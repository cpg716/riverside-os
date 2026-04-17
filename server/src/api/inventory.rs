//! Inventory HTTP routes — SKU scan, batch-scan, scan-resolve, and control board.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use super::products;
use super::AppState;
use crate::auth::permissions::{
    staff_has_permission, CATALOG_EDIT, CATALOG_VIEW, INVENTORY_VIEW_COST,
};
use crate::logic::physical_inventory::{resolve_scan_code, ScanResolveResult};
use crate::middleware::{self, StaffOrPosSession};
use crate::services::{resolve_sku, InventoryError, ResolvedSkuItem};

// ── InventoryError → HTTP ─────────────────────────────────────────────────────

impl IntoResponse for InventoryError {
    fn into_response(self) -> Response {
        let (status, error_message) = match &self {
            InventoryError::SkuNotFound(sku) => (
                StatusCode::NOT_FOUND,
                format!("Product '{sku}' not found or is inactive"),
            ),
            InventoryError::AmbiguousProduct(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            InventoryError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg.clone()),
            InventoryError::Database(e) => {
                tracing::error!(error = %e, "Database error in inventory");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };

        let body = Json(json!({ "error": error_message }));
        (status, body).into_response()
    }
}

// ── Router ────────────────────────────────────────────────────────────────────

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/scan/{*sku}", get(scan_sku))
        .route("/scan-resolve", get(scan_resolve))
        .route("/control-board", get(products::list_control_board))
        .route("/batch-scan", post(batch_scan))
        .route("/recommendations", get(get_recommendations))
        .route("/snapshot/{variant_id}", get(get_product_snapshot))
        .route("/wedding-products", get(list_wedding_products))
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

/// A single scan event sent from the frontend (laser or camera).
#[derive(Debug, Deserialize)]
pub struct ScanItem {
    /// The scanned code (UPC, barcode, or SKU).
    pub code: String,
    /// Optional vendor context for vendor_upc priority lookup.
    pub vendor_id: Option<Uuid>,
    /// Quantity to add to stock_on_hand. Default 1.
    pub quantity: Option<i32>,
    /// Source device type for audit logging.
    pub source: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ScanItemResult {
    pub code: String,
    pub status: String, // "matched" | "not_found"
    pub variant_id: Option<Uuid>,
    pub sku: Option<String>,
    pub new_stock: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct BatchScanResponse {
    pub processed: usize,
    pub matched: usize,
    pub not_found: usize,
    pub results: Vec<ScanItemResult>,
}

#[derive(Debug, Serialize)]
pub struct ProductSnapshot {
    pub variant_id: Uuid,
    pub product_id: Uuid,
    pub sku: String,
    pub name: String,
    pub variation_label: Option<String>,
    pub stock_on_hand: i32,
    pub reserved_stock: i32,
    pub available_stock: i32,
    pub qty_on_order: i32,
    pub unit_cost: Option<Decimal>,
    pub retail_price: Decimal,
    pub last_sale_date: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct ScanResolveQuery {
    pub code: String,
    pub vendor_id: Option<Uuid>,
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/// Legacy single-SKU lookup for POS cart (preserved for backward compat).
async fn scan_sku(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(sku): Path<String>,
) -> Result<Json<ResolvedSkuItem>, InventoryError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(|(_, axum::Json(v))| {
            let msg = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("unauthorized")
                .to_string();
            InventoryError::Unauthorized(msg)
        })?;
    let resolved_item = resolve_sku(&state.db, &sku, state.global_employee_markup).await?;

    Ok(Json(resolved_item))
}

/// Resolve a scanned code (GET) — for receiving and physical inventory lookups.
/// Checks vendor_upc → barcode → sku based on vendor's use_vendor_upc flag.
async fn scan_resolve(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ScanResolveQuery>,
) -> impl IntoResponse {
    if let Err((st, body)) =
        middleware::require_staff_perm_or_pos_session(&state, &headers, CATALOG_VIEW).await
    {
        return (st, body).into_response();
    }
    match resolve_scan_code(&state.db, &q.code, q.vendor_id).await {
        Ok(Some(result)) => (StatusCode::OK, Json(json!(result))).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "No product matched the scanned code", "code": q.code })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, code = %q.code, "scan-resolve error");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Internal error during scan resolve" })),
            )
                .into_response()
        }
    }
}

/// High-performance batch scan — atomically updates stock_on_hand for multiple scans.
/// Used by ReceivingBay (localforage flush) and InventoryControlBoard.
async fn batch_scan(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(items): Json<Vec<ScanItem>>,
) -> impl IntoResponse {
    if let Err((st, body)) =
        middleware::require_staff_perm_or_pos_session(&state, &headers, CATALOG_EDIT).await
    {
        return (st, body).into_response();
    }
    if items.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "At least one scan item is required" })),
        )
            .into_response();
    }
    if items.len() > 200 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Batch size exceeds maximum of 200 items" })),
        )
            .into_response();
    }

    let mut results: Vec<ScanItemResult> = Vec::with_capacity(items.len());
    let mut matched = 0usize;

    // Process in a single transaction for atomicity
    let mut tx = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "Failed to begin batch-scan transaction");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Database error" })),
            )
                .into_response();
        }
    };

    for item in &items {
        let qty = item.quantity.unwrap_or(1).max(0);
        let source = item.source.as_deref().unwrap_or("laser");

        // Resolve the code (vendor_upc → barcode → sku) — query run on pool directly for read
        let resolved = match resolve_scan_code(&state.db, &item.code, item.vendor_id).await {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(error = %e, code = %item.code, "Scan resolve error in batch");
                results.push(ScanItemResult {
                    code: item.code.clone(),
                    status: "error".to_string(),
                    variant_id: None,
                    sku: None,
                    new_stock: None,
                });
                continue;
            }
        };

        match resolved {
            None => {
                results.push(ScanItemResult {
                    code: item.code.clone(),
                    status: "not_found".to_string(),
                    variant_id: None,
                    sku: None,
                    new_stock: None,
                });
            }
            Some(ScanResolveResult {
                variant_id, sku, ..
            }) => {
                // Update stock_on_hand
                let new_stock: Option<i32> = sqlx::query_scalar(
                    r#"
                    UPDATE product_variants
                    SET stock_on_hand = stock_on_hand + $1
                    WHERE id = $2
                    RETURNING stock_on_hand
                    "#,
                )
                .bind(qty)
                .bind(variant_id)
                .fetch_optional(&mut *tx)
                .await
                .unwrap_or(None);

                // Log to inventory_transactions
                let _ = sqlx::query(
                    r#"
                    INSERT INTO inventory_transactions
                        (variant_id, tx_type, quantity_delta, reference_table, notes)
                    VALUES ($1, 'scan_receive', $2, 'batch_scan', $3)
                    "#,
                )
                .bind(variant_id)
                .bind(qty)
                .bind(format!("Batch scan via {source}"))
                .execute(&mut *tx)
                .await;

                matched += 1;
                results.push(ScanItemResult {
                    code: item.code.clone(),
                    status: "matched".to_string(),
                    variant_id: Some(variant_id),
                    sku: Some(sku),
                    new_stock,
                });
            }
        }
    }

    if let Err(e) = tx.commit().await {
        tracing::error!(error = %e, "Failed to commit batch-scan transaction");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Database commit failed" })),
        )
            .into_response();
    }

    let not_found = results.len() - matched;
    (
        StatusCode::OK,
        Json(json!(BatchScanResponse {
            processed: results.len(),
            matched,
            not_found,
            results,
        })),
    )
        .into_response()
}

/// Detailed product data for POS "Snapshot" drawer.
/// Aggregates inventory levels, open PO quantities, and sale history.
async fn get_product_snapshot(
    State(state): State<AppState>,
    Path(variant_id): Path<Uuid>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let auth = match middleware::require_staff_or_pos_register_session(&state, &headers).await {
        Ok(a) => a,
        Err((status, body)) => return (status, body).into_response(),
    };

    let show_cost = match &auth {
        StaffOrPosSession::Staff(s) => {
            match crate::auth::permissions::effective_permissions_for_staff(&state.db, s.id, s.role)
                .await
            {
                Ok(eff) => staff_has_permission(&eff, INVENTORY_VIEW_COST),
                Err(_) => false,
            }
        }
        StaffOrPosSession::PosSession { .. } => false,
    };

    type VariantStockBasicRow = (
        String,
        String,
        Option<String>,
        i32,
        i32,
        Decimal,
        Decimal,
        Uuid,
    );
    // Fetch basic info + current stock
    let basic: Option<VariantStockBasicRow> = sqlx::query_as(
        r#"
        SELECT 
            p.name, 
            v.sku, 
            v.variation_label, 
            v.stock_on_hand, 
            v.reserved_stock,
            COALESCE(v.retail_price_override, p.base_retail_price) as retail_price,
            COALESCE(v.cost_override, p.base_cost) as unit_cost,
            p.id as product_id
        FROM product_variants v
        JOIN products p ON v.product_id = p.id
        WHERE v.id = $1
        "#,
    )
    .bind(variant_id)
    .fetch_optional(&state.db)
    .await
    .unwrap_or(None);

    let Some((name, sku, label, soh, res, retail, cost, product_id)) = basic else {
        return StatusCode::NOT_FOUND.into_response();
    };

    // 3. Fetch Qty On Order (Sum of open PO lines)
    let qty_on_order: i32 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(pol.quantity_ordered - pol.quantity_received), 0)::int4
        FROM purchase_order_lines pol
        JOIN purchase_orders po ON pol.purchase_order_id = po.id
        WHERE pol.variant_id = $1 AND po.status IN ('submitted', 'partially_received')
        "#,
    )
    .bind(variant_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    // 4. Fetch Last Sale Date
    let last_sale_date: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        r#"
        SELECT o.booked_at
        FROM transaction_lines oi
        JOIN transactions o ON oi.transaction_id = o.id
        WHERE oi.variant_id = $1
        ORDER BY o.booked_at DESC
        LIMIT 1
        "#,
    )
    .bind(variant_id)
    .fetch_optional(&state.db)
    .await
    .unwrap_or(None);

    Json(ProductSnapshot {
        variant_id,
        product_id,
        sku,
        name,
        variation_label: label,
        stock_on_hand: soh,
        reserved_stock: res,
        available_stock: (soh - res).max(0),
        qty_on_order,
        unit_cost: if show_cost { Some(cost) } else { None },
        retail_price: retail,
        last_sale_date,
    })
    .into_response()
}

async fn get_recommendations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err((st, body)) =
        middleware::require_staff_perm_or_pos_session(&state, &headers, CATALOG_VIEW).await
    {
        return (st, body).into_response();
    }
    match crate::logic::inventory_brain::query_inventory_recommendations(&state.db).await {
        Ok(recs) => (StatusCode::OK, Json(recs)).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "Inventory recommendations query failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Failed to fetch inventory recommendations" })),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct WeddingProductsQuery {
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct WeddingProductRow {
    pub variant_id: Uuid,
    pub product_id: Uuid,
    pub sku: String,
    pub name: String,
    pub variation_label: Option<String>,
    pub retail_price: Decimal,
    pub stock_on_hand: i32,
}

async fn list_wedding_products(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<WeddingProductsQuery>,
) -> impl IntoResponse {
    if let Err((st, body)) =
        middleware::require_staff_perm_or_pos_session(&state, &headers, CATALOG_VIEW).await
    {
        return (st, body).into_response();
    }

    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let offset = q.offset.unwrap_or(0).max(0);
    let search = q.q.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty());

    let rows: Vec<WeddingProductRow> = if let Some(search_term) = search {
        let pattern = format!(
            "%{}%",
            search_term.replace('\\', "\\\\").replace('%', "\\%")
        );
        sqlx::query_as(
            r#"
            SELECT 
                v.id as variant_id,
                p.id as product_id,
                v.sku,
                p.name,
                v.variation_label,
                COALESCE(v.retail_price_override, p.base_retail_price) as retail_price,
                v.stock_on_hand
            FROM product_variants v
            JOIN products p ON v.product_id = p.id
            WHERE p.is_active = TRUE
              AND v.is_active = TRUE
              AND (p.name ILIKE $1 ESCAPE '\' OR v.sku ILIKE $1 ESCAPE '\' OR v.variation_label ILIKE $1 ESCAPE '\')
            ORDER BY p.name ASC, v.sku ASC
            LIMIT $2 OFFSET $3
            "#,
        )
        .bind(&pattern)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default()
    } else {
        sqlx::query_as(
            r#"
            SELECT 
                v.id as variant_id,
                p.id as product_id,
                v.sku,
                p.name,
                v.variation_label,
                COALESCE(v.retail_price_override, p.base_retail_price) as retail_price,
                v.stock_on_hand
            FROM product_variants v
            JOIN products p ON v.product_id = p.id
            WHERE p.is_active = TRUE
              AND v.is_active = TRUE
            ORDER BY p.name ASC, v.sku ASC
            LIMIT $1 OFFSET $2
            "#,
        )
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default()
    };

    (StatusCode::OK, Json(rows)).into_response()
}
