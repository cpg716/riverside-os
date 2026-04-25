//! Recompute `orders.total_price`, `balance_due`, and `status` from line items and returns.

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

    Ok(())
}
