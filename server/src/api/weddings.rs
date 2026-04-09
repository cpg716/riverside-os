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
use futures_core::stream::Stream;
use serde::Deserialize;
use serde_json::json;
use sqlx::QueryBuilder;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{WEDDINGS_MUTATE, WEDDINGS_VIEW};
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

pub use crate::logic::wedding_api_types::{
    ActionRow, ActivityFeedRow, AppointmentRow, PaginatedParties, Pagination, PartyListQuery,
    WeddingActions, WeddingLedgerLine, WeddingLedgerResponse, WeddingLedgerSummary,
    WeddingMemberApi, WeddingMemberFinancialRow, WeddingPartyFinancialContext, WeddingPartyRow,
    WeddingPartyWithMembers,
};

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
    #[serde(default)]
    pub actor_name: Option<String>,
    /// When set (non-empty), used as the wedding_activity_log description instead of the default patch summary.
    #[serde(default)]
    pub activity_description: Option<String>,
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
}

#[derive(Debug, Deserialize)]
pub struct UpdateAppointmentRequest {
    pub customer_display_name: Option<String>,
    pub phone: Option<String>,
    pub appointment_type: Option<String>,
    pub starts_at: Option<chrono::DateTime<chrono::Utc>>,
    pub notes: Option<String>,
    pub status: Option<String>,
    pub salesperson: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AppointmentsQuery {
    pub from: Option<chrono::DateTime<chrono::Utc>>,
    pub to: Option<chrono::DateTime<chrono::Utc>>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/events", get(wedding_events_stream))
        .route("/morning-compass", get(get_morning_compass))
        .route("/activity-feed", get(get_activity_feed))
        .route("/actions", get(get_actions))
        .route(
            "/appointments",
            get(list_appointments).post(create_appointment),
        )
        .route(
            "/appointments/{appointment_id}",
            patch(update_appointment).delete(delete_appointment),
        )
        .route("/parties", get(list_parties).post(create_party))
        .route("/parties/{party_id}/ledger", get(get_ledger))
        .route(
            "/parties/{party_id}/financial-context",
            get(get_party_financial_context),
        )
        .route("/parties/{party_id}/restore", post(restore_party))
        .route("/parties/{party_id}/members", post(add_member))
        .route(
            "/parties/{party_id}",
            get(get_party)
                .patch(update_party)
                .delete(delete_party_handler),
        )
        .route(
            "/members/{member_id}",
            get(get_member)
                .patch(update_member)
                .delete(delete_member_handler),
        )
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

    let id: Uuid = sqlx::query_scalar(
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
    .fetch_one(&state.db)
    .await?;

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
        json!({ "party_type": party_type }),
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
        sep.push("party_name = ").push_bind(v.clone());
        has_updates = true;
    }
    if let Some(v) = &body.groom_name {
        let t = v.trim();
        if !t.is_empty() {
            sep.push("groom_name = ").push_bind(t.to_string());
            has_updates = true;
        }
    }
    if let Some(v) = body.event_date {
        sep.push("event_date = ").push_bind(v);
        has_updates = true;
    }
    if body.venue.is_some() {
        sep.push("venue = ").push_bind(body.venue.clone());
        has_updates = true;
    }
    if body.notes.is_some() {
        sep.push("notes = ").push_bind(body.notes.clone());
        has_updates = true;
    }
    if let Some(v) = &body.party_type {
        sep.push("party_type = ").push_bind(v.clone());
        has_updates = true;
    }
    if body.sign_up_date.is_some() {
        sep.push("sign_up_date = ").push_bind(body.sign_up_date);
        has_updates = true;
    }
    if body.salesperson.is_some() {
        sep.push("salesperson = ")
            .push_bind(body.salesperson.clone());
        has_updates = true;
    }
    if body.style_info.is_some() {
        sep.push("style_info = ").push_bind(body.style_info.clone());
        has_updates = true;
    }
    if body.price_info.is_some() {
        sep.push("price_info = ").push_bind(body.price_info.clone());
        has_updates = true;
    }
    if body.groom_phone.is_some() {
        let gp = body.groom_phone.clone();
        let gpc = gp.as_deref().map(digits_only).filter(|s| !s.is_empty());
        sep.push("groom_phone = ").push_bind(gp);
        sep.push("groom_phone_clean = ").push_bind(gpc);
        has_updates = true;
    }
    if body.groom_email.is_some() {
        sep.push("groom_email = ")
            .push_bind(body.groom_email.clone());
        has_updates = true;
    }
    if body.bride_name.is_some() {
        sep.push("bride_name = ").push_bind(body.bride_name.clone());
        has_updates = true;
    }
    if body.bride_phone.is_some() {
        let bp = body.bride_phone.clone();
        let bpc = bp.as_deref().map(digits_only).filter(|s| !s.is_empty());
        sep.push("bride_phone = ").push_bind(bp);
        sep.push("bride_phone_clean = ").push_bind(bpc);
        has_updates = true;
    }
    if body.bride_email.is_some() {
        sep.push("bride_email = ")
            .push_bind(body.bride_email.clone());
        has_updates = true;
    }
    if let Some(acc) = &body.accessories {
        sep.push("accessories = ").push_bind(acc.clone());
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

    let (customer_id, role, notes, log_actor) = match body {
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
            (customer_id, role, notes, actor_name)
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
            (cid, role, notes, actor_name)
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
            wedding_party_id, customer_id, role, status, notes, member_index
        )
        VALUES ($1, $2, $3, 'prospect', $4, $5)
        RETURNING id
        "#,
    )
    .bind(party_id)
    .bind(customer_id)
    .bind(&role)
    .bind(&notes)
    .bind(next_idx)
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
                sep.push(concat!($field, " = ")).push_bind(v);
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
    let row: Option<Uuid> =
        sqlx::query_scalar("SELECT wedding_party_id FROM wedding_members WHERE id = $1")
            .bind(member_id)
            .fetch_optional(&state.db)
            .await?;
    let party_id = row.ok_or(WeddingError::MemberNotFound)?;
    let actor = resolve_actor(q.actor_name);
    if let Err(e) = wedding_logic::insert_wedding_activity(
        &state.db,
        party_id,
        Some(member_id),
        &actor,
        "STATUS_CHANGE",
        "Member removed from party",
        json!({ "removed_wedding_member_id": member_id }),
    )
    .await
    {
        tracing::warn!(error = %e, "Wedding activity log failed");
    }
    let r = sqlx::query("DELETE FROM wedding_members WHERE id = $1")
        .bind(member_id)
        .execute(&state.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(WeddingError::MemberNotFound);
    }
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
    let rows = list_appointments_filtered(&state.db, q.from, q.to).await?;
    Ok(Json(rows))
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

    staff_schedule::ensure_salesperson_booking_allowed(
        &state.db,
        body.salesperson.as_deref(),
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

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO wedding_appointments (
            wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone,
            appointment_type, starts_at, notes, status, salesperson
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
    .bind(&body.salesperson)
    .fetch_one(&state.db)
    .await?;

    let appt: AppointmentRow = sqlx::query_as(
        r#"
        SELECT id, wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone,
               appointment_type, starts_at, notes, status, salesperson
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
               appointment_type, starts_at, notes, status, salesperson
        FROM wedding_appointments WHERE id = $1
        "#,
    )
    .bind(appointment_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| WeddingError::BadRequest("Appointment not found".to_string()))?;

    let merged_starts = body.starts_at.unwrap_or(current.starts_at);
    let merged_salesperson = body
        .salesperson
        .clone()
        .or_else(|| current.salesperson.clone());
    staff_schedule::ensure_salesperson_booking_allowed(
        &state.db,
        merged_salesperson.as_deref(),
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

    let mut qb: QueryBuilder<'_, sqlx::Postgres> =
        QueryBuilder::new("UPDATE wedding_appointments SET ");
    let mut sep = qb.separated(", ");
    let mut has_updates = false;

    macro_rules! set_opt {
        ($field:literal, $value:expr) => {
            if let Some(v) = $value {
                sep.push(concat!($field, " = ")).push_bind(v);
                has_updates = true;
            }
        };
    }

    set_opt!("customer_display_name", body.customer_display_name);
    set_opt!("phone", body.phone);
    set_opt!("appointment_type", body.appointment_type);
    set_opt!("starts_at", body.starts_at);
    set_opt!("notes", body.notes);
    set_opt!("status", body.status);
    set_opt!("salesperson", body.salesperson);

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
    }

    let appt: AppointmentRow = sqlx::query_as(
        r#"
        SELECT id, wedding_party_id, wedding_member_id, customer_id, customer_display_name, phone,
               appointment_type, starts_at, notes, status, salesperson
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
    let result = sqlx::query("DELETE FROM wedding_appointments WHERE id = $1")
        .bind(appointment_id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(WeddingError::BadRequest(
            "Appointment not found".to_string(),
        ));
    }
    state
        .wedding_events
        .appointments_updated(wedding_client_sender(&headers).as_deref());
    Ok(StatusCode::NO_CONTENT)
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
