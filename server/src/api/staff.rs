//! Staff registry, POS verification, and Back Office hub (RBAC permissions).

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    self, all_permissions_set, staff_has_permission, ALL_PERMISSION_KEYS, SETTINGS_ADMIN,
    STAFF_EDIT, STAFF_MANAGE_ACCESS, STAFF_MANAGE_COMMISSION, STAFF_MANAGE_PINS, STAFF_VIEW,
    STAFF_VIEW_AUDIT,
};
use crate::auth::pins::{self, hash_pin, is_valid_staff_credential, log_staff_access};
use crate::auth::staff_avatar;
use crate::logic::pricing_limits;
use crate::logic::register_staff_metrics;
use crate::middleware::{require_authenticated_staff_headers, require_staff_with_permission};
use crate::models::DbStaffRole;

#[derive(Debug, Error)]
pub enum StaffApiError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Invalid cashier code")]
    InvalidCode,
    #[error("Forbidden")]
    Forbidden,
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
}

impl IntoResponse for StaffApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            StaffApiError::InvalidCode => (StatusCode::UNAUTHORIZED, self.to_string()),
            StaffApiError::Forbidden => (StatusCode::FORBIDDEN, self.to_string()),
            StaffApiError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            StaffApiError::Database(e) => {
                tracing::error!(error = %e, "Database error in staff");
                let msg = match &e {
                    sqlx::Error::Database(db) if db.message().contains("does not exist") => {
                        "Schema out of date: a table or column is missing (see server logs). Apply SQL migrations in numeric order through migrations/34_staff_contacts_and_permissions.sql — e.g. from repo root: ./scripts/apply-migrations-docker.sh (use the database in DATABASE_URL).".to_string()
                    }
                    _ => "Internal server error".to_string(),
                };
                (StatusCode::INTERNAL_SERVER_ERROR, msg)
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

#[derive(Debug, Serialize)]
pub struct StoreSopReadResponse {
    pub markdown: String,
}

#[derive(Debug, Serialize, FromRow)]
pub struct StaffListRow {
    pub id: Uuid,
    pub full_name: String,
    pub role: DbStaffRole,
    pub avatar_key: String,
}

#[derive(Debug, Serialize, FromRow)]
pub struct StaffHubRow {
    pub id: Uuid,
    pub full_name: String,
    pub cashier_code: String,
    pub role: DbStaffRole,
    pub is_active: bool,
    pub base_commission_rate: Decimal,
    pub has_pin: bool,
    pub sales_mtd: Option<Decimal>,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub avatar_key: String,
    pub max_discount_percent: Decimal,
    pub employment_start_date: Option<NaiveDate>,
    pub employment_end_date: Option<NaiveDate>,
    pub employee_customer_id: Option<Uuid>,
    pub employee_customer_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct VerifyCashierRequest {
    pub cashier_code: String,
    #[serde(default)]
    pub pin: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct VerifyCashierResponse {
    pub staff_id: Uuid,
    pub full_name: String,
    pub role: DbStaffRole,
    pub avatar_key: String,
}

#[derive(Debug, Deserialize)]
pub struct LegacyVerifyPinRequest {
    pub pin: String,
    pub staff_id: Option<Uuid>,
    pub role: Option<String>,
    pub authorize_action: Option<String>,
    pub authorize_metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct PatchStaffRequest {
    pub full_name: Option<String>,
    pub role: Option<DbStaffRole>,
    pub is_active: Option<bool>,
    pub base_commission_rate: Option<Decimal>,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub avatar_key: Option<String>,
    #[serde(default)]
    pub max_discount_percent: Option<Decimal>,
    #[serde(default)]
    pub employment_start_date: Option<NaiveDate>,
    #[serde(default)]
    pub employment_end_date: Option<NaiveDate>,
    #[serde(default)]
    pub employee_customer_id: Option<Uuid>,
    /// When true, clear `employee_customer_id` (wins over `employee_customer_id`).
    #[serde(default)]
    pub detach_employee_customer: bool,
    #[serde(default)]
    pub cashier_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchStaffPermissionsBody {
    /// Permission keys this staff member is allowed (full replace for non-admin).
    pub granted: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchSelfAvatarRequest {
    pub avatar_key: String,
}

#[derive(Debug, Deserialize)]
pub struct SetStaffPinRequest {
    pub pin: String,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CategoryCommissionRow {
    pub category_id: Uuid,
    pub category_name: String,
    pub commission_rate: Decimal,
}

#[derive(Debug, Deserialize)]
pub struct PutCategoryCommissionRequest {
    pub commission_rate: Decimal,
}

#[derive(Debug, Deserialize)]
pub struct AccessLogQuery {
    /// Max rows (default 200, cap 1000).
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct StaffAccessLogRow {
    pub id: Uuid,
    pub staff_id: Uuid,
    pub staff_name: String,
    pub staff_avatar_key: String,
    pub event_kind: String,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct RolePermissionRow {
    pub role: DbStaffRole,
    pub permission_key: String,
    pub allowed: bool,
}

#[derive(Debug, Deserialize)]
pub struct PatchRolePermissionsBody {
    pub permissions: Vec<RolePermissionEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RolePermissionEntry {
    pub role: DbStaffRole,
    pub permission_key: String,
    pub allowed: bool,
}

#[derive(Debug, Serialize, FromRow)]
pub struct StaffOverrideRow {
    pub permission_key: String,
    pub effect: String,
}

#[derive(Debug, Deserialize)]
pub struct PutStaffOverridesBody {
    pub overrides: Vec<OverrideEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct OverrideEntry {
    pub permission_key: String,
    /// `allow` or `deny`
    pub effect: String,
}

async fn require_settings_or_manage_access(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<crate::auth::pins::AuthenticatedStaff, StaffApiError> {
    let staff = require_authenticated_staff_headers(state, headers)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;
    let eff = permissions::effective_permissions_for_staff(&state.db, staff.id, staff.role).await?;
    if staff_has_permission(&eff, SETTINGS_ADMIN) || staff_has_permission(&eff, STAFF_MANAGE_ACCESS)
    {
        Ok(staff)
    } else {
        Err(StaffApiError::Forbidden)
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .nest("/schedule", crate::api::staff_schedule::router())
        .route("/store-sop", get(get_store_sop_read))
        .route("/list-for-pos", get(list_for_pos))
        .route("/verify-cashier-code", post(verify_cashier_code))
        .route("/effective-permissions", get(effective_permissions_self))
        .route("/verify-pin", post(legacy_verify_pin))
        .route("/avatar/{id}", get(get_staff_avatar))
        .route("/self", get(self_get_profile).patch(self_patch_profile))
        .route("/self/avatar", patch(self_patch_staff_avatar))
        .route("/self/set-pin", post(self_set_pin))
        .route("/self/pricing-limits", get(self_pricing_limits))
        .route("/self/register-metrics", get(self_register_metrics))
        .route("/admin/access-log", get(admin_access_log))
        .route("/admin/roster", get(admin_roster))
        .route(
            "/admin/category-commissions",
            get(admin_list_category_commissions),
        )
        .route(
            "/admin/category-commissions/{category_id}",
            patch(admin_put_category_commission),
        )
        .route(
            "/admin/role-permissions",
            get(admin_get_role_permissions).patch(admin_patch_role_permissions),
        )
        .route(
            "/admin/pricing-limits",
            get(admin_list_pricing_limits).patch(admin_patch_pricing_limits),
        )
        .route(
            "/admin/{staff_id}/apply-role-defaults",
            post(admin_apply_role_defaults),
        )
        .route(
            "/admin/{staff_id}/permissions",
            get(admin_get_staff_permissions).patch(admin_patch_staff_permissions),
        )
        .route(
            "/admin/{staff_id}/permission-overrides",
            get(admin_get_staff_overrides).put(admin_put_staff_overrides),
        )
        .route("/admin/{staff_id}/set-pin", post(admin_set_pin))
        .route("/admin/{staff_id}", patch(admin_patch_staff))
        .route("/admin", post(admin_create_staff))
        // New Commission Rules API (SPIFFs and Overrides)
        .route(
            "/commissions/rules",
            get(list_commission_rules).post(upsert_commission_rule),
        )
        .route("/commissions/rules/{id}", delete(delete_commission_rule))
        .route(
            "/commissions/combos",
            get(list_commission_combos).post(upsert_commission_combo),
        )
        .route("/commissions/combos/{id}", delete(delete_commission_combo))
}

/// Markdown SOP/playbook for all authenticated staff (Back Office headers). Edited via `PUT /api/settings/staff-sop` (settings.admin).
async fn get_store_sop_read(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<StoreSopReadResponse>, StaffApiError> {
    let _ = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;
    let md: String =
        sqlx::query_scalar("SELECT staff_sop_markdown FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;
    Ok(Json(StoreSopReadResponse { markdown: md }))
}

#[derive(Debug, Serialize, FromRow)]
pub struct RolePricingLimitRow {
    pub role: DbStaffRole,
    pub max_discount_percent: Decimal,
}

#[derive(Debug, Deserialize)]
pub struct PatchPricingLimitsBody {
    pub limits: Vec<PricingLimitEntry>,
}

#[derive(Debug, Deserialize)]
pub struct PricingLimitEntry {
    pub role: DbStaffRole,
    pub max_discount_percent: Decimal,
}

async fn self_pricing_limits(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let staff = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;
    let max_discount_percent =
        pricing_limits::max_discount_percent_for_staff(&state.db, staff.id).await?;
    Ok(Json(json!({
        "staff_id": staff.id,
        "role": staff.role,
        "max_discount_percent": max_discount_percent.to_string(),
    })))
}

async fn self_register_metrics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<register_staff_metrics::RegisterStaffMetrics>, StaffApiError> {
    let staff = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;
    let m = register_staff_metrics::staff_attributed_sales_store_day(&state.db, staff.id).await?;
    let _ = log_staff_access(
        &state.db,
        staff.id,
        "register_metrics_view",
        json!({ "store_date": &m.store_date }),
    )
    .await;
    Ok(Json(m))
}

async fn admin_list_pricing_limits(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RolePricingLimitRow>>, StaffApiError> {
    let _ = require_settings_or_manage_access(&state, &headers).await?;
    let rows = sqlx::query_as::<_, RolePricingLimitRow>(
        r#"
        SELECT role, max_discount_percent
        FROM staff_role_pricing_limits
        ORDER BY role::text
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn admin_patch_pricing_limits(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PatchPricingLimitsBody>,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let admin = require_settings_or_manage_access(&state, &headers).await?;

    for e in &body.limits {
        if e.max_discount_percent < Decimal::ZERO || e.max_discount_percent > Decimal::from(100) {
            return Err(StaffApiError::InvalidPayload(
                "max_discount_percent must be between 0 and 100".to_string(),
            ));
        }
    }

    let mut tx = state.db.begin().await?;
    for e in &body.limits {
        sqlx::query(
            r#"
            INSERT INTO staff_role_pricing_limits (role, max_discount_percent)
            VALUES ($1, $2)
            ON CONFLICT (role) DO UPDATE SET max_discount_percent = EXCLUDED.max_discount_percent
            "#,
        )
        .bind(e.role)
        .bind(e.max_discount_percent)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "staff_pricing_limits_save",
        json!({ "count": body.limits.len() }),
    )
    .await;

    Ok(Json(json!({ "status": "updated" })))
}

async fn effective_permissions_self(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let staff = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let eff = permissions::effective_permissions_for_staff(&state.db, staff.id, staff.role).await?;
    let list: Vec<&str> = ALL_PERMISSION_KEYS
        .iter()
        .copied()
        .filter(|k| staff_has_permission(&eff, k))
        .collect();
    let employee_customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT employee_customer_id FROM staff WHERE id = $1")
            .bind(staff.id)
            .fetch_one(&state.db)
            .await?;
    Ok(Json(json!({
        "staff_id": staff.id,
        "full_name": staff.full_name,
        "avatar_key": staff.avatar_key,
        "role": staff.role,
        "permissions": list,
        "employee_customer_id": employee_customer_id,
    })))
}

async fn self_get_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<StaffHubRow>, StaffApiError> {
    let staff = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let row = sqlx::query_as::<_, StaffHubRow>(
        r#"
        SELECT
            s.id,
            s.full_name,
            s.cashier_code,
            s.role,
            s.is_active,
            s.base_commission_rate,
            (s.pin_hash IS NOT NULL AND length(trim(s.pin_hash)) > 0) AS has_pin,
            (
                SELECT COALESCE(
                    SUM((oi.unit_price * oi.quantity)::numeric(14, 2)),
                    0
                )::numeric(14, 2)
                FROM transaction_lines oi
                INNER JOIN transactions o ON o.id = oi.transaction_id
                WHERE oi.salesperson_id = s.id
                  AND o.status::text NOT IN ('cancelled')
                  AND o.booked_at >= date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
                  AND o.booked_at < date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
                    + INTERVAL '1 month'
            ) AS sales_mtd,
            NULLIF(trim(s.phone), '') AS phone,
            NULLIF(trim(s.email), '') AS email,
            s.avatar_key,
            s.max_discount_percent,
            s.employment_start_date,
            s.employment_end_date,
            s.employee_customer_id,
            NULLIF(trim(c.customer_code), '') AS employee_customer_code
        FROM staff s
        LEFT JOIN customers c ON c.id = s.employee_customer_id
        WHERE s.id = $1
        "#,
    )
    .bind(staff.id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
pub struct PatchSelfRequest {
    pub full_name: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub avatar_key: Option<String>,
    pub employee_customer_id: Option<Uuid>,
    #[serde(default)]
    pub detach_employee_customer: bool,
}

async fn self_patch_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PatchSelfRequest>,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let staff = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    if let Some(ref e) = body.email {
        if !validate_email(e) {
            return Err(StaffApiError::InvalidPayload("invalid email".to_string()));
        }
    }
    if let Some(ref p) = body.phone {
        if !validate_phone(p) {
            return Err(StaffApiError::InvalidPayload("invalid phone".to_string()));
        }
    }
    if let Some(ref k) = body.avatar_key {
        if !staff_avatar::is_allowed_staff_avatar_key(k) {
            return Err(StaffApiError::InvalidPayload(
                "invalid avatar_key".to_string(),
            ));
        }
    }

    let mut tx = state.db.begin().await?;

    if let Some(ref n) = body.full_name {
        sqlx::query("UPDATE staff SET full_name = $1 WHERE id = $2")
            .bind(n.trim())
            .bind(staff.id)
            .execute(&mut *tx)
            .await?;
    }

    if let Some(ref p) = body.phone {
        sqlx::query("UPDATE staff SET phone = $1 WHERE id = $2")
            .bind(p.trim())
            .bind(staff.id)
            .execute(&mut *tx)
            .await?;
    }

    if let Some(ref e) = body.email {
        sqlx::query("UPDATE staff SET email = $1 WHERE id = $2")
            .bind(e.trim())
            .bind(staff.id)
            .execute(&mut *tx)
            .await?;
    }

    if let Some(ref k) = body.avatar_key {
        sqlx::query("UPDATE staff SET avatar_key = $1 WHERE id = $2")
            .bind(k.trim())
            .bind(staff.id)
            .execute(&mut *tx)
            .await?;
    }

    if body.detach_employee_customer {
        sqlx::query("UPDATE staff SET employee_customer_id = NULL WHERE id = $1")
            .bind(staff.id)
            .execute(&mut *tx)
            .await?;
    } else if let Some(ec) = body.employee_customer_id {
        sqlx::query("UPDATE staff SET employee_customer_id = $1 WHERE id = $2")
            .bind(ec)
            .bind(staff.id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    spawn_meilisearch_staff_upsert(&state, staff.id);

    Ok(Json(json!({ "status": "updated" })))
}

async fn self_set_pin(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SetStaffPinRequest>,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let staff = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let pin_t = body.pin.trim();
    if !pins::is_valid_staff_credential(pin_t) {
        return Err(StaffApiError::InvalidPayload(
            "PIN must be exactly 4 digits".to_string(),
        ));
    }

    // Check if new PIN is already in use
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE cashier_code = $1 AND id != $2)")
        .bind(pin_t)
        .bind(staff.id)
        .fetch_one(&state.db)
        .await?;
    if exists {
        return Err(StaffApiError::InvalidPayload(
            "This PIN is already in use by another staff member".to_string(),
        ));
    }

    let hashed = hash_pin(pin_t)
        .map_err(|_| StaffApiError::InvalidPayload("PIN hashing failed".to_string()))?;

    sqlx::query("UPDATE staff SET pin_hash = $1, cashier_code = $2 WHERE id = $3")
        .bind(hashed)
        .bind(pin_t)
        .bind(staff.id)
        .execute(&state.db)
        .await?;

    let _ = log_staff_access(
        &state.db,
        staff.id,
        "self_set_pin",
        json!({ "status": "pin_updated" }),
    )
    .await;

    Ok(Json(json!({ "status": "pin_updated" })))
}

async fn self_patch_staff_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PatchSelfAvatarRequest>,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let staff = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let key = body.avatar_key.trim();
    if !staff_avatar::is_allowed_staff_avatar_key(key) {
        return Err(StaffApiError::InvalidPayload(
            "invalid avatar_key".to_string(),
        ));
    }

    let n = sqlx::query("UPDATE staff SET avatar_key = $1 WHERE id = $2")
        .bind(key)
        .bind(staff.id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(StaffApiError::InvalidPayload("staff not found".to_string()));
    }

    Ok(Json(json!({ "status": "updated", "avatar_key": key })))
}

async fn list_for_pos(
    State(state): State<AppState>,
) -> Result<Json<Vec<StaffListRow>>, StaffApiError> {
    let rows = sqlx::query_as::<_, StaffListRow>(
        r#"
        SELECT id, full_name, role, avatar_key
        FROM staff
        WHERE is_active = TRUE
        ORDER BY full_name ASC
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn verify_cashier_code(
    State(state): State<AppState>,
    Json(body): Json<VerifyCashierRequest>,
) -> Result<Json<VerifyCashierResponse>, StaffApiError> {
    let code = body.cashier_code.trim();
    if !is_valid_staff_credential(code) {
        return Err(StaffApiError::InvalidCode);
    }
    let staff = pins::authenticate_pos_staff(&state.db, code, body.pin.as_deref())
        .await
        .map_err(|_| StaffApiError::InvalidCode)?;

    let _ = log_staff_access(
        &state.db,
        staff.id,
        "checkout_auth",
        json!({ "context": "pos_drawer_pin_before_finalize" }),
    )
    .await;

    Ok(Json(VerifyCashierResponse {
        staff_id: staff.id,
        full_name: staff.full_name,
        role: staff.role,
        avatar_key: staff.avatar_key,
    }))
}

pub async fn legacy_verify_pin(
    State(state): State<AppState>,
    Json(body): Json<LegacyVerifyPinRequest>,
) -> Result<Json<VerifyCashierResponse>, StaffApiError> {
    let code = body.pin.trim();
    if !is_valid_staff_credential(code) {
        return Err(StaffApiError::InvalidCode);
    }

    let staff = if let Some(sid) = body.staff_id {
        pins::authenticate_staff_by_id(&state.db, sid, Some(code))
            .await
            .map_err(|_| StaffApiError::InvalidCode)?
    } else if body.role.as_deref() == Some("Admin") {
        pins::authenticate_admin(&state.db, code, None)
            .await
            .map_err(|_| StaffApiError::InvalidCode)?
    } else {
        pins::authenticate_pos_staff(&state.db, code, None)
            .await
            .map_err(|_| StaffApiError::InvalidCode)?
    };

    if let Some(action) = body.authorize_action {
        let meta = body.authorize_metadata.unwrap_or_else(|| json!({}));
        let _ = pins::log_staff_access(&state.db, staff.id, &action, meta).await;
    }

    Ok(Json(VerifyCashierResponse {
        staff_id: staff.id,
        full_name: staff.full_name,
        role: staff.role,
        avatar_key: staff.avatar_key,
    }))
}

pub fn auth_router() -> Router<AppState> {
    Router::new().route("/verify-pin", post(legacy_verify_pin))
}

async fn admin_access_log(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AccessLogQuery>,
) -> Result<Json<Vec<StaffAccessLogRow>>, StaffApiError> {
    let _ = require_staff_with_permission(&state, &headers, STAFF_VIEW_AUDIT)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let lim = q.limit.unwrap_or(200).clamp(1, 1000);

    let rows = sqlx::query_as::<_, StaffAccessLogRow>(
        r#"
        SELECT
            sal.id,
            sal.staff_id,
            st.full_name AS staff_name,
            st.avatar_key AS staff_avatar_key,
            sal.event_kind,
            sal.metadata,
            sal.created_at
        FROM staff_access_log sal
        INNER JOIN staff st ON st.id = sal.staff_id
        ORDER BY sal.created_at DESC
        LIMIT $1
        "#,
    )
    .bind(lim)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

async fn admin_roster(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<StaffHubRow>>, StaffApiError> {
    let _ = require_staff_with_permission(&state, &headers, STAFF_VIEW)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let rows = sqlx::query_as::<_, StaffHubRow>(
        r#"
        SELECT
            s.id,
            s.full_name,
            s.cashier_code,
            s.role,
            s.is_active,
            s.base_commission_rate,
            (s.pin_hash IS NOT NULL AND length(trim(s.pin_hash)) > 0) AS has_pin,
            (
                SELECT COALESCE(
                    SUM((oi.unit_price * oi.quantity)::numeric(14, 2)),
                    0
                )::numeric(14, 2)
                FROM transaction_lines oi
                INNER JOIN transactions o ON o.id = oi.transaction_id
                WHERE oi.salesperson_id = s.id
                  AND o.status::text NOT IN ('cancelled')
                  AND o.booked_at >= date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
                  AND o.booked_at < date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
                    + INTERVAL '1 month'
            ) AS sales_mtd,
            NULLIF(trim(s.phone), '') AS phone,
            NULLIF(trim(s.email), '') AS email,
            s.avatar_key,
            s.max_discount_percent,
            s.employment_start_date,
            s.employment_end_date,
            s.employee_customer_id,
            NULLIF(trim(c.customer_code), '') AS employee_customer_code
        FROM staff s
        LEFT JOIN customers c ON c.id = s.employee_customer_id
        ORDER BY s.full_name ASC
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

fn validate_email(email: &str) -> bool {
    let t = email.trim();
    if t.is_empty() {
        return true;
    }
    t.contains('@') && t.len() <= 320
}

fn validate_phone(phone: &str) -> bool {
    let t = phone.trim();
    if t.is_empty() {
        return true;
    }
    t.len() <= 40
}

fn spawn_meilisearch_staff_upsert(state: &AppState, staff_id: Uuid) {
    let state = state.clone();
    crate::logic::meilisearch_sync::spawn_meili(async move {
        if let Some(client) = crate::logic::meilisearch_client::meilisearch_from_env() {
            crate::logic::meilisearch_sync::upsert_staff_document(&client, &state.db, staff_id)
                .await;
        }
    });
}

async fn admin_patch_staff(
    State(state): State<AppState>,
    Path(staff_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PatchStaffRequest>,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let _ = require_staff_with_permission(&state, &headers, STAFF_EDIT)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let ec_touch = body.detach_employee_customer || body.employee_customer_id.is_some();
    if body.full_name.is_none()
        && body.cashier_code.is_none()
        && body.role.is_none()
        && body.is_active.is_none()
        && body.base_commission_rate.is_none()
        && body.phone.is_none()
        && body.email.is_none()
        && body.avatar_key.is_none()
        && body.max_discount_percent.is_none()
        && body.employment_start_date.is_none()
        && body.employment_end_date.is_none()
        && !ec_touch
    {
        return Err(StaffApiError::InvalidPayload(
            "no fields to update".to_string(),
        ));
    }

    if body.detach_employee_customer && body.employee_customer_id.is_some() {
        return Err(StaffApiError::InvalidPayload(
            "cannot set employee_customer_id and detach_employee_customer together".to_string(),
        ));
    }

    if let Some(ref e) = body.email {
        if !validate_email(e) {
            return Err(StaffApiError::InvalidPayload("invalid email".to_string()));
        }
    }
    if let Some(ref p) = body.phone {
        if !validate_phone(p) {
            return Err(StaffApiError::InvalidPayload("invalid phone".to_string()));
        }
    }

    if let Some(ref code) = body.cashier_code {
        let t = code.trim();
        if t.is_empty() {
            return Err(StaffApiError::InvalidPayload(
                "cashier_code cannot be empty".to_string(),
            ));
        }
        if !is_valid_staff_credential(t) {
            return Err(StaffApiError::InvalidPayload(
                "PIN must be exactly 4 digits".to_string(),
            ));
        }
    }

    if let Some(r) = body.base_commission_rate {
        if r < Decimal::ZERO || r > Decimal::ONE {
            return Err(StaffApiError::InvalidPayload(
                "base_commission_rate must be between 0 and 1".to_string(),
            ));
        }
    }

    if let Some(m) = body.max_discount_percent {
        if m < Decimal::ZERO || m > Decimal::from(100) {
            return Err(StaffApiError::InvalidPayload(
                "max_discount_percent must be between 0 and 100".to_string(),
            ));
        }
    }

    if let Some(ref k) = body.avatar_key {
        let t = k.trim();
        if t.is_empty() || !staff_avatar::is_allowed_staff_avatar_key(t) {
            return Err(StaffApiError::InvalidPayload(
                "invalid avatar_key".to_string(),
            ));
        }
    }

    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE id = $1)")
        .bind(staff_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(StaffApiError::InvalidPayload("staff not found".to_string()));
    }

    let current_staff: (DbStaffRole, bool, String) =
        sqlx::query_as("SELECT role, is_active, full_name FROM staff WHERE id = $1")
            .bind(staff_id)
            .fetch_one(&state.db)
            .await?;

    let next_role = body.role.unwrap_or(current_staff.0);
    let next_is_active = body.is_active.unwrap_or(current_staff.1);
    let admin_access_removed = current_staff.0 == DbStaffRole::Admin
        && (next_role != DbStaffRole::Admin || !next_is_active);

    if admin_access_removed {
        let other_active_admins: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM staff
            WHERE role = 'admin'::staff_role
              AND is_active = TRUE
              AND id <> $1
            "#,
        )
        .bind(staff_id)
        .fetch_one(&state.db)
        .await?;
        if other_active_admins == 0 {
            return Err(StaffApiError::InvalidPayload(
                "cannot deactivate or demote the last active admin".to_string(),
            ));
        }
    }

    if !next_is_active {
        let open_register_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM register_sessions
            WHERE is_open = TRUE
              AND (opened_by = $1 OR shift_primary_staff_id = $1)
            "#,
        )
        .bind(staff_id)
        .fetch_one(&state.db)
        .await?;
        if open_register_count > 0 {
            return Err(StaffApiError::InvalidPayload(format!(
                "cannot deactivate {} while they still own open register sessions",
                current_staff.2
            )));
        }
    }

    if let Some(cid) = body.employee_customer_id {
        let cust_ok: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
                .bind(cid)
                .fetch_one(&state.db)
                .await?;
        if !cust_ok {
            return Err(StaffApiError::InvalidPayload(
                "employee_customer_id not found".to_string(),
            ));
        }
        let dup: bool = sqlx::query_scalar(
            r#"SELECT EXISTS(
                SELECT 1 FROM staff WHERE employee_customer_id = $1 AND id <> $2
            )"#,
        )
        .bind(cid)
        .bind(staff_id)
        .fetch_one(&state.db)
        .await?;
        if dup {
            return Err(StaffApiError::InvalidPayload(
                "this customer is already linked to another staff member".to_string(),
            ));
        }
    }

    if let Some(ref code) = body.cashier_code {
        let dup: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM staff WHERE cashier_code = $1 AND id <> $2)",
        )
        .bind(code.trim())
        .bind(staff_id)
        .fetch_one(&state.db)
        .await?;
        if dup {
            return Err(StaffApiError::InvalidPayload(
                "cashier_code already in use".to_string(),
            ));
        }
    }

    let ec_apply: bool = ec_touch;
    let ec_value: Option<Uuid> = if body.detach_employee_customer {
        None
    } else {
        body.employee_customer_id
    };

    let phone_bind = body.phone.as_ref().map(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    });
    let email_bind = body.email.as_ref().map(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    });
    let avatar_bind = body
        .avatar_key
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    sqlx::query(
        r#"
        UPDATE staff SET
            full_name = COALESCE($2, full_name),
            cashier_code = COALESCE($3, cashier_code),
            role = COALESCE($4, role),
            is_active = COALESCE($5, is_active),
            base_commission_rate = COALESCE($6, base_commission_rate),
            phone = COALESCE($7, phone),
            email = COALESCE($8, email),
            avatar_key = COALESCE($9, avatar_key),
            max_discount_percent = COALESCE($10, max_discount_percent),
            employment_start_date = COALESCE($11, employment_start_date),
            employment_end_date = COALESCE($12, employment_end_date),
            employee_customer_id = CASE WHEN $13 THEN $14 ELSE employee_customer_id END
        WHERE id = $1
        "#,
    )
    .bind(staff_id)
    .bind(&body.full_name)
    .bind(body.cashier_code.as_ref().map(|s| s.trim().to_string()))
    .bind(body.role)
    .bind(body.is_active)
    .bind(body.base_commission_rate)
    .bind(phone_bind.as_ref())
    .bind(email_bind.as_ref())
    .bind(avatar_bind.as_ref())
    .bind(body.max_discount_percent)
    .bind(body.employment_start_date)
    .bind(body.employment_end_date)
    .bind(ec_apply)
    .bind(ec_value)
    .execute(&state.db)
    .await?;

    spawn_meilisearch_staff_upsert(&state, staff_id);

    Ok(Json(json!({ "status": "updated" })))
}

async fn admin_set_pin(
    State(state): State<AppState>,
    Path(staff_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<SetStaffPinRequest>,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let admin = require_staff_with_permission(&state, &headers, STAFF_MANAGE_PINS)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let badge: Option<String> = sqlx::query_scalar("SELECT cashier_code FROM staff WHERE id = $1")
        .bind(staff_id)
        .fetch_optional(&state.db)
        .await?;
    let Some(_badge) = badge else {
        return Err(StaffApiError::InvalidPayload("staff not found".to_string()));
    };
    let pin_t = body.pin.trim();
    if !pins::is_valid_staff_credential(pin_t) {
        return Err(StaffApiError::InvalidPayload(
            "PIN must be exactly 4 digits".to_string(),
        ));
    }

    // Check for duplicate cashier code
    let dup: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM staff WHERE cashier_code = $1 AND id <> $2)",
    )
    .bind(pin_t)
    .bind(staff_id)
    .fetch_one(&state.db)
    .await?;
    if dup {
        return Err(StaffApiError::InvalidPayload(
            "This PIN is already in use by another staff member".to_string(),
        ));
    }

    let hashed = hash_pin(pin_t)
        .map_err(|_| StaffApiError::InvalidPayload("PIN hashing failed".to_string()))?;

    let n = sqlx::query("UPDATE staff SET pin_hash = $1, cashier_code = $2 WHERE id = $3")
        .bind(&hashed)
        .bind(pin_t)
        .bind(staff_id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(StaffApiError::InvalidPayload("staff not found".to_string()));
    }

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "admin_set_staff_pin",
        json!({ "target_staff_id": staff_id }),
    )
    .await;

    Ok(Json(json!({ "status": "pin_updated" })))
}

async fn admin_list_category_commissions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<CategoryCommissionRow>>, StaffApiError> {
    let _ = require_staff_with_permission(&state, &headers, STAFF_MANAGE_COMMISSION)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let rows = sqlx::query_as::<_, CategoryCommissionRow>(
        r#"
        SELECT c.id AS category_id, c.name AS category_name,
               COALESCE(o.commission_rate, 0)::numeric(5, 4) AS commission_rate
        FROM categories c
        LEFT JOIN category_commission_overrides o ON o.category_id = c.id
        ORDER BY c.name ASC
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

async fn admin_put_category_commission(
    State(state): State<AppState>,
    Path(category_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PutCategoryCommissionRequest>,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let admin = require_staff_with_permission(&state, &headers, STAFF_MANAGE_COMMISSION)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    if body.commission_rate < Decimal::ZERO || body.commission_rate > Decimal::ONE {
        return Err(StaffApiError::InvalidPayload(
            "commission_rate must be between 0 and 1".to_string(),
        ));
    }

    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM categories WHERE id = $1)")
        .bind(category_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(StaffApiError::InvalidPayload(
            "category not found".to_string(),
        ));
    }

    sqlx::query(
        r#"
        INSERT INTO category_commission_overrides (category_id, commission_rate)
        VALUES ($1, $2)
        ON CONFLICT (category_id) DO UPDATE SET
            commission_rate = EXCLUDED.commission_rate,
            updated_at = CURRENT_TIMESTAMP
        "#,
    )
    .bind(category_id)
    .bind(body.commission_rate)
    .execute(&state.db)
    .await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "admin_category_commission",
        json!({ "category_id": category_id, "rate": body.commission_rate }),
    )
    .await;

    Ok(Json(json!({ "status": "updated" })))
}

async fn admin_get_role_permissions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RolePermissionRow>>, StaffApiError> {
    let _ = require_settings_or_manage_access(&state, &headers).await?;

    let rows = sqlx::query_as::<_, RolePermissionRow>(
        r#"
        SELECT role, permission_key, allowed
        FROM staff_role_permission
        ORDER BY role::text, permission_key
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

async fn admin_patch_role_permissions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PatchRolePermissionsBody>,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let admin = require_settings_or_manage_access(&state, &headers).await?;

    let catalog: std::collections::HashSet<String> = all_permissions_set();
    let mut tx = state.db.begin().await?;

    for e in &body.permissions {
        if !catalog.contains(&e.permission_key) {
            return Err(StaffApiError::InvalidPayload(format!(
                "unknown permission_key: {}",
                e.permission_key
            )));
        }
        sqlx::query(
            r#"
            INSERT INTO staff_role_permission (role, permission_key, allowed)
            VALUES ($1, $2, $3)
            ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed
            "#,
        )
        .bind(e.role)
        .bind(&e.permission_key)
        .bind(e.allowed)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "role_permission_save",
        json!({ "count": body.permissions.len() }),
    )
    .await;

    Ok(Json(json!({ "status": "updated" })))
}

async fn admin_get_staff_overrides(
    State(state): State<AppState>,
    Path(staff_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<StaffOverrideRow>>, StaffApiError> {
    let _ = require_staff_with_permission(&state, &headers, STAFF_MANAGE_ACCESS)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let rows = sqlx::query_as::<_, StaffOverrideRow>(
        r#"
        SELECT permission_key, effect
        FROM staff_permission_override
        WHERE staff_id = $1
        ORDER BY permission_key
        "#,
    )
    .bind(staff_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

async fn admin_put_staff_overrides(
    State(state): State<AppState>,
    Path(staff_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PutStaffOverridesBody>,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let admin = require_staff_with_permission(&state, &headers, STAFF_MANAGE_ACCESS)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE id = $1)")
        .bind(staff_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(StaffApiError::InvalidPayload("staff not found".to_string()));
    }

    let catalog = all_permissions_set();
    for o in &body.overrides {
        if !catalog.contains(&o.permission_key) {
            return Err(StaffApiError::InvalidPayload(format!(
                "unknown permission_key: {}",
                o.permission_key
            )));
        }
        if o.effect != "allow" && o.effect != "deny" {
            return Err(StaffApiError::InvalidPayload(
                "effect must be allow or deny".to_string(),
            ));
        }
    }

    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM staff_permission_override WHERE staff_id = $1")
        .bind(staff_id)
        .execute(&mut *tx)
        .await?;

    for o in &body.overrides {
        sqlx::query(
            r#"
            INSERT INTO staff_permission_override (staff_id, permission_key, effect)
            VALUES ($1, $2, $3)
            "#,
        )
        .bind(staff_id)
        .bind(&o.permission_key)
        .bind(&o.effect)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "permission_override_save",
        json!({ "target_staff_id": staff_id, "count": body.overrides.len() }),
    )
    .await;

    Ok(Json(json!({ "status": "updated" })))
}

async fn admin_get_staff_permissions(
    State(state): State<AppState>,
    Path(staff_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let _ = require_staff_with_permission(&state, &headers, STAFF_MANAGE_ACCESS)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let role: Option<DbStaffRole> = sqlx::query_scalar("SELECT role FROM staff WHERE id = $1")
        .bind(staff_id)
        .fetch_optional(&state.db)
        .await?;
    let Some(role) = role else {
        return Err(StaffApiError::InvalidPayload("staff not found".to_string()));
    };

    if role == DbStaffRole::Admin {
        let mut v: Vec<String> = all_permissions_set().into_iter().collect();
        v.sort();
        return Ok(Json(
            json!({ "staff_id": staff_id, "role": role, "granted": v, "is_admin": true }),
        ));
    }

    let mut granted: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT permission_key
        FROM staff_permission
        WHERE staff_id = $1 AND allowed = true
        ORDER BY permission_key
        "#,
    )
    .bind(staff_id)
    .fetch_all(&state.db)
    .await?;
    granted.sort();

    Ok(Json(
        json!({ "staff_id": staff_id, "role": role, "granted": granted, "is_admin": false }),
    ))
}

async fn admin_patch_staff_permissions(
    State(state): State<AppState>,
    Path(staff_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PatchStaffPermissionsBody>,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let admin = require_staff_with_permission(&state, &headers, STAFF_MANAGE_ACCESS)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let role: Option<DbStaffRole> = sqlx::query_scalar("SELECT role FROM staff WHERE id = $1")
        .bind(staff_id)
        .fetch_optional(&state.db)
        .await?;
    let Some(role) = role else {
        return Err(StaffApiError::InvalidPayload("staff not found".to_string()));
    };
    if role == DbStaffRole::Admin {
        return Err(StaffApiError::InvalidPayload(
            "admin role has full access; edit not applicable".to_string(),
        ));
    }

    let catalog = all_permissions_set();
    for k in &body.granted {
        if !catalog.contains(k) {
            return Err(StaffApiError::InvalidPayload(format!(
                "unknown permission_key: {k}"
            )));
        }
    }

    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM staff_permission WHERE staff_id = $1")
        .bind(staff_id)
        .execute(&mut *tx)
        .await?;

    for k in &body.granted {
        sqlx::query(
            r#"
            INSERT INTO staff_permission (staff_id, permission_key, allowed)
            VALUES ($1, $2, true)
            "#,
        )
        .bind(staff_id)
        .bind(k)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "staff_permission_save",
        json!({ "target_staff_id": staff_id, "count": body.granted.len() }),
    )
    .await;

    Ok(Json(json!({ "status": "updated" })))
}

async fn admin_apply_role_defaults(
    State(state): State<AppState>,
    Path(staff_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let admin = require_staff_with_permission(&state, &headers, STAFF_MANAGE_ACCESS)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let role: Option<DbStaffRole> = sqlx::query_scalar("SELECT role FROM staff WHERE id = $1")
        .bind(staff_id)
        .fetch_optional(&state.db)
        .await?;
    let Some(role) = role else {
        return Err(StaffApiError::InvalidPayload("staff not found".to_string()));
    };
    if role == DbStaffRole::Admin {
        return Err(StaffApiError::InvalidPayload(
            "admin role uses full access in code — apply-role-defaults not applicable".to_string(),
        ));
    }

    let mut tx = state.db.begin().await?;

    sqlx::query("DELETE FROM staff_permission WHERE staff_id = $1")
        .bind(staff_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        r#"
        INSERT INTO staff_permission (staff_id, permission_key, allowed)
        SELECT $1, p.permission_key, true
        FROM staff_role_permission p
        WHERE p.role = $2 AND p.allowed = true
        "#,
    )
    .bind(staff_id)
    .bind(role)
    .execute(&mut *tx)
    .await?;

    let cap: Option<Decimal> = sqlx::query_scalar(
        "SELECT max_discount_percent FROM staff_role_pricing_limits WHERE role = $1",
    )
    .bind(role)
    .fetch_optional(&mut *tx)
    .await?;

    let cap = cap.unwrap_or(Decimal::new(30, 0));
    sqlx::query("UPDATE staff SET max_discount_percent = $1 WHERE id = $2")
        .bind(cap)
        .bind(staff_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "staff_apply_role_defaults",
        json!({ "target_staff_id": staff_id, "role": role }),
    )
    .await;

    Ok(Json(json!({ "status": "updated" })))
}

// --- Commission Rules (SPIFFs and Overrides) Handlers ---

#[derive(Debug, Deserialize)]
pub struct UpsertCommissionRuleBody {
    pub id: Option<Uuid>,
    pub match_type: String,
    pub match_id: Uuid,
    pub override_rate: Option<Decimal>,
    pub fixed_spiff_amount: Option<Decimal>,
    pub label: Option<String>,
    pub start_date: Option<DateTime<Utc>>,
    pub end_date: Option<DateTime<Utc>>,
    pub is_active: bool,
}

async fn list_commission_rules(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<crate::models::CommissionRule>>, StaffApiError> {
    let _ = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let rules = sqlx::query_as::<_, crate::models::CommissionRule>(
        "SELECT * FROM commission_rules ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rules))
}

async fn upsert_commission_rule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UpsertCommissionRuleBody>,
) -> Result<Json<crate::models::CommissionRule>, StaffApiError> {
    let admin = require_staff_with_permission(&state, &headers, STAFF_MANAGE_COMMISSION)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let rule = if let Some(id) = body.id {
        sqlx::query_as::<_, crate::models::CommissionRule>(
            r#"
            UPDATE commission_rules
            SET match_type = $1, match_id = $2, override_rate = $3, 
                fixed_spiff_amount = $4, label = $5, start_date = $6, 
                end_date = $7, is_active = $8
            WHERE id = $9
            RETURNING *
            "#,
        )
        .bind(body.match_type)
        .bind(body.match_id)
        .bind(body.override_rate)
        .bind(body.fixed_spiff_amount.unwrap_or(Decimal::ZERO))
        .bind(body.label)
        .bind(body.start_date)
        .bind(body.end_date)
        .bind(body.is_active)
        .bind(id)
        .fetch_one(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, crate::models::CommissionRule>(
            r#"
            INSERT INTO commission_rules (
                match_type, match_id, override_rate, fixed_spiff_amount, 
                label, start_date, end_date, is_active
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
            "#,
        )
        .bind(body.match_type)
        .bind(body.match_id)
        .bind(body.override_rate)
        .bind(body.fixed_spiff_amount.unwrap_or(Decimal::ZERO))
        .bind(body.label)
        .bind(body.start_date)
        .bind(body.end_date)
        .bind(body.is_active)
        .fetch_one(&state.db)
        .await?
    };

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "upsert_commission_rule",
        json!({ "rule_id": rule.id, "label": rule.label }),
    )
    .await;

    Ok(Json(rule))
}

async fn delete_commission_rule(
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let admin = require_staff_with_permission(&state, &headers, STAFF_MANAGE_COMMISSION)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    sqlx::query("DELETE FROM commission_rules WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "delete_commission_rule",
        json!({ "rule_id": id }),
    )
    .await;

    Ok(Json(json!({ "status": "deleted" })))
}

#[derive(Debug, Deserialize)]
pub struct UpsertCommissionComboBody {
    pub id: Option<Uuid>,
    pub label: String,
    pub reward_amount: Decimal,
    pub is_active: bool,
    pub items: Vec<ComboItemInput>,
}

#[derive(Debug, Deserialize)]
pub struct ComboItemInput {
    pub match_type: String, // 'category', 'product'
    pub match_id: Uuid,
    pub qty_required: i32,
}

async fn list_commission_combos(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let _ = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let combos: Vec<serde_json::Value> = sqlx::query_scalar(
        r#"
        SELECT json_build_object(
            'id', r.id,
            'label', r.label,
            'reward_amount', r.reward_amount,
            'is_active', r.is_active,
            'created_at', r.created_at,
            'items', (
                SELECT json_agg(json_build_object(
                    'match_type', ri.match_type,
                    'match_id', ri.match_id,
                    'qty_required', ri.qty_required
                ))
                FROM commission_combo_rule_items ri
                WHERE ri.rule_id = r.id
            )
        )
        FROM commission_combo_rules r
        ORDER BY r.created_at DESC
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(json!(combos)))
}

async fn upsert_commission_combo(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UpsertCommissionComboBody>,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let admin = require_staff_with_permission(&state, &headers, STAFF_MANAGE_COMMISSION)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let mut tx = state.db.begin().await?;

    let rule_id = if let Some(id) = body.id {
        sqlx::query_scalar::<_, Uuid>("UPDATE commission_combo_rules SET label = $1, reward_amount = $2, is_active = $3 WHERE id = $4 RETURNING id")
            .bind(&body.label)
            .bind(body.reward_amount)
            .bind(body.is_active)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?
    } else {
        sqlx::query_scalar::<_, Uuid>("INSERT INTO commission_combo_rules (label, reward_amount, is_active) VALUES ($1, $2, $3) RETURNING id")
            .bind(&body.label)
            .bind(body.reward_amount)
            .bind(body.is_active)
            .fetch_one(&mut *tx)
            .await?
    };

    sqlx::query("DELETE FROM commission_combo_rule_items WHERE rule_id = $1")
        .bind(rule_id)
        .execute(&mut *tx)
        .await?;

    for item in body.items {
        sqlx::query("INSERT INTO commission_combo_rule_items (rule_id, match_type, match_id, qty_required) VALUES ($1, $2, $3, $4)")
            .bind(rule_id)
            .bind(item.match_type)
            .bind(item.match_id)
            .bind(item.qty_required)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "upsert_commission_combo",
        json!({ "rule_id": rule_id, "label": body.label }),
    )
    .await;

    Ok(Json(json!({ "status": "ok", "id": rule_id })))
}

async fn delete_commission_combo(
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let admin = require_staff_with_permission(&state, &headers, STAFF_MANAGE_COMMISSION)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    sqlx::query("DELETE FROM commission_combo_rules WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "delete_commission_combo",
        json!({ "combo_id": id }),
    )
    .await;

    Ok(Json(json!({ "status": "deleted" })))
}

async fn admin_create_staff(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PatchStaffRequest>,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let admin = require_staff_with_permission(&state, &headers, STAFF_EDIT)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let name = body
        .full_name
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| StaffApiError::InvalidPayload("full_name is required".to_string()))?;

    let code = match body.cashier_code.as_ref().map(|s| s.trim()) {
        Some(c) if !c.is_empty() => c.to_string(),
        _ => {
            // Auto-generate a unique numeric ID for the Staff Tracking ID
            let mut next_code: i32 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(cashier_code::int), 1000) + 1 FROM staff WHERE cashier_code ~ '^[0-9]+$'"
            ).fetch_one(&state.db).await?;

            // Safety: ensure it is truly unique (in case of non-numeric gaps)
            while sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM staff WHERE cashier_code = $1)",
            )
            .bind(next_code.to_string())
            .fetch_one(&state.db)
            .await?
            {
                next_code += 1;
            }
            next_code.to_string()
        }
    };

    if !pins::is_valid_staff_credential(&code) && body.cashier_code.is_some() {
        return Err(StaffApiError::InvalidPayload(
            "Custom Staff ID must be exactly 4 digits".to_string(),
        ));
    }

    let initial_pin = body
        .cashier_code
        .as_ref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "1234".to_string());
    let pin_hash = hash_pin(&initial_pin)
        .map_err(|_| StaffApiError::InvalidPayload("could not hash initial PIN".to_string()))?;

    let base_rate = body.base_commission_rate.unwrap_or(Decimal::new(200, 4)); // 2%
    let max_disc = body.max_discount_percent.unwrap_or(Decimal::new(30, 0)); // 30%

    let role = body.role.unwrap_or(DbStaffRole::Salesperson);

    let mut tx = state.db.begin().await?;

    let new_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO staff (
            full_name, cashier_code, pin_hash, role, is_active, 
            base_commission_rate, phone, email, avatar_key, max_discount_percent,
            employment_start_date, employment_end_date, employee_customer_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id
        "#,
    )
    .bind(name)
    .bind(code)
    .bind(pin_hash)
    .bind(role)
    .bind(body.is_active.unwrap_or(true))
    .bind(base_rate)
    .bind(
        body.phone
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty()),
    )
    .bind(
        body.email
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty()),
    )
    .bind(
        body.avatar_key
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("ros_default"),
    )
    .bind(max_disc)
    .bind(body.employment_start_date)
    .bind(body.employment_end_date)
    .bind(body.employee_customer_id)
    .fetch_one(&mut *tx)
    .await?;

    // Auto-apply role defaults for permissions
    sqlx::query(
        r#"
        INSERT INTO staff_permission (staff_id, permission_key, allowed)
        SELECT $1, p.permission_key, true
        FROM staff_role_permission p
        WHERE p.role = $2 AND p.allowed = true
        "#,
    )
    .bind(new_id)
    .bind(role)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    spawn_meilisearch_staff_upsert(&state, new_id);

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "admin_staff_create",
        json!({ "new_id": new_id, "name": name }),
    )
    .await;

    Ok(Json(json!({ "status": "created", "id": new_id })))
}

async fn get_staff_avatar(Path(id): Path<String>, State(state): State<AppState>) -> Response {
    let key = if id == "ros_default" {
        "ros_default".to_string()
    } else if let Ok(uid) = Uuid::parse_str(&id) {
        match sqlx::query_scalar::<_, String>("SELECT avatar_key FROM staff WHERE id = $1")
            .bind(uid)
            .fetch_one(&state.db)
            .await
        {
            Ok(k) => k,
            Err(_) => "ros_default".to_string(),
        }
    } else {
        "ros_default".to_string()
    };

    // We check both the direct path and the sibling path (up one level)
    // because the server may be running from the repo root or from the 'server/' directory.
    let paths = vec![
        format!("client/public/staff-avatars/{}.svg", key),
        format!("../client/public/staff-avatars/{}.svg", key),
        format!("client/dist/staff-avatars/{}.svg", key),
        format!("../client/dist/staff-avatars/{}.svg", key),
    ];

    for path in paths {
        if let Ok(data) = tokio::fs::read(&path).await {
            return Response::builder()
                .header("Content-Type", "image/svg+xml")
                .header("Cache-Control", "public, max-age=3600")
                .body(axum::body::Body::from(data))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
        }
    }

    StatusCode::NOT_FOUND.into_response()
}
