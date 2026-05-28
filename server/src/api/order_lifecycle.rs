//! Ordered-item lifecycle and NTBO operational queues.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    effective_permissions_for_staff, staff_has_permission, ORDERS_LIFECYCLE_MANAGE, ORDERS_VIEW,
    PROCUREMENT_MUTATE,
};
use crate::auth::pins;
use crate::logic::messaging::MessagingService;
use crate::logic::order_lifecycle;
use crate::middleware;
use crate::models::DbOrderItemLifecycleStatus;

#[derive(Debug, Error)]
pub enum OrderLifecycleError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("Order item not found")]
    NotFound,
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
}

impl IntoResponse for OrderLifecycleError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            OrderLifecycleError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            OrderLifecycleError::NotFound => {
                (StatusCode::NOT_FOUND, "Order item not found".to_string())
            }
            OrderLifecycleError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            OrderLifecycleError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            OrderLifecycleError::Database(e) => {
                tracing::error!(error = %e, "Database error in order_lifecycle");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

fn map_perm_err(e: (StatusCode, axum::Json<serde_json::Value>)) -> OrderLifecycleError {
    let (status, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match status {
        StatusCode::UNAUTHORIZED => OrderLifecycleError::Unauthorized(msg),
        StatusCode::FORBIDDEN => OrderLifecycleError::Forbidden(msg),
        _ => OrderLifecycleError::InvalidPayload(msg),
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/items", get(list_lifecycle_items))
        .route(
            "/items/{transaction_line_id}/transition",
            post(transition_item),
        )
        .route("/ntbo/create-po", post(create_po_from_ntbo))
        .route(
            "/weddings/{wedding_party_id}/readiness",
            get(wedding_readiness),
        )
}

#[derive(Debug, Deserialize)]
pub struct LifecycleItemsQuery {
    pub status: Option<String>,
    pub unlinked_only: Option<bool>,
    pub vendor_id: Option<Uuid>,
    pub wedding_party_id: Option<Uuid>,
    pub rush: Option<bool>,
    pub salesperson_id: Option<Uuid>,
    pub customer_id: Option<Uuid>,
    pub category_id: Option<Uuid>,
    pub need_by_from: Option<NaiveDate>,
    pub need_by_to: Option<NaiveDate>,
    pub wedding_date_from: Option<NaiveDate>,
    pub wedding_date_to: Option<NaiveDate>,
}

#[derive(Debug, FromRow)]
struct LifecycleItemRow {
    transaction_id: Uuid,
    transaction_display_id: Option<String>,
    transaction_line_id: Uuid,
    customer_id: Option<Uuid>,
    customer_name: Option<String>,
    customer_phone: Option<String>,
    customer_email: Option<String>,
    wedding_party_id: Option<Uuid>,
    wedding_name: Option<String>,
    wedding_date: Option<NaiveDate>,
    vendor_id: Option<Uuid>,
    vendor_name: Option<String>,
    product_id: Uuid,
    product_name: String,
    variant_id: Uuid,
    sku: String,
    variation_label: Option<String>,
    category_id: Option<Uuid>,
    category_name: Option<String>,
    salesperson_id: Option<Uuid>,
    salesperson_name: Option<String>,
    operator_name: Option<String>,
    quantity: i32,
    lifecycle_status: String,
    is_rush: bool,
    need_by_date: Option<NaiveDate>,
    booked_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct LifecycleItem {
    pub transaction_id: Uuid,
    pub transaction_display_id: String,
    pub transaction_line_id: Uuid,
    pub customer_id: Option<Uuid>,
    pub customer_name: String,
    pub customer_phone: Option<String>,
    pub customer_email: Option<String>,
    pub wedding_party_id: Option<Uuid>,
    pub wedding_name: Option<String>,
    pub wedding_date: Option<NaiveDate>,
    pub vendor_id: Option<Uuid>,
    pub vendor_name: Option<String>,
    pub product_id: Uuid,
    pub product_name: String,
    pub variant_id: Uuid,
    pub sku: String,
    pub variation_label: Option<String>,
    pub category_id: Option<Uuid>,
    pub category_name: Option<String>,
    pub salesperson_id: Option<Uuid>,
    pub salesperson_name: Option<String>,
    pub operator_name: Option<String>,
    pub quantity: i32,
    pub lifecycle_status: String,
    pub is_rush: bool,
    pub need_by_date: Option<NaiveDate>,
    pub booked_at: DateTime<Utc>,
    pub days_outstanding: i64,
    pub risk_level: String,
    pub safe_next_action: String,
}

async fn list_lifecycle_items(
    State(state): State<AppState>,
    Query(q): Query<LifecycleItemsQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<LifecycleItem>>, OrderLifecycleError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_VIEW)
        .await
        .map_err(map_perm_err)?;
    if let Some(status) = q.status.as_deref() {
        parse_lifecycle_status(status)?;
    }

    let rows = sqlx::query_as::<_, LifecycleItemRow>(
        r#"
        SELECT
            t.id AS transaction_id,
            t.display_id AS transaction_display_id,
            tl.id AS transaction_line_id,
            c.id AS customer_id,
            NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
            c.phone AS customer_phone,
            c.email AS customer_email,
            wp.id AS wedding_party_id,
            wp.party_name AS wedding_name,
            COALESCE(tl.wedding_date, wp.event_date) AS wedding_date,
            tl.vendor_id,
            v.name AS vendor_name,
            p.id AS product_id,
            p.name AS product_name,
            pv.id AS variant_id,
            pv.sku,
            pv.variation_label,
            p.category_id,
            cat.name AS category_name,
            tl.salesperson_id,
            sp.full_name AS salesperson_name,
            op.full_name AS operator_name,
            tl.quantity,
            tl.order_lifecycle_status::text AS lifecycle_status,
            COALESCE(tl.is_rush, t.is_rush, false) AS is_rush,
            COALESCE(tl.need_by_date, t.need_by_date) AS need_by_date,
            t.booked_at
        FROM transaction_lines tl
        INNER JOIN transactions t ON t.id = tl.transaction_id
        INNER JOIN products p ON p.id = tl.product_id
        INNER JOIN product_variants pv ON pv.id = tl.variant_id
        LEFT JOIN customers c ON c.id = t.customer_id
        LEFT JOIN wedding_members wm ON wm.id = t.wedding_member_id
        LEFT JOIN wedding_parties wp ON wp.id = COALESCE(tl.wedding_id, wm.wedding_party_id)
        LEFT JOIN vendors v ON v.id = tl.vendor_id
        LEFT JOIN categories cat ON cat.id = p.category_id
        LEFT JOIN staff sp ON sp.id = tl.salesperson_id
        LEFT JOIN staff op ON op.id = t.operator_id
        WHERE tl.fulfillment::text <> 'takeaway'
          AND ($1::text IS NULL OR tl.order_lifecycle_status = $1::order_item_lifecycle_status)
          AND ($2::uuid IS NULL OR tl.vendor_id = $2)
          AND ($3::uuid IS NULL OR wp.id = $3)
          AND ($4::bool IS NULL OR COALESCE(tl.is_rush, t.is_rush, false) = $4)
          AND ($5::uuid IS NULL OR tl.salesperson_id = $5)
          AND ($6::uuid IS NULL OR t.customer_id = $6)
          AND ($7::uuid IS NULL OR p.category_id = $7)
          AND ($8::date IS NULL OR COALESCE(tl.need_by_date, t.need_by_date) >= $8)
          AND ($9::date IS NULL OR COALESCE(tl.need_by_date, t.need_by_date) <= $9)
          AND ($10::date IS NULL OR COALESCE(tl.wedding_date, wp.event_date) >= $10)
          AND ($11::date IS NULL OR COALESCE(tl.wedding_date, wp.event_date) <= $11)
          AND ($12::bool IS NOT TRUE OR (tl.po_id IS NULL AND tl.po_line_id IS NULL))
        ORDER BY
            COALESCE(tl.is_rush, t.is_rush, false) DESC,
            COALESCE(tl.need_by_date, t.need_by_date) NULLS LAST,
            COALESCE(tl.wedding_date, wp.event_date) NULLS LAST,
            t.booked_at,
            tl.id
        LIMIT 500
        "#,
    )
    .bind(q.status.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(q.vendor_id)
    .bind(q.wedding_party_id)
    .bind(q.rush)
    .bind(q.salesperson_id)
    .bind(q.customer_id)
    .bind(q.category_id)
    .bind(q.need_by_from)
    .bind(q.need_by_to)
    .bind(q.wedding_date_from)
    .bind(q.wedding_date_to)
    .bind(q.unlinked_only)
    .fetch_all(&state.db)
    .await?;

    let today = Utc::now().date_naive();
    let items = rows
        .into_iter()
        .map(|row| {
            let risk_level = lifecycle_risk_level(
                &row.lifecycle_status,
                row.is_rush,
                row.need_by_date,
                row.wedding_date,
                today,
            );
            let safe_next_action = lifecycle_safe_next_action(&row.lifecycle_status);
            LifecycleItem {
                transaction_id: row.transaction_id,
                transaction_display_id: row
                    .transaction_display_id
                    .unwrap_or_else(|| row.transaction_id.to_string()),
                transaction_line_id: row.transaction_line_id,
                customer_id: row.customer_id,
                customer_name: row
                    .customer_name
                    .unwrap_or_else(|| "Walk-in Customer".to_string()),
                customer_phone: row.customer_phone,
                customer_email: row.customer_email,
                wedding_party_id: row.wedding_party_id,
                wedding_name: row.wedding_name,
                wedding_date: row.wedding_date,
                vendor_id: row.vendor_id,
                vendor_name: row.vendor_name,
                product_id: row.product_id,
                product_name: row.product_name,
                variant_id: row.variant_id,
                sku: row.sku,
                variation_label: row.variation_label,
                category_id: row.category_id,
                category_name: row.category_name,
                salesperson_id: row.salesperson_id,
                salesperson_name: row.salesperson_name,
                operator_name: row.operator_name,
                quantity: row.quantity,
                lifecycle_status: row.lifecycle_status,
                is_rush: row.is_rush,
                need_by_date: row.need_by_date,
                booked_at: row.booked_at,
                days_outstanding: (Utc::now() - row.booked_at).num_days(),
                risk_level,
                safe_next_action,
            }
        })
        .collect();

    Ok(Json(items))
}

#[derive(Debug, Deserialize)]
pub struct TransitionRequest {
    pub next_status: String,
    pub reason: Option<String>,
    pub vendor_id: Option<Uuid>,
    pub vendor_eta: Option<NaiveDate>,
    pub vendor_reference: Option<String>,
    pub manager_staff_code: Option<String>,
    pub manager_pin: Option<String>,
    pub metadata: Option<Value>,
}

async fn transition_item(
    State(state): State<AppState>,
    Path(transaction_line_id): Path<Uuid>,
    headers: HeaderMap,
    Json(payload): Json<TransitionRequest>,
) -> Result<Json<Value>, OrderLifecycleError> {
    let staff =
        match middleware::require_staff_with_permission(&state, &headers, ORDERS_LIFECYCLE_MANAGE)
            .await
        {
            Ok(staff) => staff,
            Err(permission_error) => {
                let manager_code = payload
                    .manager_staff_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        let mapped = map_perm_err(permission_error);
                        OrderLifecycleError::Forbidden(format!(
                            "{mapped}. Manager Access PIN is required for lifecycle repair."
                        ))
                    })?;
                let manager_pin = payload
                    .manager_pin
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        OrderLifecycleError::Forbidden(
                            "Manager Access PIN is required for lifecycle repair.".to_string(),
                        )
                    })?;
                let manager =
                    pins::authenticate_pos_staff(&state.db, manager_code, Some(manager_pin))
                        .await
                        .map_err(|_| {
                            OrderLifecycleError::Forbidden(
                                "Manager Access PIN could not authorize lifecycle repair."
                                    .to_string(),
                            )
                        })?;
                let effective =
                    effective_permissions_for_staff(&state.db, manager.id, manager.role)
                        .await
                        .map_err(OrderLifecycleError::Database)?;
                if !staff_has_permission(&effective, ORDERS_LIFECYCLE_MANAGE) {
                    return Err(OrderLifecycleError::Forbidden(
                        "Manager Access does not include orders.lifecycle_manage.".to_string(),
                    ));
                }
                manager
            }
        };
    let next_status = parse_lifecycle_status(&payload.next_status)?;
    match next_status {
        DbOrderItemLifecycleStatus::Received => {
            return Err(OrderLifecycleError::InvalidPayload(
                "Use purchase order receiving so inventory and audit records stay correct"
                    .to_string(),
            ));
        }
        DbOrderItemLifecycleStatus::PickedUp => {
            return Err(OrderLifecycleError::InvalidPayload(
                "Use the pickup fulfillment workflow so revenue, inventory, and commission records stay correct"
                    .to_string(),
            ));
        }
        _ => {}
    }
    if next_status == DbOrderItemLifecycleStatus::Ordered && payload.vendor_id.is_none() {
        return Err(OrderLifecycleError::InvalidPayload(
            "vendor_id is required when manually marking an item ordered".to_string(),
        ));
    }

    let mut tx = state.db.begin().await?;
    let exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM transaction_lines
            WHERE id = $1
              AND fulfillment::text <> 'takeaway'
        )
        "#,
    )
    .bind(transaction_line_id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(OrderLifecycleError::NotFound);
    }

    // Check if line has pending alterations before allowing ready_for_pickup
    if next_status == DbOrderItemLifecycleStatus::ReadyForPickup {
        let alteration_ready: bool = sqlx::query_scalar(
            "SELECT COALESCE(alteration_ready, false) FROM transaction_lines WHERE id = $1"
        )
        .bind(transaction_line_id)
        .fetch_one(&mut *tx)
        .await?;

        let has_pending_alteration: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM alteration_orders
                WHERE source_transaction_line_id = $1
                  AND status IN ('intake', 'in_work', 'verify_completed')
            )
            "#,
        )
        .bind(transaction_line_id)
        .fetch_one(&mut *tx)
        .await?;

        if has_pending_alteration && !alteration_ready {
            return Err(OrderLifecycleError::InvalidPayload(
                "Cannot mark ready for pickup: pending alterations must be completed first".to_string(),
            ));
        }

        // Clear alteration_ready flag when order is marked ready
        sqlx::query(
            r#"
            UPDATE transaction_lines
            SET alteration_ready = false,
                updated_at = now()
            WHERE id = $1
            "#,
        )
        .bind(transaction_line_id)
        .execute(&mut *tx)
        .await?;
    }

    if next_status == DbOrderItemLifecycleStatus::Ordered {
        sqlx::query(
            r#"
            UPDATE transaction_lines
            SET
                vendor_id = COALESCE($2, vendor_id),
                vendor_eta = COALESCE($3, vendor_eta),
                vendor_reference = COALESCE(NULLIF(TRIM($4), ''), vendor_reference)
            WHERE id = $1
            "#,
        )
        .bind(transaction_line_id)
        .bind(payload.vendor_id)
        .bind(payload.vendor_eta)
        .bind(payload.vendor_reference.as_deref())
        .execute(&mut *tx)
        .await?;
    }

    order_lifecycle::apply_transition_tx(
        &mut tx,
        &[transaction_line_id],
        next_status,
        Some(staff.id),
        "manual_lifecycle_transition",
        payload.reason.as_deref(),
        payload.metadata.unwrap_or_else(|| json!({})),
    )
    .await?;
    tx.commit().await?;

    if next_status == DbOrderItemLifecycleStatus::ReadyForPickup {
        let pool1 = state.db.clone();
        let pool2 = state.db.clone();
        let line_id = transaction_line_id;

        // Send staff notification
        tokio::spawn(async move {
            if let Err(error) =
                crate::logic::notifications::emit_order_item_ready_for_pickup(&pool1, line_id).await
            {
                tracing::error!(%error, %line_id, "emit_order_item_ready_for_pickup");
            }
        });

        // Queue customer notification for batch sending
        tokio::spawn(async move {
            let row: Option<(Uuid, Uuid)> = sqlx::query_as(
                r#"
                SELECT t.id AS transaction_id, t.customer_id
                FROM transaction_lines tl
                INNER JOIN transactions t ON t.id = tl.transaction_id
                WHERE tl.id = $1
                "#,
            )
            .bind(line_id)
            .fetch_optional(&pool2)
            .await
            .ok()
            .flatten();

            if let Some((transaction_id, customer_id)) = row {
                let _ = sqlx::query("SELECT queue_order_ready_notification($1, $2, NULL)")
                    .bind(transaction_id)
                    .bind(customer_id)
                    .execute(&pool2)
                    .await;
            }
        });
    }

    Ok(Json(
        json!({ "ok": true, "transaction_line_id": transaction_line_id }),
    ))
}

#[derive(Debug, Deserialize)]
pub struct CreatePoFromNtboRequest {
    pub purchase_order_id: Option<Uuid>,
    pub vendor_id: Uuid,
    pub transaction_line_ids: Vec<Uuid>,
    pub expected_at: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreatePoFromNtboResponse {
    pub purchase_order_id: Uuid,
    pub po_number: String,
    pub linked_line_count: usize,
}

#[derive(Debug, FromRow)]
struct NtboPoLineCandidate {
    transaction_line_id: Uuid,
    variant_id: Uuid,
    quantity: i32,
    unit_cost: Decimal,
}

async fn create_po_from_ntbo(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreatePoFromNtboRequest>,
) -> Result<Json<CreatePoFromNtboResponse>, OrderLifecycleError> {
    let staff =
        middleware::require_staff_with_permission(&state, &headers, ORDERS_LIFECYCLE_MANAGE)
            .await
            .map_err(map_perm_err)?;
    middleware::require_staff_with_permission(&state, &headers, PROCUREMENT_MUTATE)
        .await
        .map_err(map_perm_err)?;
    if payload.transaction_line_ids.is_empty() {
        return Err(OrderLifecycleError::InvalidPayload(
            "Select at least one NTBO order item".to_string(),
        ));
    }

    let mut tx = state.db.begin().await?;
    let vendor_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM vendors WHERE id = $1 AND is_active = TRUE)",
    )
    .bind(payload.vendor_id)
    .fetch_one(&mut *tx)
    .await?;
    if !vendor_exists {
        return Err(OrderLifecycleError::InvalidPayload(
            "vendor_id not found or inactive".to_string(),
        ));
    }

    let candidates = sqlx::query_as::<_, NtboPoLineCandidate>(
        r#"
        SELECT
            tl.id AS transaction_line_id,
            tl.variant_id,
            tl.quantity,
            COALESCE(NULLIF(tl.unit_cost, 0), pv.cost_override, p.base_cost, 0)::numeric(12,2)
                AS unit_cost
        FROM transaction_lines tl
        INNER JOIN product_variants pv ON pv.id = tl.variant_id
        INNER JOIN products p ON p.id = tl.product_id
        WHERE tl.id = ANY($1)
          AND tl.fulfillment::text <> 'takeaway'
          AND tl.is_fulfilled = FALSE
          AND tl.order_lifecycle_status = 'ntbo'
          AND tl.po_id IS NULL
          AND tl.po_line_id IS NULL
        ORDER BY tl.id
        FOR UPDATE OF tl
        "#,
    )
    .bind(&payload.transaction_line_ids)
    .fetch_all(&mut *tx)
    .await?;

    if candidates.len() != payload.transaction_line_ids.len() {
        return Err(OrderLifecycleError::InvalidPayload(
            "Only open NTBO order items can be added to this vendor purchase order".to_string(),
        ));
    }

    let (purchase_order_id, po_number): (Uuid, String) =
        if let Some(existing_po_id) = payload.purchase_order_id {
            let row = sqlx::query_as::<_, (Uuid, String)>(
                r#"
                SELECT id, po_number
                FROM purchase_orders
                WHERE id = $1
                  AND vendor_id = $2
                  AND status = 'draft'
                  AND po_kind = 'standard'
                FOR UPDATE
                "#,
            )
            .bind(existing_po_id)
            .bind(payload.vendor_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                OrderLifecycleError::InvalidPayload(
                    "Selected purchase order must be a draft for this vendor".to_string(),
                )
            })?;
            row
        } else {
            sqlx::query_as(
                r#"
                INSERT INTO purchase_orders (
                    po_number, vendor_id, status, expected_at, notes, created_by, po_kind
                )
                VALUES (
                    CONCAT(
                        'PO-',
                        TO_CHAR(NOW(), 'YYYYMMDD-HH24MISS-MS'),
                        '-',
                        LPAD((FLOOR(random() * 1000))::int::text, 3, '0')
                    ),
                    $1,
                    'draft',
                    $2::timestamptz,
                    $3,
                    $4,
                    'standard'
                )
                RETURNING id, po_number
                "#,
            )
            .bind(payload.vendor_id)
            .bind(payload.expected_at)
            .bind(payload.notes)
            .bind(staff.id)
            .fetch_one(&mut *tx)
            .await?
        };

    let mut links: Vec<(Uuid, Uuid)> = Vec::with_capacity(candidates.len());
    for candidate in &candidates {
        let po_line_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO purchase_order_lines (
                purchase_order_id, variant_id, quantity_ordered, unit_cost
            )
            VALUES ($1, $2, $3, GREATEST($4, 0))
            RETURNING id
            "#,
        )
        .bind(purchase_order_id)
        .bind(candidate.variant_id)
        .bind(candidate.quantity)
        .bind(candidate.unit_cost)
        .fetch_one(&mut *tx)
        .await?;
        links.push((candidate.transaction_line_id, po_line_id));
    }

    order_lifecycle::attach_lines_to_po_tx(&mut tx, &links, purchase_order_id, payload.vendor_id)
        .await?;
    tx.commit().await?;

    Ok(Json(CreatePoFromNtboResponse {
        purchase_order_id,
        po_number,
        linked_line_count: links.len(),
    }))
}

#[derive(Debug, Serialize, FromRow)]
pub struct WeddingReadinessResponse {
    pub wedding_party_id: Uuid,
    pub ntbo_count: i64,
    pub ordered_count: i64,
    pub received_count: i64,
    pub ready_for_pickup_count: i64,
    pub picked_up_count: i64,
    pub open_count: i64,
    pub rush_count: i64,
    pub at_risk_count: i64,
    pub summary_status: String,
}

async fn wedding_readiness(
    State(state): State<AppState>,
    Path(wedding_party_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<WeddingReadinessResponse>, OrderLifecycleError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_VIEW)
        .await
        .map_err(map_perm_err)?;

    let row = sqlx::query_as::<_, WeddingReadinessResponse>(
        r#"
        WITH scoped AS (
            SELECT
                tl.order_lifecycle_status,
                COALESCE(tl.is_rush, t.is_rush, false) AS is_rush,
                COALESCE(tl.need_by_date, t.need_by_date) AS need_by_date,
                COALESCE(tl.wedding_date, wp.event_date) AS wedding_date
            FROM transaction_lines tl
            INNER JOIN transactions t ON t.id = tl.transaction_id
            LEFT JOIN wedding_members wm ON wm.id = t.wedding_member_id
            INNER JOIN wedding_parties wp ON wp.id = COALESCE(tl.wedding_id, wm.wedding_party_id)
            WHERE wp.id = $1
              AND tl.fulfillment::text <> 'takeaway'
        ),
        counts AS (
            SELECT
                COUNT(*) FILTER (WHERE order_lifecycle_status = 'ntbo')::bigint AS ntbo_count,
                COUNT(*) FILTER (WHERE order_lifecycle_status = 'ordered')::bigint AS ordered_count,
                COUNT(*) FILTER (WHERE order_lifecycle_status = 'received')::bigint AS received_count,
                COUNT(*) FILTER (WHERE order_lifecycle_status = 'ready_for_pickup')::bigint AS ready_for_pickup_count,
                COUNT(*) FILTER (WHERE order_lifecycle_status = 'picked_up')::bigint AS picked_up_count,
                COUNT(*) FILTER (WHERE order_lifecycle_status <> 'picked_up')::bigint AS open_count,
                COUNT(*) FILTER (WHERE is_rush)::bigint AS rush_count,
                COUNT(*) FILTER (
                    WHERE order_lifecycle_status IN ('ntbo', 'ordered')
                      AND (
                          is_rush
                          OR need_by_date <= CURRENT_DATE + INTERVAL '4 days'
                          OR wedding_date <= CURRENT_DATE + INTERVAL '14 days'
                      )
                )::bigint AS at_risk_count
            FROM scoped
        )
        SELECT
            $1 AS wedding_party_id,
            ntbo_count,
            ordered_count,
            received_count,
            ready_for_pickup_count,
            picked_up_count,
            open_count,
            rush_count,
            at_risk_count,
            CASE
                WHEN at_risk_count > 0 THEN 'at_risk'
                WHEN open_count = 0 THEN 'complete'
                WHEN ready_for_pickup_count > 0 THEN 'partially_ready'
                ELSE 'in_progress'
            END AS summary_status
        FROM counts
        "#,
    )
    .bind(wedding_party_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row))
}

fn parse_lifecycle_status(raw: &str) -> Result<DbOrderItemLifecycleStatus, OrderLifecycleError> {
    match raw.trim() {
        "needs_measurements" => Ok(DbOrderItemLifecycleStatus::NeedsMeasurements),
        "ntbo" => Ok(DbOrderItemLifecycleStatus::Ntbo),
        "ordered" => Ok(DbOrderItemLifecycleStatus::Ordered),
        "received" => Ok(DbOrderItemLifecycleStatus::Received),
        "ready_for_pickup" => Ok(DbOrderItemLifecycleStatus::ReadyForPickup),
        "picked_up" => Ok(DbOrderItemLifecycleStatus::PickedUp),
        other => Err(OrderLifecycleError::InvalidPayload(format!(
            "unsupported lifecycle status: {other}"
        ))),
    }
}

fn lifecycle_risk_level(
    status: &str,
    is_rush: bool,
    need_by_date: Option<NaiveDate>,
    wedding_date: Option<NaiveDate>,
    today: NaiveDate,
) -> String {
    if status == "picked_up" {
        return "complete".to_string();
    }
    let need_by_soon = need_by_date
        .map(|date| date <= today + chrono::Duration::days(4))
        .unwrap_or(false);
    let wedding_soon = wedding_date
        .map(|date| date <= today + chrono::Duration::days(14))
        .unwrap_or(false);
    if (status == "ntbo" || status == "ordered") && (is_rush || need_by_soon || wedding_soon) {
        "at_risk".to_string()
    } else if is_rush || need_by_soon || wedding_soon {
        "needs_review".to_string()
    } else {
        "normal".to_string()
    }
}

fn lifecycle_safe_next_action(status: &str) -> String {
    match status {
        "ntbo" => "Create or attach a vendor purchase order".to_string(),
        "ordered" => "Wait for vendor receipt, then receive through PO receiving".to_string(),
        "received" => "Review prep or alterations, then mark ready for pickup".to_string(),
        "ready_for_pickup" => {
            "Fulfill through the pickup workflow when the customer receives it".to_string()
        }
        "picked_up" => "No action needed; item was fulfilled".to_string(),
        _ => "Review item lifecycle before taking action".to_string(),
    }
}
