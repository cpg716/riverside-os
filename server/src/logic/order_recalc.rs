//! Recompute `orders.total_price`, `balance_due`, and `status` from line items and returns.

use rust_decimal::Decimal;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::models::DbOrderStatus;

/// Effective line totals subtract `order_return_lines` per item.
pub async fn recalc_order_totals(
    tx: &mut Transaction<'_, Postgres>,
    order_id: Uuid,
) -> Result<(), sqlx::Error> {
    let (total, amount_paid, status, _ship): (
        Option<Decimal>,
        Decimal,
        DbOrderStatus,
        Option<Decimal>,
    ) = sqlx::query_as(
        r#"
        SELECT
            COALESCE(SUM(
                (oi.unit_price + COALESCE(oi.state_tax, 0) + COALESCE(oi.local_tax, 0))::numeric
                * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)::numeric
            ), 0::numeric) + COALESCE(o.shipping_amount_usd, 0)::numeric AS total,
            o.amount_paid,
            o.status,
            o.shipping_amount_usd
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        LEFT JOIN (
            SELECT order_item_id, SUM(quantity_returned)::int AS returned
            FROM order_return_lines
            GROUP BY order_item_id
        ) orl ON orl.order_item_id = oi.id
        WHERE o.id = $1
        GROUP BY o.amount_paid, o.status, o.shipping_amount_usd
        "#,
    )
    .bind(order_id)
    .fetch_one(&mut **tx)
    .await?;

    let total_price = total.unwrap_or(Decimal::ZERO);
    let balance_due = total_price - amount_paid;

    let unfulfilled_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM order_items oi
        LEFT JOIN (
            SELECT order_item_id, SUM(quantity_returned)::int AS returned
            FROM order_return_lines
            GROUP BY order_item_id
        ) orl ON orl.order_item_id = oi.id
        WHERE oi.order_id = $1
          AND oi.is_fulfilled = FALSE
          AND GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0) > 0
        "#,
    )
    .bind(order_id)
    .fetch_one(&mut **tx)
    .await?;

    let next_status = if status == DbOrderStatus::Cancelled {
        DbOrderStatus::Cancelled
    } else if unfulfilled_count == 0 && balance_due <= Decimal::ZERO {
        DbOrderStatus::Fulfilled
    } else {
        DbOrderStatus::Open
    };

    sqlx::query(
        r#"
        UPDATE orders
        SET total_price = $1, balance_due = $2, status = $3
        WHERE id = $4
        "#,
    )
    .bind(total_price)
    .bind(balance_due)
    .bind(next_status)
    .bind(order_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}
