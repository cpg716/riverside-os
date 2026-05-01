//! Notification center API (inbox, read/complete, admin broadcast).

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::NOTIFICATIONS_BROADCAST;
use crate::logic::notifications::{
    self, fan_out_notification_to_staff_ids, insert_app_notification_deduped,
    mark_read_for_notification_recipients, resolve_broadcast_audience, BroadcastAudience,
    NotificationListMode, SharedReadOutcome,
};
use crate::middleware;

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub include_archived: bool,
    pub mode: Option<String>,
    pub kinds: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    80
}

#[derive(Debug, Deserialize)]
pub struct BroadcastBody {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub audience: BroadcastAudience,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_notifications))
        .route("/unread-count", get(unread_count))
        .route("/health", get(notification_health))
        .route("/broadcast", post(post_broadcast))
        .route(
            "/by-notification/{notification_id}/read-all",
            post(mark_read_all_for_notification),
        )
        .route("/{staff_notification_id}/read", post(mark_read))
        .route("/{staff_notification_id}/complete", post(mark_complete))
        .route("/{staff_notification_id}/archive", post(mark_archive))
}

async fn list_notifications(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<notifications::NotificationListItem>>, Response> {
    let staff = middleware::require_notification_viewer(&state, &headers)
        .await
        .map_err(|e| e.into_response())?;
    let rows = notifications::list_inbox_for_staff(
        &state.db,
        staff.id,
        list_mode_from_query(&q),
        q.kinds.as_deref(),
        q.limit,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "list_inbox_for_staff");
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    })?;
    Ok(Json(rows))
}

fn list_mode_from_query(q: &ListQuery) -> NotificationListMode {
    match q.mode.as_deref().unwrap_or("").trim() {
        "history" => NotificationListMode::History,
        "all" => NotificationListMode::All,
        "inbox" | "" if q.include_archived => NotificationListMode::All,
        "inbox" | "" => NotificationListMode::Inbox,
        _ => NotificationListMode::Inbox,
    }
}

async fn unread_count(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let staff = middleware::require_notification_viewer(&state, &headers)
        .await
        .map_err(|e| e.into_response())?;
    let n = notifications::unread_count_for_staff(&state.db, staff.id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "unread_count_for_staff");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        })?;
    let podium_inbox = notifications::unread_podium_inbox_count_for_staff(&state.db, staff.id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "unread_podium_inbox_count_for_staff");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        })?;
    Ok(Json(json!({
        "unread": n,
        "podium_inbox_unread": podium_inbox
    })))
}

async fn mark_read_all_for_notification(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(nid): axum::extract::Path<Uuid>,
) -> Result<Json<serde_json::Value>, Response> {
    let staff = middleware::require_notification_viewer(&state, &headers)
        .await
        .map_err(|e| e.into_response())?;
    let outcome = mark_read_for_notification_recipients(&state.db, nid, staff.id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "mark_read_for_notification_recipients");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        })?;
    match outcome {
        SharedReadOutcome::NotFound | SharedReadOutcome::NotRecipient => Err((
            StatusCode::NOT_FOUND,
            axum::Json(json!({ "error": "notification not found" })),
        )
            .into_response()),
        SharedReadOutcome::CurrentRecipientOnly(updated) => Ok(Json(json!({
            "ok": true,
            "shared": false,
            "updated": updated
        }))),
        SharedReadOutcome::SharedRecipients(updated) => Ok(Json(json!({
            "ok": true,
            "shared": true,
            "updated": updated
        }))),
    }
}

async fn mark_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(sn_id): axum::extract::Path<Uuid>,
) -> Result<Json<serde_json::Value>, Response> {
    let staff = middleware::require_notification_viewer(&state, &headers)
        .await
        .map_err(|e| e.into_response())?;
    let ok = notifications::mark_read(&state.db, sn_id, staff.id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "mark_read");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        })?;
    if !ok {
        return Err((
            StatusCode::NOT_FOUND,
            axum::Json(json!({ "error": "notification not found" })),
        )
            .into_response());
    }
    Ok(Json(json!({ "ok": true })))
}

async fn mark_complete(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(sn_id): axum::extract::Path<Uuid>,
) -> Result<Json<serde_json::Value>, Response> {
    let staff = middleware::require_notification_viewer(&state, &headers)
        .await
        .map_err(|e| e.into_response())?;
    let ok = notifications::mark_complete(&state.db, sn_id, staff.id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "mark_complete");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        })?;
    if !ok {
        return Err((
            StatusCode::NOT_FOUND,
            axum::Json(json!({ "error": "notification not found" })),
        )
            .into_response());
    }
    Ok(Json(json!({ "ok": true })))
}

async fn mark_archive(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(sn_id): axum::extract::Path<Uuid>,
) -> Result<Json<serde_json::Value>, Response> {
    let staff = middleware::require_notification_viewer(&state, &headers)
        .await
        .map_err(|e| e.into_response())?;
    let ok = notifications::archive_for_staff(&state.db, sn_id, staff.id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "mark_archive");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        })?;
    if !ok {
        return Err((
            StatusCode::NOT_FOUND,
            axum::Json(json!({ "error": "notification not found" })),
        )
            .into_response());
    }
    Ok(Json(json!({ "ok": true })))
}

async fn notification_health(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<notifications::NotificationHealthResponse>, Response> {
    middleware::require_staff_with_permission(&state, &headers, NOTIFICATIONS_BROADCAST)
        .await
        .map_err(|e| e.into_response())?;
    let health = notifications::notification_health(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "notification_health");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        })?;
    Ok(Json(health))
}

async fn post_broadcast(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BroadcastBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let actor =
        middleware::require_staff_with_permission(&state, &headers, NOTIFICATIONS_BROADCAST)
            .await
            .map_err(|e| e.into_response())?;
    let title = body.title.trim();
    if title.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": "title required" })),
        )
            .into_response());
    }
    let audience = BroadcastAudience {
        mode: if body.audience.mode.is_empty() {
            "all_staff".to_string()
        } else {
            body.audience.mode.clone()
        },
        roles: body.audience.roles.clone(),
        staff_ids: body.audience.staff_ids.clone(),
    };
    let mut target = resolve_broadcast_audience(&state.db, &audience)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "resolve_broadcast_audience");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        })?;
    target.sort_unstable();
    target.dedup();
    let audience_json = serde_json::to_value(&audience).unwrap_or(json!({}));
    let nid = insert_app_notification_deduped(
        &state.db,
        "admin_broadcast",
        title,
        body.body.trim(),
        json!({
            "type": "none",
            "broadcast_from": {
                "staff_id": actor.id,
                "full_name": actor.full_name,
                "avatar_key": actor.avatar_key,
            }
        }),
        "admin_broadcast",
        audience_json,
        None,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "insert broadcast");
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    })?
    .ok_or_else(|| {
        tracing::error!("broadcast insert unexpectedly skipped");
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    })?;
    fan_out_notification_to_staff_ids(&state.db, nid, &target)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "fan_out broadcast");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        })?;
    let _ = crate::auth::pins::log_staff_access(
        &state.db,
        actor.id,
        "notification_broadcast",
        json!({ "notification_id": nid, "recipients": target.len() }),
    )
    .await;
    Ok(Json(
        json!({ "notification_id": nid, "recipients": target.len() }),
    ))
}
