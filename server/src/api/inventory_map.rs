use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{delete, get},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{CATALOG_EDIT, CATALOG_VIEW};
use crate::middleware::require_staff_with_permission;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct MapLayout {
    pub id: Uuid,
    pub name: String,
    pub layout_data: serde_json::Value,
    pub is_active: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct MapLocation {
    pub id: Uuid,
    pub layout_id: Uuid,
    pub name: String,
    pub zone_type: String,
    pub geometry: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct CreateLayoutRequest {
    pub name: String,
    pub layout_data: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct CreateLocationRequest {
    pub layout_id: Uuid,
    pub name: String,
    pub zone_type: String, // 'sales_floor', 'backroom', 'display', 'receiving'
    pub geometry: serde_json::Value,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/layouts", get(list_layouts).post(create_layout))
        .route("/layouts/{id}", delete(delete_layout))
        .route("/locations", get(list_locations).post(create_location))
        .route("/locations/{id}", delete(delete_location))
}

async fn list_layouts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<MapLayout>>, (StatusCode, Json<serde_json::Value>)> {
    require_staff_with_permission(&state, &headers, CATALOG_VIEW).await?;
    let rows = sqlx::query_as::<_, MapLayout>(
        "SELECT * FROM inventory_map_layouts WHERE is_active = true ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
    })?;
    Ok(Json(rows))
}

async fn create_layout(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateLayoutRequest>,
) -> Result<Json<MapLayout>, (StatusCode, Json<serde_json::Value>)> {
    require_staff_with_permission(&state, &headers, CATALOG_EDIT).await?;
    let row = sqlx::query_as::<_, MapLayout>(
        "INSERT INTO inventory_map_layouts (name, layout_data) VALUES ($1, $2) RETURNING *",
    )
    .bind(payload.name)
    .bind(payload.layout_data.unwrap_or(json!({})))
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
    })?;
    Ok(Json(row))
}

async fn delete_layout(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    require_staff_with_permission(&state, &headers, CATALOG_EDIT).await?;
    sqlx::query("UPDATE inventory_map_layouts SET is_active = false WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": e.to_string()})),
            )
        })?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_locations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<MapLocation>>, (StatusCode, Json<serde_json::Value>)> {
    require_staff_with_permission(&state, &headers, CATALOG_VIEW).await?;
    let rows = sqlx::query_as::<_, MapLocation>(
        "SELECT id, layout_id, name, zone_type, geometry FROM inventory_locations",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
    })?;
    Ok(Json(rows))
}

async fn create_location(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateLocationRequest>,
) -> Result<Json<MapLocation>, (StatusCode, Json<serde_json::Value>)> {
    require_staff_with_permission(&state, &headers, CATALOG_EDIT).await?;
    let row = sqlx::query_as::<_, MapLocation>(
        "INSERT INTO inventory_locations (layout_id, name, zone_type, geometry) VALUES ($1, $2, $3, $4) RETURNING id, layout_id, name, zone_type, geometry"
    )
    .bind(payload.layout_id)
    .bind(payload.name)
    .bind(payload.zone_type)
    .bind(payload.geometry)
    .fetch_one(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e.to_string()}))))?;
    Ok(Json(row))
}

async fn delete_location(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    require_staff_with_permission(&state, &headers, CATALOG_EDIT).await?;
    sqlx::query("DELETE FROM inventory_locations WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": e.to_string()})),
            )
        })?;
    Ok(StatusCode::NO_CONTENT)
}
