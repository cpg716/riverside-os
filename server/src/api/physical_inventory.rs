//! Physical Inventory HTTP routes — session CRUD, counting, review, and publish.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::api::{AppState, PgPool};
use crate::auth::permissions::{PHYSICAL_INVENTORY_MUTATE, PHYSICAL_INVENTORY_VIEW};
use crate::logic::physical_inventory::{self, AddCountRequest, CreateSessionRequest};
use crate::middleware::require_staff_with_permission;

// ── Error type ────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct PhysicalInventoryError(pub anyhow::Error);

impl<E> From<E> for PhysicalInventoryError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        Self(err.into())
    }
}

impl IntoResponse for PhysicalInventoryError {
    fn into_response(self) -> Response {
        let err = self.0;
        let msg = err.to_string();
        tracing::error!(error = %err, "Inventory API error");

        let status = if msg.contains("not found") || msg.contains("missing") {
            StatusCode::NOT_FOUND
        } else if msg.contains("permission") || msg.contains("auth") {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::BAD_REQUEST
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
            get(get_session)
                .patch(patch_session)
                .delete(handle_cancel_session),
        )
        .route("/sessions/{id}/counts", post(add_count))
        .route("/sessions/{id}/counts/{count_id}", patch(patch_count))
        .route(
            "/sessions/{id}/counts/{count_id}/accept",
            post(accept_variance),
        )
        .route("/sessions/{id}/review", get(get_review))
        .route("/sessions/{id}/stream", get(get_scan_stream))
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
               started_at, last_saved_at, published_at, notes
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
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_VIEW)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.view permission required"))?;

    let session = sqlx::query_as::<_, physical_inventory::PhysicalInventorySession>(
        r#"
        SELECT id, session_number, status, scope, category_ids,
               started_at, last_saved_at, published_at, notes
        FROM physical_inventory_sessions
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("Session not found"))?;

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
        "#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(json!({ "session": session, "counts": counts })))
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
    Json(payload): Json<AddCountRequest>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;

    // Verify session is open
    let (status, started_at): (String, chrono::DateTime<chrono::Utc>) =
        sqlx::query_as("SELECT status, started_at FROM physical_inventory_sessions WHERE id = $1")
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
        SELECT $1, pv.id, pv.stock_on_hand FROM product_variants pv WHERE pv.id = $2
        ON CONFLICT (session_id, variant_id) DO NOTHING
        "#,
    )
    .bind(id)
    .bind(payload.variant_id)
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
    require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;

    physical_inventory::apply_review_adjustment(
        &state.db,
        session_id,
        count_id,
        body.adjusted_qty,
        body.note,
        None,
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
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_VIEW)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.view permission required"))?;

    let rows = physical_inventory::build_review(&state.db, id).await?;
    let total_counted = rows.len() as i64;
    let total_shrinkage: i32 = rows
        .iter()
        .filter(|r| r.delta < 0)
        .map(|r| r.delta.abs())
        .sum();
    let total_surplus: i32 = rows.iter().filter(|r| r.delta > 0).map(|r| r.delta).sum();
    Ok(Json(json!({
        "rows": rows,
        "summary": {
            "total_counted": total_counted,
            "total_shrinkage": total_shrinkage,
            "total_surplus": total_surplus,
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
        "UPDATE physical_inventory_counts SET review_status = 'confirmed' WHERE id = $1 AND session_id = $2",
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

async fn publish_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    let staff = require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;
    let result = physical_inventory::publish_session(&state.db, id, Some(staff.id)).await?;
    Ok(Json(json!(result)))
}

async fn handle_cancel_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    let staff = require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_MUTATE)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.mutate permission required"))?;

    physical_inventory::cancel_session(&state.db, id, Some(staff.id))
        .await
        .map_err(PhysicalInventoryError::from)?;

    Ok(Json(json!({"status": "cancelled"})))
}

#[derive(sqlx::FromRow)]
struct CountStreamRow {
    id: Uuid,
    scanned_at: chrono::DateTime<chrono::Utc>,
    quantity: i32,
    staff_name: String,
    product_name: String,
    variation_label: Option<String>,
    sku: String,
}

async fn get_scan_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, PhysicalInventoryError> {
    require_staff_with_permission(&state, &headers, PHYSICAL_INVENTORY_VIEW)
        .await
        .map_err(|_| anyhow::anyhow!("physical_inventory.view permission required"))?;

    let rows = sqlx::query_as::<_, CountStreamRow>(
        r#"
        SELECT
            ss.id,
            ss.scanned_at,
            ss.quantity,
            st.first_name || ' ' || st.last_name AS staff_name,
            p.name AS product_name,
            pv.variation_label,
            pv.sku
        FROM inventory_count_scan_stream ss
        JOIN staff st ON st.id = ss.staff_id
        JOIN product_variants pv ON pv.id = ss.variant_id
        JOIN products p ON p.id = pv.product_id
        WHERE ss.session_id = $1
        ORDER BY ss.scanned_at DESC
        LIMIT 100
        "#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await
    .map_err(PhysicalInventoryError::from)?;

    let stream = rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.id,
                "scanned_at": r.scanned_at,
                "quantity": r.quantity,
                "staff_name": r.staff_name,
                "product_name": r.product_name,
                "variation_label": r.variation_label,
                "sku": r.sku,
            })
        })
        .collect::<Vec<_>>();

    Ok(Json(json!({ "stream": stream })))
}
