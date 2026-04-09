//! Operations: Podium review invite tracking (see `logic/podium_reviews.rs`).

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
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
    Router::new().route("/invite-rows", get(list_review_invite_rows))
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
