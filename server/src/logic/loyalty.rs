//! Loyalty point accrual — 5 pts per $1 on product lines (excluding service / excluded SKUs).
//!
//! Entry point: `try_accrue_for_order` — safe to call multiple times; idempotent via
//! `transaction_loyalty_accrual` guard table.

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub const POINTS_PER_DOLLAR: i32 = 5;

/// Compute integer points from a product subtotal (floor on whole dollars; 5 pts per $1).
/// Result of a successful one-time accrual for a fulfilled order (for loyalty email threshold checks).
#[derive(Debug, Clone, Copy)]
pub struct LoyaltyAccrualOutcome {
    pub customer_id: Uuid,
    pub points_earned: i32,
    pub balance_after: i32,
}

impl LoyaltyAccrualOutcome {
    #[inline]
    pub fn balance_before(self) -> i32 {
        self.balance_after - self.points_earned
    }
}

pub fn points_for_subtotal(subtotal: Decimal) -> i32 {
    if subtotal <= Decimal::ZERO {
        return 0;
    }
    let dollars_trunc = subtotal.trunc();
    let di = dollars_trunc
        .to_i64()
        .unwrap_or(0)
        .max(0)
        .min(i64::from(i32::MAX / POINTS_PER_DOLLAR.max(1)));
    (di * i64::from(POINTS_PER_DOLLAR)) as i32
}

/// Sum the eligible product line total for an order: unit_price × quantity for all lines
/// where the product is not `tax_category = 'service'` and `excludes_from_loyalty = false`.
///
/// Returns `(product_subtotal, customer_id)` or `None` if the order has no customer or
/// the accrual has already been recorded.
pub async fn try_accrue_for_order(
    pool: &PgPool,
    transaction_id: Uuid,
) -> Result<Option<LoyaltyAccrualOutcome>, sqlx::Error> {
    // Idempotency guard — if already accrued for this order, skip.
    let already: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM transaction_loyalty_accrual WHERE transaction_id = $1)",
    )
    .bind(transaction_id)
    .fetch_one(pool)
    .await?;

    if already {
        return Ok(None);
    }

    // Fetch order status and customer.
    let row: Option<(String, Option<Uuid>)> =
        sqlx::query_as("SELECT status::text, customer_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_optional(pool)
            .await?;

    let Some((status, Some(customer_id))) = row else {
        return Ok(None);
    };

    if status != "fulfilled" {
        return Ok(None);
    }

    // Check that every non-takeaway line is picked up.
    let pending_non_takeaway: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM transaction_lines
        WHERE transaction_id = $1
          AND fulfillment::text <> 'takeaway'
          AND is_fulfilled = FALSE
        "#,
    )
    .bind(transaction_id)
    .fetch_one(pool)
    .await?;

    if pending_non_takeaway > 0 {
        return Ok(None);
    }

    // Sum eligible product lines.
    let subtotal: Decimal = sqlx::query_scalar(
        r#"
        SELECT COALESCE(
            SUM(
                oi.unit_price
                * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)::numeric
            ),
            0
        )::numeric(14,2)
        FROM transaction_lines oi
        LEFT JOIN (
            SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
            FROM transaction_return_lines
            GROUP BY transaction_line_id
        ) orl ON orl.transaction_line_id = oi.id
        INNER JOIN products p ON p.id = oi.product_id
        WHERE oi.transaction_id = $1
          AND p.tax_category != 'service'::tax_category
          AND p.excludes_from_loyalty = FALSE
        "#,
    )
    .bind(transaction_id)
    .fetch_one(pool)
    .await?;

    if subtotal <= Decimal::ZERO {
        return Ok(None);
    }

    let points = points_for_subtotal(subtotal);
    if points <= 0 {
        return Ok(None);
    }

    let mut tx = pool.begin().await?;

    // Double-check inside the transaction (race guard).
    let already2: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM transaction_loyalty_accrual WHERE transaction_id = $1)",
    )
    .bind(transaction_id)
    .fetch_one(&mut *tx)
    .await?;

    if already2 {
        tx.rollback().await?;
        return Ok(None);
    }

    // Atomically bump customer balance and record ledger entry.
    let effective_id =
        crate::logic::customer_couple::resolve_effective_customer_id_tx(&mut tx, customer_id)
            .await?;

    let balance_after: i32 = sqlx::query_scalar(
        r#"
        UPDATE customers
        SET loyalty_points = loyalty_points + $1
        WHERE id = $2
        RETURNING loyalty_points
        "#,
    )
    .bind(points)
    .bind(effective_id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO loyalty_point_ledger
            (customer_id, delta_points, balance_after, reason, transaction_id, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(effective_id)
    .bind(points)
    .bind(balance_after)
    .bind("order_earn")
    .bind(transaction_id)
    .bind(json!({ "product_subtotal": subtotal, "original_customer_id": customer_id }))
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO transaction_loyalty_accrual (transaction_id, points_earned, product_subtotal)
        VALUES ($1, $2, $3)
        "#,
    )
    .bind(transaction_id)
    .bind(points)
    .bind(subtotal)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Some(LoyaltyAccrualOutcome {
        customer_id,
        points_earned: points,
        balance_after,
    }))
}

/// Full clawback when all payments are refunded (or order cancelled after accrual). Idempotent.
pub async fn reverse_order_accrual_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
) -> Result<(), sqlx::Error> {
    let row: Option<(Uuid, i32)> = sqlx::query_as(
        r#"
        SELECT ola.transaction_id, ola.points_earned
        FROM transaction_loyalty_accrual ola
        WHERE ola.transaction_id = $1
        FOR UPDATE
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(&mut **tx)
    .await?;

    let Some((_oid, points_earned)) = row else {
        return Ok(());
    };

    let customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1 FOR UPDATE")
            .bind(transaction_id)
            .fetch_optional(&mut **tx)
            .await?
            .flatten();

    let Some(customer_id) = customer_id else {
        sqlx::query("DELETE FROM transaction_loyalty_accrual WHERE transaction_id = $1")
            .bind(transaction_id)
            .execute(&mut **tx)
            .await?;
        return Ok(());
    };

    if points_earned <= 0 {
        sqlx::query("DELETE FROM transaction_loyalty_accrual WHERE transaction_id = $1")
            .bind(transaction_id)
            .execute(&mut **tx)
            .await?;
        return Ok(());
    }

    let effective_id =
        crate::logic::customer_couple::resolve_effective_customer_id_tx(tx, customer_id).await?;

    let balance_after: i32 = sqlx::query_scalar(
        r#"
        UPDATE customers
        SET loyalty_points = GREATEST(loyalty_points - $1, 0)
        WHERE id = $2
        RETURNING loyalty_points
        "#,
    )
    .bind(points_earned)
    .bind(effective_id)
    .fetch_one(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO loyalty_point_ledger
            (customer_id, delta_points, balance_after, reason, transaction_id, metadata)
        VALUES ($1, $2, $3, 'order_refund_clawback', $4, '{}'::jsonb)
        "#,
    )
    .bind(effective_id)
    .bind(-points_earned)
    .bind(balance_after)
    .bind(transaction_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query("DELETE FROM transaction_loyalty_accrual WHERE transaction_id = $1")
        .bind(transaction_id)
        .execute(&mut **tx)
        .await?;

    Ok(())
}

/// Partial clawback when merchandise subtotal is returned (tax excluded, matches earn basis).
pub async fn clawback_points_for_returned_subtotal_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
    customer_id: Uuid,
    returned_subtotal: Decimal,
) -> Result<(), sqlx::Error> {
    if returned_subtotal <= Decimal::ZERO {
        return Ok(());
    }
    let pts = points_for_subtotal(returned_subtotal);
    if pts <= 0 {
        return Ok(());
    }

    let effective_id =
        crate::logic::customer_couple::resolve_effective_customer_id_tx(tx, customer_id).await?;

    let balance_after: i32 = sqlx::query_scalar(
        r#"
        UPDATE customers
        SET loyalty_points = GREATEST(loyalty_points - $1, 0)
        WHERE id = $2
        RETURNING loyalty_points
        "#,
    )
    .bind(pts)
    .bind(effective_id)
    .fetch_one(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO loyalty_point_ledger
            (customer_id, delta_points, balance_after, reason, transaction_id, metadata)
        VALUES ($1, $2, $3, 'order_return_clawback', $4, $5)
        "#,
    )
    .bind(effective_id)
    .bind(-pts)
    .bind(balance_after)
    .bind(transaction_id)
    .bind(json!({ "returned_subtotal": returned_subtotal.to_string() }))
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE transaction_loyalty_accrual
        SET points_earned = GREATEST(points_earned - $1, 0),
            product_subtotal = GREATEST(product_subtotal - $2, 0::numeric)
        WHERE transaction_id = $3
        "#,
    )
    .bind(pts)
    .bind(returned_subtotal)
    .bind(transaction_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}
