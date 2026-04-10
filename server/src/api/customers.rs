//! Customer search, profile, marketing flags, and wedding memberships.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    CUSTOMERS_COUPLE_MANAGE, CUSTOMERS_DUPLICATE_REVIEW, CUSTOMERS_HUB_EDIT, CUSTOMERS_HUB_VIEW,
    CUSTOMERS_MEASUREMENTS, CUSTOMERS_MERGE, CUSTOMERS_RMS_CHARGE, CUSTOMERS_TIMELINE,
    CUSTOMER_GROUPS_MANAGE, ORDERS_VIEW, STORE_CREDIT_MANAGE,
};
use crate::logic::customer_duplicate_candidates::find_duplicate_candidates;
use crate::logic::customer_hub::{days_since_last_visit, fetch_hub_stats};
use crate::logic::customer_measurements;
use crate::logic::customer_merge;
use crate::logic::customer_open_deposit;
use crate::logic::customer_order_history::{
    query_customer_order_history, CustomerOrderHistoryQuery, CustomerOrderHistoryResponse,
};
use crate::logic::customers::{
    insert_customer, is_profile_complete, InsertCustomerParams, ProfileFields,
};
use crate::logic::lightspeed_customers::{
    execute_lightspeed_customer_import, LightspeedCustomerImportPayload,
    LightspeedCustomerImportSummary,
};
use crate::logic::podium;
use crate::logic::podium_messaging;
use crate::logic::store_credit;
use crate::logic::wedding_party_display::SQL_PARTY_TRACKING_LABEL_WP;
use crate::middleware;
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;

#[derive(Debug, Error)]
pub enum CustomerError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Customer search requires at least 2 characters")]
    QueryTooShort,
    #[error("First and last name are required")]
    NameRequired,
    #[error("Customer not found")]
    NotFound,
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    PodiumUnavailable(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    Logic(String),
}

impl IntoResponse for CustomerError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            CustomerError::QueryTooShort => (
                StatusCode::BAD_REQUEST,
                "Customer search requires at least 2 characters".to_string(),
            ),
            CustomerError::NameRequired => (
                StatusCode::BAD_REQUEST,
                "First and last name are required".to_string(),
            ),
            CustomerError::NotFound => (StatusCode::NOT_FOUND, "Customer not found".to_string()),
            CustomerError::Conflict(m) => (StatusCode::CONFLICT, m),
            CustomerError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            CustomerError::PodiumUnavailable(m) => (StatusCode::BAD_GATEWAY, m),
            CustomerError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            CustomerError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            CustomerError::Logic(m) => (StatusCode::BAD_REQUEST, m),
            CustomerError::Database(e) => {
                tracing::error!(error = %e, "Database error in customers");
                let msg = e.to_string();
                if msg.contains("customers_email_key")
                    || (msg.contains("unique constraint") && msg.contains("email"))
                {
                    (
                        StatusCode::CONFLICT,
                        "Email already in use by another customer".to_string(),
                    )
                } else {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Internal server error".to_string(),
                    )
                }
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

fn spawn_meilisearch_customer_hooks(state: &AppState, customer_id: Uuid) {
    let ms = state.meilisearch.clone();
    let pool = state.db.clone();
    if let Some(c) = ms {
        tokio::spawn(async move {
            crate::logic::meilisearch_sync::upsert_customer_document(&c, &pool, customer_id).await;
            let Ok(pids): Result<Vec<Uuid>, _> = sqlx::query_scalar(
                "SELECT DISTINCT wm.wedding_party_id FROM wedding_members wm WHERE wm.customer_id = $1",
            )
            .bind(customer_id)
            .fetch_all(&pool)
            .await
            else {
                return;
            };
            for pid in pids {
                crate::logic::meilisearch_sync::upsert_wedding_party_document(&c, &pool, pid).await;
            }
        });
    }
}

async fn require_customer_access(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), CustomerError> {
    middleware::require_staff_or_pos_register_session(state, headers)
        .await
        .map(|_| ())
        .map_err(|(_, axum::Json(v))| {
            let msg = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("unauthorized")
                .to_string();
            CustomerError::Unauthorized(msg)
        })
}

fn map_perm_or_pos_err(
    (status, axum::Json(v)): (StatusCode, axum::Json<serde_json::Value>),
) -> CustomerError {
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("unauthorized")
        .to_string();
    if status == StatusCode::FORBIDDEN {
        CustomerError::Forbidden(msg)
    } else {
        CustomerError::Unauthorized(msg)
    }
}

/// Staff with **Back Office permission** or **valid open register POS session** (same pattern as receiving).
async fn require_customer_perm_or_pos(
    state: &AppState,
    headers: &HeaderMap,
    permission: &str,
) -> Result<(), CustomerError> {
    middleware::require_staff_perm_or_pos_session(state, headers, permission)
        .await
        .map(|_| ())
        .map_err(map_perm_or_pos_err)
}

async fn staff_id_from_customer_perm_or_pos(
    state: &AppState,
    headers: &HeaderMap,
    permission: &str,
) -> Result<Option<Uuid>, CustomerError> {
    match middleware::require_staff_perm_or_pos_session(state, headers, permission)
        .await
        .map_err(map_perm_or_pos_err)?
    {
        middleware::StaffOrPosSession::Staff(s) => Ok(Some(s.id)),
        middleware::StaffOrPosSession::PosSession { .. } => Ok(None),
    }
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
    /// Max rows (default 25; hard cap 100).
    pub limit: Option<i64>,
    /// Pagination offset into `ORDER BY c.created_at DESC`.
    pub offset: Option<i64>,
}

/// Search results — slim card for POS / wedding picker.
#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct Customer {
    pub id: Uuid,
    pub customer_code: String,
    pub first_name: String,
    pub last_name: String,
    pub company_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub wedding_active: bool,
    pub wedding_party_name: Option<String>,
    pub wedding_party_id: Option<Uuid>,
    pub wedding_member_id: Option<Uuid>,
    pub couple_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct CreateCustomerRequest {
    pub first_name: String,
    pub last_name: String,
    pub company_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address_line1: Option<String>,
    pub address_line2: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub postal_code: Option<String>,
    pub date_of_birth: Option<NaiveDate>,
    pub anniversary_date: Option<NaiveDate>,
    pub custom_field_1: Option<String>,
    pub custom_field_2: Option<String>,
    pub custom_field_3: Option<String>,
    pub custom_field_4: Option<String>,
    pub marketing_email_opt_in: Option<bool>,
    pub marketing_sms_opt_in: Option<bool>,
    pub transactional_sms_opt_in: Option<bool>,
    #[serde(default)]
    pub transactional_email_opt_in: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCustomerRequest {
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub company_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address_line1: Option<String>,
    pub address_line2: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub postal_code: Option<String>,
    pub date_of_birth: Option<NaiveDate>,
    pub anniversary_date: Option<NaiveDate>,
    pub custom_field_1: Option<String>,
    pub custom_field_2: Option<String>,
    pub custom_field_3: Option<String>,
    pub custom_field_4: Option<String>,
    pub marketing_email_opt_in: Option<bool>,
    pub marketing_sms_opt_in: Option<bool>,
    pub transactional_sms_opt_in: Option<bool>,
    #[serde(default)]
    pub transactional_email_opt_in: Option<bool>,
    #[serde(default)]
    pub podium_conversation_url: Option<String>,
    pub is_vip: Option<bool>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CustomerProfileRow {
    pub id: Uuid,
    pub customer_code: String,
    pub first_name: String,
    pub last_name: String,
    pub company_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address_line1: Option<String>,
    pub address_line2: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub postal_code: Option<String>,
    pub date_of_birth: Option<NaiveDate>,
    pub anniversary_date: Option<NaiveDate>,
    pub custom_field_1: Option<String>,
    pub custom_field_2: Option<String>,
    pub custom_field_3: Option<String>,
    pub custom_field_4: Option<String>,
    pub marketing_email_opt_in: bool,
    pub marketing_sms_opt_in: bool,
    pub transactional_sms_opt_in: bool,
    pub transactional_email_opt_in: bool,
    pub podium_conversation_url: Option<String>,
    pub is_vip: bool,
    pub loyalty_points: i32,
    /// `store` or `online_store` (migration 77+).
    pub customer_created_source: String,
    pub couple_id: Option<Uuid>,
    pub couple_primary_id: Option<Uuid>,
    pub couple_linked_at: Option<DateTime<Utc>>,
}

async fn load_customer_profile_row(
    pool: &sqlx::PgPool,
    customer_id: Uuid,
) -> Result<CustomerProfileRow, CustomerError> {
    let row = sqlx::query_as::<_, CustomerProfileRow>(
        r#"
        SELECT
            id, customer_code,
            COALESCE(first_name, '') AS first_name,
            COALESCE(last_name, '') AS last_name,
            company_name, email, phone,
            address_line1, address_line2, city, state, postal_code,
            date_of_birth, anniversary_date,
            custom_field_1, custom_field_2, custom_field_3, custom_field_4,
            marketing_email_opt_in, marketing_sms_opt_in, transactional_sms_opt_in,
            transactional_email_opt_in, podium_conversation_url,
            is_vip, loyalty_points, customer_created_source,
            couple_id, couple_primary_id, couple_linked_at
        FROM customers WHERE id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await?
    .ok_or(CustomerError::NotFound)?;
    Ok(row)
}

#[derive(Debug, Serialize, FromRow)]
pub struct WeddingMembershipRow {
    pub wedding_member_id: Uuid,
    pub wedding_party_id: Uuid,
    pub order_id: Option<Uuid>,
    pub party_name: String,
    pub event_date: chrono::NaiveDate,
    pub role: String,
    pub status: String,
    pub active: bool,
}

#[derive(Debug, Serialize)]
pub struct CustomerProfileResponse {
    #[serde(flatten)]
    pub customer: CustomerProfileRow,
    pub profile_complete: bool,
    pub weddings: Vec<WeddingMembershipRow>,
}

#[derive(Debug, Serialize)]
pub struct CustomerHubStats {
    pub lifetime_spend_usd: Decimal,
    pub balance_due_usd: Decimal,
    pub wedding_party_count: i64,
    pub last_activity_at: Option<DateTime<Utc>>,
    pub days_since_last_visit: Option<i64>,
    pub marketing_needs_attention: bool,
    pub loyalty_points: i32,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CoupleMemberPreview {
    pub id: Uuid,
    pub first_name: String,
    pub last_name: String,
    pub email: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CustomerHubResponse {
    #[serde(flatten)]
    pub customer: CustomerProfileRow,
    pub profile_complete: bool,
    pub weddings: Vec<WeddingMembershipRow>,
    pub stats: CustomerHubStats,
    pub partner: Option<CoupleMemberPreview>,
}

#[derive(Debug, Serialize)]
pub struct CustomerTimelineEvent {
    pub at: DateTime<Utc>,
    pub kind: String,
    pub summary: String,
    pub reference_id: Option<Uuid>,
    pub reference_type: Option<String>,
    pub wedding_party_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct CustomerTimelineResponse {
    pub events: Vec<CustomerTimelineEvent>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct MeasurementRecord {
    pub id: Uuid,
    pub neck: Option<Decimal>,
    pub sleeve: Option<Decimal>,
    pub chest: Option<Decimal>,
    pub waist: Option<Decimal>,
    pub seat: Option<Decimal>,
    pub inseam: Option<Decimal>,
    pub outseam: Option<Decimal>,
    pub shoulder: Option<Decimal>,
    #[sqlx(default)]
    pub retail_suit: Option<String>,
    #[sqlx(default)]
    pub retail_waist: Option<String>,
    #[sqlx(default)]
    pub retail_vest: Option<String>,
    #[sqlx(default)]
    pub retail_shirt: Option<String>,
    #[sqlx(default)]
    pub retail_shoe: Option<String>,
    pub measured_at: DateTime<Utc>,
    pub source: String,
}

#[derive(Debug, Serialize)]
pub struct MeasurementVaultResponse {
    pub latest: Option<MeasurementRecord>,
    pub history: Vec<MeasurementRecord>,
}

#[derive(Debug, Deserialize)]
pub struct PostCustomerNoteRequest {
    pub body: String,
    pub created_by_staff_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct CustomerBrowseQuery {
    pub q: Option<String>,
    /// When true, only VIP customers.
    pub vip_only: Option<bool>,
    /// When true, only customers with a positive open-order balance due.
    pub balance_due_only: Option<bool>,
    /// When true, only customers with a wedding party date in the next N days.
    pub wedding_soon_only: Option<bool>,
    /// Upper bound for “wedding soon” (default 30).
    pub wedding_within_days: Option<i64>,
    /// Optional wedding party name filter.
    pub wedding_party_q: Option<String>,
    pub limit: Option<i64>,
    /// Pagination offset into `ORDER BY c.last_name ASC, c.first_name ASC` (default 0).
    pub offset: Option<i64>,
    /// Filter to customers in a group (`customer_groups.code`).
    pub group_code: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CustomerBrowseRow {
    pub id: Uuid,
    pub customer_code: String,
    pub first_name: String,
    pub last_name: String,
    pub company_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub is_vip: bool,
    pub open_balance_due: Decimal,
    pub wedding_soon: bool,
    pub wedding_active: bool,
    pub wedding_party_name: Option<String>,
    pub wedding_party_id: Option<Uuid>,
    pub couple_id: Option<Uuid>,
    pub couple_primary_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct BulkCustomerVipRequest {
    pub customer_ids: Vec<Uuid>,
    pub is_vip: bool,
}

#[derive(Debug, Deserialize)]
pub struct MergeCustomersBody {
    pub master_customer_id: Uuid,
    pub slave_customer_id: Uuid,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Deserialize)]
pub struct PatchCustomerMeasurementsBody {
    pub neck: Option<Decimal>,
    pub sleeve: Option<Decimal>,
    pub chest: Option<Decimal>,
    pub waist: Option<Decimal>,
    pub seat: Option<Decimal>,
    pub inseam: Option<Decimal>,
    pub outseam: Option<Decimal>,
    pub shoulder: Option<Decimal>,
    pub retail_suit: Option<String>,
    pub retail_waist: Option<String>,
    pub retail_vest: Option<String>,
    pub retail_shirt: Option<String>,
    pub retail_shoe: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct CustomerGroupListRow {
    id: Uuid,
    code: String,
    label: String,
    member_count: i64,
}

#[derive(Debug, Deserialize)]
struct CustomerGroupMemberBody {
    customer_id: Uuid,
    group_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct RemoveCustomerGroupQuery {
    customer_id: Uuid,
    group_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct StoreCreditAdjustBody {
    amount: Decimal,
    reason: String,
}

#[derive(Debug, Deserialize)]
struct DuplicateCandidatesQuery {
    email: Option<String>,
    phone: Option<String>,
    first_name: Option<String>,
    last_name: Option<String>,
    exclude_customer_id: Option<Uuid>,
    #[serde(default = "default_dup_limit")]
    limit: i64,
}

fn default_dup_limit() -> i64 {
    20
}

async fn get_duplicate_candidates(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DuplicateCandidatesQuery>,
) -> Result<
    Json<Vec<crate::logic::customer_duplicate_candidates::DuplicateCandidateRow>>,
    CustomerError,
> {
    require_customer_access(&state, &headers).await?;
    let rows = find_duplicate_candidates(
        &state.db,
        q.email.as_deref(),
        q.phone.as_deref(),
        q.first_name.as_deref(),
        q.last_name.as_deref(),
        q.exclude_customer_id,
        q.limit,
    )
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Serialize, FromRow)]
struct DuplicateQueueListRow {
    id: Uuid,
    created_at: DateTime<Utc>,
    customer_a_id: Uuid,
    customer_b_id: Uuid,
    customer_a_code: String,
    customer_b_code: String,
    customer_a_display: String,
    customer_b_display: String,
    score: Decimal,
    reason: String,
    status: String,
}

async fn list_duplicate_review_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<DuplicateQueueListRow>>, CustomerError> {
    middleware::require_staff_with_permission(&state, &headers, CUSTOMERS_DUPLICATE_REVIEW)
        .await
        .map_err(|(_, axum::Json(v))| {
            CustomerError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("not authorized")
                    .to_string(),
            )
        })?;
    let rows = sqlx::query_as::<_, DuplicateQueueListRow>(
        r#"
        SELECT
            q.id,
            q.created_at,
            q.customer_a_id,
            q.customer_b_id,
            ca.customer_code AS customer_a_code,
            cb.customer_code AS customer_b_code,
            COALESCE(
                NULLIF(TRIM(CONCAT_WS(' ', ca.first_name, ca.last_name)), ''),
                NULLIF(TRIM(COALESCE(ca.company_name, '')), ''),
                ca.customer_code
            ) AS customer_a_display,
            COALESCE(
                NULLIF(TRIM(CONCAT_WS(' ', cb.first_name, cb.last_name)), ''),
                NULLIF(TRIM(COALESCE(cb.company_name, '')), ''),
                cb.customer_code
            ) AS customer_b_display,
            q.score,
            q.reason,
            q.status
        FROM customer_duplicate_review_queue q
        JOIN customers ca ON ca.id = q.customer_a_id
        JOIN customers cb ON cb.id = q.customer_b_id
        WHERE q.status = 'pending'
        ORDER BY q.created_at DESC
        LIMIT 200
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
struct DismissDuplicateQueueBody {
    id: Uuid,
}

#[derive(Debug, Deserialize)]
struct EnqueueDuplicateReviewBody {
    customer_a_id: Uuid,
    customer_b_id: Uuid,
    #[serde(default)]
    reason: String,
}

async fn post_duplicate_review_queue_enqueue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<EnqueueDuplicateReviewBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    middleware::require_staff_with_permission(&state, &headers, CUSTOMERS_DUPLICATE_REVIEW)
        .await
        .map_err(|(_, axum::Json(v))| {
            CustomerError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("not authorized")
                    .to_string(),
            )
        })?;
    let (a, b) = if body.customer_a_id < body.customer_b_id {
        (body.customer_a_id, body.customer_b_id)
    } else {
        (body.customer_b_id, body.customer_a_id)
    };
    if a == b {
        return Err(CustomerError::BadRequest(
            "Choose two different customers.".to_string(),
        ));
    }
    let pending: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM customer_duplicate_review_queue
            WHERE customer_a_id = $1 AND customer_b_id = $2 AND status = 'pending'
        )
        "#,
    )
    .bind(a)
    .bind(b)
    .fetch_one(&state.db)
    .await?;
    if pending {
        return Ok(Json(json!({ "status": "already_queued" })));
    }
    let reason = body.reason.trim().to_string();
    sqlx::query(
        r#"
        INSERT INTO customer_duplicate_review_queue (
            customer_a_id, customer_b_id, score, reason, status
        )
        VALUES ($1, $2, 0, $3, 'pending')
        "#,
    )
    .bind(a)
    .bind(b)
    .bind(if reason.is_empty() {
        "manual_queue".to_string()
    } else {
        reason
    })
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "status": "queued" })))
}

async fn post_duplicate_review_queue_dismiss(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<DismissDuplicateQueueBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    middleware::require_staff_with_permission(&state, &headers, CUSTOMERS_DUPLICATE_REVIEW)
        .await
        .map_err(|(_, axum::Json(v))| {
            CustomerError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("not authorized")
                    .to_string(),
            )
        })?;
    let r = sqlx::query(
        r#"
        UPDATE customer_duplicate_review_queue
        SET status = 'dismissed'
        WHERE id = $1 AND status = 'pending'
        "#,
    )
    .bind(body.id)
    .execute(&state.db)
    .await?;
    if r.rows_affected() == 0 {
        return Err(CustomerError::NotFound);
    }
    Ok(Json(json!({ "status": "dismissed" })))
}

#[derive(Debug, Deserialize)]
struct RmsChargeRecordsQuery {
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
    /// `charge`, `payment`, or omit for both.
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    customer_id: Option<Uuid>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

#[derive(Debug, Serialize, FromRow)]
struct RmsChargeRecordApiRow {
    id: Uuid,
    record_kind: String,
    created_at: DateTime<Utc>,
    order_id: Uuid,
    register_session_id: Uuid,
    customer_id: Option<Uuid>,
    payment_method: String,
    amount: Decimal,
    operator_staff_id: Option<Uuid>,
    payment_transaction_id: Option<Uuid>,
    customer_display: Option<String>,
    order_short_ref: Option<String>,
    customer_name: Option<String>,
    customer_code: Option<String>,
    operator_name: Option<String>,
}

async fn list_rms_charge_records(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<RmsChargeRecordsQuery>,
) -> Result<Json<Vec<RmsChargeRecordApiRow>>, CustomerError> {
    middleware::require_staff_with_permission(&state, &headers, CUSTOMERS_RMS_CHARGE)
        .await
        .map_err(|(_, axum::Json(v))| {
            CustomerError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("not authorized")
                    .to_string(),
            )
        })?;

    let end_naive =
        q.to.as_deref()
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .unwrap_or_else(|| Utc::now().date_naive());
    let start_naive = q
        .from
        .as_deref()
        .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .unwrap_or_else(|| end_naive - chrono::Duration::days(90));

    let start_dt = start_naive
        .and_hms_opt(0, 0, 0)
        .map(|na| DateTime::<Utc>::from_naive_utc_and_offset(na, Utc))
        .ok_or_else(|| CustomerError::BadRequest("invalid from date".to_string()))?;
    let end_exclusive = end_naive
        .succ_opt()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|na| DateTime::<Utc>::from_naive_utc_and_offset(na, Utc))
        .ok_or_else(|| CustomerError::BadRequest("invalid to date".to_string()))?;

    let kind_filter = q.kind.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(k) = kind_filter {
        if k != "charge" && k != "payment" {
            return Err(CustomerError::BadRequest(
                "kind must be charge, payment, or omitted".to_string(),
            ));
        }
    }

    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let offset = q.offset.unwrap_or(0).max(0);

    let q_trim = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());

    let search = q_trim.map(|s| {
        format!(
            "%{}%",
            s.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        )
    });

    let meili_rms_customer_ids: Option<Vec<uuid::Uuid>> = if let Some(qs) = q_trim {
        if let Some(c) = state.meilisearch.as_ref() {
            match crate::logic::meilisearch_search::customer_search_ids(c, qs).await {
                Ok(ids) if !ids.is_empty() => Some(ids),
                Ok(_) => None,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "Meilisearch RMS charge search failed; using PostgreSQL ILIKE only"
                    );
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    let rows = if let Some(ref pat) = search {
        if let Some(ref mids) = meili_rms_customer_ids {
            sqlx::query_as::<_, RmsChargeRecordApiRow>(
                r#"
                SELECT
                    r.id,
                    r.record_kind,
                    r.created_at,
                    r.order_id,
                    r.register_session_id,
                    r.customer_id,
                    r.payment_method,
                    r.amount,
                    r.operator_staff_id,
                    r.payment_transaction_id,
                    r.customer_display,
                    r.order_short_ref,
                    NULLIF(TRIM(BOTH FROM CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), '') AS customer_name,
                    c.customer_code,
                    s.full_name AS operator_name
                FROM pos_rms_charge_record r
                LEFT JOIN customers c ON c.id = r.customer_id
                LEFT JOIN staff s ON s.id = r.operator_staff_id
                WHERE r.created_at >= $1 AND r.created_at < $2
                  AND ($3::text IS NULL OR r.record_kind = $3)
                  AND ($4::uuid IS NULL OR r.customer_id = $4)
                  AND (
                    c.id = ANY($5)
                    OR c.customer_code ILIKE $6 ESCAPE '\'
                    OR CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, '')) ILIKE $6 ESCAPE '\'
                    OR r.order_short_ref ILIKE $6 ESCAPE '\'
                    OR r.payment_method ILIKE $6 ESCAPE '\'
                  )
                ORDER BY r.created_at DESC
                LIMIT $7 OFFSET $8
                "#,
            )
            .bind(start_dt)
            .bind(end_exclusive)
            .bind(kind_filter)
            .bind(q.customer_id)
            .bind(&mids[..])
            .bind(pat)
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db)
            .await?
        } else {
            sqlx::query_as::<_, RmsChargeRecordApiRow>(
                r#"
                SELECT
                    r.id,
                    r.record_kind,
                    r.created_at,
                    r.order_id,
                    r.register_session_id,
                    r.customer_id,
                    r.payment_method,
                    r.amount,
                    r.operator_staff_id,
                    r.payment_transaction_id,
                    r.customer_display,
                    r.order_short_ref,
                    NULLIF(TRIM(BOTH FROM CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), '') AS customer_name,
                    c.customer_code,
                    s.full_name AS operator_name
                FROM pos_rms_charge_record r
                LEFT JOIN customers c ON c.id = r.customer_id
                LEFT JOIN staff s ON s.id = r.operator_staff_id
                WHERE r.created_at >= $1 AND r.created_at < $2
                  AND ($3::text IS NULL OR r.record_kind = $3)
                  AND ($4::uuid IS NULL OR r.customer_id = $4)
                  AND (
                    c.customer_code ILIKE $5 ESCAPE '\'
                    OR CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, '')) ILIKE $5 ESCAPE '\'
                    OR r.order_short_ref ILIKE $5 ESCAPE '\'
                    OR r.payment_method ILIKE $5 ESCAPE '\'
                  )
                ORDER BY r.created_at DESC
                LIMIT $6 OFFSET $7
                "#,
            )
            .bind(start_dt)
            .bind(end_exclusive)
            .bind(kind_filter)
            .bind(q.customer_id)
            .bind(pat)
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db)
            .await?
        }
    } else {
        sqlx::query_as::<_, RmsChargeRecordApiRow>(
            r#"
            SELECT
                r.id,
                r.record_kind,
                r.created_at,
                r.order_id,
                r.register_session_id,
                r.customer_id,
                r.payment_method,
                r.amount,
                r.operator_staff_id,
                r.payment_transaction_id,
                r.customer_display,
                r.order_short_ref,
                NULLIF(TRIM(BOTH FROM CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), '') AS customer_name,
                c.customer_code,
                s.full_name AS operator_name
            FROM pos_rms_charge_record r
            LEFT JOIN customers c ON c.id = r.customer_id
            LEFT JOIN staff s ON s.id = r.operator_staff_id
            WHERE r.created_at >= $1 AND r.created_at < $2
              AND ($3::text IS NULL OR r.record_kind = $3)
              AND ($4::uuid IS NULL OR r.customer_id = $4)
            ORDER BY r.created_at DESC
            LIMIT $5 OFFSET $6
            "#,
        )
        .bind(start_dt)
        .bind(end_exclusive)
        .bind(kind_filter)
        .bind(q.customer_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    };

    Ok(Json(rows))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", post(create_customer))
        .route("/duplicate-candidates", get(get_duplicate_candidates))
        .route("/duplicate-review-queue", get(list_duplicate_review_queue))
        .route(
            "/duplicate-review-queue/dismiss",
            post(post_duplicate_review_queue_dismiss),
        )
        .route(
            "/duplicate-review-queue/enqueue",
            post(post_duplicate_review_queue_enqueue),
        )
        .route("/search", get(search_customers))
        .route("/browse", get(browse_customers))
        .route("/podium/messaging-inbox", get(list_podium_messaging_inbox))
        .route("/rms-charge/records", get(list_rms_charge_records))
        .route("/groups", get(list_customer_groups))
        .route(
            "/group-members",
            post(add_customer_group_member).delete(remove_customer_group_member),
        )
        .route("/merge", post(post_merge_customers))
        .route("/bulk-vip", post(bulk_set_customer_vip))
        .route("/import/lightspeed", post(import_lightspeed_customers))
        .route("/{customer_id}/hub", get(get_customer_hub))
        .route("/{customer_id}/timeline", get(get_customer_timeline))
        .route(
            "/{customer_id}/order-history",
            get(get_customer_order_history),
        )
        .route(
            "/{customer_id}/measurements",
            get(get_customer_measurement_vault).patch(patch_customer_measurements),
        )
        .route(
            "/{customer_id}/open-deposit",
            get(get_customer_open_deposit_summary),
        )
        .route(
            "/{customer_id}/store-credit",
            get(get_customer_store_credit_summary),
        )
        .route(
            "/{customer_id}/store-credit/adjust",
            post(post_customer_store_credit_adjust),
        )
        .route("/{customer_id}/notes", post(post_customer_timeline_note))
        .route("/{customer_id}/profile", get(get_customer_profile))
        .route(
            "/{customer_id}/podium/email",
            post(post_customer_podium_email),
        )
        .route(
            "/{customer_id}/podium/messages",
            get(get_customer_podium_messages).post(post_customer_podium_reply),
        )
        .route("/{customer_id}/weddings", get(list_customer_weddings))
        .route(
            "/{customer_id}/couple-link",
            post(post_couple_link).delete(delete_couple_link),
        )
        .route("/{customer_id}/couple-link-new", post(post_couple_create))
        .route("/{customer_id}", get(get_customer).patch(update_customer))
}

async fn post_merge_customers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<MergeCustomersBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, CUSTOMERS_MERGE)
        .await
        .map_err(|(_code, axum::Json(v))| {
            CustomerError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("not authorized")
                    .to_string(),
            )
        })?;

    if body.dry_run {
        let preview = customer_merge::merge_preview(
            &state.db,
            body.master_customer_id,
            body.slave_customer_id,
        )
        .await
        .map_err(|e| match e {
            customer_merge::CustomerMergeError::Db(d) => CustomerError::Database(d),
            customer_merge::CustomerMergeError::BadRequest(m) => CustomerError::BadRequest(m),
        })?;
        return Ok(Json(json!({ "dry_run": true, "preview": preview })));
    }

    customer_merge::merge_customers(&state.db, body.master_customer_id, body.slave_customer_id)
        .await
        .map_err(|e| match e {
            customer_merge::CustomerMergeError::Db(d) => CustomerError::Database(d),
            customer_merge::CustomerMergeError::BadRequest(m) => CustomerError::BadRequest(m),
        })?;

    let pool = state.db.clone();
    let actor_id = staff.id;
    let master_id = body.master_customer_id;
    let slave_id = body.slave_customer_id;
    tokio::spawn(async move {
        if let Err(e) = crate::logic::notifications::emit_customer_merge_completed(
            &pool, actor_id, master_id, slave_id,
        )
        .await
        {
            tracing::error!(error = %e, "emit_customer_merge_completed");
        }
    });

    Ok(Json(json!({ "status": "merged" })))
}

async fn browse_customers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<CustomerBrowseQuery>,
) -> Result<Json<Vec<CustomerBrowseRow>>, CustomerError> {
    require_customer_access(&state, &headers).await?;
    let limit = query.limit.unwrap_or(300).clamp(1, 1000);
    let offset = query.offset.unwrap_or(0).clamp(0, 500_000);
    let wedding_days = query.wedding_within_days.unwrap_or(30).clamp(1, 3650);

    let vip_filter = query.vip_only.unwrap_or(false);
    let bd_filter = query.balance_due_only.unwrap_or(false);
    let ws_filter = query.wedding_soon_only.unwrap_or(false);

    let search_raw = query.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let party_search_raw = query
        .wedding_party_q
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let group_code = query
        .group_code
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let meili_browse_ids: Option<Vec<uuid::Uuid>> =
        if search_raw.is_some() && party_search_raw.is_none() {
            if let (Some(qs), Some(c)) = (search_raw, state.meilisearch.as_ref()) {
                match crate::logic::meilisearch_search::customer_search_ids(c, qs).await {
                    Ok(ids) if !ids.is_empty() => Some(ids),
                    Ok(_) => None,
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            "Meilisearch customer browse failed; using PostgreSQL ILIKE"
                        );
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        };

    let rows = if let Some(ids) = meili_browse_ids {
        sqlx::query_as::<_, CustomerBrowseRow>(&format!(
            r#"
            SELECT
                c.id,
                c.customer_code,
                COALESCE(c.first_name, '') AS first_name,
                COALESCE(c.last_name, '') AS last_name,
                c.company_name,
                c.email,
                c.phone,
                c.is_vip,
                c.couple_id,
                c.couple_primary_id,
                COALESCE(ob.balance_sum, 0)::numeric(12, 2) AS open_balance_due,
                EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                      AND wp.event_date <= CURRENT_DATE + ($1::bigint * INTERVAL '1 day')
                ) AS wedding_soon,
                EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                ) AS wedding_active,
                (
                    SELECT {SQL_PARTY_TRACKING_LABEL_WP}
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_name,
                (
                    SELECT wp.id
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_id
            FROM customers c
            LEFT JOIN LATERAL (
                SELECT SUM(balance_due) AS balance_sum
                FROM orders
                WHERE customer_id = c.id
                  AND status = 'open'::order_status
            ) ob ON true
            WHERE ($2::bool = false OR c.is_vip = TRUE)
              AND ($3::bool = false OR COALESCE(ob.balance_sum, 0) > 0)
              AND (
                $4::bool = false
                OR EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                      AND wp.event_date <= CURRENT_DATE + ($1::bigint * INTERVAL '1 day')
                )
              )
              AND (
                $5::text IS NULL
                OR LENGTH(TRIM($5::text)) = 0
                OR c.id = ANY($8)
              )
              AND (
                $6::text IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND (
                        COALESCE(wp.party_name, '') ILIKE ('%' || $6::text || '%')
                        OR wp.groom_name ILIKE ('%' || $6::text || '%')
                      )
                )
              )
              AND (
                $7::text IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM customer_group_members cgm
                    JOIN customer_groups cg ON cg.id = cgm.group_id
                    WHERE cgm.customer_id = c.id
                      AND cg.code = $7::text
                )
              )
            ORDER BY array_position($9::uuid[], c.id)
            LIMIT $10 OFFSET $11
            "#
        ))
        .bind(wedding_days)
        .bind(vip_filter)
        .bind(bd_filter)
        .bind(ws_filter)
        .bind(search_raw)
        .bind(party_search_raw)
        .bind(group_code)
        .bind(&ids[..])
        .bind(&ids[..])
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, CustomerBrowseRow>(&format!(
            r#"
            SELECT
                c.id,
                c.customer_code,
                COALESCE(c.first_name, '') AS first_name,
                COALESCE(c.last_name, '') AS last_name,
                c.company_name,
                c.email,
                c.phone,
                c.is_vip,
                c.couple_id,
                c.couple_primary_id,
                COALESCE(ob.balance_sum, 0)::numeric(12, 2) AS open_balance_due,
                EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                      AND wp.event_date <= CURRENT_DATE + ($1::bigint * INTERVAL '1 day')
                ) AS wedding_soon,
                EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                ) AS wedding_active,
                (
                    SELECT {SQL_PARTY_TRACKING_LABEL_WP}
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_name,
                (
                    SELECT wp.id
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_id
            FROM customers c
            LEFT JOIN LATERAL (
                SELECT SUM(balance_due) AS balance_sum
                FROM orders
                WHERE customer_id = c.id
                  AND status = 'open'::order_status
            ) ob ON true
            WHERE ($2::bool = false OR c.is_vip = TRUE)
              AND ($3::bool = false OR COALESCE(ob.balance_sum, 0) > 0)
              AND (
                $4::bool = false
                OR EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                      AND wp.event_date <= CURRENT_DATE + ($1::bigint * INTERVAL '1 day')
                )
              )
              AND (
                $5::text IS NULL
                OR LENGTH(TRIM($5::text)) = 0
                OR c.first_name ILIKE ('%' || $5::text || '%')
                OR c.last_name ILIKE ('%' || $5::text || '%')
                OR c.customer_code ILIKE ('%' || $5::text || '%')
                OR COALESCE(c.company_name, '') ILIKE ('%' || $5::text || '%')
                OR COALESCE(c.email, '') ILIKE ('%' || $5::text || '%')
                OR COALESCE(c.phone, '') ILIKE ('%' || $5::text || '%')
              )
              AND (
                $6::text IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND (
                        COALESCE(wp.party_name, '') ILIKE ('%' || $6::text || '%')
                        OR wp.groom_name ILIKE ('%' || $6::text || '%')
                      )
                )
              )
              AND (
                $7::text IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM customer_group_members cgm
                    JOIN customer_groups cg ON cg.id = cgm.group_id
                    WHERE cgm.customer_id = c.id
                      AND cg.code = $7::text
                )
              )
            ORDER BY c.last_name ASC, c.first_name ASC
            LIMIT $8 OFFSET $9
            "#
        ))
        .bind(wedding_days)
        .bind(vip_filter)
        .bind(bd_filter)
        .bind(ws_filter)
        .bind(search_raw)
        .bind(party_search_raw)
        .bind(group_code)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    };

    Ok(Json(rows))
}

async fn bulk_set_customer_vip(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BulkCustomerVipRequest>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    require_customer_access(&state, &headers).await?;
    if body.customer_ids.is_empty() {
        return Err(CustomerError::BadRequest(
            "customer_ids cannot be empty".to_string(),
        ));
    }

    sqlx::query("UPDATE customers SET is_vip = $1 WHERE id = ANY($2)")
        .bind(body.is_vip)
        .bind(&body.customer_ids[..])
        .execute(&state.db)
        .await?;

    Ok(Json(json!({ "status": "updated" })))
}

async fn import_lightspeed_customers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<LightspeedCustomerImportPayload>,
) -> Result<Json<LightspeedCustomerImportSummary>, CustomerError> {
    require_customer_access(&state, &headers).await?;
    let summary = execute_lightspeed_customer_import(&state.db, payload)
        .await
        .map_err(|e| match e {
            crate::logic::lightspeed_customers::LightspeedCustomerImportError::InvalidPayload(
                m,
            ) => CustomerError::BadRequest(m),
            crate::logic::lightspeed_customers::LightspeedCustomerImportError::Database(d) => {
                CustomerError::Database(d)
            }
        })?;
    if let Some(c) = state.meilisearch.clone() {
        let pool = state.db.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::logic::meilisearch_sync::reindex_all_meilisearch(&c, &pool).await
            {
                tracing::error!(error = %e, "Meilisearch reindex after Lightspeed customer import failed");
            }
        });
    }
    Ok(Json(summary))
}

async fn search_customers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<Customer>>, CustomerError> {
    require_customer_access(&state, &headers).await?;
    let q = query.q.trim();
    if q.len() < 2 {
        return Err(CustomerError::QueryTooShort);
    }

    let limit = query.limit.unwrap_or(25).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).clamp(0, 500_000);

    let meili_ids: Option<Vec<uuid::Uuid>> = if let Some(c) = state.meilisearch.as_ref() {
        match crate::logic::meilisearch_search::customer_search_ids(c, q).await {
            Ok(ids) if !ids.is_empty() => Some(ids),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "Meilisearch customer search failed; using PostgreSQL ILIKE"
                );
                None
            }
        }
    } else {
        None
    };

    let results = if let Some(ids) = meili_ids {
        sqlx::query_as::<_, Customer>(&format!(
            r#"
            SELECT
                c.id,
                c.customer_code,
                COALESCE(c.first_name, '') AS first_name,
                COALESCE(c.last_name, '') AS last_name,
                c.company_name,
                c.email,
                c.phone,
                EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                ) AS wedding_active,
                c.couple_id,
                (
                    SELECT {SQL_PARTY_TRACKING_LABEL_WP}
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_name,
                (
                    SELECT wp.id
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_id,
                (
                    SELECT wm.id
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_member_id
            FROM customers c
            WHERE c.id = ANY($1)
            ORDER BY array_position($2::uuid[], c.id)
            LIMIT $3 OFFSET $4
            "#
        ))
        .bind(&ids[..])
        .bind(&ids[..])
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    } else {
        let search_term = format!("%{q}%");
        sqlx::query_as::<_, Customer>(&format!(
            r#"
            SELECT
                c.id,
                c.customer_code,
                COALESCE(c.first_name, '') AS first_name,
                COALESCE(c.last_name, '') AS last_name,
                c.company_name,
                c.email,
                c.phone,
                EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                ) AS wedding_active,
                c.couple_id,
                (
                    SELECT {SQL_PARTY_TRACKING_LABEL_WP}
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_name,
                (
                    SELECT wp.id
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_party_id,
                (
                    SELECT wm.id
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND wp.event_date >= CURRENT_DATE
                    ORDER BY wp.event_date ASC
                    LIMIT 1
                ) AS wedding_member_id
            FROM customers c
            WHERE
                c.first_name ILIKE $1 OR
                c.last_name ILIKE $1 OR
                c.customer_code ILIKE $1 OR
                COALESCE(c.company_name, '') ILIKE $1 OR
                c.email ILIKE $1 OR
                c.phone ILIKE $1 OR
                c.city ILIKE $1 OR
                c.state ILIKE $1 OR
                c.postal_code ILIKE $1 OR
                COALESCE(c.address_line1, '') ILIKE $1 OR
                EXISTS (
                    SELECT 1
                    FROM wedding_members wm
                    JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                    WHERE wm.customer_id = c.id
                      AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                      AND (
                        COALESCE(wp.party_name, '') ILIKE $1
                        OR wp.groom_name ILIKE $1
                      )
                )
            ORDER BY c.created_at DESC
            LIMIT $2 OFFSET $3
            "#
        ))
        .bind(search_term)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    };

    Ok(Json(results))
}

type NormalizedCustomerInput = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
    bool,
    bool,
    bool,
);

fn normalize_customer_input(
    payload: &CreateCustomerRequest,
) -> Result<NormalizedCustomerInput, CustomerError> {
    let first = payload.first_name.trim();
    let last = payload.last_name.trim();
    if first.is_empty() || last.is_empty() {
        return Err(CustomerError::NameRequired);
    }

    let email = payload
        .email
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let phone = payload
        .phone
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let line1 = payload
        .address_line1
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let line2 = payload
        .address_line2
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let city = payload
        .city
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let state_st = payload
        .state
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let postal = payload
        .postal_code
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let m_email = payload.marketing_email_opt_in.unwrap_or(false);
    let m_sms = payload.marketing_sms_opt_in.unwrap_or(false);
    let t_sms = payload.transactional_sms_opt_in.unwrap_or(m_sms);
    let t_email = payload.transactional_email_opt_in.unwrap_or(m_email);

    Ok((
        first.to_string(),
        last.to_string(),
        email,
        phone,
        line1,
        line2,
        city,
        state_st,
        postal,
        m_email,
        m_sms,
        t_sms,
        t_email,
    ))
}

async fn create_customer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateCustomerRequest>,
) -> Result<Json<CustomerProfileRow>, CustomerError> {
    require_customer_access(&state, &headers).await?;
    let (
        first,
        last,
        email,
        phone,
        line1,
        line2,
        city,
        state_st,
        postal,
        m_email,
        m_sms,
        t_sms,
        t_email,
    ) = normalize_customer_input(&payload)?;

    let trim_opt = |o: &Option<String>| {
        o.as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };

    let id = insert_customer(
        &state.db,
        InsertCustomerParams {
            customer_code: None,
            first_name: first,
            last_name: last,
            company_name: trim_opt(&payload.company_name),
            email,
            phone,
            address_line1: line1,
            address_line2: line2,
            city,
            state: state_st,
            postal_code: postal,
            date_of_birth: payload.date_of_birth,
            anniversary_date: payload.anniversary_date,
            custom_field_1: trim_opt(&payload.custom_field_1),
            custom_field_2: trim_opt(&payload.custom_field_2),
            custom_field_3: trim_opt(&payload.custom_field_3),
            custom_field_4: trim_opt(&payload.custom_field_4),
            marketing_email_opt_in: m_email,
            marketing_sms_opt_in: m_sms,
            transactional_sms_opt_in: t_sms,
            transactional_email_opt_in: t_email,
            customer_created_source: crate::logic::customers::CustomerCreatedSource::Store,
        },
    )
    .await?;

    let row = load_customer_profile_row(&state.db, id).await?;
    spawn_meilisearch_customer_hooks(&state, id);
    Ok(Json(row))
}

async fn get_customer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<CustomerProfileRow>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let row = load_customer_profile_row(&state.db, customer_id).await?;
    Ok(Json(row))
}

async fn update_customer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<UpdateCustomerRequest>,
) -> Result<Json<CustomerProfileRow>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_EDIT).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }

    let mut qb: sqlx::QueryBuilder<'_, sqlx::Postgres> =
        sqlx::QueryBuilder::new("UPDATE customers SET ");
    let mut sep = qb.separated(", ");
    let mut n = 0u8;

    if let Some(ref v) = body.first_name {
        let t = v.trim();
        if !t.is_empty() {
            sep.push("first_name = ").push_bind(t.to_string());
            n += 1;
        }
    }
    if let Some(ref v) = body.last_name {
        let t = v.trim();
        if !t.is_empty() {
            sep.push("last_name = ").push_bind(t.to_string());
            n += 1;
        }
    }

    if let Some(ref v) = body.company_name {
        let t = v.trim();
        sep.push("company_name = ").push_bind(if t.is_empty() {
            None::<String>
        } else {
            Some(t.to_string())
        });
        n += 1;
    }

    if let Some(email_raw) = body.email {
        let t = email_raw.trim();
        let bind: Option<String> = if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        };
        sep.push("email = ").push_bind(bind);
        n += 1;
    }
    if let Some(phone_raw) = body.phone {
        let t = phone_raw.trim();
        let bind: Option<String> = if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        };
        sep.push("phone = ").push_bind(bind);
        n += 1;
    }

    if let Some(v) = body.address_line1 {
        let t = v.trim();
        sep.push("address_line1 = ").push_bind(if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(v) = body.address_line2 {
        let t = v.trim();
        sep.push("address_line2 = ").push_bind(if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(v) = body.city {
        let t = v.trim();
        sep.push("city = ").push_bind(if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(v) = body.state {
        let t = v.trim();
        sep.push("state = ").push_bind(if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(v) = body.postal_code {
        let t = v.trim();
        sep.push("postal_code = ").push_bind(if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        });
        n += 1;
    }

    if let Some(v) = body.date_of_birth {
        sep.push("date_of_birth = ").push_bind(v);
        n += 1;
    }
    if let Some(v) = body.anniversary_date {
        sep.push("anniversary_date = ").push_bind(v);
        n += 1;
    }

    if let Some(ref v) = body.custom_field_1 {
        let t = v.trim();
        sep.push("custom_field_1 = ").push_bind(if t.is_empty() {
            None::<String>
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(ref v) = body.custom_field_2 {
        let t = v.trim();
        sep.push("custom_field_2 = ").push_bind(if t.is_empty() {
            None::<String>
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(ref v) = body.custom_field_3 {
        let t = v.trim();
        sep.push("custom_field_3 = ").push_bind(if t.is_empty() {
            None::<String>
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(ref v) = body.custom_field_4 {
        let t = v.trim();
        sep.push("custom_field_4 = ").push_bind(if t.is_empty() {
            None::<String>
        } else {
            Some(t.to_string())
        });
        n += 1;
    }

    if let Some(v) = body.marketing_email_opt_in {
        sep.push("marketing_email_opt_in = ").push_bind(v);
        n += 1;
    }
    if let Some(v) = body.marketing_sms_opt_in {
        sep.push("marketing_sms_opt_in = ").push_bind(v);
        n += 1;
    }
    if let Some(v) = body.transactional_sms_opt_in {
        sep.push("transactional_sms_opt_in = ").push_bind(v);
        n += 1;
    }
    if let Some(v) = body.transactional_email_opt_in {
        sep.push("transactional_email_opt_in = ").push_bind(v);
        n += 1;
    }
    if let Some(ref v) = body.podium_conversation_url {
        let t = v.trim();
        sep.push("podium_conversation_url = ")
            .push_bind(if t.is_empty() {
                None::<String>
            } else {
                Some(t.to_string())
            });
        n += 1;
    }
    if let Some(v) = body.is_vip {
        sep.push("is_vip = ").push_bind(v);
        n += 1;
    }

    if n == 0 {
        let row = load_customer_profile_row(&state.db, customer_id).await?;
        return Ok(Json(row));
    }

    qb.push(" WHERE id = ").push_bind(customer_id);
    qb.build().execute(&state.db).await?;

    let row = load_customer_profile_row(&state.db, customer_id).await?;
    spawn_meilisearch_customer_hooks(&state, customer_id);
    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
struct PostCustomerPodiumEmailBody {
    subject: String,
    html_body: String,
}

async fn post_customer_podium_email(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<PostCustomerPodiumEmailBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    let staff_id = staff_id_from_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_EDIT).await?;
    let sub = body.subject.trim();
    let html = body.html_body.trim();
    if sub.is_empty() || html.is_empty() {
        return Err(CustomerError::BadRequest(
            "subject and html_body are required".to_string(),
        ));
    }
    let row = load_customer_profile_row(&state.db, customer_id).await?;
    let Some(ref em) = row.email else {
        return Err(CustomerError::BadRequest(
            "Customer has no email on file".to_string(),
        ));
    };
    if !podium::looks_like_email(em) {
        return Err(CustomerError::BadRequest(
            "Customer email is missing or invalid".to_string(),
        ));
    }
    match podium::send_podium_email_message(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        em,
        sub,
        html,
    )
    .await
    {
        Ok(()) => {
            let em_t = em.trim();
            if let Err(e) = podium_messaging::record_outbound_message(
                &state.db,
                customer_id,
                "email",
                html,
                staff_id,
                None,
                Some(em_t),
                "outbound",
            )
            .await
            {
                tracing::error!(error = %e, "record podium outbound email");
            }
            Ok(Json(json!({ "status": "sent" })))
        }
        Err(e) => Err(CustomerError::PodiumUnavailable(format!(
            "Could not send via Podium ({e}). Enable operational email in Integrations, set location UID, and verify Podium env credentials."
        ))),
    }
}

#[derive(Debug, Deserialize)]
struct ListPodiumInboxQuery {
    limit: Option<i64>,
}

async fn list_podium_messaging_inbox(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListPodiumInboxQuery>,
) -> Result<Json<Vec<podium_messaging::PodiumInboxRow>>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let rows = podium_messaging::list_messaging_inbox(&state.db, q.limit.unwrap_or(50)).await?;
    Ok(Json(rows))
}

async fn get_customer_podium_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<Vec<podium_messaging::PodiumMessageApiRow>>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let rows = podium_messaging::list_messages_for_customer(&state.db, customer_id).await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
struct PostCustomerPodiumReplyBody {
    channel: String,
    body: String,
    #[serde(default)]
    subject: Option<String>,
}

async fn post_customer_podium_reply(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<PostCustomerPodiumReplyBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    let id_for_insert =
        staff_id_from_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_EDIT).await?;
    let ch = body.channel.trim().to_ascii_lowercase();
    let text = body.body.trim();
    if text.is_empty() {
        return Err(CustomerError::BadRequest("body is required".to_string()));
    }
    let row = load_customer_profile_row(&state.db, customer_id).await?;
    match ch.as_str() {
        "sms" | "phone" => {
            let Some(ref ph) = row.phone else {
                return Err(CustomerError::BadRequest(
                    "Customer has no phone on file".to_string(),
                ));
            };
            podium::send_podium_sms_message(
                &state.db,
                &state.http_client,
                &state.podium_token_cache,
                ph,
                text,
            )
            .await
            .map_err(|e| {
                CustomerError::PodiumUnavailable(format!(
                    "Could not send SMS via Podium ({e}). Check Integrations and env credentials."
                ))
            })?;
            let e164 = podium::normalize_phone_e164(ph.as_str());
            podium_messaging::record_outbound_message(
                &state.db,
                customer_id,
                "sms",
                text,
                id_for_insert,
                e164.as_deref(),
                None,
                "outbound",
            )
            .await
            .map_err(CustomerError::Database)?;
        }
        "email" | "e-mail" => {
            let sub = body.subject.as_deref().unwrap_or("").trim();
            if sub.is_empty() {
                return Err(CustomerError::BadRequest(
                    "subject is required for email".to_string(),
                ));
            }
            let Some(ref em) = row.email else {
                return Err(CustomerError::BadRequest(
                    "Customer has no email on file".to_string(),
                ));
            };
            if !podium::looks_like_email(em) {
                return Err(CustomerError::BadRequest(
                    "Customer email is invalid".to_string(),
                ));
            }
            podium::send_podium_email_message(
                &state.db,
                &state.http_client,
                &state.podium_token_cache,
                em,
                sub,
                text,
            )
            .await
            .map_err(|e| {
                CustomerError::PodiumUnavailable(format!(
                    "Could not send email via Podium ({e}). Check Integrations and env credentials."
                ))
            })?;
            let em_t = em.trim();
            podium_messaging::record_outbound_message(
                &state.db,
                customer_id,
                "email",
                text,
                id_for_insert,
                None,
                Some(em_t),
                "outbound",
            )
            .await
            .map_err(CustomerError::Database)?;
        }
        _ => {
            return Err(CustomerError::BadRequest(
                "channel must be sms or email".to_string(),
            ));
        }
    }
    Ok(Json(json!({ "ok": true })))
}

async fn list_wedding_rows(
    pool: &sqlx::PgPool,
    customer_id: Uuid,
) -> Result<Vec<WeddingMembershipRow>, sqlx::Error> {
    sqlx::query_as::<_, WeddingMembershipRow>(&format!(
        r#"
        SELECT
            wm.id AS wedding_member_id,
            wp.id AS wedding_party_id,
            wm.order_id,
            {SQL_PARTY_TRACKING_LABEL_WP} AS party_name,
            wp.event_date,
            wm.role,
            wm.status,
            (wp.event_date >= CURRENT_DATE) AS active
        FROM wedding_members wm
        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        WHERE wm.customer_id = $1
          AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
        ORDER BY wp.event_date DESC
        "#
    ))
    .bind(customer_id)
    .fetch_all(pool)
    .await
}

async fn list_customer_weddings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<Vec<WeddingMembershipRow>>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let rows = list_wedding_rows(&state.db, customer_id).await?;
    Ok(Json(rows))
}

async fn get_customer_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<CustomerProfileResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let row = load_customer_profile_row(&state.db, customer_id).await?;

    let weddings = list_wedding_rows(&state.db, customer_id).await?;

    let profile_complete = is_profile_complete(ProfileFields {
        phone: row.phone.as_deref(),
        email: row.email.as_deref(),
    });

    Ok(Json(CustomerProfileResponse {
        customer: row,
        profile_complete,
        weddings,
    }))
}

fn short_order_ref(id: Uuid) -> String {
    let s = id.simple().to_string();
    s.chars().take(8).collect()
}

async fn get_customer_hub(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<CustomerHubResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let row = load_customer_profile_row(&state.db, customer_id).await?;

    let weddings = list_wedding_rows(&state.db, customer_id).await?;
    let hub = fetch_hub_stats(&state.db, customer_id)
        .await
        .map_err(CustomerError::Database)?;

    let profile_complete = is_profile_complete(ProfileFields {
        phone: row.phone.as_deref(),
        email: row.email.as_deref(),
    });

    let marketing_needs_attention =
        !row.marketing_email_opt_in && !row.marketing_sms_opt_in && !row.transactional_sms_opt_in;

    let partner = if let Some(cid) = row.couple_id {
        sqlx::query_as::<_, CoupleMemberPreview>(
            "SELECT id, first_name, last_name, email FROM customers WHERE couple_id = $1 AND id != $2"
        )
        .bind(cid)
        .bind(customer_id)
        .fetch_optional(&state.db)
        .await?
    } else {
        None
    };

    Ok(Json(CustomerHubResponse {
        stats: CustomerHubStats {
            lifetime_spend_usd: hub.lifetime_spend_usd,
            balance_due_usd: hub.balance_due_usd,
            wedding_party_count: hub.wedding_party_count,
            last_activity_at: hub.last_activity_at,
            days_since_last_visit: days_since_last_visit(hub.last_activity_at),
            marketing_needs_attention,
            loyalty_points: hub.loyalty_points,
        },
        customer: row,
        profile_complete,
        weddings,
        partner,
    }))
}

#[derive(Debug, Deserialize)]
pub struct CoupleLinkRequest {
    pub partner_id: Uuid,
}

async fn post_couple_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<CoupleLinkRequest>,
) -> Result<Json<CustomerHubResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_COUPLE_MANAGE).await?;
    crate::logic::customer_couple::link_couple(&state.db, customer_id, body.partner_id)
        .await
        .map_err(|e| CustomerError::Logic(e.to_string()))?;

    get_customer_hub(State(state), headers, Path(customer_id)).await
}

async fn post_couple_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(payload): Json<CreateCustomerRequest>,
) -> Result<Json<CustomerHubResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_COUPLE_MANAGE).await?;

    let (
        first,
        last,
        email,
        phone,
        line1,
        line2,
        city,
        state_st,
        postal,
        m_email,
        m_sms,
        t_sms,
        t_email,
    ) = normalize_customer_input(&payload)?;

    let trim_opt = |o: &Option<String>| {
        o.as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };

    let partner_id = insert_customer(
        &state.db,
        InsertCustomerParams {
            customer_code: None,
            first_name: first,
            last_name: last,
            company_name: trim_opt(&payload.company_name),
            email,
            phone,
            address_line1: line1,
            address_line2: line2,
            city,
            state: state_st,
            postal_code: postal,
            date_of_birth: payload.date_of_birth,
            anniversary_date: payload.anniversary_date,
            custom_field_1: trim_opt(&payload.custom_field_1),
            custom_field_2: trim_opt(&payload.custom_field_2),
            custom_field_3: trim_opt(&payload.custom_field_3),
            custom_field_4: trim_opt(&payload.custom_field_4),
            marketing_email_opt_in: m_email,
            marketing_sms_opt_in: m_sms,
            transactional_sms_opt_in: t_sms,
            transactional_email_opt_in: t_email,
            customer_created_source: crate::logic::customers::CustomerCreatedSource::Store,
        },
    )
    .await
    .map_err(CustomerError::Database)?;

    crate::logic::customer_couple::link_couple(&state.db, customer_id, partner_id)
        .await
        .map_err(|e| CustomerError::Logic(e.to_string()))?;

    get_customer_hub(State(state), headers, Path(customer_id)).await
}

async fn delete_couple_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_COUPLE_MANAGE).await?;
    crate::logic::customer_couple::unlink_couple(&state.db, customer_id)
        .await
        .map_err(|e| CustomerError::BadRequest(e.to_string()))?;

    Ok(Json(json!({ "status": "unlinked" })))
}

#[derive(Debug, FromRow)]
struct OrderTimelineRow {
    id: Uuid,
    booked_at: DateTime<Utc>,
    items_summary: Option<String>,
}

#[derive(Debug, FromRow)]
struct PaymentTimelineRow {
    id: Uuid,
    created_at: DateTime<Utc>,
    payment_method: String,
    amount: Decimal,
    category: String,
}

#[derive(Debug, FromRow)]
struct WeddingLogTimelineRow {
    created_at: DateTime<Utc>,
    description: String,
    action_type: String,
    wedding_party_id: Uuid,
    party_name: String,
}

#[derive(Debug, FromRow)]
struct NoteTimelineRow {
    id: Uuid,
    created_at: DateTime<Utc>,
    body: String,
}

#[derive(Debug, FromRow)]
struct MeasTimelineRow {
    id: Uuid,
    created_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct ApptTimelineRow {
    id: Uuid,
    datetime: DateTime<Utc>,
    appt_type: String,
}

#[derive(Debug, FromRow)]
struct ShipmentTimelineRow {
    at: DateTime<Utc>,
    kind: String,
    message: String,
    shipment_id: Uuid,
    staff_name: Option<String>,
}

async fn build_customer_timeline(
    pool: &sqlx::PgPool,
    customer_id: Uuid,
) -> Result<Vec<CustomerTimelineEvent>, sqlx::Error> {
    let couple_id: Option<Uuid> =
        sqlx::query_scalar("SELECT couple_id FROM customers WHERE id = $1")
            .bind(customer_id)
            .fetch_one(pool)
            .await?;

    let orders = if let Some(cid) = couple_id {
        sqlx::query_as::<_, OrderTimelineRow>(
            r#"
            SELECT
                o.id,
                o.booked_at,
                STRING_AGG(
                    (oi.quantity::text || '× ' || COALESCE(p.name, 'Item')),
                    ', ' ORDER BY COALESCE(p.name, '')
                ) FILTER (WHERE oi.id IS NOT NULL) AS items_summary
            FROM orders o
            LEFT JOIN order_items oi ON oi.order_id = o.id
            LEFT JOIN products p ON p.id = oi.product_id
            WHERE o.customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
              AND o.status != 'cancelled'::order_status
            GROUP BY o.id, o.booked_at
            ORDER BY o.booked_at DESC
            LIMIT 25
            "#,
        )
        .bind(cid)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, OrderTimelineRow>(
            r#"
            SELECT
                o.id,
                o.booked_at,
                STRING_AGG(
                    (oi.quantity::text || '× ' || COALESCE(p.name, 'Item')),
                    ', ' ORDER BY COALESCE(p.name, '')
                ) FILTER (WHERE oi.id IS NOT NULL) AS items_summary
            FROM orders o
            LEFT JOIN order_items oi ON oi.order_id = o.id
            LEFT JOIN products p ON p.id = oi.product_id
            WHERE o.customer_id = $1
              AND o.status != 'cancelled'::order_status
            GROUP BY o.id, o.booked_at
            ORDER BY o.booked_at DESC
            LIMIT 25
            "#,
        )
        .bind(customer_id)
        .fetch_all(pool)
        .await?
    };

    let payments = if let Some(cid) = couple_id {
        sqlx::query_as::<_, PaymentTimelineRow>(
            r#"
            SELECT id, created_at, payment_method, amount, category::text AS category
            FROM payment_transactions
            WHERE payer_id IN (SELECT id FROM customers WHERE couple_id = $1)
            ORDER BY created_at DESC
            LIMIT 28
            "#,
        )
        .bind(cid)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, PaymentTimelineRow>(
            r#"
            SELECT id, created_at, payment_method, amount, category::text AS category
            FROM payment_transactions
            WHERE payer_id = $1
            ORDER BY created_at DESC
            LIMIT 28
            "#,
        )
        .bind(customer_id)
        .fetch_all(pool)
        .await?
    };

    let wedding_logs = sqlx::query_as::<_, WeddingLogTimelineRow>(&format!(
        r#"
        SELECT
            l.created_at,
            l.description,
            l.action_type,
            l.wedding_party_id,
            {SQL_PARTY_TRACKING_LABEL_WP} AS party_name
        FROM wedding_activity_log l
        JOIN wedding_parties wp ON wp.id = l.wedding_party_id
        WHERE EXISTS (
            SELECT 1 FROM wedding_members wm
            WHERE wm.wedding_party_id = l.wedding_party_id
              AND wm.customer_id = $1
              AND (l.wedding_member_id IS NULL OR l.wedding_member_id = wm.id)
        )
          AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
        ORDER BY l.created_at DESC
        LIMIT 35
        "#
    ))
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    let notes = sqlx::query_as::<_, NoteTimelineRow>(
        r#"
        SELECT id, created_at, body
        FROM customer_timeline_notes
        WHERE customer_id = $1
        ORDER BY created_at DESC
        LIMIT 30
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    let meas = sqlx::query_as::<_, MeasTimelineRow>(
        r#"
        SELECT id, created_at
        FROM measurements
        WHERE customer_id = $1
        ORDER BY created_at DESC
        LIMIT 18
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    let appts = sqlx::query_as::<_, ApptTimelineRow>(
        r#"
        SELECT wa.id, wa.starts_at AS datetime, wa.appointment_type AS appt_type
        FROM wedding_appointments wa
        LEFT JOIN wedding_members wm ON wm.id = wa.wedding_member_id
        WHERE wa.customer_id = $1
           OR wm.customer_id = $1
        ORDER BY wa.starts_at DESC
        LIMIT 20
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    let shipment_events = sqlx::query_as::<_, ShipmentTimelineRow>(
        r#"
        SELECT
            e.at,
            e.kind,
            e.message,
            s.id AS shipment_id,
            st.full_name AS staff_name
        FROM shipment_event e
        INNER JOIN shipment s ON s.id = e.shipment_id
        LEFT JOIN staff st ON st.id = e.staff_id
        WHERE s.customer_id = $1
        ORDER BY e.at DESC
        LIMIT 35
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    let mut events: Vec<CustomerTimelineEvent> = Vec::new();

    for o in orders {
        let items = o.items_summary.unwrap_or_else(|| "Purchase".to_string());
        let d = o.booked_at.format("%m/%d/%y").to_string();
        events.push(CustomerTimelineEvent {
            at: o.booked_at,
            kind: "sale".to_string(),
            summary: format!(
                "{}: Purchased {} (Order · {})",
                d,
                items,
                short_order_ref(o.id)
            ),
            reference_id: Some(o.id),
            reference_type: Some("order".to_string()),
            wedding_party_id: None,
        });
    }

    for p in payments {
        events.push(CustomerTimelineEvent {
            at: p.created_at,
            kind: "payment".to_string(),
            summary: format!(
                "{}: Paid {} {} ({})",
                p.created_at.format("%m/%d/%y"),
                p.amount,
                p.payment_method,
                p.category
            ),
            reference_id: Some(p.id),
            reference_type: Some("payment".to_string()),
            wedding_party_id: None,
        });
    }

    for w in wedding_logs {
        let desc = w.description.trim();
        let summary = if desc.is_empty() {
            format!(
                "{}: {} — {}",
                w.created_at.format("%m/%d/%y"),
                w.party_name,
                w.action_type
            )
        } else {
            format!(
                "{}: {} — {}",
                w.created_at.format("%m/%d/%y"),
                w.party_name,
                desc
            )
        };
        events.push(CustomerTimelineEvent {
            at: w.created_at,
            kind: "wedding".to_string(),
            summary,
            reference_id: None,
            reference_type: Some("wedding_activity".to_string()),
            wedding_party_id: Some(w.wedding_party_id),
        });
    }

    for n in notes {
        events.push(CustomerTimelineEvent {
            at: n.created_at,
            kind: "note".to_string(),
            summary: format!("{}: {}", n.created_at.format("%m/%d/%y"), n.body),
            reference_id: Some(n.id),
            reference_type: Some("note".to_string()),
            wedding_party_id: None,
        });
    }

    for m in meas {
        events.push(CustomerTimelineEvent {
            at: m.created_at,
            kind: "measurement".to_string(),
            summary: format!(
                "{}: Body measurements recorded",
                m.created_at.format("%m/%d/%y")
            ),
            reference_id: Some(m.id),
            reference_type: Some("measurement".to_string()),
            wedding_party_id: None,
        });
    }

    for a in appts {
        events.push(CustomerTimelineEvent {
            at: a.datetime,
            kind: "appointment".to_string(),
            summary: format!(
                "{}: Scheduled {} appointment",
                a.datetime.format("%m/%d/%y"),
                a.appt_type
            ),
            reference_id: Some(a.id),
            reference_type: Some("appointment".to_string()),
            wedding_party_id: None,
        });
    }

    for se in shipment_events {
        let body = {
            let m = se.message.trim();
            if m.is_empty() {
                se.kind.replace('_', " ")
            } else {
                m.to_string()
            }
        };
        let staff_suffix = se
            .staff_name
            .as_deref()
            .map(|n| {
                let t = n.trim();
                if t.is_empty() {
                    String::new()
                } else {
                    format!(" · {t}")
                }
            })
            .unwrap_or_default();
        events.push(CustomerTimelineEvent {
            at: se.at,
            kind: "shipping".to_string(),
            summary: format!(
                "{}: Shipment {} — {}{}",
                se.at.format("%m/%d/%y"),
                short_order_ref(se.shipment_id),
                body,
                staff_suffix
            ),
            reference_id: Some(se.shipment_id),
            reference_type: Some("shipment".to_string()),
            wedding_party_id: None,
        });
    }

    events.sort_by(|a, b| b.at.cmp(&a.at));
    events.truncate(90);
    Ok(events)
}

async fn get_customer_timeline(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<CustomerTimelineResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_TIMELINE).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let events = build_customer_timeline(&state.db, customer_id)
        .await
        .map_err(CustomerError::Database)?;
    Ok(Json(CustomerTimelineResponse { events }))
}

async fn get_customer_order_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Query(q): Query<CustomerOrderHistoryQuery>,
) -> Result<Json<CustomerOrderHistoryResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, ORDERS_VIEW).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let body = query_customer_order_history(&state.db, customer_id, &q)
        .await
        .map_err(CustomerError::Database)?;
    Ok(Json(body))
}

async fn get_customer_measurement_vault(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<MeasurementVaultResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_MEASUREMENTS).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }

    let block = sqlx::query_as::<_, MeasurementRecord>(
        r#"
        SELECT
            id,
            neck, sleeve, chest, waist, seat, inseam, outseam, shoulder,
            retail_suit, retail_waist, retail_vest, retail_shirt, retail_shoe,
            measured_at,
            'current_block'::text AS source
        FROM customer_measurements
        WHERE customer_id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(&state.db)
    .await?;

    let history = sqlx::query_as::<_, MeasurementRecord>(
        r#"
        SELECT
            id,
            neck, sleeve, chest, waist, seat, inseam, outseam, shoulder,
            NULL::text AS retail_suit,
            NULL::text AS retail_waist,
            NULL::text AS retail_vest,
            NULL::text AS retail_shirt,
            NULL::text AS retail_shoe,
            created_at AS measured_at,
            'archive'::text AS source
        FROM measurements
        WHERE customer_id = $1
        ORDER BY created_at DESC
        LIMIT 40
        "#,
    )
    .bind(customer_id)
    .fetch_all(&state.db)
    .await?;

    let latest = block.or_else(|| history.first().cloned());

    Ok(Json(MeasurementVaultResponse { latest, history }))
}

async fn patch_customer_measurements(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<PatchCustomerMeasurementsBody>,
) -> Result<Json<MeasurementVaultResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_MEASUREMENTS).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }

    let patch = customer_measurements::PatchMeasurementBlock {
        neck: body.neck,
        sleeve: body.sleeve,
        chest: body.chest,
        waist: body.waist,
        seat: body.seat,
        inseam: body.inseam,
        outseam: body.outseam,
        shoulder: body.shoulder,
        retail_suit: body.retail_suit,
        retail_waist: body.retail_waist,
        retail_vest: body.retail_vest,
        retail_shirt: body.retail_shirt,
        retail_shoe: body.retail_shoe,
    };

    customer_measurements::patch_measurement_block(&state.db, customer_id, &patch)
        .await
        .map_err(CustomerError::Database)?;

    get_customer_measurement_vault(State(state.clone()), headers.clone(), Path(customer_id)).await
}

async fn list_customer_groups(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<CustomerGroupListRow>>, CustomerError> {
    require_customer_access(&state, &headers).await?;
    let rows = sqlx::query_as::<_, CustomerGroupListRow>(
        r#"
        SELECT g.id, g.code, g.label, COUNT(cgm.customer_id)::bigint AS member_count
        FROM customer_groups g
        LEFT JOIN customer_group_members cgm ON cgm.group_id = g.id
        GROUP BY g.id, g.code, g.label
        ORDER BY g.label ASC
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn add_customer_group_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CustomerGroupMemberBody>,
) -> Result<StatusCode, CustomerError> {
    let _staff =
        middleware::require_staff_with_permission(&state, &headers, CUSTOMER_GROUPS_MANAGE)
            .await
            .map_err(|(_code, axum::Json(v))| {
                CustomerError::Unauthorized(
                    v.get("error")
                        .and_then(|x| x.as_str())
                        .unwrap_or("not authorized")
                        .to_string(),
                )
            })?;

    sqlx::query(
        r#"
        INSERT INTO customer_group_members (customer_id, group_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(body.customer_id)
    .bind(body.group_id)
    .execute(&state.db)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn remove_customer_group_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<RemoveCustomerGroupQuery>,
) -> Result<StatusCode, CustomerError> {
    let _staff =
        middleware::require_staff_with_permission(&state, &headers, CUSTOMER_GROUPS_MANAGE)
            .await
            .map_err(|(_code, axum::Json(v))| {
                CustomerError::Unauthorized(
                    v.get("error")
                        .and_then(|x| x.as_str())
                        .unwrap_or("not authorized")
                        .to_string(),
                )
            })?;

    sqlx::query("DELETE FROM customer_group_members WHERE customer_id = $1 AND group_id = $2")
        .bind(q.customer_id)
        .bind(q.group_id)
        .execute(&state.db)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn get_customer_open_deposit_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<customer_open_deposit::CustomerOpenDepositSummary>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let s = customer_open_deposit::fetch_summary(&state.db, customer_id)
        .await
        .map_err(CustomerError::Database)?;
    Ok(Json(s))
}

async fn get_customer_store_credit_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<store_credit::StoreCreditSummary>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let s = store_credit::fetch_summary(&state.db, customer_id)
        .await
        .map_err(CustomerError::Database)?;
    Ok(Json(s))
}

async fn post_customer_store_credit_adjust(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<StoreCreditAdjustBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    let _staff = middleware::require_staff_with_permission(&state, &headers, STORE_CREDIT_MANAGE)
        .await
        .map_err(|(_code, axum::Json(v))| {
            CustomerError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("not authorized")
                    .to_string(),
            )
        })?;

    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }

    let new_bal = store_credit::adjust_balance(&state.db, customer_id, body.amount, &body.reason)
        .await
        .map_err(|e| match e {
            store_credit::StoreCreditError::InsufficientBalance => CustomerError::BadRequest(
                "Insufficient store credit balance for this adjustment".to_string(),
            ),
            store_credit::StoreCreditError::ReasonRequired => {
                CustomerError::BadRequest("Adjustment reason is required".to_string())
            }
            store_credit::StoreCreditError::NotFound => CustomerError::NotFound,
            store_credit::StoreCreditError::Database(d) => CustomerError::Database(d),
        })?;

    Ok(Json(json!({ "balance": new_bal })))
}

async fn post_customer_timeline_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<PostCustomerNoteRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_TIMELINE).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let text = body.body.trim();
    if text.is_empty() {
        return Err(CustomerError::BadRequest(
            "Note body cannot be empty".to_string(),
        ));
    }

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO customer_timeline_notes (customer_id, body, created_by)
        VALUES ($1, $2, $3)
        RETURNING id
        "#,
    )
    .bind(customer_id)
    .bind(text)
    .bind(body.created_by_staff_id)
    .fetch_one(&state.db)
    .await
    .map_err(CustomerError::Database)?;

    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}
