//! Alteration work orders (tailoring / fittings).

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch},
    Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::types::Json as SqlxJson;
use sqlx::FromRow;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::ALTERATIONS_MANAGE;
use crate::auth::pins::AuthenticatedStaff;
use crate::logic::messaging::MessagingService;
use crate::middleware;

#[derive(Debug, Serialize, FromRow)]
pub struct AlterationOrderRow {
    pub id: Uuid,
    pub customer_id: Uuid,
    pub customer_first_name: Option<String>,
    pub customer_last_name: Option<String>,
    pub customer_code: Option<String>,
    pub customer_phone: Option<String>,
    pub customer_email: Option<String>,
    pub customer_address_line1: Option<String>,
    pub customer_city: Option<String>,
    pub customer_state: Option<String>,
    pub customer_postal_code: Option<String>,
    pub wedding_member_id: Option<Uuid>,
    pub status: String,
    pub due_at: Option<DateTime<Utc>>,
    pub fitting_at: Option<DateTime<Utc>>,
    pub appointment_id: Option<Uuid>,
    pub total_units_jacket: i32,
    pub total_units_pant: i32,
    pub notes: Option<String>,
    pub linked_transaction_id: Option<Uuid>,
    pub linked_transaction_display_id: Option<String>,
    pub source_type: Option<String>,
    pub item_description: Option<String>,
    pub work_requested: Option<String>,
    pub source_product_id: Option<Uuid>,
    pub source_variant_id: Option<Uuid>,
    pub source_sku: Option<String>,
    pub source_transaction_id: Option<Uuid>,
    pub source_transaction_line_id: Option<Uuid>,
    pub charge_amount: Option<Decimal>,
    pub charge_transaction_line_id: Option<Uuid>,
    pub intake_channel: String,
    pub source_snapshot: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct AlterationOrderItemRow {
    pub id: Uuid,
    pub alteration_order_id: Uuid,
    pub label: String,
    pub capacity_bucket: String,
    pub units: i32,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ListAlterationsQuery {
    pub status: Option<String>,
    pub customer_id: Option<Uuid>,
    pub search: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateAlterationBody {
    pub customer_id: Uuid,
    pub wedding_member_id: Option<Uuid>,
    pub due_at: Option<DateTime<Utc>>,
    pub notes: Option<String>,
    pub linked_transaction_id: Option<Uuid>,
    pub source_type: Option<String>,
    pub item_description: Option<String>,
    pub work_requested: Option<String>,
    pub source_product_id: Option<Uuid>,
    pub source_variant_id: Option<Uuid>,
    pub source_sku: Option<String>,
    pub source_transaction_id: Option<Uuid>,
    pub source_transaction_line_id: Option<Uuid>,
    pub charge_amount: Option<Decimal>,
    pub charge_transaction_line_id: Option<Uuid>,
    pub intake_channel: Option<String>,
    pub source_snapshot: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct PatchAlterationBody {
    pub status: Option<String>,
    pub due_at: Option<DateTime<Utc>>,
    pub fitting_at: Option<DateTime<Utc>>,
    pub appointment_id: Option<Uuid>,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateOrderItemBody {
    pub label: String,
    pub capacity_bucket: String,
    pub units: i32,
}

const VALID_ALTERATION_STATUSES: &[&str] = &["intake", "in_work", "ready", "picked_up"];
const VALID_ALTERATION_SOURCE_TYPES: &[&str] = &[
    "current_cart_item",
    "past_transaction_line",
    "catalog_item",
    "custom_item",
];
const VALID_ALTERATION_INTAKE_CHANNELS: &[&str] = &["standalone", "pos_register"];

fn normalize_alteration_status(status: &str) -> Result<&str, AlterationError> {
    let trimmed = status.trim();
    if VALID_ALTERATION_STATUSES.contains(&trimmed) {
        return Ok(trimmed);
    }
    Err(AlterationError::BadRequest(format!(
        "invalid status '{trimmed}'. Expected one of: {}",
        VALID_ALTERATION_STATUSES.join(", ")
    )))
}

fn normalize_alteration_source_type(source_type: &str) -> Result<&str, AlterationError> {
    let trimmed = source_type.trim();
    if VALID_ALTERATION_SOURCE_TYPES.contains(&trimmed) {
        return Ok(trimmed);
    }
    Err(AlterationError::BadRequest(format!(
        "invalid source_type '{trimmed}'. Expected one of: {}",
        VALID_ALTERATION_SOURCE_TYPES.join(", ")
    )))
}

fn normalize_alteration_intake_channel(channel: Option<&str>) -> Result<&str, AlterationError> {
    let trimmed = channel
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("standalone");
    if VALID_ALTERATION_INTAKE_CHANNELS.contains(&trimmed) {
        return Ok(trimmed);
    }
    Err(AlterationError::BadRequest(format!(
        "invalid intake_channel '{trimmed}'. Expected one of: {}",
        VALID_ALTERATION_INTAKE_CHANNELS.join(", ")
    )))
}

fn trim_optional_text(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn digits_only(value: &str) -> String {
    value.chars().filter(|c| c.is_ascii_digit()).collect()
}

fn spawn_meilisearch_alteration_upsert(state: &AppState, alteration_id: Uuid) {
    let Some(client) = state.meilisearch.clone() else {
        return;
    };
    let pool = state.db.clone();
    crate::logic::meilisearch_sync::spawn_meili(async move {
        crate::logic::meilisearch_sync::upsert_alteration_document(&client, &pool, alteration_id)
            .await;
    });
}

#[derive(Debug)]
struct ValidatedAlterationCreate {
    source_type: Option<String>,
    intake_channel: String,
    item_description: Option<String>,
    work_requested: Option<String>,
    source_sku: Option<String>,
    notes: Option<String>,
}

fn validate_alteration_create(
    body: &CreateAlterationBody,
) -> Result<ValidatedAlterationCreate, AlterationError> {
    let source_type = body
        .source_type
        .as_deref()
        .map(normalize_alteration_source_type)
        .transpose()?
        .map(str::to_string);
    let intake_channel =
        normalize_alteration_intake_channel(body.intake_channel.as_deref())?.to_string();
    let item_description = trim_optional_text(&body.item_description);
    let work_requested = trim_optional_text(&body.work_requested);
    let source_sku = trim_optional_text(&body.source_sku);
    let notes = trim_optional_text(&body.notes);

    if source_type.as_deref() == Some("custom_item") && item_description.is_none() {
        return Err(AlterationError::BadRequest(
            "custom_item alterations require item_description".to_string(),
        ));
    }

    if let Some(amount) = body.charge_amount {
        if amount < Decimal::ZERO {
            return Err(AlterationError::BadRequest(
                "charge_amount must be non-negative".to_string(),
            ));
        }
    }

    if body.charge_transaction_line_id.is_some() {
        return Err(AlterationError::BadRequest(
            "charge_transaction_line_id is created by checkout integration and must be null in this phase"
                .to_string(),
        ));
    }

    Ok(ValidatedAlterationCreate {
        source_type,
        intake_channel,
        item_description,
        work_requested,
        source_sku,
        notes,
    })
}

#[derive(Debug, thiserror::Error)]
enum AlterationError {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("not found")]
    NotFound,
}

impl IntoResponse for AlterationError {
    fn into_response(self) -> Response {
        let (code, msg) = match self {
            AlterationError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AlterationError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            AlterationError::NotFound => (StatusCode::NOT_FOUND, "Not found".to_string()),
            AlterationError::Db(e) => {
                tracing::error!(error = %e, "alterations database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal error".to_string(),
                )
            }
        };
        (code, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_alterations).post(create_alteration))
        .route("/capacity", get(get_capacity))
        .route("/suggest-slots", get(get_suggested_slots))
        .route("/{id}", patch(patch_alteration))
        .route(
            "/{id}/items",
            get(list_alteration_items).post(add_alteration_item),
        )
        .route(
            "/{id}/items/{item_id}",
            patch(patch_alteration_item).delete(delete_alteration_item),
        )
}

#[derive(Debug, Deserialize)]
pub struct CapacityQuery {
    pub start: NaiveDate,
    pub end: NaiveDate,
}

#[derive(Debug, Deserialize)]
pub struct SuggestSlotsQuery {
    pub jacket_units: i32,
    pub pant_units: i32,
    pub due_date: NaiveDate,
}

async fn get_capacity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<CapacityQuery>,
) -> Result<Json<Vec<crate::logic::alterations_scheduler::CapacitySummary>>, AlterationError> {
    let _staff = require_manage(&state, &headers).await?;
    let cap =
        crate::logic::alterations_scheduler::get_capacity_for_range(&state.db, q.start, q.end)
            .await?;
    Ok(Json(cap))
}

async fn get_suggested_slots(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<SuggestSlotsQuery>,
) -> Result<Json<Vec<crate::logic::alterations_scheduler::SuggestedSlot>>, AlterationError> {
    let _staff = require_manage(&state, &headers).await?;
    let slots = crate::logic::alterations_scheduler::find_suggested_slots(
        &state.db,
        q.jacket_units,
        q.pant_units,
        q.due_date,
        10,
    )
    .await?;
    Ok(Json(slots))
}

async fn list_alteration_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<AlterationOrderItemRow>>, AlterationError> {
    let _staff = require_manage(&state, &headers).await?;
    let rows = sqlx::query_as::<_, AlterationOrderItemRow>(
        "SELECT id, alteration_order_id, label, capacity_bucket::text, units, completed_at, created_at 
         FROM alteration_order_items WHERE alteration_order_id = $1 ORDER BY created_at ASC"
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn add_alteration_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<CreateOrderItemBody>,
) -> Result<Json<AlterationOrderItemRow>, AlterationError> {
    let _staff = require_manage(&state, &headers).await?;

    let mut tx = state.db.begin().await?;

    let item_id: Uuid = sqlx::query_scalar(
        "INSERT INTO alteration_order_items (alteration_order_id, label, capacity_bucket, units) 
         VALUES ($1, $2, $3::alteration_bucket, $4) RETURNING id",
    )
    .bind(id)
    .bind(&body.label)
    .bind(&body.capacity_bucket)
    .bind(body.units)
    .fetch_one(&mut *tx)
    .await?;

    crate::logic::alterations_scheduler::update_order_unit_totals(&state.db, id).await?;

    let row = sqlx::query_as::<_, AlterationOrderItemRow>(
        "SELECT id, alteration_order_id, label, capacity_bucket::text, units, completed_at, created_at 
         FROM alteration_order_items WHERE id = $1"
    )
    .bind(item_id)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
pub struct PatchOrderItemBody {
    pub completed_at: Option<Option<DateTime<Utc>>>,
}

async fn patch_alteration_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, item_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<PatchOrderItemBody>,
) -> Result<Json<AlterationOrderItemRow>, AlterationError> {
    let _staff = require_manage(&state, &headers).await?;

    if let Some(completed_at) = body.completed_at {
        sqlx::query("UPDATE alteration_order_items SET completed_at = $1 WHERE id = $2 AND alteration_order_id = $3")
            .bind(completed_at)
            .bind(item_id)
            .bind(id)
            .execute(&state.db)
            .await?;
    }

    let row = sqlx::query_as::<_, AlterationOrderItemRow>(
        "SELECT id, alteration_order_id, label, capacity_bucket::text, units, completed_at, created_at 
         FROM alteration_order_items WHERE id = $1"
    )
    .bind(item_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row))
}

async fn delete_alteration_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, item_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, AlterationError> {
    let _staff = require_manage(&state, &headers).await?;

    let mut tx = state.db.begin().await?;

    sqlx::query("DELETE FROM alteration_order_items WHERE id = $1 AND alteration_order_id = $2")
        .bind(item_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;

    crate::logic::alterations_scheduler::update_order_unit_totals(&state.db, id).await?;

    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn require_manage(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthenticatedStaff, AlterationError> {
    middleware::require_staff_with_permission(state, headers, ALTERATIONS_MANAGE)
        .await
        .map_err(|(_c, axum::Json(v))| {
            AlterationError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("not authorized")
                    .to_string(),
            )
        })
}

async fn list_alterations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListAlterationsQuery>,
) -> Result<Json<Vec<AlterationOrderRow>>, AlterationError> {
    let _staff = require_manage(&state, &headers).await?;

    let st = q
        .status
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let search = q
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let raw_search = q
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let search_digits = raw_search
        .as_deref()
        .map(digits_only)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let mut meili_ids: Option<Vec<Uuid>> = None;
    if let (Some(client), Some(query_text)) = (state.meilisearch.as_ref(), raw_search.as_deref()) {
        match crate::logic::meilisearch_search::alteration_search_ids(client, query_text, false)
            .await
        {
            Ok(ids) => {
                if ids.is_empty() {
                    return Ok(Json(Vec::new()));
                }
                meili_ids = Some(ids);
            }
            Err(e) => {
                tracing::warn!(error = %e, "Meilisearch alteration search failed; using PostgreSQL ILIKE");
            }
        }
    }
    let sql_search = if meili_ids.is_some() { None } else { search };

    let rows = sqlx::query_as::<_, AlterationOrderRow>(
        r#"
        SELECT a.id, a.customer_id, c.first_name as customer_first_name, c.last_name as customer_last_name, 
               c.customer_code, c.phone AS customer_phone, c.email AS customer_email,
               c.address_line1 AS customer_address_line1, c.city AS customer_city,
               c.state AS customer_state, c.postal_code AS customer_postal_code,
               a.wedding_member_id, a.status::text AS status,
               a.due_at, a.fitting_at, a.appointment_id,
               a.total_units_jacket, a.total_units_pant,
               a.notes, a.transaction_id AS linked_transaction_id,
               lt.display_id AS linked_transaction_display_id,
               a.source_type::text AS source_type, a.item_description, a.work_requested,
               a.source_product_id, a.source_variant_id, a.source_sku,
               a.source_transaction_id, a.source_transaction_line_id,
               a.charge_amount, a.charge_transaction_line_id,
               a.intake_channel::text AS intake_channel, a.source_snapshot,
               a.created_at, a.updated_at
        FROM alteration_orders a
        LEFT JOIN customers c ON a.customer_id = c.id
        LEFT JOIN transactions lt ON lt.id = COALESCE(a.transaction_id, a.source_transaction_id)
        WHERE ($1::uuid IS NULL OR a.customer_id = $1)
          AND ($2::text IS NULL OR a.status::text = $2)
          AND ($5::uuid[] IS NULL OR a.id = ANY($5))
          AND (
            $3::text IS NULL
            OR a.id::text ILIKE $3
            OR COALESCE(c.first_name, '') ILIKE $3
            OR COALESCE(c.last_name, '') ILIKE $3
            OR CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, '')) ILIKE $3
            OR COALESCE(c.customer_code, '') ILIKE $3
            OR COALESCE(c.phone, '') ILIKE $3
            OR COALESCE(c.email, '') ILIKE $3
            OR COALESCE(c.address_line1, '') ILIKE $3
            OR COALESCE(c.city, '') ILIKE $3
            OR COALESCE(c.state, '') ILIKE $3
            OR COALESCE(c.postal_code, '') ILIKE $3
            OR COALESCE(a.notes, '') ILIKE $3
            OR COALESCE(a.item_description, '') ILIKE $3
            OR COALESCE(a.work_requested, '') ILIKE $3
            OR COALESCE(a.source_sku, '') ILIKE $3
            OR (
              $4::text IS NOT NULL
              AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') ILIKE $4
            )
          )
        ORDER BY a.created_at DESC
        LIMIT 200
        "#,
    )
    .bind(q.customer_id)
    .bind(st)
    .bind(sql_search)
    .bind(search_digits)
    .bind(meili_ids.as_deref())
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

async fn create_alteration(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateAlterationBody>,
) -> Result<Json<AlterationOrderRow>, AlterationError> {
    let staff = require_manage(&state, &headers).await?;

    let ok: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(body.customer_id)
        .fetch_one(&state.db)
        .await?;
    if !ok {
        return Err(AlterationError::BadRequest(
            "customer not found".to_string(),
        ));
    }

    let validated = validate_alteration_create(&body)?;
    let source_snapshot = body.source_snapshot.clone().map(SqlxJson);

    let mut tx = state.db.begin().await?;

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO alteration_orders (
            customer_id, wedding_member_id, due_at, notes, transaction_id,
            source_type, item_description, work_requested,
            source_product_id, source_variant_id, source_sku,
            source_transaction_id, source_transaction_line_id,
            charge_amount, charge_transaction_line_id,
            intake_channel, source_snapshot
        )
        VALUES (
            $1, $2, $3, $4, $5,
            $6::alteration_source_type, $7, $8,
            $9, $10, $11,
            $12, $13,
            $14, $15,
            $16::alteration_intake_channel, $17
        )
        RETURNING id
        "#,
    )
    .bind(body.customer_id)
    .bind(body.wedding_member_id)
    .bind(body.due_at)
    .bind(validated.notes.as_deref())
    .bind(body.linked_transaction_id)
    .bind(validated.source_type.as_deref())
    .bind(validated.item_description.as_deref())
    .bind(validated.work_requested.as_deref())
    .bind(body.source_product_id)
    .bind(body.source_variant_id)
    .bind(validated.source_sku.as_deref())
    .bind(body.source_transaction_id)
    .bind(body.source_transaction_line_id)
    .bind(body.charge_amount)
    .bind(body.charge_transaction_line_id)
    .bind(validated.intake_channel.as_str())
    .bind(source_snapshot)
    .fetch_one(&mut *tx)
    .await?;

    let detail = json!({
        "customer_id": body.customer_id,
        "wedding_member_id": body.wedding_member_id,
        "due_at": body.due_at.map(|d| d.to_rfc3339()),
        "notes_set": validated.notes.is_some(),
        "linked_transaction_id": body.linked_transaction_id,
        "source_type": validated.source_type,
        "item_description": validated.item_description,
        "work_requested": validated.work_requested,
        "source_product_id": body.source_product_id,
        "source_variant_id": body.source_variant_id,
        "source_sku": validated.source_sku,
        "source_transaction_id": body.source_transaction_id,
        "source_transaction_line_id": body.source_transaction_line_id,
        "charge_amount": body.charge_amount.map(|amount| amount.to_string()),
        "charge_transaction_line_id": body.charge_transaction_line_id,
        "intake_channel": validated.intake_channel,
        "source_snapshot_set": body.source_snapshot.is_some(),
    });
    sqlx::query(
        r#"
        INSERT INTO alteration_activity (alteration_id, staff_id, action, detail)
        VALUES ($1, $2, 'create', $3)
        "#,
    )
    .bind(id)
    .bind(staff.id)
    .bind(SqlxJson(detail))
    .execute(&mut *tx)
    .await?;

    let row = sqlx::query_as::<_, AlterationOrderRow>(
        r#"
        SELECT a.id, a.customer_id, c.first_name as customer_first_name, c.last_name as customer_last_name, 
               c.customer_code, c.phone AS customer_phone, c.email AS customer_email,
               c.address_line1 AS customer_address_line1, c.city AS customer_city,
               c.state AS customer_state, c.postal_code AS customer_postal_code,
               a.wedding_member_id, a.status::text AS status,
               a.due_at, a.fitting_at, a.appointment_id,
               a.total_units_jacket, a.total_units_pant,
               a.notes, a.transaction_id AS linked_transaction_id,
               lt.display_id AS linked_transaction_display_id,
               a.source_type::text AS source_type, a.item_description, a.work_requested,
               a.source_product_id, a.source_variant_id, a.source_sku,
               a.source_transaction_id, a.source_transaction_line_id,
               a.charge_amount, a.charge_transaction_line_id,
               a.intake_channel::text AS intake_channel, a.source_snapshot,
               a.created_at, a.updated_at
        FROM alteration_orders a
        LEFT JOIN customers c ON a.customer_id = c.id
        LEFT JOIN transactions lt ON lt.id = COALESCE(a.transaction_id, a.source_transaction_id)
        WHERE a.id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AlterationError::NotFound)?;

    tx.commit().await?;
    spawn_meilisearch_alteration_upsert(&state, row.id);

    Ok(Json(row))
}

async fn patch_alteration(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchAlterationBody>,
) -> Result<Json<AlterationOrderRow>, AlterationError> {
    let staff = require_manage(&state, &headers).await?;

    let normalized_status = body
        .status
        .as_deref()
        .map(normalize_alteration_status)
        .transpose()?;

    let notes_trimmed = body.notes.as_ref().map(|n| n.trim().to_string());

    let mut tx = state.db.begin().await?;

    let prev_status: Option<String> =
        sqlx::query_scalar("SELECT status::text FROM alteration_orders WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;

    if prev_status.is_none() {
        return Err(AlterationError::NotFound);
    }

    let will_change = body.status.is_some() || body.due_at.is_some() || body.notes.is_some();
    if !will_change {
        return Err(AlterationError::BadRequest(
            "no fields to update".to_string(),
        ));
    }

    if let Some(status) = normalized_status {
        sqlx::query("UPDATE alteration_orders SET status = $1::alteration_status, updated_at = now() WHERE id = $2")
            .bind(status)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    if body.due_at.is_some() {
        sqlx::query("UPDATE alteration_orders SET due_at = $1, updated_at = now() WHERE id = $2")
            .bind(body.due_at)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    if body.fitting_at.is_some() {
        sqlx::query(
            "UPDATE alteration_orders SET fitting_at = $1, updated_at = now() WHERE id = $2",
        )
        .bind(body.fitting_at)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }

    if body.appointment_id.is_some() {
        sqlx::query(
            "UPDATE alteration_orders SET appointment_id = $1, updated_at = now() WHERE id = $2",
        )
        .bind(body.appointment_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }

    if let Some(ref n) = notes_trimmed {
        sqlx::query("UPDATE alteration_orders SET notes = $1, updated_at = now() WHERE id = $2")
            .bind(n)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    let row = sqlx::query_as::<_, AlterationOrderRow>(
        r#"
        SELECT a.id, a.customer_id, c.first_name as customer_first_name, c.last_name as customer_last_name, 
               c.customer_code, c.phone AS customer_phone, c.email AS customer_email,
               c.address_line1 AS customer_address_line1, c.city AS customer_city,
               c.state AS customer_state, c.postal_code AS customer_postal_code,
               a.wedding_member_id, a.status::text AS status,
               a.due_at, a.fitting_at, a.appointment_id,
               a.total_units_jacket, a.total_units_pant,
               a.notes, a.transaction_id AS linked_transaction_id,
               lt.display_id AS linked_transaction_display_id,
               a.source_type::text AS source_type, a.item_description, a.work_requested,
               a.source_product_id, a.source_variant_id, a.source_sku,
               a.source_transaction_id, a.source_transaction_line_id,
               a.charge_amount, a.charge_transaction_line_id,
               a.intake_channel::text AS intake_channel, a.source_snapshot,
               a.created_at, a.updated_at
        FROM alteration_orders a
        LEFT JOIN customers c ON a.customer_id = c.id
        LEFT JOIN transactions lt ON lt.id = COALESCE(a.transaction_id, a.source_transaction_id)
        WHERE a.id = $1
        "#,
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;

    let detail = json!({
        "status": normalized_status,
        "due_at": body.due_at.map(|d| d.to_rfc3339()),
        "notes_set": body.notes.is_some(),
    });
    sqlx::query(
        r#"
        INSERT INTO alteration_activity (alteration_id, staff_id, action, detail)
        VALUES ($1, $2, 'patch', $3)
        "#,
    )
    .bind(id)
    .bind(staff.id)
    .bind(SqlxJson(detail))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    spawn_meilisearch_alteration_upsert(&state, row.id);

    if row.status == "ready" && prev_status.as_deref() != Some("ready") {
        let pool = state.db.clone();
        let http = state.http_client.clone();
        let podium_cache = state.podium_token_cache.clone();
        let cid = row.customer_id;
        let aid = row.id;
        tokio::spawn(async move {
            if let Err(e) =
                MessagingService::trigger_alteration_ready(&pool, &http, &podium_cache, cid, aid)
                    .await
            {
                tracing::warn!(error = %e, "alteration ready messaging failed");
            }
        });
    }

    Ok(Json(row))
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_alteration_intake_channel, normalize_alteration_source_type,
        normalize_alteration_status, validate_alteration_create, CreateAlterationBody,
    };
    use rust_decimal::Decimal;
    use uuid::Uuid;

    #[test]
    fn normalize_alteration_status_accepts_known_values() {
        for status in ["intake", "in_work", "ready", "picked_up"] {
            assert_eq!(normalize_alteration_status(status).unwrap(), status);
        }
    }

    #[test]
    fn normalize_alteration_status_trims_known_values() {
        assert_eq!(normalize_alteration_status(" ready ").unwrap(), "ready");
    }

    #[test]
    fn normalize_alteration_status_rejects_unknown_values() {
        let err = normalize_alteration_status("finished").unwrap_err();
        assert!(err.to_string().contains("invalid status"));
        assert!(err.to_string().contains("intake"));
    }

    #[test]
    fn normalize_alteration_source_type_accepts_known_values() {
        for source_type in [
            "current_cart_item",
            "past_transaction_line",
            "catalog_item",
            "custom_item",
        ] {
            assert_eq!(
                normalize_alteration_source_type(source_type).unwrap(),
                source_type
            );
        }
    }

    #[test]
    fn normalize_alteration_source_type_rejects_unknown_values() {
        let err = normalize_alteration_source_type("barcode_ticket").unwrap_err();
        assert!(err.to_string().contains("invalid source_type"));
        assert!(err.to_string().contains("custom_item"));
    }

    #[test]
    fn normalize_alteration_intake_channel_defaults_to_standalone() {
        assert_eq!(
            normalize_alteration_intake_channel(None).unwrap(),
            "standalone"
        );
        assert_eq!(
            normalize_alteration_intake_channel(Some(" ")).unwrap(),
            "standalone"
        );
    }

    #[test]
    fn validate_alteration_create_allows_existing_simple_standalone_payload() {
        let body = CreateAlterationBody {
            customer_id: Uuid::new_v4(),
            wedding_member_id: None,
            due_at: None,
            notes: Some(" hem pants ".to_string()),
            linked_transaction_id: None,
            source_type: None,
            item_description: None,
            work_requested: None,
            source_product_id: None,
            source_variant_id: None,
            source_sku: None,
            source_transaction_id: None,
            source_transaction_line_id: None,
            charge_amount: None,
            charge_transaction_line_id: None,
            intake_channel: None,
            source_snapshot: None,
        };

        let validated = validate_alteration_create(&body).unwrap();
        assert_eq!(validated.source_type, None);
        assert_eq!(validated.intake_channel, "standalone");
        assert_eq!(validated.notes.as_deref(), Some("hem pants"));
    }

    #[test]
    fn validate_alteration_create_requires_custom_item_description() {
        let body = CreateAlterationBody {
            customer_id: Uuid::new_v4(),
            wedding_member_id: None,
            due_at: None,
            notes: None,
            linked_transaction_id: None,
            source_type: Some("custom_item".to_string()),
            item_description: Some(" ".to_string()),
            work_requested: Some("Shorten sleeves".to_string()),
            source_product_id: None,
            source_variant_id: None,
            source_sku: None,
            source_transaction_id: None,
            source_transaction_line_id: None,
            charge_amount: None,
            charge_transaction_line_id: None,
            intake_channel: None,
            source_snapshot: None,
        };

        let err = validate_alteration_create(&body).unwrap_err();
        assert!(err.to_string().contains("item_description"));
    }

    #[test]
    fn validate_alteration_create_rejects_negative_charge_amount() {
        let body = CreateAlterationBody {
            customer_id: Uuid::new_v4(),
            wedding_member_id: None,
            due_at: None,
            notes: None,
            linked_transaction_id: None,
            source_type: Some("catalog_item".to_string()),
            item_description: None,
            work_requested: None,
            source_product_id: None,
            source_variant_id: None,
            source_sku: Some("ABC-123".to_string()),
            source_transaction_id: None,
            source_transaction_line_id: None,
            charge_amount: Some(Decimal::new(-1, 2)),
            charge_transaction_line_id: None,
            intake_channel: None,
            source_snapshot: None,
        };

        let err = validate_alteration_create(&body).unwrap_err();
        assert!(err.to_string().contains("non-negative"));
    }

    #[test]
    fn validate_alteration_create_rejects_charge_transaction_line_in_phase_one() {
        let body = CreateAlterationBody {
            customer_id: Uuid::new_v4(),
            wedding_member_id: None,
            due_at: None,
            notes: None,
            linked_transaction_id: None,
            source_type: Some("catalog_item".to_string()),
            item_description: None,
            work_requested: None,
            source_product_id: None,
            source_variant_id: None,
            source_sku: Some("ABC-123".to_string()),
            source_transaction_id: None,
            source_transaction_line_id: None,
            charge_amount: Some(Decimal::ZERO),
            charge_transaction_line_id: Some(Uuid::new_v4()),
            intake_channel: None,
            source_snapshot: None,
        };

        let err = validate_alteration_create(&body).unwrap_err();
        assert!(err.to_string().contains("charge_transaction_line_id"));
    }
}
