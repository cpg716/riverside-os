//! Staff registry, POS verification, and Back Office hub (RBAC permissions).

use axum::{
    extract::{Multipart, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    self, all_permissions_set, effective_permissions_for_staff, staff_has_permission,
    ALL_PERMISSION_KEYS, MANAGER_APPROVAL, SETTINGS_ADMIN, STAFF_EDIT, STAFF_MANAGE_ACCESS,
    STAFF_MANAGE_COMMISSION, STAFF_MANAGE_PINS, STAFF_VIEW, STAFF_VIEW_AUDIT,
};
use crate::auth::pins::{self, hash_pin, is_valid_staff_credential, log_staff_access};
use crate::auth::staff_avatar;
use crate::logic::{
    notifications, pricing_limits, register_staff_metrics, staff_avatar_processor, staff_schedule,
    tasks,
};
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
    #[error("Processing error: {0}")]
    Processing(String),
}

impl IntoResponse for StaffApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            StaffApiError::InvalidCode => (StatusCode::UNAUTHORIZED, self.to_string()),
            StaffApiError::Forbidden => (StatusCode::FORBIDDEN, self.to_string()),
            StaffApiError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            StaffApiError::Processing(m) => {
                tracing::error!(error = %m, "Processing error in staff");
                (StatusCode::INTERNAL_SERVER_ERROR, m)
            }
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
    pub avatar_photo_url: Option<String>,
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
    pub avatar_photo_url: Option<String>,
    pub max_discount_percent: Decimal,
    pub employment_start_date: Option<NaiveDate>,
    pub employment_end_date: Option<NaiveDate>,
    pub birthday_month: Option<i16>,
    pub birthday_day: Option<i16>,
    pub employee_customer_id: Option<Uuid>,
    pub employee_customer_code: Option<String>,
    pub notification_preferences: serde_json::Value,
    pub podium_user_uid: Option<String>,
    pub podium_display_name: Option<String>,
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
    pub avatar_photo_url: Option<String>,
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
    #[serde(default)]
    pub commission_effective_start_date: Option<NaiveDate>,
    #[serde(default)]
    pub recalculate_commissions_from_effective_date: Option<bool>,
    #[serde(default)]
    pub commission_change_note: Option<String>,
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
    pub birthday_month: Option<i16>,
    #[serde(default)]
    pub birthday_day: Option<i16>,
    #[serde(default)]
    pub clear_birthday: bool,
    #[serde(default)]
    pub employee_customer_id: Option<Uuid>,
    /// When true, clear `employee_customer_id` (wins over `employee_customer_id`).
    #[serde(default)]
    pub detach_employee_customer: bool,
    #[serde(default)]
    pub cashier_code: Option<String>,
    #[serde(default)]
    pub podium_user_uid: Option<String>,
    #[serde(default)]
    pub podium_display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchStaffPermissionsBody {
    /// Permission keys this staff member is allowed (full replace for non-admin).
    pub granted: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct StaffBirthdayGreetingResponse {
    pub show: bool,
    pub title: Option<String>,
    pub body: Option<String>,
    pub birthday_local_date: String,
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
    pub staff_avatar_photo_url: Option<String>,
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
        .route(
            "/birthday-greeting/today",
            get(get_staff_birthday_greeting_today),
        )
        .route(
            "/birthday-greeting/seen",
            post(mark_staff_birthday_greeting_seen),
        )
        .route("/self", get(self_get_profile).patch(self_patch_profile))
        .route("/self/avatar", patch(self_patch_staff_avatar))
        .route("/self/set-pin", post(self_set_pin))
        .route("/self/pricing-limits", get(self_pricing_limits))
        .route("/self/register-metrics", get(self_register_metrics))
        .route("/admin/access-log", get(admin_access_log))
        .route("/admin/roster", get(admin_roster))
        .route("/admin/podium-users", get(admin_get_podium_users))
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
        .route(
            "/admin/{staff_id}/avatar-photo",
            post(admin_upload_avatar_photo).delete(admin_delete_avatar_photo),
        )
        .route("/admin/{staff_id}", patch(admin_patch_staff))
        .route("/admin", post(admin_create_staff))
        // Commission incentive rules (fixed SPIFFs and combos)
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
        "avatar_photo_url": staff.avatar_photo_url,
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
            s.avatar_photo_url,
            s.max_discount_percent,
            s.employment_start_date,
            s.employment_end_date,
            s.birthday_month,
            s.birthday_day,
            s.employee_customer_id,
            NULLIF(trim(c.customer_code), '') AS employee_customer_code,
            COALESCE(s.notification_preferences, '{}'::jsonb) AS notification_preferences,
            NULLIF(trim(s.podium_user_uid), '') AS podium_user_uid,
            NULLIF(trim(s.podium_display_name), '') AS podium_display_name
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
    pub notification_preferences: Option<notifications::StaffNotificationPreferences>,
    pub employee_customer_id: Option<Uuid>,
    #[serde(default)]
    pub podium_user_uid: Option<String>,
    #[serde(default)]
    pub podium_display_name: Option<String>,
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

    if let Some(ref prefs) = body.notification_preferences {
        sqlx::query("UPDATE staff SET notification_preferences = $1 WHERE id = $2")
            .bind(serde_json::to_value(prefs).unwrap_or_else(|_| json!({})))
            .bind(staff.id)
            .execute(&mut *tx)
            .await?;
    }

    if let Some(ref uid) = body.podium_user_uid {
        let trimmed = uid.trim();
        sqlx::query("UPDATE staff SET podium_user_uid = $1 WHERE id = $2")
            .bind(if trimmed.is_empty() {
                None::<String>
            } else {
                Some(trimmed.to_string())
            })
            .bind(staff.id)
            .execute(&mut *tx)
            .await?;
    }

    if let Some(ref name) = body.podium_display_name {
        let trimmed = name.trim();
        sqlx::query("UPDATE staff SET podium_display_name = $1 WHERE id = $2")
            .bind(if trimmed.is_empty() {
                None::<String>
            } else {
                Some(trimmed.to_string())
            })
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
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM staff WHERE cashier_code = $1 AND id != $2)",
    )
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
    let tz_name = tasks::load_store_timezone_name(&state.db).await?;
    let today = tasks::store_local_date(&tz_name);
    let rows = sqlx::query_as::<_, StaffListRow>(
        r#"
        SELECT id, full_name, role, avatar_key, avatar_photo_url
        FROM staff
        WHERE is_active = TRUE
        ORDER BY
            CASE
                WHEN role IN ('admin', 'salesperson', 'sales_support', 'staff_support', 'alterations')
                     AND staff_effective_working_day(id, $1) THEN 0
                WHEN role IN ('admin', 'salesperson', 'sales_support', 'staff_support', 'alterations') THEN 1
                ELSE 2
            END,
            full_name ASC
        "#,
    )
    .bind(today)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn current_staff_birthday_greeting(
    state: &AppState,
    staff_id: Uuid,
) -> Result<Option<StaffBirthdayGreetingResponse>, StaffApiError> {
    let tz_name = tasks::load_store_timezone_name(&state.db).await?;
    let today = tasks::store_local_date(&tz_name);
    let Some((full_name, birthday_month, birthday_day)) =
        sqlx::query_as::<_, (String, Option<i16>, Option<i16>)>(
            r#"
        SELECT full_name, birthday_month, birthday_day
        FROM staff
        WHERE id = $1
          AND is_active = TRUE
          AND (employment_end_date IS NULL OR employment_end_date >= $2)
        "#,
        )
        .bind(staff_id)
        .bind(today)
        .fetch_optional(&state.db)
        .await?
    else {
        return Ok(None);
    };

    let (Some(month), Some(day)) = (birthday_month, birthday_day) else {
        return Ok(None);
    };
    if !birthday_observed_on(today, month, day) {
        return Ok(None);
    }
    if !staff_schedule::is_working_day(&state.db, staff_id, today).await? {
        return Ok(None);
    }

    let already_seen: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM staff_birthday_popup_seen
            WHERE staff_id = $1
              AND birthday_local_date = $2
        )
        "#,
    )
    .bind(staff_id)
    .bind(today)
    .fetch_one(&state.db)
    .await?;
    if already_seen {
        return Ok(None);
    }

    let first_name = full_name
        .split_whitespace()
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(full_name.as_str());

    Ok(Some(StaffBirthdayGreetingResponse {
        show: true,
        title: Some(format!("Happy Birthday, {first_name}")),
        body: Some("Your Riverside crew is glad you are here today. Hope your shift has a little extra sparkle.".to_string()),
        birthday_local_date: today.format("%Y-%m-%d").to_string(),
    }))
}

async fn get_staff_birthday_greeting_today(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<StaffBirthdayGreetingResponse>, StaffApiError> {
    let staff = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;
    let tz_name = tasks::load_store_timezone_name(&state.db).await?;
    let today = tasks::store_local_date(&tz_name);
    let fallback = StaffBirthdayGreetingResponse {
        show: false,
        title: None,
        body: None,
        birthday_local_date: today.format("%Y-%m-%d").to_string(),
    };
    Ok(Json(
        current_staff_birthday_greeting(&state, staff.id)
            .await?
            .unwrap_or(fallback),
    ))
}

async fn mark_staff_birthday_greeting_seen(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let staff = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;
    let Some(greeting) = current_staff_birthday_greeting(&state, staff.id).await? else {
        return Ok(Json(json!({ "status": "not_applicable" })));
    };
    let parsed_date = NaiveDate::parse_from_str(&greeting.birthday_local_date, "%Y-%m-%d")
        .map_err(|_| StaffApiError::InvalidPayload("invalid local date".to_string()))?;
    sqlx::query(
        r#"
        INSERT INTO staff_birthday_popup_seen (staff_id, birthday_local_date)
        VALUES ($1, $2)
        ON CONFLICT (staff_id, birthday_local_date) DO UPDATE
        SET seen_at = now()
        "#,
    )
    .bind(staff.id)
    .bind(parsed_date)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "status": "seen" })))
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
        avatar_photo_url: staff.avatar_photo_url,
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
        if body.staff_id.is_none() {
            return Err(StaffApiError::InvalidPayload(
                "Manager Access approvals require staff_id plus Access PIN".to_string(),
            ));
        }
        let effective = effective_permissions_for_staff(&state.db, staff.id, staff.role).await?;
        if !staff_has_permission(&effective, MANAGER_APPROVAL) {
            return Err(StaffApiError::Forbidden);
        }
        let approved_at = Utc::now();
        let meta = match body.authorize_metadata.unwrap_or_else(|| json!({})) {
            serde_json::Value::Object(mut object) => {
                object.insert(
                    "approved_by_staff_id".to_string(),
                    serde_json::Value::String(staff.id.to_string()),
                );
                object.insert(
                    "approved_by_staff_name".to_string(),
                    serde_json::Value::String(staff.full_name.clone()),
                );
                object.insert("approved_by_role".to_string(), json!(staff.role));
                object.insert("approved_at".to_string(), json!(approved_at));
                object.insert("approval_method".to_string(), json!("staff_id_access_pin"));
                serde_json::Value::Object(object)
            }
            value => json!({
                "details": value,
                "approved_by_staff_id": staff.id,
                "approved_by_staff_name": staff.full_name,
                "approved_by_role": staff.role,
                "approved_at": approved_at,
                "approval_method": "staff_id_access_pin",
            }),
        };
        let _ = pins::log_staff_access(&state.db, staff.id, &action, meta).await;
    }

    Ok(Json(VerifyCashierResponse {
        staff_id: staff.id,
        full_name: staff.full_name,
        role: staff.role,
        avatar_key: staff.avatar_key,
        avatar_photo_url: staff.avatar_photo_url,
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
            st.avatar_photo_url AS staff_avatar_photo_url,
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
            s.avatar_photo_url,
            s.max_discount_percent,
            s.employment_start_date,
            s.employment_end_date,
            s.birthday_month,
            s.birthday_day,
            s.employee_customer_id,
            NULLIF(trim(c.customer_code), '') AS employee_customer_code,
            COALESCE(s.notification_preferences, '{}'::jsonb) AS notification_preferences,
            NULLIF(trim(s.podium_user_uid), '') AS podium_user_uid,
            NULLIF(trim(s.podium_display_name), '') AS podium_display_name
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

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn valid_birthday_month_day(month: i16, day: i16) -> bool {
    if !(1..=12).contains(&month) {
        return false;
    }
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => 29,
        _ => 0,
    };
    (1..=max_day).contains(&day)
}

fn validate_birthday_pair(month: Option<i16>, day: Option<i16>) -> Result<(), StaffApiError> {
    match (month, day) {
        (None, None) => Ok(()),
        (Some(m), Some(d)) if valid_birthday_month_day(m, d) => Ok(()),
        (Some(_), Some(_)) => Err(StaffApiError::InvalidPayload(
            "birthday must be a valid month/day".to_string(),
        )),
        _ => Err(StaffApiError::InvalidPayload(
            "birthday month and day must be saved together".to_string(),
        )),
    }
}

fn birthday_observed_on(local_date: NaiveDate, month: i16, day: i16) -> bool {
    let observed_month = local_date.month() as i16;
    let observed_day = local_date.day() as i16;
    if month == observed_month && day == observed_day {
        return true;
    }
    month == 2
        && day == 29
        && observed_month == 2
        && observed_day == 28
        && !is_leap_year(local_date.year())
}

fn spawn_meilisearch_staff_upsert(state: &AppState, staff_id: Uuid) {
    let Some(client) = state.meilisearch.clone() else {
        return;
    };
    let pool = state.db.clone();
    crate::logic::meilisearch_sync::spawn_meili(async move {
        crate::logic::meilisearch_sync::upsert_staff_document(&client, &pool, staff_id).await;
    });
}

async fn admin_patch_staff(
    State(state): State<AppState>,
    Path(staff_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PatchStaffRequest>,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let admin = require_staff_with_permission(&state, &headers, STAFF_EDIT)
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
        && body.birthday_month.is_none()
        && body.birthday_day.is_none()
        && !body.clear_birthday
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
    if body.clear_birthday && (body.birthday_month.is_some() || body.birthday_day.is_some()) {
        return Err(StaffApiError::InvalidPayload(
            "cannot clear and set birthday together".to_string(),
        ));
    }
    if !body.clear_birthday {
        validate_birthday_pair(body.birthday_month, body.birthday_day)?;
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

    let current_staff: (DbStaffRole, bool, String, Decimal) = sqlx::query_as(
        "SELECT role, is_active, full_name, base_commission_rate FROM staff WHERE id = $1",
    )
    .bind(staff_id)
    .fetch_one(&state.db)
    .await?;
    let (current_role, current_is_active, current_name, current_rate) = current_staff;

    let next_role = body.role.unwrap_or(current_role);
    let next_is_active = body.is_active.unwrap_or(current_is_active);
    let admin_access_removed =
        current_role == DbStaffRole::Admin && (next_role != DbStaffRole::Admin || !next_is_active);

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
                "cannot deactivate {current_name} while they still own open register sessions"
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
    let rate_change_requested = body
        .base_commission_rate
        .map(|rate| rate != current_rate)
        .unwrap_or(false);
    let commission_effective_start_date = body
        .commission_effective_start_date
        .unwrap_or_else(|| Utc::now().date_naive());
    let commission_change_note = body
        .commission_change_note
        .as_ref()
        .map(|note| note.trim())
        .filter(|note| !note.is_empty())
        .map(ToOwned::to_owned);
    let recalculate_commissions_from_effective_date = body
        .recalculate_commissions_from_effective_date
        .unwrap_or(rate_change_requested);

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
    let podium_uid_bind = body.podium_user_uid.as_ref().map(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    });
    let podium_name_bind = body.podium_display_name.as_ref().map(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    });

    let mut tx = state.db.begin().await?;

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
            employee_customer_id = CASE WHEN $13 THEN $14 ELSE employee_customer_id END,
            podium_user_uid = CASE WHEN $15 THEN $16 ELSE podium_user_uid END,
            podium_display_name = CASE WHEN $17 THEN $18 ELSE podium_display_name END,
            birthday_month = CASE WHEN $19 THEN NULL ELSE COALESCE($20, birthday_month) END,
            birthday_day = CASE WHEN $19 THEN NULL ELSE COALESCE($21, birthday_day) END
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
    .bind(body.podium_user_uid.is_some())
    .bind(podium_uid_bind.flatten())
    .bind(body.podium_display_name.is_some())
    .bind(podium_name_bind.flatten())
    .bind(body.clear_birthday)
    .bind(body.birthday_month)
    .bind(body.birthday_day)
    .execute(&mut *tx)
    .await?;

    // Auto-sync permissions and discount limits if role changed
    if let Some(new_role) = body.role {
        if new_role != current_role {
            // 1. Sync max_discount_percent if not explicitly provided in the patch
            if body.max_discount_percent.is_none() {
                sqlx::query(
                    r#"
                    UPDATE staff SET max_discount_percent = COALESCE(
                        (SELECT max_discount_percent FROM staff_role_pricing_limits WHERE role = $1),
                        30::numeric
                    )
                    WHERE id = $2
                    "#,
                )
                .bind(new_role)
                .bind(staff_id)
                .execute(&mut *tx)
                .await?;
            }

            // 2. Regenerate staff_permission from role defaults + overrides
            if new_role != DbStaffRole::Admin {
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
                    ON CONFLICT DO NOTHING
                    "#,
                )
                .bind(staff_id)
                .bind(new_role)
                .execute(&mut *tx)
                .await?;

                // Apply existing deny overrides
                sqlx::query(
                    r#"
                    DELETE FROM staff_permission sp
                    USING staff_permission_override o
                    WHERE sp.staff_id = o.staff_id
                      AND sp.staff_id = $1
                      AND sp.permission_key = o.permission_key
                      AND o.effect = 'deny'
                    "#,
                )
                .bind(staff_id)
                .execute(&mut *tx)
                .await?;

                // Apply existing allow overrides
                sqlx::query(
                    r#"
                    INSERT INTO staff_permission (staff_id, permission_key, allowed)
                    SELECT o.staff_id, o.permission_key, true
                    FROM staff_permission_override o
                    WHERE o.staff_id = $1 AND o.effect = 'allow'
                    ON CONFLICT (staff_id, permission_key) DO UPDATE SET allowed = true
                    "#,
                )
                .bind(staff_id)
                .execute(&mut *tx)
                .await?;
            }
        }
    }

    let mut reconciled_line_count = 0u64;
    if rate_change_requested {
        let new_rate = body.base_commission_rate.unwrap_or(current_rate);

        let has_history: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM staff_commission_rate_history WHERE staff_id = $1)",
        )
        .bind(staff_id)
        .fetch_one(&mut *tx)
        .await?;

        if !has_history {
            sqlx::query(
                r#"
                INSERT INTO staff_commission_rate_history (
                    staff_id, effective_start_date, base_commission_rate, changed_by_staff_id, note
                )
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (staff_id, effective_start_date) DO NOTHING
                "#,
            )
            .bind(staff_id)
            .bind(NaiveDate::from_ymd_opt(1900, 1, 1).expect("valid baseline date"))
            .bind(current_rate)
            .bind(admin.id)
            .bind("Baseline before effective-dated commission change")
            .execute(&mut *tx)
            .await?;
        }

        sqlx::query(
            r#"
            INSERT INTO staff_commission_rate_history (
                staff_id, effective_start_date, base_commission_rate, changed_by_staff_id, note
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (staff_id, effective_start_date) DO UPDATE SET
                base_commission_rate = EXCLUDED.base_commission_rate,
                changed_by_staff_id = EXCLUDED.changed_by_staff_id,
                note = EXCLUDED.note,
                created_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(staff_id)
        .bind(commission_effective_start_date)
        .bind(new_rate)
        .bind(admin.id)
        .bind(commission_change_note.as_deref())
        .execute(&mut *tx)
        .await?;

        if recalculate_commissions_from_effective_date {
            reconciled_line_count = crate::logic::commission_recalc::recalc_staff_commissions_from(
                &mut tx,
                staff_id,
                commission_effective_start_date,
            )
            .await?;
        }
    }

    tx.commit().await?;

    spawn_meilisearch_staff_upsert(&state, staff_id);

    if rate_change_requested {
        let _ = log_staff_access(
            &state.db,
            admin.id,
            "admin_staff_commission_rate_change",
            json!({
                "target_staff_id": staff_id,
                "target_staff_name": current_name,
                "prior_rate": current_rate,
                "new_rate": body.base_commission_rate,
                "effective_start_date": commission_effective_start_date,
                "recalculate_commissions_from_effective_date": recalculate_commissions_from_effective_date,
                "reconciled_line_count": reconciled_line_count,
                "note": commission_change_note,
            }),
        )
        .await;
    }

    Ok(Json(json!({
        "status": "updated",
        "reconciled_line_count": reconciled_line_count,
    })))
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
               0::numeric(5, 4) AS commission_rate
        FROM categories c
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

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "admin_category_commission_rejected",
        json!({
            "category_id": category_id,
            "attempted_rate": body.commission_rate,
            "reason": "legacy category percentage overrides are retired"
        }),
    )
    .await;

    Err(StaffApiError::InvalidPayload(
        "category commission percentage overrides are retired; use Staff Profile base rates and fixed SPIFFs"
            .to_string(),
    ))
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

// --- Commission Rules (fixed SPIFFs and combos) Handlers ---

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
    let _ = require_staff_with_permission(&state, &headers, STAFF_MANAGE_COMMISSION)
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

    let match_type = body.match_type.trim().to_ascii_lowercase();
    if !matches!(match_type.as_str(), "category" | "product" | "variant") {
        return Err(StaffApiError::InvalidPayload(
            "commission rule target must be category, product, or variant".to_string(),
        ));
    }
    if body.override_rate.is_some() {
        return Err(StaffApiError::InvalidPayload(
            "commission percentage overrides are retired; use Staff Profile base rates and fixed SPIFFs"
                .to_string(),
        ));
    }
    let fixed_spiff_amount = body.fixed_spiff_amount.unwrap_or(Decimal::ZERO);
    if fixed_spiff_amount <= Decimal::ZERO {
        return Err(StaffApiError::InvalidPayload(
            "fixed SPIFF amount must be greater than zero".to_string(),
        ));
    }
    let label = body
        .label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| StaffApiError::InvalidPayload("rule label is required".to_string()))?
        .to_string();
    if let (Some(start), Some(end)) = (body.start_date, body.end_date) {
        if end <= start {
            return Err(StaffApiError::InvalidPayload(
                "rule end date must be after start date".to_string(),
            ));
        }
    }
    let target_exists: bool = match match_type.as_str() {
        "category" => sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM categories WHERE id = $1)"),
        "product" => sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM products WHERE id = $1)"),
        "variant" => {
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM product_variants WHERE id = $1)")
        }
        _ => unreachable!(),
    }
    .bind(body.match_id)
    .fetch_one(&state.db)
    .await?;
    if !target_exists {
        return Err(StaffApiError::InvalidPayload(format!(
            "commission rule {match_type} target not found"
        )));
    }

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
        .bind(&match_type)
        .bind(body.match_id)
        .bind(Option::<Decimal>::None)
        .bind(fixed_spiff_amount)
        .bind(&label)
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
        .bind(&match_type)
        .bind(body.match_id)
        .bind(Option::<Decimal>::None)
        .bind(fixed_spiff_amount)
        .bind(&label)
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
    pub match_type: String, // 'category' or 'product'
    pub match_id: Uuid,
    pub qty_required: i32,
}

async fn list_commission_combos(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let _ = require_staff_with_permission(&state, &headers, STAFF_MANAGE_COMMISSION)
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
                    'qty_required', ri.qty_required,
                    'category_name', c.name,
                    'product_name', COALESCE(p.name, pv_product.name),
                    'sku', pv.sku,
                    'variation_label', pv.variation_label
                ))
                FROM commission_combo_rule_items ri
                LEFT JOIN categories c ON ri.match_type = 'category' AND c.id = ri.match_id
                LEFT JOIN products p ON ri.match_type = 'product' AND p.id = ri.match_id
                LEFT JOIN product_variants pv ON ri.match_type = 'variant' AND pv.id = ri.match_id
                LEFT JOIN products pv_product ON pv_product.id = pv.product_id
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

    let label = body.label.trim();
    if label.is_empty() {
        return Err(StaffApiError::InvalidPayload(
            "combo label is required".to_string(),
        ));
    }
    if body.reward_amount <= Decimal::ZERO {
        return Err(StaffApiError::InvalidPayload(
            "combo reward amount must be greater than zero".to_string(),
        ));
    }
    if !(3..=4).contains(&body.items.len()) {
        return Err(StaffApiError::InvalidPayload(
            "combo rewards require 3 or 4 item requirements".to_string(),
        ));
    }
    for item in &body.items {
        let match_type = item.match_type.trim().to_ascii_lowercase();
        if !matches!(match_type.as_str(), "category" | "product") {
            return Err(StaffApiError::InvalidPayload(
                "combo requirement target must be category or product".to_string(),
            ));
        }
        if item.qty_required <= 0 {
            return Err(StaffApiError::InvalidPayload(
                "combo requirement quantity must be greater than zero".to_string(),
            ));
        }
        let target_exists: bool = match match_type.as_str() {
            "category" => {
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM categories WHERE id = $1)")
            }
            "product" => sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM products WHERE id = $1)"),
            _ => unreachable!(),
        }
        .bind(item.match_id)
        .fetch_one(&state.db)
        .await?;
        if !target_exists {
            return Err(StaffApiError::InvalidPayload(format!(
                "combo {match_type} target not found"
            )));
        }
    }

    let mut tx = state.db.begin().await?;

    let rule_id = if let Some(id) = body.id {
        sqlx::query_scalar::<_, Uuid>("UPDATE commission_combo_rules SET label = $1, reward_amount = $2, is_active = $3 WHERE id = $4 RETURNING id")
            .bind(label)
            .bind(body.reward_amount)
            .bind(body.is_active)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?
    } else {
        sqlx::query_scalar::<_, Uuid>("INSERT INTO commission_combo_rules (label, reward_amount, is_active) VALUES ($1, $2, $3) RETURNING id")
            .bind(label)
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
        let match_type = item.match_type.trim().to_ascii_lowercase();
        sqlx::query("INSERT INTO commission_combo_rule_items (rule_id, match_type, match_id, qty_required) VALUES ($1, $2, $3, $4)")
            .bind(rule_id)
            .bind(match_type)
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
        json!({ "rule_id": rule_id, "label": label }),
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
    validate_birthday_pair(body.birthday_month, body.birthday_day)?;

    let initial_pin = body
        .cashier_code
        .as_ref()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "1234".to_string());
    let pin_hash = hash_pin(&initial_pin)
        .map_err(|_| StaffApiError::InvalidPayload("could not hash initial PIN".to_string()))?;

    let base_rate = body.base_commission_rate.unwrap_or(Decimal::new(200, 4)); // 2%
    let role = body.role.unwrap_or(DbStaffRole::Salesperson);

    let max_disc = if let Some(m) = body.max_discount_percent {
        m
    } else {
        sqlx::query_scalar::<_, Decimal>(
            "SELECT max_discount_percent FROM staff_role_pricing_limits WHERE role = $1",
        )
        .bind(role)
        .fetch_optional(&state.db)
        .await?
        .unwrap_or(Decimal::new(30, 0)) // 30% fallback
    };

    let mut tx = state.db.begin().await?;

    let new_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO staff (
            full_name, cashier_code, pin_hash, role, is_active,
            base_commission_rate, phone, email, avatar_key, max_discount_percent,
            employment_start_date, employment_end_date, employee_customer_id,
            podium_user_uid, podium_display_name, birthday_month, birthday_day
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
    .bind(
        body.podium_user_uid
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty()),
    )
    .bind(
        body.podium_display_name
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty()),
    )
    .bind(body.birthday_month)
    .bind(body.birthday_day)
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

async fn admin_upload_avatar_photo(
    State(state): State<AppState>,
    Path(staff_id): Path<Uuid>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let admin = require_staff_with_permission(&state, &headers, STAFF_EDIT)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let mut image_bytes: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| StaffApiError::InvalidPayload(format!("multipart error: {e}")))?
    {
        if field.name() == Some("photo") {
            image_bytes = Some(
                field
                    .bytes()
                    .await
                    .map_err(|e| StaffApiError::InvalidPayload(format!("read error: {e}")))?
                    .to_vec(),
            );
        }
    }

    let bytes = image_bytes
        .ok_or_else(|| StaffApiError::InvalidPayload("missing 'photo' field".to_string()))?;

    if bytes.len() > 10 * 1024 * 1024 {
        return Err(StaffApiError::InvalidPayload(
            "image exceeds 10MB".to_string(),
        ));
    }

    let processed = staff_avatar_processor::process_staff_avatar(&bytes)
        .map_err(|e| StaffApiError::InvalidPayload(e.to_string()))?;

    let upload_dir = std::path::PathBuf::from("uploads/avatars");
    tokio::fs::create_dir_all(&upload_dir).await.ok();
    let file_name = format!("{staff_id}.jpg");
    let file_path = upload_dir.join(&file_name);

    tokio::fs::write(&file_path, &processed)
        .await
        .map_err(|e| StaffApiError::Processing(format!("save failed: {e}")))?;

    let photo_url = format!("/uploads/avatars/{file_name}");
    sqlx::query("UPDATE staff SET avatar_photo_url = $1 WHERE id = $2")
        .bind(&photo_url)
        .bind(staff_id)
        .execute(&state.db)
        .await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "admin_staff_avatar_photo_upload",
        json!({ "target_staff_id": staff_id, "size_bytes": processed.len() }),
    )
    .await;

    Ok(Json(
        json!({ "status": "updated", "avatar_photo_url": photo_url }),
    ))
}

async fn admin_delete_avatar_photo(
    State(state): State<AppState>,
    Path(staff_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let admin = require_staff_with_permission(&state, &headers, STAFF_EDIT)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    sqlx::query("UPDATE staff SET avatar_photo_url = NULL WHERE id = $1")
        .bind(staff_id)
        .execute(&state.db)
        .await?;

    let file_path = format!("uploads/avatars/{staff_id}.jpg");
    let _ = tokio::fs::remove_file(&file_path).await;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "admin_staff_avatar_photo_delete",
        json!({ "target_staff_id": staff_id }),
    )
    .await;

    Ok(Json(json!({ "status": "deleted" })))
}

async fn get_staff_avatar(Path(id): Path<String>, State(state): State<AppState>) -> Response {
    // First, try to serve a real uploaded photo if one exists.
    if let Ok(uid) = Uuid::parse_str(&id) {
        if let Ok(Some(url)) = sqlx::query_scalar::<_, Option<String>>(
            "SELECT avatar_photo_url FROM staff WHERE id = $1",
        )
        .bind(uid)
        .fetch_one(&state.db)
        .await
        {
            let file_name = url.trim_start_matches("/uploads/avatars/");
            let paths = vec![
                format!("uploads/avatars/{file_name}"),
                format!("../uploads/avatars/{file_name}"),
            ];
            for path in paths {
                if let Ok(data) = tokio::fs::read(&path).await {
                    return Response::builder()
                        .header("Content-Type", "image/jpeg")
                        .header("Cache-Control", "public, max-age=3600")
                        .body(axum::body::Body::from(data))
                        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
                }
            }
        }
    }

    // Fall back to SVG avatar_key system.
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

async fn admin_get_podium_users(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StaffApiError> {
    let _admin = require_staff_with_permission(&state, &headers, STAFF_EDIT)
        .await
        .map_err(|_| StaffApiError::Forbidden)?;

    let users = crate::logic::podium::list_podium_users_combined(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
    )
    .await
    .map_err(|e| StaffApiError::Processing(e.to_string()))?;

    Ok(Json(serde_json::Value::Array(users)))
}
