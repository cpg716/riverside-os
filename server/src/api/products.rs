use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, QueryBuilder};
use std::collections::HashSet;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    effective_permissions_for_staff, staff_has_permission, CATALOG_EDIT, CATALOG_VIEW,
    PROCUREMENT_VIEW,
};
use crate::logic::importer::{execute_import, ImportPayload, ImportSummary, ImporterError};
use crate::logic::product_catalog_analysis::{
    analyze_product_catalog, suggest_product_catalog_normalization, ProductCatalogAnalysisInput,
};
use crate::logic::template_variant_pricing::effective_retail_usd;
use crate::middleware;

#[derive(Debug, Error)]
pub enum ProductError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("Variant not found")]
    VariantNotFound,
    #[error("Product not found")]
    ProductNotFound,
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
}

/// Trailing `orders.booked_at` window for ranking control-board **text search** by **parent product**
/// units sold (all variants of the product share the same score). Non-search board loads skip the join.
const CONTROL_BOARD_SEARCH_SALES_WINDOW_DAYS: i32 = 45;

fn map_perm_err_products(e: (StatusCode, axum::Json<serde_json::Value>)) -> ProductError {
    let (status, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match status {
        StatusCode::UNAUTHORIZED => ProductError::Unauthorized(msg),
        StatusCode::FORBIDDEN => ProductError::Forbidden(msg),
        _ => ProductError::InvalidPayload(msg),
    }
}

impl IntoResponse for ProductError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            ProductError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            ProductError::VariantNotFound => {
                (StatusCode::NOT_FOUND, "Variant not found".to_string())
            }
            ProductError::ProductNotFound => {
                (StatusCode::NOT_FOUND, "Product not found".to_string())
            }
            ProductError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            ProductError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            ProductError::Database(e) => {
                tracing::error!(error = %e, "Database error in products");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

fn spawn_meilisearch_product_resync(state: &AppState, product_id: Uuid) {
    let ms = state.meilisearch.clone();
    let pool = state.db.clone();
    if let Some(c) = ms {
        crate::logic::meilisearch_sync::spawn_meili(async move {
            crate::logic::meilisearch_sync::sync_product_variants_and_store(&c, &pool, product_id)
                .await;
        });
    }
}

fn spawn_meilisearch_variant_resync(state: &AppState, variant_id: Uuid) {
    let ms = state.meilisearch.clone();
    let pool = state.db.clone();
    if let Some(c) = ms {
        crate::logic::meilisearch_sync::spawn_meili(async move {
            let Ok(pid) = sqlx::query_scalar::<_, Uuid>(
                "SELECT product_id FROM product_variants WHERE id = $1",
            )
            .bind(variant_id)
            .fetch_one(&pool)
            .await
            else {
                return;
            };
            crate::logic::meilisearch_sync::sync_product_variants_and_store(&c, &pool, pid).await;
        });
    }
}

fn spawn_meilisearch_products_resync(state: &AppState, product_ids: &[Uuid]) {
    let ms = state.meilisearch.clone();
    let pool = state.db.clone();
    let ids: Vec<Uuid> = product_ids.to_vec();
    if let Some(c) = ms {
        crate::logic::meilisearch_sync::spawn_meili(async move {
            for pid in ids {
                crate::logic::meilisearch_sync::sync_product_variants_and_store(&c, &pool, pid)
                    .await;
            }
        });
    }
}

#[derive(Debug, Deserialize)]
pub struct MatrixAxisInput {
    pub name: String,
    pub options: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct GenerateMatrixRequest {
    pub axes: Vec<MatrixAxisInput>,
}

#[derive(Debug, Serialize)]
pub struct GeneratedVariant {
    pub variation_values: Value,
    pub variation_label: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateProductRequest {
    pub category_id: Option<Uuid>,
    pub name: String,
    pub brand: Option<String>,
    pub description: Option<String>,
    pub base_retail_price: Decimal,
    pub base_cost: Decimal,
    pub variation_axes: Vec<String>,
    pub images: Option<Vec<String>>,
    /// When false (default), low-stock notifications skip this template unless enabled later.
    #[serde(default)]
    pub track_low_stock: bool,
    /// When true, new variants are created with `web_published = true` (still require catalog handle + template for storefront).
    #[serde(default)]
    pub publish_variants_to_web: bool,
    /// Optional parent-product POS tax override. Omit/null to inherit category ancestry.
    pub tax_category_override: Option<crate::logic::tax::TaxCategory>,
    pub variants: Vec<CreateVariantInput>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CreateVariantInput {
    pub sku: String,
    pub variation_values: Value,
    pub variation_label: Option<String>,
    pub stock_on_hand: Option<i32>,
    pub retail_price_override: Option<Decimal>,
    pub cost_override: Option<Decimal>,
    #[serde(default)]
    pub track_low_stock: bool,
}

fn normalize_sku_key(raw: &str) -> String {
    raw.trim().to_lowercase()
}

fn validate_variation_axes(axes: &[String]) -> Result<Vec<String>, ProductError> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(axes.len());
    for axis in axes {
        let trimmed = axis.trim();
        if trimmed.is_empty() {
            return Err(ProductError::InvalidPayload(
                "variation_axes cannot contain blank names".to_string(),
            ));
        }
        let key = trimmed.to_lowercase();
        if !seen.insert(key) {
            return Err(ProductError::InvalidPayload(format!(
                "duplicate variation axis: {trimmed}"
            )));
        }
        normalized.push(trimmed.to_string());
    }
    Ok(normalized)
}

fn validate_variant_shape(
    variation_axes: &[String],
    variant: &CreateVariantInput,
) -> Result<(), ProductError> {
    let Some(values) = variant.variation_values.as_object() else {
        return Err(ProductError::InvalidPayload(format!(
            "variant {} variation_values must be an object",
            variant.sku.trim()
        )));
    };

    let expected_axes: HashSet<&str> = variation_axes.iter().map(String::as_str).collect();
    let actual_axes: HashSet<&str> = values.keys().map(String::as_str).collect();
    if expected_axes != actual_axes {
        return Err(ProductError::InvalidPayload(format!(
            "variant {} variation_values must match variation_axes exactly",
            variant.sku.trim()
        )));
    }

    for (axis, value) in values {
        if !value.is_string()
            || value
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .is_none()
        {
            return Err(ProductError::InvalidPayload(format!(
                "variant {} has an invalid value for axis {}",
                variant.sku.trim(),
                axis
            )));
        }
    }

    Ok(())
}

fn validate_create_product_payload(
    payload: &CreateProductRequest,
) -> Result<(Vec<String>, Vec<String>), ProductError> {
    if payload.name.trim().is_empty() {
        return Err(ProductError::InvalidPayload("name is required".to_string()));
    }
    if payload.base_retail_price < Decimal::ZERO {
        return Err(ProductError::InvalidPayload(
            "base_retail_price must be non-negative".to_string(),
        ));
    }
    if payload.base_cost < Decimal::ZERO {
        return Err(ProductError::InvalidPayload(
            "base_cost must be non-negative".to_string(),
        ));
    }
    if payload.variants.is_empty() {
        return Err(ProductError::InvalidPayload(
            "at least one variant is required".to_string(),
        ));
    }

    let variation_axes = validate_variation_axes(&payload.variation_axes)?;
    let mut sku_set = HashSet::new();
    let mut normalized_skus = Vec::with_capacity(payload.variants.len());

    for variant in &payload.variants {
        let trimmed_sku = variant.sku.trim();
        if trimmed_sku.is_empty() {
            return Err(ProductError::InvalidPayload(
                "variant sku is required".to_string(),
            ));
        }
        let sku_key = normalize_sku_key(trimmed_sku);
        if !sku_set.insert(sku_key.clone()) {
            return Err(ProductError::InvalidPayload(format!(
                "duplicate sku in request: {trimmed_sku}"
            )));
        }
        if variant.stock_on_hand.unwrap_or(0) < 0 {
            return Err(ProductError::InvalidPayload(format!(
                "variant {trimmed_sku} stock_on_hand must be non-negative"
            )));
        }
        if variant
            .retail_price_override
            .is_some_and(|price| price < Decimal::ZERO)
        {
            return Err(ProductError::InvalidPayload(format!(
                "variant {trimmed_sku} retail_price_override must be non-negative"
            )));
        }
        if variant
            .cost_override
            .is_some_and(|cost| cost < Decimal::ZERO)
        {
            return Err(ProductError::InvalidPayload(format!(
                "variant {trimmed_sku} cost_override must be non-negative"
            )));
        }
        validate_variant_shape(&variation_axes, variant)?;
        normalized_skus.push(sku_key);
    }

    Ok((variation_axes, normalized_skus))
}

async fn ensure_category_exists(
    pool: &sqlx::PgPool,
    category_id: Option<Uuid>,
) -> Result<(), ProductError> {
    if let Some(category_id) = category_id {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM categories WHERE id = $1)")
                .bind(category_id)
                .fetch_one(pool)
                .await?;
        if !exists {
            return Err(ProductError::InvalidPayload(
                "category_id does not exist".to_string(),
            ));
        }
    }
    Ok(())
}

async fn ensure_skus_do_not_exist(
    pool: &sqlx::PgPool,
    normalized_skus: &[String],
) -> Result<(), ProductError> {
    if normalized_skus.is_empty() {
        return Ok(());
    }

    let existing: Option<String> = sqlx::query_scalar(
        "SELECT sku FROM product_variants WHERE lower(trim(sku)) = ANY($1) LIMIT 1",
    )
    .bind(normalized_skus)
    .fetch_optional(pool)
    .await?;

    if let Some(existing) = existing {
        return Err(ProductError::InvalidPayload(format!(
            "sku already exists: {}",
            existing.trim()
        )));
    }

    Ok(())
}

#[derive(Debug, Serialize, FromRow)]
pub struct ProductRow {
    pub id: Uuid,
    pub name: String,
    pub brand: Option<String>,
    pub base_retail_price: Decimal,
    pub base_cost: Decimal,
}

#[derive(Debug, Deserialize)]
pub struct InventoryBoardQuery {
    pub search: Option<String>,
    pub filter: Option<String>,
    pub category_id: Option<Uuid>,
    /// When set, return variants for this product only (POS line variant swap, hub drill-down).
    pub product_id: Option<Uuid>,
    pub vendor_id: Option<Uuid>,
    /// Case-insensitive substring match on `products.brand`.
    pub brand: Option<String>,
    /// Only variants with no `shelf_labeled_at` (new / never marked labeled).
    pub unlabeled_only: Option<bool>,
    /// Minimum extended cost: `stock_on_hand * effective_unit_cost` (in USD).
    pub min_line_value: Option<Decimal>,
    /// Stock alert: out-of-stock or low (on hand ≤ 2). Composable with `clothing_only`.
    pub oos_low_only: Option<bool>,
    /// Category tax class: clothing / footwear path only.
    pub clothing_only: Option<bool>,
    /// Max variant rows (default: 25_000 unfiltered, 5_000 when `search` is non-empty; hard cap 50_000).
    pub limit: Option<i64>,
    /// Pagination offset into `ORDER BY p.name, pv.sku`.
    pub offset: Option<i64>,
    /// Only variants marked `web_published` (online storefront).
    pub web_published_only: Option<bool>,
    /// Only variants with stock_on_hand <= 0.
    pub oos_only: Option<bool>,
    /// Only variants with stock_on_hand < 0.
    pub negative_stock_only: Option<bool>,
    /// Text search only: rank rows where the **product** (name / brand / handle) matches the query
    pub parent_rank_first: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct MaintenanceLedgerQuery {
    pub tx_type: Option<String>, // "damaged" | "return_to_vendor"
    pub vendor_id: Option<Uuid>,
    pub search: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct MaintenanceLedgerRow {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub tx_type: String,
    pub quantity_delta: i32,
    pub unit_cost: Option<Decimal>,
    pub notes: Option<String>,
    pub variant_id: Uuid,
    pub sku: String,
    pub product_name: String,
    pub brand: Option<String>,
    pub category_name: Option<String>,
    pub vendor_name: Option<String>,
    pub staff_name: Option<String>,
}

/// `%…%` pattern for PostgreSQL `ILIKE … ESCAPE '\'`.
fn control_board_ilike_pattern(raw: &str) -> String {
    let mut esc = String::new();
    for c in raw.chars() {
        match c {
            '\\' | '%' | '_' => {
                esc.push('\\');
                esc.push(c);
            }
            _ => esc.push(c),
        }
    }
    format!("%{esc}%")
}

#[derive(Debug, Serialize, FromRow)]
pub struct InventoryControlRow {
    pub variant_id: Uuid,
    pub product_id: Uuid,
    pub total_variant_count: i64,
    pub sku: String,
    pub barcode: Option<String>,
    pub product_name: String,
    pub brand: Option<String>,
    pub variation_label: Option<String>,
    pub category_id: Option<Uuid>,
    pub category_name: Option<String>,
    pub is_clothing_footwear: Option<bool>,
    pub stock_on_hand: i32,
    pub retail_price: Decimal,
    pub cost_price: Decimal,
    /// Template base retail (`products.base_retail_price`) for grid editing.
    pub base_retail_price: Decimal,
    /// Template base cost (`products.base_cost`) for grid editing.
    pub base_cost: Decimal,
    pub shelf_labeled_at: Option<DateTime<Utc>>,
    pub primary_vendor_id: Option<Uuid>,
    pub primary_vendor_name: Option<String>,
    pub last_vendor_id: Option<Uuid>,
    pub last_vendor_name: Option<String>,
    pub state_tax: Decimal,
    pub local_tax: Decimal,
    pub tax_category: crate::logic::tax::TaxCategory,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tax_category_override: Option<crate::logic::tax::TaxCategory>,
    pub web_published: bool,
    pub web_price_override: Option<Decimal>,
    pub available_stock: i32,
    /// Parent-product gross units sold in the trailing search window (all variants of the product); text search only.
    #[serde(skip_serializing)]
    pub units_sold_trailing: i64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct InventoryStats {
    pub total_asset_value: Decimal,
    pub skus_out_of_stock: i64,
    /// Distinct `products.primary_vendor_id` on active templates (receiving partner).
    pub active_vendors: i64,
    pub need_label_skus: i64,
    /// OOS variants with at least one sale on a non-cancelled order in the trailing 12 months (PO replenishment signal).
    pub oos_replenishment_skus: i64,
}

#[derive(Debug, Serialize)]
pub struct InventoryControlResponse {
    pub rows: Vec<InventoryControlRow>,
    pub stats: InventoryStats,
}

#[derive(Debug, Deserialize)]
pub struct BulkUpdateRequest {
    pub product_id: Uuid,
    pub retail_price_override: Option<Decimal>,
    pub cost_override: Option<Decimal>,
    pub category_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct PatchProductModelRequest {
    pub name: Option<String>,
    pub base_retail_price: Option<Decimal>,
    pub base_cost: Option<Decimal>,
    pub category_id: Option<Uuid>,
    #[serde(default)]
    pub clear_category_id: bool,
    pub brand: Option<String>,
    pub catalog_handle: Option<String>,
    #[serde(default)]
    pub clear_catalog_handle: bool,
    pub is_bundle: Option<bool>,
    pub track_low_stock: Option<bool>,
    pub tax_category_override: Option<crate::logic::tax::TaxCategory>,
    #[serde(default)]
    pub clear_tax_category_override: bool,
    /// When set, overrides store default employee markup % for this product; omit to keep prior.
    pub employee_markup_percent: Option<Decimal>,
    #[serde(default)]
    pub clear_employee_markup_percent: bool,
    /// Per-unit flat amount after cost×(1+markup%) on employee sales.
    pub employee_extra_amount: Option<Decimal>,
    /// When set, assigns primary vendor; validate against active `vendors` row.
    pub primary_vendor_id: Option<Uuid>,
    #[serde(default)]
    pub clear_primary_vendor_id: bool,
    pub audit_source: Option<String>,
    pub audit_note: Option<String>,
    pub audit_confidence: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct BulkProductModelRequest {
    pub product_ids: Vec<Uuid>,
    pub brand: Option<String>,
    pub category_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct BulkArchiveProductsRequest {
    pub product_ids: Vec<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct BulkMarkShelfLabeledRequest {
    pub variant_ids: Vec<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct BulkWebPublishRequest {
    pub variant_ids: Vec<Uuid>,
    pub web_published: bool,
}

#[derive(Debug, Deserialize)]
pub struct AdjustVariantStockRequest {
    pub quantity_delta: i32,
    pub tx_type: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct VariantPricingPatch {
    /// Toggle online storefront visibility for this SKU.
    #[serde(default)]
    pub web_published: Option<bool>,
    pub web_price_override: Option<Decimal>,
    #[serde(default)]
    pub clear_web_price_override: bool,
    pub web_gallery_order: Option<i32>,
    /// When true, clears `retail_price_override` (revert to template base).
    #[serde(default)]
    pub clear_retail_override: bool,
    /// New per-variant retail override (ignored if `clear_retail_override`).
    #[serde(default)]
    pub retail_price_override: Option<Decimal>,
    #[serde(default)]
    pub clear_cost_override: bool,
    #[serde(default)]
    pub cost_override: Option<Decimal>,
    #[serde(default)]
    pub track_low_stock: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ProductHubStats {
    pub total_units_on_hand: i64,
    pub total_reserved_units: i64,
    pub total_available_units: i64,
    pub value_on_hand: Decimal,
    pub units_sold_all_time: i64,
    pub open_order_units: i64,
    pub last_physical_count_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct HubVariantRow {
    pub id: Uuid,
    pub sku: String,
    pub variation_values: Value,
    pub variation_label: Option<String>,
    pub vendor_upc: Option<String>,
    pub stock_on_hand: i32,
    pub reserved_stock: i32,
    pub available_stock: i32,
    pub qty_on_order: Option<i32>,
    pub last_physical_count_at: Option<DateTime<Utc>>,
    pub reorder_point: i32,
    pub track_low_stock: bool,
    pub retail_price_override: Option<Decimal>,
    pub cost_override: Option<Decimal>,
    pub effective_retail: Decimal,
    pub web_published: bool,
    pub web_price_override: Option<Decimal>,
    pub web_gallery_order: i32,
}

#[derive(Debug, FromRow)]
struct HubVariantJoinRow {
    id: Uuid,
    sku: String,
    variation_values: Value,
    variation_label: Option<String>,
    vendor_upc: Option<String>,
    stock_on_hand: i32,
    reserved_stock: i32,
    available_stock: i32,
    qty_on_order: i32,
    last_physical_count_at: Option<DateTime<Utc>>,
    reorder_point: i32,
    track_low_stock: bool,
    retail_price_override: Option<Decimal>,
    cost_override: Option<Decimal>,
    base_retail_price: Decimal,
    web_published: bool,
    web_price_override: Option<Decimal>,
    web_gallery_order: i32,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ProductHubProductRow {
    id: Uuid,
    name: String,
    brand: Option<String>,
    description: Option<String>,
    base_retail_price: Decimal,
    base_cost: Decimal,
    variation_axes: Vec<String>,
    category_id: Option<Uuid>,
    category_name: Option<String>,
    is_clothing_footwear: Option<bool>,
    matrix_row_axis_key: Option<String>,
    matrix_col_axis_key: Option<String>,
    primary_vendor_id: Option<Uuid>,
    primary_vendor_name: Option<String>,
    primary_vendor_code: Option<String>,
    track_low_stock: bool,
    employee_markup_percent: Option<Decimal>,
    employee_extra_amount: Decimal,
    tax_category_override: Option<crate::logic::tax::TaxCategory>,
    nuorder_product_id: Option<String>,
    catalog_handle: Option<String>,
}

#[derive(Debug, FromRow)]
struct ProductHubInventoryTotalsRow {
    total_units_on_hand: i64,
    total_reserved_units: i64,
    total_available_units: i64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ProductPoSummaryLine {
    pub purchase_order_id: Uuid,
    pub po_number: String,
    pub status: String,
    pub ordered_at: DateTime<Utc>,
    pub vendor_name: String,
    pub sku: String,
    pub quantity_ordered: i32,
    pub quantity_received: i32,
}

#[derive(Debug, Serialize)]
pub struct ProductPoSummary {
    pub open_po_count: i64,
    pub pending_receive_units: i64,
    pub pending_commit_value_usd: Decimal,
    pub recent_lines: Vec<ProductPoSummaryLine>,
}

#[derive(Debug, Serialize)]
pub struct ProductHubResponse {
    pub product: ProductHubProductRow,
    /// Store-wide default (same source as checkout `AppState::global_employee_markup`).
    pub store_default_employee_markup_percent: Decimal,
    pub can_view_procurement: bool,
    pub stats: ProductHubStats,
    pub po_summary: ProductPoSummary,
    pub variants: Vec<HubVariantRow>,
}

#[derive(Debug, Serialize)]
pub struct RosieProductCatalogAnalysisResponse {
    pub tool_name: String,
    pub product_id: Uuid,
    pub product_name: String,
    pub source_route: String,
    pub parsed_fields: crate::logic::product_catalog_analysis::ProductCatalogParsedFields,
    pub issues_detected: Vec<String>,
    pub confidence_score: f64,
    pub unresolved_parts: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RosieProductCatalogSuggestionResponse {
    pub tool_name: String,
    pub product_id: Uuid,
    pub product_name: String,
    pub source_route: String,
    pub suggested_parent_title: Option<String>,
    pub suggested_variant_fields:
        crate::logic::product_catalog_analysis::ProductCatalogSuggestedVariantFields,
    pub suggestion_issues: Vec<String>,
    pub suggestion_confidence: f64,
    pub unresolved_parts: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ProductTimelineEvent {
    pub at: DateTime<Utc>,
    pub kind: String,
    pub summary: String,
    pub reference_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct ProductTimelineResponse {
    pub events: Vec<ProductTimelineEvent>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/maintenance", get(get_maintenance_ledger))
        .route("/", post(create_product).get(list_products))
        .route("/control-board", get(list_control_board))
        .route("/bulk-update", post(bulk_update_product_model))
        .route("/bulk-set-model", post(bulk_set_product_model))
        .route("/bulk-archive", post(bulk_archive_products))
        .route(
            "/variants/bulk-mark-shelf-labeled",
            post(bulk_mark_shelf_labeled),
        )
        .route("/variants/bulk-web-publish", post(bulk_web_publish))
        .route("/import", post(import_catalog))
        .route("/matrix/generate", post(generate_matrix))
        .route(
            "/variants/{variant_id}/stock-adjust",
            patch(adjust_variant_stock),
        )
        .route(
            "/variants/{variant_id}/pricing",
            patch(patch_variant_pricing),
        )
        .route("/variants/{variant_id}", get(get_variant))
        .route(
            "/{product_id}/bundle-components",
            get(get_product_bundle_components),
        )
        .route("/{product_id}/po-summary", get(get_product_po_summary))
        .route(
            "/{product_id}/clear-retail-overrides",
            post(clear_product_retail_overrides),
        )
        .route("/{product_id}/model", patch(patch_product_model))
        .route("/{product_id}/hub", get(get_product_hub))
        .route("/{product_id}/timeline", get(get_product_timeline))
        .route("/{product_id}/variants", get(list_variants))
}

async fn require_catalog_perm(
    state: &AppState,
    headers: &HeaderMap,
    key: &'static str,
) -> Result<(), ProductError> {
    middleware::require_staff_with_permission(state, headers, key)
        .await
        .map(|_| ())
        .map_err(map_perm_err_products)
}

async fn require_catalog_staff(
    state: &AppState,
    headers: &HeaderMap,
    key: &'static str,
) -> Result<crate::auth::pins::AuthenticatedStaff, ProductError> {
    middleware::require_staff_with_permission(state, headers, key)
        .await
        .map_err(map_perm_err_products)
}

async fn require_catalog_or_procurement_view(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), ProductError> {
    let staff = middleware::require_authenticated_staff_headers(state, headers)
        .await
        .map_err(map_perm_err_products)?;
    let eff = effective_permissions_for_staff(&state.db, staff.id, staff.role)
        .await
        .map_err(ProductError::Database)?;
    if staff_has_permission(&eff, CATALOG_VIEW) || staff_has_permission(&eff, PROCUREMENT_VIEW) {
        return Ok(());
    }
    Err(ProductError::Forbidden(
        "catalog.view or procurement.view required".to_string(),
    ))
}

async fn import_catalog(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ImportPayload>,
) -> Result<Json<ImportSummary>, ProductError> {
    let actor = middleware::require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(map_perm_err_products)?;
    let eff = effective_permissions_for_staff(&state.db, actor.id, actor.role)
        .await
        .map_err(ProductError::Database)?;
    if !staff_has_permission(&eff, CATALOG_EDIT) {
        return Err(ProductError::Forbidden("catalog.edit required".to_string()));
    }
    let row_count = payload.rows.len();
    tracing::info!(
        staff_id = %actor.id,
        rows = row_count,
        "catalog CSV import started (request body received and parsed)"
    );
    let started = std::time::Instant::now();
    let summary = execute_import(&state.db, payload)
        .await
        .map_err(|e| match e {
            ImporterError::InvalidPayload(m) => ProductError::InvalidPayload(m),
            ImporterError::Database(err) => ProductError::Database(err),
        })?;
    tracing::info!(
        staff_id = %actor.id,
        rows = row_count,
        elapsed_ms = started.elapsed().as_millis() as u64,
        products_created = summary.products_created,
        products_updated = summary.products_updated,
        variants_synced = summary.variants_synced,
        rows_skipped = summary.rows_skipped,
        "catalog CSV import finished"
    );
    if summary.rows_skipped > 0 {
        let pool = state.db.clone();
        let actor_id = actor.id;
        let skipped = summary.rows_skipped;
        let pc = summary.products_created;
        let pu = summary.products_updated;
        let vs = summary.variants_synced;
        tokio::spawn(async move {
            if let Err(e) = crate::logic::notifications::emit_catalog_import_rows_skipped(
                &pool, actor_id, skipped, pc, pu, vs,
            )
            .await
            {
                tracing::error!(error = %e, "emit_catalog_import_rows_skipped");
            }
        });
    }
    if let Some(c) = state.meilisearch.clone() {
        let pool = state.db.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::logic::meilisearch_sync::reindex_all_meilisearch(&c, &pool).await
            {
                tracing::error!(error = %e, "Meilisearch reindex after catalog import failed");
            }
        });
    }
    Ok(Json(summary))
}

async fn generate_matrix(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<GenerateMatrixRequest>,
) -> Result<Json<Vec<GeneratedVariant>>, ProductError> {
    require_catalog_perm(&state, &headers, CATALOG_EDIT).await?;
    if payload.axes.is_empty() || payload.axes.len() > 3 {
        return Err(ProductError::InvalidPayload("provide 1-3 axes".to_string()));
    }
    for axis in &payload.axes {
        if axis.name.trim().is_empty() || axis.options.is_empty() {
            return Err(ProductError::InvalidPayload(
                "each axis needs a name and at least one option".to_string(),
            ));
        }
    }

    let mut results: Vec<GeneratedVariant> = Vec::new();
    fn build(
        axes: &[MatrixAxisInput],
        index: usize,
        current: &mut Vec<(String, String)>,
        out: &mut Vec<GeneratedVariant>,
    ) {
        if index == axes.len() {
            let mut map = serde_json::Map::new();
            let label_parts: Vec<String> = current.iter().map(|(_, v)| v.clone()).collect();
            for (k, v) in current.iter() {
                map.insert(k.clone(), Value::String(v.clone()));
            }
            out.push(GeneratedVariant {
                variation_values: Value::Object(map),
                variation_label: label_parts.join(" / "),
            });
            return;
        }
        let axis = &axes[index];
        for option in &axis.options {
            current.push((axis.name.clone(), option.clone()));
            build(axes, index + 1, current, out);
            current.pop();
        }
    }
    build(&payload.axes, 0, &mut Vec::new(), &mut results);

    Ok(Json(results))
}

async fn create_product(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateProductRequest>,
) -> Result<Json<ProductRow>, ProductError> {
    require_catalog_perm(&state, &headers, CATALOG_EDIT).await?;
    let (normalized_axes, normalized_skus) = validate_create_product_payload(&payload)?;
    ensure_category_exists(&state.db, payload.category_id).await?;
    ensure_skus_do_not_exist(&state.db, &normalized_skus).await?;

    let mut tx = state.db.begin().await?;

    let product: ProductRow = sqlx::query_as(
        r#"
        INSERT INTO products (
            category_id, name, brand, description, base_retail_price, base_cost, variation_axes, images,
            track_low_stock, tax_category_override
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, name, brand, base_retail_price, base_cost
        "#,
    )
    .bind(payload.category_id)
    .bind(payload.name.trim())
    .bind(payload.brand.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(payload.description.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(payload.base_retail_price)
    .bind(payload.base_cost)
    .bind(normalized_axes)
    .bind(payload.images.unwrap_or_default())
    .bind(payload.track_low_stock)
    .bind(payload.tax_category_override)
    .fetch_one(&mut *tx)
    .await?;

    for variant in payload.variants {
        sqlx::query(
            r#"
            INSERT INTO product_variants (
                product_id, sku, variation_values, variation_label, stock_on_hand,
                retail_price_override, cost_override, track_low_stock, web_published
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            "#,
        )
        .bind(product.id)
        .bind(variant.sku.trim())
        .bind(variant.variation_values)
        .bind(variant.variation_label)
        .bind(variant.stock_on_hand.unwrap_or(0))
        .bind(variant.retail_price_override)
        .bind(variant.cost_override)
        .bind(variant.track_low_stock)
        .bind(payload.publish_variants_to_web)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    let pid = product.id;
    spawn_meilisearch_product_resync(&state, pid);
    Ok(Json(product))
}

async fn list_products(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ProductRow>>, ProductError> {
    require_catalog_perm(&state, &headers, CATALOG_VIEW).await?;
    let rows = sqlx::query_as::<_, ProductRow>(
        r#"
        SELECT id, name, brand, base_retail_price, base_cost
        FROM products
        WHERE is_active = true
        ORDER BY created_at DESC
        LIMIT 200
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

/// Control board JSON (also mounted at `GET /api/inventory/control-board`).
///
/// Filters (search, category, vendor, etc.) are applied in SQL. Historically a `LIMIT 1000` ran
/// *before* filtering, which hid most SKUs in large catalogs from both Back Office and Register fuzzy search.
pub async fn list_control_board(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<InventoryBoardQuery>,
) -> Result<Json<InventoryControlResponse>, ProductError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(|(_, axum::Json(v))| {
            let msg = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("unauthorized")
                .to_string();
            ProductError::Unauthorized(msg)
        })?;
    let search_raw = query.search.as_deref().map(str::trim).unwrap_or("");
    let has_search = !search_raw.is_empty();
    let parent_rank_first = query.parent_rank_first.unwrap_or(false) && has_search;
    let filter = query.filter.as_deref().unwrap_or("all");
    let brand_raw = query
        .brand
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let default_limit = if has_search { 5_000i64 } else { 25_000i64 };
    let limit = query.limit.unwrap_or(default_limit).clamp(1, 50_000);
    let offset = query.offset.unwrap_or(0).max(0);

    let meili_variant_ids: Option<Vec<Uuid>> = if has_search {
        if let Some(ref c) = state.meilisearch {
            match crate::logic::meilisearch_search::control_board_search_variant_ids(
                c,
                search_raw,
                query.category_id,
                query.vendor_id,
                query.web_published_only.unwrap_or(false),
                query.clothing_only.unwrap_or(false),
                query.filter.as_deref(),
                query.oos_only,
                query.negative_stock_only,
            )
            .await
            {
                Ok(ids) => Some(ids),
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "Meilisearch inventory search failed; using PostgreSQL ILIKE"
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

    let mut qb = QueryBuilder::new(
        r#"
        SELECT
            pv.id AS variant_id,
            p.id AS product_id,
            variant_totals.total_variant_count,
            pv.sku,
            pv.barcode,
            p.name AS product_name,
            p.brand,
            pv.variation_label,
            c.id AS category_id,
            c.name AS category_name,
            c.is_clothing_footwear,
            pv.stock_on_hand,
            GREATEST(0, pv.stock_on_hand - pv.reserved_stock)::integer AS available_stock,
            COALESCE(pv.retail_price_override, p.base_retail_price) AS retail_price,
            COALESCE(pv.cost_override, p.base_cost) AS cost_price,
            p.base_retail_price,
            p.base_cost,
            pv.shelf_labeled_at,
            COALESCE(pv.web_published, false) AS web_published,
            pv.web_price_override,
            p.primary_vendor_id,
            pvendor.name AS primary_vendor_name,
            lv.id AS last_vendor_id,
            lv.name AS last_vendor_name,
            p.tax_category_override,
            p.tax_category,
            0::numeric AS state_tax,
            0::numeric AS local_tax
        "#,
    );
    if has_search {
        qb.push(", COALESCE(st.units_sold, 0)::bigint AS units_sold_trailing ");
    } else {
        qb.push(", 0::bigint AS units_sold_trailing ");
    }
    qb.push(
        r#"
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::bigint AS total_variant_count
            FROM product_variants pv_total
            WHERE pv_total.product_id = p.id
        ) variant_totals ON true
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN vendors pvendor ON pvendor.id = p.primary_vendor_id
        LEFT JOIN LATERAL (
            SELECT v.id, v.name
            FROM purchase_order_lines pol
            JOIN purchase_orders po ON po.id = pol.purchase_order_id
            JOIN vendors v ON v.id = po.vendor_id
            WHERE pol.variant_id = pv.id
            ORDER BY po.ordered_at DESC
            LIMIT 1
        ) lv ON true
        "#,
    );
    if has_search {
        qb.push(
            r#"
        LEFT JOIN (
            SELECT oi.product_id, COALESCE(SUM(oi.quantity::bigint), 0) AS units_sold
            FROM transaction_lines oi
            INNER JOIN transactions o ON o.id = oi.transaction_id
            WHERE oi.product_id IS NOT NULL
              AND o.booked_at >= NOW() - "#,
        );
        qb.push(format!(
            "INTERVAL '{CONTROL_BOARD_SEARCH_SALES_WINDOW_DAYS} days'"
        ));
        qb.push(
            r#"
              AND o.status <> 'cancelled'::order_status
        "#,
        );
        if let Some(ids) = &meili_variant_ids {
            if !ids.is_empty() {
                qb.push(
                    r#"
              AND oi.product_id IN (
                  SELECT pv_search.product_id
                  FROM product_variants pv_search
                  WHERE pv_search.id = ANY("#,
                );
                qb.push_bind(ids.clone());
                qb.push(
                    r#")
              )
        "#,
                );
            }
        }
        qb.push(
            r#"
            GROUP BY oi.product_id
        ) st ON st.product_id = p.id
        "#,
        );
    }
    qb.push(" WHERE p.is_active = true ");

    if let Some(ids) = &meili_variant_ids {
        if ids.is_empty() {
            qb.push(" AND FALSE ");
        } else {
            qb.push(" AND pv.id = ANY(");
            qb.push_bind(ids.clone());
            qb.push(")");
        }
    } else if has_search {
        let pat = control_board_ilike_pattern(search_raw);
        qb.push(" AND (pv.sku ILIKE ");
        qb.push_bind(pat.clone());
        qb.push(" ESCAPE '\\' OR COALESCE(pv.barcode, '') ILIKE ");
        qb.push_bind(pat.clone());
        qb.push(" ESCAPE '\\' OR COALESCE(pv.vendor_upc, '') ILIKE ");
        qb.push_bind(pat.clone());
        qb.push(" ESCAPE '\\' OR p.name ILIKE ");
        qb.push_bind(pat.clone());
        qb.push(" ESCAPE '\\' OR COALESCE(p.catalog_handle, '') ILIKE ");
        qb.push_bind(pat.clone());
        qb.push(" ESCAPE '\\' OR COALESCE(p.brand, '') ILIKE ");
        qb.push_bind(pat.clone());
        qb.push(" ESCAPE '\\' OR COALESCE(pv.variation_label, '') ILIKE ");
        qb.push_bind(pat);
        qb.push(" ESCAPE '\\')");
    }

    if let Some(category_id) = query.category_id {
        qb.push(" AND p.category_id = ");
        qb.push_bind(category_id);
    }
    if let Some(product_id) = query.product_id {
        qb.push(" AND p.id = ");
        qb.push_bind(product_id);
    }
    if let Some(vendor_id) = query.vendor_id {
        qb.push(" AND p.primary_vendor_id = ");
        qb.push_bind(vendor_id);
    }
    if let Some(brand) = brand_raw {
        let pat = control_board_ilike_pattern(brand);
        qb.push(" AND p.brand ILIKE ");
        qb.push_bind(pat);
        qb.push(" ESCAPE '\\'");
    }
    if query.unlabeled_only.unwrap_or(false) {
        qb.push(" AND pv.shelf_labeled_at IS NULL");
    }
    if let Some(min_lv) = query.min_line_value {
        qb.push(" AND (COALESCE(pv.cost_override, p.base_cost) * pv.stock_on_hand::numeric) >= ");
        qb.push_bind(min_lv);
    }
    if query.oos_low_only.unwrap_or(false) || filter == "low_stock" || filter == "oos_low" {
        qb.push(" AND pv.stock_on_hand <= 2");
    }
    if query.clothing_only.unwrap_or(false) || filter == "clothing" {
        qb.push(" AND c.is_clothing_footwear IS TRUE");
    }
    if query.web_published_only.unwrap_or(false) {
        qb.push(" AND COALESCE(pv.web_published, false) = true");
    }
    if query.oos_only.unwrap_or(false) || filter == "oos" {
        qb.push(" AND pv.stock_on_hand <= 0");
    }
    if query.negative_stock_only.unwrap_or(false) || filter == "negative" {
        qb.push(" AND pv.stock_on_hand < 0");
    }

    if has_search {
        if parent_rank_first {
            let pr_pat = control_board_ilike_pattern(search_raw);
            qb.push(" ORDER BY CASE WHEN (p.name ILIKE ");
            qb.push_bind(pr_pat.clone());
            qb.push(" ESCAPE '\\' OR COALESCE(p.brand, '') ILIKE ");
            qb.push_bind(pr_pat.clone());
            qb.push(" ESCAPE '\\' OR COALESCE(p.catalog_handle, '') ILIKE ");
            qb.push_bind(pr_pat.clone());
            qb.push(" ESCAPE '\\') THEN 0 ELSE 1 END, ");
            if let Some(ids) = &meili_variant_ids {
                if !ids.is_empty() {
                    qb.push("array_position(");
                    qb.push_bind(ids.clone());
                    qb.push("::uuid[], pv.id), ");
                }
            }
            qb.push("units_sold_trailing DESC, p.name ASC, pv.sku ASC LIMIT ");
        } else {
            qb.push(" ORDER BY units_sold_trailing DESC, p.name ASC, pv.sku ASC LIMIT ");
        }
    } else {
        qb.push(" ORDER BY p.name ASC, pv.sku ASC LIMIT ");
    }
    qb.push_bind(limit);
    qb.push(" OFFSET ");
    qb.push_bind(offset);

    let rows = qb
        .build_query_as::<InventoryControlRow>()
        .fetch_all(&state.db)
        .await?;

    // Fill in actual taxes using the logic module
    let rows: Vec<InventoryControlRow> = rows
        .into_iter()
        .map(|mut r| {
            let logic_tax_cat = if let Some(override_category) = r.tax_category_override {
                override_category
            } else if r.is_clothing_footwear.unwrap_or(false) {
                let cat_name = r.category_name.as_deref().unwrap_or("").to_lowercase();
                if cat_name.contains("shoe") || cat_name.contains("footwear") {
                    crate::logic::tax::TaxCategory::Footwear
                } else {
                    crate::logic::tax::TaxCategory::Clothing
                }
            } else {
                crate::logic::tax::TaxCategory::Other
            };

            r.state_tax =
                crate::logic::tax::nys_state_tax_usd(logic_tax_cat, r.retail_price, r.retail_price);
            r.local_tax = crate::logic::tax::erie_local_tax_usd(
                logic_tax_cat,
                r.retail_price,
                r.retail_price,
            );
            r.tax_category = logic_tax_cat;
            r
        })
        .collect();

    let stats = if let Some(vid) = query.vendor_id {
        sqlx::query_as::<_, InventoryStats>(
            r#"
            SELECT
                COALESCE(SUM((COALESCE(pv.cost_override, p.base_cost) * pv.stock_on_hand)::numeric), 0)::numeric(12,2) AS total_asset_value,
                COALESCE(SUM(CASE WHEN pv.stock_on_hand <= 0 THEN 1 ELSE 0 END), 0)::bigint AS skus_out_of_stock,
                1::bigint AS active_vendors,
                COALESCE(SUM(CASE WHEN pv.shelf_labeled_at IS NULL THEN 1 ELSE 0 END), 0)::bigint AS need_label_skus,
                COALESCE((
                    SELECT COUNT(*)::bigint
                    FROM product_variants pv2
                    JOIN products p2 ON p2.id = pv2.product_id
                    WHERE p2.is_active = true
                      AND p2.primary_vendor_id = $1
                      AND pv2.stock_on_hand <= 0
                      AND EXISTS (
                          SELECT 1
                          FROM transaction_lines oi
                          INNER JOIN transactions o ON o.id = oi.transaction_id
                          WHERE oi.variant_id = pv2.id
                            AND o.status::text NOT IN ('cancelled')
                            AND o.booked_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '365 days'
                      )
                ), 0)::bigint AS oos_replenishment_skus
            FROM product_variants pv
            JOIN products p ON p.id = pv.product_id
            WHERE p.is_active = true
              AND p.primary_vendor_id = $1
            "#,
        )
        .bind(vid)
        .fetch_one(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, InventoryStats>(
            r#"
            SELECT
                COALESCE(SUM((COALESCE(pv.cost_override, p.base_cost) * pv.stock_on_hand)::numeric), 0)::numeric(12,2) AS total_asset_value,
                COALESCE(SUM(CASE WHEN pv.stock_on_hand <= 0 THEN 1 ELSE 0 END), 0)::bigint AS skus_out_of_stock,
                COALESCE(COUNT(DISTINCT p.primary_vendor_id), 0)::bigint AS active_vendors,
                COALESCE(SUM(CASE WHEN pv.shelf_labeled_at IS NULL THEN 1 ELSE 0 END), 0)::bigint AS need_label_skus,
                COALESCE((
                    SELECT COUNT(*)::bigint
                    FROM product_variants pv2
                    JOIN products p2 ON p2.id = pv2.product_id
                    WHERE p2.is_active = true
                      AND pv2.stock_on_hand <= 0
                      AND EXISTS (
                          SELECT 1
                          FROM transaction_lines oi
                          INNER JOIN transactions o ON o.id = oi.transaction_id
                          WHERE oi.variant_id = pv2.id
                            AND o.status::text NOT IN ('cancelled')
                            AND o.booked_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '365 days'
                      )
                ), 0)::bigint AS oos_replenishment_skus
            FROM product_variants pv
            JOIN products p ON p.id = pv.product_id
            WHERE p.is_active = true
            "#,
        )
        .fetch_one(&state.db)
        .await?
    };

    Ok(Json(InventoryControlResponse { rows, stats }))
}

async fn bulk_update_product_model(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<BulkUpdateRequest>,
) -> Result<Json<serde_json::Value>, ProductError> {
    require_catalog_perm(&state, &headers, CATALOG_EDIT).await?;
    if payload.retail_price_override.is_none()
        && payload.cost_override.is_none()
        && payload.category_id.is_none()
    {
        return Err(ProductError::InvalidPayload(
            "provide at least one field to update".to_string(),
        ));
    }

    let mut tx = state.db.begin().await?;

    if payload.category_id.is_some() {
        sqlx::query(
            r#"
            UPDATE products
            SET category_id = $1
            WHERE id = $2
            "#,
        )
        .bind(payload.category_id)
        .bind(payload.product_id)
        .execute(&mut *tx)
        .await?;
    }

    if payload.retail_price_override.is_some() || payload.cost_override.is_some() {
        sqlx::query(
            r#"
            UPDATE product_variants
            SET
                retail_price_override = COALESCE($1, retail_price_override),
                cost_override = COALESCE($2, cost_override)
            WHERE product_id = $3
            "#,
        )
        .bind(payload.retail_price_override)
        .bind(payload.cost_override)
        .bind(payload.product_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    spawn_meilisearch_product_resync(&state, payload.product_id);
    Ok(Json(json!({ "status": "updated" })))
}

async fn patch_product_model(
    State(state): State<AppState>,
    Path(product_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<PatchProductModelRequest>,
) -> Result<Json<Value>, ProductError> {
    let actor = require_catalog_staff(&state, &headers, CATALOG_EDIT).await?;
    let current = sqlx::query_as::<_, ProductModelAuditSnapshot>(
        "SELECT name, brand, catalog_handle, tax_category_override::text FROM products WHERE id = $1 AND is_active = TRUE",
    )
    .bind(product_id)
    .fetch_optional(&state.db)
    .await?;

    let Some(current) = current else {
        return Err(ProductError::ProductNotFound);
    };

    if body.clear_catalog_handle && body.catalog_handle.is_some() {
        return Err(ProductError::InvalidPayload(
            "cannot set catalog_handle and clear_catalog_handle together".to_string(),
        ));
    }

    let audit_source = normalize_audit_source(body.audit_source.as_deref())?;

    let mut n = 0u8;
    let mut before_values = serde_json::Map::<String, Value>::new();
    let mut after_values = serde_json::Map::<String, Value>::new();
    let mut name_value: Option<String> = None;
    let mut set_name = false;
    let mut set_base_retail = false;
    let mut set_base_cost = false;
    let mut set_category = false;
    let mut category_value: Option<Uuid> = None;
    let mut set_brand = false;
    let mut brand_value: Option<String> = None;
    let mut set_catalog_handle = false;
    let mut catalog_handle_value: Option<String> = None;
    let mut set_employee_markup = false;
    let mut employee_markup_value: Option<Decimal> = None;
    let mut set_employee_extra = false;
    let mut employee_extra_value: Option<Decimal> = None;
    let mut set_primary_vendor = false;
    let mut primary_vendor_value: Option<Uuid> = None;
    let mut set_is_bundle = false;
    let mut is_bundle_value = false;
    let mut set_track_low_stock = false;
    let mut track_low_stock_value = false;
    let mut set_tax_category_override = false;
    let mut tax_category_override_value: Option<crate::logic::tax::TaxCategory> = None;

    if let Some(ref name) = body.name {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(ProductError::InvalidPayload("name is required".to_string()));
        }
        set_name = true;
        name_value = Some(trimmed.to_string());
        n += 1;
        if current.name != trimmed {
            before_values.insert("name".to_string(), Value::String(current.name.clone()));
            after_values.insert("name".to_string(), Value::String(trimmed.to_string()));
        }
    }

    if let Some(p) = body.base_retail_price {
        if p < Decimal::ZERO {
            return Err(ProductError::InvalidPayload(
                "base_retail_price must be non-negative".to_string(),
            ));
        }
        set_base_retail = true;
        n += 1;
    }
    if let Some(c) = body.base_cost {
        if c < Decimal::ZERO {
            return Err(ProductError::InvalidPayload(
                "base_cost must be non-negative".to_string(),
            ));
        }
        set_base_cost = true;
        n += 1;
    }
    if body.clear_category_id {
        set_category = true;
        n += 1;
    } else if let Some(cid) = body.category_id {
        ensure_category_exists(&state.db, Some(cid)).await?;
        set_category = true;
        category_value = Some(cid);
        n += 1;
    }
    if let Some(ref b) = body.brand {
        let t = b.trim();
        let brand_val = if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        };
        set_brand = true;
        brand_value = brand_val.clone();
        n += 1;
        let normalized_before = normalize_optional_text(current.brand.as_deref());
        let normalized_after = brand_val;
        if normalized_before != normalized_after {
            before_values.insert(
                "brand".to_string(),
                normalized_before.map(Value::String).unwrap_or(Value::Null),
            );
            after_values.insert(
                "brand".to_string(),
                normalized_after.map(Value::String).unwrap_or(Value::Null),
            );
        }
    }

    if body.clear_catalog_handle {
        set_catalog_handle = true;
        n += 1;
        if current.catalog_handle.is_some() {
            before_values.insert(
                "catalog_handle".to_string(),
                current
                    .catalog_handle
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
            after_values.insert("catalog_handle".to_string(), Value::Null);
        }
    } else if let Some(ref handle) = body.catalog_handle {
        let trimmed = handle.trim();
        if trimmed.is_empty() {
            return Err(ProductError::InvalidPayload(
                "catalog_handle must be non-empty when provided".to_string(),
            ));
        }
        let existing_conflict: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM products WHERE lower(catalog_handle) = lower($1) AND id <> $2 LIMIT 1",
        )
        .bind(trimmed)
        .bind(product_id)
        .fetch_optional(&state.db)
        .await?;
        if existing_conflict.is_some() {
            return Err(ProductError::InvalidPayload(
                "catalog_handle is already in use by another product".to_string(),
            ));
        }
        set_catalog_handle = true;
        catalog_handle_value = Some(trimmed.to_string());
        n += 1;
        let normalized_before = normalize_optional_text(current.catalog_handle.as_deref());
        let normalized_after = Some(trimmed.to_string());
        if normalized_before != normalized_after {
            before_values.insert(
                "catalog_handle".to_string(),
                normalized_before.map(Value::String).unwrap_or(Value::Null),
            );
            after_values.insert(
                "catalog_handle".to_string(),
                Value::String(trimmed.to_string()),
            );
        }
    }

    if body.clear_employee_markup_percent && body.employee_markup_percent.is_some() {
        return Err(ProductError::InvalidPayload(
            "cannot set employee_markup_percent and clear_employee_markup_percent together"
                .to_string(),
        ));
    }

    if body.clear_primary_vendor_id && body.primary_vendor_id.is_some() {
        return Err(ProductError::InvalidPayload(
            "cannot set primary_vendor_id and clear_primary_vendor_id together".to_string(),
        ));
    }

    if body.clear_employee_markup_percent {
        set_employee_markup = true;
        n += 1;
    } else if let Some(m) = body.employee_markup_percent {
        if m < Decimal::ZERO {
            return Err(ProductError::InvalidPayload(
                "employee_markup_percent must be non-negative".to_string(),
            ));
        }
        set_employee_markup = true;
        employee_markup_value = Some(m);
        n += 1;
    }
    if let Some(x) = body.employee_extra_amount {
        if x < Decimal::ZERO {
            return Err(ProductError::InvalidPayload(
                "employee_extra_amount must be non-negative".to_string(),
            ));
        }
        set_employee_extra = true;
        employee_extra_value = Some(x);
        n += 1;
    }

    if body.clear_primary_vendor_id {
        set_primary_vendor = true;
        n += 1;
    } else if let Some(vid) = body.primary_vendor_id {
        let vendor_ok: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM vendors WHERE id = $1 AND is_active = TRUE)",
        )
        .bind(vid)
        .fetch_one(&state.db)
        .await?;

        if !vendor_ok {
            return Err(ProductError::InvalidPayload(
                "primary_vendor_id not found or inactive".to_string(),
            ));
        }
        set_primary_vendor = true;
        primary_vendor_value = Some(vid);
        n += 1;
    }

    if let Some(ib) = body.is_bundle {
        set_is_bundle = true;
        is_bundle_value = ib;
        n += 1;
    }

    if let Some(t) = body.track_low_stock {
        set_track_low_stock = true;
        track_low_stock_value = t;
        n += 1;
    }

    if body.clear_tax_category_override && body.tax_category_override.is_some() {
        return Err(ProductError::InvalidPayload(
            "cannot set tax_category_override and clear_tax_category_override together".to_string(),
        ));
    }
    if body.clear_tax_category_override {
        set_tax_category_override = true;
        n += 1;
        if current.tax_category_override.is_some() {
            before_values.insert(
                "tax_category_override".to_string(),
                current
                    .tax_category_override
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
            after_values.insert("tax_category_override".to_string(), Value::Null);
        }
    } else if let Some(category) = body.tax_category_override {
        set_tax_category_override = true;
        tax_category_override_value = Some(category);
        n += 1;
        let after = format!("{category:?}").to_ascii_lowercase();
        if current.tax_category_override.as_deref() != Some(after.as_str()) {
            before_values.insert(
                "tax_category_override".to_string(),
                current
                    .tax_category_override
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
            after_values.insert("tax_category_override".to_string(), Value::String(after));
        }
    }

    if n == 0 {
        return Err(ProductError::InvalidPayload(
            "provide at least one field".to_string(),
        ));
    }

    let mut tx = state.db.begin().await?;
    sqlx::query(
        r#"
        UPDATE products
        SET
            name = CASE WHEN $1 THEN $2 ELSE name END,
            base_retail_price = CASE WHEN $3 THEN $4 ELSE base_retail_price END,
            base_cost = CASE WHEN $5 THEN $6 ELSE base_cost END,
            category_id = CASE
                WHEN $7 THEN NULL
                WHEN $8 THEN $9
                ELSE category_id
            END,
            brand = CASE WHEN $10 THEN $11 ELSE brand END,
            catalog_handle = CASE
                WHEN $12 THEN NULL
                WHEN $13 THEN $14
                ELSE catalog_handle
            END,
            employee_markup_percent = CASE
                WHEN $15 THEN NULL
                WHEN $16 THEN $17
                ELSE employee_markup_percent
            END,
            employee_extra_amount = CASE WHEN $18 THEN $19 ELSE employee_extra_amount END,
            primary_vendor_id = CASE
                WHEN $20 THEN NULL
                WHEN $21 THEN $22
                ELSE primary_vendor_id
            END,
            is_bundle = CASE WHEN $23 THEN $24 ELSE is_bundle END,
            track_low_stock = CASE WHEN $25 THEN $26 ELSE track_low_stock END,
            tax_category_override = CASE
                WHEN $27 THEN NULL
                WHEN $28 THEN $29
                ELSE tax_category_override
            END
        WHERE id = $30
        "#,
    )
    .bind(set_name)
    .bind(name_value)
    .bind(set_base_retail)
    .bind(body.base_retail_price)
    .bind(set_base_cost)
    .bind(body.base_cost)
    .bind(body.clear_category_id)
    .bind(set_category && !body.clear_category_id)
    .bind(category_value)
    .bind(set_brand)
    .bind(brand_value)
    .bind(body.clear_catalog_handle)
    .bind(set_catalog_handle && !body.clear_catalog_handle)
    .bind(catalog_handle_value)
    .bind(body.clear_employee_markup_percent)
    .bind(set_employee_markup && !body.clear_employee_markup_percent)
    .bind(employee_markup_value)
    .bind(set_employee_extra)
    .bind(employee_extra_value)
    .bind(body.clear_primary_vendor_id)
    .bind(set_primary_vendor && !body.clear_primary_vendor_id)
    .bind(primary_vendor_value)
    .bind(set_is_bundle)
    .bind(is_bundle_value)
    .bind(set_track_low_stock)
    .bind(track_low_stock_value)
    .bind(body.clear_tax_category_override)
    .bind(set_tax_category_override && !body.clear_tax_category_override)
    .bind(tax_category_override_value)
    .bind(product_id)
    .execute(&mut *tx)
    .await?;

    if !before_values.is_empty() {
        let note = body
            .audit_note
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                build_catalog_change_summary(
                    &Value::Object(before_values.clone()),
                    &Value::Object(after_values.clone()),
                )
            });
        sqlx::query(
            r#"
            INSERT INTO product_catalog_audit_log (
                product_id,
                changed_by,
                change_source,
                before_values,
                after_values,
                change_note,
                suggestion_confidence
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
        )
        .bind(product_id)
        .bind(actor.id)
        .bind(audit_source)
        .bind(Value::Object(before_values))
        .bind(Value::Object(after_values))
        .bind(note)
        .bind(body.audit_confidence)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    spawn_meilisearch_product_resync(&state, product_id);
    Ok(Json(json!({ "status": "updated" })))
}

async fn bulk_set_product_model(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BulkProductModelRequest>,
) -> Result<Json<Value>, ProductError> {
    require_catalog_perm(&state, &headers, CATALOG_EDIT).await?;
    if body.product_ids.is_empty() {
        return Err(ProductError::InvalidPayload(
            "product_ids cannot be empty".to_string(),
        ));
    }
    if body.brand.is_none() && body.category_id.is_none() {
        return Err(ProductError::InvalidPayload(
            "provide brand and/or category_id".to_string(),
        ));
    }

    let brand_bind = body
        .brand
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut tx = state.db.begin().await?;

    if body.brand.is_some() {
        let b = brand_bind;
        sqlx::query("UPDATE products SET brand = $1 WHERE id = ANY($2)")
            .bind(b)
            .bind(&body.product_ids[..])
            .execute(&mut *tx)
            .await?;
    }

    if let Some(cid) = body.category_id {
        sqlx::query("UPDATE products SET category_id = $1 WHERE id = ANY($2)")
            .bind(cid)
            .bind(&body.product_ids[..])
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    spawn_meilisearch_products_resync(&state, &body.product_ids);
    Ok(Json(json!({ "status": "updated" })))
}

async fn bulk_archive_products(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BulkArchiveProductsRequest>,
) -> Result<Json<Value>, ProductError> {
    require_catalog_perm(&state, &headers, CATALOG_EDIT).await?;
    if body.product_ids.is_empty() {
        return Err(ProductError::InvalidPayload(
            "product_ids cannot be empty".to_string(),
        ));
    }

    sqlx::query("UPDATE products SET is_active = FALSE WHERE id = ANY($1)")
        .bind(&body.product_ids[..])
        .execute(&state.db)
        .await?;

    spawn_meilisearch_products_resync(&state, &body.product_ids);
    Ok(Json(json!({ "status": "archived" })))
}

async fn bulk_mark_shelf_labeled(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BulkMarkShelfLabeledRequest>,
) -> Result<Json<Value>, ProductError> {
    require_catalog_perm(&state, &headers, CATALOG_EDIT).await?;
    if body.variant_ids.is_empty() {
        return Err(ProductError::InvalidPayload(
            "variant_ids cannot be empty".to_string(),
        ));
    }

    sqlx::query("UPDATE product_variants SET shelf_labeled_at = NOW() WHERE id = ANY($1)")
        .bind(&body.variant_ids[..])
        .execute(&state.db)
        .await?;

    Ok(Json(json!({ "status": "updated" })))
}

async fn bulk_web_publish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BulkWebPublishRequest>,
) -> Result<Json<Value>, ProductError> {
    require_catalog_perm(&state, &headers, CATALOG_EDIT).await?;
    if body.variant_ids.is_empty() {
        return Err(ProductError::InvalidPayload(
            "variant_ids cannot be empty".to_string(),
        ));
    }
    if body.variant_ids.len() > 500 {
        return Err(ProductError::InvalidPayload(
            "variant_ids exceeds maximum of 500".to_string(),
        ));
    }

    sqlx::query(
        r#"
        UPDATE product_variants
        SET web_published = $2
        WHERE id = ANY($1)
        "#,
    )
    .bind(&body.variant_ids[..])
    .bind(body.web_published)
    .execute(&state.db)
    .await?;

    let pids: Vec<Uuid> =
        sqlx::query_scalar("SELECT DISTINCT product_id FROM product_variants WHERE id = ANY($1)")
            .bind(&body.variant_ids[..])
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();
    spawn_meilisearch_products_resync(&state, &pids);

    Ok(Json(json!({ "status": "updated" })))
}

#[derive(Debug, Serialize, FromRow)]
struct VariantRow {
    id: Uuid,
    sku: String,
    variation_values: Value,
    variation_label: Option<String>,
    stock_on_hand: i32,
    web_published: bool,
    web_price_override: Option<Decimal>,
    web_gallery_order: i32,
}

async fn load_product_po_summary(
    db: &sqlx::PgPool,
    product_id: Uuid,
) -> Result<ProductPoSummary, sqlx::Error> {
    #[derive(Debug, FromRow)]
    struct PoAggRow {
        open_po_count: i64,
        pending_receive_units: i64,
        pending_commit_value_usd: Decimal,
    }

    let agg = sqlx::query_as::<_, PoAggRow>(
        r#"
        SELECT
            COUNT(DISTINCT po.id) FILTER (
                WHERE po.status IN (
                    'draft'::purchase_order_status,
                    'submitted'::purchase_order_status,
                    'partially_received'::purchase_order_status
                )
            )::bigint AS open_po_count,
            COALESCE(SUM(
                CASE WHEN po.status IN (
                    'draft'::purchase_order_status,
                    'submitted'::purchase_order_status,
                    'partially_received'::purchase_order_status
                )
                    THEN GREATEST(0, pol.quantity_ordered - pol.quantity_received)
                    ELSE 0 END
            ), 0)::bigint AS pending_receive_units,
            COALESCE(SUM(
                CASE WHEN po.status IN (
                    'draft'::purchase_order_status,
                    'submitted'::purchase_order_status,
                    'partially_received'::purchase_order_status
                )
                    THEN GREATEST(0, pol.quantity_ordered - pol.quantity_received)::numeric * pol.unit_cost
                    ELSE 0 END
            ), 0)::numeric(12, 2) AS pending_commit_value_usd
        FROM purchase_order_lines pol
        JOIN purchase_orders po ON po.id = pol.purchase_order_id
        JOIN product_variants pv ON pv.id = pol.variant_id
        WHERE pv.product_id = $1
        "#,
    )
    .bind(product_id)
    .fetch_one(db)
    .await?;

    let recent_lines = sqlx::query_as::<_, ProductPoSummaryLine>(
        r#"
        SELECT
            po.id AS purchase_order_id,
            po.po_number,
            po.status::text AS status,
            po.ordered_at,
            v.name AS vendor_name,
            pv.sku,
            pol.quantity_ordered,
            pol.quantity_received
        FROM purchase_order_lines pol
        JOIN purchase_orders po ON po.id = pol.purchase_order_id
        JOIN vendors v ON v.id = po.vendor_id
        JOIN product_variants pv ON pv.id = pol.variant_id
        WHERE pv.product_id = $1
        ORDER BY po.ordered_at DESC, pol.id DESC
        LIMIT 12
        "#,
    )
    .bind(product_id)
    .fetch_all(db)
    .await?;

    Ok(ProductPoSummary {
        open_po_count: agg.open_po_count,
        pending_receive_units: agg.pending_receive_units,
        pending_commit_value_usd: agg.pending_commit_value_usd,
        recent_lines,
    })
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct BundleComponentRow {
    component_variant_id: Uuid,
    quantity: i32,
    sku: String,
    product_name: String,
}

async fn get_product_bundle_components(
    State(state): State<AppState>,
    Path(product_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<BundleComponentRow>>, ProductError> {
    require_catalog_or_procurement_view(&state, &headers).await?;
    let rows = sqlx::query_as::<_, BundleComponentRow>(
        r#"
        SELECT c.component_variant_id, c.quantity, v.sku, p.name AS product_name
        FROM product_bundle_components c
        JOIN product_variants v ON v.id = c.component_variant_id
        JOIN products p ON p.id = v.product_id
        WHERE c.bundle_product_id = $1
        ORDER BY v.sku ASC
        "#,
    )
    .bind(product_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn get_product_po_summary(
    State(state): State<AppState>,
    Path(product_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<ProductPoSummary>, ProductError> {
    require_catalog_or_procurement_view(&state, &headers).await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM products WHERE id = $1 AND is_active = TRUE)",
    )
    .bind(product_id)
    .fetch_one(&state.db)
    .await?;

    if !exists {
        return Err(ProductError::ProductNotFound);
    }

    let summary = load_product_po_summary(&state.db, product_id)
        .await
        .map_err(ProductError::Database)?;
    Ok(Json(summary))
}

async fn clear_product_retail_overrides(
    State(state): State<AppState>,
    Path(product_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Value>, ProductError> {
    require_catalog_perm(&state, &headers, CATALOG_EDIT).await?;
    let ok: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM products WHERE id = $1 AND is_active = TRUE)",
    )
    .bind(product_id)
    .fetch_one(&state.db)
    .await?;

    if !ok {
        return Err(ProductError::ProductNotFound);
    }

    let res = sqlx::query(
        r#"
        UPDATE product_variants
        SET retail_price_override = NULL
        WHERE product_id = $1
        "#,
    )
    .bind(product_id)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "cleared": res.rows_affected() })))
}

#[derive(Debug, FromRow)]
struct ProductModelAuditSnapshot {
    name: String,
    brand: Option<String>,
    catalog_handle: Option<String>,
    tax_category_override: Option<String>,
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn normalize_audit_source(value: Option<&str>) -> Result<String, ProductError> {
    match value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("manual")
        .to_ascii_lowercase()
        .as_str()
    {
        "manual" => Ok("manual".to_string()),
        "rosie" => Ok("rosie".to_string()),
        _ => Err(ProductError::InvalidPayload(
            "audit_source must be 'manual' or 'rosie'".to_string(),
        )),
    }
}

fn build_catalog_change_summary(before_values: &Value, after_values: &Value) -> String {
    let mut fragments = Vec::new();
    for key in ["name", "brand", "catalog_handle"] {
        let before = before_values
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("—");
        let after = after_values.get(key).and_then(Value::as_str).unwrap_or("—");
        if before != after {
            fragments.push(format!("{key}: {before} -> {after}"));
        }
    }
    if fragments.is_empty() {
        "Catalog normalization review".to_string()
    } else {
        fragments.join("; ")
    }
}

async fn get_product_hub(
    State(state): State<AppState>,
    Path(product_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<ProductHubResponse>, ProductError> {
    let hub = fetch_product_hub(&state, &headers, product_id).await?;
    Ok(Json(hub))
}

async fn fetch_product_hub(
    state: &AppState,
    headers: &HeaderMap,
    product_id: Uuid,
) -> Result<ProductHubResponse, ProductError> {
    require_catalog_perm(state, headers, CATALOG_VIEW).await?;
    let product = sqlx::query_as::<_, ProductHubProductRow>(
        r#"
        SELECT
            p.id,
            p.name,
            p.brand,
            p.description,
            p.base_retail_price,
            p.base_cost,
            p.variation_axes,
            c.id AS category_id,
            c.name AS category_name,
            c.is_clothing_footwear,
            c.matrix_row_axis_key,
            c.matrix_col_axis_key,
            p.primary_vendor_id,
            v_primary.name AS primary_vendor_name,
            v_primary.vendor_code AS primary_vendor_code,
            p.track_low_stock,
            p.employee_markup_percent,
            COALESCE(p.employee_extra_amount, 0::numeric) AS employee_extra_amount,
            p.tax_category_override,
            p.catalog_handle AS nuorder_product_id,
            p.catalog_handle
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN vendors v_primary ON v_primary.id = p.primary_vendor_id
        WHERE p.id = $1 AND p.is_active = TRUE
        "#,
    )
    .bind(product_id)
    .fetch_optional(&state.db)
    .await?;

    let Some(product) = product else {
        return Err(ProductError::ProductNotFound);
    };

    let inventory_totals = sqlx::query_as::<_, ProductHubInventoryTotalsRow>(
        r#"
        SELECT
            COALESCE(SUM(stock_on_hand), 0)::bigint AS total_units_on_hand,
            COALESCE(SUM(reserved_stock), 0)::bigint AS total_reserved_units,
            COALESCE(SUM(GREATEST(0, stock_on_hand - reserved_stock)), 0)::bigint AS total_available_units
        FROM product_variants
        WHERE product_id = $1
        "#,
    )
    .bind(product_id)
    .fetch_one(&state.db)
    .await?;

    let last_physical_count_at: Option<DateTime<Utc>> = sqlx::query_scalar(
        r#"
        SELECT MAX(it.created_at)
        FROM inventory_transactions it
        INNER JOIN product_variants pv ON pv.id = it.variant_id
        WHERE pv.product_id = $1
          AND it.tx_type = 'physical_inventory'
        "#,
    )
    .bind(product_id)
    .fetch_one(&state.db)
    .await?;

    let value_on_hand: Decimal = sqlx::query_scalar(
        r#"
        SELECT COALESCE(
            SUM(
                pv.stock_on_hand::numeric * COALESCE(pv.retail_price_override, p.base_retail_price)
            ),
            0
        )
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        WHERE pv.product_id = $1
        "#,
    )
    .bind(product_id)
    .fetch_one(&state.db)
    .await?;

    let units_sold_all_time: i64 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(oi.quantity), 0)::bigint
        FROM transaction_lines oi
        INNER JOIN product_variants pv ON pv.id = oi.variant_id
        WHERE pv.product_id = $1
        "#,
    )
    .bind(product_id)
    .fetch_one(&state.db)
    .await?;

    let open_order_units: i64 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(oi.quantity), 0)::bigint
        FROM transaction_lines oi
        INNER JOIN product_variants pv ON pv.id = oi.variant_id
        INNER JOIN transactions o ON o.id = oi.transaction_id
        WHERE pv.product_id = $1 AND o.status = 'open'::order_status
        "#,
    )
    .bind(product_id)
    .fetch_one(&state.db)
    .await?;

    let join_rows = sqlx::query_as::<_, HubVariantJoinRow>(
        r#"
        SELECT
            pv.id,
            pv.sku,
            pv.variation_values,
            pv.variation_label,
            pv.vendor_upc,
            pv.stock_on_hand,
            pv.reserved_stock,
            GREATEST(0, pv.stock_on_hand - pv.reserved_stock)::integer AS available_stock,
            COALESCE(po_open.qty_on_order, 0)::int4 AS qty_on_order,
            physical.last_physical_count_at,
            pv.reorder_point,
            pv.track_low_stock,
            pv.retail_price_override,
            pv.cost_override,
            p.base_retail_price,
            COALESCE(pv.web_published, false) AS web_published,
            pv.web_price_override,
            pv.web_gallery_order
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(pol.quantity_ordered - pol.quantity_received), 0)::int4 AS qty_on_order
            FROM purchase_order_lines pol
            INNER JOIN purchase_orders po ON po.id = pol.purchase_order_id
            WHERE pol.variant_id = pv.id
              AND po.status IN ('submitted', 'partially_received')
        ) po_open ON true
        LEFT JOIN LATERAL (
            SELECT MAX(it.created_at) AS last_physical_count_at
            FROM inventory_transactions it
            WHERE it.variant_id = pv.id
              AND it.tx_type = 'physical_inventory'
        ) physical ON true
        WHERE pv.product_id = $1
        ORDER BY pv.created_at
        "#,
    )
    .bind(product_id)
    .fetch_all(&state.db)
    .await?;

    let variants: Vec<HubVariantRow> = join_rows
        .into_iter()
        .map(|r| HubVariantRow {
            id: r.id,
            sku: r.sku,
            variation_values: r.variation_values,
            variation_label: r.variation_label,
            vendor_upc: r.vendor_upc,
            stock_on_hand: r.stock_on_hand,
            reserved_stock: r.reserved_stock,
            available_stock: r.available_stock,
            qty_on_order: Some(r.qty_on_order),
            last_physical_count_at: r.last_physical_count_at,
            reorder_point: r.reorder_point,
            track_low_stock: r.track_low_stock,
            retail_price_override: r.retail_price_override,
            cost_override: r.cost_override,
            effective_retail: effective_retail_usd(r.base_retail_price, r.retail_price_override),
            web_published: r.web_published,
            web_price_override: r.web_price_override,
            web_gallery_order: r.web_gallery_order,
        })
        .collect();

    let staff = middleware::require_authenticated_staff_headers(state, headers)
        .await
        .map_err(map_perm_err_products)?;
    let eff = effective_permissions_for_staff(&state.db, staff.id, staff.role)
        .await
        .map_err(ProductError::Database)?;
    let can_view_procurement = staff_has_permission(&eff, PROCUREMENT_VIEW);
    let variants: Vec<HubVariantRow> = variants
        .into_iter()
        .map(|variant| HubVariantRow {
            qty_on_order: can_view_procurement.then_some(variant.qty_on_order.unwrap_or(0)),
            ..variant
        })
        .collect();

    let po_summary = if can_view_procurement {
        load_product_po_summary(&state.db, product_id)
            .await
            .map_err(ProductError::Database)?
    } else {
        ProductPoSummary {
            open_po_count: 0,
            pending_receive_units: 0,
            pending_commit_value_usd: Decimal::ZERO,
            recent_lines: vec![],
        }
    };

    Ok(ProductHubResponse {
        product,
        store_default_employee_markup_percent: state.global_employee_markup,
        can_view_procurement,
        stats: ProductHubStats {
            total_units_on_hand: inventory_totals.total_units_on_hand,
            total_reserved_units: inventory_totals.total_reserved_units,
            total_available_units: inventory_totals.total_available_units,
            value_on_hand,
            units_sold_all_time,
            open_order_units,
            last_physical_count_at,
        },
        po_summary,
        variants,
    })
}

pub(crate) async fn rosie_product_catalog_analyze(
    state: &AppState,
    headers: &HeaderMap,
    product_id: Uuid,
) -> Result<serde_json::Value, Response> {
    let hub = fetch_product_hub(state, headers, product_id)
        .await
        .map_err(IntoResponse::into_response)?;
    let analysis = analyze_product_catalog(&ProductCatalogAnalysisInput {
        title: hub.product.name.clone(),
        vendor: hub.product.primary_vendor_name.clone(),
        vendor_code: hub.product.primary_vendor_code.clone(),
        brand: hub.product.brand.clone(),
        supplier_code_hint: hub.product.catalog_handle.clone(),
        category_name: hub.product.category_name.clone(),
        variation_axes: hub.product.variation_axes.clone(),
        variant_values: hub
            .variants
            .iter()
            .map(|variant| variant.variation_values.clone())
            .collect(),
    });

    let response = RosieProductCatalogAnalysisResponse {
        tool_name: "product_catalog_analyze".to_string(),
        product_id,
        product_name: hub.product.name,
        source_route: format!("/api/products/{product_id}/hub"),
        parsed_fields: analysis.parsed_fields,
        issues_detected: analysis.issues_detected,
        confidence_score: analysis.confidence_score,
        unresolved_parts: analysis.unresolved_parts,
    };

    serde_json::to_value(response).map_err(|error| {
        tracing::error!(error = %error, %product_id, "serialize ROSIE product catalog analysis");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "failed to serialize product catalog analysis" })),
        )
            .into_response()
    })
}

pub(crate) async fn rosie_product_catalog_suggest(
    state: &AppState,
    headers: &HeaderMap,
    product_id: Uuid,
) -> Result<serde_json::Value, Response> {
    let hub = fetch_product_hub(state, headers, product_id)
        .await
        .map_err(IntoResponse::into_response)?;
    let input = ProductCatalogAnalysisInput {
        title: hub.product.name.clone(),
        vendor: hub.product.primary_vendor_name.clone(),
        vendor_code: hub.product.primary_vendor_code.clone(),
        brand: hub.product.brand.clone(),
        supplier_code_hint: hub.product.catalog_handle.clone(),
        category_name: hub.product.category_name.clone(),
        variation_axes: hub.product.variation_axes.clone(),
        variant_values: hub
            .variants
            .iter()
            .map(|variant| variant.variation_values.clone())
            .collect(),
    };
    let analysis = analyze_product_catalog(&input);
    let suggestion = suggest_product_catalog_normalization(&input, &analysis);

    let response = RosieProductCatalogSuggestionResponse {
        tool_name: "product_catalog_suggest".to_string(),
        product_id,
        product_name: hub.product.name,
        source_route: format!("/api/products/{product_id}/hub"),
        suggested_parent_title: suggestion.suggested_parent_title,
        suggested_variant_fields: suggestion.suggested_variant_fields,
        suggestion_issues: suggestion.suggestion_issues,
        suggestion_confidence: suggestion.suggestion_confidence,
        unresolved_parts: analysis.unresolved_parts,
    };

    serde_json::to_value(response).map_err(|error| {
        tracing::error!(error = %error, %product_id, "serialize ROSIE product catalog suggestion");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "failed to serialize product catalog suggestion" })),
        )
            .into_response()
    })
}

#[derive(Debug, FromRow)]
struct SaleTimelineRow {
    booked_at: DateTime<Utc>,
    quantity: i32,
    sku: String,
    transaction_id: Uuid,
    first_name: Option<String>,
    last_name: Option<String>,
}

#[derive(Debug, FromRow)]
struct InvTimelineRow {
    created_at: DateTime<Utc>,
    tx_type: String,
    quantity_delta: i32,
    sku: String,
    notes: Option<String>,
    reference_id: Option<Uuid>,
    actor_name: Option<String>,
}

#[derive(Debug, FromRow)]
struct CatalogAuditTimelineRow {
    id: Uuid,
    created_at: DateTime<Utc>,
    change_source: String,
    before_values: Value,
    after_values: Value,
    change_note: Option<String>,
    changed_by_name: Option<String>,
}

fn product_inventory_timeline_label(tx_type: &str) -> &'static str {
    match tx_type {
        "adjustment" => "Inventory adjusted",
        "damaged" => "Marked damaged",
        "return_to_vendor" => "Returned to vendor",
        "po_receipt" => "Received into stock",
        "physical_inventory" => "Physical count published",
        _ => "Inventory updated",
    }
}

fn product_catalog_timeline_label(change_source: &str) -> String {
    match change_source {
        "rosie" => "Catalog update from ROSIE".to_string(),
        "import" => "Catalog update from import".to_string(),
        other if !other.trim().is_empty() => {
            format!("Catalog update ({})", other.replace('_', " "))
        }
        _ => "Catalog update".to_string(),
    }
}

async fn get_product_timeline(
    State(state): State<AppState>,
    Path(product_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<ProductTimelineResponse>, ProductError> {
    require_catalog_perm(&state, &headers, CATALOG_VIEW).await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM products WHERE id = $1 AND is_active = TRUE)",
    )
    .bind(product_id)
    .fetch_one(&state.db)
    .await?;

    if !exists {
        return Err(ProductError::ProductNotFound);
    }

    let sales = sqlx::query_as::<_, SaleTimelineRow>(
        r#"
        SELECT
            o.booked_at,
            oi.quantity,
            pv.sku,
            o.id AS transaction_id,
            c.first_name,
            c.last_name
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        INNER JOIN product_variants pv ON pv.id = oi.variant_id
        LEFT JOIN customers c ON c.id = o.customer_id
        WHERE pv.product_id = $1
        ORDER BY o.booked_at DESC
        LIMIT 40
        "#,
    )
    .bind(product_id)
    .fetch_all(&state.db)
    .await?;

    let inv = sqlx::query_as::<_, InvTimelineRow>(
        r#"
        SELECT
            it.created_at,
            it.tx_type::text AS tx_type,
            it.quantity_delta,
            pv.sku,
            it.notes,
            it.reference_id,
            s.full_name AS actor_name
        FROM inventory_transactions it
        INNER JOIN product_variants pv ON pv.id = it.variant_id
        LEFT JOIN staff s ON s.id = it.created_by
        WHERE pv.product_id = $1
        ORDER BY it.created_at DESC
        LIMIT 25
        "#,
    )
    .bind(product_id)
    .fetch_all(&state.db)
    .await?;

    let catalog_audit = sqlx::query_as::<_, CatalogAuditTimelineRow>(
        r#"
        SELECT
            a.id,
            a.created_at,
            a.change_source,
            a.before_values,
            a.after_values,
            a.change_note,
            s.full_name AS changed_by_name
        FROM product_catalog_audit_log a
        LEFT JOIN staff s ON s.id = a.changed_by
        WHERE a.product_id = $1
        ORDER BY a.created_at DESC
        LIMIT 20
        "#,
    )
    .bind(product_id)
    .fetch_all(&state.db)
    .await?;

    let mut events: Vec<ProductTimelineEvent> = Vec::new();

    for s in sales {
        let who = match (&s.first_name, &s.last_name) {
            (Some(a), Some(b)) if !a.is_empty() || !b.is_empty() => {
                format!("{} {}", a.trim(), b.trim())
            }
            _ => "Walk-in / guest".to_string(),
        };
        events.push(ProductTimelineEvent {
            at: s.booked_at,
            kind: "sale".to_string(),
            summary: format!(
                "Sold {}× {} — {} (Order {})",
                s.quantity, s.sku, who, s.transaction_id
            ),
            reference_id: Some(s.transaction_id),
        });
    }

    for t in inv {
        let actor_suffix = t
            .actor_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| format!(" by {name}"))
            .unwrap_or_default();
        let notes_suffix = t
            .notes
            .as_deref()
            .map(str::trim)
            .filter(|notes| !notes.is_empty())
            .map(|notes| format!(" — {notes}"))
            .unwrap_or_default();
        events.push(ProductTimelineEvent {
            at: t.created_at,
            kind: format!("inventory_{}", t.tx_type),
            summary: format!(
                "{}{}: {:+} × {}{}",
                product_inventory_timeline_label(&t.tx_type),
                actor_suffix,
                t.quantity_delta,
                t.sku,
                notes_suffix
            ),
            reference_id: t.reference_id,
        });
    }

    for audit in catalog_audit {
        let actor = audit
            .changed_by_name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or("Staff");
        let summary = if let Some(note) = audit
            .change_note
            .as_deref()
            .map(str::trim)
            .filter(|note| !note.is_empty())
        {
            note.to_string()
        } else {
            build_catalog_change_summary(&audit.before_values, &audit.after_values)
        };
        events.push(ProductTimelineEvent {
            at: audit.created_at,
            kind: format!("catalog_{}", audit.change_source),
            summary: format!(
                "{} by {} — {}",
                product_catalog_timeline_label(&audit.change_source),
                actor,
                summary
            ),
            reference_id: Some(audit.id),
        });
    }

    events.sort_by(|a, b| b.at.cmp(&a.at));
    events.truncate(60);

    Ok(Json(ProductTimelineResponse { events }))
}

async fn patch_variant_pricing(
    State(state): State<AppState>,
    Path(variant_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<VariantPricingPatch>,
) -> Result<Json<Value>, ProductError> {
    require_catalog_perm(&state, &headers, CATALOG_EDIT).await?;
    let exists: i64 =
        sqlx::query_scalar("SELECT COUNT(*)::bigint FROM product_variants WHERE id = $1")
            .bind(variant_id)
            .fetch_one(&state.db)
            .await?;

    if exists == 0 {
        return Err(ProductError::VariantNotFound);
    }

    let mut did = false;

    if let Some(wp) = body.web_published {
        did = true;
        sqlx::query(
            r#"
            UPDATE product_variants
            SET web_published = $1
            WHERE id = $2
            "#,
        )
        .bind(wp)
        .bind(variant_id)
        .execute(&state.db)
        .await?;
    }

    if body.clear_web_price_override {
        did = true;
        sqlx::query(
            r#"
            UPDATE product_variants
            SET web_price_override = NULL
            WHERE id = $1
            "#,
        )
        .bind(variant_id)
        .execute(&state.db)
        .await?;
    } else if let Some(w) = body.web_price_override {
        did = true;
        if w < Decimal::ZERO {
            return Err(ProductError::InvalidPayload(
                "web_price_override must be non-negative".to_string(),
            ));
        }
        sqlx::query(
            r#"
            UPDATE product_variants
            SET web_price_override = $1
            WHERE id = $2
            "#,
        )
        .bind(w)
        .bind(variant_id)
        .execute(&state.db)
        .await?;
    }

    if let Some(go) = body.web_gallery_order {
        did = true;
        sqlx::query(
            r#"
            UPDATE product_variants
            SET web_gallery_order = $1
            WHERE id = $2
            "#,
        )
        .bind(go)
        .bind(variant_id)
        .execute(&state.db)
        .await?;
    }

    if body.clear_retail_override {
        did = true;
        sqlx::query(
            r#"
            UPDATE product_variants
            SET retail_price_override = NULL
            WHERE id = $1
            "#,
        )
        .bind(variant_id)
        .execute(&state.db)
        .await?;
    } else if let Some(p) = body.retail_price_override {
        did = true;
        if p < Decimal::ZERO {
            return Err(ProductError::InvalidPayload(
                "retail_price_override must be non-negative".to_string(),
            ));
        }
        sqlx::query(
            r#"
            UPDATE product_variants
            SET retail_price_override = $1
            WHERE id = $2
            "#,
        )
        .bind(p)
        .bind(variant_id)
        .execute(&state.db)
        .await?;
    }

    if body.clear_cost_override {
        did = true;
        sqlx::query(
            r#"
            UPDATE product_variants
            SET cost_override = NULL
            WHERE id = $1
            "#,
        )
        .bind(variant_id)
        .execute(&state.db)
        .await?;
    } else if let Some(c) = body.cost_override {
        did = true;
        if c < Decimal::ZERO {
            return Err(ProductError::InvalidPayload(
                "cost_override must be non-negative".to_string(),
            ));
        }
        sqlx::query(
            r#"
            UPDATE product_variants
            SET cost_override = $1
            WHERE id = $2
            "#,
        )
        .bind(c)
        .bind(variant_id)
        .execute(&state.db)
        .await?;
    }

    if let Some(t) = body.track_low_stock {
        did = true;
        sqlx::query(
            r#"
            UPDATE product_variants
            SET track_low_stock = $1
            WHERE id = $2
            "#,
        )
        .bind(t)
        .bind(variant_id)
        .execute(&state.db)
        .await?;
    }

    if !did {
        return Err(ProductError::InvalidPayload(
            "provide at least one field".to_string(),
        ));
    }

    spawn_meilisearch_variant_resync(&state, variant_id);
    Ok(Json(json!({ "status": "updated" })))
}

async fn adjust_variant_stock(
    State(state): State<AppState>,
    Path(variant_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<AdjustVariantStockRequest>,
) -> Result<Json<Value>, ProductError> {
    let staff = require_catalog_staff(&state, &headers, CATALOG_EDIT).await?;

    let mut tx = state.db.begin().await?;

    let row = sqlx::query(
        r#"
        UPDATE product_variants
        SET stock_on_hand = stock_on_hand + $1
        WHERE id = $2
        RETURNING stock_on_hand, cost_override, (SELECT base_cost FROM products p WHERE p.id = product_id) as base_cost
        "#,
    )
    .bind(body.quantity_delta)
    .bind(variant_id)
    .fetch_optional(&mut *tx)
    .await?;

    use sqlx::Row;
    let (new_stock, unit_cost) = match row {
        Some(r) => (
            r.get::<i32, _>("stock_on_hand"),
            r.get::<Option<Decimal>, _>("cost_override")
                .or(r.get::<Option<Decimal>, _>("base_cost"))
                .unwrap_or_default(),
        ),
        None => return Err(ProductError::VariantNotFound),
    };

    let tx_type_str = body.tx_type.unwrap_or_else(|| "adjustment".to_string());

    sqlx::query(
        r#"
        INSERT INTO inventory_transactions
            (variant_id, tx_type, quantity_delta, unit_cost, notes, created_by)
        VALUES ($1, $2::inventory_tx_type, $3, $4, $5, $6)
        "#,
    )
    .bind(variant_id)
    .bind(tx_type_str)
    .bind(body.quantity_delta)
    .bind(unit_cost)
    .bind(body.notes)
    .bind(staff.id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    spawn_meilisearch_variant_resync(&state, variant_id);
    Ok(Json(json!({ "stock_on_hand": new_stock })))
}

async fn list_variants(
    State(state): State<AppState>,
    Path(product_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<VariantRow>>, ProductError> {
    require_catalog_perm(&state, &headers, CATALOG_VIEW).await?;
    let rows = sqlx::query_as::<_, VariantRow>(
        r#"
        SELECT
            id, sku, variation_values, variation_label, stock_on_hand,
            COALESCE(web_published, false) AS web_published,
            web_price_override,
            web_gallery_order
        FROM product_variants
        WHERE product_id = $1
        ORDER BY created_at
        "#,
    )
    .bind(product_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}
async fn get_maintenance_ledger(
    State(state): State<AppState>,
    Query(query): Query<MaintenanceLedgerQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<MaintenanceLedgerRow>>, ProductError> {
    require_catalog_perm(&state, &headers, CATALOG_VIEW).await?;

    let tx_type_filter = query.tx_type.unwrap_or_else(|| "damaged".to_string());
    let limit = query.limit.unwrap_or(100).min(1000);
    let offset = query.offset.unwrap_or(0);

    let rows = sqlx::query_as::<_, MaintenanceLedgerRow>(
        r#"
        SELECT 
            it.id,
            it.created_at,
            it.tx_type::text AS tx_type,
            it.quantity_delta,
            it.unit_cost,
            it.notes,
            pv.id AS variant_id,
            pv.sku,
            p.name AS product_name,
            p.brand,
            c.name AS category_name,
            v.name AS vendor_name,
            s.full_name AS staff_name
        FROM inventory_transactions it
        INNER JOIN product_variants pv ON pv.id = it.variant_id
        INNER JOIN products p ON p.id = pv.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN vendors v ON v.id = p.primary_vendor_id
        LEFT JOIN staff s ON s.id = it.created_by
        WHERE it.tx_type::text = $1
          AND ($2::text IS NULL OR pv.sku ILIKE $3 OR p.name ILIKE $3)
        ORDER BY it.created_at DESC
        LIMIT $4 OFFSET $5
        "#,
    )
    .bind(tx_type_filter)
    .bind(query.search.as_ref())
    .bind(query.search.as_ref().map(|s| format!("%{s}%")))
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

async fn get_variant(
    State(state): State<AppState>,
    Path(variant_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<crate::services::ResolvedSkuItem>, ProductError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(|(_, axum::Json(v))| {
            let msg = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("unauthorized")
                .to_string();
            ProductError::Unauthorized(msg)
        })?;

    let resolved = crate::services::inventory::resolve_variant_by_id(
        &state.db,
        variant_id,
        state.global_employee_markup,
    )
    .await
    .map_err(|e| match e {
        crate::services::inventory::InventoryError::Database(db_err) => {
            ProductError::Database(db_err)
        }
        crate::services::inventory::InventoryError::SkuNotFound(_) => ProductError::VariantNotFound,
        _ => ProductError::Unauthorized(format!("{e}")),
    })?;

    Ok(Json(resolved))
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_skus_do_not_exist, patch_product_model, validate_create_product_payload,
        CreateProductRequest, CreateVariantInput, PatchProductModelRequest, ProductError,
    };
    use crate::api::{
        store_account_rate::StoreAccountRateState, AppState, PaymentIntentMinuteWindow,
    };
    use crate::auth::permissions::CATALOG_EDIT;
    use crate::auth::pins::hash_pin;
    use crate::logic::corecard::auth::CoreCardTokenCache;
    use crate::logic::corecard::CoreCardConfig;
    use crate::logic::podium::PodiumTokenCache;
    use crate::logic::wedding_push::WeddingEventBus;
    use crate::observability::ServerLogRing;
    use axum::extract::{Path, State};
    use axum::http::{HeaderMap, HeaderValue};
    use axum::Json;
    use rust_decimal::Decimal;
    use serde_json::json;
    use sqlx::PgPool;
    use std::sync::Arc;
    use std::time::Instant;
    use uuid::Uuid;

    fn sample_request() -> CreateProductRequest {
        CreateProductRequest {
            category_id: None,
            name: "Validation Product".to_string(),
            brand: Some("Riverside".to_string()),
            description: Some("Test".to_string()),
            base_retail_price: Decimal::new(10000, 2),
            base_cost: Decimal::new(4000, 2),
            variation_axes: vec!["Color".to_string(), "Size".to_string()],
            images: None,
            track_low_stock: false,
            publish_variants_to_web: false,
            tax_category_override: None,
            variants: vec![CreateVariantInput {
                sku: "SKU-1".to_string(),
                variation_values: json!({
                    "Color": "Navy",
                    "Size": "40R"
                }),
                variation_label: Some("Navy / 40R".to_string()),
                stock_on_hand: Some(0),
                retail_price_override: None,
                cost_override: None,
                track_low_stock: false,
            }],
        }
    }

    async fn connect_test_db() -> PgPool {
        let database_url = std::env::var("TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .expect("TEST_DATABASE_URL or DATABASE_URL must be set for tests");
        PgPool::connect(&database_url)
            .await
            .expect("connect test database")
    }

    async fn next_staff_code(pool: &PgPool) -> String {
        for _ in 0..128 {
            let candidate = format!("{:04}", (Uuid::new_v4().as_u128() % 10_000) as u16);
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE cashier_code = $1)")
                    .bind(&candidate)
                    .fetch_one(pool)
                    .await
                    .expect("check cashier_code uniqueness");
            if !exists {
                return candidate;
            }
        }
        panic!("could not allocate unique 4-digit cashier code for test staff");
    }

    async fn insert_staff_with_permissions(
        pool: &PgPool,
        role: &str,
        permissions: &[&str],
    ) -> (Uuid, String) {
        let id = Uuid::new_v4();
        let code = next_staff_code(pool).await;
        let pin_hash = hash_pin(&code).expect("hash test pin");
        sqlx::query(
            r#"
            INSERT INTO staff (id, full_name, cashier_code, pin_hash, role, is_active, avatar_key)
            VALUES ($1, $2, $3, $4, $5::staff_role, TRUE, 'ros_default')
            "#,
        )
        .bind(id)
        .bind(format!("ROSIE Product Test {}", id.simple()))
        .bind(&code)
        .bind(pin_hash)
        .bind(role)
        .execute(pool)
        .await
        .expect("insert staff");

        for permission in permissions {
            sqlx::query(
                r#"
                INSERT INTO staff_permission (staff_id, permission_key, allowed)
                VALUES ($1, $2, TRUE)
                ON CONFLICT (staff_id, permission_key)
                DO UPDATE SET allowed = EXCLUDED.allowed
                "#,
            )
            .bind(id)
            .bind(permission)
            .execute(pool)
            .await
            .expect("insert permission");
        }

        (id, code)
    }

    fn auth_headers(code: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-riverside-staff-code",
            HeaderValue::from_str(code).expect("staff code header"),
        );
        headers.insert(
            "x-riverside-staff-pin",
            HeaderValue::from_str(code).expect("staff pin header"),
        );
        headers
    }

    fn build_test_state(pool: PgPool) -> AppState {
        AppState {
            db: pool,
            global_employee_markup: Decimal::new(15, 0),
            stripe_client: stripe::Client::new("sk_test_products"),
            http_client: reqwest::Client::new(),
            podium_token_cache: Arc::new(tokio::sync::Mutex::new(PodiumTokenCache::default())),
            database_url: "postgres://test".to_string(),
            counterpoint_sync_token: None,
            wedding_events: WeddingEventBus::new(),
            payment_intent_minute: Arc::new(tokio::sync::Mutex::new(PaymentIntentMinuteWindow {
                window_start: Instant::now(),
                count: 0,
            })),
            payment_intent_max_per_minute: 0,
            store_customer_jwt_secret: Arc::<[u8]>::from(b"product-test".as_slice()),
            store_account_rate: Arc::new(tokio::sync::Mutex::new(StoreAccountRateState::default())),
            store_account_unauth_post_per_minute_ip: 0,
            store_account_authed_per_minute: 0,
            meilisearch: None,
            corecard_config: CoreCardConfig::from_env(),
            corecard_token_cache: Arc::new(tokio::sync::Mutex::new(CoreCardTokenCache::default())),
            rosie_speech_state: Arc::new(tokio::sync::Mutex::new(None)),
            server_log_ring: ServerLogRing::new(32, 512),
        }
    }

    async fn insert_patchable_product(pool: &PgPool) -> Uuid {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS product_catalog_audit_log (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                changed_by UUID REFERENCES staff(id),
                change_source TEXT NOT NULL DEFAULT 'manual',
                before_values JSONB NOT NULL DEFAULT '{}'::jsonb,
                after_values JSONB NOT NULL DEFAULT '{}'::jsonb,
                change_note TEXT,
                suggestion_confidence DOUBLE PRECISION,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            "#,
        )
        .execute(pool)
        .await
        .expect("ensure product catalog audit table");
        let vendor_id = Uuid::new_v4();
        let product_id = Uuid::new_v4();
        let legacy_code = format!("LEG-{}", &product_id.simple().to_string()[..6]);
        sqlx::query("INSERT INTO vendors (id, name, vendor_code) VALUES ($1, $2, 'PRLS')")
            .bind(vendor_id)
            .bind(format!(
                "Patch Vendor {}",
                &vendor_id.simple().to_string()[..8]
            ))
            .execute(pool)
            .await
            .expect("insert vendor");
        sqlx::query(
            r#"
            INSERT INTO products (
                id, name, brand, catalog_handle, primary_vendor_id, base_retail_price, base_cost, is_active
            )
            VALUES ($1, 'Legacy Title', NULL, $3, $2, 100.00, 50.00, TRUE)
            "#,
        )
        .bind(product_id)
        .bind(vendor_id)
        .bind(legacy_code)
        .execute(pool)
        .await
        .expect("insert product");
        product_id
    }

    #[test]
    fn validate_create_product_payload_rejects_negative_values_and_duplicate_skus() {
        let mut payload = sample_request();
        payload.base_cost = Decimal::new(-1, 0);
        assert!(matches!(
            validate_create_product_payload(&payload),
            Err(ProductError::InvalidPayload(message))
            if message == "base_cost must be non-negative"
        ));

        let mut payload = sample_request();
        payload.base_retail_price = Decimal::new(-1, 0);
        assert!(matches!(
            validate_create_product_payload(&payload),
            Err(ProductError::InvalidPayload(message))
            if message == "base_retail_price must be non-negative"
        ));

        let mut payload = sample_request();
        payload.variants = vec![
            payload.variants[0].clone(),
            CreateVariantInput {
                sku: " sku-1 ".to_string(),
                variation_values: json!({
                    "Color": "Black",
                    "Size": "42R"
                }),
                variation_label: Some("Black / 42R".to_string()),
                stock_on_hand: Some(0),
                retail_price_override: None,
                cost_override: None,
                track_low_stock: false,
            },
        ];
        assert!(matches!(
            validate_create_product_payload(&payload),
            Err(ProductError::InvalidPayload(message))
            if message == "duplicate sku in request: sku-1"
        ));
    }

    #[test]
    fn validate_create_product_payload_requires_axes_to_match_variant_values() {
        let mut payload = sample_request();
        payload.variants[0].variation_values = json!({
            "Color": "Navy"
        });
        assert!(matches!(
            validate_create_product_payload(&payload),
            Err(ProductError::InvalidPayload(message))
            if message == "variant SKU-1 variation_values must match variation_axes exactly"
        ));

        let mut payload = sample_request();
        payload.variants[0].variation_values = json!(["Navy", "40R"]);
        assert!(matches!(
            validate_create_product_payload(&payload),
            Err(ProductError::InvalidPayload(message))
            if message == "variant SKU-1 variation_values must be an object"
        ));

        let mut payload = sample_request();
        payload.variants[0].stock_on_hand = Some(-1);
        assert!(matches!(
            validate_create_product_payload(&payload),
            Err(ProductError::InvalidPayload(message))
            if message == "variant SKU-1 stock_on_hand must be non-negative"
        ));
    }

    #[tokio::test]
    async fn ensure_skus_do_not_exist_rejects_existing_sku() {
        let pool = connect_test_db().await;

        let product_id = Uuid::new_v4();
        let sku = format!("PRODUCT-VALIDATION-{}", Uuid::new_v4().simple());

        sqlx::query(
            r#"
            INSERT INTO products (id, name, base_retail_price, base_cost, is_active)
            VALUES ($1, $2, $3, $4, true)
            "#,
        )
        .bind(product_id)
        .bind("Existing Product Validation")
        .bind(Decimal::new(10000, 2))
        .bind(Decimal::new(4000, 2))
        .execute(&pool)
        .await
        .expect("insert product");

        sqlx::query(
            r#"
            INSERT INTO product_variants (product_id, sku, variation_values, stock_on_hand)
            VALUES ($1, $2, '{}'::jsonb, 0)
            "#,
        )
        .bind(product_id)
        .bind(&sku)
        .execute(&pool)
        .await
        .expect("insert variant");

        assert!(matches!(
            ensure_skus_do_not_exist(&pool, &[sku.to_lowercase()]).await,
            Err(ProductError::InvalidPayload(message))
            if message == format!("sku already exists: {}", sku)
        ));
    }

    #[tokio::test]
    async fn patch_product_model_records_rosie_catalog_audit() {
        let pool = connect_test_db().await;
        let product_id = insert_patchable_product(&pool).await;
        let suggested_code = format!("MK-{}", &product_id.simple().to_string()[..6]);
        let (_staff_id, code) =
            insert_staff_with_permissions(&pool, "salesperson", &[CATALOG_EDIT]).await;
        let state = build_test_state(pool.clone());

        let Json(response) = patch_product_model(
            State(state),
            Path(product_id),
            auth_headers(&code),
            Json(PatchProductModelRequest {
                name: Some(format!("Michael Kors Suit {suggested_code}")),
                base_retail_price: None,
                base_cost: None,
                category_id: None,
                clear_category_id: false,
                brand: Some("Michael Kors".to_string()),
                catalog_handle: Some(suggested_code.clone()),
                clear_catalog_handle: false,
                is_bundle: None,
                track_low_stock: None,
                tax_category_override: None,
                clear_tax_category_override: false,
                employee_markup_percent: None,
                clear_employee_markup_percent: false,
                employee_extra_amount: None,
                primary_vendor_id: None,
                clear_primary_vendor_id: false,
                audit_source: Some("rosie".to_string()),
                audit_note: Some("Applied ROSIE suggestion".to_string()),
                audit_confidence: Some(0.88),
            }),
        )
        .await
        .expect("patch product model should succeed");

        assert_eq!(response["status"], "updated");

        let row: (String, Option<String>, Option<String>) =
            sqlx::query_as("SELECT name, brand, catalog_handle FROM products WHERE id = $1")
                .bind(product_id)
                .fetch_one(&pool)
                .await
                .expect("load patched product");
        assert_eq!(row.0, format!("Michael Kors Suit {suggested_code}"));
        assert_eq!(row.1.as_deref(), Some("Michael Kors"));
        assert_eq!(row.2.as_deref(), Some(suggested_code.as_str()));

        let audit: (String, serde_json::Value, serde_json::Value) = sqlx::query_as(
            r#"
            SELECT change_source, before_values, after_values
            FROM product_catalog_audit_log
            WHERE product_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )
        .bind(product_id)
        .fetch_one(&pool)
        .await
        .expect("load catalog audit row");
        assert_eq!(audit.0, "rosie");
        assert_eq!(audit.1["name"], "Legacy Title");
        assert_eq!(
            audit.2["name"],
            format!("Michael Kors Suit {suggested_code}")
        );
        assert_eq!(audit.2["catalog_handle"], suggested_code);
    }
}
