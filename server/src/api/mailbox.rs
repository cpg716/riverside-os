//! Operations Mailbox API for first-party store email.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{CUSTOMERS_HUB_EDIT, CUSTOMERS_HUB_VIEW};
use crate::logic::email;
use crate::middleware;

#[derive(Debug, Error)]
pub enum MailboxError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("email error: {0}")]
    Email(#[from] email::EmailError),
}

impl IntoResponse for MailboxError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            MailboxError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            MailboxError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            MailboxError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            MailboxError::Email(email::EmailError::NotConfigured) => (
                StatusCode::BAD_REQUEST,
                "Email is not configured".to_string(),
            ),
            MailboxError::Email(email::EmailError::InvalidPayload(message)) => {
                (StatusCode::BAD_REQUEST, message)
            }
            MailboxError::Email(e) => (StatusCode::BAD_GATEWAY, e.to_string()),
            MailboxError::Database(e) => {
                tracing::error!(error = %e, "mailbox database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

fn map_perm_err(e: (StatusCode, Json<serde_json::Value>)) -> MailboxError {
    let (status, Json(value)) = e;
    let msg = value
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match status {
        StatusCode::UNAUTHORIZED => MailboxError::Unauthorized(msg),
        StatusCode::FORBIDDEN => MailboxError::Forbidden(msg),
        _ => MailboxError::BadRequest(msg),
    }
}

async fn require_perm(
    state: &AppState,
    headers: &HeaderMap,
    permission: &str,
) -> Result<Option<Uuid>, MailboxError> {
    match middleware::require_staff_perm_or_pos_session(state, headers, permission)
        .await
        .map_err(map_perm_err)?
    {
        middleware::StaffOrPosSession::Staff(staff) => Ok(Some(staff.id)),
        middleware::StaffOrPosSession::PosSession { session_id } => {
            let staff_id: Option<Uuid> = sqlx::query_scalar(
                r#"
                SELECT COALESCE(shift_primary_staff_id, opened_by)
                FROM register_sessions
                WHERE id = $1 AND is_open = true
                "#,
            )
            .bind(session_id)
            .fetch_optional(&state.db)
            .await?;
            Ok(staff_id)
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_messages).post(send_message))
        .route("/sync", post(sync_mailbox))
        .route("/signature", get(get_signature).patch(patch_signature))
        .route("/customer/{customer_id}", get(list_customer_messages))
        .route("/{id}", patch(patch_message_state))
}

#[derive(Debug, Deserialize)]
struct PatchMailboxMessageBody {
    folder: Option<String>,
    status: Option<String>,
}

async fn patch_message_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchMailboxMessageBody>,
) -> Result<Json<email::MailboxMessageRow>, MailboxError> {
    require_perm(&state, &headers, CUSTOMERS_HUB_EDIT).await?;
    Ok(Json(
        email::update_mailbox_message_state(
            &state.db,
            id,
            body.folder.as_deref(),
            body.status.as_deref(),
        )
        .await?,
    ))
}

#[derive(Debug, Deserialize)]
struct ListMailboxQuery {
    customer_id: Option<Uuid>,
    unmatched_only: Option<bool>,
    limit: Option<i64>,
}

async fn list_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListMailboxQuery>,
) -> Result<Json<Vec<email::MailboxMessageRow>>, MailboxError> {
    require_perm(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    Ok(Json(
        email::list_mailbox_messages(
            &state.db,
            q.customer_id,
            q.unmatched_only.unwrap_or(false),
            q.limit.unwrap_or(100),
        )
        .await?,
    ))
}

async fn list_customer_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<Vec<email::MailboxMessageRow>>, MailboxError> {
    require_perm(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    Ok(Json(
        email::list_mailbox_messages(&state.db, Some(customer_id), false, 100).await?,
    ))
}

async fn sync_mailbox(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<email::MailboxSyncResult>, MailboxError> {
    require_perm(&state, &headers, CUSTOMERS_HUB_VIEW).await?;
    let summary = email::sync_inbox(&state.db).await?;
    if let Err(error) = email::notify_new_mail(&state.db, &summary).await {
        tracing::warn!(
            target: "email",
            error = %error,
            "Mailbox sync completed but notification fan-out failed"
        );
    }
    Ok(Json(summary))
}

#[derive(Debug, Deserialize)]
struct SendMailboxMessageBody {
    to_email: String,
    subject: String,
    html_body: String,
    #[serde(default)]
    signature_html: Option<String>,
    #[serde(default)]
    reply_to_message_id: Option<Uuid>,
}

async fn send_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SendMailboxMessageBody>,
) -> Result<Json<serde_json::Value>, MailboxError> {
    let staff_id = require_perm(&state, &headers, CUSTOMERS_HUB_EDIT).await?;
    let id = email::send_email_with_reply_context(
        &state.db,
        &body.to_email,
        &body.subject,
        &body.html_body,
        staff_id,
        body.signature_html.as_deref(),
        "outbound",
        body.reply_to_message_id,
    )
    .await?;
    Ok(Json(json!({ "id": id, "status": "sent" })))
}

async fn require_staff_id(state: &AppState, headers: &HeaderMap) -> Result<Uuid, MailboxError> {
    require_perm(state, headers, CUSTOMERS_HUB_EDIT)
        .await?
        .ok_or_else(|| MailboxError::Forbidden("Staff identity is required.".to_string()))
}

async fn get_signature(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, MailboxError> {
    let staff_id = require_staff_id(&state, &headers).await?;
    let signature: Option<String> =
        sqlx::query_scalar("SELECT email_signature FROM staff WHERE id = $1")
            .bind(staff_id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    Ok(Json(
        json!({ "signature_html": signature.unwrap_or_default() }),
    ))
}

#[derive(Debug, Deserialize)]
struct PatchSignatureBody {
    signature_html: String,
}

async fn patch_signature(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PatchSignatureBody>,
) -> Result<Json<serde_json::Value>, MailboxError> {
    let staff_id = require_staff_id(&state, &headers).await?;
    let signature = body.signature_html.trim();
    if signature.len() > 4096 {
        return Err(MailboxError::BadRequest(
            "Signature is too long.".to_string(),
        ));
    }
    sqlx::query("UPDATE staff SET email_signature = $1 WHERE id = $2")
        .bind(if signature.is_empty() {
            None
        } else {
            Some(signature)
        })
        .bind(staff_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "signature_html": signature })))
}
