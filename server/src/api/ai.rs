//! Internal AI routes for visual generation tasks.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::api::AppState;
use crate::logic::fal_sidecar::{dispatch_fal_task, FalError};
use crate::middleware::require_authenticated_staff_headers;

#[derive(Debug, thiserror::Error)]
pub enum AiApiError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Forbidden")]
    Forbidden,
    #[error("Fal.ai error: {0}")]
    Fal(#[from] FalError),
    #[error("Job not found: {0}")]
    NotFound(Uuid),
}

impl IntoResponse for AiApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            AiApiError::Forbidden => (StatusCode::FORBIDDEN, self.to_string()),
            AiApiError::NotFound(id) => (StatusCode::NOT_FOUND, format!("Job {id} not found")),
            AiApiError::Fal(ref e) => {
                let status = match e {
                    FalError::MissingApiKey | FalError::MissingBaseUrl => {
                        StatusCode::INTERNAL_SERVER_ERROR
                    }
                    FalError::Http(_) => StatusCode::BAD_GATEWAY,
                    FalError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
                    FalError::InvalidResponse(_) => StatusCode::BAD_GATEWAY,
                };
                (status, e.to_string())
            }
            AiApiError::Database(ref e) => {
                tracing::error!(error = %e, "Database error in AI API");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal database error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

#[derive(Debug, Deserialize)]
pub struct DispatchFalRequest {
    pub model_endpoint: String,
    pub payload: serde_json::Value,
    pub job_type: String,
    pub target_id: Uuid,
}

#[derive(Debug, Serialize)]
pub struct DispatchFalResponse {
    pub ok: bool,
    pub job_id: Uuid,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct FalJobStatusResponse {
    pub id: Uuid,
    pub job_type: String,
    pub target_id: Uuid,
    pub pending_job_id: Option<String>,
    pub local_asset_path: Option<String>,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub completed_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// POST /api/ai/visual/dispatch
/// Dispatches a visual generation job to Fal.ai.
async fn dispatch_visual_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<DispatchFalRequest>,
) -> Result<Json<DispatchFalResponse>, AiApiError> {
    // Require staff authentication
    let _staff = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| AiApiError::Forbidden)?;

    let job_id = dispatch_fal_task(
        &req.model_endpoint,
        req.payload,
        &req.job_type,
        req.target_id,
        &state,
    )
    .await?;

    Ok(Json(DispatchFalResponse { ok: true, job_id }))
}

/// GET /api/ai/visual/status/{job_id}
/// Retrieves the status of a visual generation job.
async fn get_visual_job_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
) -> Result<Json<FalJobStatusResponse>, AiApiError> {
    // Require staff authentication
    let _staff = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| AiApiError::Forbidden)?;

    let job: Option<FalJobStatusResponse> = sqlx::query_as(
        r#"
        SELECT id, job_type, target_id, pending_job_id, local_asset_path, status, error_message, created_at, completed_at
        FROM fal_generation_jobs
        WHERE id = $1
        "#
    )
    .bind(job_id)
    .fetch_optional(&state.db)
    .await?;

    match job {
        Some(j) => Ok(Json(j)),
        None => Err(AiApiError::NotFound(job_id)),
    }
}

/// GET /api/ai/visual/jobs
/// Lists visual generation jobs.
async fn list_visual_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<FalJobStatusResponse>>, AiApiError> {
    let _staff = require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|_| AiApiError::Forbidden)?;

    let jobs: Vec<FalJobStatusResponse> = sqlx::query_as(
        r#"
        SELECT id, job_type, target_id, pending_job_id, local_asset_path, status, error_message, created_at, completed_at
        FROM fal_generation_jobs
        ORDER BY created_at DESC
        LIMIT 50
        "#
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(jobs))
}

async fn get_fal_health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let health = crate::logic::fal_sidecar::health_check(&state.http_client).await;
    Json(json!({
        "configured": health.configured,
        "reachable": health.reachable,
        "latency_ms": health.latency_ms,
        "message": health.message,
    }))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/visual/dispatch", post(dispatch_visual_job))
        .route("/visual/status/{job_id}", get(get_visual_job_status))
        .route("/visual/jobs", get(list_visual_jobs))
        .route("/fal-health", get(get_fal_health))
}
