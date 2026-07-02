//! Wedding Manager: full party / member / appointment parity with legacy app,
//! integrated with ROS `customers`, `orders`, and POS checkout.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use futures_core::stream::Stream;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{PgPool, QueryBuilder, Row};
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    effective_permissions_for_staff, staff_has_permission, STAFF_MANAGE_ACCESS, TASKS_MANAGE,
    WEDDINGS_MUTATE, WEDDINGS_VIEW,
};
use crate::logic::customers::{insert_customer, InsertCustomerParams};
use crate::logic::messaging::MessagingService;
use crate::logic::staff_schedule;
use crate::logic::wedding_api_types::build_party_bundle;
use crate::logic::wedding_queries::{
    digits_only, fetch_member_optional, fetch_party_row_optional, list_appointments_filtered,
    load_members_for_party, query_activity_feed, query_party_list_page, query_wedding_actions,
    try_load_party_financial_context, try_load_party_ledger,
};
use crate::logic::weddings as wedding_logic;
use crate::middleware;
use crate::middleware::require_authenticated_staff_headers;
use crate::models::DbOrderItemLifecycleStatus;
use crate::services::inventory::resolve_variant_by_id;
use crate::services::ResolvedSkuItem;

pub(crate) async fn rosie_wedding_actions(
    state: &AppState,
    headers: &HeaderMap,
    days: Option<i64>,
) -> Result<serde_json::Value, Response> {
    let Json(actions) = get_actions(
        State(state.clone()),
        headers.clone(),
        Query(ActionsQuery { days }),
    )
    .await
    .map_err(IntoResponse::into_response)?;

    serde_json::to_value(actions).map_err(|error| {
        tracing::error!(error = %error, days, "serialize ROSIE wedding actions");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "failed to serialize wedding actions" })),
        )
            .into_response()
    })
}

fn spawn_meilisearch_wedding_party(state: &AppState, party_id: Uuid) {
    let ms = state.meilisearch.clone();
    let pool = state.db.clone();
    if let Some(c) = ms {
        tokio::spawn(async move {
            crate::logic::meilisearch_sync::upsert_wedding_party_document(&c, &pool, party_id)
                .await;
        });
    }
}

fn spawn_meilisearch_appointment_upsert(state: &AppState, appt_id: Uuid) {
    let Some(client) = state.meilisearch.clone() else {
        return;
    };
    let pool = state.db.clone();
    crate::logic::meilisearch_sync::spawn_meili(async move {
        crate::logic::meilisearch_sync::upsert_appointment_document(&client, &pool, appt_id).await;
    });
}

async fn get_or_create_wedding_customer(
    pool: &PgPool,
    first: &str,
    last: &str,
    phone: Option<&str>,
    customer_created_source: &str,
    created_is_verified: bool,
) -> Result<(Uuid, bool), sqlx::Error> {
    let is_cutover_import = customer_created_source == "wedding_import";
    let phone = phone.map(str::trim).filter(|s| !s.is_empty());
    if let Some(phone) = phone {
        let phone_digits = digits_only(phone);
        let phone_digits_for_match = if is_cutover_import && phone_digits.len() < 10 {
            None
        } else {
            Some(phone_digits.as_str())
        };
        if let Some(match_digits) = phone_digits_for_match {
            if let Some((existing_id, match_count)) = sqlx::query_as::<_, (Uuid, i64)>(
                r#"
                WITH phone_matches AS (
                    SELECT id, first_name, last_name, created_at
                    FROM customers
                    WHERE phone = $1
                       OR REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') = $2
                       OR (
                            LENGTH($2) = 10
                            AND RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = $2
                       )
                       OR (
                            LENGTH($2) = 7
                            AND RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 7) = $2
                       )
                       OR (
                            LENGTH($2) = 7
                            AND RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = CONCAT('716', $2)
                       )
                ),
                name_matches AS (
                    SELECT id, created_at
                    FROM phone_matches
                    WHERE LOWER(TRIM(COALESCE(first_name, ''))) = LOWER(TRIM($3))
                      AND LOWER(TRIM(COALESCE(last_name, ''))) = LOWER(TRIM($4))
                )
                SELECT id, COUNT(*) OVER () AS match_count
                FROM name_matches
                ORDER BY created_at DESC
                LIMIT 1
                "#,
            )
            .bind(phone)
            .bind(match_digits)
            .bind(first)
            .bind(last)
            .fetch_optional(pool)
            .await?
            {
                if match_count == 1 {
                    return Ok((existing_id, true));
                }
            }
        }
    }

    let customer_id = Uuid::new_v4();
    let created_phone = phone.and_then(|value| {
        let digits = digits_only(value);
        if is_cutover_import && digits.len() < 10 {
            None
        } else {
            Some(value)
        }
    });
    let inserted_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO customers (
            id, first_name, last_name, phone, customer_code, customer_created_source, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING id
        "#,
    )
    .bind(customer_id)
    .bind(first)
    .bind(last)
    .bind(created_phone)
    .bind(format!("Wedding-{}", &customer_id.to_string()[..8]))
    .bind(customer_created_source)
    .fetch_one(pool)
    .await?;

    Ok((inserted_id, created_is_verified))
}

pub use crate::logic::wedding_api_types::{
    ActionRow, ActivityFeedRow, AppointmentRow, PaginatedParties, Pagination, PartyListQuery,
    WeddingActions, WeddingLedgerLine, WeddingLedgerResponse, WeddingLedgerSummary,
    WeddingMemberApi, WeddingMemberFinancialRow, WeddingNonInventoryItem,
    WeddingPartyFinancialContext, WeddingPartyRow, WeddingPartyWithMembers,
};

#[derive(Debug, Serialize)]
pub struct CustomerWeddingPurchaseContext {
    pub memberships: Vec<CustomerWeddingPurchaseMembership>,
}

#[derive(Debug, Serialize)]
pub struct CustomerWeddingPurchaseMembership {
    pub wedding_member_id: Uuid,
    pub wedding_party_id: Uuid,
    pub transaction_id: Option<Uuid>,
    pub party_name: String,
    pub event_date: chrono::NaiveDate,
    pub role: String,
    pub status: String,
    pub active: bool,
    pub measured: bool,
    pub suit_ordered: bool,
    pub customer_id: Uuid,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub customer_email: Option<String>,
    pub customer_phone: Option<String>,
    pub is_free_suit_promo: bool,
    pub purchase_items: Vec<CustomerWeddingPurchaseItem>,
    pub checklist_items: Vec<CustomerWeddingChecklistItem>,
}

#[derive(Debug, Serialize)]
pub struct CustomerWeddingPurchaseItem {
    #[serde(flatten)]
    pub item: ResolvedSkuItem,
    pub source: String,
    pub already_tracked: bool,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CustomerWeddingChecklistItem {
    pub id: Uuid,
    pub description: String,
    pub quantity: i32,
    pub status: String,
    pub notes: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct CustomerWeddingPurchaseRow {
    wedding_member_id: Uuid,
    wedding_party_id: Uuid,
    transaction_id: Option<Uuid>,
    party_name: String,
    event_date: chrono::NaiveDate,
    role: String,
    status: String,
    active: bool,
    measured: bool,
    suit_ordered: bool,
    customer_id: Uuid,
    first_name: Option<String>,
    last_name: Option<String>,
    customer_email: Option<String>,
    customer_phone: Option<String>,
    is_free_suit_promo: bool,
    suit_variant_id: Option<Uuid>,
    suit_source: Option<String>,
}

#[derive(Debug, Error)]
pub enum WeddingError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Wedding party not found")]
    PartyNotFound,
    #[error("Wedding member not found")]
    MemberNotFound,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
}

fn map_wed_perm(e: (StatusCode, axum::Json<serde_json::Value>)) -> WeddingError {
    let (st, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match st {
        StatusCode::UNAUTHORIZED => WeddingError::Unauthorized(msg),
        StatusCode::FORBIDDEN => WeddingError::Forbidden(msg),
        _ => WeddingError::BadRequest(msg),
    }
}

async fn require_weddings_view(state: &AppState, headers: &HeaderMap) -> Result<(), WeddingError> {
    middleware::require_staff_with_permission(state, headers, WEDDINGS_VIEW)
        .await
        .map(|_| ())
        .map_err(map_wed_perm)
}

async fn require_weddings_mutate(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), WeddingError> {
    middleware::require_staff_with_permission(state, headers, WEDDINGS_MUTATE)
        .await
        .map(|_| ())
        .map_err(map_wed_perm)
}

async fn require_schedule_override_actor(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Uuid, WeddingError> {
    let staff = require_authenticated_staff_headers(state, headers)
        .await
        .map_err(map_wed_perm)?;
    let permissions = effective_permissions_for_staff(&state.db, staff.id, staff.role)
        .await
        .map_err(WeddingError::Database)?;
    if staff_has_permission(&permissions, STAFF_MANAGE_ACCESS)
        || staff_has_permission(&permissions, TASKS_MANAGE)
    {
        Ok(staff.id)
    } else {
        Err(WeddingError::Forbidden(
            "Manager Access required for appointment schedule override".to_string(),
        ))
    }
}

impl IntoResponse for WeddingError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            WeddingError::PartyNotFound => {
                (StatusCode::NOT_FOUND, "Wedding party not found".to_string())
            }
            WeddingError::MemberNotFound => (
                StatusCode::NOT_FOUND,
                "Wedding member not found".to_string(),
            ),
            WeddingError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            WeddingError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            WeddingError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            WeddingError::Database(e) => {
                tracing::error!(error = %e, "Database error in weddings");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

fn resolve_actor(o: Option<String>) -> String {
    o.map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Riverside POS".to_string())
}

fn normalize_cutover_status(raw: Option<String>) -> Result<String, WeddingError> {
    let value = raw
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("not_required");
    match value {
        "not_required" | "needs_review" | "in_review" | "blocked" | "reviewed" => {
            Ok(value.to_string())
        }
        _ => Err(WeddingError::BadRequest(
            "unsupported cutover review status".to_string(),
        )),
    }
}

fn wedding_client_sender(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-wedding-client-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

async fn wedding_events_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>> + Send>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let rx = state.wedding_events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|item| match item {
        Ok(json) => Some(Ok(Event::default().data(json))),
        Err(BroadcastStreamRecvError::Lagged(n)) => {
            tracing::debug!(skipped = n, "wedding sse client lagged");
            None
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

#[derive(Debug, Deserialize)]
pub struct ActorQuery {
    #[serde(default)]
    pub actor_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ActivityFeedQuery {
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

fn member_patch_keys(body: &UpdateMemberRequest) -> Vec<String> {
    let mut k = Vec::new();
    macro_rules! push {
        ($field:ident, $label:literal) => {
            if body.$field.is_some() {
                k.push($label.to_string());
            }
        };
    }
    push!(role, "role");
    push!(notes, "notes");
    push!(status, "status");
    push!(member_index, "member_index");
    push!(oot, "oot");
    push!(suit, "suit");
    push!(waist, "waist");
    push!(vest, "vest");
    push!(shirt, "shirt");
    push!(shoe, "shoe");
    push!(measured, "measured");
    push!(suit_ordered, "suit_ordered");
    push!(received, "received");
    push!(fitting, "fitting");
    push!(pickup_status, "pickup_status");
    push!(measure_date, "measure_date");
    push!(ordered_date, "ordered_date");
    push!(received_date, "received_date");
    push!(fitting_date, "fitting_date");
    push!(pickup_date, "pickup_date");
    push!(ordered_items, "ordered_items");
    push!(member_accessories, "member_accessories");
    push!(contact_history, "contact_history");
    push!(pin_note, "pin_note");
    push!(ordered_po, "ordered_po");
    push!(stock_info, "stock_info");
    push!(suit_variant_id, "suit_variant_id");
    push!(is_free_suit_promo, "is_free_suit_promo");
    k
}

fn party_patch_summary(body: &UpdatePartyRequest) -> Vec<String> {
    let mut k = Vec::new();
    if body.party_name.is_some() {
        k.push("party_name".into());
    }
    if body.groom_name.is_some() {
        k.push("groom_name".into());
    }
    if body.event_date.is_some() {
        k.push("event_date".into());
    }
    if body.venue.is_some() {
        k.push("venue".into());
    }
    if body.notes.is_some() {
        k.push("notes".into());
    }
    if body.party_type.is_some() {
        k.push("party_type".into());
    }
    if body.sign_up_date.is_some() {
        k.push("sign_up_date".into());
    }
    if body.salesperson.is_some() {
        k.push("salesperson".into());
    }
    if body.style_info.is_some() {
        k.push("style_info".into());
    }
    if body.price_info.is_some() {
        k.push("price_info".into());
    }
    if body.groom_phone.is_some() {
        k.push("groom_phone".into());
    }
    if body.groom_email.is_some() {
        k.push("groom_email".into());
    }
    if body.bride_name.is_some() {
        k.push("bride_name".into());
    }
    if body.bride_phone.is_some() {
        k.push("bride_phone".into());
    }
    if body.bride_email.is_some() {
        k.push("bride_email".into());
    }
    if body.accessories.is_some() {
        k.push("accessories".into());
    }
    if body.suit_variant_id.is_some() {
        k.push("suit_variant_id".into());
    }
    k
}

#[derive(Debug, Deserialize)]
pub struct ActionsQuery {
    pub days: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct CreatePartyRequest {
    pub party_name: Option<String>,
    pub groom_name: String,
    pub event_date: chrono::NaiveDate,
    pub venue: Option<String>,
    pub notes: Option<String>,
    pub party_type: Option<String>,
    pub sign_up_date: Option<chrono::NaiveDate>,
    pub salesperson: Option<String>,
    pub style_info: Option<String>,
    pub price_info: Option<String>,
    pub groom_phone: Option<String>,
    pub groom_email: Option<String>,
    pub bride_name: Option<String>,
    pub bride_phone: Option<String>,
    pub bride_email: Option<String>,
    pub accessories: Option<serde_json::Value>,
    #[serde(default)]
    pub actor_name: Option<String>,
    /// ROS customer ID for groom (if searching/linking an existing customer)
    pub groom_customer_id: Option<Uuid>,
    /// ROS customer ID for bride (if searching/linking an existing customer)
    pub bride_customer_id: Option<Uuid>,
    /// Base suit variant for the party (can be overridden per member)
    pub base_suit_variant_id: Option<Uuid>,
    #[serde(default)]
    pub cutover_review_status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePartyRequest {
    pub party_name: Option<String>,
    pub groom_name: Option<String>,
    pub event_date: Option<chrono::NaiveDate>,
    pub venue: Option<String>,
    pub notes: Option<String>,
    pub party_type: Option<String>,
    pub sign_up_date: Option<chrono::NaiveDate>,
    pub salesperson: Option<String>,
    pub style_info: Option<String>,
    pub price_info: Option<String>,
    pub groom_phone: Option<String>,
    pub groom_email: Option<String>,
    pub bride_name: Option<String>,
    pub bride_phone: Option<String>,
    pub bride_email: Option<String>,
    pub accessories: Option<serde_json::Value>,
    pub suit_variant_id: Option<Uuid>,
    #[serde(default)]
    pub actor_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct QuickCreateMemberBody {
    first_name: String,
    last_name: String,
    email: Option<String>,
    phone: Option<String>,
    address_line1: Option<String>,
    address_line2: Option<String>,
    city: Option<String>,
    state: Option<String>,
    postal_code: Option<String>,
    marketing_email_opt_in: Option<bool>,
    marketing_sms_opt_in: Option<bool>,
    transactional_sms_opt_in: Option<bool>,
    #[serde(default)]
    transactional_email_opt_in: Option<bool>,
    role: Option<String>,
    notes: Option<String>,
    #[serde(default)]
    actor_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum CreateMemberRequest {
    LinkExisting {
        customer_id: Uuid,
        role: Option<String>,
        notes: Option<String>,
        #[serde(default)]
        actor_name: Option<String>,
    },
    QuickCreateCustomer(Box<QuickCreateMemberBody>),
    SimpleCreate {
        first_name: String,
        last_name: String,
        phone: Option<String>,
        role: Option<String>,
        notes: Option<String>,
        /// Original name from import (before ROS customer link)
        import_customer_name: Option<String>,
        /// Original phone from import (before ROS customer link)
        import_customer_phone: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
pub struct UpdateMemberRequest {
    pub role: Option<String>,
    pub notes: Option<String>,
    pub status: Option<String>,
    pub member_index: Option<i32>,
    pub oot: Option<bool>,
    pub suit: Option<String>,
    pub waist: Option<String>,
    pub vest: Option<String>,
    pub shirt: Option<String>,
    pub shoe: Option<String>,
    pub measured: Option<bool>,
    pub suit_ordered: Option<bool>,
    pub received: Option<bool>,
    pub fitting: Option<bool>,
    pub pickup_status: Option<String>,
    pub measure_date: Option<chrono::NaiveDate>,
    pub ordered_date: Option<chrono::NaiveDate>,
    pub received_date: Option<chrono::NaiveDate>,
    pub fitting_date: Option<chrono::NaiveDate>,
    pub pickup_date: Option<chrono::NaiveDate>,
    pub ordered_items: Option<serde_json::Value>,
    pub member_accessories: Option<serde_json::Value>,
    pub contact_history: Option<serde_json::Value>,
    pub pin_note: Option<bool>,
    pub ordered_po: Option<String>,
    pub stock_info: Option<serde_json::Value>,
    pub suit_variant_id: Option<Uuid>,
    pub is_free_suit_promo: Option<bool>,
    #[serde(default)]
    pub actor_name: Option<String>,
    /// When set (non-empty), used as the wedding_activity_log description instead of the default patch summary.
    #[serde(default)]
    pub activity_description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateNonInventoryItemRequest {
    pub wedding_party_id: Uuid,
    pub wedding_member_id: Option<Uuid>,
    pub description: String,
    pub quantity: i32,
    pub notes: Option<String>,
    #[serde(default)]
    pub actor_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateAppointmentRequest {
    /// When set, appointment is tied to this wedding member (and party is derived).
    #[serde(default)]
    pub wedding_member_id: Option<Uuid>,
    /// Optional ROS customer link (walk-in or member-linked).
    #[serde(default)]
    pub customer_id: Option<Uuid>,
    pub customer_display_name: Option<String>,
    pub phone: Option<String>,
    pub appointment_type: Option<String>,
    pub starts_at: chrono::DateTime<chrono::Utc>,
    pub notes: Option<String>,
    pub status: Option<String>,
    pub salesperson: Option<String>,
    #[serde(default)]
    pub salesperson_staff_id: Option<Uuid>,
    #[serde(default)]
    pub schedule_override_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAppointmentRequest {
    #[serde(default)]
    pub wedding_member_id: Option<Uuid>,
    #[serde(default)]
    pub customer_id: Option<Uuid>,
    pub customer_display_name: Option<String>,
    pub phone: Option<String>,
    pub appointment_type: Option<String>,
    pub starts_at: Option<chrono::DateTime<chrono::Utc>>,
    pub notes: Option<String>,
    pub status: Option<String>,
    pub salesperson: Option<String>,
    #[serde(default)]
    pub salesperson_staff_id: Option<Uuid>,
    #[serde(default)]
    pub schedule_override_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AppointmentsQuery {
    pub from: Option<String>,
    pub to: Option<String>,
}

fn parse_datetime(s: &str) -> Result<chrono::DateTime<chrono::Utc>, WeddingError> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Ok(dt.with_timezone(&chrono::Utc));
    }
    if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        return Ok(ndt.and_utc());
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        if let Some(ndt) = date.and_hms_opt(0, 0, 0) {
            return Ok(ndt.and_utc());
        }
    }
    Err(WeddingError::BadRequest("Invalid date format".into()))
}

#[derive(Debug, Deserialize)]
pub struct AttachOrderRequest {
    pub transaction_id: Uuid,
    pub wedding_party_id: Option<Uuid>,
    pub new_party_info: Option<CreatePartyRequest>,
    pub role: String,
    #[serde(default)]
    pub actor_name: Option<String>,
}

#[derive(Debug, Serialize)]
struct CutoverSummaryResponse {
    parties: Vec<CutoverPartySummary>,
}

#[derive(Debug, Serialize)]
struct CutoverPartySummary {
    party_id: Uuid,
    party_name: String,
    event_date: chrono::NaiveDate,
    salesperson: Option<String>,
    review_status: String,
    member_count: i64,
    linked_transaction_count: i64,
    candidate_transaction_count: i64,
    needs_measurements: i64,
    ntbo: i64,
    ordered: i64,
    received: i64,
    ready_for_pickup: i64,
    picked_up: i64,
}

#[derive(Debug, Serialize)]
struct CutoverPartyDetail {
    party: CutoverPartySummary,
    members: Vec<CutoverMember>,
    candidates: Vec<CutoverCandidate>,
}

#[derive(Debug, Serialize)]
struct CutoverMember {
    member_id: Uuid,
    customer_id: Option<Uuid>,
    name: String,
    role: String,
    phone: Option<String>,
    customer_verified: bool,
}

#[derive(Debug, Serialize)]
struct CutoverCandidate {
    suggested_member_id: Uuid,
    transaction_id: Uuid,
    display_id: String,
    booked_at: DateTime<Utc>,
    total_price: Decimal,
    balance_due: Decimal,
    customer_name: String,
    customer_code: Option<String>,
    confidence: String,
    reason: String,
    lines: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct CutoverLinkRequest {
    party_id: Uuid,
    member_id: Uuid,
    transaction_id: Uuid,
    #[serde(default)]
    transaction_line_ids: Vec<Uuid>,
    lifecycle_status: String,
    #[serde(default)]
    actor_name: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CutoverReviewRequest {
    status: String,
    #[serde(default)]
    actor_name: Option<String>,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CutoverRejectRequest {
    #[serde(default)]
    actor_name: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/events", get(wedding_events_stream))
        .route("/morning-compass", get(get_morning_compass))
        .route("/activity-feed", get(get_activity_feed))
        .route("/actions", get(get_actions))
        .route("/readiness-dashboard", get(get_readiness_dashboard))
        .route("/cutover/summary", get(get_cutover_summary))
        .route("/cutover/links", post(post_cutover_link))
        .route(
            "/cutover/suggestions/{suggestion_id}/reject",
            post(post_cutover_reject),
        )
        .route(
            "/non-inventory",
            get(list_non_inventory_items).post(create_non_inventory_item),
        )
        .route(
            "/non-inventory/{id}",
            patch(update_non_inventory_item).delete(delete_non_inventory_item),
        )
        .route(
            "/appointments",
            get(list_appointments).post(create_appointment),
        )
        .route("/appointments/search", get(search_appointments))
        .route(
            "/appointments/{appointment_id}",
            get(get_appointment)
                .patch(update_appointment)
                .delete(delete_appointment),
        )
        .route(
            "/customers/{customer_id}/purchase-context",
            get(get_customer_purchase_context),
        )
        .route("/parties", get(list_parties).post(create_party))
        .route("/parties/{party_id}/ledger", get(get_ledger))
        .route(
            "/parties/{party_id}/financial-context",
            get(get_party_financial_context),
        )
        .route("/parties/{party_id}/restore", post(restore_party))
        .route("/parties/{party_id}/health", get(get_health))
        .route("/parties/{party_id}/readiness", get(get_party_readiness))
        .route("/parties/{party_id}/cutover", get(get_party_cutover))
        .route(
            "/parties/{party_id}/cutover/review",
            post(post_party_cutover_review),
        )
        .route("/parties/{party_id}/members", post(add_member))
        .route(
            "/parties/{party_id}",
            get(get_party)
                .patch(update_party)
                .delete(delete_party_handler),
        )
        .route("/attach-order", post(post_attach_order))
        .route(
            "/members/{member_id}",
            get(get_member)
                .patch(update_member)
                .delete(delete_member_handler),
        )
}

async fn get_customer_purchase_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<CustomerWeddingPurchaseContext>, WeddingError> {
    middleware::require_staff_perm_or_pos_session(&state, &headers, WEDDINGS_VIEW)
        .await
        .map(|_| ())
        .map_err(map_wed_perm)?;

    let rows = sqlx::query_as::<_, CustomerWeddingPurchaseRow>(
        r#"
        SELECT
            wm.id AS wedding_member_id,
            wp.id AS wedding_party_id,
            wm.transaction_id,
            COALESCE(
                NULLIF(TRIM(wp.party_name), ''),
                NULLIF(TRIM(CONCAT_WS(' / ', NULLIF(wp.groom_name, ''), NULLIF(wp.bride_name, ''))), ''),
                'Wedding party'
            ) AS party_name,
            wp.event_date,
            wm.role,
            wm.status,
            (wp.event_date >= CURRENT_DATE) AS active,
            COALESCE(wm.measured, FALSE) AS measured,
            COALESCE(wm.suit_ordered, FALSE) AS suit_ordered,
            wm.customer_id,
            c.first_name,
            c.last_name,
            c.email AS customer_email,
            c.phone AS customer_phone,
            COALESCE(wm.is_free_suit_promo, FALSE) AS is_free_suit_promo,
            COALESCE(wm.suit_variant_id, wp.suit_variant_id) AS suit_variant_id,
            CASE
                WHEN wm.suit_variant_id IS NOT NULL THEN 'member_suit'
                WHEN wp.suit_variant_id IS NOT NULL THEN 'party_suit'
                ELSE NULL
            END AS suit_source
        FROM wedding_members wm
        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        JOIN customers c ON c.id = wm.customer_id
        WHERE wm.customer_id = $1
          AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
          AND (
              wp.event_date >= CURRENT_DATE - INTERVAL '90 days'
              OR LOWER(COALESCE(wm.status, '')) NOT IN ('picked_up', 'complete', 'completed', 'cancelled', 'canceled')
          )
        ORDER BY wp.event_date ASC, wp.created_at DESC
        "#,
    )
    .bind(customer_id)
    .fetch_all(&state.db)
    .await?;

    let mut memberships = Vec::with_capacity(rows.len());
    for row in rows {
        let mut purchase_items = Vec::new();
        if let Some(variant_id) = row.suit_variant_id {
            match resolve_variant_by_id(&state.db, variant_id, state.global_employee_markup).await {
                Ok(item) => {
                    let already_tracked: bool = sqlx::query_scalar(
                        r#"
                        SELECT EXISTS(
                            SELECT 1
                            FROM transactions t
                            JOIN transaction_lines tl ON tl.transaction_id = t.id
                            WHERE t.wedding_member_id = $1
                              AND tl.variant_id = $2
                        )
                        "#,
                    )
                    .bind(row.wedding_member_id)
                    .bind(variant_id)
                    .fetch_one(&state.db)
                    .await?;
                    purchase_items.push(CustomerWeddingPurchaseItem {
                        item,
                        source: row
                            .suit_source
                            .clone()
                            .unwrap_or_else(|| "wedding_item".to_string()),
                        already_tracked,
                    });
                }
                Err(error) => {
                    tracing::warn!(
                        error = %error,
                        %variant_id,
                        wedding_member_id = %row.wedding_member_id,
                        "wedding purchase context skipped unresolved suit variant"
                    );
                }
            }
        }
        let checklist_items = sqlx::query_as::<_, CustomerWeddingChecklistItem>(
            r#"
            SELECT id, description, quantity, status, notes
            FROM wedding_non_inventory_items
            WHERE wedding_party_id = $1
              AND (wedding_member_id IS NULL OR wedding_member_id = $2)
              AND LOWER(COALESCE(status, '')) NOT IN ('done', 'complete', 'completed', 'cancelled', 'canceled')
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .bind(row.wedding_party_id)
        .bind(row.wedding_member_id)
        .fetch_all(&state.db)
        .await?;

        memberships.push(CustomerWeddingPurchaseMembership {
            wedding_member_id: row.wedding_member_id,
            wedding_party_id: row.wedding_party_id,
            transaction_id: row.transaction_id,
            party_name: row.party_name,
            event_date: row.event_date,
            role: row.role,
            status: row.status,
            active: row.active,
            measured: row.measured,
            suit_ordered: row.suit_ordered,
            customer_id: row.customer_id,
            first_name: row.first_name,
            last_name: row.last_name,
            customer_email: row.customer_email,
            customer_phone: row.customer_phone,
            is_free_suit_promo: row.is_free_suit_promo,
            purchase_items,
            checklist_items,
        });
    }

    Ok(Json(CustomerWeddingPurchaseContext { memberships }))
}

async fn list_parties(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PartyListQuery>,
) -> Result<Json<PaginatedParties>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let (parties, total, page, limit) =
        query_party_list_page(&state.db, &q, state.meilisearch.as_ref()).await?;
    let mut out = Vec::with_capacity(parties.len());
    for p in parties {
        let members = load_members_for_party(&state.db, p.id).await?;
        out.push(build_party_bundle(p, members));
    }
    let total_pages = if total == 0 {
        0
    } else {
        (total + limit - 1) / limit
    };
    Ok(Json(PaginatedParties {
        data: out,
        pagination: Pagination {
            page,
            limit,
            total,
            total_pages,
        },
    }))
}

async fn insert_party_and_respond(
    state: &AppState,
    body: CreatePartyRequest,
    sender_id: Option<&str>,
) -> Result<Json<WeddingPartyWithMembers>, WeddingError> {
    let groom = body.groom_name.trim();
    if groom.is_empty() {
        return Err(WeddingError::BadRequest("groom_name is required".into()));
    }

    let acc = body.accessories.unwrap_or_else(|| json!({}));
    let gp = body.groom_phone.as_deref().unwrap_or("");
    let bp = body.bride_phone.as_deref().unwrap_or("");
    let gpc = if gp.is_empty() {
        None
    } else {
        Some(digits_only(gp))
    };
    let bpc = if bp.is_empty() {
        None
    } else {
        Some(digits_only(bp))
    };

    let party_type = body.party_type.as_deref().unwrap_or("Wedding").to_string();
    let cutover_review_status = normalize_cutover_status(body.cutover_review_status.clone())?;
    let is_cutover_import = cutover_review_status == "needs_review";
    let simple_customer_source = if is_cutover_import {
        "wedding_import"
    } else {
        "store"
    };

    // Handle groom and bride customer creation/linking
    let (groom_customer_id, groom_customer_verified) = if let Some(gcid) = body.groom_customer_id {
        // Link to existing customer
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
                .bind(gcid)
                .fetch_one(&state.db)
                .await?;
        if !exists {
            return Err(WeddingError::BadRequest("groom customer not found".into()));
        }
        (Some(gcid), true)
    } else if !gp.is_empty() || !groom.is_empty() {
        // Create or reuse an imported groom customer by normalized phone.
        let first = groom.split_whitespace().next().unwrap_or(groom);
        let last = groom
            .split_whitespace()
            .skip(1)
            .collect::<Vec<_>>()
            .join(" ");
        let last = if last.is_empty() {
            "Groom".to_string()
        } else {
            last
        };
        let _phone_clean = gpc.clone();

        let (cid, verified) = get_or_create_wedding_customer(
            &state.db,
            first,
            &last,
            Some(gp),
            simple_customer_source,
            !is_cutover_import,
        )
        .await?;
        (Some(cid), verified)
    } else {
        (None, true)
    };

    let bride_customer_id = if let Some(bcid) = body.bride_customer_id {
        // Link to existing customer
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
                .bind(bcid)
                .fetch_one(&state.db)
                .await?;
        if !exists {
            return Err(WeddingError::BadRequest("bride customer not found".into()));
        }
        Some(bcid)
    } else if !bp.is_empty()
        || body
            .bride_name
            .as_ref()
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    {
        // Create or reuse an imported bride customer by normalized phone.
        let bride_name = body.bride_name.as_deref().unwrap_or("").trim();
        let first = bride_name.split_whitespace().next().unwrap_or("Bride");
        let last = bride_name
            .split_whitespace()
            .skip(1)
            .collect::<Vec<_>>()
            .join(" ");
        let last = if last.is_empty() {
            "Bride".to_string()
        } else {
            last
        };

        let (cid, _) = get_or_create_wedding_customer(
            &state.db,
            first,
            &last,
            Some(bp),
            simple_customer_source,
            !is_cutover_import,
        )
        .await?;
        Some(cid)
    } else {
        None
    };

    // Create couple link if both groom and bride exist
    let couple_id = if let (Some(gid), Some(bid)) = (groom_customer_id, bride_customer_id) {
        let couple = Uuid::new_v4();
        sqlx::query(
            r#"
            UPDATE customers SET couple_id = $1, couple_primary_id = $1, couple_linked_at = NOW()
            WHERE id IN ($2, $3)
            "#,
        )
        .bind(couple)
        .bind(gid)
        .bind(bid)
        .execute(&state.db)
        .await
        .ok();
        Some(couple)
    } else {
        None
    };

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO wedding_parties (
            party_name, groom_name, event_date, venue, notes,
            party_type, sign_up_date, salesperson, style_info, price_info,
            groom_phone, groom_email, bride_name, bride_phone, bride_email,
            accessories, groom_phone_clean, bride_phone_clean, is_deleted,
            suit_variant_id, cutover_review_status
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,FALSE,$19,$20)
        RETURNING id
        "#,
    )
    .bind(&body.party_name)
    .bind(groom)
    .bind(body.event_date)
    .bind(&body.venue)
    .bind(&body.notes)
    .bind(&party_type)
    .bind(body.sign_up_date)
    .bind(&body.salesperson)
    .bind(&body.style_info)
    .bind(&body.price_info)
    .bind(&body.groom_phone)
    .bind(&body.groom_email)
    .bind(&body.bride_name)
    .bind(&body.bride_phone)
    .bind(&body.bride_email)
    .bind(acc)
    .bind(&gpc)
    .bind(&bpc)
    .bind(body.base_suit_variant_id)
    .bind(&cutover_review_status)
    .fetch_one(&state.db)
    .await?;

    // Add groom as party member
    if let Some(gcid) = groom_customer_id {
        let max_idx: Option<i32> = sqlx::query_scalar(
            "SELECT MAX(member_index) FROM wedding_members WHERE wedding_party_id = $1",
        )
        .bind(id)
        .fetch_one(&state.db)
        .await?;
        let next_idx = max_idx.unwrap_or(0) + 1;
        let _: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO wedding_members (
                wedding_party_id, customer_id, role, status, member_index, customer_verified
            )
            VALUES ($1, $2, 'Groom', 'active', $3, $4)
            RETURNING id
            "#,
        )
        .bind(id)
        .bind(gcid)
        .bind(next_idx)
        .bind(groom_customer_verified)
        .fetch_one(&state.db)
        .await?;
    }

    // NOTE: Bride is NOT a party member - just party info (stored in wedding_parties table)
    // Bride info: bride_name, bride_phone, bride_email - stored but not created as member

    let party = fetch_party_row_optional(&state.db, id)
        .await?
        .ok_or_else(|| {
            tracing::error!(party_id = %id, "party missing immediately after insert");
            WeddingError::BadRequest("Could not load party after create".into())
        })?;

    let actor = resolve_actor(body.actor_name);
    if let Err(e) = wedding_logic::insert_wedding_activity(
        &state.db,
        id,
        None,
        &actor,
        "NOTE",
        "Wedding party created",
        json!({ "party_type": party_type, "couple_id": couple_id }),
    )
    .await
    {
        tracing::warn!(error = %e, "Wedding activity log failed");
    }

    state.wedding_events.parties_updated(sender_id);

    spawn_meilisearch_wedding_party(state, id);

    Ok(Json(build_party_bundle(party, vec![])))
}

async fn create_party(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreatePartyRequest>,
) -> Result<Json<WeddingPartyWithMembers>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let sender = wedding_client_sender(&headers);
    insert_party_and_respond(&state, body, sender.as_deref()).await
}

async fn fetch_party_bundle(
    state: &AppState,
    party_id: Uuid,
) -> Result<WeddingPartyWithMembers, WeddingError> {
    let party = fetch_party_row_optional(&state.db, party_id)
        .await?
        .ok_or(WeddingError::PartyNotFound)?;
    let members = load_members_for_party(&state.db, party_id).await?;
    Ok(build_party_bundle(party, members))
}

async fn get_party(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<WeddingPartyWithMembers>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let bundle = fetch_party_bundle(&state, party_id).await?;
    Ok(Json(bundle))
}

async fn update_party(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<UpdatePartyRequest>,
) -> Result<Json<WeddingPartyWithMembers>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let log_actor = body.actor_name.clone();
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM wedding_parties WHERE id = $1)")
            .bind(party_id)
            .fetch_one(&state.db)
            .await?;
    if !exists {
        return Err(WeddingError::PartyNotFound);
    }

    let mut qb: QueryBuilder<'_, sqlx::Postgres> = QueryBuilder::new("UPDATE wedding_parties SET ");
    let mut sep = qb.separated(", ");
    let mut has_updates = false;

    if let Some(v) = &body.party_name {
        sep.push("party_name = ").push_bind_unseparated(v.clone());
        has_updates = true;
    }
    if let Some(v) = &body.groom_name {
        let t = v.trim();
        if !t.is_empty() {
            sep.push("groom_name = ")
                .push_bind_unseparated(t.to_string());
            has_updates = true;
        }
    }
    if let Some(v) = body.event_date {
        sep.push("event_date = ").push_bind_unseparated(v);
        has_updates = true;
    }
    if body.venue.is_some() {
        sep.push("venue = ")
            .push_bind_unseparated(body.venue.clone());
        has_updates = true;
    }
    if body.notes.is_some() {
        sep.push("notes = ")
            .push_bind_unseparated(body.notes.clone());
        has_updates = true;
    }
    if let Some(v) = &body.party_type {
        sep.push("party_type = ").push_bind_unseparated(v.clone());
        has_updates = true;
    }
    if body.sign_up_date.is_some() {
        sep.push("sign_up_date = ")
            .push_bind_unseparated(body.sign_up_date);
        has_updates = true;
    }
    if body.salesperson.is_some() {
        sep.push("salesperson = ")
            .push_bind_unseparated(body.salesperson.clone());
        has_updates = true;
    }
    if body.style_info.is_some() {
        sep.push("style_info = ")
            .push_bind_unseparated(body.style_info.clone());
        has_updates = true;
    }
    if body.price_info.is_some() {
        sep.push("price_info = ")
            .push_bind_unseparated(body.price_info.clone());
        has_updates = true;
    }
    if body.groom_phone.is_some() {
        let gp = body.groom_phone.clone();
        let gpc = gp.as_deref().map(digits_only).filter(|s| !s.is_empty());
        sep.push("groom_phone = ").push_bind_unseparated(gp);
        sep.push("groom_phone_clean = ").push_bind_unseparated(gpc);
        has_updates = true;
    }
    if body.groom_email.is_some() {
        sep.push("groom_email = ")
            .push_bind_unseparated(body.groom_email.clone());
        has_updates = true;
    }
    if body.bride_name.is_some() {
        sep.push("bride_name = ")
            .push_bind_unseparated(body.bride_name.clone());
        has_updates = true;
    }
    if body.bride_phone.is_some() {
        let bp = body.bride_phone.clone();
        let bpc = bp.as_deref().map(digits_only).filter(|s| !s.is_empty());
        sep.push("bride_phone = ").push_bind_unseparated(bp);
        sep.push("bride_phone_clean = ").push_bind_unseparated(bpc);
        has_updates = true;
    }
    if body.bride_email.is_some() {
        sep.push("bride_email = ")
            .push_bind_unseparated(body.bride_email.clone());
        has_updates = true;
    }
    if let Some(acc) = &body.accessories {
        sep.push("accessories = ")
            .push_bind_unseparated(acc.clone());
        has_updates = true;
    }
    if body.suit_variant_id.is_some() {
        sep.push("suit_variant_id = ")
            .push_bind_unseparated(body.suit_variant_id);
        has_updates = true;
    }

    if !has_updates {
        let bundle = fetch_party_bundle(&state, party_id).await?;
        return Ok(Json(bundle));
    }

    let fields_summary = party_patch_summary(&body);
    qb.push(" WHERE id = ").push_bind(party_id);
    qb.build().execute(&state.db).await?;

    if !fields_summary.is_empty() {
        let actor = resolve_actor(log_actor);
        let desc = format!("Party updated: {}", fields_summary.join(", "));
        if let Err(e) = wedding_logic::insert_wedding_activity(
            &state.db,
            party_id,
            None,
            &actor,
            "STATUS_CHANGE",
            &desc,
            json!({ "fields": fields_summary }),
        )
        .await
        {
            tracing::warn!(error = %e, "Wedding activity log failed");
        }
    }

    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());

    spawn_meilisearch_wedding_party(&state, party_id);

    let bundle = fetch_party_bundle(&state, party_id).await?;
    Ok(Json(bundle))
}

async fn delete_party_handler(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    Query(q): Query<ActorQuery>,
    headers: HeaderMap,
) -> Result<StatusCode, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let r = sqlx::query("UPDATE wedding_parties SET is_deleted = TRUE WHERE id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)")
        .bind(party_id)
        .execute(&state.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(WeddingError::PartyNotFound);
    }
    let actor = resolve_actor(q.actor_name);
    if let Err(e) = wedding_logic::insert_wedding_activity(
        &state.db,
        party_id,
        None,
        &actor,
        "STATUS_CHANGE",
        "Party archived",
        json!({}),
    )
    .await
    {
        tracing::warn!(error = %e, "Wedding activity log failed");
    }
    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());
    spawn_meilisearch_wedding_party(&state, party_id);
    Ok(StatusCode::NO_CONTENT)
}

async fn restore_party(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    Query(q): Query<ActorQuery>,
    headers: HeaderMap,
) -> Result<Json<WeddingPartyWithMembers>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let r = sqlx::query("UPDATE wedding_parties SET is_deleted = FALSE WHERE id = $1")
        .bind(party_id)
        .execute(&state.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(WeddingError::PartyNotFound);
    }
    let actor = resolve_actor(q.actor_name);
    if let Err(e) = wedding_logic::insert_wedding_activity(
        &state.db,
        party_id,
        None,
        &actor,
        "STATUS_CHANGE",
        "Party restored from archive",
        json!({}),
    )
    .await
    {
        tracing::warn!(error = %e, "Wedding activity log failed");
    }
    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());
    spawn_meilisearch_wedding_party(&state, party_id);
    let bundle = fetch_party_bundle(&state, party_id).await?;
    Ok(Json(bundle))
}

async fn add_member(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CreateMemberRequest>,
) -> Result<Json<WeddingMemberApi>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let pew: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM wedding_parties WHERE id = $1)")
            .bind(party_id)
            .fetch_one(&state.db)
            .await?;
    if !pew {
        return Err(WeddingError::PartyNotFound);
    }

    let (customer_id, role, notes, log_actor, import_name, import_phone, customer_verified) =
        match body {
            CreateMemberRequest::LinkExisting {
                customer_id,
                role,
                notes,
                actor_name,
            } => {
                let cust: bool =
                    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
                        .bind(customer_id)
                        .fetch_one(&state.db)
                        .await?;
                if !cust {
                    return Err(WeddingError::BadRequest("customer not found".into()));
                }
                // Linked existing customers are verified
                (customer_id, role, notes, actor_name, None, None, true)
            }
            CreateMemberRequest::SimpleCreate {
                first_name,
                last_name,
                phone,
                role,
                notes,
                import_customer_name,
                import_customer_phone,
            } => {
                let first = first_name.trim();
                let last = last_name.trim();
                if first.is_empty() || last.is_empty() {
                    return Err(WeddingError::BadRequest(
                        "first_name and last_name are required".into(),
                    ));
                }
                let phone = phone
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned);
                let import_name = import_customer_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned);
                let import_phone = import_customer_phone
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned);
                let is_import = import_name.is_some() || import_phone.is_some();
                let source = if is_import { "wedding_import" } else { "store" };
                let (cid, is_verified) = get_or_create_wedding_customer(
                    &state.db,
                    first,
                    last,
                    phone.as_deref(),
                    source,
                    !is_import,
                )
                .await?;

                // Store import tracking info
                let import_name = if is_import {
                    import_name.or_else(|| Some(format!("{first} {last}")))
                } else {
                    None
                };
                let import_phone = if is_import {
                    import_phone.or_else(|| phone.clone())
                } else {
                    None
                };

                (
                    cid,
                    role,
                    notes,
                    None,
                    import_name,
                    import_phone,
                    is_verified,
                )
            }
            CreateMemberRequest::QuickCreateCustomer(boxed) => {
                let QuickCreateMemberBody {
                    first_name,
                    last_name,
                    email,
                    phone,
                    address_line1,
                    address_line2,
                    city,
                    state: region,
                    postal_code,
                    marketing_email_opt_in,
                    marketing_sms_opt_in,
                    transactional_sms_opt_in,
                    transactional_email_opt_in,
                    role,
                    notes,
                    actor_name,
                } = *boxed;
                let first = first_name.trim();
                let last = last_name.trim();
                if first.is_empty() || last.is_empty() {
                    return Err(WeddingError::BadRequest(
                        "first_name and last_name are required".into(),
                    ));
                }
                let email = email
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned);
                let phone = phone
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned);
                let line1 = address_line1
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned);
                let line2 = address_line2
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned);
                let city_v = city
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned);
                let state_v = region
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned);
                let postal = postal_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned);
                let m_sms = marketing_sms_opt_in.unwrap_or(false);
                let t_sms = transactional_sms_opt_in.unwrap_or(m_sms);
                let m_email = marketing_email_opt_in.unwrap_or(false);
                let t_email = transactional_email_opt_in.unwrap_or(m_email);
                let cid = insert_customer(
                &state.db,
                InsertCustomerParams {
                    customer_code: None,
                    first_name: first.to_string(),
                    last_name: last.to_string(),
                    company_name: None,
                    email,
                    phone,
                    address_line1: line1,
                    address_line2: line2,
                    city: city_v,
                    state: state_v,
                    postal_code: postal,
                    date_of_birth: None,
                    anniversary_date: None,
                    custom_field_1: None,
                    custom_field_2: None,
                    custom_field_3: None,
                    custom_field_4: None,
                    marketing_email_opt_in: m_email,
                    marketing_sms_opt_in: m_sms,
                    transactional_sms_opt_in: t_sms,
                    transactional_email_opt_in: t_email,
                    customer_created_source: crate::logic::customers::CustomerCreatedSource::Store,
                },
            )
            .await
            .map_err(|e| {
                if let sqlx::Error::Database(ref d) = e {
                    if d.is_unique_violation() {
                        return WeddingError::BadRequest(
                            "email or phone conflicts with an existing customer".into(),
                        );
                    }
                    // e.g. INSERT references customer_code before migration 28 — Postgres 42703
                    if d.code().as_deref() == Some("42703") {
                        return WeddingError::BadRequest(
                            "Database schema is missing required columns (apply SQL migrations through 28_customer_profile_and_code.sql, then retry)."
                                .into(),
                        );
                    }
                }
                WeddingError::Database(e)
            })?;
                // QuickCreateCustomer - assume verified when creating full profile
                (cid, role, notes, actor_name, None, None, true)
            }
        };

    let max_idx: Option<i32> = sqlx::query_scalar(
        "SELECT MAX(member_index) FROM wedding_members WHERE wedding_party_id = $1",
    )
    .bind(party_id)
    .fetch_one(&state.db)
    .await?;
    let next_idx = max_idx.unwrap_or(0) + 1;
    let role = role
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Member")
        .to_string();

    let member_id: Uuid = match sqlx::query_scalar(
        r#"
        INSERT INTO wedding_members (
            wedding_party_id, customer_id, role, status, notes, member_index,
            customer_verified, import_customer_name, import_customer_phone
        )
        VALUES ($1, $2, $3, 'prospect', $4, $5, $6, $7, $8)
        RETURNING id
        "#,
    )
    .bind(party_id)
    .bind(customer_id)
    .bind(&role)
    .bind(&notes)
    .bind(next_idx)
    .bind(customer_verified)
    .bind(&import_name)
    .bind(&import_phone)
    .fetch_one(&state.db)
    .await
    {
        Ok(id) => id,
        Err(e) => {
            if let sqlx::Error::Database(ref d) = e {
                if d.is_unique_violation() {
                    return Err(WeddingError::BadRequest(
                        "this customer is already a member of this party".into(),
                    ));
                }
            }
            return Err(WeddingError::Database(e));
        }
    };

    let actor = resolve_actor(log_actor);
    if let Err(e) = wedding_logic::insert_wedding_activity(
        &state.db,
        party_id,
        Some(member_id),
        &actor,
        "STATUS_CHANGE",
        &format!("Member added to party (role: {role})"),
        json!({ "customer_id": customer_id, "wedding_member_id": member_id }),
    )
    .await
    {
        tracing::warn!(error = %e, "Wedding activity log failed");
    }

    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());

    spawn_meilisearch_wedding_party(&state, party_id);

    let member = fetch_member_optional(&state.db, member_id)
        .await?
        .ok_or(WeddingError::MemberNotFound)?;
    Ok(Json(member))
}

async fn update_member(
    State(state): State<AppState>,
    Path(member_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<UpdateMemberRequest>,
) -> Result<Json<WeddingMemberApi>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let log_actor = body.actor_name.clone();
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM wedding_members WHERE id = $1)")
            .bind(member_id)
            .fetch_one(&state.db)
            .await?;
    if !exists {
        return Err(WeddingError::MemberNotFound);
    }

    let patch_keys = member_patch_keys(&body);

    let mut qb: QueryBuilder<'_, sqlx::Postgres> = QueryBuilder::new("UPDATE wedding_members SET ");
    let mut sep = qb.separated(", ");
    let mut has_updates = false;

    macro_rules! opt {
        ($field:literal, $val:expr) => {
            if let Some(v) = $val {
                sep.push(concat!($field, " = ")).push_bind_unseparated(v);
                has_updates = true;
            }
        };
    }

    opt!("role", body.role);
    opt!("notes", body.notes);
    opt!("status", body.status);
    opt!("member_index", body.member_index);
    opt!("oot", body.oot);
    opt!("suit", body.suit);
    opt!("waist", body.waist);
    opt!("vest", body.vest);
    opt!("shirt", body.shirt);
    opt!("shoe", body.shoe);
    opt!("measured", body.measured);
    opt!("suit_ordered", body.suit_ordered);
    opt!("received", body.received);
    opt!("fitting", body.fitting);
    opt!("pickup_status", body.pickup_status);
    opt!("measure_date", body.measure_date);
    opt!("ordered_date", body.ordered_date);
    opt!("received_date", body.received_date);
    opt!("fitting_date", body.fitting_date);
    opt!("pickup_date", body.pickup_date);
    opt!("ordered_items", body.ordered_items);
    opt!("member_accessories", body.member_accessories);
    opt!("contact_history", body.contact_history);
    opt!("pin_note", body.pin_note);
    opt!("ordered_po", body.ordered_po);
    opt!("stock_info", body.stock_info);
    opt!("suit_variant_id", body.suit_variant_id);
    opt!("is_free_suit_promo", body.is_free_suit_promo);

    if !has_updates {
        let member = fetch_member_optional(&state.db, member_id)
            .await?
            .ok_or(WeddingError::MemberNotFound)?;
        return Ok(Json(member));
    }

    qb.push(" WHERE id = ").push_bind(member_id);
    qb.build().execute(&state.db).await?;

    if patch_keys.iter().any(|k| {
        matches!(
            k.as_str(),
            "suit" | "waist" | "vest" | "shirt" | "shoe" | "measure_date" | "measured"
        )
    }) {
        if let Err(e) = crate::logic::customer_measurements::sync_retail_from_wedding_member(
            &state.db, member_id,
        )
        .await
        {
            tracing::warn!(
                error = %e,
                wedding_member_id = %member_id,
                "customer measurement retail sync from wedding member failed"
            );
        }
    }

    if !patch_keys.is_empty() {
        let party_id: Uuid =
            sqlx::query_scalar("SELECT wedding_party_id FROM wedding_members WHERE id = $1")
                .bind(member_id)
                .fetch_one(&state.db)
                .await?;
        let actor = resolve_actor(log_actor);
        let desc = body
            .activity_description
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("Member updated: {}", patch_keys.join(", ")));
        let action_type = if patch_keys
            .iter()
            .any(|k| matches!(k.as_str(), "contact_history" | "notes"))
        {
            "NOTE"
        } else if patch_keys.iter().any(|k| {
            matches!(
                k.as_str(),
                "measured"
                    | "suit"
                    | "waist"
                    | "vest"
                    | "shirt"
                    | "shoe"
                    | "measure_date"
                    | "fitting"
                    | "fitting_date"
                    | "pickup"
                    | "pickup_date"
                    | "pickup_status"
            )
        }) {
            "MEASUREMENT"
        } else {
            "STATUS_CHANGE"
        };
        if let Err(e) = wedding_logic::insert_wedding_activity(
            &state.db,
            party_id,
            Some(member_id),
            &actor,
            action_type,
            &desc,
            json!({ "fields": patch_keys }),
        )
        .await
        {
            tracing::warn!(error = %e, "Wedding activity log failed");
        }
    }

    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());

    let party_for_meili: Uuid =
        sqlx::query_scalar("SELECT wedding_party_id FROM wedding_members WHERE id = $1")
            .bind(member_id)
            .fetch_one(&state.db)
            .await?;
    spawn_meilisearch_wedding_party(&state, party_for_meili);

    let member = fetch_member_optional(&state.db, member_id)
        .await?
        .ok_or(WeddingError::MemberNotFound)?;
    Ok(Json(member))
}

async fn delete_member_handler(
    State(state): State<AppState>,
    Path(member_id): Path<Uuid>,
    Query(q): Query<ActorQuery>,
    headers: HeaderMap,
) -> Result<StatusCode, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let mut tx = state.db.begin().await?;
    let row: Option<Uuid> =
        sqlx::query_scalar("SELECT wedding_party_id FROM wedding_members WHERE id = $1")
            .bind(member_id)
            .fetch_optional(&mut *tx)
            .await?;
    let party_id = row.ok_or(WeddingError::MemberNotFound)?;
    let actor = resolve_actor(q.actor_name);
    wedding_logic::insert_wedding_activity(
        &mut *tx,
        party_id,
        Some(member_id),
        &actor,
        "STATUS_CHANGE",
        "Member removed from party",
        json!({ "removed_wedding_member_id": member_id }),
    )
    .await?;
    let r = sqlx::query("DELETE FROM wedding_members WHERE id = $1")
        .bind(member_id)
        .execute(&mut *tx)
        .await?;
    if r.rows_affected() == 0 {
        return Err(WeddingError::MemberNotFound);
    }
    tx.commit().await?;
    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());
    spawn_meilisearch_wedding_party(&state, party_id);
    Ok(StatusCode::NO_CONTENT)
}

async fn list_appointments(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AppointmentsQuery>,
) -> Result<Json<Vec<AppointmentRow>>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let from_dt = q.from.as_ref().map(|s| parse_datetime(s)).transpose()?;
    let to_dt = q.to.as_ref().map(|s| parse_datetime(s)).transpose()?;
    let rows = list_appointments_filtered(&state.db, from_dt, to_dt).await?;
    Ok(Json(rows))
}

async fn get_appointment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(appointment_id): Path<Uuid>,
) -> Result<Json<AppointmentRow>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let row = sqlx::query_as(
        r#"
        SELECT id, wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone,
               appointment_type, starts_at, notes, status, salesperson, salesperson_staff_id
        FROM wedding_appointments
        WHERE id = $1
        "#,
    )
    .bind(appointment_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| WeddingError::BadRequest("Appointment not found".to_string()))?;
    Ok(Json(row))
}

async fn create_appointment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateAppointmentRequest>,
) -> Result<Json<AppointmentRow>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let name_ok = body
        .customer_display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let phone_ok = body
        .phone
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let (party_id, member_id, customer_id) = if let Some(mid) = body.wedding_member_id {
        let row: Option<(Uuid, Uuid)> =
            sqlx::query_as("SELECT wedding_party_id, id FROM wedding_members WHERE id = $1")
                .bind(mid)
                .fetch_optional(&state.db)
                .await?;
        let (pid, real_mid) = row.ok_or(WeddingError::MemberNotFound)?;
        (Some(pid), Some(real_mid), body.customer_id)
    } else {
        if name_ok.is_none() && phone_ok.is_none() {
            return Err(WeddingError::BadRequest(
                "Provide a wedding member, or a customer name or phone for this appointment."
                    .to_string(),
            ));
        }
        (None, None, body.customer_id)
    };

    let appt_type = body
        .appointment_type
        .as_deref()
        .unwrap_or("Measurement")
        .to_string();
    let status = body.status.as_deref().unwrap_or("Scheduled").to_string();

    let resolved_salesperson = if let Some(staff_id) = body.salesperson_staff_id {
        staff_schedule::resolve_floor_staff_name_by_id(&state.db, staff_id)
            .await?
            .or_else(|| body.salesperson.clone())
    } else {
        body.salesperson.clone()
    };

    let schedule_warning = staff_schedule::appointment_staff_booking_check(
        &state.db,
        body.salesperson_staff_id,
        resolved_salesperson.as_deref(),
        body.starts_at,
    )
    .await
    .map_err(|e| match e {
        staff_schedule::StaffScheduleError::BadRequest(m) => WeddingError::BadRequest(m),
        staff_schedule::StaffScheduleError::Database(e) => WeddingError::Database(e),
        staff_schedule::StaffScheduleError::NotFound => {
            WeddingError::BadRequest("Schedule check failed".to_string())
        }
    })?;

    let override_actor = if let Some(message) = schedule_warning.as_deref() {
        let reason = body
            .schedule_override_reason
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| WeddingError::BadRequest(message.to_string()))?;
        Some((
            require_schedule_override_actor(&state, &headers).await?,
            reason.to_string(),
            message.to_string(),
        ))
    } else {
        None
    };

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO wedding_appointments (
            wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone,
            appointment_type, starts_at, notes, status, salesperson, salesperson_staff_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING id
        "#,
    )
    .bind(party_id)
    .bind(member_id)
    .bind(customer_id)
    .bind(&body.customer_display_name)
    .bind(&body.phone)
    .bind(&appt_type)
    .bind(body.starts_at)
    .bind(&body.notes)
    .bind(&status)
    .bind(&resolved_salesperson)
    .bind(body.salesperson_staff_id)
    .fetch_one(&state.db)
    .await?;

    if let Some((actor_id, reason, message)) = override_actor {
        sqlx::query(
            r#"
            INSERT INTO appointment_schedule_override_audit (
                appointment_id, salesperson_staff_id, salesperson_name, override_reason,
                validation_message, overridden_by_staff_id
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(id)
        .bind(body.salesperson_staff_id)
        .bind(&resolved_salesperson)
        .bind(reason)
        .bind(message)
        .bind(actor_id)
        .execute(&state.db)
        .await?;
    }

    let appt: AppointmentRow = sqlx::query_as(
        r#"
        SELECT id, wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone,
               appointment_type, starts_at, notes, status, salesperson, salesperson_staff_id
        FROM wedding_appointments WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;

    let appt_email = appt.clone();
    let pool = state.db.clone();
    let http = state.http_client.clone();
    let cache = Arc::clone(&state.podium_token_cache);
    tokio::spawn(async move {
        if let Err(e) =
            MessagingService::trigger_appointment_confirmation(&pool, &http, &cache, &appt_email)
                .await
        {
            tracing::error!(error = %e, "appointment confirmation email hook failed");
        }
    });

    state
        .wedding_events
        .appointments_updated(wedding_client_sender(&headers).as_deref());

    spawn_meilisearch_appointment_upsert(&state, id);

    Ok(Json(appt))
}

async fn update_appointment(
    State(state): State<AppState>,
    Path(appointment_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<UpdateAppointmentRequest>,
) -> Result<Json<AppointmentRow>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;

    let current: AppointmentRow = sqlx::query_as(
        r#"
        SELECT id, wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone,
               appointment_type, starts_at, notes, status, salesperson, salesperson_staff_id
        FROM wedding_appointments WHERE id = $1
        "#,
    )
    .bind(appointment_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| WeddingError::BadRequest("Appointment not found".to_string()))?;

    let merged_starts = body.starts_at.unwrap_or(current.starts_at);
    let merged_salesperson_staff_id = body.salesperson_staff_id.or(current.salesperson_staff_id);
    let merged_salesperson = body.salesperson.clone().or_else(|| {
        merged_salesperson_staff_id
            .and_then(|_| None)
            .or_else(|| current.salesperson.clone())
    });
    let resolved_salesperson = if let Some(staff_id) = body.salesperson_staff_id {
        staff_schedule::resolve_floor_staff_name_by_id(&state.db, staff_id)
            .await?
            .or(merged_salesperson)
    } else {
        merged_salesperson
    };
    let schedule_warning = staff_schedule::appointment_staff_booking_check(
        &state.db,
        merged_salesperson_staff_id,
        resolved_salesperson.as_deref(),
        merged_starts,
    )
    .await
    .map_err(|e| match e {
        staff_schedule::StaffScheduleError::BadRequest(m) => WeddingError::BadRequest(m),
        staff_schedule::StaffScheduleError::Database(e) => WeddingError::Database(e),
        staff_schedule::StaffScheduleError::NotFound => {
            WeddingError::BadRequest("Schedule check failed".to_string())
        }
    })?;

    let override_actor = if let Some(message) = schedule_warning.as_deref() {
        let reason = body
            .schedule_override_reason
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| WeddingError::BadRequest(message.to_string()))?;
        Some((
            require_schedule_override_actor(&state, &headers).await?,
            reason.to_string(),
            message.to_string(),
        ))
    } else {
        None
    };

    let mut qb: QueryBuilder<'_, sqlx::Postgres> =
        QueryBuilder::new("UPDATE wedding_appointments SET ");
    let mut sep = qb.separated(", ");
    let mut has_updates = false;

    if let Some(mid) = body.wedding_member_id {
        let row: Option<(Uuid, Uuid)> =
            sqlx::query_as("SELECT wedding_party_id, id FROM wedding_members WHERE id = $1")
                .bind(mid)
                .fetch_optional(&state.db)
                .await?;
        let (party_id, real_mid) = row.ok_or(WeddingError::MemberNotFound)?;
        sep.push("wedding_party_id = ")
            .push_bind_unseparated(party_id);
        sep.push("wedding_member_id = ")
            .push_bind_unseparated(real_mid);
        has_updates = true;
    }

    macro_rules! set_opt {
        ($field:literal, $value:expr) => {
            if let Some(v) = $value {
                sep.push(concat!($field, " = ")).push_bind_unseparated(v);
                has_updates = true;
            }
        };
    }

    set_opt!("customer_id", body.customer_id);
    set_opt!("customer_display_name", body.customer_display_name);
    set_opt!("phone", body.phone);
    set_opt!("appointment_type", body.appointment_type);
    set_opt!("starts_at", body.starts_at);
    set_opt!("notes", body.notes);
    set_opt!("status", body.status);
    if let Some(staff_id) = body.salesperson_staff_id {
        sep.push("salesperson_staff_id = ")
            .push_bind_unseparated(staff_id);
        sep.push("salesperson = ")
            .push_bind_unseparated(resolved_salesperson.clone());
        has_updates = true;
    } else {
        if let Some(salesperson) = body.salesperson {
            sep.push("salesperson = ")
                .push_bind_unseparated(salesperson);
            sep.push("salesperson_staff_id = NULL");
            has_updates = true;
        }
    }

    if has_updates {
        qb.push(" WHERE id = ").push_bind(appointment_id);
        let result = qb.build().execute(&state.db).await?;
        if result.rows_affected() == 0 {
            return Err(WeddingError::BadRequest(
                "Appointment not found".to_string(),
            ));
        }
        state
            .wedding_events
            .appointments_updated(wedding_client_sender(&headers).as_deref());

        spawn_meilisearch_appointment_upsert(&state, appointment_id);
    }

    if let Some((actor_id, reason, message)) = override_actor {
        sqlx::query(
            r#"
            INSERT INTO appointment_schedule_override_audit (
                appointment_id, salesperson_staff_id, salesperson_name, override_reason,
                validation_message, overridden_by_staff_id
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(appointment_id)
        .bind(merged_salesperson_staff_id)
        .bind(&resolved_salesperson)
        .bind(reason)
        .bind(message)
        .bind(actor_id)
        .execute(&state.db)
        .await?;
    }

    let appt: AppointmentRow = sqlx::query_as(
        r#"
        SELECT id, wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone,
               appointment_type, starts_at, notes, status, salesperson, salesperson_staff_id
        FROM wedding_appointments WHERE id = $1
        "#,
    )
    .bind(appointment_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(appt))
}

async fn delete_appointment(
    State(state): State<AppState>,
    Path(appointment_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<StatusCode, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let mut tx = state.db.begin().await?;

    // Fetch before deleting so we can log it and update search index
    let existing: Option<AppointmentRow> = sqlx::query_as(
        r#"
        SELECT id, wedding_party_id, wedding_member_id, customer_id, customer_display_name,
               phone, appointment_type, starts_at, notes, status, salesperson, salesperson_staff_id
        FROM wedding_appointments WHERE id = $1
        "#,
    )
    .bind(appointment_id)
    .fetch_optional(&mut *tx)
    .await?;

    let existing =
        existing.ok_or_else(|| WeddingError::BadRequest("Appointment not found".to_string()))?;

    if let Some(party_id) = existing.wedding_party_id {
        wedding_logic::insert_wedding_activity(
            &mut *tx,
            party_id,
            existing.wedding_member_id,
            "system",
            "APPOINTMENT_DELETED",
            &format!(
                "Appointment deleted: {} on {}",
                existing.appointment_type,
                existing.starts_at.format("%Y-%m-%d %H:%M UTC"),
            ),
            json!({
                "appointment_id": appointment_id,
                "appointment_type": existing.appointment_type,
                "starts_at": existing.starts_at,
                "salesperson": existing.salesperson,
                "customer_display_name": existing.customer_display_name,
            }),
        )
        .await?;
    }

    let result = sqlx::query("DELETE FROM wedding_appointments WHERE id = $1")
        .bind(appointment_id)
        .execute(&mut *tx)
        .await?;
    if result.rows_affected() == 0 {
        return Err(WeddingError::BadRequest(
            "Appointment not found".to_string(),
        ));
    }

    tx.commit().await?;

    state
        .wedding_events
        .appointments_updated(wedding_client_sender(&headers).as_deref());
    Ok(StatusCode::NO_CONTENT)
}

pub async fn search_appointments(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<SearchQuery>,
) -> Result<Json<Vec<AppointmentRow>>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let rows = crate::logic::wedding_queries::search_appointments_hybrid(
        &state.db,
        state.meilisearch.as_ref(),
        q.q.as_deref().unwrap_or(""),
        40,
    )
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
}

async fn get_morning_compass(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<wedding_logic::MorningCompassBundle>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    wedding_logic::get_morning_compass_bundle(&state.db)
        .await
        .map(Json)
        .map_err(WeddingError::Database)
}

async fn get_activity_feed(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ActivityFeedQuery>,
) -> Result<Json<Vec<ActivityFeedRow>>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let limit = q.limit.unwrap_or(40).clamp(1, 100);
    let offset = q.offset.unwrap_or(0).max(0);
    let rows = query_activity_feed(&state.db, limit, offset).await?;
    Ok(Json(rows))
}

async fn get_actions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ActionsQuery>,
) -> Result<Json<WeddingActions>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let day_window = query.days.unwrap_or(90).clamp(1, 365);
    let actions = query_wedding_actions(&state.db, day_window).await?;
    Ok(Json(actions))
}

async fn get_member(
    State(state): State<AppState>,
    Path(member_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<WeddingMemberApi>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let row = fetch_member_optional(&state.db, member_id).await?;
    match row {
        Some(member) => Ok(Json(member)),
        None => Err(WeddingError::MemberNotFound),
    }
}

async fn get_ledger(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<WeddingLedgerResponse>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let ledger = try_load_party_ledger(&state.db, party_id)
        .await?
        .ok_or(WeddingError::PartyNotFound)?;
    Ok(Json(ledger))
}

async fn get_party_financial_context(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<WeddingPartyFinancialContext>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let ctx = try_load_party_financial_context(&state.db, party_id)
        .await?
        .ok_or(WeddingError::PartyNotFound)?;
    Ok(Json(ctx))
}

async fn create_non_inventory_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateNonInventoryItemRequest>,
) -> Result<Json<WeddingNonInventoryItem>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO wedding_non_inventory_items (
            wedding_party_id, wedding_member_id, description, quantity, notes, status
        )
        VALUES ($1, $2, $3, $4, $5, 'needed')
        RETURNING id
        "#,
    )
    .bind(body.wedding_party_id)
    .bind(body.wedding_member_id)
    .bind(&body.description)
    .bind(body.quantity)
    .bind(&body.notes)
    .fetch_one(&state.db)
    .await?;

    let actor = resolve_actor(body.actor_name);
    let desc = format!(
        "Non-inventory item added: {} (qty {})",
        body.description, body.quantity
    );
    if let Err(e) = wedding_logic::insert_wedding_activity(
        &state.db,
        body.wedding_party_id,
        body.wedding_member_id,
        &actor,
        "STATUS_CHANGE",
        &desc,
        json!({ "description": body.description, "quantity": body.quantity }),
    )
    .await
    {
        tracing::warn!(error = %e, "Wedding activity log failed");
    }

    let item: WeddingNonInventoryItem =
        sqlx::query_as("SELECT * FROM wedding_non_inventory_items WHERE id = $1")
            .bind(id)
            .fetch_one(&state.db)
            .await?;

    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());
    Ok(Json(item))
}

async fn list_non_inventory_items(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<WeddingNonInventoryItem>>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let rows = sqlx::query_as::<_, WeddingNonInventoryItem>(
        "SELECT * FROM wedding_non_inventory_items ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct UpdateNonInventoryRequest {
    pub description: Option<String>,
    pub quantity: Option<i32>,
    pub status: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub actor_name: Option<String>,
}

async fn update_non_inventory_item(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<UpdateNonInventoryRequest>,
) -> Result<Json<WeddingNonInventoryItem>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;

    let mut qb: QueryBuilder<'_, sqlx::Postgres> =
        QueryBuilder::new("UPDATE wedding_non_inventory_items SET ");
    let mut sep = qb.separated(", ");
    let mut has_updates = false;

    if let Some(v) = &body.description {
        sep.push("description = ").push_bind_unseparated(v.clone());
        has_updates = true;
    }
    if let Some(v) = body.quantity {
        sep.push("quantity = ").push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = &body.status {
        sep.push("status = ").push_bind_unseparated(v.clone());
        has_updates = true;
    }
    if let Some(v) = &body.notes {
        sep.push("notes = ").push_bind_unseparated(v.clone());
        has_updates = true;
    }

    if has_updates {
        qb.push(" WHERE id = ").push_bind(id);
        qb.build().execute(&state.db).await?;
        state
            .wedding_events
            .parties_updated(wedding_client_sender(&headers).as_deref());
    }

    let item: WeddingNonInventoryItem =
        sqlx::query_as("SELECT * FROM wedding_non_inventory_items WHERE id = $1")
            .bind(id)
            .fetch_one(&state.db)
            .await?;
    Ok(Json(item))
}

async fn delete_non_inventory_item(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<StatusCode, WeddingError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, WEDDINGS_MUTATE)
        .await
        .map_err(map_wed_perm)?;
    let mut tx = state.db.begin().await?;
    let item: Option<WeddingNonInventoryItem> =
        sqlx::query_as("SELECT * FROM wedding_non_inventory_items WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let item = item.ok_or(WeddingError::BadRequest(
        "Non-inventory item not found".to_string(),
    ))?;
    wedding_logic::insert_wedding_activity(
        &mut *tx,
        item.wedding_party_id,
        item.wedding_member_id,
        &staff.full_name,
        "STATUS_CHANGE",
        &format!(
            "Non-inventory item removed: {} (qty {})",
            item.description, item.quantity
        ),
        json!({
            "non_inventory_item_id": item.id,
            "description": item.description,
            "quantity": item.quantity,
            "status": item.status,
        }),
    )
    .await?;
    sqlx::query("DELETE FROM wedding_non_inventory_items WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());
    Ok(StatusCode::NO_CONTENT)
}

async fn post_attach_order(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AttachOrderRequest>,
) -> Result<Json<WeddingMemberApi>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let mut tx = state.db.begin().await?;

    // 1. Validate Order and get Customer
    let order_info: Option<(Option<Uuid>, Option<Uuid>)> =
        sqlx::query_as("SELECT customer_id, wedding_member_id FROM transactions WHERE id = $1")
            .bind(body.transaction_id)
            .fetch_optional(&mut *tx)
            .await?;

    let (customer_id, existing_member_id) =
        order_info.ok_or(WeddingError::BadRequest("Order not found".into()))?;
    let customer_id = customer_id.ok_or(WeddingError::BadRequest(
        "Order has no customer attached".into(),
    ))?;

    if existing_member_id.is_some() {
        return Err(WeddingError::BadRequest(
            "Order is already attached to a wedding member".into(),
        ));
    }

    // 2. Resolve Party
    let party_id = if let Some(pid) = body.wedding_party_id {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM wedding_parties WHERE id = $1)")
                .bind(pid)
                .fetch_one(&mut *tx)
                .await?;
        if !exists {
            return Err(WeddingError::PartyNotFound);
        }
        pid
    } else if let Some(new_party) = body.new_party_info {
        // Create new party
        let groom = new_party.groom_name.trim();
        if groom.is_empty() {
            return Err(WeddingError::BadRequest(
                "groom_name is required for new party".into(),
            ));
        }
        let acc = new_party.accessories.unwrap_or_else(|| json!({}));
        let gp = new_party.groom_phone.as_deref().unwrap_or("");
        let bp = new_party.bride_phone.as_deref().unwrap_or("");
        let gpc = if gp.is_empty() {
            None
        } else {
            Some(digits_only(gp))
        };
        let bpc = if bp.is_empty() {
            None
        } else {
            Some(digits_only(bp))
        };
        let party_type = new_party
            .party_type
            .as_deref()
            .unwrap_or("Wedding")
            .to_string();

        let pid: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO wedding_parties (
                party_name, groom_name, event_date, venue, notes,
                party_type, sign_up_date, salesperson, style_info, price_info,
                groom_phone, groom_email, bride_name, bride_phone, bride_email,
                accessories, groom_phone_clean, bride_phone_clean, is_deleted
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,FALSE)
            RETURNING id
            "#,
        )
        .bind(&new_party.party_name)
        .bind(groom)
        .bind(new_party.event_date)
        .bind(&new_party.venue)
        .bind(&new_party.notes)
        .bind(&party_type)
        .bind(new_party.sign_up_date)
        .bind(&new_party.salesperson)
        .bind(&new_party.style_info)
        .bind(&new_party.price_info)
        .bind(&new_party.groom_phone)
        .bind(&new_party.groom_email)
        .bind(&new_party.bride_name)
        .bind(&new_party.bride_phone)
        .bind(&new_party.bride_email)
        .bind(acc)
        .bind(&gpc)
        .bind(&bpc)
        .fetch_one(&mut *tx)
        .await?;
        pid
    } else {
        return Err(WeddingError::BadRequest(
            "Either wedding_party_id or new_party_info must be provided".into(),
        ));
    };

    // 3. Create Member
    let max_idx: Option<i32> = sqlx::query_scalar(
        "SELECT MAX(member_index) FROM wedding_members WHERE wedding_party_id = $1",
    )
    .bind(party_id)
    .fetch_one(&mut *tx)
    .await?;
    let next_idx = max_idx.unwrap_or(0) + 1;
    let role = body.role.trim();
    if role.is_empty() {
        return Err(WeddingError::BadRequest("role is required".into()));
    }

    let member_id: Uuid = match sqlx::query_scalar(
        r#"
        INSERT INTO wedding_members (
            wedding_party_id, customer_id, role, status, member_index, transaction_id
        )
        VALUES ($1, $2, $3, 'prospect', $4, $5)
        RETURNING id
        "#,
    )
    .bind(party_id)
    .bind(customer_id)
    .bind(role)
    .bind(next_idx)
    .bind(body.transaction_id)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(id) => id,
        Err(e) => {
            if let sqlx::Error::Database(ref d) = e {
                if d.is_unique_violation() {
                    return Err(WeddingError::BadRequest(
                        "this customer is already a member of this party".into(),
                    ));
                }
            }
            return Err(WeddingError::Database(e));
        }
    };

    // 4. Update Order
    sqlx::query("UPDATE transactions SET wedding_member_id = $1 WHERE id = $2")
        .bind(member_id)
        .bind(body.transaction_id)
        .execute(&mut *tx)
        .await?;

    // 5. Update Order Items to 'wedding_order'
    sqlx::query(
        r#"
        UPDATE transaction_lines
        SET fulfillment = 'wedding_order'
        WHERE transaction_id = $1 AND fulfillment = 'special_order'
        "#,
    )
    .bind(body.transaction_id)
    .execute(&mut *tx)
    .await?;

    // 6. Log Activity
    let actor = resolve_actor(body.actor_name);
    if let Err(e) = wedding_logic::insert_wedding_activity(
        &mut *tx,
        party_id,
        Some(member_id),
        &actor,
        "STATUS_CHANGE",
        &format!("Order attached to wedding party (role: {role})"),
        json!({ "transaction_id": body.transaction_id, "wedding_member_id": member_id }),
    )
    .await
    {
        tracing::warn!(error = %e, "Wedding activity log failed");
    }

    tx.commit().await?;

    // 7. Post-commit actions
    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());

    spawn_meilisearch_wedding_party(&state, party_id);
    crate::logic::meilisearch_sync::spawn_meili({
        let state = state.clone();
        let oid = body.transaction_id;
        async move {
            if let Some(c) = &state.meilisearch {
                crate::logic::meilisearch_sync::upsert_transaction_document(c, &state.db, oid)
                    .await;
            }
        }
    });

    let member = fetch_member_optional(&state.db, member_id)
        .await?
        .ok_or(WeddingError::MemberNotFound)?;
    Ok(Json(member))
}

fn parse_cutover_lifecycle(value: &str) -> Result<DbOrderItemLifecycleStatus, WeddingError> {
    match value.trim() {
        "needs_measurements" => Ok(DbOrderItemLifecycleStatus::NeedsMeasurements),
        "ntbo" => Ok(DbOrderItemLifecycleStatus::Ntbo),
        "ordered" => Ok(DbOrderItemLifecycleStatus::Ordered),
        "received" => Ok(DbOrderItemLifecycleStatus::Received),
        "ready_for_pickup" => Ok(DbOrderItemLifecycleStatus::ReadyForPickup),
        "picked_up" => Ok(DbOrderItemLifecycleStatus::PickedUp),
        _ => Err(WeddingError::BadRequest(
            "Choose a valid item status before saving.".to_string(),
        )),
    }
}

async fn load_cutover_summary(
    pool: &sqlx::PgPool,
    party_id: Option<Uuid>,
) -> Result<Vec<CutoverPartySummary>, sqlx::Error> {
    let rows = sqlx::query(
        r#"
        WITH member_counts AS (
            SELECT wedding_party_id, COUNT(*)::bigint AS member_count
            FROM wedding_members
            GROUP BY wedding_party_id
        ),
        member_signals AS (
            SELECT
                wm.wedding_party_id,
                wm.id AS wedding_member_id,
                wm.customer_id,
                NULLIF(REGEXP_REPLACE(COALESCE(c.phone, wm.import_customer_phone, ''), '[^0-9]', '', 'g'), '') AS member_phone_digits,
                NULLIF(
                    LOWER(REGEXP_REPLACE(
                        COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), wm.import_customer_name, ''),
                        '[^a-z0-9]+',
                        '',
                        'g'
                    )),
                    ''
                ) AS member_name_key
            FROM wedding_members wm
            LEFT JOIN customers c ON c.id = wm.customer_id
        ),
        candidate_counts AS (
            SELECT
                ms.wedding_party_id,
                COUNT(DISTINCT t.id)::bigint AS candidate_transaction_count
            FROM member_signals ms
            JOIN transactions t ON t.wedding_member_id IS NULL
            JOIN customers c ON c.id = t.customer_id
            WHERE t.wedding_member_id IS NULL
              AND t.status::text <> 'cancelled'
              AND (
                t.customer_id = ms.customer_id
                OR (
                    ms.member_phone_digits IS NOT NULL
                    AND LENGTH(ms.member_phone_digits) >= 7
                    AND REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = ms.member_phone_digits
                )
                OR (
                    ms.member_name_key IS NOT NULL
                    AND LENGTH(ms.member_name_key) >= 5
                    AND LOWER(REGEXP_REPLACE(COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), c.company_name, ''), '[^a-z0-9]+', '', 'g')) = ms.member_name_key
                )
              )
              AND (
                t.is_counterpoint_import = TRUE
                OR t.counterpoint_ticket_ref IS NOT NULL
                OR t.counterpoint_doc_ref IS NOT NULL
                OR EXISTS (
                    SELECT 1
                    FROM transaction_lines tl
                    WHERE tl.transaction_id = t.id
                      AND tl.fulfillment::text <> 'takeaway'
                )
              )
            GROUP BY ms.wedding_party_id
        ),
        lifecycle AS (
            SELECT
                wm.wedding_party_id,
                COUNT(DISTINCT t.id)::bigint AS linked_transaction_count,
                COUNT(*) FILTER (WHERE tl.order_lifecycle_status = 'needs_measurements')::bigint AS needs_measurements,
                COUNT(*) FILTER (WHERE tl.order_lifecycle_status = 'ntbo')::bigint AS ntbo,
                COUNT(*) FILTER (WHERE tl.order_lifecycle_status = 'ordered')::bigint AS ordered,
                COUNT(*) FILTER (WHERE tl.order_lifecycle_status = 'received')::bigint AS received,
                COUNT(*) FILTER (WHERE tl.order_lifecycle_status = 'ready_for_pickup')::bigint AS ready_for_pickup,
                COUNT(*) FILTER (WHERE tl.order_lifecycle_status = 'picked_up')::bigint AS picked_up
            FROM wedding_members wm
            JOIN transactions t ON t.wedding_member_id = wm.id
            LEFT JOIN transaction_lines tl ON tl.transaction_id = t.id AND tl.fulfillment::text <> 'takeaway'
            GROUP BY wm.wedding_party_id
        )
        SELECT
            wp.id AS party_id,
            COALESCE(NULLIF(TRIM(wp.party_name), ''), wp.groom_name, 'Wedding party') AS party_name,
            wp.event_date,
            wp.salesperson,
            COALESCE(wp.cutover_review_status, 'not_required') AS review_status,
            COALESCE(mc.member_count, 0)::bigint AS member_count,
            COALESCE(l.linked_transaction_count, 0)::bigint AS linked_transaction_count,
            COALESCE(cc.candidate_transaction_count, 0)::bigint AS candidate_transaction_count,
            COALESCE(l.needs_measurements, 0)::bigint AS needs_measurements,
            COALESCE(l.ntbo, 0)::bigint AS ntbo,
            COALESCE(l.ordered, 0)::bigint AS ordered,
            COALESCE(l.received, 0)::bigint AS received,
            COALESCE(l.ready_for_pickup, 0)::bigint AS ready_for_pickup,
            COALESCE(l.picked_up, 0)::bigint AS picked_up
        FROM wedding_parties wp
        LEFT JOIN member_counts mc ON mc.wedding_party_id = wp.id
        LEFT JOIN candidate_counts cc ON cc.wedding_party_id = wp.id
        LEFT JOIN lifecycle l ON l.wedding_party_id = wp.id
        WHERE (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
          AND ($1::uuid IS NULL OR wp.id = $1)
        ORDER BY
            CASE COALESCE(wp.cutover_review_status, 'not_required')
                WHEN 'blocked' THEN 0
                WHEN 'needs_review' THEN 1
                WHEN 'in_review' THEN 2
                WHEN 'not_required' THEN 3
                ELSE 4
            END,
            wp.event_date ASC,
            wp.created_at ASC
        "#,
    )
    .bind(party_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| CutoverPartySummary {
            party_id: row.get("party_id"),
            party_name: row.get("party_name"),
            event_date: row.get("event_date"),
            salesperson: row.get("salesperson"),
            review_status: row.get("review_status"),
            member_count: row.get("member_count"),
            linked_transaction_count: row.get("linked_transaction_count"),
            candidate_transaction_count: row.get("candidate_transaction_count"),
            needs_measurements: row.get("needs_measurements"),
            ntbo: row.get("ntbo"),
            ordered: row.get("ordered"),
            received: row.get("received"),
            ready_for_pickup: row.get("ready_for_pickup"),
            picked_up: row.get("picked_up"),
        })
        .collect())
}

async fn get_cutover_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<CutoverSummaryResponse>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let parties = load_cutover_summary(&state.db, None).await?;
    Ok(Json(CutoverSummaryResponse { parties }))
}

async fn get_party_cutover(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<CutoverPartyDetail>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let mut summaries = load_cutover_summary(&state.db, Some(party_id)).await?;
    let party = summaries.pop().ok_or(WeddingError::PartyNotFound)?;

    let member_rows = sqlx::query(
        r#"
        SELECT
            wm.id AS member_id,
            wm.customer_id,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), wm.import_customer_name, 'Wedding member') AS name,
            wm.role,
            COALESCE(NULLIF(TRIM(c.phone), ''), NULLIF(TRIM(wm.import_customer_phone), '')) AS phone,
            COALESCE(wm.customer_verified, wm.customer_id IS NOT NULL) AS customer_verified
        FROM wedding_members wm
        LEFT JOIN customers c ON c.id = wm.customer_id
        WHERE wm.wedding_party_id = $1
        ORDER BY wm.member_index ASC, wm.created_at ASC
        "#,
    )
    .bind(party_id)
    .fetch_all(&state.db)
    .await?;
    let members = member_rows
        .into_iter()
        .map(|row| CutoverMember {
            member_id: row.get("member_id"),
            customer_id: row.get("customer_id"),
            name: row.get("name"),
            role: row.get("role"),
            phone: row.get("phone"),
            customer_verified: row.get("customer_verified"),
        })
        .collect::<Vec<_>>();

    let candidate_rows = sqlx::query(
        r#"
        WITH member_signals AS (
            SELECT
                wm.id AS wedding_member_id,
                wm.customer_id,
                NULLIF(REGEXP_REPLACE(COALESCE(c.phone, wm.import_customer_phone, ''), '[^0-9]', '', 'g'), '') AS member_phone_digits,
                NULLIF(
                    LOWER(REGEXP_REPLACE(
                        COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), wm.import_customer_name, ''),
                        '[^a-z0-9]+',
                        '',
                        'g'
                    )),
                    ''
                ) AS member_name_key
            FROM wedding_members wm
            LEFT JOIN customers c ON c.id = wm.customer_id
            WHERE wm.wedding_party_id = $1
        ),
        matched AS (
            SELECT *
            FROM (
                SELECT
                    ms.wedding_member_id AS suggested_member_id,
                    t.id AS transaction_id,
                    CASE
                        WHEN t.customer_id = ms.customer_id THEN 1
                        WHEN ms.member_phone_digits IS NOT NULL
                          AND LENGTH(ms.member_phone_digits) >= 7
                          AND REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = ms.member_phone_digits THEN 2
                        ELSE 3
                    END AS match_rank,
                    CASE
                        WHEN t.customer_id = ms.customer_id THEN 'high'
                        WHEN ms.member_phone_digits IS NOT NULL
                          AND LENGTH(ms.member_phone_digits) >= 7
                          AND REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = ms.member_phone_digits THEN 'high'
                        ELSE 'medium'
                    END AS confidence,
                    CASE
                        WHEN t.customer_id = ms.customer_id THEN 'Customer on the imported Transaction Record matches this wedding member.'
                        WHEN ms.member_phone_digits IS NOT NULL
                          AND LENGTH(ms.member_phone_digits) >= 7
                          AND REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = ms.member_phone_digits THEN 'Phone number matches this wedding member.'
                        ELSE 'Customer name matches this wedding member.'
                    END AS reason,
                    ROW_NUMBER() OVER (
                        PARTITION BY ms.wedding_member_id, t.id
                        ORDER BY
                            CASE
                                WHEN t.customer_id = ms.customer_id THEN 1
                                WHEN ms.member_phone_digits IS NOT NULL
                                  AND LENGTH(ms.member_phone_digits) >= 7
                                  AND REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = ms.member_phone_digits THEN 2
                                ELSE 3
                            END
                    ) AS rn
                FROM member_signals ms
                JOIN transactions t ON t.wedding_member_id IS NULL
                JOIN customers c ON c.id = t.customer_id
                WHERE t.status::text <> 'cancelled'
                  AND (
                    t.customer_id = ms.customer_id
                    OR (
                        ms.member_phone_digits IS NOT NULL
                        AND LENGTH(ms.member_phone_digits) >= 7
                        AND REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = ms.member_phone_digits
                    )
                    OR (
                        ms.member_name_key IS NOT NULL
                        AND LENGTH(ms.member_name_key) >= 5
                        AND LOWER(REGEXP_REPLACE(COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), c.company_name, ''), '[^a-z0-9]+', '', 'g')) = ms.member_name_key
                    )
                  )
                  AND (
                    t.is_counterpoint_import = TRUE
                    OR t.counterpoint_ticket_ref IS NOT NULL
                    OR t.counterpoint_doc_ref IS NOT NULL
                    OR EXISTS (
                        SELECT 1
                        FROM transaction_lines tl_exists
                        WHERE tl_exists.transaction_id = t.id
                          AND tl_exists.fulfillment::text <> 'takeaway'
                    )
                  )
            ) ranked
            WHERE rn = 1
        )
        SELECT
            matched.suggested_member_id,
            t.id AS transaction_id,
            COALESCE(t.display_id, t.counterpoint_doc_ref, t.counterpoint_ticket_ref, t.id::text) AS display_id,
            t.booked_at,
            COALESCE(t.total_price, 0)::numeric(12,2) AS total_price,
            COALESCE(t.balance_due, 0)::numeric(12,2) AS balance_due,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), c.company_name, 'Customer') AS customer_name,
            NULLIF(TRIM(c.customer_code), '') AS customer_code,
            matched.confidence,
            matched.reason,
            COALESCE(
                jsonb_agg(
                    jsonb_build_object(
                        'line_id', tl.id,
                        'description', COALESCE(NULLIF(tl.size_specs->>'counterpoint_description', ''), p.name, pv.sku, 'Line item'),
                        'sku', COALESCE(NULLIF(pv.sku, ''), NULLIF(tl.size_specs->>'counterpoint_sku', ''), NULLIF(tl.size_specs->>'counterpoint_item_key', '')),
                        'quantity', tl.quantity,
                        'fulfillment', tl.fulfillment::text,
                        'lifecycle_status', tl.order_lifecycle_status::text
                    )
                    ORDER BY tl.line_display_id NULLS LAST, tl.id
                ) FILTER (WHERE tl.id IS NOT NULL),
                '[]'::jsonb
            ) AS lines
        FROM matched
        JOIN transactions t ON t.id = matched.transaction_id
        JOIN customers c ON c.id = t.customer_id
        LEFT JOIN transaction_lines tl ON tl.transaction_id = t.id AND tl.fulfillment::text <> 'takeaway'
        LEFT JOIN products p ON p.id = tl.product_id
        LEFT JOIN product_variants pv ON pv.id = tl.variant_id
        GROUP BY matched.suggested_member_id, matched.match_rank, matched.confidence, matched.reason, t.id, c.id
        ORDER BY matched.match_rank ASC, t.booked_at DESC, display_id ASC
        "#,
    )
    .bind(party_id)
    .fetch_all(&state.db)
    .await?;

    let candidates = candidate_rows
        .into_iter()
        .map(|row| CutoverCandidate {
            suggested_member_id: row.get("suggested_member_id"),
            transaction_id: row.get("transaction_id"),
            display_id: row.get("display_id"),
            booked_at: row.get("booked_at"),
            total_price: row.get("total_price"),
            balance_due: row.get("balance_due"),
            customer_name: row.get("customer_name"),
            customer_code: row.get("customer_code"),
            confidence: row.get("confidence"),
            reason: row.get("reason"),
            lines: row.get("lines"),
        })
        .collect::<Vec<_>>();

    Ok(Json(CutoverPartyDetail {
        party,
        members,
        candidates,
    }))
}

async fn post_cutover_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CutoverLinkRequest>,
) -> Result<Json<serde_json::Value>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let lifecycle = parse_cutover_lifecycle(&body.lifecycle_status)?;
    let actor = resolve_actor(body.actor_name.clone());
    let mut tx = state.db.begin().await?;

    let member_party: Option<Uuid> =
        sqlx::query_scalar("SELECT wedding_party_id FROM wedding_members WHERE id = $1")
            .bind(body.member_id)
            .fetch_optional(&mut *tx)
            .await?;
    if member_party != Some(body.party_id) {
        return Err(WeddingError::BadRequest(
            "Choose a member from this wedding party.".to_string(),
        ));
    }

    let existing_member_row: Option<(Option<Uuid>,)> =
        sqlx::query_as("SELECT wedding_member_id FROM transactions WHERE id = $1")
            .bind(body.transaction_id)
            .fetch_optional(&mut *tx)
            .await?;
    let existing_member = existing_member_row
        .ok_or_else(|| WeddingError::BadRequest("Transaction Record not found.".to_string()))?
        .0;
    match existing_member {
        Some(id) if id != body.member_id => {
            return Err(WeddingError::BadRequest(
                "This Transaction Record is already linked to another wedding member.".to_string(),
            ));
        }
        _ => {}
    }

    sqlx::query("UPDATE transactions SET wedding_member_id = $1 WHERE id = $2")
        .bind(body.member_id)
        .bind(body.transaction_id)
        .execute(&mut *tx)
        .await?;

    let mut line_ids = body.transaction_line_ids.clone();
    if line_ids.is_empty() {
        line_ids = sqlx::query_scalar(
            r#"
            SELECT id
            FROM transaction_lines
            WHERE transaction_id = $1
              AND fulfillment::text <> 'takeaway'
            ORDER BY line_display_id NULLS LAST, id
            "#,
        )
        .bind(body.transaction_id)
        .fetch_all(&mut *tx)
        .await?;
    }

    if !line_ids.is_empty() {
        let count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM transaction_lines
            WHERE transaction_id = $1
              AND id = ANY($2)
              AND fulfillment::text <> 'takeaway'
            "#,
        )
        .bind(body.transaction_id)
        .bind(&line_ids)
        .fetch_one(&mut *tx)
        .await?;
        if count != line_ids.len() as i64 {
            return Err(WeddingError::BadRequest(
                "One or more selected items do not belong to this Transaction Record.".to_string(),
            ));
        }

        sqlx::query(
            r#"
            UPDATE transaction_lines tl
            SET fulfillment = 'wedding_order',
                wedding_id = wm.wedding_party_id,
                wedding_date = wp.event_date
            FROM wedding_members wm
            JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
            WHERE wm.id = $1
              AND tl.transaction_id = $2
              AND tl.id = ANY($3)
              AND tl.fulfillment::text <> 'takeaway'
            "#,
        )
        .bind(body.member_id)
        .bind(body.transaction_id)
        .bind(&line_ids)
        .execute(&mut *tx)
        .await?;

        crate::logic::order_lifecycle::apply_transition_tx(
            &mut tx,
            &line_ids,
            lifecycle,
            None,
            "counterpoint_cutover_review",
            body.note.as_deref().or(Some("Wedding cutover review")),
            json!({
                "party_id": body.party_id,
                "wedding_member_id": body.member_id,
                "transaction_id": body.transaction_id,
                "actor_name": actor,
            }),
        )
        .await?;
    }

    sqlx::query(
        r#"
        UPDATE wedding_parties
        SET cutover_review_status = CASE
                WHEN cutover_review_status = 'reviewed' THEN 'reviewed'
                ELSE 'in_review'
            END
        WHERE id = $1
        "#,
    )
    .bind(body.party_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO wedding_cutover_match_suggestions (
            wedding_party_id, wedding_member_id, customer_id, transaction_id,
            transaction_line_id, confidence, reason, status, reviewed_by, reviewed_at, metadata
        )
        SELECT
            $1, $2, t.customer_id, $3, line_id, 'high',
            'Accepted during Cutover Review', 'accepted', $4, NOW(),
            jsonb_build_object('lifecycle_status', $5::text, 'note', $6::text)
        FROM transactions t
        CROSS JOIN unnest(CASE WHEN cardinality($7::uuid[]) = 0 THEN ARRAY[NULL]::uuid[] ELSE $7::uuid[] END) AS line_id
        WHERE t.id = $3
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(body.party_id)
    .bind(body.member_id)
    .bind(body.transaction_id)
    .bind(&actor)
    .bind(lifecycle.as_str())
    .bind(body.note.clone())
    .bind(&line_ids)
    .execute(&mut *tx)
    .await?;

    if let Err(e) = wedding_logic::insert_wedding_activity(
        &mut *tx,
        body.party_id,
        Some(body.member_id),
        &actor,
        "CUTOVER_REVIEW",
        "Counterpoint Transaction Record linked during cutover review",
        json!({
            "transaction_id": body.transaction_id,
            "line_count": line_ids.len(),
            "lifecycle_status": lifecycle.as_str(),
        }),
    )
    .await
    {
        tracing::warn!(error = %e, "Wedding cutover activity log failed");
    }

    tx.commit().await?;
    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());
    spawn_meilisearch_wedding_party(&state, body.party_id);
    Ok(Json(
        json!({ "status": "linked", "line_count": line_ids.len() }),
    ))
}

async fn post_party_cutover_review(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CutoverReviewRequest>,
) -> Result<Json<serde_json::Value>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let status = normalize_cutover_status(Some(body.status))?;
    if status == "not_required" {
        return Err(WeddingError::BadRequest(
            "Choose a review status before saving.".to_string(),
        ));
    }
    let actor = resolve_actor(body.actor_name.clone());
    let rows = sqlx::query(
        r#"
        UPDATE wedding_parties
        SET cutover_review_status = $2,
            cutover_reviewed_at = CASE WHEN $2 = 'reviewed' THEN NOW() ELSE cutover_reviewed_at END,
            cutover_reviewed_by = CASE WHEN $2 = 'reviewed' THEN $3 ELSE cutover_reviewed_by END,
            cutover_review_notes = $4
        WHERE id = $1
        "#,
    )
    .bind(party_id)
    .bind(&status)
    .bind(&actor)
    .bind(&body.notes)
    .execute(&state.db)
    .await?
    .rows_affected();
    if rows == 0 {
        return Err(WeddingError::PartyNotFound);
    }
    wedding_logic::insert_wedding_activity(
        &state.db,
        party_id,
        None,
        &actor,
        "CUTOVER_REVIEW",
        &format!("Cutover review marked {status}"),
        json!({ "status": status, "notes": body.notes }),
    )
    .await
    .ok();
    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());
    Ok(Json(json!({ "status": status })))
}

async fn post_cutover_reject(
    State(state): State<AppState>,
    Path(suggestion_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CutoverRejectRequest>,
) -> Result<Json<serde_json::Value>, WeddingError> {
    require_weddings_mutate(&state, &headers).await?;
    let actor = resolve_actor(body.actor_name);
    let row: Option<(Uuid, Option<Uuid>, Option<Uuid>)> = sqlx::query_as(
        r#"
        UPDATE wedding_cutover_match_suggestions
        SET status = 'rejected',
            reviewed_by = $2,
            reviewed_at = NOW(),
            metadata = metadata || jsonb_build_object('reject_reason', $3::text)
        WHERE id = $1
        RETURNING wedding_party_id, wedding_member_id, transaction_id
        "#,
    )
    .bind(suggestion_id)
    .bind(&actor)
    .bind(body.reason)
    .fetch_optional(&state.db)
    .await?;
    let Some((party_id, member_id, transaction_id)) = row else {
        return Err(WeddingError::BadRequest(
            "Suggestion not found.".to_string(),
        ));
    };
    wedding_logic::insert_wedding_activity(
        &state.db,
        party_id,
        member_id,
        &actor,
        "CUTOVER_REVIEW",
        "Cutover match suggestion rejected",
        json!({ "suggestion_id": suggestion_id, "transaction_id": transaction_id }),
    )
    .await
    .ok();
    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());
    Ok(Json(json!({ "status": "rejected" })))
}

async fn get_health(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<crate::logic::wedding_health::WeddingHealthScore>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let score = crate::logic::wedding_health::calculate_wedding_health(&state.db, party_id)
        .await
        .map_err(WeddingError::Database)?;
    Ok(Json(score))
}

#[derive(Debug, Deserialize)]
struct ReadinessDashboardQuery {
    #[serde(default)]
    start_date: Option<chrono::NaiveDate>,
    #[serde(default)]
    end_date: Option<chrono::NaiveDate>,
    #[serde(default)]
    salesperson: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

fn parse_readiness_status(
    raw: Option<&str>,
) -> Result<Option<crate::logic::wedding_health::WeddingReadinessStatus>, WeddingError> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let status = match value {
        "safe" => crate::logic::wedding_health::WeddingReadinessStatus::Safe,
        "watch" => crate::logic::wedding_health::WeddingReadinessStatus::Watch,
        "at_risk" => crate::logic::wedding_health::WeddingReadinessStatus::AtRisk,
        "critical" => crate::logic::wedding_health::WeddingReadinessStatus::Critical,
        "complete" => crate::logic::wedding_health::WeddingReadinessStatus::Complete,
        other => {
            return Err(WeddingError::BadRequest(format!(
                "unsupported readiness status: {other}"
            )));
        }
    };
    Ok(Some(status))
}

async fn get_readiness_dashboard(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReadinessDashboardQuery>,
) -> Result<Json<crate::logic::wedding_health::WeddingReadinessDashboard>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let dashboard = crate::logic::wedding_health::list_wedding_readiness_dashboard(
        &state.db,
        crate::logic::wedding_health::WeddingReadinessDashboardFilter {
            start_date: query.start_date,
            end_date: query.end_date,
            salesperson: query.salesperson,
            status: parse_readiness_status(query.status.as_deref())?,
            limit: query.limit.unwrap_or(100),
        },
    )
    .await
    .map_err(WeddingError::Database)?;
    Ok(Json(dashboard))
}

async fn get_party_readiness(
    State(state): State<AppState>,
    Path(party_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<crate::logic::wedding_health::WeddingReadinessDetail>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let readiness = crate::logic::wedding_health::calculate_wedding_readiness(&state.db, party_id)
        .await
        .map_err(WeddingError::Database)?;
    Ok(Json(readiness))
}
