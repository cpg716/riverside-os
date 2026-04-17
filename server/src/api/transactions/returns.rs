use super::helpers::{
    authorize_transaction_modify_bo_or_register, log_order_activity, map_perm_err,
    register_session_is_open,
};
use super::list::RefundQueueRow;
use super::read::{load_transaction_detail, TransactionDetailResponse, TransactionReadQuery};
use super::TransactionError;
use crate::api::AppState;
use crate::auth::permissions::{ORDERS_MODIFY, ORDERS_REFUND_PROCESS};
use crate::logic::gift_card_ops;
use crate::logic::loyalty as loyalty_logic;
use crate::logic::transaction_recalc;
use crate::logic::transaction_returns::{self, ReturnLineInput};
use crate::middleware;
use crate::models::DbTransactionCategory;
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::post,
    Json, Router,
};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::json;
use stripe;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct ProcessRefundRequest {
    pub session_id: Uuid,
    pub payment_method: String,
    pub amount: Decimal,
    #[serde(default)]
    pub gift_card_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PostOrderReturnsRequest {
    pub lines: Vec<OrderReturnLineBody>,
}

#[derive(Debug, Deserialize)]
pub struct OrderReturnLineBody {
    pub transaction_line_id: Uuid,
    pub quantity: i32,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub restock: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct OrderExchangeLinkBody {
    pub other_transaction_id: Uuid,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/{transaction_id}/refunds/process", post(process_refund))
        .route("/{transaction_id}/returns", post(post_transaction_returns))
        .route(
            "/{transaction_id}/exchange-link",
            post(post_transaction_exchange_link),
        )
}

async fn process_refund(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<ProcessRefundRequest>,
) -> Result<Json<serde_json::Value>, TransactionError> {
    middleware::require_staff_with_permission(&state, &headers, ORDERS_REFUND_PROCESS)
        .await
        .map_err(map_perm_err)?;

    if !register_session_is_open(&state.db, body.session_id).await? {
        return Err(TransactionError::InvalidPayload(
            "register session is not open".to_string(),
        ));
    }

    if body.amount <= Decimal::ZERO {
        return Err(TransactionError::InvalidPayload(
            "amount must be positive".to_string(),
        ));
    }

    let method_l = body.payment_method.to_lowercase();

    let mut tx = state.db.begin().await?;
    let row: Option<RefundQueueRow> = sqlx::query_as(
        r#"
        SELECT id, transaction_id, customer_id, amount_due, amount_refunded, is_open, reason, created_at
        FROM transaction_refund_queue
        WHERE transaction_id = $1 AND is_open = TRUE
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(refund) = row else {
        return Err(TransactionError::InvalidPayload(
            "no open refund for this order".to_string(),
        ));
    };
    let remaining = refund.amount_due - refund.amount_refunded;
    if body.amount > remaining {
        return Err(TransactionError::InvalidPayload(
            "refund exceeds amount due".to_string(),
        ));
    }

    let current_paid: Decimal =
        sqlx::query_scalar("SELECT amount_paid FROM transactions WHERE id = $1 FOR UPDATE")
            .bind(transaction_id)
            .fetch_one(&mut *tx)
            .await?;
    if body.amount > current_paid {
        return Err(TransactionError::InvalidPayload(
            "refund amount exceeds total amount paid on this order".to_string(),
        ));
    }

    let stripe_intent: Option<String> = sqlx::query_scalar(
        r#"
        SELECT pt.stripe_intent_id
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        WHERE pa.target_transaction_id = $1
          AND pa.amount_allocated > 0::numeric
          AND pt.stripe_intent_id IS NOT NULL
          AND btrim(pt.stripe_intent_id) <> ''
        ORDER BY pt.created_at ASC
        LIMIT 1
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();

    let mut stripe_refund_id: Option<String> = None;
    let wants_card_refund =
        method_l.contains("card") || method_l.contains("stripe") || method_l.contains("present");
    if wants_card_refund {
        if let Some(ref iid) = stripe_intent {
            let pi: stripe::PaymentIntentId = iid.parse().map_err(|_| {
                TransactionError::InvalidPayload(
                    "invalid stripe intent id on original payment".to_string(),
                )
            })?;
            let cents = (body.amount * Decimal::from(100)).to_i64().ok_or_else(|| {
                TransactionError::InvalidPayload(
                    "refund amount is too large or invalid".to_string(),
                )
            })?;
            let mut cp = stripe::CreateRefund::new();
            cp.payment_intent = Some(pi.clone());
            cp.amount = Some(cents);
            let rf = stripe::Refund::create(&state.stripe_client, cp)
                .await
                .map_err(|e| {
                    TransactionError::InvalidPayload(format!("Stripe refund failed: {e}"))
                })?;
            stripe_refund_id = Some(rf.id.to_string());
        }
    }

    if method_l.contains("gift") {
        let code = body
            .gift_card_code
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                TransactionError::InvalidPayload(
                    "gift_card_code is required when refunding to a gift card".to_string(),
                )
            })?;
        gift_card_ops::credit_gift_card_in_tx(
            &mut tx,
            code,
            body.amount,
            transaction_id,
            body.session_id,
        )
        .await
        .map_err(|e| match e {
            gift_card_ops::GiftCardOpError::Db(d) => TransactionError::Database(d),
            gift_card_ops::GiftCardOpError::BadRequest(m) => TransactionError::InvalidPayload(m),
        })?;
    }

    let metadata = json!({
        "kind": "order_refund",
        "transaction_id": transaction_id,
        "stripe_refund_id": stripe_refund_id,
    });

    let payment_tx_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO payment_transactions (session_id, payer_id, category, payment_method, amount, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
    )
    .bind(body.session_id)
    .bind(refund.customer_id)
    .bind(DbTransactionCategory::RetailSale)
    .bind(body.payment_method.trim())
    .bind(-body.amount)
    .bind(metadata)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO payment_allocations (transaction_id, target_transaction_id, amount_allocated, metadata)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(payment_tx_id)
    .bind(transaction_id)
    .bind(-body.amount)
    .bind(json!({ "kind": "order_refund" }))
    .execute(&mut *tx)
    .await?;

    let new_refunded = refund.amount_refunded + body.amount;
    let close = new_refunded >= refund.amount_due;
    sqlx::query(
        r#"
        UPDATE transaction_refund_queue
        SET amount_refunded = $1, is_open = $2, closed_at = CASE WHEN $2 = FALSE THEN CURRENT_TIMESTAMP ELSE NULL END
        WHERE id = $3
        "#,
    )
    .bind(new_refunded)
    .bind(!close)
    .bind(refund.id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE transactions
        SET amount_paid = GREATEST(amount_paid - $1, 0)
        WHERE id = $2
        "#,
    )
    .bind(body.amount)
    .bind(transaction_id)
    .execute(&mut *tx)
    .await?;

    transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id)
        .await
        .map_err(TransactionError::Database)?;

    let new_paid: Decimal =
        sqlx::query_scalar("SELECT amount_paid FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_one(&mut *tx)
            .await?;
    if new_paid.is_zero() {
        loyalty_logic::reverse_order_accrual_in_tx(&mut tx, transaction_id)
            .await
            .map_err(TransactionError::Database)?;
    }

    tx.commit().await?;

    log_order_activity(
        &state.db,
        transaction_id,
        refund.customer_id,
        "refund_processed",
        &format!(
            "Refunded ${} in Register via {}",
            body.amount,
            body.payment_method.trim()
        ),
        json!({ "amount": body.amount, "payment_method": body.payment_method }),
    )
    .await?;

    Ok(Json(json!({ "status": "ok" })))
}

async fn post_transaction_returns(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(q): Query<TransactionReadQuery>,
    headers: HeaderMap,
    Json(body): Json<PostOrderReturnsRequest>,
) -> Result<Json<TransactionDetailResponse>, TransactionError> {
    let staff_id = authorize_transaction_modify_bo_or_register(
        &state,
        &headers,
        transaction_id,
        q.register_session_id,
    )
    .await?;
    if body.lines.is_empty() {
        return Err(TransactionError::InvalidPayload("lines required".into()));
    }

    let inputs: Vec<ReturnLineInput> = body
        .lines
        .into_iter()
        .map(|l| ReturnLineInput {
            transaction_line_id: l.transaction_line_id,
            quantity: l.quantity,
            reason: l.reason,
            restock: l.restock,
        })
        .collect();

    transaction_returns::apply_transaction_returns(&state.db, transaction_id, staff_id, inputs)
        .await
        .map_err(|e| match e {
            transaction_returns::TransactionReturnError::Db(d) => TransactionError::Database(d),
            transaction_returns::TransactionReturnError::BadRequest(m) => {
                TransactionError::InvalidPayload(m)
            }
        })?;

    Ok(Json(
        load_transaction_detail(&state.db, transaction_id).await?,
    ))
}

async fn post_transaction_exchange_link(
    State(state): State<AppState>,
    Path(transaction_id): Path<Uuid>,
    Query(q): Query<TransactionReadQuery>,
    headers: HeaderMap,
    Json(body): Json<OrderExchangeLinkBody>,
) -> Result<Json<TransactionDetailResponse>, TransactionError> {
    if body.other_transaction_id == transaction_id {
        return Err(TransactionError::InvalidPayload("id mismatch".into()));
    }

    if let Some(sid) = q.register_session_id {
        authorize_transaction_modify_bo_or_register(
            &state,
            &headers,
            body.other_transaction_id,
            Some(sid),
        )
        .await?;
    } else {
        middleware::require_staff_with_permission(&state, &headers, ORDERS_MODIFY)
            .await
            .map_err(map_perm_err)?;
    }

    let mut tx = state.db.begin().await?;
    let gid = Uuid::new_v4();
    sqlx::query("UPDATE transactions SET exchange_group_id = $1 WHERE id = $2 OR id = $3")
        .bind(gid)
        .bind(transaction_id)
        .bind(body.other_transaction_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let detail = load_transaction_detail(&state.db, transaction_id).await?;
    log_order_activity(
        &state.db,
        transaction_id,
        detail.customer.as_ref().map(|c| c.id),
        "exchange_linked",
        "Orders linked",
        json!({ "exchange_group_id": gid, "other_id": body.other_transaction_id }),
    )
    .await?;

    Ok(Json(detail))
}
