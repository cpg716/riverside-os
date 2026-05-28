//! Customer notification queue API for managing Ready for Pickup messages

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::middleware;

#[derive(Debug, Error)]
pub enum NotificationError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("Not found")]
    NotFound,
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
}

impl IntoResponse for NotificationError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            NotificationError::NotFound => {
                (StatusCode::NOT_FOUND, "Notification not found".to_string())
            }
            NotificationError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            NotificationError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            NotificationError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            NotificationError::Database(e) => {
                tracing::error!(error = %e, "Database error in notifications");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

async fn require_notifications_view(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), NotificationError> {
    middleware::require_staff_with_permission(state, headers, "orders.view")
        .await
        .map(|_| ())
        .map_err(map_perm)
}

async fn require_notifications_manage(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), NotificationError> {
    middleware::require_staff_with_permission(state, headers, "orders.lifecycle_manage")
        .await
        .map(|_| ())
        .map_err(map_perm)
}

fn map_perm(e: (StatusCode, axum::Json<serde_json::Value>)) -> NotificationError {
    let (st, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match st {
        StatusCode::UNAUTHORIZED => NotificationError::Unauthorized(msg),
        StatusCode::FORBIDDEN => NotificationError::Forbidden(msg),
        _ => NotificationError::InvalidPayload(msg),
    }
}

#[derive(Debug, Serialize, FromRow)]
pub struct NotificationQueueRow {
    pub id: Uuid,
    pub entity_type: String,
    pub entity_id: Uuid,
    pub customer_id: Uuid,
    pub kind: String,
    pub status: String,
    pub scheduled_for: Option<DateTime<Utc>>,
    pub sent_at: Option<DateTime<Utc>>,
    pub send_immediately: bool,
    pub override_reason: Option<String>,
    pub delivery_method: Option<String>,
    pub delivery_status: Option<String>,
    pub delivery_error: Option<String>,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub created_by_staff_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct ListNotificationsQuery {
    pub status: Option<String>,
    pub entity_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SendNowRequest {
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct ScheduleBatchRequest {
    pub target_time: String, // ISO 8601 timestamp
}

#[derive(Debug, Serialize)]
pub struct ScheduleBatchResponse {
    pub scheduled_count: i64,
}

#[derive(Debug, Serialize)]
pub struct SendNowResponse {
    pub success: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/notifications/queue", get(list_notifications))
        .route(
            "/notifications/queue/{id}/send-now",
            post(send_notification_now),
        )
        .route("/notifications/queue/schedule-batch", post(schedule_batch))
        .route("/notifications/queue/{id}/skip", post(skip_notification))
}

/// List pending notifications for staff review
async fn list_notifications(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListNotificationsQuery>,
) -> Result<Json<Vec<NotificationQueueRow>>, NotificationError> {
    require_notifications_view(&state, &headers).await?;

    let status_filter = q.status.unwrap_or_else(|| "pending".to_string());
    let entity_type_filter = q.entity_type;

    let rows = if let Some(entity_type) = entity_type_filter {
        sqlx::query_as::<_, NotificationQueueRow>(
            r#"
            SELECT
                id, entity_type, entity_id, customer_id, kind, status,
                scheduled_for, sent_at, send_immediately, override_reason,
                delivery_method, delivery_status, delivery_error, metadata,
                created_at, updated_at, created_by_staff_id
            FROM customer_notification_queue
            WHERE status = $1 AND entity_type = $2
            ORDER BY created_at DESC
            "#,
        )
        .bind(&status_filter)
        .bind(&entity_type)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, NotificationQueueRow>(
            r#"
            SELECT
                id, entity_type, entity_id, customer_id, kind, status,
                scheduled_for, sent_at, send_immediately, override_reason,
                delivery_method, delivery_status, delivery_error, metadata,
                created_at, updated_at, created_by_staff_id
            FROM customer_notification_queue
            WHERE status = $1
            ORDER BY created_at DESC
            "#,
        )
        .bind(&status_filter)
        .fetch_all(&state.db)
        .await?
    };

    Ok(Json(rows))
}

/// Override and send notification immediately
async fn send_notification_now(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<SendNowRequest>,
) -> Result<Json<SendNowResponse>, NotificationError> {
    let staff =
        middleware::require_staff_with_permission(&state, &headers, "orders.lifecycle_manage")
            .await
            .map_err(map_perm)?;

    let success: bool = sqlx::query_scalar("SELECT override_send_immediately($1, $2, $3)")
        .bind(id)
        .bind(&body.reason)
        .bind(staff.id)
        .fetch_one(&state.db)
        .await?;

    if success {
        // Trigger immediate send (this would call the messaging service)
        // For now, just mark as ready for immediate processing
        Ok(Json(SendNowResponse { success: true }))
    } else {
        Ok(Json(SendNowResponse { success: false }))
    }
}

/// Schedule all pending notifications for next batch
async fn schedule_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ScheduleBatchRequest>,
) -> Result<Json<ScheduleBatchResponse>, NotificationError> {
    require_notifications_manage(&state, &headers).await?;

    let target_time: DateTime<Utc> = body
        .target_time
        .parse()
        .map_err(|_| NotificationError::InvalidPayload("Invalid timestamp format".to_string()))?;

    let count: i64 = sqlx::query_scalar("SELECT schedule_pending_notifications($1)")
        .bind(target_time)
        .fetch_one(&state.db)
        .await?;

    Ok(Json(ScheduleBatchResponse {
        scheduled_count: count,
    }))
}

/// Skip a notification (mark as skipped)
async fn skip_notification(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, NotificationError> {
    require_notifications_manage(&state, &headers).await?;

    sqlx::query(
        r#"
        UPDATE customer_notification_queue
        SET status = 'skipped', updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(id)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "status": "skipped" })))
}
