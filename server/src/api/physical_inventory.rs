//! Physical Inventory HTTP routes — session CRUD, counting, review, and publish.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    effective_permissions_for_staff, staff_can_approve_manager_access, PHYSICAL_INVENTORY_MUTATE,
    PHYSICAL_INVENTORY_VIEW,
};
use crate::auth::pins;
use crate::logic::physical_inventory::{
    self, AddCountRequest, CreateSessionRequest, RecordDiscoveredItemRequest,
    ResolveDiscoveredItemRequest,
};
use crate::middleware::require_staff_with_permission;

const DEFAULT_COUNT_LIMIT: i64 = 500;
const DEFAULT_REVIEW_LIMIT: usize = 500;
const MAX_REVIEW_LIMIT: usize = 1_000;

#[derive(Deserialize)]
struct CountQuery {
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct ReviewQuery {
    q: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

fn bounded_count_limit(limit: Option<i64>) -> i64 {
    limit
        .unwrap_or(DEFAULT_COUNT_LIMIT)
        .clamp(1, DEFAULT_COUNT_LIMIT)
}

fn bounded_review_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_REVIEW_LIMIT)
        .clamp(1, MAX_REVIEW_LIMIT)
}

// ── Error type ────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct PhysicalInventoryError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for PhysicalInventoryError {
    fn from(e: E) -> Self {
        PhysicalInventoryError(e.into())
    }
}

impl IntoResponse for PhysicalInventoryError {
    fn into_response(self) -> Response {
        let msg = self.0.to_string();
        tracing::error!(error = %self.0, "Physical inventory error");
        let status = if msg.contains("already exists")
            || msg.contains("not found")
            || msg.contains("must be in")
            || msg.contains("scan source must")
            || msg.contains("scanned_code required")
            || msg.contains("discovered item status")
            || msg.contains("resolved_variant_id required")
            || msg.contains("Resolve or ignore")
            || msg.contains("Set unit cost")
            || msg.contains("Resolve non-sale inventory movement")
            || msg.contains("baseline_type must")
            || msg.contains("Manager Access")
            || msg.contains("scope must")
            || msg.contains("category_ids required")
        {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

// ── Router ────────────────────────────────────────────────────────────────────

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/sessions", get(list_sessions).post(create_session))
        .route("/sessions/active", get(get_active_session))
        .route(
            "/sessions/{id}",
            get(get_session).patch(patch_session).delete(cancel_session),
        )
        .route("/sessions/{id}/counts", post(add_count))
        .route("/sessions/{id}/counts/{count_id}", patch(patch_count))
        .route(
            "/sessions/{id}/counts/{count_id}/accept",
            post(accept_variance),
        )
        .route(
            "/sessions/{id}/discovered",
            get(list_discovered).post(record_discovered),
        )
        .route(
            "/sessions/{id}/discovered/{item_id}",
            patch(resolve_discovered),
        )
        .route("/sessions/{id}/review", get(get_review))
        .route("/sessions/{id}/reports", get(get_workspace_report))
        .route("/sessions/{id}/move-to-review", post(move_to_review))
        .route("/sessions/{id}/save", post(save_session))
        .route("/sessions/{id}/publish", post(publish_session))
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async fn list_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_VIEW)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.view permission required"))?;

    let rows = sqlx::query_as::<_, physical_inventory::PhysicalInventorySession>(
        r#"
        SELECT id, session_number, status, scope, category_ids,
               baseline_type, started_at, last_saved_at, published_at, notes,
               exclude_reserved, exclude_layaway
        FROM physical_inventory_sessions
        ORDER BY started_at DESC
        LIMIT 50
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    // Attach count stats per session
    let mut sessions_json = Vec::with_capacity(rows.len());
    for s in rows {
        let counted: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM physical_inventory_counts WHERE session_id = $1",
        )
        .bind(s.id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

        sessions_json.push(json!({
            "id": s.id,
            "session_number": s.session_number,
            "status": s.status,
            "scope": s.scope,
            "category_ids": s.category_ids,
            "baseline_type": s.baseline_type,
            "started_at": s.started_at,
            "last_saved_at": s.last_saved_at,
            "published_at": s.published_at,
            "notes": s.notes,
            "total_counted": counted,
        }));
    }

    Ok(Json(json!({ "sessions": sessions_json })))
}

async fn get_active_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_VIEW)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.view permission required"))?;

    match physical_inventory::get_active_session(&state.db).await? {
        Some(s) => Ok(Json(json!(s))),
        None => Ok(Json(json!(null))),
    }
}

async fn create_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateSessionRequest>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    let staff = require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;
    let session = physical_inventory::create_session(&state.db, payload, Some(staff.id)).await?;
    Ok(Json(json!(session)))
}

async fn get_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<CountQuery>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_VIEW)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.view permission required"))?;

    let session = sqlx::query_as::<_, physical_inventory::PhysicalInventorySession>(
        r#"
        SELECT id, session_number, status, scope, category_ids,
               baseline_type, started_at, last_saved_at, published_at, notes,
               exclude_reserved, exclude_layaway
        FROM physical_inventory_sessions
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("Session not found"))?;

    let count_limit = bounded_count_limit(query.limit);
    let count_total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM physical_inventory_counts WHERE session_id = $1")
            .bind(id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

    let counts = sqlx::query_as::<_, physical_inventory::CountRow>(
        r#"
        SELECT pic.id, pic.session_id, pic.variant_id, pv.sku,
               p.name AS product_name, pv.variation_label,
               pic.counted_qty, pic.adjusted_qty, pic.review_status,
               pic.review_note, pic.last_scanned_at, pic.scan_source
        FROM physical_inventory_counts pic
        JOIN product_variants pv ON pv.id = pic.variant_id
        JOIN products p ON p.id = pv.product_id
        WHERE pic.session_id = $1
        ORDER BY pic.last_scanned_at DESC
        LIMIT $2
        "#,
    )
    .bind(id)
    .bind(count_limit)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(json!({
        "session": session,
        "counts": counts,
        "count_total": count_total,
        "count_limit": count_limit,
    })))
}

#[derive(Deserialize)]
struct PatchSessionRequest {
    notes: Option<String>,
}

async fn patch_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchSessionRequest>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;

    sqlx::query(
        "UPDATE physical_inventory_sessions SET notes = COALESCE($1, notes), last_saved_at = NOW() WHERE id = $2",
    )
    .bind(body.notes.as_deref())
    .bind(id)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "status": "updated" })))
}

async fn add_count(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(mut payload): Json<AddCountRequest>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    let staff = require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;
    payload.staff_id = Some(staff.id);
    if !matches!(payload.source.as_str(), "laser" | "camera" | "manual") {
        return Err(anyhow::anyhow!("scan source must be 'laser', 'camera', or 'manual'").into());
    }

    // Verify session is open
    let (status, started_at, exclude_reserved, exclude_layaway): (
        String,
        chrono::DateTime<chrono::Utc>,
        bool,
        bool,
    ) =
        sqlx::query_as(
            "SELECT status, started_at, exclude_reserved, exclude_layaway FROM physical_inventory_sessions WHERE id = $1",
        )
            .bind(id)
            .fetch_one(&state.db)
            .await
            .map_err(|_| anyhow::anyhow!("Session not found"))?;

    if status != "open" {
        return Err(anyhow::anyhow!("Session is not open for counting (status: {status})").into());
    }

    // Ensure variant is in snapshot (handle variants added after session start)
    sqlx::query(
        r#"
        INSERT INTO physical_inventory_snapshots (session_id, variant_id, stock_at_start)
        SELECT
            $1,
            pv.id,
            pv.stock_on_hand
              - CASE WHEN $3 THEN COALESCE(pv.reserved_stock, 0) ELSE 0 END
              - CASE WHEN $4 THEN COALESCE(pv.on_layaway, 0) ELSE 0 END
        FROM product_variants pv
        WHERE pv.id = $2
        ON CONFLICT (session_id, variant_id) DO NOTHING
        "#,
    )
    .bind(id)
    .bind(payload.variant_id)
    .bind(exclude_reserved)
    .bind(exclude_layaway)
    .execute(&state.db)
    .await?;

    let new_qty = physical_inventory::upsert_count(&state.db, id, payload, started_at).await?;
    Ok(Json(json!({ "counted_qty": new_qty })))
}

#[derive(Deserialize)]
struct PatchCountRequest {
    adjusted_qty: i32,
    note: Option<String>,
}

async fn patch_count(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((session_id, count_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<PatchCountRequest>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    let staff = require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;

    physical_inventory::apply_review_adjustment(
        &state.db,
        session_id,
        count_id,
        body.adjusted_qty,
        body.note,
        Some(staff.id),
    )
    .await?;
    Ok(Json(json!({ "status": "adjusted" })))
}

async fn accept_variance(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((session_id, count_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    let staff = require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;
    confirm_variance(&state.db, session_id, count_id, Some(staff.id)).await?;
    Ok(Json(json!({ "status": "confirmed" })))
}

async fn get_review(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<ReviewQuery>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_VIEW)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.view permission required"))?;

    let rows = physical_inventory::build_review(&state.db, id).await?;
    let total_counted = rows.iter().filter(|r| r.counted_qty > 0).count() as i64;
    let total_variants_in_scope = rows.len() as i64;
    let missing_variants = rows
        .iter()
        .filter(|r| r.counted_qty == 0 && r.adjusted_qty.is_none())
        .count() as i64;
    let total_shrinkage: i32 = rows
        .iter()
        .filter(|r| r.delta < 0)
        .map(|r| r.delta.abs())
        .sum();
    let total_surplus: i32 = rows.iter().filter(|r| r.delta > 0).map(|r| r.delta).sum();
    let zero_cost_movement_count = rows
        .iter()
        .filter(|r| r.delta != 0 && r.unit_cost <= rust_decimal::Decimal::ZERO)
        .count() as i64;
    let accounting_impact = rows.iter().fold(rust_decimal::Decimal::ZERO, |acc, r| {
        acc + r.accounting_impact
    });
    let non_sale_movement_count =
        physical_inventory::count_non_sale_movements(&state.db, id).await?;
    let q = query.q.unwrap_or_default().trim().to_ascii_lowercase();
    let offset = query.offset.unwrap_or(0);
    let limit = bounded_review_limit(query.limit);
    let mut visible_rows: Vec<_> = if q.is_empty() {
        rows
    } else {
        rows.into_iter()
            .filter(|row| {
                row.sku.to_ascii_lowercase().contains(&q)
                    || row.product_name.to_ascii_lowercase().contains(&q)
                    || row
                        .variation_label
                        .as_ref()
                        .map(|label| label.to_ascii_lowercase().contains(&q))
                        .unwrap_or(false)
            })
            .collect()
    };
    visible_rows.sort_by(|a, b| {
        b.delta
            .abs()
            .cmp(&a.delta.abs())
            .then_with(|| a.product_name.cmp(&b.product_name))
            .then_with(|| a.sku.cmp(&b.sku))
    });
    let matching_rows = visible_rows.len();
    let response_rows: Vec<_> = visible_rows.into_iter().skip(offset).take(limit).collect();
    let rows_returned = response_rows.len();
    let rows_hidden = matching_rows.saturating_sub(offset + rows_returned);
    Ok(Json(json!({
        "rows": response_rows,
        "summary": {
            "total_counted": total_counted,
            "total_variants_in_scope": total_variants_in_scope,
            "missing_variants": missing_variants,
            "total_shrinkage": total_shrinkage,
            "total_surplus": total_surplus,
            "zero_cost_movement_count": zero_cost_movement_count,
            "non_sale_movement_count": non_sale_movement_count,
            "accounting_impact": accounting_impact,
            "rows_matching_filter": matching_rows,
            "rows_returned": rows_returned,
            "rows_hidden": rows_hidden,
            "row_limit": limit,
        }
    })))
}

/// Manually confirm (accept) a variance for a specific count row.
pub async fn confirm_variance(
    pool: &PgPool,
    session_id: Uuid,
    count_id: Uuid,
    staff_id: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE physical_inventory_counts SET review_status = 'ok' WHERE id = $1 AND session_id = $2",
    )
    .bind(count_id)
    .bind(session_id)
    .execute(pool)
    .await?;

    sqlx::query(
        "INSERT INTO physical_inventory_audit (session_id, event_type, performed_by, note) VALUES ($1, 'review_confirm', $2, 'Variance manually accepted')",
    )
    .bind(session_id)
    .bind(staff_id)
    .execute(pool)
    .await?;

    Ok(())
}

async fn list_discovered(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_VIEW)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.view permission required"))?;

    let rows = physical_inventory::list_discovered_items(&state.db, id).await?;
    Ok(Json(json!({ "items": rows })))
}

async fn record_discovered(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<RecordDiscoveredItemRequest>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    let staff = require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;

    let item =
        physical_inventory::record_discovered_item(&state.db, id, payload, Some(staff.id)).await?;
    Ok(Json(json!(item)))
}

async fn resolve_discovered(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((session_id, item_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<ResolveDiscoveredItemRequest>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    let staff = require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;

    let item = physical_inventory::resolve_discovered_item(
        &state.db,
        session_id,
        item_id,
        payload,
        Some(staff.id),
    )
    .await?;
    Ok(Json(json!(item)))
}

async fn get_workspace_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_VIEW)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.view permission required"))?;

    let report = physical_inventory::build_workspace_report(&state.db, id).await?;
    Ok(Json(json!(report)))
}

async fn move_to_review(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    let staff = require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;
    physical_inventory::move_to_review(&state.db, id, Some(staff.id)).await?;
    Ok(Json(json!({ "status": "reviewing" })))
}

async fn save_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    let staff = require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;
    physical_inventory::save_session(&state.db, id, Some(staff.id)).await?;
    Ok(Json(json!({ "status": "saved" })))
}

#[derive(Deserialize)]
struct PublishSessionRequest {
    manager_staff_id: Uuid,
    manager_pin: String,
    approval_note: Option<String>,
}

async fn publish_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<PublishSessionRequest>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    let staff = require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;
    let manager =
        pins::authenticate_staff_by_id(&state.db, body.manager_staff_id, Some(&body.manager_pin))
            .await
            .map_err(|_| anyhow::anyhow!("Manager Access PIN was not approved"))?;
    let effective = effective_permissions_for_staff(&state.db, manager.id, manager.role).await?;
    if !staff_can_approve_manager_access(&effective, manager.role) {
        return Err(anyhow::anyhow!("Manager Access is required to publish").into());
    }

    let _ = pins::log_staff_access(
        &state.db,
        manager.id,
        "physical_inventory_publish_approval",
        json!({
            "session_id": id,
            "operator_staff_id": staff.id,
        }),
    )
    .await;

    let result = physical_inventory::publish_session(
        &state.db,
        id,
        Some(staff.id),
        manager.id,
        body.approval_note,
    )
    .await?;
    Ok(Json(json!(result)))
}

async fn cancel_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    let staff = require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;
    physical_inventory::cancel_session(&state.db, id, Some(staff.id)).await?;
    Ok(Json(json!({ "status": "cancelled" })))
}
