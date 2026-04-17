// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use super::WeddingError;
use crate::api::AppState;
use crate::auth::permissions::{WEDDINGS_MUTATE, WEDDINGS_VIEW};
use crate::middleware;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use uuid::Uuid;

pub fn spawn_meilisearch_wedding_party(state: &AppState, party_id: Uuid) {
    let ms = state.meilisearch.clone();
    let pool = state.db.clone();
    if let Some(c) = ms {
        tokio::spawn(async move {
            crate::logic::meilisearch_sync::upsert_wedding_party_document(&c, &pool, party_id)
                .await;
        });
    }
}

pub fn spawn_meilisearch_appointment_upsert(state: &AppState, appt_id: Uuid) {
    let state = state.clone();
    crate::logic::meilisearch_sync::spawn_meili(async move {
        if let Some(client) = crate::logic::meilisearch_client::meilisearch_from_env() {
            crate::logic::meilisearch_sync::upsert_appointment_document(
                &client, &state.db, appt_id,
            )
            .await;
        }
    });
}

pub fn resolve_actor(o: Option<String>) -> String {
    o.map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Riverside POS".to_string())
}

pub fn wedding_client_sender(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-wedding-client-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn parse_datetime(s: &str) -> Result<chrono::DateTime<chrono::Utc>, WeddingError> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .or_else(|_| {
            chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").map(|ndt| ndt.and_utc())
        })
        .map_err(|_| WeddingError::BadRequest("Invalid date format".into()))
}

pub fn map_wed_perm(e: (StatusCode, Json<serde_json::Value>)) -> WeddingError {
    let (st, Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match st {
        StatusCode::UNAUTHORIZED => WeddingError::Unauthorized(msg),
        StatusCode::FORBIDDEN => WeddingError::Forbidden(msg),
        _ => WeddingError::BadRequest(msg),
    }
}

pub async fn require_weddings_view(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), WeddingError> {
    middleware::require_staff_with_permission(state, headers, WEDDINGS_VIEW)
        .await
        .map(|_| ())
        .map_err(map_wed_perm)
}

pub async fn require_weddings_mutate(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), WeddingError> {
    middleware::require_staff_with_permission(state, headers, WEDDINGS_MUTATE)
        .await
        .map(|_| ())
        .map_err(map_wed_perm)
}
