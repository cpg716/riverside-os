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
    effective_permissions_for_staff, staff_has_permission, CUSTOMERS_COUPLE_MANAGE,
    CUSTOMERS_DUPLICATE_REVIEW, CUSTOMERS_HUB_EDIT, CUSTOMERS_HUB_VIEW, CUSTOMERS_MEASUREMENTS,
    CUSTOMERS_MERGE, CUSTOMERS_RMS_CHARGE, CUSTOMERS_RMS_CHARGE_MANAGE_LINKS,
    CUSTOMERS_RMS_CHARGE_RECONCILE, CUSTOMERS_RMS_CHARGE_REPORTING,
    CUSTOMERS_RMS_CHARGE_RESOLVE_EXCEPTIONS, CUSTOMERS_RMS_CHARGE_REVERSE,
    CUSTOMERS_RMS_CHARGE_VIEW, CUSTOMERS_TIMELINE, CUSTOMER_GROUPS_MANAGE, ORDERS_VIEW,
    POS_RMS_CHARGE_HISTORY_BASIC, POS_RMS_CHARGE_LOOKUP, POS_RMS_CHARGE_PAYMENT_COLLECT,
    POS_RMS_CHARGE_USE, STORE_CREDIT_MANAGE,
};
use crate::logic::corecard;
use crate::logic::customer_duplicate_candidates::find_duplicate_candidates;
use crate::logic::customer_hub::{days_since_last_visit, fetch_hub_stats};
use crate::logic::customer_measurements;
use crate::logic::customer_merge;
use crate::logic::customer_open_deposit;
use crate::logic::customer_transaction_history::{
    query_customer_transaction_history, CustomerTransactionHistoryQuery,
    CustomerTransactionHistoryResponse,
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

pub(crate) async fn rosie_customer_hub_snapshot(
    state: &AppState,
    headers: &HeaderMap,
    customer_id: Uuid,
) -> Result<serde_json::Value, Response> {
    let Json(hub) = get_customer_hub(State(state.clone()), headers.clone(), Path(customer_id))
        .await
        .map_err(IntoResponse::into_response)?;

    serde_json::to_value(hub).map_err(|error| {
        tracing::error!(error = %error, %customer_id, "serialize ROSIE customer hub snapshot");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "failed to serialize customer hub snapshot" })),
        )
            .into_response()
    })
}
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

const CUSTOMER_LIFECYCLE_ACTIVE_DAYS: i64 = 90;
const ADDRESS_LOOKUP_MIN_QUERY_LEN: usize = 8;
const ADDRESS_LOOKUP_MAX_RESULTS: usize = 5;
const CENSUS_ADDRESS_LOOKUP_URL: &str =
    "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

#[derive(Debug, Deserialize)]
struct AddressSuggestionQuery {
    q: String,
}

#[derive(Debug, Serialize)]
struct AddressSuggestion {
    id: String,
    label: String,
    address_line1: String,
    city: String,
    state: String,
    postal_code: String,
}

#[derive(Debug, Deserialize)]
struct CensusAddressLookupResponse {
    result: Option<CensusAddressLookupResult>,
}

#[derive(Debug, Deserialize)]
struct CensusAddressLookupResult {
    #[serde(rename = "addressMatches")]
    address_matches: Option<Vec<CensusAddressMatch>>,
}

#[derive(Debug, Deserialize)]
struct CensusAddressMatch {
    #[serde(rename = "addressComponents")]
    address_components: Option<CensusAddressComponents>,
}

#[derive(Debug, Deserialize)]
struct CensusAddressComponents {
    #[serde(rename = "fromAddress")]
    from_address: Option<String>,
    #[serde(rename = "preDirection")]
    pre_direction: Option<String>,
    #[serde(rename = "preType")]
    pre_type: Option<String>,
    #[serde(rename = "streetName")]
    street_name: Option<String>,
    #[serde(rename = "suffixType")]
    suffix_type: Option<String>,
    #[serde(rename = "suffixDirection")]
    suffix_direction: Option<String>,
    city: Option<String>,
    state: Option<String>,
    zip: Option<String>,
}

fn title_case_address(value: &str) -> String {
    value
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => {
                    format!(
                        "{}{}",
                        first.to_uppercase(),
                        chars.as_str().to_ascii_lowercase()
                    )
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_census_street_line(parts: &CensusAddressComponents) -> String {
    [
        parts.from_address.as_deref(),
        parts.pre_direction.as_deref(),
        parts.pre_type.as_deref(),
        parts.street_name.as_deref(),
        parts.suffix_type.as_deref(),
        parts.suffix_direction.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
}

fn map_census_address_match(
    address_match: CensusAddressMatch,
    index: usize,
) -> Option<AddressSuggestion> {
    let parts = address_match.address_components?;
    let address_line1 = build_census_street_line(&parts);
    let city = parts.city?.trim().to_string();
    let state = parts.state?.trim().to_ascii_uppercase();
    let postal_code = parts.zip?.trim().to_string();
    if address_line1.is_empty() || city.is_empty() || state.is_empty() || postal_code.is_empty() {
        return None;
    }
    let address_line1 = title_case_address(&address_line1);
    let city = title_case_address(&city);
    let label = format!("{address_line1}, {city}, {state} {postal_code}");
    Some(AddressSuggestion {
        id: format!("{label}-{index}"),
        label,
        address_line1,
        city,
        state,
        postal_code,
    })
}

fn normalize_customer_lifecycle_filter(raw: Option<&str>) -> Option<&'static str> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        Some("new") => Some(CustomerLifecycleState::New.as_str()),
        Some("active") => Some(CustomerLifecycleState::Active.as_str()),
        Some("pending") => Some(CustomerLifecycleState::Pending.as_str()),
        Some("pickup") => Some(CustomerLifecycleState::Pickup.as_str()),
        Some("completed") => Some(CustomerLifecycleState::Completed.as_str()),
        Some("issue") => Some(CustomerLifecycleState::Issue.as_str()),
        _ => None,
    }
}

#[derive(Debug, sqlx::FromRow)]
struct CustomerLifecycleSignals {
    lifetime_sales: Decimal,
    open_orders_count: i64,
    active_shipment_status: Option<String>,
    wedding_active: bool,
    ready_for_pickup_count: i64,
    last_activity_at: Option<DateTime<Utc>>,
}

fn derive_customer_lifecycle(signals: &CustomerLifecycleSignals) -> CustomerLifecycleState {
    if signals.active_shipment_status.as_deref() == Some("exception") {
        return CustomerLifecycleState::Issue;
    }

    if signals.ready_for_pickup_count > 0 {
        return CustomerLifecycleState::Pickup;
    }

    if signals.open_orders_count > 0
        || signals.wedding_active
        || matches!(
            signals.active_shipment_status.as_deref(),
            Some("draft" | "quoted" | "label_purchased" | "in_transit")
        )
    {
        return CustomerLifecycleState::Pending;
    }

    if signals.lifetime_sales <= Decimal::ZERO && signals.last_activity_at.is_none() {
        return CustomerLifecycleState::New;
    }

    if let Some(last_activity_at) = signals.last_activity_at {
        if (Utc::now() - last_activity_at).num_days() <= CUSTOMER_LIFECYCLE_ACTIVE_DAYS {
            return CustomerLifecycleState::Active;
        }
    }

    if signals.lifetime_sales > Decimal::ZERO || signals.last_activity_at.is_some() {
        return CustomerLifecycleState::Completed;
    }

    CustomerLifecycleState::New
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

async fn require_staff_with_any_permission(
    state: &AppState,
    headers: &HeaderMap,
    permissions: &[&str],
) -> Result<crate::auth::pins::AuthenticatedStaff, CustomerError> {
    let staff = middleware::require_authenticated_staff_headers(state, headers)
        .await
        .map_err(map_perm_or_pos_err)?;
    let effective = effective_permissions_for_staff(&state.db, staff.id, staff.role)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "customer permission resolution failed");
            CustomerError::Forbidden("permission resolution failed".to_string())
        })?;
    if permissions
        .iter()
        .any(|permission| staff_has_permission(&effective, permission))
    {
        Ok(staff)
    } else {
        Err(CustomerError::Forbidden("missing permission".to_string()))
    }
}

async fn require_rms_charge_view_staff(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<crate::auth::pins::AuthenticatedStaff, CustomerError> {
    require_staff_with_any_permission(
        state,
        headers,
        &[
            CUSTOMERS_RMS_CHARGE,
            CUSTOMERS_RMS_CHARGE_VIEW,
            CUSTOMERS_RMS_CHARGE_MANAGE_LINKS,
            CUSTOMERS_RMS_CHARGE_REPORTING,
            CUSTOMERS_RMS_CHARGE_RESOLVE_EXCEPTIONS,
            CUSTOMERS_RMS_CHARGE_RECONCILE,
            POS_RMS_CHARGE_USE,
            POS_RMS_CHARGE_LOOKUP,
            POS_RMS_CHARGE_HISTORY_BASIC,
            POS_RMS_CHARGE_PAYMENT_COLLECT,
        ],
    )
    .await
}

async fn require_rms_charge_manage_staff(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<crate::auth::pins::AuthenticatedStaff, CustomerError> {
    require_staff_with_any_permission(
        state,
        headers,
        &[CUSTOMERS_RMS_CHARGE_MANAGE_LINKS, CUSTOMERS_RMS_CHARGE],
    )
    .await
}

async fn require_rms_charge_exception_staff(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<crate::auth::pins::AuthenticatedStaff, CustomerError> {
    require_staff_with_any_permission(
        state,
        headers,
        &[
            CUSTOMERS_RMS_CHARGE_RESOLVE_EXCEPTIONS,
            CUSTOMERS_RMS_CHARGE_RECONCILE,
            CUSTOMERS_RMS_CHARGE_REVERSE,
            CUSTOMERS_RMS_CHARGE,
        ],
    )
    .await
}

async fn require_rms_charge_reconcile_staff(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<crate::auth::pins::AuthenticatedStaff, CustomerError> {
    require_staff_with_any_permission(
        state,
        headers,
        &[
            CUSTOMERS_RMS_CHARGE_RECONCILE,
            CUSTOMERS_RMS_CHARGE_REPORTING,
            CUSTOMERS_RMS_CHARGE,
        ],
    )
    .await
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
    pub date_of_birth: Option<chrono::NaiveDate>,
    pub anniversary_date: Option<chrono::NaiveDate>,
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
    pub customer_created_source: String,
    pub couple_id: Option<Uuid>,
    pub couple_primary_id: Option<Uuid>,
    pub couple_linked_at: Option<DateTime<Utc>>,
    pub open_balance_due: Decimal,
    pub lifetime_sales: Decimal,
}

async fn load_customer_profile_row(
    pool: &sqlx::PgPool,
    customer_id: Uuid,
) -> Result<CustomerProfileRow, CustomerError> {
    let row = sqlx::query_as::<_, CustomerProfileRow>(
        r#"
        SELECT
            c.id, c.customer_code,
            COALESCE(c.first_name, '') AS first_name,
            COALESCE(c.last_name, '') AS last_name,
            c.company_name, c.email, c.phone,
            c.address_line1, c.address_line2, c.city, c.state, c.postal_code,
            c.date_of_birth, c.anniversary_date,
            c.custom_field_1, c.custom_field_2, c.custom_field_3, c.custom_field_4,
            c.marketing_email_opt_in, c.marketing_sms_opt_in, c.transactional_sms_opt_in,
            c.transactional_email_opt_in, c.podium_conversation_url,
            c.is_vip, c.loyalty_points, c.customer_created_source,
            c.couple_id, c.couple_primary_id, c.couple_linked_at,
            COALESCE(ob.balance_sum, 0)::numeric(12, 2) AS open_balance_due,
            COALESCE(ob.lifetime_sales, 0)::numeric(12, 2) AS lifetime_sales
        FROM customers c
        LEFT JOIN LATERAL (
            SELECT 
                SUM(balance_due) FILTER (WHERE status = 'open'::order_status) AS balance_sum,
                SUM(total_price) FILTER (WHERE status = 'fulfilled'::order_status AND booked_at >= '2018-01-01') AS lifetime_sales
            FROM transactions
            WHERE customer_id = c.id
        ) ob ON true
        WHERE c.id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await?
    .ok_or(CustomerError::NotFound)?;
    Ok(row)
}

async fn load_customer_lifecycle_signals(
    pool: &sqlx::PgPool,
    customer_id: Uuid,
) -> Result<CustomerLifecycleSignals, sqlx::Error> {
    sqlx::query_as::<_, CustomerLifecycleSignals>(
        r#"
        SELECT
            COALESCE(tx.lifetime_sales, 0)::numeric(12, 2) AS lifetime_sales,
            COALESCE(tx.open_orders_count, 0)::bigint AS open_orders_count,
            (
                SELECT s.status::text
                FROM shipment s
                WHERE s.customer_id = c.id
                  AND s.status NOT IN ('delivered', 'cancelled')
                ORDER BY s.created_at DESC
                LIMIT 1
            ) AS active_shipment_status,
            EXISTS (
                SELECT 1
                FROM wedding_members wm
                JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                WHERE wm.customer_id = c.id
                  AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                  AND wp.event_date >= CURRENT_DATE
            ) AS wedding_active,
            COALESCE(tx.ready_for_pickup_count, 0)::bigint AS ready_for_pickup_count,
            (
                SELECT MAX(ts)
                FROM (
                    SELECT MAX(booked_at) AS ts
                    FROM transactions
                    WHERE customer_id = c.id
                    UNION ALL
                    SELECT MAX(created_at)
                    FROM payment_transactions
                    WHERE payer_id = c.id
                    UNION ALL
                    SELECT MAX(created_at)
                    FROM measurements
                    WHERE customer_id = c.id
                    UNION ALL
                    SELECT MAX(measured_at)
                    FROM customer_measurements
                    WHERE customer_id = c.id
                    UNION ALL
                    SELECT MAX(created_at)
                    FROM customer_timeline_notes
                    WHERE customer_id = c.id
                    UNION ALL
                    SELECT MAX(l.created_at)
                    FROM wedding_activity_log l
                    WHERE EXISTS (
                        SELECT 1
                        FROM wedding_members wm
                        WHERE wm.wedding_party_id = l.wedding_party_id
                          AND wm.customer_id = c.id
                          AND (
                            l.wedding_member_id IS NULL
                            OR l.wedding_member_id = wm.id
                          )
                    )
                ) activity
            ) AS last_activity_at
        FROM customers c
        LEFT JOIN LATERAL (
            SELECT
                SUM(total_price) FILTER (WHERE status = 'fulfilled'::order_status AND booked_at >= '2018-01-01') AS lifetime_sales,
                COUNT(*) FILTER (WHERE status IN ('open'::order_status, 'pending_measurement'::order_status)) AS open_orders_count,
                COUNT(*) FILTER (WHERE status::text = 'ready') AS ready_for_pickup_count
            FROM transactions
            WHERE customer_id = c.id
        ) tx ON true
        WHERE c.id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await
}

#[derive(Debug, Serialize, FromRow)]
pub struct WeddingMembershipRow {
    pub wedding_member_id: Uuid,
    pub wedding_party_id: Uuid,
    pub transaction_id: Option<Uuid>,
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
    pub lifecycle_state: CustomerLifecycleState,
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
    /// Optional lifecycle filter (`new`, `active`, `pending`, `pickup`, `completed`, `issue`).
    pub lifecycle: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CustomerLifecycleState {
    New,
    Active,
    Pending,
    Pickup,
    Completed,
    Issue,
}

impl CustomerLifecycleState {
    fn as_str(self) -> &'static str {
        match self {
            CustomerLifecycleState::New => "new",
            CustomerLifecycleState::Active => "active",
            CustomerLifecycleState::Pending => "pending",
            CustomerLifecycleState::Pickup => "pickup",
            CustomerLifecycleState::Completed => "completed",
            CustomerLifecycleState::Issue => "issue",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct CustomerPipelineStats {
    pub total_customers: i64,
    pub vip_customers: i64,
    pub with_balance: i64,
    pub upcoming_weddings: i64,
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
    pub lifetime_sales: Decimal,
    pub open_orders_count: i64,
    pub active_shipment_status: Option<String>,
    pub wedding_soon: bool,
    pub wedding_active: bool,
    pub wedding_party_name: Option<String>,
    pub wedding_party_id: Option<Uuid>,
    pub couple_id: Option<Uuid>,
    pub couple_primary_id: Option<Uuid>,
    pub lifecycle_state: String,
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

async fn get_address_suggestions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AddressSuggestionQuery>,
) -> Result<Json<Vec<AddressSuggestion>>, CustomerError> {
    require_customer_access(&state, &headers).await?;
    let query = q.q.trim();
    if query.len() < ADDRESS_LOOKUP_MIN_QUERY_LEN {
        return Ok(Json(Vec::new()));
    }

    let res = state
        .http_client
        .get(CENSUS_ADDRESS_LOOKUP_URL)
        .query(&[
            ("address", query),
            ("benchmark", "Public_AR_Current"),
            ("format", "json"),
        ])
        .send()
        .await;

    let Ok(res) = res else {
        tracing::warn!("customer address lookup request failed");
        return Ok(Json(Vec::new()));
    };
    if !res.status().is_success() {
        tracing::warn!(
            status = %res.status(),
            "customer address lookup returned non-success status"
        );
        return Ok(Json(Vec::new()));
    }

    let body = res.json::<CensusAddressLookupResponse>().await;
    let Ok(body) = body else {
        tracing::warn!("customer address lookup response was not valid JSON");
        return Ok(Json(Vec::new()));
    };

    let suggestions = body
        .result
        .and_then(|result| result.address_matches)
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .filter_map(|(index, address_match)| map_census_address_match(address_match, index))
        .take(ADDRESS_LOOKUP_MAX_RESULTS)
        .collect();

    Ok(Json(suggestions))
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
    account_id: Option<String>,
    #[serde(default)]
    program_code: Option<String>,
    #[serde(default)]
    posting_status: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RmsChargeOverviewQuery {
    #[serde(default)]
    customer_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct RmsChargeExceptionsQuery {
    #[serde(default)]
    customer_id: Option<Uuid>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RmsChargeProgramsQuery {
    #[serde(default)]
    customer_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct RmsChargeReconciliationQuery {
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RunReconciliationBody {
    #[serde(default)]
    run_scope: Option<String>,
    #[serde(default)]
    date_from: Option<String>,
    #[serde(default)]
    date_to: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExceptionAssignBody {
    #[serde(default)]
    assigned_to_staff_id: Option<Uuid>,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExceptionResolveBody {
    #[serde(default)]
    resolution_notes: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
struct RmsChargeRecordApiRow {
    id: Uuid,
    record_kind: String,
    created_at: DateTime<Utc>,
    transaction_id: Uuid,
    register_session_id: Uuid,
    customer_id: Option<Uuid>,
    payment_method: String,
    amount: Decimal,
    operator_staff_id: Option<Uuid>,
    payment_transaction_id: Option<Uuid>,
    customer_display: Option<String>,
    order_short_ref: Option<String>,
    tender_family: Option<String>,
    program_code: Option<String>,
    program_label: Option<String>,
    masked_account: Option<String>,
    linked_corecredit_customer_id: Option<String>,
    linked_corecredit_account_id: Option<String>,
    resolution_status: Option<String>,
    posting_status: String,
    posting_error_code: Option<String>,
    host_reference: Option<String>,
    external_transaction_id: Option<String>,
    customer_name: Option<String>,
    customer_code: Option<String>,
    operator_name: Option<String>,
}

async fn link_customer_rms_charge_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<corecard::LinkCustomerCoreCreditAccountRequest>,
) -> Result<Json<corecard::LinkedCoreCreditAccountView>, CustomerError> {
    let staff = require_rms_charge_manage_staff(&state, &headers).await?;
    let linked = corecard::link_customer_account(&state.db, &body, staff.id)
        .await
        .map_err(|error| CustomerError::BadRequest(error.to_string()))?;
    let _ = crate::auth::pins::log_staff_access(
        &state.db,
        staff.id,
        "rms_charge_link_account",
        json!({
            "customer_id": body.customer_id,
            "corecredit_customer_id": body.corecredit_customer_id,
            "corecredit_account_id": corecard::mask_account_identifier(&body.corecredit_account_id),
            "is_primary": body.is_primary,
        }),
    )
    .await;
    Ok(Json(corecard::LinkedCoreCreditAccountView {
        masked_account: corecard::mask_account_identifier(&linked.corecredit_account_id),
        id: linked.id,
        customer_id: linked.customer_id,
        corecredit_customer_id: linked.corecredit_customer_id,
        corecredit_account_id: linked.corecredit_account_id,
        corecredit_card_id: linked.corecredit_card_id,
        status: linked.status,
        is_primary: linked.is_primary,
        program_group: linked.program_group,
        last_verified_at: linked.last_verified_at,
        verified_by_staff_id: linked.verified_by_staff_id,
        verification_source: linked.verification_source,
        notes: linked.notes,
        created_at: linked.created_at,
        updated_at: linked.updated_at,
    }))
}

async fn unlink_customer_rms_charge_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<corecard::UnlinkCustomerCoreCreditAccountRequest>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    let staff = require_rms_charge_manage_staff(&state, &headers).await?;
    let removed = corecard::unlink_customer_account(&state.db, &body)
        .await
        .map_err(|error| match error {
            corecard::CoreCardError::AccountNotFound => CustomerError::NotFound,
            _ => CustomerError::BadRequest(error.to_string()),
        })?;
    let _ = crate::auth::pins::log_staff_access(
        &state.db,
        staff.id,
        "rms_charge_unlink_account",
        json!({
            "customer_id": body.customer_id,
            "link_id": body.link_id,
            "corecredit_account_id": corecard::mask_account_identifier(&removed.corecredit_account_id),
        }),
    )
    .await;
    Ok(Json(json!({
        "status": "unlinked",
        "link_id": removed.id,
    })))
}

async fn list_customer_rms_charge_accounts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<Vec<corecard::LinkedCoreCreditAccountView>>, CustomerError> {
    require_rms_charge_view_staff(&state, &headers).await?;
    let rows = corecard::list_customer_account_views(&state.db, customer_id)
        .await
        .map_err(|error| CustomerError::BadRequest(error.to_string()))?;
    Ok(Json(rows))
}

async fn get_customer_rms_charge_account_balances(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<corecard::CoreCardAccountBalancesResponse>, CustomerError> {
    require_rms_charge_view_staff(&state, &headers).await?;
    let customer_id = query
        .get("customer_id")
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| CustomerError::BadRequest("customer_id is required".to_string()))?;
    let response = corecard::account_balances_for_customer(
        &state.db,
        &state.http_client,
        &state.corecard_config,
        &state.corecard_token_cache,
        customer_id,
        account_id.trim(),
    )
    .await
    .map_err(|error| CustomerError::BadRequest(error.to_string()))?;
    Ok(Json(response))
}

async fn get_customer_rms_charge_account_transactions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<corecard::CoreCardAccountTransactionsResponse>, CustomerError> {
    require_rms_charge_view_staff(&state, &headers).await?;
    let customer_id = query
        .get("customer_id")
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| CustomerError::BadRequest("customer_id is required".to_string()))?;
    let response = corecard::account_transactions_for_customer(
        &state.db,
        &state.http_client,
        &state.corecard_config,
        &state.corecard_token_cache,
        customer_id,
        account_id.trim(),
    )
    .await
    .map_err(|error| CustomerError::BadRequest(error.to_string()))?;
    Ok(Json(response))
}

async fn get_rms_charge_record(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(record_id): Path<Uuid>,
) -> Result<Json<corecard::RmsChargeRecordDetail>, CustomerError> {
    require_rms_charge_view_staff(&state, &headers).await?;
    let row = corecard::get_rms_charge_record_detail(&state.db, record_id)
        .await
        .map_err(|error| CustomerError::BadRequest(error.to_string()))?;
    Ok(Json(row))
}

async fn get_rms_charge_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RmsChargeOverviewQuery>,
) -> Result<Json<corecard::CoreCardOverviewResponse>, CustomerError> {
    require_rms_charge_view_staff(&state, &headers).await?;
    let overview = corecard::fetch_overview(&state.db, query.customer_id)
        .await
        .map_err(|error| CustomerError::BadRequest(error.to_string()))?;
    Ok(Json(overview))
}

async fn get_rms_charge_exceptions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RmsChargeExceptionsQuery>,
) -> Result<Json<Vec<corecard::CoreCardExceptionQueueRow>>, CustomerError> {
    require_rms_charge_exception_staff(&state, &headers).await?;
    let rows = corecard::list_exceptions(
        &state.db,
        query.status.as_deref(),
        query.customer_id,
        query.limit.unwrap_or(50),
    )
    .await
    .map_err(|error| CustomerError::BadRequest(error.to_string()))?;
    Ok(Json(rows))
}

async fn assign_rms_charge_exception(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(exception_id): Path<Uuid>,
    Json(body): Json<ExceptionAssignBody>,
) -> Result<Json<corecard::CoreCardExceptionQueueRow>, CustomerError> {
    let staff = require_rms_charge_exception_staff(&state, &headers).await?;
    let row = corecard::assign_exception(
        &state.db,
        exception_id,
        body.assigned_to_staff_id,
        body.notes.as_deref(),
    )
    .await
    .map_err(|error| CustomerError::BadRequest(error.to_string()))?;
    let _ = crate::auth::pins::log_staff_access(
        &state.db,
        staff.id,
        "rms_charge_exception_assign",
        json!({
            "exception_id": exception_id,
            "assigned_to_staff_id": body.assigned_to_staff_id,
        }),
    )
    .await;
    Ok(Json(row))
}

async fn resolve_rms_charge_exception(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(exception_id): Path<Uuid>,
    Json(body): Json<ExceptionResolveBody>,
) -> Result<Json<corecard::CoreCardExceptionQueueRow>, CustomerError> {
    let staff = require_rms_charge_exception_staff(&state, &headers).await?;
    let row =
        corecard::resolve_exception(&state.db, exception_id, body.resolution_notes.as_deref())
            .await
            .map_err(|error| CustomerError::BadRequest(error.to_string()))?;
    let _ = crate::auth::pins::log_staff_access(
        &state.db,
        staff.id,
        "rms_charge_exception_resolve",
        json!({
            "exception_id": exception_id,
        }),
    )
    .await;
    Ok(Json(row))
}

async fn retry_rms_charge_exception(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(exception_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    let staff = require_rms_charge_exception_staff(&state, &headers).await?;
    let exception = sqlx::query_as::<_, corecard::CoreCardExceptionQueueRow>(
        r#"
        SELECT
            id,
            rms_record_id,
            account_id,
            exception_type,
            severity,
            status,
            assigned_to_staff_id,
            opened_at,
            resolved_at,
            notes,
            resolution_notes,
            retry_count,
            last_retry_at,
            metadata_json
        FROM corecredit_exception_queue
        WHERE id = $1
        "#,
    )
    .bind(exception_id)
    .fetch_one(&state.db)
    .await?;

    let mut retried = false;
    if let Some(record_id) = exception.rms_record_id {
        let record = corecard::get_rms_charge_record_detail(&state.db, record_id)
            .await
            .map_err(|error| CustomerError::BadRequest(error.to_string()))?;
        let stable_reference = record
            .idempotency_key
            .clone()
            .unwrap_or_else(|| record.transaction_id.to_string());
        let request = corecard::CoreCardMutationRequest {
            customer_id: record.customer_id,
            linked_corecredit_customer_id: record
                .linked_corecredit_customer_id
                .clone()
                .unwrap_or_default(),
            linked_corecredit_account_id: record
                .linked_corecredit_account_id
                .clone()
                .unwrap_or_default(),
            linked_corecredit_card_id: None,
            program_code: record.program_code.clone(),
            amount: record.amount,
            idempotency_key: corecard::build_idempotency_key(
                match record.external_transaction_type.as_deref() {
                    Some("payment") => corecard::CoreCardOperationType::Payment,
                    Some("refund") => corecard::CoreCardOperationType::Refund,
                    Some("reversal") => corecard::CoreCardOperationType::Reversal,
                    _ if record.record_kind == "payment" => {
                        corecard::CoreCardOperationType::Payment
                    }
                    _ => corecard::CoreCardOperationType::Purchase,
                },
                &stable_reference,
                record
                    .linked_corecredit_account_id
                    .as_deref()
                    .unwrap_or_default(),
                record.amount,
                record.program_code.as_deref(),
            ),
            transaction_id: Some(record.transaction_id),
            payment_transaction_id: record.payment_transaction_id,
            pos_rms_charge_record_id: Some(record.id),
            reason: Some("exception_retry".to_string()),
            reference_hint: record.order_short_ref.clone(),
            metadata: record.metadata_json.clone(),
        };
        let result = match request.idempotency_key.as_str() {
            _ if record.external_transaction_type.as_deref() == Some("refund") => {
                corecard::post_refund(
                    &state.db,
                    &state.http_client,
                    &state.corecard_config,
                    &state.corecard_token_cache,
                    &request,
                )
                .await
            }
            _ if record.external_transaction_type.as_deref() == Some("reversal") => {
                corecard::post_reversal(
                    &state.db,
                    &state.http_client,
                    &state.corecard_config,
                    &state.corecard_token_cache,
                    &request,
                )
                .await
            }
            _ if record.record_kind == "payment" => {
                corecard::post_payment(
                    &state.db,
                    &state.http_client,
                    &state.corecard_config,
                    &state.corecard_token_cache,
                    &request,
                )
                .await
            }
            _ => {
                corecard::post_purchase(
                    &state.db,
                    &state.http_client,
                    &state.corecard_config,
                    &state.corecard_token_cache,
                    &request,
                )
                .await
            }
        }
        .map_err(|error| CustomerError::BadRequest(error.to_string()))?;

        crate::logic::pos_rms_charge::update_record_host_result(
            &state.db,
            record.id,
            &serde_json::to_value(&result).unwrap_or_else(|_| json!({})),
        )
        .await
        .map_err(CustomerError::Database)?;
        retried = true;
    }

    sqlx::query(
        r#"
        UPDATE corecredit_exception_queue
        SET
            status = CASE WHEN $2 THEN 'resolved' ELSE 'retry_pending' END,
            retry_count = retry_count + 1,
            last_retry_at = now(),
            resolved_at = CASE WHEN $2 THEN now() ELSE resolved_at END
        WHERE id = $1
        "#,
    )
    .bind(exception_id)
    .bind(retried)
    .execute(&state.db)
    .await?;

    let _ = crate::auth::pins::log_staff_access(
        &state.db,
        staff.id,
        "rms_charge_exception_retry",
        json!({
            "exception_id": exception_id,
            "retried": retried,
        }),
    )
    .await;

    Ok(Json(json!({
        "status": if retried { "retried" } else { "retry_pending" },
        "exception_id": exception_id,
    })))
}

async fn get_rms_charge_reconciliation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RmsChargeReconciliationQuery>,
) -> Result<Json<corecard::CoreCardReconciliationResponse>, CustomerError> {
    require_rms_charge_reconcile_staff(&state, &headers).await?;
    let response = corecard::list_reconciliation(&state.db, query.limit.unwrap_or(10))
        .await
        .map_err(|error| CustomerError::BadRequest(error.to_string()))?;
    Ok(Json(response))
}

async fn run_rms_charge_reconciliation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RunReconciliationBody>,
) -> Result<Json<corecard::CoreCardReconciliationRunRow>, CustomerError> {
    let staff = require_rms_charge_reconcile_staff(&state, &headers).await?;
    let date_from = body
        .date_from
        .as_deref()
        .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok());
    let date_to = body
        .date_to
        .as_deref()
        .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok());
    let run = corecard::run_reconciliation(
        &state.db,
        Some(staff.id),
        body.run_scope.as_deref().unwrap_or("manual"),
        date_from,
        date_to,
    )
    .await
    .map_err(|error| CustomerError::BadRequest(error.to_string()))?;
    let _ = crate::auth::pins::log_staff_access(
        &state.db,
        staff.id,
        "rms_charge_reconciliation_run",
        json!({
            "run_id": run.id,
            "run_scope": run.run_scope,
        }),
    )
    .await;
    Ok(Json(run))
}

async fn get_rms_charge_program_catalog(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RmsChargeProgramsQuery>,
) -> Result<Json<Vec<corecard::CoreCardProgramOption>>, CustomerError> {
    require_rms_charge_view_staff(&state, &headers).await?;
    let rows = corecard::list_program_catalog(&state.db, query.customer_id)
        .await
        .map_err(|error| CustomerError::BadRequest(error.to_string()))?;
    Ok(Json(rows))
}

async fn get_rms_charge_sync_health(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<corecard::CoreCardSyncHealthResponse>, CustomerError> {
    require_rms_charge_view_staff(&state, &headers).await?;
    let health = corecard::collect_sync_health(&state.db)
        .await
        .map_err(|error| CustomerError::BadRequest(error.to_string()))?;
    Ok(Json(health))
}

async fn list_rms_charge_records(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<RmsChargeRecordsQuery>,
) -> Result<Json<Vec<RmsChargeRecordApiRow>>, CustomerError> {
    require_staff_with_any_permission(
        &state,
        &headers,
        &[
            CUSTOMERS_RMS_CHARGE,
            CUSTOMERS_RMS_CHARGE_VIEW,
            CUSTOMERS_RMS_CHARGE_MANAGE_LINKS,
        ],
    )
    .await?;

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
    let account_filter = q
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let program_filter = q
        .program_code
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let posting_status_filter = q
        .posting_status
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

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
                    r.transaction_id,
                    r.register_session_id,
                    r.customer_id,
                    r.payment_method,
                    r.amount,
                    r.operator_staff_id,
                    r.payment_transaction_id,
                    r.customer_display,
                    r.order_short_ref,
                    r.tender_family,
                    r.program_code,
                    r.program_label,
                    r.masked_account,
                    r.linked_corecredit_customer_id,
                    r.linked_corecredit_account_id,
                    r.resolution_status,
                    COALESCE(r.posting_status, 'legacy') AS posting_status,
                    r.posting_error_code,
                    r.host_reference,
                    r.external_transaction_id,
                    NULLIF(TRIM(BOTH FROM CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), '') AS customer_name,
                    c.customer_code,
                    s.full_name AS operator_name
                FROM pos_rms_charge_record r
                LEFT JOIN customers c ON c.id = r.customer_id
                LEFT JOIN staff s ON s.id = r.operator_staff_id
                WHERE r.created_at >= $1 AND r.created_at < $2
                  AND ($3::text IS NULL OR r.record_kind = $3)
                  AND ($4::uuid IS NULL OR r.customer_id = $4)
                  AND ($5::text IS NULL OR r.linked_corecredit_account_id = $5)
                  AND ($6::text IS NULL OR r.program_code = $6)
                  AND ($7::text IS NULL OR COALESCE(r.posting_status, 'legacy') = $7)
                  AND (
                    c.id = ANY($8)
                    OR c.customer_code ILIKE $9 ESCAPE '\'
                    OR CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, '')) ILIKE $9 ESCAPE '\'
                    OR r.order_short_ref ILIKE $9 ESCAPE '\'
                    OR r.payment_method ILIKE $9 ESCAPE '\'
                  )
                ORDER BY r.created_at DESC
                LIMIT $10 OFFSET $11
                "#,
            )
            .bind(start_dt)
            .bind(end_exclusive)
            .bind(kind_filter)
            .bind(q.customer_id)
            .bind(account_filter)
            .bind(program_filter)
            .bind(posting_status_filter)
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
                    r.transaction_id,
                    r.register_session_id,
                    r.customer_id,
                    r.payment_method,
                    r.amount,
                    r.operator_staff_id,
                    r.payment_transaction_id,
                    r.customer_display,
                    r.order_short_ref,
                    r.tender_family,
                    r.program_code,
                    r.program_label,
                    r.masked_account,
                    r.linked_corecredit_customer_id,
                    r.linked_corecredit_account_id,
                    r.resolution_status,
                    COALESCE(r.posting_status, 'legacy') AS posting_status,
                    r.posting_error_code,
                    r.host_reference,
                    r.external_transaction_id,
                    NULLIF(TRIM(BOTH FROM CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), '') AS customer_name,
                    c.customer_code,
                    s.full_name AS operator_name
                FROM pos_rms_charge_record r
                LEFT JOIN customers c ON c.id = r.customer_id
                LEFT JOIN staff s ON s.id = r.operator_staff_id
                WHERE r.created_at >= $1 AND r.created_at < $2
                  AND ($3::text IS NULL OR r.record_kind = $3)
                  AND ($4::uuid IS NULL OR r.customer_id = $4)
                  AND ($5::text IS NULL OR r.linked_corecredit_account_id = $5)
                  AND ($6::text IS NULL OR r.program_code = $6)
                  AND ($7::text IS NULL OR COALESCE(r.posting_status, 'legacy') = $7)
                  AND (
                    c.customer_code ILIKE $8 ESCAPE '\'
                    OR CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, '')) ILIKE $8 ESCAPE '\'
                    OR r.order_short_ref ILIKE $8 ESCAPE '\'
                    OR r.payment_method ILIKE $8 ESCAPE '\'
                  )
                ORDER BY r.created_at DESC
                LIMIT $9 OFFSET $10
                "#,
            )
            .bind(start_dt)
            .bind(end_exclusive)
            .bind(kind_filter)
            .bind(q.customer_id)
            .bind(account_filter)
            .bind(program_filter)
            .bind(posting_status_filter)
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
                r.transaction_id,
                r.register_session_id,
                r.customer_id,
                r.payment_method,
                r.amount,
                r.operator_staff_id,
                r.payment_transaction_id,
                r.customer_display,
                r.order_short_ref,
                r.tender_family,
                r.program_code,
                r.program_label,
                r.masked_account,
                r.linked_corecredit_customer_id,
                r.linked_corecredit_account_id,
                r.resolution_status,
                COALESCE(r.posting_status, 'legacy') AS posting_status,
                r.posting_error_code,
                r.host_reference,
                r.external_transaction_id,
                NULLIF(TRIM(BOTH FROM CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), '') AS customer_name,
                c.customer_code,
                s.full_name AS operator_name
            FROM pos_rms_charge_record r
            LEFT JOIN customers c ON c.id = r.customer_id
            LEFT JOIN staff s ON s.id = r.operator_staff_id
            WHERE r.created_at >= $1 AND r.created_at < $2
              AND ($3::text IS NULL OR r.record_kind = $3)
              AND ($4::uuid IS NULL OR r.customer_id = $4)
              AND ($5::text IS NULL OR r.linked_corecredit_account_id = $5)
              AND ($6::text IS NULL OR r.program_code = $6)
              AND ($7::text IS NULL OR COALESCE(r.posting_status, 'legacy') = $7)
            ORDER BY r.created_at DESC
            LIMIT $8 OFFSET $9
            "#,
        )
        .bind(start_dt)
        .bind(end_exclusive)
        .bind(kind_filter)
        .bind(q.customer_id)
        .bind(account_filter)
        .bind(program_filter)
        .bind(posting_status_filter)
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
        .route("/address-suggestions", get(get_address_suggestions))
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
        .route("/pipeline-stats", get(browse_customer_pipeline_stats))
        .route("/podium/messaging-inbox", get(list_podium_messaging_inbox))
        .route(
            "/rms-charge/link-account",
            post(link_customer_rms_charge_account),
        )
        .route(
            "/rms-charge/unlink-account",
            post(unlink_customer_rms_charge_account),
        )
        .route(
            "/rms-charge/customer/{customer_id}/accounts",
            get(list_customer_rms_charge_accounts),
        )
        .route(
            "/rms-charge/accounts/{account_id}/balances",
            get(get_customer_rms_charge_account_balances),
        )
        .route(
            "/rms-charge/accounts/{account_id}/transactions",
            get(get_customer_rms_charge_account_transactions),
        )
        .route("/rms-charge/overview", get(get_rms_charge_overview))
        .route("/rms-charge/programs", get(get_rms_charge_program_catalog))
        .route("/rms-charge/exceptions", get(get_rms_charge_exceptions))
        .route(
            "/rms-charge/exceptions/{exception_id}/retry",
            post(retry_rms_charge_exception),
        )
        .route(
            "/rms-charge/exceptions/{exception_id}/resolve",
            post(resolve_rms_charge_exception),
        )
        .route(
            "/rms-charge/exceptions/{exception_id}/assign",
            post(assign_rms_charge_exception),
        )
        .route(
            "/rms-charge/reconciliation",
            get(get_rms_charge_reconciliation),
        )
        .route(
            "/rms-charge/reconciliation/run",
            post(run_rms_charge_reconciliation),
        )
        .route("/rms-charge/sync-health", get(get_rms_charge_sync_health))
        .route("/rms-charge/records", get(list_rms_charge_records))
        .route(
            "/rms-charge/records/{record_id}",
            get(get_rms_charge_record),
        )
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
            "/{customer_id}/transaction-history",
            get(get_customer_transaction_history),
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

    if let Some(c) = state.meilisearch.clone() {
        let pool = state.db.clone();
        tokio::spawn(async move {
            // Delete slave from Meilisearch
            if let Err(e) =
                crate::logic::meilisearch_sync::spawn_meilisearch_customer_delete(&c, slave_id)
                    .await
            {
                tracing::error!(error = %e, slave_id = %slave_id, "Meilisearch customer delete after merge failed");
            }
            // Upsert master to ensure latest metrics/status are reflected
            if let Err(e) = crate::logic::meilisearch_sync::spawn_meilisearch_customer_upsert(
                &c, &pool, master_id,
            )
            .await
            {
                tracing::error!(error = %e, master_id = %master_id, "Meilisearch customer upsert after merge failed");
            }
        });
    }

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
    let lifecycle_filter = normalize_customer_lifecycle_filter(query.lifecycle.as_deref());

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
            WITH browse_base AS (
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
                    COALESCE(ob.lifetime_sales, 0)::numeric(12, 2) AS lifetime_sales,
                    COALESCE(ob.open_orders_count, 0)::bigint AS open_orders_count,
                    COALESCE(ob.ready_for_pickup_count, 0)::bigint AS ready_for_pickup_count,
                    (
                        SELECT s.status::text
                        FROM shipment s
                        WHERE s.customer_id = c.id
                          AND s.status NOT IN ('delivered', 'cancelled')
                        ORDER BY s.created_at DESC
                        LIMIT 1
                    ) AS active_shipment_status,
                    (
                        SELECT MAX(ts)
                        FROM (
                            SELECT MAX(booked_at) AS ts FROM transactions WHERE customer_id = c.id
                            UNION ALL
                            SELECT MAX(created_at) FROM payment_transactions WHERE payer_id = c.id
                            UNION ALL
                            SELECT MAX(created_at) FROM measurements WHERE customer_id = c.id
                            UNION ALL
                            SELECT MAX(measured_at) FROM customer_measurements WHERE customer_id = c.id
                            UNION ALL
                            SELECT MAX(created_at) FROM customer_timeline_notes WHERE customer_id = c.id
                            UNION ALL
                            SELECT MAX(l.created_at)
                            FROM wedding_activity_log l
                            WHERE EXISTS (
                                SELECT 1
                                FROM wedding_members wm
                                WHERE wm.wedding_party_id = l.wedding_party_id
                                  AND wm.customer_id = c.id
                                  AND (
                                      l.wedding_member_id IS NULL
                                      OR l.wedding_member_id = wm.id
                                  )
                            )
                        ) activity
                    ) AS last_activity_at,
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
                    SELECT
                        SUM(balance_due) FILTER (WHERE status = 'open'::order_status) AS balance_sum,
                        SUM(total_price) FILTER (WHERE status = 'fulfilled'::order_status AND booked_at >= '2018-01-01') AS lifetime_sales,
                        COUNT(*) FILTER (WHERE status IN ('open'::order_status, 'pending_measurement'::order_status)) AS open_orders_count,
                        COUNT(*) FILTER (WHERE status::text = 'ready') AS ready_for_pickup_count
                    FROM transactions
                    WHERE customer_id = c.id
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
            ),
            browse_derived AS (
                SELECT
                    id,
                    customer_code,
                    first_name,
                    last_name,
                    company_name,
                    email,
                    phone,
                    is_vip,
                    open_balance_due,
                    lifetime_sales,
                    open_orders_count,
                    active_shipment_status,
                    wedding_soon,
                    wedding_active,
                    wedding_party_name,
                    wedding_party_id,
                    couple_id,
                    couple_primary_id,
                    CASE
                        WHEN active_shipment_status = 'exception' THEN 'issue'
                        WHEN ready_for_pickup_count > 0 THEN 'pickup'
                        WHEN open_orders_count > 0
                          OR wedding_active = TRUE
                          OR COALESCE(active_shipment_status, '') IN ('draft', 'quoted', 'label_purchased', 'in_transit') THEN 'pending'
                        WHEN lifetime_sales <= 0 AND last_activity_at IS NULL THEN 'new'
                        WHEN last_activity_at IS NOT NULL
                          AND last_activity_at >= (CURRENT_TIMESTAMP - ($12::bigint * INTERVAL '1 day')) THEN 'active'
                        WHEN lifetime_sales > 0 OR last_activity_at IS NOT NULL THEN 'completed'
                        ELSE 'new'
                    END AS lifecycle_state
                FROM browse_base
            )
            SELECT
                id,
                customer_code,
                first_name,
                last_name,
                company_name,
                email,
                phone,
                is_vip,
                open_balance_due,
                lifetime_sales,
                open_orders_count,
                active_shipment_status,
                wedding_soon,
                wedding_active,
                wedding_party_name,
                wedding_party_id,
                couple_id,
                couple_primary_id,
                lifecycle_state
            FROM browse_derived
            WHERE ($13::text IS NULL OR lifecycle_state = $13::text)
            ORDER BY array_position($9::uuid[], id)
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
        .bind(CUSTOMER_LIFECYCLE_ACTIVE_DAYS)
        .bind(lifecycle_filter)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, CustomerBrowseRow>(&format!(
            r#"
            WITH browse_base AS (
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
                    COALESCE(ob.lifetime_sales, 0)::numeric(12, 2) AS lifetime_sales,
                    COALESCE(ob.open_orders_count, 0)::bigint AS open_orders_count,
                    COALESCE(ob.ready_for_pickup_count, 0)::bigint AS ready_for_pickup_count,
                    (
                        SELECT s.status::text
                        FROM shipment s
                        WHERE s.customer_id = c.id
                          AND s.status NOT IN ('delivered', 'cancelled')
                        ORDER BY s.created_at DESC
                        LIMIT 1
                    ) AS active_shipment_status,
                    (
                        SELECT MAX(ts)
                        FROM (
                            SELECT MAX(booked_at) AS ts FROM transactions WHERE customer_id = c.id
                            UNION ALL
                            SELECT MAX(created_at) FROM payment_transactions WHERE payer_id = c.id
                            UNION ALL
                            SELECT MAX(created_at) FROM measurements WHERE customer_id = c.id
                            UNION ALL
                            SELECT MAX(measured_at) FROM customer_measurements WHERE customer_id = c.id
                            UNION ALL
                            SELECT MAX(created_at) FROM customer_timeline_notes WHERE customer_id = c.id
                            UNION ALL
                            SELECT MAX(l.created_at)
                            FROM wedding_activity_log l
                            WHERE EXISTS (
                                SELECT 1
                                FROM wedding_members wm
                                WHERE wm.wedding_party_id = l.wedding_party_id
                                  AND wm.customer_id = c.id
                                  AND (
                                      l.wedding_member_id IS NULL
                                      OR l.wedding_member_id = wm.id
                                  )
                            )
                        ) activity
                    ) AS last_activity_at,
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
                    SELECT
                        SUM(balance_due) FILTER (WHERE status = 'open'::order_status) AS balance_sum,
                        SUM(total_price) FILTER (WHERE status = 'fulfilled'::order_status AND booked_at >= '2018-01-01') AS lifetime_sales,
                        COUNT(*) FILTER (WHERE status IN ('open'::order_status, 'pending_measurement'::order_status)) AS open_orders_count,
                        COUNT(*) FILTER (WHERE status::text = 'ready') AS ready_for_pickup_count
                    FROM transactions
                    WHERE customer_id = c.id
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
            ),
            browse_derived AS (
                SELECT
                    id,
                    customer_code,
                    first_name,
                    last_name,
                    company_name,
                    email,
                    phone,
                    is_vip,
                    open_balance_due,
                    lifetime_sales,
                    open_orders_count,
                    active_shipment_status,
                    wedding_soon,
                    wedding_active,
                    wedding_party_name,
                    wedding_party_id,
                    couple_id,
                    couple_primary_id,
                    CASE
                        WHEN active_shipment_status = 'exception' THEN 'issue'
                        WHEN ready_for_pickup_count > 0 THEN 'pickup'
                        WHEN open_orders_count > 0
                          OR wedding_active = TRUE
                          OR COALESCE(active_shipment_status, '') IN ('draft', 'quoted', 'label_purchased', 'in_transit') THEN 'pending'
                        WHEN lifetime_sales <= 0 AND last_activity_at IS NULL THEN 'new'
                        WHEN last_activity_at IS NOT NULL
                          AND last_activity_at >= (CURRENT_TIMESTAMP - ($10::bigint * INTERVAL '1 day')) THEN 'active'
                        WHEN lifetime_sales > 0 OR last_activity_at IS NOT NULL THEN 'completed'
                        ELSE 'new'
                    END AS lifecycle_state
                FROM browse_base
            )
            SELECT
                id,
                customer_code,
                first_name,
                last_name,
                company_name,
                email,
                phone,
                is_vip,
                open_balance_due,
                lifetime_sales,
                open_orders_count,
                active_shipment_status,
                wedding_soon,
                wedding_active,
                wedding_party_name,
                wedding_party_id,
                couple_id,
                couple_primary_id,
                lifecycle_state
            FROM browse_derived
            WHERE ($11::text IS NULL OR lifecycle_state = $11::text)
            ORDER BY last_name ASC, first_name ASC
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
        .bind(CUSTOMER_LIFECYCLE_ACTIVE_DAYS)
        .bind(lifecycle_filter)
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

async fn browse_customer_pipeline_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<CustomerPipelineStats>, CustomerError> {
    require_customer_access(&state, &headers).await?;

    let stats = sqlx::query!(
        r#"
        SELECT
            COUNT(*)::bigint AS total_customers,
            COUNT(*) FILTER (WHERE is_vip = TRUE)::bigint AS vip_customers,
            (
                SELECT COUNT(DISTINCT customer_id)::bigint
                FROM transactions
                WHERE status = 'open' AND balance_due > 0
            ) AS with_balance,
            (
                SELECT COUNT(DISTINCT wm.customer_id)::bigint
                FROM wedding_members wm
                JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                WHERE (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                  AND wp.event_date >= CURRENT_DATE
                  AND wp.event_date <= CURRENT_DATE + INTERVAL '30 days'
            ) AS upcoming_weddings
        FROM customers
        "#
    )
    .fetch_one(&state.db)
    .await?;

    Ok(Json(CustomerPipelineStats {
        total_customers: stats.total_customers.unwrap_or(0),
        vip_customers: stats.vip_customers.unwrap_or(0),
        with_balance: stats.with_balance.unwrap_or(0),
        upcoming_weddings: stats.upcoming_weddings.unwrap_or(0),
    }))
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
            wm.transaction_id,
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
    let lifecycle = load_customer_lifecycle_signals(&state.db, customer_id)
        .await
        .map_err(CustomerError::Database)?;

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
            lifecycle_state: derive_customer_lifecycle(&lifecycle),
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
            FROM transactions o
            LEFT JOIN transaction_lines oi ON oi.transaction_id = o.id
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
            FROM transactions o
            LEFT JOIN transaction_lines oi ON oi.transaction_id = o.id
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
        events.push(CustomerTimelineEvent {
            at: o.booked_at,
            kind: "sale".to_string(),
            summary: format!("Purchased {} (Order {})", items, short_order_ref(o.id)),
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
                "Payment recorded: {} via {} ({})",
                p.amount, p.payment_method, p.category
            ),
            reference_id: Some(p.id),
            reference_type: Some("payment".to_string()),
            wedding_party_id: None,
        });
    }

    for w in wedding_logs {
        let desc = w.description.trim();
        let summary = if desc.is_empty() {
            format!("Wedding party {} — {}", w.party_name, w.action_type)
        } else {
            format!("Wedding party {} — {}", w.party_name, desc)
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
            summary: n.body,
            reference_id: Some(n.id),
            reference_type: Some("note".to_string()),
            wedding_party_id: None,
        });
    }

    for m in meas {
        events.push(CustomerTimelineEvent {
            at: m.created_at,
            kind: "measurement".to_string(),
            summary: "Body measurements recorded".to_string(),
            reference_id: Some(m.id),
            reference_type: Some("measurement".to_string()),
            wedding_party_id: None,
        });
    }

    for a in appts {
        events.push(CustomerTimelineEvent {
            at: a.datetime,
            kind: "appointment".to_string(),
            summary: format!("Scheduled {} appointment", a.appt_type),
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
                "Shipment {} — {}{}",
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

async fn get_customer_transaction_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Query(q): Query<CustomerTransactionHistoryQuery>,
) -> Result<Json<CustomerTransactionHistoryResponse>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, ORDERS_VIEW).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let body = query_customer_transaction_history(&state.db, customer_id, &q)
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
