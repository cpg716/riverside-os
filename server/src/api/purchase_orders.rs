use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rust_decimal::Decimal;
use rust_decimal::RoundingStrategy;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{PROCUREMENT_MUTATE, PROCUREMENT_VIEW};
use crate::logic::procurement;
use crate::logic::template_variant_pricing::effective_cost_usd;
use crate::middleware;

#[derive(Debug, Error)]
pub enum PurchaseOrderError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("Purchase order not found")]
    NotFound,
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
}

fn map_po_perm(e: (StatusCode, axum::Json<serde_json::Value>)) -> PurchaseOrderError {
    let (st, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match st {
        StatusCode::UNAUTHORIZED => PurchaseOrderError::Unauthorized(msg),
        StatusCode::FORBIDDEN => PurchaseOrderError::Forbidden(msg),
        _ => PurchaseOrderError::InvalidPayload(msg),
    }
}

async fn require_po(
    state: &AppState,
    headers: &HeaderMap,
    key: &'static str,
) -> Result<(), PurchaseOrderError> {
    middleware::require_staff_with_permission(state, headers, key)
        .await
        .map(|_| ())
        .map_err(map_po_perm)
}

impl IntoResponse for PurchaseOrderError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            PurchaseOrderError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            PurchaseOrderError::NotFound => (
                StatusCode::NOT_FOUND,
                "Purchase order not found".to_string(),
            ),
            PurchaseOrderError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            PurchaseOrderError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            PurchaseOrderError::Database(e) => {
                tracing::error!(error = %e, "Database error in purchase_orders");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateDraftPoRequest {
    pub vendor_id: Uuid,
    pub expected_at: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct PurchaseOrderSummary {
    pub id: Uuid,
    pub po_number: String,
    pub status: String,
    pub vendor_name: String,
    pub po_kind: String,
}

#[derive(Debug, Deserialize)]
pub struct AddPoLineRequest {
    pub variant_id: Uuid,
    pub quantity_ordered: i32,
    pub unit_cost: Decimal,
}

#[derive(Debug, Deserialize)]
pub struct ReceivePoRequest {
    pub invoice_number: Option<String>,
    pub freight_total: Decimal,
    pub lines: Vec<ReceiveLine>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ReceiveLine {
    pub po_line_id: Uuid,
    pub quantity_received_now: i32,
}

#[derive(Debug, Serialize)]
pub struct PurchaseOrderDetailResponse {
    pub id: Uuid,
    pub po_number: String,
    pub status: String,
    pub vendor_name: String,
    pub po_kind: String,
    pub lines: Vec<PurchaseOrderLineDetail>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct PurchaseOrderLineDetail {
    pub line_id: Uuid,
    pub variant_id: Uuid,
    pub sku: String,
    pub product_name: String,
    pub variation_label: Option<String>,
    #[sqlx(json)]
    pub variation_values: serde_json::Value,
    pub qty_ordered: i32,
    pub qty_previously_received: i32,
    pub unit_cost: Decimal,
    /// Pre-receipt effective cost (for UI cost-alert glow).
    pub prior_effective_cost: Decimal,
}

#[derive(Debug, Deserialize)]
pub struct CreateDirectInvoiceRequest {
    pub vendor_id: Uuid,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_purchase_orders).post(create_draft_po))
        .route("/direct-invoice", post(create_direct_invoice_draft))
        .route("/{po_id}", get(get_po_details))
        .route("/{po_id}/lines", post(add_po_line))
        .route("/{po_id}/submit", post(submit_po))
        .route("/{po_id}/receive", post(receive_po))
}

async fn list_purchase_orders(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<PurchaseOrderSummary>>, PurchaseOrderError> {
    require_po(&state, &headers, PROCUREMENT_VIEW).await?;
    let rows = sqlx::query_as::<_, PurchaseOrderSummary>(
        r#"
        SELECT po.id, po.po_number, po.status::text AS status, v.name AS vendor_name,
               po.po_kind
        FROM purchase_orders po
        JOIN vendors v ON v.id = po.vendor_id
        ORDER BY po.ordered_at DESC
        LIMIT 200
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

async fn create_draft_po(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateDraftPoRequest>,
) -> Result<Json<PurchaseOrderSummary>, PurchaseOrderError> {
    require_po(&state, &headers, PROCUREMENT_MUTATE).await?;
    let po = sqlx::query_as::<_, PurchaseOrderSummary>(
        r#"
        INSERT INTO purchase_orders (po_number, vendor_id, expected_at, notes, po_kind)
        VALUES (
            CONCAT('PO-', TO_CHAR(NOW(), 'YYYYMMDD-HH24MISS')),
            $1,
            $2::timestamptz,
            $3,
            'standard'
        )
        RETURNING
            id,
            po_number,
            status::text AS status,
            (SELECT name FROM vendors WHERE id = vendor_id) AS vendor_name,
            po_kind
        "#,
    )
    .bind(payload.vendor_id)
    .bind(payload.expected_at)
    .bind(payload.notes)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(po))
}

async fn create_direct_invoice_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateDirectInvoiceRequest>,
) -> Result<Json<PurchaseOrderSummary>, PurchaseOrderError> {
    require_po(&state, &headers, PROCUREMENT_MUTATE).await?;
    let po = sqlx::query_as::<_, PurchaseOrderSummary>(
        r#"
        INSERT INTO purchase_orders (po_number, vendor_id, notes, po_kind)
        VALUES (
            CONCAT('DIR-', TO_CHAR(NOW(), 'YYYYMMDD-HH24MISS')),
            $1,
            'Direct vendor invoice / fill-in receipt',
            'direct_invoice'
        )
        RETURNING
            id,
            po_number,
            status::text AS status,
            (SELECT name FROM vendors WHERE id = vendor_id) AS vendor_name,
            po_kind
        "#,
    )
    .bind(payload.vendor_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(po))
}

async fn add_po_line(
    State(state): State<AppState>,
    Path(po_id): Path<Uuid>,
    headers: HeaderMap,
    Json(payload): Json<AddPoLineRequest>,
) -> Result<Json<serde_json::Value>, PurchaseOrderError> {
    require_po(&state, &headers, PROCUREMENT_MUTATE).await?;
    if payload.quantity_ordered <= 0 {
        return Err(PurchaseOrderError::InvalidPayload(
            "quantity_ordered must be > 0".to_string(),
        ));
    }
    sqlx::query(
        r#"
        INSERT INTO purchase_order_lines (purchase_order_id, variant_id, quantity_ordered, unit_cost)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(po_id)
    .bind(payload.variant_id)
    .bind(payload.quantity_ordered)
    .bind(payload.unit_cost)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "status": "line_added" })))
}

async fn submit_po(
    State(state): State<AppState>,
    Path(po_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, PurchaseOrderError> {
    require_po(&state, &headers, PROCUREMENT_MUTATE).await?;
    let result = sqlx::query(
        r#"
        UPDATE purchase_orders
        SET
            status = 'submitted',
            submitted_at = COALESCE(submitted_at, NOW())
        WHERE id = $1
          AND status = 'draft'
        "#,
    )
    .bind(po_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(PurchaseOrderError::NotFound);
    }

    // --- Wedding Manager Integration: Mark members as 'ordered' ---
    // Find all variants on this PO
    let variants: Vec<Uuid> = sqlx::query_scalar(
        "SELECT variant_id FROM purchase_order_lines WHERE purchase_order_id = $1",
    )
    .bind(po_id)
    .fetch_all(&state.db)
    .await?;

    if !variants.is_empty() {
        // Update wedding members matching these variants
        sqlx::query(
            r#"
            UPDATE wedding_members
            SET status = 'ordered',
                suit_ordered = true
            WHERE suit_variant_id = ANY($1)
              AND status IN ('measured', 'pending')
            "#,
        )
        .bind(&variants)
        .execute(&state.db)
        .await?;
    }

    Ok(Json(json!({ "status": "submitted" })))
}

#[derive(Debug, FromRow)]
struct PoHeaderRow {
    id: Uuid,
    po_number: String,
    status: String,
    vendor_name: String,
    po_kind: String,
}

async fn get_po_details(
    State(state): State<AppState>,
    Path(po_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<PurchaseOrderDetailResponse>, PurchaseOrderError> {
    require_po(&state, &headers, PROCUREMENT_VIEW).await?;
    let header = sqlx::query_as::<_, PoHeaderRow>(
        r#"
        SELECT po.id, po.po_number, po.status::text AS status, v.name AS vendor_name, po.po_kind
        FROM purchase_orders po
        JOIN vendors v ON v.id = po.vendor_id
        WHERE po.id = $1
        "#,
    )
    .bind(po_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(PurchaseOrderError::NotFound)?;

    let line_rows = sqlx::query_as::<_, PurchaseOrderLineDetail>(
        r#"
        SELECT
            pol.id AS line_id,
            pv.id AS variant_id,
            pv.sku,
            p.name AS product_name,
            pv.variation_label,
            pv.variation_values,
            pol.quantity_ordered AS qty_ordered,
            pol.quantity_received AS qty_previously_received,
            pol.unit_cost,
            COALESCE(pv.cost_override, p.base_cost) AS prior_effective_cost
        FROM purchase_order_lines pol
        JOIN product_variants pv ON pv.id = pol.variant_id
        JOIN products p ON p.id = pv.product_id
        WHERE pol.purchase_order_id = $1
        ORDER BY pol.created_at, pol.id
        "#,
    )
    .bind(po_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(PurchaseOrderDetailResponse {
        id: header.id,
        po_number: header.po_number,
        status: header.status,
        vendor_name: header.vendor_name,
        po_kind: header.po_kind,
        lines: line_rows,
    }))
}

#[derive(Debug, FromRow)]
struct ReceiveAllocationRow {
    po_line_id: Uuid,
    variant_id: Uuid,
    unit_cost: Decimal,
    quantity_received_now: i32,
}

async fn receive_po(
    State(state): State<AppState>,
    Path(po_id): Path<Uuid>,
    headers: HeaderMap,
    Json(payload): Json<ReceivePoRequest>,
) -> Result<Json<serde_json::Value>, PurchaseOrderError> {
    require_po(&state, &headers, PROCUREMENT_MUTATE).await?;
    let lines: Vec<ReceiveLine> = payload
        .lines
        .into_iter()
        .filter(|l| l.quantity_received_now > 0)
        .collect();
    if lines.is_empty() {
        return Err(PurchaseOrderError::InvalidPayload(
            "at least one line with quantity_received_now > 0 is required".to_string(),
        ));
    }
    {
        use std::collections::HashSet;
        let mut seen = HashSet::new();
        for line in &lines {
            if !seen.insert(line.po_line_id) {
                return Err(PurchaseOrderError::InvalidPayload(
                    "duplicate po_line_id in receive payload".to_string(),
                ));
            }
        }
    }
    if payload.freight_total < Decimal::ZERO {
        return Err(PurchaseOrderError::InvalidPayload(
            "freight_total cannot be negative".to_string(),
        ));
    }

    let mut tx = state.db.begin().await?;

    #[derive(Debug, FromRow)]
    struct PoLockRow {
        status: String,
        po_kind: String,
    }

    let po_lock: PoLockRow = sqlx::query_as(
        r#"
        SELECT status::text AS status, po_kind
        FROM purchase_orders
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(po_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(PurchaseOrderError::NotFound)?;

    if po_lock.status == "cancelled" {
        return Err(PurchaseOrderError::InvalidPayload(
            "purchase order is cancelled".to_string(),
        ));
    }
    if po_lock.status == "closed" {
        return Err(PurchaseOrderError::InvalidPayload(
            "purchase order is already fully received".to_string(),
        ));
    }
    if po_lock.status == "draft" && po_lock.po_kind != "direct_invoice" {
        return Err(PurchaseOrderError::InvalidPayload(
            "purchase order must be submitted before receiving (or use a direct invoice draft)"
                .to_string(),
        ));
    }

    if po_lock.status == "draft" && po_lock.po_kind == "direct_invoice" {
        sqlx::query(
            r#"
            UPDATE purchase_orders
            SET
                status = 'submitted',
                submitted_at = COALESCE(submitted_at, NOW())
            WHERE id = $1
            "#,
        )
        .bind(po_id)
        .execute(&mut *tx)
        .await?;
    }

    let invoice_number = payload.invoice_number.clone();
    let receive_event_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO receiving_events (purchase_order_id, invoice_number, freight_total)
        VALUES ($1, $2, $3)
        RETURNING id
        "#,
    )
    .bind(po_id)
    .bind(invoice_number.clone())
    .bind(payload.freight_total)
    .fetch_one(&mut *tx)
    .await?;

    let total_received_now: i32 = lines.iter().map(|l| l.quantity_received_now).sum();
    if total_received_now <= 0 {
        return Err(PurchaseOrderError::InvalidPayload(
            "received quantity must be > 0".to_string(),
        ));
    }

    for line in &lines {
        let updated = sqlx::query(
            r#"
            UPDATE purchase_order_lines
            SET quantity_received = quantity_received + $1
            WHERE id = $2 AND purchase_order_id = $3
              AND quantity_received + $1 <= quantity_ordered
            "#,
        )
        .bind(line.quantity_received_now)
        .bind(line.po_line_id)
        .bind(po_id)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() == 0 {
            return Err(PurchaseOrderError::InvalidPayload(
                "line not on this purchase order, or receive would exceed ordered quantity"
                    .to_string(),
            ));
        }
    }

    let lines_json = serde_json::to_value(&lines).map_err(|e| {
        PurchaseOrderError::InvalidPayload(format!("invalid receiving lines payload: {e}"))
    })?;

    let alloc_rows: Vec<ReceiveAllocationRow> = sqlx::query_as(
        r#"
        SELECT pol.id AS po_line_id, pol.variant_id, pol.unit_cost, r.quantity_received_now
        FROM purchase_order_lines pol
        JOIN (
            SELECT
                x.po_line_id::uuid AS po_line_id,
                x.quantity_received_now::int AS quantity_received_now
            FROM jsonb_to_recordset($1::jsonb) AS x(po_line_id text, quantity_received_now int)
        ) r ON r.po_line_id = pol.id
        WHERE pol.purchase_order_id = $2
        ORDER BY pol.id
        "#,
    )
    .bind(lines_json)
    .bind(po_id)
    .fetch_all(&mut *tx)
    .await?;

    if alloc_rows.len() != lines.len() {
        return Err(PurchaseOrderError::InvalidPayload(
            "one or more purchase order lines could not be resolved".to_string(),
        ));
    }

    let freight_inputs: Vec<(i32, Decimal)> = alloc_rows
        .iter()
        .map(|r| (r.quantity_received_now, r.unit_cost))
        .collect();
    let freight_adds =
        procurement::freight_add_per_unit_by_extended_cost(&freight_inputs, payload.freight_total);

    for (i, row) in alloc_rows.iter().enumerate() {
        let freight_add = freight_adds.get(i).copied().unwrap_or(Decimal::ZERO);
        // WAC and inventory capitalization use invoice unit only; freight is booked separately.
        let invoice_unit = procurement::round_unit_cost(row.unit_cost);

        type VarCostRow = (i32, Option<Decimal>, Decimal);
        let (stock_before, cost_ov, base_cost): VarCostRow = sqlx::query_as(
            r#"
            SELECT pv.stock_on_hand, pv.cost_override, p.base_cost
            FROM product_variants pv
            INNER JOIN products p ON p.id = pv.product_id
            WHERE pv.id = $1
            FOR UPDATE OF pv
            "#,
        )
        .bind(row.variant_id)
        .fetch_one(&mut *tx)
        .await?;

        let cost_before = effective_cost_usd(base_cost, cost_ov);
        let new_wac = procurement::weighted_average_cost(
            stock_before,
            cost_before,
            row.quantity_received_now,
            invoice_unit,
        )
        .ok_or_else(|| {
            PurchaseOrderError::InvalidPayload(
                "weighted average cost could not be computed".to_string(),
            )
        })?;
        let stored_wac = new_wac.round_dp_with_strategy(2, RoundingStrategy::AwayFromZero);

        sqlx::query(
            r#"
            UPDATE product_variants
            SET
                stock_on_hand = stock_on_hand + $1,
                cost_override = $2,
                shelf_labeled_at = NULL
            WHERE id = $3
            "#,
        )
        .bind(row.quantity_received_now)
        .bind(stored_wac)
        .bind(row.variant_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            UPDATE purchase_order_lines
            SET landed_cost_per_unit = $1
            WHERE id = $2 AND purchase_order_id = $3
            "#,
        )
        .bind(invoice_unit)
        .bind(row.po_line_id)
        .bind(po_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO inventory_transactions (
                variant_id, tx_type, quantity_delta, unit_cost, landed_cost_component,
                reference_table, reference_id, notes
            )
            VALUES ($1, 'po_receipt', $2, $3, $4, 'receiving_events', $5, $6)
            "#,
        )
        .bind(row.variant_id)
        .bind(row.quantity_received_now)
        .bind(invoice_unit)
        .bind(freight_add)
        .bind(receive_event_id)
        .bind(format!(
            "PO receipt · invoice unit {:.4} · freight/unit {:.4} · line {}",
            invoice_unit, freight_add, row.po_line_id
        ))
        .execute(&mut *tx)
        .await?;

        // For every unit received, allocate to open special/custom order items for this
        // variant (oldest order first). Those units go into reserved_stock because they are
        // already promised to a customer — they are NOT available for walk-in sales.
        let open_special_qty: Option<i64> = sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(oi.quantity)::bigint, 0)
            FROM transaction_lines oi
            INNER JOIN transactions o ON o.id = oi.transaction_id
            WHERE oi.variant_id = $1
              AND oi.fulfillment::text IN ('special_order', 'custom', 'wedding_order')
              AND oi.is_fulfilled = FALSE
              AND o.status NOT IN ('cancelled')
            "#,
        )
        .bind(row.variant_id)
        .fetch_optional(&mut *tx)
        .await?;

        let reserved_delta = open_special_qty
            .unwrap_or(0)
            .min(row.quantity_received_now as i64) as i32;

        if reserved_delta > 0 {
            sqlx::query(
                r#"
                UPDATE product_variants
                SET reserved_stock = reserved_stock + $1
                WHERE id = $2
                "#,
            )
            .bind(reserved_delta)
            .bind(row.variant_id)
            .execute(&mut *tx)
            .await?;
        }

        // --- WEDDING SYNC ---
        // If this variant is assigned to any wedding members as their suit selection,
        // mark them as received.
        sqlx::query(
            r#"
            UPDATE wedding_members
            SET 
                received = TRUE,
                received_date = COALESCE(received_date, NOW()),
                status = CASE WHEN status = 'ordered' THEN 'received' ELSE status END
            WHERE suit_variant_id = $1
              AND (received IS NULL OR received = FALSE)
            "#,
        )
        .bind(row.variant_id)
        .execute(&mut *tx)
        .await?;
    }

    let has_short = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM purchase_order_lines
            WHERE purchase_order_id = $1
              AND quantity_received < quantity_ordered
        )
        "#,
    )
    .bind(po_id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE purchase_orders
        SET
            status = CASE
                WHEN $4 THEN 'partially_received'::purchase_order_status
                ELSE 'closed'::purchase_order_status
            END,
            invoice_number = CASE
                WHEN $2::text IS NOT NULL AND TRIM($2::text) <> '' THEN TRIM($2::text)
                ELSE invoice_number
            END,
            freight_total = COALESCE(freight_total, 0) + $3,
            fully_received_at = CASE
                WHEN NOT $4 THEN COALESCE(fully_received_at, NOW())
                ELSE fully_received_at
            END
        WHERE id = $1
        "#,
    )
    .bind(po_id)
    .bind(invoice_number.clone())
    .bind(payload.freight_total)
    .bind(has_short)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    if has_short {
        if let Err(e) = create_backorder_from_short_lines(&state.db, po_id).await {
            tracing::error!(error = %e, "Backorder split failed");
        }
    }

    Ok(Json(json!({
        "status": "received",
        "receiving_event_id": receive_event_id,
        "freight_total_this_receipt": payload.freight_total,
        "freight_ledger_key": "COGS_FREIGHT",
        "backorder_created_for_short_lines": has_short
    })))
}

/// Draft PO with one line per unreceived remainder (same unit costs).
async fn create_backorder_from_short_lines(
    db: &sqlx::PgPool,
    source_po_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    let mut tx = db.begin().await?;

    let shorts: Vec<(Uuid, i32, Decimal)> = sqlx::query_as(
        r#"
        SELECT variant_id,
               quantity_ordered - quantity_received AS qty_short,
               unit_cost
        FROM purchase_order_lines
        WHERE purchase_order_id = $1
          AND quantity_received < quantity_ordered
        ORDER BY id
        "#,
    )
    .bind(source_po_id)
    .fetch_all(&mut *tx)
    .await?;

    if shorts.is_empty() {
        tx.commit().await?;
        return Ok(None);
    }

    let vendor_id: Uuid = sqlx::query_scalar("SELECT vendor_id FROM purchase_orders WHERE id = $1")
        .bind(source_po_id)
        .fetch_one(&mut *tx)
        .await?;

    let existing_bo: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM purchase_orders
        WHERE split_from_po_id = $1
          AND status = 'draft'
        LIMIT 1
        "#,
    )
    .bind(source_po_id)
    .fetch_optional(&mut *tx)
    .await?;

    let target_po_id = if let Some(id) = existing_bo {
        sqlx::query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        id
    } else {
        sqlx::query_scalar(
            r#"
            INSERT INTO purchase_orders (po_number, vendor_id, status, po_kind, notes, split_from_po_id)
            VALUES (
                CONCAT('BO-', TO_CHAR(NOW(), 'YYYYMMDD-HH24MISS')),
                $1,
                'draft',
                'standard',
                $2,
                $3
            )
            RETURNING id
            "#,
        )
        .bind(vendor_id)
        .bind(format!("Auto backorder from PO {source_po_id}"))
        .bind(source_po_id)
        .fetch_one(&mut *tx)
        .await?
    };

    for (variant_id, qty, uc) in shorts {
        if qty <= 0 {
            continue;
        }
        sqlx::query(
            r#"
            INSERT INTO purchase_order_lines (purchase_order_id, variant_id, quantity_ordered, unit_cost)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(target_po_id)
        .bind(variant_id)
        .bind(qty)
        .bind(uc)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(Some(target_po_id))
}
