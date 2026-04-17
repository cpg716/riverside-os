use crate::api::AppState;
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json, Router,
};
use serde_json::json;
use sqlx::Error as SqlxError;
use thiserror::Error;

pub mod helpers;
pub mod list;
pub mod read;
pub mod returns;
pub mod write;

pub use list::RefundQueueRow;
pub use read::{load_transaction_detail, TransactionDetailResponse, TransactionFinancialSummary};
pub use write::{add_transaction_line, checkout, delete_transaction_line, update_transaction_line};

pub use crate::logic::transaction_checkout::{
    CheckoutItem, CheckoutPaymentSplit, CheckoutRequest, CheckoutResponse, WeddingDisbursement,
};
pub use crate::logic::transaction_list::{
    PagedTransactionsResponse, TransactionListQuery, TransactionListResponse,
    TransactionPipelineStats,
};

#[derive(Debug, Error)]
pub enum TransactionError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("Transaction not found")]
    NotFound,
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    BadGateway(String),
}

impl IntoResponse for TransactionError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            TransactionError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            TransactionError::NotFound => {
                (StatusCode::NOT_FOUND, "Transaction not found".to_string())
            }
            TransactionError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            TransactionError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            TransactionError::BadGateway(m) => (StatusCode::BAD_GATEWAY, m),
            TransactionError::Database(e) => {
                if matches!(&e, SqlxError::RowNotFound) {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(json!({ "error": "Transaction not found" })),
                    )
                        .into_response();
                }
                tracing::error!(error = %e, "Database error in transactions");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

impl From<crate::logic::transaction_checkout::CheckoutError> for TransactionError {
    fn from(e: crate::logic::transaction_checkout::CheckoutError) -> Self {
        match e {
            crate::logic::transaction_checkout::CheckoutError::InvalidPayload(m) => {
                TransactionError::InvalidPayload(m)
            }
            crate::logic::transaction_checkout::CheckoutError::Database(d) => {
                TransactionError::Database(d)
            }
        }
    }
}

impl From<crate::logic::suit_component_swap::SuitSwapError> for TransactionError {
    fn from(e: crate::logic::suit_component_swap::SuitSwapError) -> Self {
        use crate::logic::suit_component_swap::SuitSwapError;
        match e {
            SuitSwapError::NotFound => TransactionError::NotFound,
            SuitSwapError::InvalidPayload(m) => TransactionError::InvalidPayload(m),
            SuitSwapError::Inventory(i) => TransactionError::InvalidPayload(i.to_string()),
            SuitSwapError::Database(d) => TransactionError::Database(d),
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(list::router())
        .merge(read::router())
        .merge(write::router())
        .merge(returns::router())
}
