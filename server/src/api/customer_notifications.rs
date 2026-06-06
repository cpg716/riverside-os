//! Customer notification center API for customer-facing SMS/email tracking.

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
use crate::logic::messaging::MessagingService;
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
    middleware::require_authenticated_staff_headers(state, headers)
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
    pub reviewed_at: Option<DateTime<Utc>>,
    pub reviewed_by_staff_id: Option<Uuid>,
    pub review_note: Option<String>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub customer_email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListNotificationsQuery {
    pub status: Option<String>,
    pub entity_type: Option<String>,
    pub include_reviewed: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct SendNowRequest {
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct ScheduleBatchRequest {
    pub target_time: String, // ISO 8601 timestamp
}

#[derive(Debug, Deserialize)]
pub struct ReviewNotificationRequest {
    pub note: Option<String>,
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
        .route(
            "/notifications/queue/{id}/review",
            post(review_notification),
        )
}

/// List customer notifications for staff review.
async fn list_notifications(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListNotificationsQuery>,
) -> Result<Json<Vec<NotificationQueueRow>>, NotificationError> {
    require_notifications_view(&state, &headers).await?;

    let status_filter = q.status.unwrap_or_else(|| "all".to_string());
    let entity_type_filter = q.entity_type.unwrap_or_else(|| "all".to_string());
    let include_reviewed = q.include_reviewed.unwrap_or(false);

    let rows = sqlx::query_as::<_, NotificationQueueRow>(
        r#"
        SELECT
            cnq.id, cnq.entity_type, cnq.entity_id, cnq.customer_id, cnq.kind, cnq.status,
            cnq.scheduled_for, cnq.sent_at, cnq.send_immediately, cnq.override_reason,
            cnq.delivery_method, cnq.delivery_status, cnq.delivery_error, cnq.metadata,
            cnq.created_at, cnq.updated_at, cnq.created_by_staff_id,
            cnq.reviewed_at, cnq.reviewed_by_staff_id, cnq.review_note,
            NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
            c.phone AS customer_phone,
            c.email AS customer_email
        FROM customer_notification_queue cnq
        LEFT JOIN customers c ON c.id = cnq.customer_id
        WHERE ($1 = 'all' OR cnq.status = $1)
          AND ($2 = 'all' OR cnq.entity_type = $2)
          AND ($3 OR cnq.reviewed_at IS NULL)
        ORDER BY
          CASE WHEN cnq.delivery_status = 'failed' OR cnq.status = 'failed' THEN 0 WHEN cnq.status IN ('pending', 'scheduled') THEN 1 ELSE 2 END,
          COALESCE(cnq.sent_at, cnq.scheduled_for, cnq.created_at) DESC
        LIMIT 500
        "#,
    )
    .bind(&status_filter)
    .bind(&entity_type_filter)
    .bind(include_reviewed)
    .fetch_all(&state.db)
    .await?;

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

    if !success {
        return Ok(Json(SendNowResponse { success: false }));
    }

    let row: Option<(String, Uuid, Uuid, String)> = sqlx::query_as(
        r#"
        SELECT entity_type, entity_id, customer_id, kind
        FROM customer_notification_queue
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;

    if let Some((entity_type, entity_id, customer_id, kind)) = row {
        let result = match (entity_type.as_str(), kind.as_str()) {
            ("order", "ready_for_pickup") => {
                MessagingService::trigger_ready_for_pickup(
                    &state.db,
                    &state.http_client,
                    &state.podium_token_cache,
                    entity_id,
                    customer_id,
                )
                .await
            }
            ("alteration", "ready_for_pickup") => {
                MessagingService::trigger_alteration_ready(
                    &state.db,
                    &state.http_client,
                    &state.podium_token_cache,
                    customer_id,
                    entity_id,
                )
                .await
            }
            _ => Ok(()),
        };
        let delivery_status = if result.is_ok() {
            "delivered"
        } else {
            "failed"
        };
        let delivery_error = result.as_ref().err().map(ToString::to_string);
        sqlx::query("SELECT mark_notification_sent($1, $2, $3, $4)")
            .bind(id)
            .bind("both")
            .bind(delivery_status)
            .bind(delivery_error.as_deref())
            .execute(&state.db)
            .await?;
    }

    Ok(Json(SendNowResponse { success: true }))
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

/// Mark a customer notification as reviewed so it leaves the active worklist.
async fn review_notification(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<ReviewNotificationRequest>,
) -> Result<Json<serde_json::Value>, NotificationError> {
    let staff = middleware::require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(map_perm)?;

    let result = sqlx::query(
        r#"
        UPDATE customer_notification_queue
        SET reviewed_at = NOW(),
            reviewed_by_staff_id = $2,
            review_note = NULLIF(TRIM($3), ''),
            updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(id)
    .bind(staff.id)
    .bind(body.note.unwrap_or_default())
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(NotificationError::NotFound);
    }

    Ok(Json(json!({ "status": "reviewed" })))
}
