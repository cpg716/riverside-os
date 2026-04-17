use super::helpers::{map_perm_err, register_session_is_open};
use super::TransactionError;
use super::{PagedTransactionsResponse, TransactionListQuery, TransactionPipelineStats};
use crate::api::AppState;
use crate::auth::permissions::ORDERS_VIEW;
use crate::middleware;
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Serialize, FromRow)]
pub struct RefundQueueRow {
    pub id: Uuid,
    pub transaction_id: Uuid,
    pub customer_id: Option<Uuid>,
    pub amount_due: Decimal,
    pub amount_refunded: Decimal,
    pub is_open: bool,
    pub reason: String,
    pub created_at: DateTime<Utc>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_transactions))
        .route("/pipeline-stats", get(get_pipeline_stats))
        .route("/refunds/due", get(list_refunds_due))
        .route("/fulfillment-queue", get(get_fulfillment_queue))
}

async fn list_transactions(
    State(state): State<AppState>,
    Query(q): Query<TransactionListQuery>,
    headers: HeaderMap,
) -> Result<Json<PagedTransactionsResponse>, TransactionError> {
    if let Some(sid) = q.register_session_id {
        if !register_session_is_open(&state.db, sid).await? {
            return Err(TransactionError::Forbidden(
                "register session is not open".to_string(),
            ));
        }
    } else {
        middleware::require_staff_with_permission(&state, &headers, ORDERS_VIEW)
            .await
            .map_err(map_perm_err)?;
    }

    let page = crate::logic::transaction_list::query_paged_transactions(
        &state.db,
        &q,
        state.meilisearch.as_ref(),
    )
    .await
    .map_err(TransactionError::Database)?;
    Ok(Json(page))
}

async fn get_pipeline_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<TransactionPipelineStats>, TransactionError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_VIEW)
        .await
        .map_err(map_perm_err)?;
    let stats = crate::logic::transaction_list::query_pipeline_stats(&state.db)
        .await
        .map_err(TransactionError::Database)?;
    Ok(Json(stats))
}

async fn list_refunds_due(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RefundQueueRow>>, TransactionError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_VIEW)
        .await
        .map_err(map_perm_err)?;
    let rows: Vec<RefundQueueRow> = sqlx::query_as(
        r#"
        SELECT id, transaction_id, customer_id, amount_due, amount_refunded, is_open, reason, created_at
        FROM transaction_refund_queue
        WHERE is_open = TRUE
        ORDER BY created_at DESC
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn get_fulfillment_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<crate::logic::transaction_list::FulfillmentItem>>, TransactionError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_VIEW)
        .await
        .map_err(map_perm_err)?;
    let rows = crate::logic::transaction_list::query_fulfillment_queue(&state.db)
        .await
        .map_err(TransactionError::Database)?;
    Ok(Json(rows))
}
