// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use crate::api::AppState;
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json, Router,
};
use serde_json::json;
use thiserror::Error;

pub mod appointments;
pub mod events;
pub mod feed;
pub mod helpers;
pub mod items;
pub mod members;
pub mod parties;

pub use crate::logic::wedding_api_types::{
    ActionRow, ActivityFeedRow, AppointmentRow, PaginatedParties, Pagination, PartyListQuery,
    WeddingActions, WeddingLedgerLine, WeddingLedgerResponse, WeddingLedgerSummary,
    WeddingMemberApi, WeddingMemberFinancialRow, WeddingNonInventoryItem,
    WeddingPartyFinancialContext, WeddingPartyRow, WeddingPartyWithMembers,
};

#[derive(Debug, Error)]
pub enum WeddingError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Wedding party not found")]
    PartyNotFound,
    #[error("Wedding member not found")]
    MemberNotFound,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
}

impl IntoResponse for WeddingError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            WeddingError::PartyNotFound => {
                (StatusCode::NOT_FOUND, "Wedding party not found".to_string())
            }
            WeddingError::MemberNotFound => (
                StatusCode::NOT_FOUND,
                "Wedding member not found".to_string(),
            ),
            WeddingError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            WeddingError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            WeddingError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            WeddingError::Database(e) => {
                tracing::error!(error = %e, "Database error in weddings");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(events::router())
        .merge(feed::router())
        .merge(items::router())
        .merge(appointments::router())
        .merge(parties::router())
        .merge(members::router())
}
