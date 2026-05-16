//! Operations: Podium review invite tracking (see `logic/podium_reviews.rs`).

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;

use crate::api::AppState;
use crate::auth::permissions::REVIEWS_VIEW;
use crate::logic::podium_reviews::{self, ReviewInviteListRow};
use crate::middleware;

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    80
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/invite-rows", get(list_review_invite_rows))
        .route("/sync", post(post_sync_review_invites))
}

async fn list_review_invite_rows(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<ReviewInviteListRow>>, Response> {
    middleware::require_staff_with_permission(&state, &headers, REVIEWS_VIEW)
        .await
        .map_err(|e| e.into_response())?;
    let rows = podium_reviews::list_review_invite_rows(&state.db, q.limit)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "list_review_invite_rows");
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({ "error": "database" })),
            )
                .into_response()
        })?;
    Ok(Json(rows))
}

async fn post_sync_review_invites(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<podium_reviews::ReviewInviteSyncResult>, Response> {
    middleware::require_staff_with_permission(&state, &headers, REVIEWS_VIEW)
        .await
        .map_err(|e| e.into_response())?;
    let result = podium_reviews::sync_review_invites_from_podium(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        100,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "sync_review_invites_from_podium");
        (
            axum::http::StatusCode::BAD_GATEWAY,
            axum::Json(json!({ "error": e.to_string() })),
        )
            .into_response()
    })?;
    Ok(Json(result))
}
