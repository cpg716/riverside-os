//! Recompute `orders.total_price`, `balance_due`, and status from line items and returns.

use rust_decimal::Decimal;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// Effective line totals subtract `transaction_return_lines` per item.
pub async fn recalc_transaction_totals(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
) -> Result<(), sqlx::Error> {
    let (total, amount_paid, rounding_adjustment, _ship): (
        Option<Decimal>,
        Decimal,
        Decimal,
        Option<Decimal>,
    ) = sqlx::query_as(
        r#"
        SELECT
            COALESCE(SUM(
                (oi.unit_price + COALESCE(oi.state_tax, 0) + COALESCE(oi.local_tax, 0))::numeric
                * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)::numeric
            ), 0::numeric) + COALESCE(o.shipping_amount_usd, 0)::numeric AS total,
            o.amount_paid,
            COALESCE(o.rounding_adjustment, 0)::numeric AS rounding_adjustment,
            o.shipping_amount_usd
        FROM transactions o
        LEFT JOIN transaction_lines oi ON oi.transaction_id = o.id
        LEFT JOIN (
            SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
            FROM transaction_return_lines
            GROUP BY transaction_line_id
        ) orl ON orl.transaction_line_id = oi.id
        WHERE o.id = $1
        GROUP BY o.amount_paid, o.rounding_adjustment, o.shipping_amount_usd
        "#,
    )
    .bind(transaction_id)
    .fetch_one(&mut **tx)
    .await?;

    let total_price = total.unwrap_or(Decimal::ZERO);
    let balance_due = total_price + rounding_adjustment - amount_paid;

    sqlx::query(
        r#"
        UPDATE transactions
        SET total_price = $1, balance_due = $2
        WHERE id = $3
        "#,
    )
    .bind(total_price)
    .bind(balance_due)
    .bind(transaction_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        WITH line_state AS (
            SELECT
                COUNT(oi.id) FILTER (
                    WHERE GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0) > 0
                )::bigint AS active_line_count,
                COUNT(oi.id) FILTER (
                    WHERE oi.is_fulfilled = FALSE
                      AND GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0) > 0
                )::bigint AS open_active_line_count,
                MAX(oi.fulfilled_at) FILTER (WHERE oi.is_fulfilled = TRUE) AS max_line_fulfilled_at
            FROM transaction_lines oi
            LEFT JOIN (
                SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
                FROM transaction_return_lines
                GROUP BY transaction_line_id
            ) orl ON orl.transaction_line_id = oi.id
            WHERE oi.transaction_id = $1
        )
        UPDATE transactions t
        SET
            status = CASE
                WHEN t.status IN ('cancelled'::order_status, 'pending_measurement'::order_status) THEN t.status
                WHEN t.status = 'fulfilled'::order_status
                  AND line_state.open_active_line_count > 0 THEN 'open'::order_status
                WHEN t.status = 'open'::order_status
                  AND line_state.active_line_count > 0
                  AND line_state.open_active_line_count = 0
                  AND t.balance_due = 0 THEN 'fulfilled'::order_status
                ELSE t.status
            END,
            fulfilled_at = CASE
                WHEN t.status = 'fulfilled'::order_status
                  AND line_state.open_active_line_count > 0 THEN NULL
                WHEN t.status = 'open'::order_status
                  AND line_state.active_line_count > 0
                  AND line_state.open_active_line_count = 0
                  AND t.balance_due = 0
                    THEN COALESCE(t.fulfilled_at, line_state.max_line_fulfilled_at, CURRENT_TIMESTAMP)
                ELSE t.fulfilled_at
            END
        FROM line_state
        WHERE t.id = $1
        "#,
    )
    .bind(transaction_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}
