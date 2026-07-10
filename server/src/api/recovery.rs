use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::REGISTER_REPORTS;
use crate::middleware::{self, StaffOrPosSession};

const MAX_RECOVERY_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
enum RecoveryError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("recovery job not found")]
    NotFound,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

impl IntoResponse for RecoveryError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            Self::Unauthorized(message) => (StatusCode::UNAUTHORIZED, message),
            Self::Forbidden(message) => (StatusCode::FORBIDDEN, message),
            Self::NotFound => (StatusCode::NOT_FOUND, "recovery job not found".to_string()),
            Self::Database(error) => {
                tracing::error!(error = %error, "operational recovery database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

fn map_auth_error(error: (StatusCode, Json<Value>)) -> RecoveryError {
    let (status, Json(body)) = error;
    let message = body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("not authorized")
        .to_string();
    match status {
        StatusCode::UNAUTHORIZED => RecoveryError::Unauthorized(message),
        StatusCode::FORBIDDEN => RecoveryError::Forbidden(message),
        _ => RecoveryError::BadRequest(message),
    }
}

async fn require_recovery_caller(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<StaffOrPosSession, RecoveryError> {
    if let Some((session_id, token, station_key)) =
        crate::auth::pos_session::pos_session_headers(headers)
    {
        return match crate::auth::pos_session::verify_pos_session_token(
            &state.db,
            session_id,
            &token,
            &station_key,
        )
        .await
        {
            Ok(true) => Ok(StaffOrPosSession::PosSession { session_id }),
            Ok(false) => Err(RecoveryError::Unauthorized(
                "invalid or expired register session token".to_string(),
            )),
            Err(error) => {
                tracing::error!(%error, "recovery register session verification failed");
                Err(RecoveryError::Database(error))
            }
        };
    }
    middleware::require_staff_or_pos_register_session(state, headers)
        .await
        .map_err(map_auth_error)
}

#[derive(Debug, Deserialize)]
struct UpsertRecoveryJob {
    client_job_key: String,
    kind: String,
    status: String,
    register_session_id: Option<Uuid>,
    transaction_id: Option<Uuid>,
    checkout_client_id: Option<Uuid>,
    label: Option<String>,
    payload: Value,
    last_error: Option<String>,
    attempt_count: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct ResolveRecoveryJob {
    status: String,
    resolution_note: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct RecoveryJob {
    client_job_key: String,
    kind: String,
    status: String,
    register_session_id: Option<Uuid>,
    transaction_id: Option<Uuid>,
    checkout_client_id: Option<Uuid>,
    station_key: Option<String>,
    label: Option<String>,
    payload: Value,
    last_error: Option<String>,
    attempt_count: i32,
    first_seen_at: chrono::DateTime<chrono::Utc>,
    last_seen_at: chrono::DateTime<chrono::Utc>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_recovery_jobs).post(upsert_recovery_job))
        .route("/{client_job_key}", patch(resolve_recovery_job))
}

fn header_text(headers: &HeaderMap, name: &'static str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn validate_kind(kind: &str) -> Result<&str, RecoveryError> {
    match kind {
        "checkout_offline" | "checkout_unconfirmed" | "pickup_after_payment" | "receipt_print" => {
            Ok(kind)
        }
        _ => Err(RecoveryError::BadRequest(
            "unsupported recovery job kind".to_string(),
        )),
    }
}

fn validate_open_status(status: &str) -> Result<&str, RecoveryError> {
    match status {
        "pending" | "blocked" => Ok(status),
        _ => Err(RecoveryError::BadRequest(
            "recovery status must be pending or blocked".to_string(),
        )),
    }
}

async fn upsert_recovery_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<UpsertRecoveryJob>,
) -> Result<Json<RecoveryJob>, RecoveryError> {
    let caller = require_recovery_caller(&state, &headers).await?;
    let client_job_key = request.client_job_key.trim();
    if client_job_key.is_empty() || client_job_key.len() > 200 {
        return Err(RecoveryError::BadRequest(
            "client_job_key must contain 1 to 200 characters".to_string(),
        ));
    }
    let kind = validate_kind(request.kind.trim())?;
    let status = validate_open_status(request.status.trim())?;
    if serde_json::to_vec(&request.payload)
        .map_err(|_| RecoveryError::BadRequest("invalid recovery payload".to_string()))?
        .len()
        > MAX_RECOVERY_PAYLOAD_BYTES
    {
        return Err(RecoveryError::BadRequest(
            "recovery payload exceeds 2 MiB".to_string(),
        ));
    }
    let register_session_id = match caller {
        StaffOrPosSession::PosSession { session_id } => {
            if request
                .register_session_id
                .is_some_and(|id| id != session_id)
            {
                return Err(RecoveryError::Forbidden(
                    "register session does not match authenticated session".to_string(),
                ));
            }
            Some(session_id)
        }
        StaffOrPosSession::Staff(_) => request.register_session_id,
    };
    let station_key = header_text(&headers, "x-riverside-station-key");
    let attempt_count = request.attempt_count.unwrap_or(0).max(0);
    let row = sqlx::query_as(
        r#"
        INSERT INTO operational_recovery_job (
            client_job_key, kind, status, register_session_id, transaction_id,
            checkout_client_id, station_key, label, payload, last_error, attempt_count
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (client_job_key) DO UPDATE SET
            kind = EXCLUDED.kind,
            status = CASE
                WHEN operational_recovery_job.status IN ('resolved', 'dismissed')
                    THEN operational_recovery_job.status
                ELSE EXCLUDED.status
            END,
            register_session_id = COALESCE(EXCLUDED.register_session_id, operational_recovery_job.register_session_id),
            transaction_id = COALESCE(EXCLUDED.transaction_id, operational_recovery_job.transaction_id),
            checkout_client_id = COALESCE(EXCLUDED.checkout_client_id, operational_recovery_job.checkout_client_id),
            station_key = COALESCE(EXCLUDED.station_key, operational_recovery_job.station_key),
            label = EXCLUDED.label,
            payload = EXCLUDED.payload,
            last_error = EXCLUDED.last_error,
            attempt_count = GREATEST(operational_recovery_job.attempt_count, EXCLUDED.attempt_count),
            last_seen_at = now()
        RETURNING client_job_key, kind, status, register_session_id, transaction_id,
                  checkout_client_id, station_key, label, payload, last_error, attempt_count,
                  first_seen_at, last_seen_at
        "#,
    )
    .bind(client_job_key)
    .bind(kind)
    .bind(status)
    .bind(register_session_id)
    .bind(request.transaction_id)
    .bind(request.checkout_client_id)
    .bind(station_key)
    .bind(request.label.as_deref().map(str::trim).filter(|v| !v.is_empty()))
    .bind(request.payload)
    .bind(
        request
            .last_error
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(attempt_count)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(row))
}

async fn list_recovery_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RecoveryJob>>, RecoveryError> {
    let caller = require_recovery_caller(&state, &headers).await?;
    let rows = match caller {
        StaffOrPosSession::PosSession { session_id } => {
            sqlx::query_as(
                r#"
                SELECT client_job_key, kind, status, register_session_id, transaction_id,
                       checkout_client_id, station_key, label, payload, last_error, attempt_count,
                       first_seen_at, last_seen_at
                FROM operational_recovery_job
                WHERE status IN ('pending', 'blocked')
                  AND register_session_id IN (
                      SELECT sibling.id
                      FROM register_sessions current_session
                      JOIN register_sessions sibling
                        ON sibling.till_close_group_id = current_session.till_close_group_id
                      WHERE current_session.id = $1
                  )
                ORDER BY first_seen_at
                "#,
            )
            .bind(session_id)
            .fetch_all(&state.db)
            .await?
        }
        StaffOrPosSession::Staff(_) => {
            middleware::require_staff_with_permission(&state, &headers, REGISTER_REPORTS)
                .await
                .map_err(map_auth_error)?;
            sqlx::query_as(
                r#"
                SELECT client_job_key, kind, status, register_session_id, transaction_id,
                       checkout_client_id, station_key, label, payload, last_error, attempt_count,
                       first_seen_at, last_seen_at
                FROM operational_recovery_job
                WHERE status IN ('pending', 'blocked')
                ORDER BY first_seen_at
                "#,
            )
            .fetch_all(&state.db)
            .await?
        }
    };
    Ok(Json(rows))
}

async fn resolve_recovery_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(client_job_key): Path<String>,
    Json(request): Json<ResolveRecoveryJob>,
) -> Result<StatusCode, RecoveryError> {
    if !matches!(request.status.as_str(), "resolved" | "dismissed") {
        return Err(RecoveryError::BadRequest(
            "resolution status must be resolved or dismissed".to_string(),
        ));
    }
    let caller = require_recovery_caller(&state, &headers).await?;
    let (session_scope, resolved_by_staff_id) = match caller {
        StaffOrPosSession::PosSession { session_id } => (Some(session_id), None),
        StaffOrPosSession::Staff(staff) => {
            middleware::require_staff_with_permission(&state, &headers, REGISTER_REPORTS)
                .await
                .map_err(map_auth_error)?;
            (None, Some(staff.id))
        }
    };
    let result = sqlx::query(
        r#"
        UPDATE operational_recovery_job
        SET status = $2, resolved_at = now(), resolved_by_staff_id = $3,
            resolution_note = $4, last_seen_at = now()
        WHERE client_job_key = $1
          AND (
              $5::uuid IS NULL
              OR register_session_id IN (
                  SELECT sibling.id
                  FROM register_sessions current_session
                  JOIN register_sessions sibling
                    ON sibling.till_close_group_id = current_session.till_close_group_id
                  WHERE current_session.id = $5
              )
          )
          AND status IN ('pending', 'blocked')
        "#,
    )
    .bind(client_job_key)
    .bind(request.status)
    .bind(resolved_by_staff_id)
    .bind(
        request
            .resolution_note
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(session_scope)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(RecoveryError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}
