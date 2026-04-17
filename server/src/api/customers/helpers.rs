// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use crate::api::AppState;
use crate::middleware;
use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum CustomerError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Customer search requires at least 2 characters")]
    QueryTooShort,
    #[error("First and last name are required")]
    NameRequired,
    #[error("Customer not found")]
    NotFound,
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    PodiumUnavailable(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    Logic(String),
}

impl IntoResponse for CustomerError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            CustomerError::QueryTooShort => (
                StatusCode::BAD_REQUEST,
                "Customer search requires at least 2 characters".to_string(),
            ),
            CustomerError::NameRequired => (
                StatusCode::BAD_REQUEST,
                "First and last name are required".to_string(),
            ),
            CustomerError::NotFound => (StatusCode::NOT_FOUND, "Customer not found".to_string()),
            CustomerError::Conflict(m) => (StatusCode::CONFLICT, m),
            CustomerError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            CustomerError::PodiumUnavailable(m) => (StatusCode::BAD_GATEWAY, m),
            CustomerError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            CustomerError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            CustomerError::Logic(m) => (StatusCode::BAD_REQUEST, m),
            CustomerError::Database(e) => {
                tracing::error!(error = %e, "Database error in customers");
                let msg = e.to_string();
                if msg.contains("customers_email_key")
                    || (msg.contains("unique constraint") && msg.contains("email"))
                {
                    (
                        StatusCode::CONFLICT,
                        "Email already in use by another customer".to_string(),
                    )
                } else {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Internal server error".to_string(),
                    )
                }
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

pub fn spawn_meilisearch_customer_hooks(state: &AppState, customer_id: Uuid) {
    let ms = state.meilisearch.clone();
    let pool = state.db.clone();
    if let Some(c) = ms {
        tokio::spawn(async move {
            crate::logic::meilisearch_sync::upsert_customer_document(&c, &pool, customer_id).await;
            let Ok(pids): Result<Vec<Uuid>, _> = sqlx::query_scalar(
                "SELECT DISTINCT wm.wedding_party_id FROM wedding_members wm WHERE wm.customer_id = $1",
            )
            .bind(customer_id)
            .fetch_all(&pool)
            .await
            else {
                return;
            };
            for pid in pids {
                crate::logic::meilisearch_sync::upsert_wedding_party_document(&c, &pool, pid).await;
            }
        });
    }
}

pub async fn require_customer_access(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), CustomerError> {
    middleware::require_staff_or_pos_register_session(state, headers)
        .await
        .map(|_| ())
        .map_err(|(_, axum::Json(v))| {
            let msg = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("unauthorized")
                .to_string();
            CustomerError::Unauthorized(msg)
        })
}

pub fn map_perm_or_pos_err(
    (status, axum::Json(v)): (StatusCode, axum::Json<serde_json::Value>),
) -> CustomerError {
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("unauthorized")
        .to_string();
    if status == StatusCode::FORBIDDEN {
        CustomerError::Forbidden(msg)
    } else {
        CustomerError::Unauthorized(msg)
    }
}

pub async fn require_customer_perm_or_pos(
    state: &AppState,
    headers: &HeaderMap,
    permission: &str,
) -> Result<(), CustomerError> {
    middleware::require_staff_perm_or_pos_session(state, headers, permission)
        .await
        .map(|_| ())
        .map_err(map_perm_or_pos_err)
}

pub async fn staff_id_from_customer_perm_or_pos(
    state: &AppState,
    headers: &HeaderMap,
    permission: &str,
) -> Result<Option<Uuid>, CustomerError> {
    match middleware::require_staff_perm_or_pos_session(state, headers, permission)
        .await
        .map_err(map_perm_or_pos_err)?
    {
        middleware::StaffOrPosSession::Staff(s) => Ok(Some(s.id)),
        middleware::StaffOrPosSession::PosSession { .. } => Ok(None),
    }
}
