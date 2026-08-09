//! Recompute `orders.total_price`, `balance_due`, and status from line items and returns.

use rust_decimal::Decimal;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::logic::checkout_validate::is_shipping_charge_sku;
use crate::logic::tax::{erie_local_tax_usd, nys_state_tax_usd, TaxCategory};

fn recalculated_balance_due(
    is_cancelled_or_fully_refunded: bool,
    total_price: Decimal,
    rounding_adjustment: Decimal,
    amount_paid: Decimal,
) -> Decimal {
    if is_cancelled_or_fully_refunded {
        Decimal::ZERO
    } else {
        total_price + rounding_adjustment - amount_paid
    }
}

fn open_refund_amount_due(amount_refunded: Decimal, balance_due: Decimal) -> Decimal {
    amount_refunded
        + if balance_due < Decimal::ZERO {
            -balance_due
        } else {
            Decimal::ZERO
        }
}

/// Recalculate per-unit tax for an amended open-order line from the price the
/// customer is actually being charged. Client-supplied or previously stored tax
/// must not survive a price change.
pub fn amended_order_line_tax(
    tax_category: TaxCategory,
    unit_price: Decimal,
    is_tax_exempt: bool,
    pos_line_kind: Option<&str>,
    sku: &str,
) -> (Decimal, Decimal) {
    let is_non_taxable_internal = matches!(
        pos_line_kind,
        Some(
            "rms_charge_payment"
                | "pos_gift_card_load"
                | "staff_account_payment"
                | "alteration_service"
        )
    ) || is_shipping_charge_sku(sku);

    if is_tax_exempt || is_non_taxable_internal {
        return (Decimal::ZERO, Decimal::ZERO);
    }

    (
        nys_state_tax_usd(tax_category, unit_price, unit_price),
        erie_local_tax_usd(tax_category, unit_price, unit_price),
    )
}

/// Effective line totals subtract `transaction_return_lines` per item.
pub async fn recalc_transaction_totals(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
) -> Result<(), sqlx::Error> {
    let (total, amount_paid, rounding_adjustment, _ship, is_cancelled, is_fully_refunded): (
        Option<Decimal>,
        Decimal,
        Decimal,
        Option<Decimal>,
        bool,
        bool,
    ) = sqlx::query_as(
        r#"
        SELECT
            COALESCE(SUM(
                (oi.unit_price + COALESCE(oi.state_tax, 0) + COALESCE(oi.local_tax, 0))::numeric
                * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)::numeric
            ), 0::numeric) + COALESCE(o.shipping_amount_usd, 0)::numeric AS total,
            o.amount_paid,
            COALESCE(o.rounding_adjustment, 0)::numeric AS rounding_adjustment,
            o.shipping_amount_usd,
            o.status = 'cancelled'::order_status AS is_cancelled,
            EXISTS (
                SELECT 1
                FROM transaction_refund_queue q
                WHERE q.transaction_id = o.id
                  AND q.is_open = FALSE
                  AND q.amount_due > 0
                  AND q.amount_refunded >= q.amount_due
            ) AS is_fully_refunded
        FROM transactions o
        LEFT JOIN transaction_lines oi ON oi.transaction_id = o.id
        LEFT JOIN (
            SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
            FROM transaction_return_lines
            GROUP BY transaction_line_id
        ) orl ON orl.transaction_line_id = oi.id
        WHERE o.id = $1
        GROUP BY o.id, o.amount_paid, o.rounding_adjustment, o.shipping_amount_usd, o.status
        "#,
    )
    .bind(transaction_id)
    .fetch_one(&mut **tx)
    .await?;

    let total_price = total.unwrap_or(Decimal::ZERO);
    let balance_due = recalculated_balance_due(
        is_cancelled || is_fully_refunded,
        total_price,
        rounding_adjustment,
        amount_paid,
    );

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
        UPDATE transaction_refund_queue
        SET
            amount_due = $2,
            is_open = $3,
            closed_at = CASE WHEN $3 THEN NULL ELSE CURRENT_TIMESTAMP END
        WHERE transaction_id = $1
          AND is_open = TRUE
          AND NOT EXISTS (
              SELECT 1
              FROM transaction_void_records void_record
              WHERE void_record.transaction_id = $1
          )
        "#,
    )
    .bind(transaction_id)
    .bind(open_refund_amount_due(
        sqlx::query_scalar::<_, Decimal>(
            r#"
            SELECT COALESCE(MAX(amount_refunded), 0)::numeric(14,2)
            FROM transaction_refund_queue
            WHERE transaction_id = $1
              AND is_open = TRUE
            "#,
        )
        .bind(transaction_id)
        .fetch_one(&mut **tx)
        .await?,
        balance_due,
    ))
    .bind(balance_due < Decimal::ZERO)
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
              AND NOT COALESCE(oi.is_internal, FALSE)
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

#[cfg(test)]
mod tests {
    use super::{amended_order_line_tax, open_refund_amount_due, recalculated_balance_due};
    use crate::logic::tax::TaxCategory;
    use rust_decimal::Decimal;
    use rust_decimal_macros::dec;

    #[test]
    fn cancelled_transaction_never_reopens_a_customer_balance() {
        assert_eq!(
            recalculated_balance_due(true, dec!(282.75), Decimal::ZERO, Decimal::ZERO),
            Decimal::ZERO,
        );
        assert_eq!(
            recalculated_balance_due(false, dec!(282.75), Decimal::ZERO, Decimal::ZERO),
            dec!(282.75),
        );
    }

    #[test]
    fn fully_refunded_transaction_never_reopens_a_customer_balance() {
        assert_eq!(
            recalculated_balance_due(true, dec!(316.00), Decimal::ZERO, Decimal::ZERO),
            Decimal::ZERO,
        );
    }

    #[test]
    fn replacement_items_reduce_or_consume_an_open_refund() {
        assert_eq!(
            open_refund_amount_due(Decimal::ZERO, dec!(-67.04)),
            dec!(67.04)
        );
        assert_eq!(
            open_refund_amount_due(Decimal::ZERO, Decimal::ZERO),
            Decimal::ZERO
        );
        assert_eq!(
            open_refund_amount_due(Decimal::ZERO, dec!(25.00)),
            Decimal::ZERO
        );
    }

    #[test]
    fn partial_refunds_retain_only_the_unpaid_credit() {
        assert_eq!(
            open_refund_amount_due(dec!(20.00), dec!(-47.04)),
            dec!(67.04)
        );
    }

    #[test]
    fn amended_clothing_line_uses_actual_charged_price_for_threshold_tax() {
        let (state_tax, local_tax) =
            amended_order_line_tax(TaxCategory::Clothing, dec!(50.00), false, None, "VEST");

        assert_eq!(state_tax, Decimal::ZERO);
        assert_eq!(local_tax, dec!(2.38));
    }

    #[test]
    fn amended_vest_and_tux_match_txn_624473_expected_tax() {
        let (vest_state, vest_local) =
            amended_order_line_tax(TaxCategory::Clothing, dec!(50.00), false, None, "VEST");
        let (tux_state, tux_local) =
            amended_order_line_tax(TaxCategory::Clothing, dec!(260.00), false, None, "TUX");

        assert_eq!(vest_state + vest_local + tux_state + tux_local, dec!(25.13));
    }
}
