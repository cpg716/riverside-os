//! Fal.ai visual sidecar logic.
//! Handles visual orchestration, authentication, and job status management.

use crate::api::AppState;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum FalError {
    #[error("Fal.ai key not configured (FAL_KEY must be set in environment)")]
    MissingApiKey,
    #[error("Public base URL not configured (RIVERSIDE_PUBLIC_BASE_URL must be set in environment)")]
    MissingBaseUrl,
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Invalid response from Fal.ai: {0}")]
    InvalidResponse(String),
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FalQueueResponse {
    pub request_id: String,
}

/// Dispatches a visual generation task to Fal.ai.
/// Inserts a local record in `fal_generation_jobs`, submits to Fal queue with webhooks,
/// and updates the record with Fal's `request_id`.
pub async fn dispatch_fal_task(
    model_endpoint: &str,
    payload: serde_json::Value,
    job_type: &str,
    target_id: Uuid,
    state: &AppState,
) -> Result<Uuid, FalError> {
    let fal_key = std::env::var("FAL_KEY").map_err(|_| FalError::MissingApiKey)?;
    let base_url = std::env::var("RIVERSIDE_PUBLIC_BASE_URL").map_err(|_| FalError::MissingBaseUrl)?;
    
    // 1. Insert pending job into database to get a local tracking ID
    let job_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO fal_generation_jobs (job_type, target_id, status)
        VALUES ($1, $2, 'pending')
        RETURNING id
        "#
    )
    .bind(job_type)
    .bind(target_id)
    .fetch_one(&state.db)
    .await?;

    // 2. Build webhook callback URL
    let webhook_url = format!("{}/api/webhooks/fal", base_url.trim_end_matches('/'));

    // 3. Make queue request to Fal.ai
    let queue_url = format!(
        "https://queue.fal.run/{}?fal_webhook={}",
        model_endpoint.trim_start_matches('/'),
        urlencoding::encode(&webhook_url)
    );

    tracing::info!(
        job_id = %job_id,
        endpoint = %model_endpoint,
        webhook = %webhook_url,
        "Dispatching visual sidecar job to Fal.ai"
    );

    let response = state.http_client
        .post(&queue_url)
        .header("Authorization", format!("Key {}", fal_key))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let err_msg = format!("Fal.ai error ({}): {}", status, body);
        tracing::error!(job_id = %job_id, error = %err_msg, "Fal.ai queue submission failed");

        sqlx::query(
            "UPDATE fal_generation_jobs SET status = 'failed', error_message = $1 WHERE id = $2"
        )
        .bind(&err_msg)
        .bind(job_id)
        .execute(&state.db)
        .await?;

        return Err(FalError::InvalidResponse(err_msg));
    }

    let fal_res: FalQueueResponse = response.json().await.map_err(|e| {
        FalError::InvalidResponse(format!("failed to parse request_id: {e}"))
    })?;

    let pending_job_id = fal_res.request_id;

    // 4. Update job to processing state with the Fal.ai task id
    sqlx::query(
        r#"
        UPDATE fal_generation_jobs
        SET pending_job_id = $1, status = 'processing'
        WHERE id = $2
        "#
    )
    .bind(&pending_job_id)
    .bind(job_id)
    .execute(&state.db)
    .await?;

    tracing::info!(
        job_id = %job_id,
        pending_job_id = %pending_job_id,
        "Fal.ai job queued successfully"
    );

    Ok(job_id)
}
