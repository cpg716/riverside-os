use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{CATALOG_EDIT, CATALOG_VIEW};
use crate::middleware;

// ── Error ────────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum WebCatError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Not found")]
    NotFound,
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("Conflict: {0}")]
    Conflict(String),
}

impl IntoResponse for WebCatError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            WebCatError::NotFound => (StatusCode::NOT_FOUND, "Web category not found".to_string()),
            WebCatError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            WebCatError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            WebCatError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            WebCatError::Conflict(m) => (StatusCode::CONFLICT, m),
            WebCatError::Database(e) => {
                tracing::error!(error = %e, "Database error in web_categories");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string())
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

fn map_perm(e: (StatusCode, Json<Value>)) -> WebCatError {
    let (st, Json(v)) = e;
    let msg = v.get("error").and_then(|x| x.as_str()).unwrap_or("not authorized").to_string();
    match st {
        StatusCode::UNAUTHORIZED => WebCatError::Unauthorized(msg),
        StatusCode::FORBIDDEN => WebCatError::Forbidden(msg),
        _ => WebCatError::InvalidPayload(msg),
    }
}

async fn require_view(state: &AppState, headers: &HeaderMap) -> Result<(), WebCatError> {
    middleware::require_staff_with_permission(state, headers, CATALOG_VIEW)
        .await
        .map(|_| ())
        .map_err(map_perm)
}

async fn require_edit(state: &AppState, headers: &HeaderMap) -> Result<(), WebCatError> {
    middleware::require_staff_with_permission(state, headers, CATALOG_EDIT)
        .await
        .map(|_| ())
        .map_err(map_perm)
}

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, FromRow)]
struct WebCategory {
    id: Uuid,
    parent_id: Option<Uuid>,
    name: String,
    slug: String,
    description: Option<String>,
    sort_order: i32,
    is_active: bool,
}

#[derive(Debug, Deserialize)]
struct CreateWebCategoryBody {
    name: String,
    slug: String,
    parent_id: Option<Uuid>,
    description: Option<String>,
    sort_order: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct PatchWebCategoryBody {
    name: Option<String>,
    slug: Option<String>,
    parent_id: Option<Uuid>,
    #[serde(default)]
    clear_parent_id: bool,
    description: Option<String>,
    #[serde(default)]
    clear_description: bool,
    sort_order: Option<i32>,
    is_active: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct SetProductWebCategoriesBody {
    web_category_ids: Vec<Uuid>,
}

// ── Router ───────────────────────────────────────────────────────────────────

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_web_categories))
        .route("/", post(create_web_category))
        .route("/{id}", patch(patch_web_category))
        .route("/{id}", delete(delete_web_category))
}

/// Sub-router merged into `/api/products/{product_id}/web-categories`
pub fn product_subrouter() -> Router<AppState> {
    Router::new()
        .route("/", get(get_product_web_categories))
        .route("/", post(set_product_web_categories))
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async fn list_web_categories(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, WebCatError> {
    require_view(&state, &headers).await?;
    let rows = sqlx::query_as::<_, WebCategory>(
        "SELECT id, parent_id, name, slug, description, sort_order, is_active FROM web_categories ORDER BY sort_order, name",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "web_categories": rows })))
}

async fn create_web_category(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateWebCategoryBody>,
) -> Result<Json<Value>, WebCatError> {
    require_edit(&state, &headers).await?;
    let name = body.name.trim().to_string();
    let slug = body.slug.trim().to_lowercase();
    if name.is_empty() || slug.is_empty() {
        return Err(WebCatError::InvalidPayload("name and slug are required".to_string()));
    }
    if let Some(pid) = body.parent_id {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM web_categories WHERE id = $1)")
            .bind(pid)
            .fetch_one(&state.db)
            .await?;
        if !exists {
            return Err(WebCatError::InvalidPayload("parent_id not found".to_string()));
        }
    }
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO web_categories (name, slug, parent_id, description, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(&name)
    .bind(&slug)
    .bind(body.parent_id)
    .bind(body.description.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(body.sort_order.unwrap_or(0))
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("web_categories_slug_unique") {
            WebCatError::Conflict("slug already in use".to_string())
        } else {
            WebCatError::Database(e)
        }
    })?;
    Ok(Json(json!({ "id": id, "status": "created" })))
}

async fn patch_web_category(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PatchWebCategoryBody>,
) -> Result<Json<Value>, WebCatError> {
    require_edit(&state, &headers).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM web_categories WHERE id = $1)")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(WebCatError::NotFound);
    }
    sqlx::query(
        r#"
        UPDATE web_categories SET
            name = COALESCE($2, name),
            slug = COALESCE($3, slug),
            parent_id = CASE WHEN $4 THEN NULL ELSE COALESCE($5, parent_id) END,
            description = CASE WHEN $6 THEN NULL ELSE COALESCE($7, description) END,
            sort_order = COALESCE($8, sort_order),
            is_active = COALESCE($9, is_active),
            updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(id)
    .bind(body.name.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(body.slug.as_deref().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()))
    .bind(body.clear_parent_id)
    .bind(body.parent_id)
    .bind(body.clear_description)
    .bind(body.description.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(body.sort_order)
    .bind(body.is_active)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "status": "updated" })))
}

async fn delete_web_category(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Value>, WebCatError> {
    require_edit(&state, &headers).await?;
    sqlx::query("DELETE FROM web_categories WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "status": "deleted" })))
}

// ── Product web category assignment ──────────────────────────────────────────

async fn get_product_web_categories(
    State(state): State<AppState>,
    Path(product_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Value>, WebCatError> {
    require_view(&state, &headers).await?;
    let rows = sqlx::query_as::<_, WebCategory>(
        r#"
        SELECT wc.id, wc.parent_id, wc.name, wc.slug, wc.description, wc.sort_order, wc.is_active
        FROM web_categories wc
        JOIN product_web_categories pwc ON pwc.web_category_id = wc.id
        WHERE pwc.product_id = $1
        ORDER BY pwc.sort_order, wc.name
        "#,
    )
    .bind(product_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "web_categories": rows })))
}

async fn set_product_web_categories(
    State(state): State<AppState>,
    Path(product_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<SetProductWebCategoriesBody>,
) -> Result<Json<Value>, WebCatError> {
    require_edit(&state, &headers).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM product_web_categories WHERE product_id = $1")
        .bind(product_id)
        .execute(&mut *tx)
        .await?;
    for (i, cat_id) in body.web_category_ids.iter().enumerate() {
        sqlx::query(
            "INSERT INTO product_web_categories (product_id, web_category_id, sort_order) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(product_id)
        .bind(cat_id)
        .bind(i as i32)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "status": "updated", "count": body.web_category_ids.len() })))
}
