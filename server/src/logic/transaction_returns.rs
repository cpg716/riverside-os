//! Post-sale line returns: audit rows, optional restock, totals + refund queue bumps.

use rust_decimal::Decimal;
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::models::DbFulfillmentType;

use super::loyalty;
use super::transaction_recalc;

#[derive(Debug, thiserror::Error)]
pub enum TransactionReturnError {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    BadRequest(String),
}

/// Sum of quantity already returned for an order line.
pub async fn returned_qty_for_item(
    tx: &mut Transaction<'_, Postgres>,
    transaction_line_id: Uuid,
) -> Result<i32, sqlx::Error> {
    let v: Option<i32> = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(quantity_returned), 0)::int FROM transaction_return_lines WHERE transaction_line_id = $1"#,
    )
    .bind(transaction_line_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(v.unwrap_or(0))
}

/// Record returns, adjust inventory for eligible takeaway lines, recalc transaction totals, bump refund queue.
pub async fn apply_transaction_returns(
    pool: &PgPool,
    transaction_id: Uuid,
    staff_id: Option<Uuid>,
    lines: Vec<ReturnLineInput>,
) -> Result<(), TransactionReturnError> {
    if lines.is_empty() {
        return Err(TransactionReturnError::BadRequest(
            "no return lines".to_string(),
        ));
    }

    let mut tx = pool.begin().await?;

    let status: Option<String> =
        sqlx::query_scalar("SELECT status::text FROM transactions WHERE id = $1 FOR UPDATE")
            .bind(transaction_id)
            .fetch_optional(&mut *tx)
            .await?;

    let Some(status) = status else {
        return Err(TransactionReturnError::BadRequest(
            "order not found".to_string(),
        ));
    };
    if status == "cancelled" {
        return Err(TransactionReturnError::BadRequest(
            "cannot return lines on a cancelled order".to_string(),
        ));
    }

    let customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();

    let mut refund_add = Decimal::ZERO;
    let mut loyalty_subtotal = Decimal::ZERO;

    type ReturnLineLockRow = (
        Uuid,
        i32,
        DbFulfillmentType,
        bool,
        Decimal,
        Decimal,
        Decimal,
        Uuid,
        Decimal,
    );
    for line in &lines {
        let row: Option<ReturnLineLockRow> = sqlx::query_as(
            r#"
                SELECT oi.id, oi.quantity, oi.fulfillment, oi.is_fulfilled,
                       oi.unit_price, oi.state_tax, oi.local_tax, oi.product_id,
                       oi.calculated_commission
                FROM transaction_lines oi
                WHERE oi.id = $1 AND oi.transaction_id = $2
                FOR UPDATE
                "#,
        )
        .bind(line.transaction_line_id)
        .bind(transaction_id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some((
            oid,
            sold_qty,
            fulfillment,
            is_fulfilled,
            unit_price,
            state_tax,
            local_tax,
            product_id,
            line_commission,
        )) = row
        else {
            return Err(TransactionReturnError::BadRequest(format!(
                "order_item {} not on this order",
                line.transaction_line_id
            )));
        };

        if line.quantity <= 0 {
            return Err(TransactionReturnError::BadRequest(
                "quantity must be positive".to_string(),
            ));
        }

        let already = returned_qty_for_item(&mut tx, oid).await?;
        let remaining = sold_qty - already;
        if line.quantity > remaining {
            return Err(TransactionReturnError::BadRequest(format!(
                "cannot return {} of item; only {} remaining (sold {sold_qty}, already returned {already})",
                line.quantity, remaining
            )));
        }

        let line_total = (unit_price + state_tax + local_tax) * Decimal::from(line.quantity);
        refund_add += line_total;

        if is_fulfilled && line_commission > Decimal::ZERO && remaining > 0 {
            let claw = (line_commission * Decimal::from(line.quantity) / Decimal::from(remaining))
                .round_dp(2);
            if claw > Decimal::ZERO {
                sqlx::query(
                    r#"
                    UPDATE transaction_lines
                    SET calculated_commission = GREATEST(calculated_commission - $1, 0)
                    WHERE id = $2
                    "#,
                )
                .bind(claw)
                .bind(oid)
                .execute(&mut *tx)
                .await?;
            }
        }

        let restock = line
            .restock
            .unwrap_or_else(|| fulfillment == DbFulfillmentType::Takeaway && is_fulfilled);

        if restock {
            let vid: Uuid =
                sqlx::query_scalar("SELECT variant_id FROM transaction_lines WHERE id = $1")
                    .bind(oid)
                    .fetch_one(&mut *tx)
                    .await?;
            sqlx::query(
                r#"
                UPDATE product_variants
                SET stock_on_hand = stock_on_hand + $1
                WHERE id = $2
                "#,
            )
            .bind(line.quantity)
            .bind(vid)
            .execute(&mut *tx)
            .await?;
        }

        sqlx::query(
            r#"
            INSERT INTO transaction_return_lines
                (transaction_id, transaction_line_id, quantity_returned, reason, restocked, staff_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(transaction_id)
        .bind(oid)
        .bind(line.quantity)
        .bind(line.reason.as_deref().unwrap_or("return"))
        .bind(restock)
        .bind(staff_id)
        .execute(&mut *tx)
        .await?;

        let excludes_loyalty: bool = sqlx::query_scalar(
            r#"
            SELECT (p.tax_category = 'service'::tax_category OR p.excludes_from_loyalty = TRUE)
            FROM products p WHERE p.id = $1
            "#,
        )
        .bind(product_id)
        .fetch_one(&mut *tx)
        .await?;

        if !excludes_loyalty {
            loyalty_subtotal += unit_price * Decimal::from(line.quantity);
        }
    }

    transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id)
        .await
        .map_err(TransactionReturnError::Db)?;

    if refund_add > Decimal::ZERO {
        upsert_refund_queue_row(
            &mut tx,
            transaction_id,
            customer_id,
            refund_add,
            "Line return",
        )
        .await?;
    }

    if loyalty_subtotal > Decimal::ZERO {
        if let Some(cid) = customer_id {
            loyalty::clawback_points_for_returned_subtotal_in_tx(
                &mut tx,
                transaction_id,
                cid,
                loyalty_subtotal,
            )
            .await?;
        }
    }

    sqlx::query(
        r#"
        INSERT INTO transaction_activity_log (transaction_id, customer_id, event_kind, summary, metadata)
        VALUES ($1, $2, 'line_return', $3, $4)
        "#,
    )
    .bind(transaction_id)
    .bind(customer_id)
    .bind(format!("Return recorded (${refund_add})"))
    .bind(json!({ "refund_subtotal": refund_add.to_string(), "line_count": lines.len() }))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

pub struct ReturnLineInput {
    pub transaction_line_id: Uuid,
    pub quantity: i32,
    pub reason: Option<String>,
    /// When None, restock if takeaway and fulfilled.
    pub restock: Option<bool>,
}

async fn upsert_refund_queue_row(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
    customer_id: Option<Uuid>,
    add_amount: Decimal,
    reason: &str,
) -> Result<(), sqlx::Error> {
    let reason_full = format!("{reason}; refund due after return");
    sqlx::query(
        r#"
        INSERT INTO transaction_refund_queue (transaction_id, customer_id, amount_due, reason)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (transaction_id) WHERE (is_open = true)
        DO UPDATE SET
            amount_due = transaction_refund_queue.amount_due + EXCLUDED.amount_due,
            reason = transaction_refund_queue.reason || '; ' || EXCLUDED.reason
        "#,
    )
    .bind(transaction_id)
    .bind(customer_id)
    .bind(add_amount)
    .bind(reason_full)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
