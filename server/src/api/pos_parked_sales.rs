//! POS parked sales under `/api/sessions/{session_id}/parked-sales/*`.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::logic::pos_parked_sales::{
    create_parked_sale, delete_parked_sale, list_parked_for_session, recall_parked_sale,
    CreateParkedSaleRequest, ParkedSaleRow,
};
use crate::middleware;

#[derive(Debug, Error)]
pub enum ParkedSalesError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("Parked sale not found")]
    NotFound,
}

impl IntoResponse for ParkedSalesError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            ParkedSalesError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            ParkedSalesError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            ParkedSalesError::NotFound => {
                (StatusCode::NOT_FOUND, "Parked sale not found".to_string())
            }
            ParkedSalesError::Database(e) => {
                if matches!(e, sqlx::Error::RowNotFound) {
                    return (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" })))
                        .into_response();
                }
                tracing::error!(error = %e, "parked sales database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

#[derive(Debug, Deserialize)]
pub struct ListParkedQuery {
    #[serde(default)]
    pub customer_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct ActorBody {
    pub actor_staff_id: Uuid,
}

#[derive(Debug, Serialize)]
pub struct ParkedSaleResponse {
    pub id: Uuid,
    pub register_session_id: Uuid,
    pub parked_by_staff_id: Uuid,
    pub customer_id: Option<Uuid>,
    pub label: String,
    pub payload_json: serde_json::Value,
    pub status: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

impl From<ParkedSaleRow> for ParkedSaleResponse {
    fn from(r: ParkedSaleRow) -> Self {
        ParkedSaleResponse {
            id: r.id,
            register_session_id: r.register_session_id,
            parked_by_staff_id: r.parked_by_staff_id,
            customer_id: r.customer_id,
            label: r.label,
            payload_json: r.payload_json,
            status: r.status,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

async fn list_parked(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
    Query(q): Query<ListParkedQuery>,
) -> Result<Json<Vec<ParkedSaleResponse>>, ParkedSalesError> {
    middleware::require_pos_register_session_for_checkout(&state, &headers, session_id)
        .await
        .map_err(|(st, axum::Json(v))| {
            let msg = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("unauthorized")
                .to_string();
            if st == StatusCode::UNAUTHORIZED {
                ParkedSalesError::Unauthorized(msg)
            } else {
                ParkedSalesError::BadRequest(msg)
            }
        })?;

    let rows = list_parked_for_session(&state.db, session_id, q.customer_id)
        .await
        .map_err(ParkedSalesError::Database)?;
    Ok(Json(
        rows.into_iter().map(ParkedSaleResponse::from).collect(),
    ))
}

async fn create_parked(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CreateParkedSaleRequest>,
) -> Result<Json<ParkedSaleResponse>, ParkedSalesError> {
    middleware::require_pos_register_session_for_checkout(&state, &headers, session_id)
        .await
        .map_err(|(st, axum::Json(v))| {
            let msg = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("unauthorized")
                .to_string();
            if st == StatusCode::UNAUTHORIZED {
                ParkedSalesError::Unauthorized(msg)
            } else {
                ParkedSalesError::BadRequest(msg)
            }
        })?;

    if !body.label.trim().is_empty() && body.label.len() > 500 {
        return Err(ParkedSalesError::BadRequest(
            "label too long (max 500)".to_string(),
        ));
    }

    let row = create_parked_sale(&state.db, session_id, body)
        .await
        .map_err(|e| match e {
            sqlx::Error::RowNotFound => ParkedSalesError::NotFound,
            _ => ParkedSalesError::Database(e),
        })?;

    Ok(Json(ParkedSaleResponse::from(row)))
}

async fn recall_parked(
    State(state): State<AppState>,
    Path((session_id, park_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(body): Json<ActorBody>,
) -> Result<StatusCode, ParkedSalesError> {
    middleware::require_pos_register_session_for_checkout(&state, &headers, session_id)
        .await
        .map_err(|(st, axum::Json(v))| {
            let msg = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("unauthorized")
                .to_string();
            if st == StatusCode::UNAUTHORIZED {
                ParkedSalesError::Unauthorized(msg)
            } else {
                ParkedSalesError::BadRequest(msg)
            }
        })?;

    recall_parked_sale(&state.db, session_id, park_id, body.actor_staff_id)
        .await
        .map_err(|e| match e {
            sqlx::Error::RowNotFound => ParkedSalesError::NotFound,
            _ => ParkedSalesError::Database(e),
        })?;

    Ok(StatusCode::NO_CONTENT)
}

async fn delete_parked(
    State(state): State<AppState>,
    Path((session_id, park_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(body): Json<ActorBody>,
) -> Result<StatusCode, ParkedSalesError> {
    middleware::require_pos_register_session_for_checkout(&state, &headers, session_id)
        .await
        .map_err(|(st, axum::Json(v))| {
            let msg = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("unauthorized")
                .to_string();
            if st == StatusCode::UNAUTHORIZED {
                ParkedSalesError::Unauthorized(msg)
            } else {
                ParkedSalesError::BadRequest(msg)
            }
        })?;

    delete_parked_sale(&state.db, session_id, park_id, body.actor_staff_id)
        .await
        .map_err(|e| match e {
            sqlx::Error::RowNotFound => ParkedSalesError::NotFound,
            _ => ParkedSalesError::Database(e),
        })?;

    Ok(StatusCode::NO_CONTENT)
}

/// Routes merged under `/api/sessions` alongside `sessions::router()`.
pub fn session_subrouter() -> Router<AppState> {
    Router::new()
        .route(
            "/{session_id}/parked-sales",
            get(list_parked).post(create_parked),
        )
        .route(
            "/{session_id}/parked-sales/{park_id}/recall",
            post(recall_parked),
        )
        .route(
            "/{session_id}/parked-sales/{park_id}/delete",
            post(delete_parked),
        )
}
