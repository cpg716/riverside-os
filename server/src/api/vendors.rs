use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
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
use crate::services::fetch_vendor_hub;

#[derive(Debug, Error)]
pub enum VendorError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("Vendor not found")]
    NotFound,
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
}

fn map_v_perm(e: (StatusCode, axum::Json<serde_json::Value>)) -> VendorError {
    let (st, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match st {
        StatusCode::UNAUTHORIZED => VendorError::Unauthorized(msg),
        StatusCode::FORBIDDEN => VendorError::Forbidden(msg),
        _ => VendorError::InvalidPayload(msg),
    }
}

async fn require_v(
    state: &AppState,
    headers: &HeaderMap,
    key: &'static str,
) -> Result<(), VendorError> {
    middleware::require_staff_with_permission(state, headers, key)
        .await
        .map(|_| ())
        .map_err(map_v_perm)
}

impl IntoResponse for VendorError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            VendorError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            VendorError::NotFound => (StatusCode::NOT_FOUND, "Vendor not found".to_string()),
            VendorError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            VendorError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            VendorError::Database(e) => {
                tracing::error!(error = %e, "Database error in vendors");
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
pub struct Vendor {
    pub id: Uuid,
    pub name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub account_number: Option<String>,
    /// Payment terms label or code (e.g. Counterpoint TERMS_COD); not the AP account #.
    pub payment_terms: Option<String>,
    /// External / POS supplier identifier (e.g. Lightspeed `supplier_code`).
    pub vendor_code: Option<String>,
    pub nuorder_brand_id: Option<String>,
    pub is_active: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateVendorRequest {
    pub name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub account_number: Option<String>,
    pub payment_terms: Option<String>,
    pub vendor_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AddVendorBrandRequest {
    pub brand: String,
}

#[derive(Debug, Deserialize)]
pub struct MergeVendorsRequest {
    pub source_vendor_id: Uuid,
    pub target_vendor_id: Uuid,
}

#[derive(Debug, Serialize, FromRow)]
pub struct VendorBrandRow {
    pub id: Uuid,
    pub brand: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_vendors).post(create_vendor))
        .route("/merge", post(merge_vendors))
        .route("/{vendor_id}/hub", get(get_vendor_hub))
        .route("/{vendor_id}/brands", get(list_brands).post(add_brand))
        .route("/{vendor_id}/brands/{brand_id}", delete(delete_brand))
}

async fn list_vendors(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Vendor>>, VendorError> {
    require_v(&state, &headers, CATALOG_VIEW).await?;
    let rows = sqlx::query_as::<_, Vendor>(
        r#"
        SELECT id, name, email, phone, account_number, payment_terms, vendor_code, nuorder_brand_id, is_active
        FROM vendors
        WHERE is_active = TRUE
        ORDER BY name
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

fn spawn_meilisearch_vendor_upsert(state: &AppState, vendor_id: Uuid) {
    let state = state.clone();
    crate::logic::meilisearch_sync::spawn_meili(async move {
        if let Some(client) = crate::logic::meilisearch_client::meilisearch_from_env() {
            crate::logic::meilisearch_sync::upsert_vendor_document(&client, &state.db, vendor_id)
                .await;
        }
    });
}

async fn create_vendor(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateVendorRequest>,
) -> Result<Json<serde_json::Value>, VendorError> {
    require_v(&state, &headers, CATALOG_EDIT).await?;
    let name = payload.name.trim();
    if name.is_empty() {
        return Err(VendorError::InvalidPayload("name is required".to_string()));
    }
    let v = sqlx::query_as::<_, Vendor>(
        r#"
        INSERT INTO vendors (name, email, phone, account_number, payment_terms, vendor_code)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, name, email, phone, account_number, payment_terms, vendor_code, nuorder_brand_id as "nuorder_brand_id?", is_active
        "#,
    )
    .bind(name)
    .bind(
        payload
            .email
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(
        payload
            .phone
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(
        payload
            .account_number
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(
        payload
            .payment_terms
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(
        payload
            .vendor_code
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .fetch_one(&state.db)
    .await?;

    spawn_meilisearch_vendor_upsert(&state, v.id);

    Ok(Json(json!({
        "id": v.id,
        "name": v.name,
        "email": v.email,
        "phone": v.phone,
        "account_number": v.account_number,
        "payment_terms": v.payment_terms,
        "vendor_code": v.vendor_code,
        "nuorder_brand_id": v.nuorder_brand_id,
        "is_active": v.is_active,
    })))
}

async fn get_vendor_hub(
    State(state): State<AppState>,
    Path(vendor_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, VendorError> {
    require_v(&state, &headers, CATALOG_VIEW).await?;
    let hub = fetch_vendor_hub(&state.db, vendor_id)
        .await?
        .ok_or(VendorError::NotFound)?;
    Ok(Json(json!(hub)))
}

async fn list_brands(
    State(state): State<AppState>,
    Path(vendor_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<VendorBrandRow>>, VendorError> {
    require_v(&state, &headers, CATALOG_VIEW).await?;
    let v_ok: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM vendors WHERE id = $1 AND is_active = TRUE)",
    )
    .bind(vendor_id)
    .fetch_one(&state.db)
    .await?;

    if !v_ok {
        return Err(VendorError::NotFound);
    }

    let rows = sqlx::query_as::<_, VendorBrandRow>(
        r#"
        SELECT id, brand, created_at
        FROM vendor_brands
        WHERE vendor_id = $1
        ORDER BY lower(brand)
        "#,
    )
    .bind(vendor_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

async fn add_brand(
    State(state): State<AppState>,
    Path(vendor_id): Path<Uuid>,
    headers: HeaderMap,
    Json(payload): Json<AddVendorBrandRequest>,
) -> Result<Json<serde_json::Value>, VendorError> {
    require_v(&state, &headers, CATALOG_EDIT).await?;
    let brand = payload.brand.trim();
    if brand.is_empty() {
        return Err(VendorError::InvalidPayload("brand is required".to_string()));
    }

    let v_ok: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM vendors WHERE id = $1 AND is_active = TRUE)",
    )
    .bind(vendor_id)
    .fetch_one(&state.db)
    .await?;

    if !v_ok {
        return Err(VendorError::NotFound);
    }

    let inserted = match sqlx::query_as::<_, VendorBrandRow>(
        r#"
        INSERT INTO vendor_brands (vendor_id, brand)
        VALUES ($1, $2)
        RETURNING id, brand, created_at
        "#,
    )
    .bind(vendor_id)
    .bind(brand)
    .fetch_one(&state.db)
    .await
    {
        Ok(row) => row,
        Err(e) => {
            if e.as_database_error()
                .is_some_and(|db| db.code().map(|c| c.as_ref() == "23505").unwrap_or(false))
            {
                return Err(VendorError::InvalidPayload(
                    "this brand is already linked to the vendor".to_string(),
                ));
            }
            return Err(VendorError::Database(e));
        }
    };

    Ok(Json(json!(inserted)))
}

async fn delete_brand(
    State(state): State<AppState>,
    Path((vendor_id, brand_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, VendorError> {
    require_v(&state, &headers, CATALOG_EDIT).await?;
    let res = sqlx::query(
        r#"
        DELETE FROM vendor_brands
        WHERE id = $1 AND vendor_id = $2
        "#,
    )
    .bind(brand_id)
    .bind(vendor_id)
    .execute(&state.db)
    .await?;

    if res.rows_affected() == 0 {
        return Err(VendorError::NotFound);
    }

    Ok(Json(json!({ "status": "deleted" })))
}

async fn merge_vendors(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MergeVendorsRequest>,
) -> Result<Json<serde_json::Value>, VendorError> {
    require_v(&state, &headers, CATALOG_EDIT).await?;

    if payload.source_vendor_id == payload.target_vendor_id {
        return Err(VendorError::InvalidPayload(
            "source and target vendors must be different".to_string(),
        ));
    }

    let mut tx = state.db.begin().await?;

    // Verify both exist
    let source_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM vendors WHERE id = $1)")
            .bind(payload.source_vendor_id)
            .fetch_one(&mut *tx)
            .await?;
    let target_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM vendors WHERE id = $1)")
            .bind(payload.target_vendor_id)
            .fetch_one(&mut *tx)
            .await?;

    if !source_exists || !target_exists {
        return Err(VendorError::NotFound);
    }

    // 1. Move products
    sqlx::query("UPDATE products SET primary_vendor_id = $1 WHERE primary_vendor_id = $2")
        .bind(payload.target_vendor_id)
        .bind(payload.source_vendor_id)
        .execute(&mut *tx)
        .await?;

    // 2. Move Purchase Orders
    sqlx::query("UPDATE purchase_orders SET vendor_id = $1 WHERE vendor_id = $2")
        .bind(payload.target_vendor_id)
        .bind(payload.source_vendor_id)
        .execute(&mut *tx)
        .await?;

    // Move Product Promotions
    sqlx::query("UPDATE product_promotions SET scope_vendor_id = $1 WHERE scope_vendor_id = $2")
        .bind(payload.target_vendor_id)
        .bind(payload.source_vendor_id)
        .execute(&mut *tx)
        .await?;

    // 3. Move brands (handling duplicates)
    // First, find brands in source that are already in target
    let source_brands: Vec<String> =
        sqlx::query_scalar("SELECT brand FROM vendor_brands WHERE vendor_id = $1")
            .bind(payload.source_vendor_id)
            .fetch_all(&mut *tx)
            .await?;

    for brand in source_brands {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM vendor_brands WHERE vendor_id = $1 AND brand = $2)",
        )
        .bind(payload.target_vendor_id)
        .bind(&brand)
        .fetch_one(&mut *tx)
        .await?;

        if exists {
            // Delete the duplicate from source
            sqlx::query("DELETE FROM vendor_brands WHERE vendor_id = $1 AND brand = $2")
                .bind(payload.source_vendor_id)
                .bind(&brand)
                .execute(&mut *tx)
                .await?;
        } else {
            // Move to target
            sqlx::query(
                "UPDATE vendor_brands SET vendor_id = $1 WHERE vendor_id = $2 AND brand = $3",
            )
            .bind(payload.target_vendor_id)
            .bind(payload.source_vendor_id)
            .bind(&brand)
            .execute(&mut *tx)
            .await?;
        }
    }

    // 4. Move Supplier Items (handling duplicates)
    // Similar logic to brands
    let source_items: Vec<(String, String)> = sqlx::query_as(
        "SELECT cp_item_no, vendor_item_no FROM vendor_supplier_item WHERE vendor_id = $1",
    )
    .bind(payload.source_vendor_id)
    .fetch_all(&mut *tx)
    .await?;

    for (cp, vend) in source_items {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM vendor_supplier_item WHERE vendor_id = $1 AND cp_item_no = $2 AND vendor_item_no = $3)",
        )
        .bind(payload.target_vendor_id)
        .bind(&cp)
        .bind(&vend)
        .fetch_one(&mut *tx)
        .await?;

        if exists {
            sqlx::query("DELETE FROM vendor_supplier_item WHERE vendor_id = $1 AND cp_item_no = $2 AND vendor_item_no = $3")
                .bind(payload.source_vendor_id)
                .bind(&cp)
                .bind(&vend)
                .execute(&mut *tx)
                .await?;
        } else {
            sqlx::query("UPDATE vendor_supplier_item SET vendor_id = $1 WHERE vendor_id = $2 AND cp_item_no = $3 AND vendor_item_no = $4")
                .bind(payload.target_vendor_id)
                .bind(payload.source_vendor_id)
                .bind(&cp)
                .bind(&vend)
                .execute(&mut *tx)
                .await?;
        }
    }

    // 5. Delete source vendor
    sqlx::query("DELETE FROM vendors WHERE id = $1")
        .bind(payload.source_vendor_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    // Trigger reindex for target vendor (Meilisearch)
    spawn_meilisearch_vendor_upsert(&state, payload.target_vendor_id);

    Ok(Json(
        json!({ "status": "merged", "source": payload.source_vendor_id, "target": payload.target_vendor_id }),
    ))
}
