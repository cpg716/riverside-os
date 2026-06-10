//! Manual Counterpoint Transition Review Pack routes.
//! Mounted under `/api/settings/counterpoint-sync/review-packs`.

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde_json::json;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::SETTINGS_ADMIN;
use crate::logic::counterpoint_review_packs::{
    apply_approved_suggestions, build_review_pack_document, build_review_pack_prompt,
    generate_review_pack, get_review_pack_detail, import_review_results, list_review_packs,
    list_suggestions, supported_scopes, update_suggestion_status, GenerateReviewPackPayload,
    ImportReviewResultsPayload, ReviewPackError, ReviewSuggestionUpdatePayload,
};
use crate::middleware;

fn map_perm(e: (StatusCode, Json<serde_json::Value>)) -> (StatusCode, Json<serde_json::Value>) {
    e
}

fn map_review_pack_error(e: ReviewPackError) -> (StatusCode, Json<serde_json::Value>) {
    match e {
        ReviewPackError::InvalidPayload(message) => {
            (StatusCode::BAD_REQUEST, Json(json!({ "error": message })))
        }
        ReviewPackError::NotFound(message) => {
            (StatusCode::NOT_FOUND, Json(json!({ "error": message })))
        }
        ReviewPackError::UnsafeApply(message) => {
            (StatusCode::CONFLICT, Json(json!({ "error": message })))
        }
        ReviewPackError::Database(err) => {
            tracing::error!(error = %err, "counterpoint review-pack database error");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Internal database error" })),
            )
        }
    }
}

async fn scopes(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    Ok(Json(json!({ "scopes": supported_scopes() })))
}

async fn generate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<GenerateReviewPackPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let pack = generate_review_pack(&state.db, payload, Some(staff.id))
        .await
        .map_err(map_review_pack_error)?;
    Ok(Json(serde_json::to_value(pack).unwrap_or_default()))
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let packs = list_review_packs(&state.db)
        .await
        .map_err(map_review_pack_error)?;
    Ok(Json(json!({ "packs": packs })))
}

async fn detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(pack_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let detail = get_review_pack_detail(&state.db, &pack_id)
        .await
        .map_err(map_review_pack_error)?;
    Ok(Json(serde_json::to_value(detail).unwrap_or_default()))
}

async fn download_json(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(pack_id): Path<String>,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let document = build_review_pack_document(&state.db, &pack_id)
        .await
        .map_err(map_review_pack_error)?;
    let mut response = Json(document).into_response();
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=\"counterpoint-review-pack-{pack_id}.json\""
        ))
        .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    Ok(response)
}

async fn prompt_txt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(pack_id): Path<String>,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let prompt = build_review_pack_prompt(&state.db, &pack_id)
        .await
        .map_err(map_review_pack_error)?;
    let mut response = prompt.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=\"counterpoint-review-pack-{pack_id}-prompt.txt\""
        ))
        .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    Ok(response)
}

async fn import_results(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ImportReviewResultsPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let result = import_review_results(&state.db, payload, Some(staff.id))
        .await
        .map_err(map_review_pack_error)?;
    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}

async fn suggestions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(pack_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let suggestions = list_suggestions(&state.db, &pack_id)
        .await
        .map_err(map_review_pack_error)?;
    Ok(Json(json!({ "suggestions": suggestions })))
}

async fn update_suggestion(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(suggestion_id): Path<Uuid>,
    Json(payload): Json<ReviewSuggestionUpdatePayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let suggestion = update_suggestion_status(&state.db, suggestion_id, payload, Some(staff.id))
        .await
        .map_err(map_review_pack_error)?;
    Ok(Json(serde_json::to_value(suggestion).unwrap_or_default()))
}

async fn apply_approved(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(pack_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_perm)?;
    let result = apply_approved_suggestions(&state.db, &pack_id, Some(staff.id))
        .await
        .map_err(map_review_pack_error)?;
    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/scopes", get(scopes))
        .route("/generate", post(generate))
        .route("/", get(list))
        .route("/import-results", post(import_results))
        .route("/suggestions/{suggestion_id}", patch(update_suggestion))
        .route("/{pack_id}", get(detail))
        .route("/{pack_id}/download.json", get(download_json))
        .route("/{pack_id}/prompt.txt", get(prompt_txt))
        .route("/{pack_id}/suggestions", get(suggestions))
        .route("/{pack_id}/apply-approved", post(apply_approved))
}
