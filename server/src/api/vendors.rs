use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
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

fn trimmed_opt(input: Option<&str>) -> Option<&str> {
    input.map(str::trim).filter(|s| !s.is_empty())
}

async fn validate_create_vendor_payload(
    pool: &sqlx::PgPool,
    payload: &CreateVendorRequest,
) -> Result<(), VendorError> {
    validate_vendor_payload(pool, payload, None).await
}

async fn validate_vendor_payload(
    pool: &sqlx::PgPool,
    payload: &CreateVendorRequest,
    existing_vendor_id: Option<Uuid>,
) -> Result<(), VendorError> {
    let name = payload.name.trim();
    if name.is_empty() {
        return Err(VendorError::InvalidPayload("name is required".to_string()));
    }

    let duplicate_name: Option<String> = sqlx::query_scalar(
        "SELECT name FROM vendors WHERE lower(trim(name)) = lower(trim($1)) AND ($2::uuid IS NULL OR id <> $2) LIMIT 1",
    )
    .bind(name)
    .bind(existing_vendor_id)
    .fetch_optional(pool)
    .await?;
    if let Some(existing_name) = duplicate_name {
        return Err(VendorError::InvalidPayload(format!(
            "vendor name already exists: {}",
            existing_name.trim()
        )));
    }

    if let Some(vendor_code) = trimmed_opt(payload.vendor_code.as_deref()) {
        let duplicate_code: Option<String> = sqlx::query_scalar(
            "SELECT vendor_code FROM vendors WHERE vendor_code IS NOT NULL AND lower(trim(vendor_code)) = lower(trim($1)) AND ($2::uuid IS NULL OR id <> $2) LIMIT 1",
        )
        .bind(vendor_code)
        .bind(existing_vendor_id)
        .fetch_optional(pool)
        .await?;
        if let Some(existing_code) = duplicate_code {
            return Err(VendorError::InvalidPayload(format!(
                "vendor_code already exists: {}",
                existing_code.trim()
            )));
        }
    }

    Ok(())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_vendors).post(create_vendor))
        .route("/merge", post(merge_vendors))
        .route("/{vendor_id}", patch(update_vendor))
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
    validate_create_vendor_payload(&state.db, &payload).await?;
    let name = payload.name.trim();
    let v = sqlx::query_as::<_, Vendor>(
        r#"
        INSERT INTO vendors (name, email, phone, account_number, payment_terms, vendor_code)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, name, email, phone, account_number, payment_terms, vendor_code, nuorder_brand_id, is_active
        "#,
    )
    .bind(name)
    .bind(
        trimmed_opt(payload.email.as_deref()),
    )
    .bind(
        trimmed_opt(payload.phone.as_deref()),
    )
    .bind(
        trimmed_opt(payload.account_number.as_deref()),
    )
    .bind(
        trimmed_opt(payload.payment_terms.as_deref()),
    )
    .bind(trimmed_opt(payload.vendor_code.as_deref()))
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

async fn update_vendor(
    State(state): State<AppState>,
    Path(vendor_id): Path<Uuid>,
    headers: HeaderMap,
    Json(payload): Json<CreateVendorRequest>,
) -> Result<Json<serde_json::Value>, VendorError> {
    require_v(&state, &headers, CATALOG_EDIT).await?;
    validate_vendor_payload(&state.db, &payload, Some(vendor_id)).await?;
    let updated = sqlx::query_as::<_, Vendor>(
        r#"
        UPDATE vendors
        SET name = $2,
            email = $3,
            phone = $4,
            account_number = $5,
            payment_terms = $6,
            vendor_code = $7
        WHERE id = $1 AND is_active = TRUE
        RETURNING id, name, email, phone, account_number, payment_terms, vendor_code, nuorder_brand_id, is_active
        "#,
    )
    .bind(vendor_id)
    .bind(payload.name.trim())
    .bind(trimmed_opt(payload.email.as_deref()))
    .bind(trimmed_opt(payload.phone.as_deref()))
    .bind(trimmed_opt(payload.account_number.as_deref()))
    .bind(trimmed_opt(payload.payment_terms.as_deref()))
    .bind(trimmed_opt(payload.vendor_code.as_deref()))
    .fetch_optional(&state.db)
    .await?;

    let Some(v) = updated else {
        return Err(VendorError::NotFound);
    };

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

#[cfg(test)]
mod tests {
    use super::{validate_create_vendor_payload, CreateVendorRequest, VendorError};
    use sqlx::PgPool;
    use uuid::Uuid;

    fn sample_vendor() -> CreateVendorRequest {
        CreateVendorRequest {
            name: "Vendor Validation".to_string(),
            email: None,
            phone: None,
            account_number: None,
            payment_terms: None,
            vendor_code: Some("VEND-001".to_string()),
        }
    }

    #[tokio::test]
    async fn validate_create_vendor_payload_rejects_duplicate_name_and_vendor_code() {
        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for DB-backed tests");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect test database");

        sqlx::query(
            "INSERT INTO vendors (id, name, vendor_code, is_active) VALUES ($1, $2, $3, true)",
        )
        .bind(Uuid::new_v4())
        .bind("Existing Vendor Validation")
        .bind("VAL-001")
        .execute(&pool)
        .await
        .expect("insert vendor");

        let mut duplicate_name = sample_vendor();
        duplicate_name.name = " existing vendor validation ".to_string();
        assert!(matches!(
            validate_create_vendor_payload(&pool, &duplicate_name).await,
            Err(VendorError::InvalidPayload(message))
            if message == "vendor name already exists: Existing Vendor Validation"
        ));

        let mut duplicate_code = sample_vendor();
        duplicate_code.name = format!("Fresh Vendor {}", Uuid::new_v4().simple());
        duplicate_code.vendor_code = Some(" val-001 ".to_string());
        assert!(matches!(
            validate_create_vendor_payload(&pool, &duplicate_code).await,
            Err(VendorError::InvalidPayload(message))
            if message == "vendor_code already exists: VAL-001"
        ));
    }
}
