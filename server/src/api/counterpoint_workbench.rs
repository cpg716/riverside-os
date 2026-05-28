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
    apply_suggestions, approve_step, assign_skus, build_ai_prompt, fetch_ai_review_items,
    get_data_sources_health, get_merge_preview, get_sku_gaps, get_workbench_state,
    import_cp_csv_reference, reset_workbench, suggest_next_b_sku, AiReviewRequest,
    AiReviewResponse, ApplySuggestionsPayload, ApproveStepPayload, CpCsvReferenceImportPayload,
    SkuAssignmentPayload, WorkbenchError,
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

// ── POST /upload-cp-csv ─────────────────────────────────────────────────────

async fn workbench_upload_cp_csv(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CpCsvReferenceImportPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;

    let result = import_cp_csv_reference(&state.db, payload)
        .await
        .map_err(map_workbench_err)?;

    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}

// ── GET /merge-preview ──────────────────────────────────────────────────────

async fn workbench_merge_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;

    let limit = params
        .get("limit")
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(100)
        .min(500);

    let preview = get_merge_preview(&state.db, limit).await.map_err(map_db)?;
    Ok(Json(serde_json::to_value(preview).unwrap_or_default()))
}

// ── POST /ai-review ─────────────────────────────────────────────────────────

async fn workbench_ai_review(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AiReviewRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;

    let items = fetch_ai_review_items(&state.db, &payload.scope, payload.limit)
        .await
        .map_err(map_db)?;

    if items.is_empty() {
        return Ok(Json(
            serde_json::to_value(AiReviewResponse {
                scope: payload.scope,
                items_sent: 0,
                ai_available: false,
                suggestions: json!([]),
                error: Some("No items need review for this scope.".into()),
            })
            .unwrap_or_default(),
        ));
    }

    // Fetch category list for category scope
    let category_list: Vec<String> = if payload.scope == "categories" {
        sqlx::query_scalar("SELECT name FROM categories ORDER BY name")
            .fetch_all(&state.db)
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let prompt = build_ai_prompt(&payload.scope, &items, &category_list);
    let items_sent = items.len();

    // Try to call Gemma via RIVERSIDE_LLAMA_UPSTREAM
    let upstream_url = std::env::var("RIVERSIDE_LLAMA_UPSTREAM").ok();
    let Some(upstream) = upstream_url else {
        return Ok(Json(
            serde_json::to_value(AiReviewResponse {
                scope: payload.scope,
                items_sent,
                ai_available: false,
                suggestions: json!([]),
                error: Some(
                    "RIVERSIDE_LLAMA_UPSTREAM not configured. AI review unavailable.".into(),
                ),
            })
            .unwrap_or_default(),
        ));
    };

    let llm_payload = json!({
        "model": "local",
        "messages": [
            { "role": "system", "content": "You are ROSIE, the Riverside OS AI inventory specialist. Analyze product data and return clean JSON suggestions. Always return valid JSON arrays only." },
            { "role": "user", "content": prompt }
        ],
        "temperature": 0.2,
        "max_tokens": 4096
    });

    let resp = state
        .http_client
        .post(format!("{upstream}/v1/chat/completions"))
        .json(&llm_payload)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            let data: serde_json::Value = r.json().await.unwrap_or_default();
            let content = data
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("[]");

            // Try to parse AI response as JSON
            let suggestions: serde_json::Value =
                serde_json::from_str(content).unwrap_or_else(|_| json!({ "raw": content }));

            Ok(Json(
                serde_json::to_value(AiReviewResponse {
                    scope: payload.scope,
                    items_sent,
                    ai_available: true,
                    suggestions,
                    error: None,
                })
                .unwrap_or_default(),
            ))
        }
        Ok(r) => {
            let status = r.status();
            Ok(Json(
                serde_json::to_value(AiReviewResponse {
                    scope: payload.scope,
                    items_sent,
                    ai_available: true,
                    suggestions: json!([]),
                    error: Some(format!("Gemma returned HTTP {status}")),
                })
                .unwrap_or_default(),
            ))
        }
        Err(e) => Ok(Json(
            serde_json::to_value(AiReviewResponse {
                scope: payload.scope,
                items_sent,
                ai_available: false,
                suggestions: json!([]),
                error: Some(format!("Could not reach Gemma: {e}")),
            })
            .unwrap_or_default(),
        )),
    }
}

// ── POST /apply-suggestions ──────────────────────────────────────────────────

async fn workbench_apply_suggestions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ApplySuggestionsPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;

    let result = apply_suggestions(&state.db, payload)
        .await
        .map_err(map_workbench_err)?;

    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}

// ── GET /data-sources-health ─────────────────────────────────────────────────

async fn workbench_data_sources_health(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;

    let health = get_data_sources_health(&state.db).await.map_err(map_db)?;
    Ok(Json(serde_json::to_value(health).unwrap_or_default()))
}

// ── Lightspeed CSV staff-gated upload (proxies to existing logic) ────────────

async fn workbench_upload_lightspeed_csv(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<
        crate::logic::counterpoint_sync::LightspeedNormalizationReferenceImportPayload,
    >,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;

    crate::logic::counterpoint_sync::import_lightspeed_normalization_reference(&state.db, payload)
        .await
        .map(|report| Json(serde_json::to_value(report).unwrap_or_default()))
        .map_err(|e| {
            tracing::error!(error = %e, "workbench lightspeed CSV upload failed");
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string() })),
            )
        })
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
        .route("/upload-cp-csv", post(workbench_upload_cp_csv))
        .route(
            "/upload-lightspeed-csv",
            post(workbench_upload_lightspeed_csv),
        )
        .route("/merge-preview", get(workbench_merge_preview))
        .route("/ai-review", post(workbench_ai_review))
        .route("/apply-suggestions", post(workbench_apply_suggestions))
        .route("/data-sources-health", get(workbench_data_sources_health))
}
