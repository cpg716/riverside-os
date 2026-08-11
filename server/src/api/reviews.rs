//! Operations: Podium review invite tracking (see `logic/podium_reviews.rs`).

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;

use crate::api::AppState;
use crate::auth::permissions::{REVIEWS_MANAGE, REVIEWS_VIEW};
use crate::logic::podium_reviews::{self, ReviewInviteListRow};
use crate::middleware;

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
}

#[derive(Debug, Deserialize)]
struct CancelReviewInviteBody {
    reason: String,
}

#[derive(Debug, Deserialize)]
struct TestReviewInviteBody {
    phone: String,
    first_name: Option<String>,
}

fn default_limit() -> i64 {
    80
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/invite-rows", get(list_review_invite_rows))
        .route("/sync", post(post_sync_review_invites))
        .route("/test-invite", post(post_test_review_invite))
        .route(
            "/invite-rows/{transaction_id}/retry",
            post(post_retry_review_invite),
        )
        .route(
            "/invite-rows/{transaction_id}/cancel",
            post(post_cancel_review_invite),
        )
}

async fn post_test_review_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<TestReviewInviteBody>,
) -> Result<Json<podium_reviews::ReviewInviteTestResult>, Response> {
    let staff = middleware::require_staff_with_permission(&state, &headers, REVIEWS_MANAGE)
        .await
        .map_err(|e| e.into_response())?;
    if crate::logic::podium::normalize_phone_e164(&body.phone).is_none() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            axum::Json(json!({
                "error": "Enter a valid US or Canadian mobile number."
            })),
        )
            .into_response());
    }
    let first_name = body.first_name.as_deref().map(str::trim);
    if first_name.is_some_and(|value| value.chars().count() > 80) {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": "First name cannot exceed 80 characters." })),
        )
            .into_response());
    }

    podium_reviews::send_test_review_invite(
        &state.db,
        &state.http_client,
        &state.podium_token_cache,
        staff.id,
        &body.phone,
        first_name,
    )
    .await
    .map(Json)
    .map_err(|error| {
        tracing::error!(%error, staff_id = %staff.id, "send_test_review_invite");
        (
            axum::http::StatusCode::BAD_GATEWAY,
            axum::Json(json!({ "error": error.to_string() })),
        )
            .into_response()
    })
}

async fn post_cancel_review_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(transaction_id): Path<uuid::Uuid>,
    Json(body): Json<CancelReviewInviteBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let staff = middleware::require_staff_with_permission(&state, &headers, REVIEWS_MANAGE)
        .await
        .map_err(|e| e.into_response())?;
    let reason = body.reason.trim();
    if !(12..=500).contains(&reason.chars().count()) {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            axum::Json(json!({
                "error": "Enter a cancellation reason between 12 and 500 characters."
            })),
        )
            .into_response());
    }

    let cancelled =
        podium_reviews::cancel_scheduled_review_invite(&state.db, transaction_id, staff.id, reason)
            .await
            .map_err(|error| {
                tracing::error!(%error, %transaction_id, "cancel_scheduled_review_invite");
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(json!({ "error": "database" })),
                )
                    .into_response()
            })?;
    if !cancelled {
        return Err((
            axum::http::StatusCode::CONFLICT,
            axum::Json(json!({
                "error": "This review request is no longer waiting to be sent. Refresh the Outbox."
            })),
        )
            .into_response());
    }

    Ok(Json(json!({ "ok": true, "status": "cancelled" })))
}

async fn post_retry_review_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(transaction_id): Path<uuid::Uuid>,
) -> Result<Json<serde_json::Value>, Response> {
    middleware::require_staff_with_permission(&state, &headers, REVIEWS_VIEW)
        .await
        .map_err(|e| e.into_response())?;
    let rescheduled = podium_reviews::reschedule_failed_review_invite(&state.db, transaction_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, %transaction_id, "reschedule_failed_review_invite");
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({ "error": "database" })),
            )
                .into_response()
        })?;
    if !rescheduled {
        return Err((
            axum::http::StatusCode::CONFLICT,
            axum::Json(json!({ "error": "Review request is not in failed status." })),
        )
            .into_response());
    }
    Ok(Json(json!({ "ok": true, "status": "scheduled" })))
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
