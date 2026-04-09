use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{CATALOG_EDIT, CATALOG_VIEW};
use crate::middleware;

#[derive(Debug, Error)]
pub enum CategoryError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Category not found")]
    NotFound,
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
}

fn map_cat_perm(e: (StatusCode, axum::Json<serde_json::Value>)) -> CategoryError {
    let (st, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match st {
        StatusCode::UNAUTHORIZED => CategoryError::Unauthorized(msg),
        StatusCode::FORBIDDEN => CategoryError::Forbidden(msg),
        _ => CategoryError::InvalidPayload(msg),
    }
}

async fn require_cat(
    state: &AppState,
    headers: &HeaderMap,
    key: &'static str,
) -> Result<(), CategoryError> {
    middleware::require_staff_with_permission(state, headers, key)
        .await
        .map(|_| ())
        .map_err(map_cat_perm)
}

impl IntoResponse for CategoryError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            CategoryError::NotFound => (StatusCode::NOT_FOUND, "Category not found".to_string()),
            CategoryError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            CategoryError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            CategoryError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            CategoryError::Database(e) => {
                tracing::error!(error = %e, "Database error in categories");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

#[derive(Debug, Serialize, FromRow)]
pub struct Category {
    pub id: Uuid,
    pub name: String,
    pub is_clothing_footwear: bool,
    pub parent_id: Option<Uuid>,
    /// JSON key for inventory matrix rows (e.g. `Neck`, `Waist`).
    pub matrix_row_axis_key: Option<String>,
    /// JSON key for inventory matrix columns (e.g. `Sleeve`, `Inseam`).
    pub matrix_col_axis_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateCategoryRequest {
    pub name: String,
    pub is_clothing_footwear: Option<bool>,
    pub parent_id: Option<Uuid>,
    pub changed_by_staff_id: Option<Uuid>,
    pub change_note: Option<String>,
    #[serde(default)]
    pub matrix_row_axis_key: Option<String>,
    #[serde(default)]
    pub matrix_col_axis_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCategoryRequest {
    pub name: Option<String>,
    pub is_clothing_footwear: Option<bool>,
    pub parent_id: Option<Uuid>,
    pub changed_by_staff_id: Option<Uuid>,
    pub change_note: Option<String>,
    /// When `Some("")`, clears the key in the database.
    #[serde(default)]
    pub matrix_row_axis_key: Option<String>,
    #[serde(default)]
    pub matrix_col_axis_key: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CategoryTaxResolution {
    pub category_id: Uuid,
    pub inherited_from_category_id: Option<Uuid>,
    pub is_clothing_footwear: bool,
}

#[derive(Debug, Deserialize)]
pub struct CategoryAuditQuery {
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CategoryAuditEntry {
    pub id: Uuid,
    pub category_id: Uuid,
    pub category_name: String,
    pub changed_field: String,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub changed_by: Option<Uuid>,
    pub changed_by_name: Option<String>,
    pub change_note: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_categories).post(create_category))
        .route("/tree", get(get_category_tree))
        .route("/audit", get(list_category_audit))
        .route("/{category_id}", axum::routing::patch(update_category))
        .route("/resolve-tax/{category_id}", get(resolve_category_tax))
}

#[derive(Debug, Serialize, Clone)]
pub struct CategoryNode {
    pub id: Uuid,
    pub name: String,
    pub is_clothing_footwear: bool,
    pub parent_id: Option<Uuid>,
    pub matrix_row_axis_key: Option<String>,
    pub matrix_col_axis_key: Option<String>,
    pub children: Vec<CategoryNode>,
}

async fn list_categories(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Category>>, CategoryError> {
    require_cat(&state, &headers, CATALOG_VIEW).await?;
    let categories = sqlx::query_as::<_, Category>(
        r#"
        SELECT id, name, is_clothing_footwear, parent_id, matrix_row_axis_key, matrix_col_axis_key
        FROM categories
        ORDER BY name
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(categories))
}

async fn get_category_tree(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<CategoryNode>>, CategoryError> {
    require_cat(&state, &headers, CATALOG_VIEW).await?;
    let rows = sqlx::query_as::<_, Category>(
        r#"
        SELECT id, name, is_clothing_footwear, parent_id, matrix_row_axis_key, matrix_col_axis_key
        FROM categories
        ORDER BY name
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    use std::collections::HashMap;
    let mut by_id: HashMap<Uuid, Category> = HashMap::new();
    let mut children_by_parent: HashMap<Option<Uuid>, Vec<Uuid>> = HashMap::new();
    for row in rows {
        children_by_parent
            .entry(row.parent_id)
            .or_default()
            .push(row.id);
        by_id.insert(row.id, row);
    }

    fn build_node(
        id: Uuid,
        by_id: &std::collections::HashMap<Uuid, Category>,
        children_by_parent: &std::collections::HashMap<Option<Uuid>, Vec<Uuid>>,
    ) -> Option<CategoryNode> {
        let base = by_id.get(&id)?;
        let child_ids = children_by_parent
            .get(&Some(id))
            .cloned()
            .unwrap_or_default();
        let children = child_ids
            .into_iter()
            .filter_map(|child_id| build_node(child_id, by_id, children_by_parent))
            .collect();
        Some(CategoryNode {
            id: base.id,
            name: base.name.clone(),
            is_clothing_footwear: base.is_clothing_footwear,
            parent_id: base.parent_id,
            matrix_row_axis_key: base.matrix_row_axis_key.clone(),
            matrix_col_axis_key: base.matrix_col_axis_key.clone(),
            children,
        })
    }

    let root_ids = children_by_parent.get(&None).cloned().unwrap_or_default();
    let tree: Vec<CategoryNode> = root_ids
        .into_iter()
        .filter_map(|id| build_node(id, &by_id, &children_by_parent))
        .collect();

    Ok(Json(tree))
}

async fn list_category_audit(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<CategoryAuditQuery>,
) -> Result<Json<Vec<CategoryAuditEntry>>, CategoryError> {
    require_cat(&state, &headers, CATALOG_VIEW).await?;
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let rows = sqlx::query_as::<_, CategoryAuditEntry>(
        r#"
        SELECT
            a.id,
            a.category_id,
            c.name AS category_name,
            a.changed_field,
            a.old_value,
            a.new_value,
            a.changed_by,
            s.full_name AS changed_by_name,
            a.change_note,
            a.created_at
        FROM category_audit_log a
        JOIN categories c ON c.id = a.category_id
        LEFT JOIN staff s ON s.id = a.changed_by
        ORDER BY a.created_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

fn normalize_axis_key(s: Option<&str>) -> Option<String> {
    s.and_then(|t| {
        let t = t.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    })
}

async fn create_category(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateCategoryRequest>,
) -> Result<Json<Category>, CategoryError> {
    require_cat(&state, &headers, CATALOG_EDIT).await?;
    let name = payload.name.trim();
    if name.is_empty() {
        return Err(CategoryError::InvalidPayload(
            "name is required".to_string(),
        ));
    }

    let row_key = normalize_axis_key(payload.matrix_row_axis_key.as_deref());
    let col_key = normalize_axis_key(payload.matrix_col_axis_key.as_deref());

    let mut tx = state.db.begin().await?;

    let category = sqlx::query_as::<_, Category>(
        r#"
        INSERT INTO categories (name, is_clothing_footwear, parent_id, matrix_row_axis_key, matrix_col_axis_key)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, is_clothing_footwear, parent_id, matrix_row_axis_key, matrix_col_axis_key
        "#,
    )
    .bind(name)
    .bind(payload.is_clothing_footwear.unwrap_or(false))
    .bind(payload.parent_id)
    .bind(row_key)
    .bind(col_key)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO category_audit_log
            (category_id, changed_field, old_value, new_value, changed_by, change_note)
        VALUES ($1, 'created', NULL, $2, $3, $4)
        "#,
    )
    .bind(category.id)
    .bind(category.name.as_str())
    .bind(payload.changed_by_staff_id)
    .bind(
        payload
            .change_note
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Category created from Category & Tax Manager"),
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(Json(category))
}

async fn resolve_category_tax(
    State(state): State<AppState>,
    Path(category_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<CategoryTaxResolution>, CategoryError> {
    require_cat(&state, &headers, CATALOG_VIEW).await?;
    let mut current = Some(category_id);
    let mut inherited_from = None;
    let mut resolved = false;

    while let Some(id) = current {
        let row = sqlx::query_as::<_, Category>(
            r#"
            SELECT id, name, is_clothing_footwear, parent_id, matrix_row_axis_key, matrix_col_axis_key
            FROM categories
            WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(&state.db)
        .await?;

        let category = match row {
            Some(c) => c,
            None if id == category_id => return Err(CategoryError::NotFound),
            None => break,
        };

        if category.is_clothing_footwear {
            inherited_from = Some(category.id);
            resolved = true;
            break;
        }
        current = category.parent_id;
    }

    Ok(Json(CategoryTaxResolution {
        category_id,
        inherited_from_category_id: inherited_from,
        is_clothing_footwear: resolved,
    }))
}

async fn update_category(
    State(state): State<AppState>,
    Path(category_id): Path<Uuid>,
    headers: HeaderMap,
    Json(payload): Json<UpdateCategoryRequest>,
) -> Result<Json<Category>, CategoryError> {
    require_cat(&state, &headers, CATALOG_EDIT).await?;
    let existing = sqlx::query_as::<_, Category>(
        r#"
        SELECT id, name, is_clothing_footwear, parent_id, matrix_row_axis_key, matrix_col_axis_key
        FROM categories
        WHERE id = $1
        "#,
    )
    .bind(category_id)
    .fetch_optional(&state.db)
    .await?;

    let Some(existing) = existing else {
        return Err(CategoryError::NotFound);
    };

    let next_name = payload
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(existing.name.as_str())
        .to_string();
    let next_is_clothing = payload
        .is_clothing_footwear
        .unwrap_or(existing.is_clothing_footwear);
    let next_parent_id = payload.parent_id.or(existing.parent_id);

    let next_matrix_row = match &payload.matrix_row_axis_key {
        None => existing.matrix_row_axis_key.clone(),
        Some(s) => normalize_axis_key(Some(s)),
    };
    let next_matrix_col = match &payload.matrix_col_axis_key {
        None => existing.matrix_col_axis_key.clone(),
        Some(s) => normalize_axis_key(Some(s)),
    };

    let mut tx = state.db.begin().await?;

    let updated = sqlx::query_as::<_, Category>(
        r#"
        UPDATE categories
        SET
            name = $1,
            is_clothing_footwear = $2,
            parent_id = $3,
            matrix_row_axis_key = $4,
            matrix_col_axis_key = $5
        WHERE id = $6
        RETURNING id, name, is_clothing_footwear, parent_id, matrix_row_axis_key, matrix_col_axis_key
        "#,
    )
    .bind(next_name.as_str())
    .bind(next_is_clothing)
    .bind(next_parent_id)
    .bind(next_matrix_row)
    .bind(next_matrix_col)
    .bind(category_id)
    .fetch_one(&mut *tx)
    .await?;

    let actor = payload.changed_by_staff_id;
    let note = payload
        .change_note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if existing.name != updated.name {
        sqlx::query(
            r#"
            INSERT INTO category_audit_log
                (category_id, changed_field, old_value, new_value, changed_by, change_note)
            VALUES ($1, 'name', $2, $3, $4, $5)
            "#,
        )
        .bind(category_id)
        .bind(existing.name.as_str())
        .bind(updated.name.as_str())
        .bind(actor)
        .bind(note)
        .execute(&mut *tx)
        .await?;
    }
    if existing.is_clothing_footwear != updated.is_clothing_footwear {
        sqlx::query(
            r#"
            INSERT INTO category_audit_log
                (category_id, changed_field, old_value, new_value, changed_by, change_note)
            VALUES ($1, 'is_clothing_footwear', $2, $3, $4, $5)
            "#,
        )
        .bind(category_id)
        .bind(existing.is_clothing_footwear.to_string())
        .bind(updated.is_clothing_footwear.to_string())
        .bind(actor)
        .bind(note)
        .execute(&mut *tx)
        .await?;
    }
    if existing.parent_id != updated.parent_id {
        sqlx::query(
            r#"
            INSERT INTO category_audit_log
                (category_id, changed_field, old_value, new_value, changed_by, change_note)
            VALUES ($1, 'parent_id', $2, $3, $4, $5)
            "#,
        )
        .bind(category_id)
        .bind(existing.parent_id.map(|v| v.to_string()))
        .bind(updated.parent_id.map(|v| v.to_string()))
        .bind(actor)
        .bind(note)
        .execute(&mut *tx)
        .await?;
    }
    if existing.matrix_row_axis_key != updated.matrix_row_axis_key {
        sqlx::query(
            r#"
            INSERT INTO category_audit_log
                (category_id, changed_field, old_value, new_value, changed_by, change_note)
            VALUES ($1, 'matrix_row_axis_key', $2, $3, $4, $5)
            "#,
        )
        .bind(category_id)
        .bind(existing.matrix_row_axis_key.clone())
        .bind(updated.matrix_row_axis_key.clone())
        .bind(actor)
        .bind(note)
        .execute(&mut *tx)
        .await?;
    }
    if existing.matrix_col_axis_key != updated.matrix_col_axis_key {
        sqlx::query(
            r#"
            INSERT INTO category_audit_log
                (category_id, changed_field, old_value, new_value, changed_by, change_note)
            VALUES ($1, 'matrix_col_axis_key', $2, $3, $4, $5)
            "#,
        )
        .bind(category_id)
        .bind(existing.matrix_col_axis_key.clone())
        .bind(updated.matrix_col_axis_key.clone())
        .bind(actor)
        .bind(note)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(Json(updated))
}
