//! API routes for the Inventory Migration Workbench.
//! Staff-gated, mounted under `/api/settings/counterpoint-sync/workbench`.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, patch, post},
    Json, Router,
};
use serde_json::json;

use crate::api::AppState;
use crate::logic::counterpoint_workbench::{
    approve_step, assign_skus, get_sku_gaps, get_workbench_state, reset_workbench,
    suggest_next_b_sku, ApproveStepPayload, SkuAssignmentPayload, WorkbenchError,
};
use crate::middleware;

const SETTINGS_ADMIN: &str = "settings.admin";

fn map_perm(e: (StatusCode, Json<serde_json::Value>)) -> (StatusCode, Json<serde_json::Value>) {
    e
}

fn map_workbench_err(e: WorkbenchError) -> (StatusCode, Json<serde_json::Value>) {
    match &e {
        WorkbenchError::InvalidStep(_) | WorkbenchError::InvalidPayload(_) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        ),
        WorkbenchError::StepLocked(_) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": e.to_string() })),
        ),
        WorkbenchError::AlreadyApproved(_) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": e.to_string() })),
        ),
        WorkbenchError::PrerequisiteMissing(_) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": e.to_string() })),
        ),
        WorkbenchError::Database(d) => {
            tracing::error!(error = %d, "workbench database error");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Internal database error" })),
            )
        }
    }
}

fn map_db(e: sqlx::Error) -> (StatusCode, Json<serde_json::Value>) {
    tracing::error!(error = %e, "workbench database error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "Internal database error" })),
    )
}

// ── GET /state ──────────────────────────────────────────────────────────────

async fn workbench_state(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;

    let ws = get_workbench_state(&state.db).await.map_err(map_db)?;
    Ok(Json(serde_json::to_value(ws).unwrap_or_default()))
}

// ── POST /approve-step ──────────────────────────────────────────────────────

async fn workbench_approve_step(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ApproveStepPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;

    let result = approve_step(&state.db, &payload.step, staff.id)
        .await
        .map_err(map_workbench_err)?;

    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}

// ── POST /reset ─────────────────────────────────────────────────────────────

async fn workbench_reset(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;

    reset_workbench(&state.db).await.map_err(map_db)?;
    Ok(Json(json!({ "reset": true })))
}

// ── GET /sku-gaps ───────────────────────────────────────────────────────────

async fn workbench_sku_gaps(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;

    let report = get_sku_gaps(&state.db).await.map_err(map_db)?;
    Ok(Json(serde_json::to_value(report).unwrap_or_default()))
}

// ── PATCH /sku-gaps/assign ──────────────────────────────────────────────────

async fn workbench_sku_assign(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SkuAssignmentPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;

    let result = assign_skus(&state.db, payload)
        .await
        .map_err(map_workbench_err)?;

    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}

// ── GET /sku-gaps/suggest-next?count=N ───────────────────────────────────────

async fn workbench_suggest_next_sku(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;

    let count = params
        .get("count")
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(10)
        .min(500);

    let suggestions = suggest_next_b_sku(&state.db, count).await.map_err(map_db)?;
    Ok(Json(json!({ "suggestions": suggestions })))
}

// ── Router ──────────────────────────────────────────────────────────────────

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/state", get(workbench_state))
        .route("/approve-step", post(workbench_approve_step))
        .route("/reset", post(workbench_reset))
        .route("/sku-gaps", get(workbench_sku_gaps))
        .route("/sku-gaps/assign", patch(workbench_sku_assign))
        .route("/sku-gaps/suggest-next", get(workbench_suggest_next_sku))
}
