// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use super::helpers::{
    require_weddings_mutate, require_weddings_view, resolve_actor, wedding_client_sender,
};
use super::WeddingError;
use super::WeddingNonInventoryItem;
use crate::api::AppState;
use crate::logic::weddings as wedding_logic;
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::QueryBuilder;
use uuid::Uuid;

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
pub struct UpdateNonInventoryRequest {
    pub description: Option<String>,
    pub quantity: Option<i32>,
    pub status: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub actor_name: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/non-inventory",
            get(list_non_inventory_items).post(create_non_inventory_item),
        )
        .route(
            "/non-inventory/{id}",
            patch_route(update_non_inventory_item).delete(delete_non_inventory_item),
        )
}

// Helper for patch because patch is a keyword in some contexts or I just want to be explicit
use axum::routing::patch as patch_route;

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
        sep.push("description = ").push_bind(v.clone());
        has_updates = true;
    }
    if let Some(v) = body.quantity {
        sep.push("quantity = ").push_bind(v);
        has_updates = true;
    }
    if let Some(v) = &body.status {
        sep.push("status = ").push_bind(v.clone());
        has_updates = true;
    }
    if let Some(v) = &body.notes {
        sep.push("notes = ").push_bind(v.clone());
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
    require_weddings_mutate(&state, &headers).await?;
    sqlx::query("DELETE FROM wedding_non_inventory_items WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    state
        .wedding_events
        .parties_updated(wedding_client_sender(&headers).as_deref());
    Ok(StatusCode::NO_CONTENT)
}
