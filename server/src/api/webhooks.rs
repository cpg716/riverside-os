//! Unauthenticated inbound webhooks (Podium, etc.).

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde_json::Value;

use std::sync::Arc;

use crate::api::AppState;
use crate::logic::podium_inbound;
use crate::logic::podium_webhook::{
    podium_inbound_crm_ingest_enabled, record_podium_webhook_delivery,
    verify_podium_webhook_headers, PodiumWebhookDisposition, PodiumWebhookVerifyError,
};

async fn post_podium_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let raw = body.as_ref();
    if let Err(e) = verify_podium_webhook_headers(&headers, raw) {
        let status = match e {
            PodiumWebhookVerifyError::SecretRequired | PodiumWebhookVerifyError::BadSignature => {
                StatusCode::UNAUTHORIZED
            }
            PodiumWebhookVerifyError::MissingTimestamp
            | PodiumWebhookVerifyError::MissingSignature
            | PodiumWebhookVerifyError::StaleTimestamp => StatusCode::BAD_REQUEST,
        };
        tracing::warn!(target = "podium_webhook", event = "verify_failed", reason = %e);
        return status.into_response();
    }

    let value: Value = match serde_json::from_slice(raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(target = "podium_webhook", event = "invalid_json", error = %e);
            return StatusCode::BAD_REQUEST.into_response();
        }
    };

    match record_podium_webhook_delivery(&state.db, raw, &value).await {
        Ok(PodiumWebhookDisposition::Duplicate) => {
            tracing::debug!(target = "podium_webhook", event = "duplicate_delivery");
            StatusCode::OK.into_response()
        }
        Ok(PodiumWebhookDisposition::Accepted) => {
            tracing::info!(target = "podium_webhook", event = "delivery_accepted");
            if podium_inbound_crm_ingest_enabled() {
                let pool = state.db.clone();
                let http = state.http_client.clone();
                let cache: Arc<_> = Arc::clone(&state.podium_token_cache);
                let payload = value.clone();
                tokio::spawn(async move {
                    podium_inbound::ingest_from_webhook(&pool, &http, &cache, &payload).await;
                });
            }
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => {
            tracing::error!(target = "podium_webhook", event = "persist_failed", error = %e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new().route("/podium", post(post_podium_webhook))
}
