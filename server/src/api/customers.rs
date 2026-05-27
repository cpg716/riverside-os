//! Customer search, profile, marketing flags, and wedding memberships.

use axum::{
    body::Bytes,
    extract::{Multipart, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
use crate::logic::customer_duplicate_candidates::{
    find_duplicate_candidates, DuplicateCandidateParams,
};
use crate::logic::customer_hub::{
    days_since_last_visit, fetch_customer_snapshot_items, fetch_hub_stats, CustomerSnapshotContext,
    CustomerSnapshotItem,
};
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
use crate::logic::email as store_email;
use crate::logic::integration_credentials;
use crate::logic::lightspeed_customers::{
    execute_lightspeed_customer_import, LightspeedCustomerImportPayload,
    LightspeedCustomerImportSummary,
};
use crate::logic::podium;
use crate::logic::podium_messaging;
use crate::logic::shippo::{self, ShippoAddressFields};

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
use std::collections::HashSet;

const CUSTOMER_MESSAGE_ATTACHMENT_MAX_BYTES: usize = 5 * 1024 * 1024;

const RMS_CHARGE_REPORT_TO_R2S: &str = "rms_charge.report_to_r2s";
const RMS_ACCOUNT_LIST_PREVIEW_MAX_BYTES: usize = 10 * 1024 * 1024;
const RMS_R2S_REPORTING_ACTIVATION_CUTOFF_RFC3339: &str = "2026-05-06T18:00:00Z";

fn rms_r2s_reporting_activation_cutoff() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(RMS_R2S_REPORTING_ACTIVATION_CUTOFF_RFC3339)
        .expect("valid RMS R2S reporting activation cutoff")
        .with_timezone(&Utc)
}

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
    ExternalUnavailable(String),
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
            CustomerError::ExternalUnavailable(m) => (StatusCode::BAD_GATEWAY, m),
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

impl From<crate::logic::rms_account_list_import::AccountListPreviewError> for CustomerError {
    fn from(err: crate::logic::rms_account_list_import::AccountListPreviewError) -> Self {
        CustomerError::BadRequest(err.to_string())
    }
}

const CUSTOMER_LIFECYCLE_ACTIVE_DAYS: i64 = 90;
const ADDRESS_LOOKUP_MIN_QUERY_LEN: usize = 4;
const ADDRESS_LOOKUP_MAX_RESULTS: usize = 5;
const ADDRESS_LOOKUP_PROVIDER_LIMIT: usize = 10;
const ADDRESS_LOOKUP_RADIUS_METERS: &str = "120000";
const ADDRESS_LOOKUP_STORE_LAT: &str = "42.9056";
const ADDRESS_LOOKUP_STORE_LON: &str = "-78.7048";
const GEOAPIFY_ADDRESS_LOOKUP_URL: &str = "https://api.geoapify.com/v1/geocode/autocomplete";
const ADDRESS_LOOKUP_USER_AGENT: &str = "RiversideOS/0.2.1 customer-address-autocomplete";

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
    #[serde(skip_serializing_if = "Option::is_none")]
    country: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shippo_validated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_postal_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    postal_code_corrected: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct AddressValidationBody {
    address_line1: String,
    #[serde(default)]
    address_line2: Option<String>,
    city: String,
    state: String,
    postal_code: String,
    #[serde(default)]
    country: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    company: Option<String>,
    #[serde(default)]
    phone: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    is_residential: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct GeoapifyAutocompleteResponse {
    #[serde(default)]
    results: Vec<GeoapifyAddressResult>,
}

#[derive(Debug, Deserialize)]
struct GeoapifyAddressResult {
    #[serde(default)]
    place_id: Option<String>,
    #[serde(default)]
    formatted: Option<String>,
    #[serde(default)]
    address_line1: Option<String>,
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    county: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    state_code: Option<String>,
    #[serde(default)]
    postcode: Option<String>,
    #[serde(default)]
    country_code: Option<String>,
    #[serde(default)]
    result_type: Option<String>,
    #[serde(default)]
    housenumber: Option<String>,
    #[serde(default)]
    street: Option<String>,
    #[serde(default)]
    distance: Option<f64>,
    #[serde(default)]
    rank: Option<GeoapifyRank>,
}

#[derive(Debug, Deserialize)]
struct GeoapifyRank {
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    confidence_street_level: Option<f64>,
    #[serde(default)]
    confidence_city_level: Option<f64>,
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

fn normalize_us_state(value: &str) -> String {
    match value.trim().to_ascii_uppercase().as_str() {
        "ALABAMA" | "AL" => "AL",
        "ALASKA" | "AK" => "AK",
        "ARIZONA" | "AZ" => "AZ",
        "ARKANSAS" | "AR" => "AR",
        "CALIFORNIA" | "CA" => "CA",
        "COLORADO" | "CO" => "CO",
        "CONNECTICUT" | "CT" => "CT",
        "DELAWARE" | "DE" => "DE",
        "DISTRICT OF COLUMBIA" | "DC" => "DC",
        "FLORIDA" | "FL" => "FL",
        "GEORGIA" | "GA" => "GA",
        "HAWAII" | "HI" => "HI",
        "IDAHO" | "ID" => "ID",
        "ILLINOIS" | "IL" => "IL",
        "INDIANA" | "IN" => "IN",
        "IOWA" | "IA" => "IA",
        "KANSAS" | "KS" => "KS",
        "KENTUCKY" | "KY" => "KY",
        "LOUISIANA" | "LA" => "LA",
        "MAINE" | "ME" => "ME",
        "MARYLAND" | "MD" => "MD",
        "MASSACHUSETTS" | "MA" => "MA",
        "MICHIGAN" | "MI" => "MI",
        "MINNESOTA" | "MN" => "MN",
        "MISSISSIPPI" | "MS" => "MS",
        "MISSOURI" | "MO" => "MO",
        "MONTANA" | "MT" => "MT",
        "NEBRASKA" | "NE" => "NE",
        "NEVADA" | "NV" => "NV",
        "NEW HAMPSHIRE" | "NH" => "NH",
        "NEW JERSEY" | "NJ" => "NJ",
        "NEW MEXICO" | "NM" => "NM",
        "NEW YORK" | "NY" => "NY",
        "NORTH CAROLINA" | "NC" => "NC",
        "NORTH DAKOTA" | "ND" => "ND",
        "OHIO" | "OH" => "OH",
        "OKLAHOMA" | "OK" => "OK",
        "OREGON" | "OR" => "OR",
        "PENNSYLVANIA" | "PA" => "PA",
        "RHODE ISLAND" | "RI" => "RI",
        "SOUTH CAROLINA" | "SC" => "SC",
        "SOUTH DAKOTA" | "SD" => "SD",
        "TENNESSEE" | "TN" => "TN",
        "TEXAS" | "TX" => "TX",
        "UTAH" | "UT" => "UT",
        "VERMONT" | "VT" => "VT",
        "VIRGINIA" | "VA" => "VA",
        "WASHINGTON" | "WA" => "WA",
        "WEST VIRGINIA" | "WV" => "WV",
        "WISCONSIN" | "WI" => "WI",
        "WYOMING" | "WY" => "WY",
        other => other,
    }
    .to_string()
}

async fn geoapify_api_key_from_settings(
    pool: &sqlx::PgPool,
) -> Result<Option<String>, CustomerError> {
    let values =
        integration_credentials::load_integration_credentials(pool, "geoapify", &["api_key"])
            .await
            .map_err(|error| {
                tracing::error!(error = %error, "Geoapify credential lookup failed");
                CustomerError::ExternalUnavailable(
                    "Geoapify address lookup settings could not be read.".to_string(),
                )
            })?;
    Ok(values
        .get("api_key")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()))
}

struct ScoredAddressSuggestion {
    score: i32,
    suggestion: AddressSuggestion,
}

fn leading_house_number(query: &str) -> Option<String> {
    let digits: String = query
        .trim_start()
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        None
    } else {
        Some(digits)
    }
}

fn postal_code_in_query(query: &str) -> Option<String> {
    query
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .find(|part| part.len() == 5 && part.chars().all(|ch| ch.is_ascii_digit()))
        .map(str::to_string)
}

fn geoapify_local_score(result: &GeoapifyAddressResult, query: &str) -> i32 {
    let mut score = 0;
    let state = result
        .state_code
        .as_deref()
        .or(result.state.as_deref())
        .map(normalize_us_state)
        .unwrap_or_default();
    if state == "NY" {
        score += 40;
    } else {
        score -= 30;
    }

    let result_type = result.result_type.as_deref().unwrap_or_default();
    match result_type {
        "building" | "amenity" => score += 45,
        "street" => score -= 25,
        "postcode" | "city" | "county" | "state" | "country" => score -= 80,
        _ => {}
    }

    let expected_house_number = leading_house_number(query);
    let result_house_number = result.housenumber.as_deref().map(str::trim);
    match (expected_house_number.as_deref(), result_house_number) {
        (Some(expected), Some(actual)) if actual == expected => score += 80,
        (Some(_), Some(_)) => score += 15,
        (Some(_), None) => score -= 70,
        (None, Some(_)) => score += 20,
        (None, None) => {}
    }
    if result
        .street
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        score += 10;
    }

    if let Some(expected_postal) = postal_code_in_query(query) {
        if result.postcode.as_deref().map(str::trim) == Some(expected_postal.as_str()) {
            score += 80;
        } else {
            score -= 60;
        }
    }

    if let Some(county) = result
        .county
        .as_deref()
        .map(|value| value.to_ascii_lowercase())
    {
        if ["erie", "genesee", "niagara", "wyoming", "orleans", "monroe"]
            .iter()
            .any(|local| county.contains(local))
        {
            score += 15;
        }
    }

    if let Some(distance) = result.distance {
        if distance <= 30_000.0 {
            score += 20;
        } else if distance <= 80_000.0 {
            score += 10;
        } else {
            score -= 15;
        }
    }

    if let Some(rank) = result.rank.as_ref() {
        let confidence = rank
            .confidence
            .or(rank.confidence_street_level)
            .or(rank.confidence_city_level)
            .unwrap_or(0.0);
        score += (confidence.clamp(0.0, 1.0) * 25.0).round() as i32;
    }

    score
}

fn map_geoapify_result(
    result: GeoapifyAddressResult,
    index: usize,
    query: &str,
) -> Option<ScoredAddressSuggestion> {
    if !matches!(result.country_code.as_deref(), Some(code) if code.eq_ignore_ascii_case("US")) {
        return None;
    }
    let address_line1 = result
        .address_line1
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let city = result
        .city
        .as_deref()
        .or(result.county.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let state = result
        .state_code
        .as_deref()
        .or(result.state.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let postal_code = result
        .postcode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let result_type = result.result_type.as_deref().unwrap_or_default();
    if matches!(
        result_type,
        "postcode" | "city" | "county" | "state" | "country"
    ) {
        return None;
    }
    let address_line1 = title_case_address(address_line1);
    let city = title_case_address(city);
    let state = normalize_us_state(state);
    let score = geoapify_local_score(&result, query);
    let label = result
        .formatted
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{address_line1}, {city}, {state} {postal_code}"));

    Some(ScoredAddressSuggestion {
        score,
        suggestion: AddressSuggestion {
            id: result
                .place_id
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| format!("geoapify-{index}")),
            label,
            address_line1,
            city,
            state,
            postal_code: postal_code.to_string(),
            country: Some("US".to_string()),
            source: result
                .result_type
                .map(|value| format!("geoapify:{value}"))
                .or_else(|| Some("geoapify".to_string())),
            shippo_validated: None,
            source_postal_code: None,
            postal_code_corrected: None,
        },
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
            RMS_CHARGE_REPORT_TO_R2S,
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

async fn require_rms_charge_report_staff(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<crate::auth::pins::AuthenticatedStaff, CustomerError> {
    require_staff_with_any_permission(
        state,
        headers,
        &[
            RMS_CHARGE_REPORT_TO_R2S,
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

#[derive(Debug, Clone)]
struct CustomerMessageActor {
    staff_id: Option<Uuid>,
    sender_name: Option<String>,
}

async fn customer_message_actor_from_perm_or_pos(
    state: &AppState,
    headers: &HeaderMap,
    permission: &str,
) -> Result<CustomerMessageActor, CustomerError> {
    match middleware::require_staff_perm_or_pos_session(state, headers, permission)
        .await
        .map_err(map_perm_or_pos_err)?
    {
        middleware::StaffOrPosSession::Staff(s) => Ok(CustomerMessageActor {
            staff_id: Some(s.id),
            sender_name: Some(s.full_name),
        }),
        middleware::StaffOrPosSession::PosSession { session_id } => {
            let row: Option<(Uuid, String)> = sqlx::query_as(
                r#"
                SELECT s.id, s.full_name
                FROM register_sessions rs
                JOIN staff s ON s.id = COALESCE(rs.shift_primary_staff_id, rs.opened_by)
                WHERE rs.id = $1
                  AND rs.is_open = true
                "#,
            )
            .bind(session_id)
            .fetch_optional(&state.db)
            .await?;
            Ok(match row {
                Some((id, full_name)) => CustomerMessageActor {
                    staff_id: Some(id),
                    sender_name: Some(full_name),
                },
                None => CustomerMessageActor {
                    staff_id: None,
                    sender_name: None,
                },
            })
        }
    }
}

async fn staff_email_signature(
    pool: &sqlx::PgPool,
    staff_id: Option<Uuid>,
) -> Result<Option<String>, sqlx::Error> {
    let Some(staff_id) = staff_id else {
        return Ok(None);
    };
    sqlx::query_scalar("SELECT email_signature FROM staff WHERE id = $1")
        .bind(staff_id)
        .fetch_optional(pool)
        .await
        .map(|value: Option<Option<String>>| value.flatten())
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
    pub profile_discount_percent: Decimal,
    pub tax_exempt: bool,
    pub tax_exempt_id: Option<String>,
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
    #[serde(default)]
    pub review_requests_opt_out: Option<bool>,
    pub is_vip: Option<bool>,
    pub profile_discount_percent: Option<Decimal>,
    pub tax_exempt: Option<bool>,
    pub tax_exempt_id: Option<String>,
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
    pub review_requests_opt_out: bool,
    pub is_vip: bool,
    pub profile_discount_percent: Decimal,
    pub tax_exempt: bool,
    pub tax_exempt_id: Option<String>,
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
    let has_review_opt_out: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'customers'
              AND column_name = 'review_requests_opt_out'
        )
        "#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or(false);

    let review_opt_out_expr = if has_review_opt_out {
        "c.review_requests_opt_out"
    } else {
        "false AS review_requests_opt_out"
    };

    let sql = format!(
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
            c.transactional_email_opt_in, c.podium_conversation_url, {review_opt_out_expr},
            c.is_vip, c.profile_discount_percent, c.tax_exempt, c.tax_exempt_id,
            c.loyalty_points, c.customer_created_source,
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
        "#
    );

    let row = sqlx::query_as::<_, CustomerProfileRow>(&sql)
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
    pub customer_code: String,
    pub first_name: String,
    pub last_name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub couple_id: Option<Uuid>,
    pub couple_primary_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct CustomerHubResponse {
    #[serde(flatten)]
    pub customer: CustomerProfileRow,
    pub profile_complete: bool,
    pub weddings: Vec<WeddingMembershipRow>,
    pub stats: CustomerHubStats,
    pub partner: Option<CoupleMemberPreview>,
    pub snapshot_items: Vec<CustomerSnapshotItem>,
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
    pub profile_discount_percent: Decimal,
    pub tax_exempt: bool,
    pub tax_exempt_id: Option<String>,
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
    postal_code: Option<String>,
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
        DuplicateCandidateParams {
            email: q.email.as_deref(),
            phone: q.phone.as_deref(),
            first_name: q.first_name.as_deref(),
            last_name: q.last_name.as_deref(),
            postal_code: q.postal_code.as_deref(),
            exclude_customer_id: q.exclude_customer_id,
            limit: q.limit,
        },
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

    let api_key = geoapify_api_key_from_settings(&state.db)
        .await?
        .ok_or_else(|| {
            CustomerError::ExternalUnavailable(
                "Geoapify address lookup is not configured.".to_string(),
            )
        })?;
    let limit = ADDRESS_LOOKUP_PROVIDER_LIMIT.to_string();
    let bias = format!("proximity:{ADDRESS_LOOKUP_STORE_LON},{ADDRESS_LOOKUP_STORE_LAT}");
    let filter = format!(
        "circle:{ADDRESS_LOOKUP_STORE_LON},{ADDRESS_LOOKUP_STORE_LAT},{ADDRESS_LOOKUP_RADIUS_METERS}|countrycode:us"
    );
    let res = state
        .http_client
        .get(GEOAPIFY_ADDRESS_LOOKUP_URL)
        .header(reqwest::header::USER_AGENT, ADDRESS_LOOKUP_USER_AGENT)
        .query(&[
            ("text", query),
            ("limit", limit.as_str()),
            ("lang", "en"),
            ("format", "json"),
            ("filter", filter.as_str()),
            ("bias", bias.as_str()),
            ("apiKey", api_key.as_str()),
        ])
        .send()
        .await;

    let Ok(res) = res else {
        tracing::warn!("customer Geoapify address lookup request failed");
        return Err(CustomerError::ExternalUnavailable(
            "Address lookup is temporarily unavailable.".to_string(),
        ));
    };
    if !res.status().is_success() {
        tracing::warn!(
            status = %res.status(),
            "customer Geoapify address lookup returned non-success status"
        );
        return Err(CustomerError::ExternalUnavailable(
            "Address lookup is temporarily unavailable.".to_string(),
        ));
    }

    let body = res.json::<GeoapifyAutocompleteResponse>().await;
    let Ok(body) = body else {
        tracing::warn!("customer Geoapify address lookup response was not valid JSON");
        return Err(CustomerError::ExternalUnavailable(
            "Address lookup returned an unreadable response.".to_string(),
        ));
    };

    let mut seen = HashSet::new();
    let mut suggestions = body
        .results
        .into_iter()
        .enumerate()
        .filter_map(|(index, result)| map_geoapify_result(result, index, query))
        .filter(|scored| {
            let key = format!(
                "{}|{}|{}|{}",
                scored.suggestion.address_line1.to_ascii_lowercase(),
                scored.suggestion.city.to_ascii_lowercase(),
                scored.suggestion.state.to_ascii_uppercase(),
                scored.suggestion.postal_code
            );
            seen.insert(key)
        })
        .collect::<Vec<_>>();
    suggestions.sort_by(|a, b| b.score.cmp(&a.score));
    let suggestions = suggestions
        .into_iter()
        .map(|scored| scored.suggestion)
        .take(ADDRESS_LOOKUP_MAX_RESULTS)
        .collect();

    Ok(Json(suggestions))
}

async fn post_address_validation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AddressValidationBody>,
) -> Result<Json<AddressSuggestion>, CustomerError> {
    require_customer_access(&state, &headers).await?;
    let address_line1 = body.address_line1.trim();
    let city = body.city.trim();
    let state_code = body.state.trim();
    let postal_code = body.postal_code.trim();
    if address_line1.is_empty()
        || city.is_empty()
        || state_code.is_empty()
        || postal_code.is_empty()
    {
        return Err(CustomerError::BadRequest(
            "Street, city, state, and ZIP are required.".to_string(),
        ));
    }

    let input = ShippoAddressFields {
        name: body
            .name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Riverside customer")
            .to_string(),
        company: body
            .company
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        street1: address_line1.to_string(),
        street2: body
            .address_line2
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        city: city.to_string(),
        state: normalize_us_state(state_code),
        zip: postal_code.to_string(),
        country: body
            .country
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("US")
            .to_uppercase(),
        phone: body
            .phone
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("")
            .to_string(),
        email: body
            .email
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        is_residential: body.is_residential,
    };

    let validated = shippo::validate_address(&state.http_client, &input)
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, "Shippo address validation failed");
            CustomerError::ExternalUnavailable(
                "Shippo could not validate that address.".to_string(),
            )
        })?;
    if validated.is_complete == Some(false) {
        return Err(CustomerError::BadRequest(
            "Shippo could not confirm that address is complete.".to_string(),
        ));
    }

    let normalized = validated.normalized;
    let address_line1 = title_case_address(&normalized.street1);
    let city = title_case_address(&normalized.city);
    let state = normalize_us_state(&normalized.state);
    let source_postal_code = postal_code.to_string();
    let normalized_postal_code = normalized.zip.trim().to_string();
    let postal_code_corrected = !source_postal_code.eq_ignore_ascii_case(&normalized_postal_code);
    let label = format!("{address_line1}, {city}, {state} {normalized_postal_code}");

    Ok(Json(AddressSuggestion {
        id: validated.object_id.unwrap_or_else(|| label.clone()),
        label,
        address_line1,
        city,
        state,
        postal_code: normalized_postal_code,
        country: Some(normalized.country),
        source: Some(if postal_code_corrected {
            "shippo:postal_corrected".to_string()
        } else {
            "shippo".to_string()
        }),
        shippo_validated: Some(true),
        source_postal_code: Some(source_postal_code).filter(|_| postal_code_corrected),
        postal_code_corrected: Some(postal_code_corrected).filter(|value| *value),
    }))
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
    r2s_report_status: Option<String>,
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

#[derive(Debug, Serialize, FromRow)]
struct RmsReconciliationItemRow {
    id: Uuid,
    severity: String,
    status: String,
    mismatch_type: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
struct RmsReconciliationRunRow {
    status: String,
    started_at: DateTime<Utc>,
    completed_at: Option<DateTime<Utc>>,
    summary_json: Value,
}

#[derive(Debug, Serialize)]
struct RmsReconciliationResponse {
    items: Vec<RmsReconciliationItemRow>,
    runs: Vec<RmsReconciliationRunRow>,
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

#[derive(Debug, Deserialize)]
struct RmsChargeMarkReportedBody {
    #[serde(default)]
    note: Option<String>,
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
    source_mode: String,
    r2s_reporting_required: bool,
    r2s_report_status: String,
    r2s_report_due_at: DateTime<Utc>,
    r2s_reported_at: Option<DateTime<Utc>>,
    r2s_reported_by_staff_id: Option<Uuid>,
    r2s_reported_by_name: Option<String>,
    r2s_report_note: Option<String>,
    customer_name: Option<String>,
    customer_code: Option<String>,
    operator_name: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct RmsChargeRecordDetail {
    pub id: Uuid,
    pub record_kind: String,
    pub created_at: DateTime<Utc>,
    pub transaction_id: Uuid,
    pub register_session_id: Uuid,
    pub customer_id: Option<Uuid>,
    pub payment_method: String,
    pub amount: Decimal,
    pub operator_staff_id: Option<Uuid>,
    pub payment_transaction_id: Option<Uuid>,
    pub customer_display: Option<String>,
    pub order_short_ref: Option<String>,
    pub tender_family: Option<String>,
    pub program_code: Option<String>,
    pub program_label: Option<String>,
    pub masked_account: Option<String>,
    pub linked_corecredit_customer_id: Option<String>,
    pub linked_corecredit_account_id: Option<String>,
    pub resolution_status: Option<String>,
    pub external_transaction_id: Option<String>,
    pub external_auth_code: Option<String>,
    pub posting_status: String,
    pub posting_error_code: Option<String>,
    pub posting_error_message: Option<String>,
    pub posted_at: Option<DateTime<Utc>>,
    pub reversed_at: Option<DateTime<Utc>>,
    pub refunded_at: Option<DateTime<Utc>>,
    pub idempotency_key: Option<String>,
    pub external_transaction_type: Option<String>,
    pub host_reference: Option<String>,
    pub source_mode: String,
    pub r2s_reporting_required: bool,
    pub r2s_report_status: String,
    pub r2s_report_due_at: DateTime<Utc>,
    pub r2s_reported_at: Option<DateTime<Utc>>,
    pub r2s_reported_by_staff_id: Option<Uuid>,
    pub r2s_reported_by_name: Option<String>,
    pub r2s_report_note: Option<String>,
    pub metadata_json: Value,
    pub host_metadata_json: Value,
    pub request_snapshot_json: Value,
    pub response_snapshot_json: Value,
    pub customer_name: Option<String>,
    pub customer_code: Option<String>,
    pub operator_name: Option<String>,
}

async fn fetch_rms_charge_record_detail(
    db: &sqlx::PgPool,
    record_id: Uuid,
    r2s_cutoff: DateTime<Utc>,
) -> Result<RmsChargeRecordDetail, CustomerError> {
    let row = sqlx::query_as::<_, RmsChargeRecordDetail>(
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
            r.external_transaction_id,
            r.external_auth_code,
            r.posting_status,
            r.posting_error_code,
            r.posting_error_message,
            r.posted_at,
            r.reversed_at,
            r.refunded_at,
            r.idempotency_key,
            r.external_transaction_type,
            r.host_reference,
            COALESCE(
                r.metadata_json->>'rms_charge_source',
                r.metadata_json->>'source_mode',
                CASE
                    WHEN r.external_transaction_id IS NOT NULL OR r.host_reference IS NOT NULL THEN 'corecard_live'
                    ELSE 'manual'
                END
            ) AS source_mode,
            r2s.reporting_required AS r2s_reporting_required,
            r2s.report_status AS r2s_report_status,
            r2s.due_at AS r2s_report_due_at,
            (NULLIF(r.metadata_json->>'r2s_reported_at', ''))::timestamptz AS r2s_reported_at,
            CASE
                WHEN (r.metadata_json->>'r2s_reported_by_staff_id') ~* '^[0-9a-f-]{36}$'
                THEN (r.metadata_json->>'r2s_reported_by_staff_id')::uuid
                ELSE NULL
            END AS r2s_reported_by_staff_id,
            rs.full_name AS r2s_reported_by_name,
            NULLIF(r.metadata_json->>'r2s_report_note', '') AS r2s_report_note,
            r.metadata_json,
            r.host_metadata_json,
            r.request_snapshot_json,
            r.response_snapshot_json,
            NULLIF(TRIM(BOTH FROM CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), '') AS customer_name,
            c.customer_code,
            s.full_name AS operator_name
        FROM pos_rms_charge_record r
        LEFT JOIN customers c ON c.id = r.customer_id
        LEFT JOIN staff s ON s.id = r.operator_staff_id
        LEFT JOIN staff rs ON rs.id = CASE
            WHEN (r.metadata_json->>'r2s_reported_by_staff_id') ~* '^[0-9a-f-]{36}$'
            THEN (r.metadata_json->>'r2s_reported_by_staff_id')::uuid
            ELSE NULL
        END
        CROSS JOIN LATERAL (
            SELECT
                (
                    lower(COALESCE(NULLIF(r.metadata_json->>'r2s_reporting_required', ''), 'false')) = 'true'
                    OR r.metadata_json ? 'r2s_report_status'
                    OR r.created_at >= $2
                ) AS reporting_required,
                CASE
                    WHEN (
                        lower(COALESCE(NULLIF(r.metadata_json->>'r2s_reporting_required', ''), 'false')) = 'true'
                        OR r.metadata_json ? 'r2s_report_status'
                        OR r.created_at >= $2
                    )
                    THEN COALESCE(NULLIF(r.metadata_json->>'r2s_report_status', ''), 'unreported')
                    ELSE 'not_required'
                END AS report_status,
                CASE
                    WHEN (
                        lower(COALESCE(NULLIF(r.metadata_json->>'r2s_reporting_required', ''), 'false')) = 'true'
                        OR r.metadata_json ? 'r2s_report_status'
                        OR r.created_at >= $2
                    )
                    THEN COALESCE((NULLIF(r.metadata_json->>'r2s_report_due_at', ''))::timestamptz, r.created_at + interval '1 day')
                    ELSE r.created_at
                END AS due_at
        ) r2s
        WHERE r.id = $1
        "#,
    )
    .bind(record_id)
    .bind(r2s_cutoff)
    .fetch_optional(db)
    .await?
    .ok_or(CustomerError::NotFound)?;

    Ok(row)
}

async fn get_rms_charge_record(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(record_id): Path<Uuid>,
) -> Result<Json<RmsChargeRecordDetail>, CustomerError> {
    require_rms_charge_view_staff(&state, &headers).await?;
    let r2s_cutoff = rms_r2s_reporting_activation_cutoff();
    let row = fetch_rms_charge_record_detail(&state.db, record_id, r2s_cutoff).await?;
    Ok(Json(row))
}

async fn get_rms_charge_reconciliation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<RmsChargeReconciliationQuery>,
) -> Result<Json<RmsReconciliationResponse>, CustomerError> {
    require_rms_charge_reconcile_staff(&state, &headers).await?;

    let limit = q.limit.unwrap_or(10).clamp(1, 100);

    let items: Vec<RmsReconciliationItemRow> = sqlx::query_as::<_, RmsReconciliationItemRow>(
        r#"
        SELECT id, severity, status, mismatch_type, created_at
        FROM corecredit_reconciliation_item
        WHERE status != 'resolved'
        ORDER BY created_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    let runs: Vec<RmsReconciliationRunRow> = sqlx::query_as::<_, RmsReconciliationRunRow>(
        r#"
        SELECT status, started_at, completed_at, summary_json
        FROM corecredit_reconciliation_run
        ORDER BY started_at DESC
        LIMIT 5
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(RmsReconciliationResponse { items, runs }))
}

async fn mark_rms_charge_record_reported_to_r2s(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(record_id): Path<Uuid>,
    Json(body): Json<RmsChargeMarkReportedBody>,
) -> Result<Json<RmsChargeRecordDetail>, CustomerError> {
    let staff = require_rms_charge_report_staff(&state, &headers).await?;
    let existing: Option<Value> =
        sqlx::query_scalar("SELECT metadata_json FROM pos_rms_charge_record WHERE id = $1")
            .bind(record_id)
            .fetch_optional(&state.db)
            .await?;
    let Some(existing) = existing else {
        return Err(CustomerError::NotFound);
    };

    let now = Utc::now();
    let mut object = existing.as_object().cloned().unwrap_or_default();
    object.insert(
        "r2s_report_status".to_string(),
        Value::String("reported".to_string()),
    );
    object.insert(
        "r2s_reported_at".to_string(),
        Value::String(now.to_rfc3339()),
    );
    object.insert(
        "r2s_reported_by_staff_id".to_string(),
        Value::String(staff.id.to_string()),
    );
    if let Some(note) = body.note.map(|value| value.trim().to_string()) {
        if note.is_empty() {
            object.remove("r2s_report_note");
        } else {
            object.insert("r2s_report_note".to_string(), Value::String(note));
        }
    }
    let metadata = Value::Object(object);

    sqlx::query(
        r#"
        UPDATE pos_rms_charge_record
        SET metadata_json = $2
        WHERE id = $1
        "#,
    )
    .bind(record_id)
    .bind(&metadata)
    .execute(&state.db)
    .await?;

    let _ = crate::logic::notifications::delete_app_notification_by_dedupe(
        &state.db,
        &format!("rms_r2s_report:{record_id}"),
    )
    .await;

    let _ = crate::auth::pins::log_staff_access(
        &state.db,
        staff.id,
        "rms_charge_report_to_r2s",
        json!({
            "rms_record_id": record_id,
            "reported_at": now,
        }),
    )
    .await;

    let r2s_cutoff = rms_r2s_reporting_activation_cutoff();
    let row = fetch_rms_charge_record_detail(&state.db, record_id, r2s_cutoff).await?;
    Ok(Json(row))
}

async fn preview_rms_account_list_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<crate::logic::rms_account_list_import::AccountListPreviewResponse>, CustomerError>
{
    require_rms_charge_manage_staff(&state, &headers).await?;
    let mut file_bytes = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| CustomerError::BadRequest(format!("multipart error: {e}")))?
    {
        if field.name() == Some("file") {
            let bytes = field
                .bytes()
                .await
                .map_err(|e| CustomerError::BadRequest(format!("failed to read file bytes: {e}")))?
                .to_vec();
            file_bytes = Some(bytes);
            break;
        }
    }

    let bytes =
        file_bytes.ok_or_else(|| CustomerError::BadRequest("missing file field".to_string()))?;

    if bytes.len() > RMS_ACCOUNT_LIST_PREVIEW_MAX_BYTES {
        return Err(CustomerError::BadRequest(
            "file size exceeds limit".to_string(),
        ));
    }

    let preview = crate::logic::rms_account_list_import::preview_account_list_xlsx(&bytes)?;
    Ok(Json(preview))
}

async fn import_rms_account_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<crate::logic::rms_account_list_import::AccountListImportResponse>, CustomerError> {
    let staff = require_rms_charge_manage_staff(&state, &headers).await?;
    let mut file_bytes = None;
    let mut filename = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| CustomerError::BadRequest(format!("multipart error: {e}")))?
    {
        if field.name() == Some("file") {
            filename = field.file_name().map(|s| s.to_string());
            let bytes = field
                .bytes()
                .await
                .map_err(|e| CustomerError::BadRequest(format!("failed to read file bytes: {e}")))?
                .to_vec();
            file_bytes = Some(bytes);
            break;
        }
    }

    let bytes =
        file_bytes.ok_or_else(|| CustomerError::BadRequest("missing file field".to_string()))?;

    if bytes.len() > RMS_ACCOUNT_LIST_PREVIEW_MAX_BYTES {
        return Err(CustomerError::BadRequest(
            "file size exceeds limit".to_string(),
        ));
    }

    let response = crate::logic::rms_account_list_import::import_account_list_xlsx(
        &state.db,
        &bytes,
        filename.as_deref(),
        Some(staff.id),
    )
    .await?;

    Ok(Json(response))
}

async fn get_latest_rms_account_list_import(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<
    Json<crate::logic::rms_account_list_import::AccountListLatestImportResponse>,
    CustomerError,
> {
    require_rms_charge_view_staff(&state, &headers).await?;
    let response = crate::logic::rms_account_list_import::latest_account_list_import(&state.db)
        .await
        .map_err(CustomerError::Database)?;
    Ok(Json(response))
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
            CUSTOMERS_RMS_CHARGE_REPORTING,
            RMS_CHARGE_REPORT_TO_R2S,
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
    let r2s_report_status_filter = q
        .r2s_report_status
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(status) = r2s_report_status_filter {
        if !matches!(status, "all" | "unreported" | "reported" | "overdue") {
            return Err(CustomerError::BadRequest(
                "r2s_report_status must be all, unreported, reported, or overdue".to_string(),
            ));
        }
    }

    let q_trim = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let r2s_cutoff = rms_r2s_reporting_activation_cutoff();

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
                    COALESCE(
                        r.metadata_json->>'rms_charge_source',
                        r.metadata_json->>'source_mode',
                        CASE
                            WHEN r.external_transaction_id IS NOT NULL OR r.host_reference IS NOT NULL THEN 'corecard_live'
                            ELSE 'manual'
                        END
                    ) AS source_mode,
                    r2s.reporting_required AS r2s_reporting_required,
                    r2s.report_status AS r2s_report_status,
                    r2s.due_at AS r2s_report_due_at,
                    (NULLIF(r.metadata_json->>'r2s_reported_at', ''))::timestamptz AS r2s_reported_at,
                    CASE
                        WHEN (r.metadata_json->>'r2s_reported_by_staff_id') ~* '^[0-9a-f-]{36}$'
                        THEN (r.metadata_json->>'r2s_reported_by_staff_id')::uuid
                        ELSE NULL
                    END AS r2s_reported_by_staff_id,
                    rs.full_name AS r2s_reported_by_name,
                    NULLIF(r.metadata_json->>'r2s_report_note', '') AS r2s_report_note,
                    NULLIF(TRIM(BOTH FROM CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), '') AS customer_name,
                    c.customer_code,
                    s.full_name AS operator_name
                FROM pos_rms_charge_record r
                LEFT JOIN customers c ON c.id = r.customer_id
                LEFT JOIN staff s ON s.id = r.operator_staff_id
                LEFT JOIN staff rs ON rs.id = CASE
                    WHEN (r.metadata_json->>'r2s_reported_by_staff_id') ~* '^[0-9a-f-]{36}$'
                    THEN (r.metadata_json->>'r2s_reported_by_staff_id')::uuid
                    ELSE NULL
                END
                CROSS JOIN LATERAL (
                    SELECT
                        (
                            lower(COALESCE(NULLIF(r.metadata_json->>'r2s_reporting_required', ''), 'false')) = 'true'
                            OR r.metadata_json ? 'r2s_report_status'
                            OR r.created_at >= $13
                        ) AS reporting_required,
                        CASE
                            WHEN (
                                lower(COALESCE(NULLIF(r.metadata_json->>'r2s_reporting_required', ''), 'false')) = 'true'
                                OR r.metadata_json ? 'r2s_report_status'
                                OR r.created_at >= $13
                            )
                            THEN COALESCE(NULLIF(r.metadata_json->>'r2s_report_status', ''), 'unreported')
                            ELSE 'not_required'
                        END AS report_status,
                        CASE
                            WHEN (
                                lower(COALESCE(NULLIF(r.metadata_json->>'r2s_reporting_required', ''), 'false')) = 'true'
                                OR r.metadata_json ? 'r2s_report_status'
                                OR r.created_at >= $13
                            )
                            THEN COALESCE((NULLIF(r.metadata_json->>'r2s_report_due_at', ''))::timestamptz, r.created_at + interval '1 day')
                            ELSE r.created_at
                        END AS due_at
                ) r2s
                WHERE r.created_at >= $1 AND r.created_at < $2
                  AND ($3::text IS NULL OR r.record_kind = $3)
                  AND ($4::uuid IS NULL OR r.customer_id = $4)
                  AND ($5::text IS NULL OR r.linked_corecredit_account_id = $5)
                  AND ($6::text IS NULL OR r.program_code = $6)
                  AND ($7::text IS NULL OR COALESCE(r.posting_status, 'legacy') = $7)
                  AND (
                    $12::text IS NULL
                    OR $12::text = 'all'
                    OR (
                        $12::text = 'overdue'
                        AND r2s.reporting_required
                        AND r2s.report_status = 'unreported'
                        AND r2s.due_at < now()
                    )
                    OR (
                        $12::text <> 'overdue'
                        AND r2s.reporting_required
                        AND r2s.report_status = $12
                    )
                  )
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
            .bind(r2s_report_status_filter)
            .bind(r2s_cutoff)
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
                    COALESCE(
                        r.metadata_json->>'rms_charge_source',
                        r.metadata_json->>'source_mode',
                        CASE
                            WHEN r.external_transaction_id IS NOT NULL OR r.host_reference IS NOT NULL THEN 'corecard_live'
                            ELSE 'manual'
                        END
                    ) AS source_mode,
                    r2s.reporting_required AS r2s_reporting_required,
                    r2s.report_status AS r2s_report_status,
                    r2s.due_at AS r2s_report_due_at,
                    (NULLIF(r.metadata_json->>'r2s_reported_at', ''))::timestamptz AS r2s_reported_at,
                    CASE
                        WHEN (r.metadata_json->>'r2s_reported_by_staff_id') ~* '^[0-9a-f-]{36}$'
                        THEN (r.metadata_json->>'r2s_reported_by_staff_id')::uuid
                        ELSE NULL
                    END AS r2s_reported_by_staff_id,
                    rs.full_name AS r2s_reported_by_name,
                    NULLIF(r.metadata_json->>'r2s_report_note', '') AS r2s_report_note,
                    NULLIF(TRIM(BOTH FROM CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), '') AS customer_name,
                    c.customer_code,
                    s.full_name AS operator_name
                FROM pos_rms_charge_record r
                LEFT JOIN customers c ON c.id = r.customer_id
                LEFT JOIN staff s ON s.id = r.operator_staff_id
                LEFT JOIN staff rs ON rs.id = CASE
                    WHEN (r.metadata_json->>'r2s_reported_by_staff_id') ~* '^[0-9a-f-]{36}$'
                    THEN (r.metadata_json->>'r2s_reported_by_staff_id')::uuid
                    ELSE NULL
                END
                CROSS JOIN LATERAL (
                    SELECT
                        (
                            lower(COALESCE(NULLIF(r.metadata_json->>'r2s_reporting_required', ''), 'false')) = 'true'
                            OR r.metadata_json ? 'r2s_report_status'
                            OR r.created_at >= $12
                        ) AS reporting_required,
                        CASE
                            WHEN (
                                lower(COALESCE(NULLIF(r.metadata_json->>'r2s_reporting_required', ''), 'false')) = 'true'
                                OR r.metadata_json ? 'r2s_report_status'
                                OR r.created_at >= $12
                            )
                            THEN COALESCE(NULLIF(r.metadata_json->>'r2s_report_status', ''), 'unreported')
                            ELSE 'not_required'
                        END AS report_status,
                        CASE
                            WHEN (
                                lower(COALESCE(NULLIF(r.metadata_json->>'r2s_reporting_required', ''), 'false')) = 'true'
                                OR r.metadata_json ? 'r2s_report_status'
                                OR r.created_at >= $12
                            )
                            THEN COALESCE((NULLIF(r.metadata_json->>'r2s_report_due_at', ''))::timestamptz, r.created_at + interval '1 day')
                            ELSE r.created_at
                        END AS due_at
                ) r2s
                WHERE r.created_at >= $1 AND r.created_at < $2
                  AND ($3::text IS NULL OR r.record_kind = $3)
                  AND ($4::uuid IS NULL OR r.customer_id = $4)
                  AND ($5::text IS NULL OR r.linked_corecredit_account_id = $5)
                  AND ($6::text IS NULL OR r.program_code = $6)
                  AND ($7::text IS NULL OR COALESCE(r.posting_status, 'legacy') = $7)
                  AND (
                    $11::text IS NULL
                    OR $11::text = 'all'
                    OR (
                        $11::text = 'overdue'
                        AND r2s.reporting_required
                        AND r2s.report_status = 'unreported'
                        AND r2s.due_at < now()
                    )
                    OR (
                        $11::text <> 'overdue'
                        AND r2s.reporting_required
                        AND r2s.report_status = $11
                    )
                  )
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
            .bind(r2s_report_status_filter)
            .bind(r2s_cutoff)
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
                COALESCE(
                    r.metadata_json->>'rms_charge_source',
                    r.metadata_json->>'source_mode',
                    CASE
                        WHEN r.external_transaction_id IS NOT NULL OR r.host_reference IS NOT NULL THEN 'corecard_live'
                        ELSE 'manual'
                    END
                ) AS source_mode,
                r2s.reporting_required AS r2s_reporting_required,
                r2s.report_status AS r2s_report_status,
                r2s.due_at AS r2s_report_due_at,
                (NULLIF(r.metadata_json->>'r2s_reported_at', ''))::timestamptz AS r2s_reported_at,
                CASE
                    WHEN (r.metadata_json->>'r2s_reported_by_staff_id') ~* '^[0-9a-f-]{36}$'
                    THEN (r.metadata_json->>'r2s_reported_by_staff_id')::uuid
                    ELSE NULL
                END AS r2s_reported_by_staff_id,
                rs.full_name AS r2s_reported_by_name,
                NULLIF(r.metadata_json->>'r2s_report_note', '') AS r2s_report_note,
                NULLIF(TRIM(BOTH FROM CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), '') AS customer_name,
                c.customer_code,
                s.full_name AS operator_name
            FROM pos_rms_charge_record r
            LEFT JOIN customers c ON c.id = r.customer_id
            LEFT JOIN staff s ON s.id = r.operator_staff_id
            LEFT JOIN staff rs ON rs.id = CASE
                WHEN (r.metadata_json->>'r2s_reported_by_staff_id') ~* '^[0-9a-f-]{36}$'
                THEN (r.metadata_json->>'r2s_reported_by_staff_id')::uuid
                ELSE NULL
            END
            CROSS JOIN LATERAL (
                SELECT
                    (
                        lower(COALESCE(NULLIF(r.metadata_json->>'r2s_reporting_required', ''), 'false')) = 'true'
                        OR r.metadata_json ? 'r2s_report_status'
                        OR r.created_at >= $11
                    ) AS reporting_required,
                    CASE
                        WHEN (
                            lower(COALESCE(NULLIF(r.metadata_json->>'r2s_reporting_required', ''), 'false')) = 'true'
                            OR r.metadata_json ? 'r2s_report_status'
                            OR r.created_at >= $11
                        )
                        THEN COALESCE(NULLIF(r.metadata_json->>'r2s_report_status', ''), 'unreported')
                        ELSE 'not_required'
                    END AS report_status,
                    CASE
                        WHEN (
                            lower(COALESCE(NULLIF(r.metadata_json->>'r2s_reporting_required', ''), 'false')) = 'true'
                            OR r.metadata_json ? 'r2s_report_status'
                            OR r.created_at >= $11
                        )
                        THEN COALESCE((NULLIF(r.metadata_json->>'r2s_report_due_at', ''))::timestamptz, r.created_at + interval '1 day')
                        ELSE r.created_at
                    END AS due_at
            ) r2s
            WHERE r.created_at >= $1 AND r.created_at < $2
              AND ($3::text IS NULL OR r.record_kind = $3)
              AND ($4::uuid IS NULL OR r.customer_id = $4)
              AND ($5::text IS NULL OR r.linked_corecredit_account_id = $5)
              AND ($6::text IS NULL OR r.program_code = $6)
              AND ($7::text IS NULL OR COALESCE(r.posting_status, 'legacy') = $7)
              AND (
                $10::text IS NULL
                OR $10::text = 'all'
                OR (
                    $10::text = 'overdue'
                    AND r2s.reporting_required
                    AND r2s.report_status = 'unreported'
                    AND r2s.due_at < now()
                )
                OR (
                    $10::text <> 'overdue'
                    AND r2s.reporting_required
                    AND r2s.report_status = $10
                )
              )
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
        .bind(r2s_report_status_filter)
        .bind(r2s_cutoff)
        .fetch_all(&state.db)
        .await?
    };

    Ok(Json(rows))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", post(create_customer))
        .route("/address-suggestions", get(get_address_suggestions))
        .route("/address-validation", post(post_address_validation))
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
        .route("/podium/messaging-health", get(get_podium_messaging_health))
        .route(
            "/podium/messaging-unmatched",
            get(list_podium_unmatched_conversations),
        )
        .route("/podium/direct-sms", post(post_podium_direct_sms))
        .route("/podium/messaging-sync", post(post_podium_messaging_sync))
        .route(
            "/podium/conversations/{conversation_id}/read",
            post(post_podium_conversation_read),
        )
        .route(
            "/podium/conversations/{conversation_id}/assignees",
            get(get_podium_conversation_assignees).patch(patch_podium_conversation_assignee),
        )
        .route("/rms-charge/records", get(list_rms_charge_records))
        .route(
            "/rms-charge/reconciliation",
            get(get_rms_charge_reconciliation),
        )
        .route(
            "/rms-charge/records/{record_id}",
            get(get_rms_charge_record),
        )
        .route(
            "/rms-charge/records/{record_id}/r2s-report",
            post(mark_rms_charge_record_reported_to_r2s),
        )
        .route(
            "/rms-charge/account-list/preview",
            post(preview_rms_account_list_import),
        )
        .route(
            "/rms-charge/account-list/import",
            post(import_rms_account_list),
        )
        .route(
            "/rms-charge/account-list/latest",
            get(get_latest_rms_account_list_import),
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
            "/{customer_id}/communication-timeline",
            get(get_customer_communication_timeline),
        )
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
        .route(
            "/{customer_id}/podium/contact-sync",
            post(post_customer_podium_contact_sync),
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
                    c.profile_discount_percent,
                    c.tax_exempt,
                    c.tax_exempt_id,
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
                    profile_discount_percent,
                    tax_exempt,
                    tax_exempt_id,
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
                profile_discount_percent,
                tax_exempt,
                tax_exempt_id,
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
    } else if lifecycle_filter.is_none() {
        sqlx::query_as::<_, CustomerBrowseRow>(&format!(
            r#"
            WITH page_candidates AS (
                SELECT
                    c.id,
                    c.customer_code,
                    COALESCE(c.first_name, '') AS first_name,
                    COALESCE(c.last_name, '') AS last_name,
                    c.company_name,
                    c.email,
                    c.phone,
                    c.is_vip,
                    c.profile_discount_percent,
                    c.tax_exempt,
                    c.tax_exempt_id,
                    c.couple_id,
                    c.couple_primary_id,
                    COALESCE(ob.balance_sum, 0)::numeric(12, 2) AS open_balance_due,
                    COALESCE(ob.lifetime_sales, 0)::numeric(12, 2) AS lifetime_sales,
                    COALESCE(ob.open_orders_count, 0)::bigint AS open_orders_count,
                    COALESCE(ob.ready_for_pickup_count, 0)::bigint AS ready_for_pickup_count
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
                ORDER BY last_name ASC, first_name ASC
                LIMIT $8 OFFSET $9
            ),
            browse_base AS (
                SELECT
                    pc.id,
                    pc.customer_code,
                    pc.first_name,
                    pc.last_name,
                    pc.company_name,
                    pc.email,
                    pc.phone,
                    pc.is_vip,
                    pc.profile_discount_percent,
                    pc.tax_exempt,
                    pc.tax_exempt_id,
                    pc.couple_id,
                    pc.couple_primary_id,
                    pc.open_balance_due,
                    pc.lifetime_sales,
                    pc.open_orders_count,
                    pc.ready_for_pickup_count,
                    (
                        SELECT s.status::text
                        FROM shipment s
                        WHERE s.customer_id = pc.id
                          AND s.status NOT IN ('delivered', 'cancelled')
                        ORDER BY s.created_at DESC
                        LIMIT 1
                    ) AS active_shipment_status,
                    (
                        SELECT MAX(ts)
                        FROM (
                            SELECT MAX(booked_at) AS ts FROM transactions WHERE customer_id = pc.id
                            UNION ALL
                            SELECT MAX(created_at) FROM payment_transactions WHERE payer_id = pc.id
                            UNION ALL
                            SELECT MAX(created_at) FROM measurements WHERE customer_id = pc.id
                            UNION ALL
                            SELECT MAX(measured_at) FROM customer_measurements WHERE customer_id = pc.id
                            UNION ALL
                            SELECT MAX(created_at) FROM customer_timeline_notes WHERE customer_id = pc.id
                            UNION ALL
                            SELECT MAX(l.created_at)
                            FROM wedding_activity_log l
                            WHERE EXISTS (
                                SELECT 1
                                FROM wedding_members wm
                                WHERE wm.wedding_party_id = l.wedding_party_id
                                  AND wm.customer_id = pc.id
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
                        WHERE wm.customer_id = pc.id
                          AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                          AND wp.event_date >= CURRENT_DATE
                          AND wp.event_date <= CURRENT_DATE + ($1::bigint * INTERVAL '1 day')
                    ) AS wedding_soon,
                    EXISTS (
                        SELECT 1
                        FROM wedding_members wm
                        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                        WHERE wm.customer_id = pc.id
                          AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                          AND wp.event_date >= CURRENT_DATE
                    ) AS wedding_active,
                    (
                        SELECT {SQL_PARTY_TRACKING_LABEL_WP}
                        FROM wedding_members wm
                        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                        WHERE wm.customer_id = pc.id
                          AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                          AND wp.event_date >= CURRENT_DATE
                        ORDER BY wp.event_date ASC
                        LIMIT 1
                    ) AS wedding_party_name,
                    (
                        SELECT wp.id
                        FROM wedding_members wm
                        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
                        WHERE wm.customer_id = pc.id
                          AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
                          AND wp.event_date >= CURRENT_DATE
                        ORDER BY wp.event_date ASC
                        LIMIT 1
                    ) AS wedding_party_id
                FROM page_candidates pc
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
                    profile_discount_percent,
                    tax_exempt,
                    tax_exempt_id,
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
                profile_discount_percent,
                tax_exempt,
                tax_exempt_id,
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
            ORDER BY last_name ASC, first_name ASC
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
                    c.profile_discount_percent,
                    c.tax_exempt,
                    c.tax_exempt_id,
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
                    profile_discount_percent,
                    tax_exempt,
                    tax_exempt_id,
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
                profile_discount_percent,
                tax_exempt,
                tax_exempt_id,
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

    let stats = sqlx::query(
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
        "#,
    )
    .fetch_one(&state.db)
    .await?;

    use sqlx::Row;
    Ok(Json(CustomerPipelineStats {
        total_customers: stats.get::<Option<i64>, _>("total_customers").unwrap_or(0),
        vip_customers: stats.get::<Option<i64>, _>("vip_customers").unwrap_or(0),
        with_balance: stats.get::<Option<i64>, _>("with_balance").unwrap_or(0),
        upcoming_weddings: stats
            .get::<Option<i64>, _>("upcoming_weddings")
            .unwrap_or(0),
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
                c.profile_discount_percent,
                c.tax_exempt,
                c.tax_exempt_id,
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
                c.profile_discount_percent,
                c.tax_exempt,
                c.tax_exempt_id,
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
    // Background sync to Podium contacts (best-effort)
    let pool = state.db.clone();
    let http = state.http_client.clone();
    let token_cache = state.podium_token_cache.clone();
    tokio::spawn(async move {
        let _ = podium::upsert_podium_contact(&pool, &http, &token_cache, id).await;
    });
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

    if let Some(pct) = body.profile_discount_percent {
        if pct < Decimal::ZERO || pct > Decimal::from(100) {
            return Err(CustomerError::BadRequest(
                "Profile discount must be between 0 and 100 percent".to_string(),
            ));
        }
    }
    if body.tax_exempt == Some(true) {
        let has_tax_id = body
            .tax_exempt_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();
        if !has_tax_id {
            return Err(CustomerError::BadRequest(
                "Tax exempt customers require a tax ID".to_string(),
            ));
        }
    }

    let mut qb: sqlx::QueryBuilder<'_, sqlx::Postgres> =
        sqlx::QueryBuilder::new("UPDATE customers SET ");
    let mut sep = qb.separated(", ");
    let mut n = 0u8;

    if let Some(ref v) = body.first_name {
        let t = v.trim();
        if !t.is_empty() {
            sep.push("first_name = ")
                .push_bind_unseparated(t.to_string());
            n += 1;
        }
    }
    if let Some(ref v) = body.last_name {
        let t = v.trim();
        if !t.is_empty() {
            sep.push("last_name = ")
                .push_bind_unseparated(t.to_string());
            n += 1;
        }
    }

    if let Some(ref v) = body.company_name {
        let t = v.trim();
        sep.push("company_name = ")
            .push_bind_unseparated(if t.is_empty() {
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
        sep.push("email = ").push_bind_unseparated(bind);
        n += 1;
    }
    if let Some(phone_raw) = body.phone {
        let t = phone_raw.trim();
        let bind: Option<String> = if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        };
        sep.push("phone = ").push_bind_unseparated(bind);
        n += 1;
    }

    if let Some(v) = body.address_line1 {
        let t = v.trim();
        sep.push("address_line1 = ")
            .push_bind_unseparated(if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            });
        n += 1;
    }
    if let Some(v) = body.address_line2 {
        let t = v.trim();
        sep.push("address_line2 = ")
            .push_bind_unseparated(if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            });
        n += 1;
    }
    if let Some(v) = body.city {
        let t = v.trim();
        sep.push("city = ").push_bind_unseparated(if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(v) = body.state {
        let t = v.trim();
        sep.push("state = ").push_bind_unseparated(if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        });
        n += 1;
    }
    if let Some(v) = body.postal_code {
        let t = v.trim();
        sep.push("postal_code = ")
            .push_bind_unseparated(if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            });
        n += 1;
    }

    if let Some(v) = body.date_of_birth {
        sep.push("date_of_birth = ").push_bind_unseparated(v);
        n += 1;
    }
    if let Some(v) = body.anniversary_date {
        sep.push("anniversary_date = ").push_bind_unseparated(v);
        n += 1;
    }

    if let Some(ref v) = body.custom_field_1 {
        let t = v.trim();
        sep.push("custom_field_1 = ")
            .push_bind_unseparated(if t.is_empty() {
                None::<String>
            } else {
                Some(t.to_string())
            });
        n += 1;
    }
    if let Some(ref v) = body.custom_field_2 {
        let t = v.trim();
        sep.push("custom_field_2 = ")
            .push_bind_unseparated(if t.is_empty() {
                None::<String>
            } else {
                Some(t.to_string())
            });
        n += 1;
    }
    if let Some(ref v) = body.custom_field_3 {
        let t = v.trim();
        sep.push("custom_field_3 = ")
            .push_bind_unseparated(if t.is_empty() {
                None::<String>
            } else {
                Some(t.to_string())
            });
        n += 1;
    }
    if let Some(ref v) = body.custom_field_4 {
        let t = v.trim();
        sep.push("custom_field_4 = ")
            .push_bind_unseparated(if t.is_empty() {
                None::<String>
            } else {
                Some(t.to_string())
            });
        n += 1;
    }

    if let Some(v) = body.marketing_email_opt_in {
        sep.push("marketing_email_opt_in = ")
            .push_bind_unseparated(v);
        n += 1;
    }
    if let Some(v) = body.marketing_sms_opt_in {
        sep.push("marketing_sms_opt_in = ").push_bind_unseparated(v);
        n += 1;
    }
    if let Some(v) = body.transactional_sms_opt_in {
        sep.push("transactional_sms_opt_in = ")
            .push_bind_unseparated(v);
        n += 1;
    }
    if let Some(v) = body.transactional_email_opt_in {
        sep.push("transactional_email_opt_in = ")
            .push_bind_unseparated(v);
        n += 1;
    }
    if let Some(ref v) = body.podium_conversation_url {
        let t = v.trim();
        sep.push("podium_conversation_url = ")
            .push_bind_unseparated(if t.is_empty() {
                None::<String>
            } else {
                Some(t.to_string())
            });
        n += 1;
    }
    if let Some(v) = body.review_requests_opt_out {
        sep.push("review_requests_opt_out = ")
            .push_bind_unseparated(v);
        n += 1;
    }
    if let Some(v) = body.is_vip {
        sep.push("is_vip = ").push_bind_unseparated(v);
        n += 1;
    }
    if let Some(v) = body.profile_discount_percent {
        sep.push("profile_discount_percent = ")
            .push_bind_unseparated(v.round_dp(2));
        n += 1;
    }
    if let Some(v) = body.tax_exempt {
        sep.push("tax_exempt = ").push_bind_unseparated(v);
        n += 1;
        if !v && body.tax_exempt_id.is_none() {
            sep.push("tax_exempt_id = ")
                .push_bind_unseparated(None::<String>);
            n += 1;
        }
    }
    if let Some(ref v) = body.tax_exempt_id {
        let t = v.trim();
        sep.push("tax_exempt_id = ")
            .push_bind_unseparated(if t.is_empty() {
                None::<String>
            } else {
                Some(t.to_string())
            });
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
    // Background sync to Podium contacts (best-effort)
    let pool = state.db.clone();
    let http = state.http_client.clone();
    let token_cache = state.podium_token_cache.clone();
    tokio::spawn(async move {
        let _ = podium::upsert_podium_contact(&pool, &http, &token_cache, customer_id).await;
    });
    // If review opt-out changed, also sync Podium contact campaign opt-out
    if body.review_requests_opt_out == Some(true) {
        let pool2 = state.db.clone();
        let http2 = state.http_client.clone();
        let token_cache2 = state.podium_token_cache.clone();
        tokio::spawn(async move {
            let phone_email: Option<(Option<String>, Option<String>)> =
                sqlx::query_as("SELECT phone, email FROM customers WHERE id = $1")
                    .bind(customer_id)
                    .fetch_optional(&pool2)
                    .await
                    .unwrap_or(None);
            if let Some((phone, email)) = phone_email {
                let _ = podium::opt_out_podium_contact(
                    &pool2,
                    &http2,
                    &token_cache2,
                    phone.as_deref(),
                    email.as_deref(),
                )
                .await;
            }
        });
    }
    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
struct CustomerEmailAttachmentBody {
    filename: String,
    content_type: String,
    data_base64: String,
}

#[derive(Debug, Deserialize)]
struct PostCustomerPodiumEmailBody {
    subject: String,
    html_body: String,
    #[serde(default)]
    attachments: Vec<CustomerEmailAttachmentBody>,
}

fn decode_customer_email_attachments(
    attachments: Vec<CustomerEmailAttachmentBody>,
) -> Result<Vec<store_email::EmailAttachmentPayload>, CustomerError> {
    let mut decoded = Vec::new();
    let mut total_bytes = 0usize;
    for attachment in attachments {
        let filename = attachment.filename.trim();
        if filename.is_empty() {
            return Err(CustomerError::BadRequest(
                "attachment filename is required".to_string(),
            ));
        }
        let bytes = general_purpose::STANDARD
            .decode(attachment.data_base64.trim())
            .map_err(|_| CustomerError::BadRequest("attachment data is invalid".to_string()))?;
        if bytes.is_empty() {
            return Err(CustomerError::BadRequest(
                "attachment file was empty".to_string(),
            ));
        }
        total_bytes += bytes.len();
        if total_bytes > CUSTOMER_MESSAGE_ATTACHMENT_MAX_BYTES {
            return Err(CustomerError::BadRequest(
                "attachments are too large".to_string(),
            ));
        }
        decoded.push(store_email::EmailAttachmentPayload {
            filename: filename.to_string(),
            content_type: attachment
                .content_type
                .trim()
                .to_string()
                .if_empty("application/octet-stream"),
            bytes,
        });
    }
    Ok(decoded)
}

trait EmptyStringDefault {
    fn if_empty(self, fallback: &str) -> String;
}

impl EmptyStringDefault for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

async fn post_customer_podium_email(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<PostCustomerPodiumEmailBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    let actor =
        customer_message_actor_from_perm_or_pos(&state, &headers, CUSTOMERS_HUB_EDIT).await?;
    let sub = body.subject.trim().to_string();
    let html = body.html_body.trim().to_string();
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
    let signature = staff_email_signature(&state.db, actor.staff_id).await?;
    let attachments = decode_customer_email_attachments(body.attachments)?;
    match store_email::send_email_with_attachments(
        &state.db,
        em,
        &sub,
        &html,
        actor.staff_id,
        signature.as_deref(),
        "outbound",
        attachments,
    )
    .await
    {
        Ok(_) => Ok(Json(json!({ "status": "sent" }))),
        Err(e) => Err(CustomerError::PodiumUnavailable(format!(
            "Could not send email ({e}). Check Mailbox settings and saved IONOS credentials."
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

async fn get_podium_messaging_health(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<podium_messaging::PodiumMessagingHealth>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let health = podium_messaging::health(&state.db).await?;
    Ok(Json(health))
}

async fn list_podium_unmatched_conversations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListPodiumInboxQuery>,
) -> Result<Json<Vec<podium_messaging::PodiumUnmatchedConversationRow>>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let rows =
        podium_messaging::list_unmatched_conversations(&state.db, q.limit.unwrap_or(20)).await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
struct PostPodiumDirectSmsBody {
    #[serde(default)]
    customer_id: Option<Uuid>,
    #[serde(default)]
    phone: Option<String>,
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
    body: String,
}

#[derive(Debug, Serialize)]
struct PostPodiumDirectSmsResponse {
    ok: bool,
    customer_id: Uuid,
    customer_created: bool,
}

async fn find_customer_id_by_phone_tail(
    pool: &sqlx::PgPool,
    phone: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    let digits: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
    let tail = digits
        .chars()
        .rev()
        .take(10)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    if tail.len() < 10 {
        return Ok(None);
    }
    sqlx::query_scalar(
        r#"
        SELECT id
        FROM customers
        WHERE phone IS NOT NULL
          AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE '%' || $1
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(tail)
    .fetch_optional(pool)
    .await
}

async fn post_podium_direct_sms(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PostPodiumDirectSmsBody>,
) -> Result<Json<PostPodiumDirectSmsResponse>, CustomerError> {
    let actor =
        customer_message_actor_from_perm_or_pos(&state, &headers, CUSTOMERS_HUB_EDIT).await?;
    let text = body.body.trim();
    if text.is_empty() {
        return Err(CustomerError::BadRequest("body is required".to_string()));
    }

    let mut customer_created = false;
    let customer_id = if let Some(customer_id) = body.customer_id {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
                .bind(customer_id)
                .fetch_one(&state.db)
                .await?;
        if !exists {
            return Err(CustomerError::NotFound);
        }
        customer_id
    } else {
        let phone = body
            .phone
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| CustomerError::BadRequest("phone is required".to_string()))?;
        let Some(normalized_phone) = podium::normalize_phone_e164(phone) else {
            return Err(CustomerError::BadRequest(
                "Enter a valid phone number before sending.".to_string(),
            ));
        };
        if let Some(existing_id) =
            find_customer_id_by_phone_tail(&state.db, &normalized_phone).await?
        {
            existing_id
        } else {
            let first = body.first_name.as_deref().unwrap_or("").trim();
            let last = body.last_name.as_deref().unwrap_or("").trim();
            if first.is_empty() || last.is_empty() {
                return Err(CustomerError::BadRequest(
                    "First and last name are required for a new Podium contact.".to_string(),
                ));
            }
            let id = insert_customer(
                &state.db,
                InsertCustomerParams {
                    customer_code: None,
                    first_name: first.to_string(),
                    last_name: last.to_string(),
                    company_name: None,
                    email: None,
                    phone: Some(normalized_phone),
                    address_line1: None,
                    address_line2: None,
                    city: None,
                    state: None,
                    postal_code: None,
                    date_of_birth: None,
                    anniversary_date: None,
                    custom_field_1: None,
                    custom_field_2: None,
                    custom_field_3: None,
                    custom_field_4: None,
                    marketing_email_opt_in: false,
                    marketing_sms_opt_in: false,
                    transactional_sms_opt_in: true,
                    transactional_email_opt_in: false,
                    customer_created_source: crate::logic::customers::CustomerCreatedSource::Podium,
                },
            )
            .await?;
            customer_created = true;
            spawn_meilisearch_customer_hooks(&state, id);
            id
        }
    };

    let row = load_customer_profile_row(&state.db, customer_id).await?;
    let Some(ref phone) = row.phone else {
        return Err(CustomerError::BadRequest(
            "Customer has no phone on file".to_string(),
        ));
    };
    podium::send_podium_sms_message_with_sender(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        phone,
        text,
        actor.sender_name.as_deref(),
    )
    .await
    .map_err(|e| {
        CustomerError::PodiumUnavailable(format!(
            "Could not send SMS via Podium ({e}). Check Integrations and env credentials."
        ))
    })?;
    let e164 = podium::normalize_phone_e164(phone.as_str());
    podium_messaging::record_outbound_message(
        &state.db,
        customer_id,
        "sms",
        text,
        actor.staff_id,
        e164.as_deref(),
        None,
        "outbound",
    )
    .await
    .map_err(CustomerError::Database)?;

    Ok(Json(PostPodiumDirectSmsResponse {
        ok: true,
        customer_id,
        customer_created,
    }))
}

#[derive(Debug, Deserialize)]
struct PodiumMessagingSyncBody {
    limit: Option<i64>,
}

async fn post_podium_messaging_sync(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PodiumMessagingSyncBody>,
) -> Result<Json<podium_messaging::PodiumSyncResult>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_EDIT).await?;
    let result = podium_messaging::sync_recent_from_podium(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        body.limit.unwrap_or(200),
    )
    .await
    .map_err(|err| CustomerError::PodiumUnavailable(err.to_string()))?;
    Ok(Json(result))
}

async fn post_podium_conversation_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    podium_messaging::mark_conversation_viewed(&state.db, conversation_id).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct CommunicationTimelineQuery {
    limit: Option<i64>,
}

async fn get_customer_communication_timeline(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Query(q): Query<CommunicationTimelineQuery>,
) -> Result<Json<Vec<podium_messaging::CommunicationTimelineRow>>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    if let Err(error) = podium_messaging::hydrate_missing_messages_for_customer(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        customer_id,
    )
    .await
    {
        tracing::warn!(
            error = %error,
            customer_id = %customer_id,
            "podium customer timeline hydrate failed"
        );
    }
    let rows =
        podium_messaging::communication_timeline(&state.db, customer_id, q.limit.unwrap_or(40))
            .await?;
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
    let mut rows = podium_messaging::list_messages_for_customer(&state.db, customer_id).await?;
    if rows.is_empty() {
        let has_podium_conversation =
            podium_messaging::has_conversations_for_customer(&state.db, customer_id).await?;
        if let Err(error) = podium_messaging::hydrate_missing_messages_for_customer(
            &state.db,
            &state.http_client,
            &state.podium_token_cache,
            customer_id,
        )
        .await
        {
            tracing::warn!(
                error = %error,
                customer_id = %customer_id,
                "podium customer thread hydrate failed"
            );
            if has_podium_conversation {
                return Err(CustomerError::PodiumUnavailable(
                    "Podium conversation is linked, but message history could not refresh. Check Podium webhooks, credentials, and message scopes, then refresh this customer.".to_string(),
                ));
            }
        }
        rows = podium_messaging::list_messages_for_customer(&state.db, customer_id).await?;
        if rows.is_empty() && has_podium_conversation {
            return Err(CustomerError::PodiumUnavailable(
                "Podium conversation is linked, but no message bodies are available in Riverside yet. Re-enable Podium message webhooks and run Podium sync.".to_string(),
            ));
        }
    }
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
struct PostCustomerPodiumReplyBody {
    channel: String,
    body: String,
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    attachment_png_base64: Option<String>,
}

async fn post_customer_podium_reply(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(body): Json<PostCustomerPodiumReplyBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    let actor =
        customer_message_actor_from_perm_or_pos(&state, &headers, CUSTOMERS_HUB_EDIT).await?;
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
            if let Some(b64_raw) = body.attachment_png_base64.as_deref() {
                let b64 = b64_raw.trim();
                if b64.is_empty() {
                    return Err(CustomerError::BadRequest(
                        "attachment image was empty".to_string(),
                    ));
                }
                let png = general_purpose::STANDARD.decode(b64).map_err(|_| {
                    CustomerError::BadRequest("attachment image is invalid".to_string())
                })?;
                if png.is_empty() {
                    return Err(CustomerError::BadRequest(
                        "attachment image was empty".to_string(),
                    ));
                }
                if png.len() > CUSTOMER_MESSAGE_ATTACHMENT_MAX_BYTES {
                    return Err(CustomerError::BadRequest(
                        "attachment image is too large".to_string(),
                    ));
                }
                podium::send_podium_phone_message_with_png_attachment(
                    &state.db,
                    &state.http_client,
                    &state.podium_token_cache,
                    ph,
                    text,
                    png,
                )
                .await
                .map_err(|e| {
                    CustomerError::PodiumUnavailable(format!(
                        "Could not send SMS attachment via Podium ({e}). Check Integrations and env credentials."
                    ))
                })?;
            } else {
                podium::send_podium_sms_message_with_sender(
                    &state.db,
                    &state.http_client,
                    &state.podium_token_cache,
                    ph,
                    text,
                    actor.sender_name.as_deref(),
                )
                .await
                .map_err(|e| {
                    CustomerError::PodiumUnavailable(format!(
                        "Could not send SMS via Podium ({e}). Check Integrations and env credentials."
                    ))
                })?;
            }
            let e164 = podium::normalize_phone_e164(ph.as_str());
            podium_messaging::record_outbound_message(
                &state.db,
                customer_id,
                "sms",
                text,
                actor.staff_id,
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
            let signature = staff_email_signature(&state.db, actor.staff_id).await?;
            store_email::send_email(
                &state.db,
                em,
                sub,
                text,
                actor.staff_id,
                signature.as_deref(),
                "outbound",
            )
            .await
            .map_err(|e| {
                CustomerError::PodiumUnavailable(format!(
                    "Could not send email ({e}). Check Mailbox settings and saved IONOS credentials."
                ))
            })?;
        }
        _ => {
            return Err(CustomerError::BadRequest(
                "channel must be sms or email".to_string(),
            ));
        }
    }
    Ok(Json(json!({ "ok": true })))
}

async fn post_customer_podium_contact_sync(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_EDIT).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(customer_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(CustomerError::NotFound);
    }
    let result = podium::upsert_podium_contact(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        customer_id,
    )
    .await
    .map_err(|e| {
        CustomerError::PodiumUnavailable(format!(
            "Could not sync customer to Podium contacts ({e}). Check Integration credentials and scopes."
        ))
    })?;
    Ok(Json(result))
}

async fn get_podium_conversation_assignees(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
) -> Result<Json<Vec<serde_json::Value>>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let rows = podium::fetch_conversation_assignees(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        &conversation_id,
    )
    .await
    .map_err(|e| {
        CustomerError::PodiumUnavailable(format!("Could not fetch conversation assignees ({e})."))
    })?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
struct PatchPodiumAssigneeBody {
    user_uid: Option<String>,
}

async fn patch_podium_conversation_assignee(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
    Json(body): Json<PatchPodiumAssigneeBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    require_customer_perm_or_pos(&state, &headers, CUSTOMERS_HUB_EDIT).await?;
    let result = podium::update_conversation_assignee(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        &conversation_id,
        body.user_uid.as_deref(),
    )
    .await
    .map_err(|e| {
        CustomerError::PodiumUnavailable(format!("Could not update conversation assignee ({e})."))
    })?;
    Ok(Json(result))
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
    let next_wedding = weddings
        .iter()
        .filter(|w| w.active)
        .min_by_key(|w| w.event_date);
    let snapshot_items = fetch_customer_snapshot_items(
        &state.db,
        customer_id,
        CustomerSnapshotContext {
            balance_due_usd: hub.balance_due_usd,
            marketing_email_opt_in: row.marketing_email_opt_in,
            marketing_sms_opt_in: row.marketing_sms_opt_in,
            transactional_sms_opt_in: row.transactional_sms_opt_in,
            transactional_email_opt_in: row.transactional_email_opt_in,
            next_wedding_party_name: next_wedding.map(|w| w.party_name.clone()),
            next_wedding_event_date: next_wedding.map(|w| w.event_date),
        },
    )
    .await
    .map_err(CustomerError::Database)?;

    let partner = if let Some(cid) = row.couple_id {
        sqlx::query_as::<_, CoupleMemberPreview>(
            r#"
            SELECT id, customer_code, first_name, last_name, email, phone, couple_id, couple_primary_id
            FROM customers
            WHERE couple_id = $1 AND id != $2
            "#
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
        snapshot_items,
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
    display_id: Option<String>,
    booked_at: DateTime<Utc>,
    items_summary: Option<String>,
}

#[derive(Debug, FromRow)]
struct PaymentTimelineRow {
    id: Uuid,
    created_at: DateTime<Utc>,
    payment_method: String,
    amount: Decimal,
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

#[derive(Debug, sqlx::FromRow)]
struct MarketingEmailEventTimelineRow {
    id: Uuid,
    event_type: String,
    occurred_at: DateTime<Utc>,
    campaign_name: Option<String>,
    provider: String,
}

async fn build_customer_timeline(
    pool: &sqlx::PgPool,
    customer_id: Uuid,
) -> Result<Vec<CustomerTimelineEvent>, sqlx::Error> {
    let orders = sqlx::query_as::<_, OrderTimelineRow>(
        r#"
        SELECT
            o.id,
            COALESCE(NULLIF(TRIM(o.display_id), ''), o.counterpoint_doc_ref, o.counterpoint_ticket_ref, o.id::text) AS display_id,
            o.booked_at,
            STRING_AGG(
                (oi.quantity::text || '× ' || COALESCE(p.name, 'Item')),
                ', ' ORDER BY COALESCE(p.name, '')
            ) FILTER (WHERE oi.id IS NOT NULL) AS items_summary
        FROM transactions o
        LEFT JOIN transaction_lines oi ON oi.transaction_id = o.id
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE (
            o.customer_id = $1
            OR EXISTS (
                SELECT 1
                FROM customer_relationship_periods crp
                WHERE (
                    (crp.parent_customer_id = $1 AND crp.child_customer_id = o.customer_id)
                    OR
                    (crp.child_customer_id = $1 AND crp.parent_customer_id = o.customer_id)
                )
                  AND o.booked_at >= crp.linked_at
                  AND (crp.unlinked_at IS NULL OR o.booked_at <= crp.unlinked_at)
            )
        )
          AND o.status != 'cancelled'::order_status
        GROUP BY o.id, o.display_id, o.counterpoint_doc_ref, o.counterpoint_ticket_ref, o.booked_at
        ORDER BY o.booked_at DESC
        LIMIT 25
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    let payments = sqlx::query_as::<_, PaymentTimelineRow>(
        r#"
        SELECT id, created_at, payment_method, amount
        FROM payment_transactions p
        WHERE p.payer_id = $1
           OR EXISTS (
               SELECT 1
               FROM customer_relationship_periods crp
               WHERE (
                   (crp.parent_customer_id = $1 AND crp.child_customer_id = p.payer_id)
                   OR
                   (crp.child_customer_id = $1 AND crp.parent_customer_id = p.payer_id)
               )
                 AND p.created_at >= crp.linked_at
                 AND (crp.unlinked_at IS NULL OR p.created_at <= crp.unlinked_at)
           )
        ORDER BY created_at DESC
        LIMIT 28
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

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
              AND (
                  wm.customer_id = $1
                  OR EXISTS (
                      SELECT 1
                      FROM customer_relationship_periods crp
                      WHERE (
                          (crp.parent_customer_id = $1 AND crp.child_customer_id = wm.customer_id)
                          OR
                          (crp.child_customer_id = $1 AND crp.parent_customer_id = wm.customer_id)
                      )
                        AND l.created_at >= crp.linked_at
                        AND (crp.unlinked_at IS NULL OR l.created_at <= crp.unlinked_at)
                  )
              )
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
        FROM customer_timeline_notes n
        WHERE n.customer_id = $1
           OR EXISTS (
               SELECT 1
               FROM customer_relationship_periods crp
               WHERE (
                   (crp.parent_customer_id = $1 AND crp.child_customer_id = n.customer_id)
                   OR
                   (crp.child_customer_id = $1 AND crp.parent_customer_id = n.customer_id)
               )
                 AND n.created_at >= crp.linked_at
                 AND (crp.unlinked_at IS NULL OR n.created_at <= crp.unlinked_at)
           )
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
        FROM measurements m
        WHERE m.customer_id = $1
           OR EXISTS (
               SELECT 1
               FROM customer_relationship_periods crp
               WHERE (
                   (crp.parent_customer_id = $1 AND crp.child_customer_id = m.customer_id)
                   OR
                   (crp.child_customer_id = $1 AND crp.parent_customer_id = m.customer_id)
               )
                 AND m.created_at >= crp.linked_at
                 AND (crp.unlinked_at IS NULL OR m.created_at <= crp.unlinked_at)
           )
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
           OR EXISTS (
               SELECT 1
               FROM customer_relationship_periods crp
               WHERE (
                   (crp.parent_customer_id = $1 AND crp.child_customer_id = wa.customer_id)
                   OR
                   (crp.child_customer_id = $1 AND crp.parent_customer_id = wa.customer_id)
                   OR
                   (crp.parent_customer_id = $1 AND crp.child_customer_id = wm.customer_id)
                   OR
                   (crp.child_customer_id = $1 AND crp.parent_customer_id = wm.customer_id)
               )
                 AND wa.starts_at >= crp.linked_at
                 AND (crp.unlinked_at IS NULL OR wa.starts_at <= crp.unlinked_at)
           )
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
           OR EXISTS (
               SELECT 1
               FROM customer_relationship_periods crp
               WHERE (
                   (crp.parent_customer_id = $1 AND crp.child_customer_id = s.customer_id)
                   OR
                   (crp.child_customer_id = $1 AND crp.parent_customer_id = s.customer_id)
               )
                 AND e.at >= crp.linked_at
                 AND (crp.unlinked_at IS NULL OR e.at <= crp.unlinked_at)
           )
        ORDER BY e.at DESC
        LIMIT 35
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    let marketing_events = sqlx::query_as::<_, MarketingEmailEventTimelineRow>(
        r#"
        SELECT id, event_type, occurred_at, campaign_name, provider
        FROM customer_marketing_email_event
        WHERE customer_id = $1
        ORDER BY occurred_at DESC
        LIMIT 50
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await?;

    let mut events: Vec<CustomerTimelineEvent> = Vec::new();

    for o in orders {
        let items = o.items_summary.unwrap_or_else(|| "Purchase".to_string());
        let display_id = o.display_id.unwrap_or_else(|| short_order_ref(o.id));
        events.push(CustomerTimelineEvent {
            at: o.booked_at,
            kind: "sale".to_string(),
            summary: format!("Purchased {items} ({display_id})"),
            reference_id: Some(o.id),
            reference_type: Some("transaction".to_string()),
            wedding_party_id: None,
        });
    }

    for p in payments {
        events.push(CustomerTimelineEvent {
            at: p.created_at,
            kind: "payment".to_string(),
            summary: format!("Payment recorded: {} via {}", p.amount, p.payment_method),
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

    for ev in marketing_events {
        let provider = match ev.provider.as_str() {
            "constant_contact" => "Constant Contact",
            other => other,
        };
        let campaign_info = if let Some(name) = &ev.campaign_name {
            format!(" for campaign \"{}\"", name)
        } else {
            "".to_string()
        };
        let summary = format!(
            "[{}] Email {}{}",
            provider,
            ev.event_type.to_lowercase(),
            campaign_info
        );
        events.push(CustomerTimelineEvent {
            at: ev.occurred_at,
            kind: "marketing_email".to_string(),
            summary,
            reference_id: Some(ev.id),
            reference_type: Some("marketing_email_event".to_string()),
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
