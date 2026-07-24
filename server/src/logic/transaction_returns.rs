//! Post-sale line returns: audit rows, optional restock, totals + refund queue bumps.

use rust_decimal::Decimal;
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::models::DbFulfillmentType;

use super::counterpoint_return_safety::COUNTERPOINT_RETURN_REVIEW_MESSAGE;
use super::loyalty;
use super::transaction_recalc;

#[derive(Debug, thiserror::Error)]
pub enum TransactionReturnError {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    BadRequest(String),
}

fn refundable_line_total(
    unit_price: Decimal,
    state_tax: Decimal,
    local_tax: Decimal,
    quantity: i32,
) -> Decimal {
    (unit_price + state_tax + local_tax) * Decimal::from(quantity)
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
    let mut tx = pool.begin().await?;
    apply_transaction_returns_in_tx(&mut tx, transaction_id, staff_id, lines).await?;
    tx.commit().await?;
    Ok(())
}

/// Transaction-bound return recording for flows that must bundle return/restock,
/// totals, refund queue, and a parent workflow audit row in one commit.
pub async fn apply_transaction_returns_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
    staff_id: Option<Uuid>,
    lines: Vec<ReturnLineInput>,
) -> Result<(), TransactionReturnError> {
    if lines.is_empty() {
        return Err(TransactionReturnError::BadRequest(
            "no return lines".to_string(),
        ));
    }

    let header: Option<(String, bool)> = sqlx::query_as(
        r#"
        SELECT status::text, COALESCE(is_counterpoint_import, FALSE)
        FROM transactions
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(&mut **tx)
    .await?;

    let Some((status, is_counterpoint_import)) = header else {
        return Err(TransactionReturnError::BadRequest(
            "order not found".to_string(),
        ));
    };
    if status == "cancelled" {
        return Err(TransactionReturnError::BadRequest(
            "cannot return lines on a cancelled order".to_string(),
        ));
    }
    if is_counterpoint_import {
        let has_active_review_block: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM counterpoint_return_review_blocks
                WHERE transaction_id = $1 AND active
            )
            "#,
        )
        .bind(transaction_id)
        .fetch_one(&mut **tx)
        .await?;
        let has_unmatched_negative_allocation: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                WHERE pa.target_transaction_id = $1
                  AND pa.amount_allocated < 0
                  AND NOT EXISTS (
                      SELECT 1
                      FROM transaction_return_lines trl
                      WHERE trl.transaction_id = $1
                        AND trl.refund_event_id IS NOT NULL
                        AND (
                            trl.refund_event_id::text =
                                NULLIF(pa.metadata->>'refund_event_id', '')
                            OR trl.refund_event_id::text =
                                NULLIF(pt.metadata->>'refund_event_id', '')
                        )
                  )
            )
            "#,
        )
        .bind(transaction_id)
        .fetch_one(&mut **tx)
        .await?;
        if has_active_review_block || has_unmatched_negative_allocation {
            return Err(TransactionReturnError::BadRequest(
                COUNTERPOINT_RETURN_REVIEW_MESSAGE.to_string(),
            ));
        }
    }

    let customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
            .bind(transaction_id)
            .fetch_optional(&mut **tx)
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
        Uuid,
        Decimal,
        Decimal,
    );
    for line in &lines {
        let row: Option<ReturnLineLockRow> = sqlx::query_as(
            r#"
                SELECT oi.id, oi.quantity, oi.fulfillment, oi.is_fulfilled,
                       oi.unit_price, oi.state_tax, oi.local_tax, oi.product_id, oi.variant_id,
                       oi.calculated_commission, oi.unit_cost
                FROM transaction_lines oi
                WHERE oi.id = $1 AND oi.transaction_id = $2
                FOR UPDATE
                "#,
        )
        .bind(line.transaction_line_id)
        .bind(transaction_id)
        .fetch_optional(&mut **tx)
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
            variant_id,
            line_commission,
            unit_cost,
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

        let already = returned_qty_for_item(tx, oid).await?;
        let remaining = sold_qty - already;
        if line.quantity > remaining {
            return Err(TransactionReturnError::BadRequest(format!(
                "cannot return {} of item; only {} remaining (sold {sold_qty}, already returned {already})",
                line.quantity, remaining
            )));
        }

        let fallback_subtotal = unit_price * Decimal::from(line.quantity);
        let fallback_state_tax = state_tax * Decimal::from(line.quantity);
        let fallback_local_tax = local_tax * Decimal::from(line.quantity);
        let (refund_subtotal, refund_state_tax, refund_local_tax, line_total) =
            line.financial_components(fallback_subtotal, fallback_state_tax, fallback_local_tax)?;
        refund_add += line_total;

        let restock = line
            .restock
            .unwrap_or_else(|| fulfillment == DbFulfillmentType::Takeaway && is_fulfilled);

        let restock_affected = if restock {
            let updated_variant: Option<Uuid> = sqlx::query_scalar(
                r#"
                UPDATE product_variants
                SET stock_on_hand = stock_on_hand + $1
                WHERE id = $2
                RETURNING id
                "#,
            )
            .bind(line.quantity)
            .bind(variant_id)
            .fetch_optional(&mut **tx)
            .await?;
            if updated_variant.is_none() {
                return Err(TransactionReturnError::BadRequest(
                    "cannot restock returned item because its inventory variant was not found"
                        .to_string(),
                ));
            }
            1
        } else {
            0
        };

        let return_line_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO transaction_return_lines (
                transaction_id, transaction_line_id, quantity_returned, reason, restocked, staff_id,
                refund_event_id, register_session_id, refund_subtotal, refund_state_tax,
                refund_local_tax, refund_total
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING id
            "#,
        )
        .bind(transaction_id)
        .bind(oid)
        .bind(line.quantity)
        .bind(line.reason.as_deref().unwrap_or("return"))
        .bind(restock)
        .bind(staff_id)
        .bind(line.refund_event_id)
        .bind(line.register_session_id)
        .bind(refund_subtotal)
        .bind(refund_state_tax)
        .bind(refund_local_tax)
        .bind(line_total)
        .fetch_one(&mut **tx)
        .await?;

        if restock && restock_affected > 0 {
            sqlx::query(
                r#"
                INSERT INTO inventory_transactions (
                    variant_id, tx_type, quantity_delta, unit_cost, reference_table, reference_id, notes
                )
                VALUES ($1, 'return_in', $2, $3, 'transaction_return_lines', $4, $5)
                "#,
            )
            .bind(variant_id)
            .bind(line.quantity)
            .bind(unit_cost)
            .bind(return_line_id)
            .bind(format!(
                "Restocked return stock increment for transaction {transaction_id}"
            ))
            .execute(&mut **tx)
            .await?;
        }

        if is_fulfilled && line_commission > Decimal::ZERO {
            crate::logic::commission_events::insert_return_adjustment_event(
                tx,
                crate::logic::commission_events::ReturnCommissionAdjustment {
                    transaction_id,
                    transaction_line_id: oid,
                    return_line_id,
                    returned_qty: line.quantity,
                    sold_qty,
                    original_commission: line_commission,
                    reason: line.reason.clone().unwrap_or_else(|| "return".to_string()),
                    created_by_staff_id: staff_id,
                },
            )
            .await?;
        }

        let excludes_loyalty: bool = sqlx::query_scalar(
            r#"
            SELECT (p.tax_category = 'service'::tax_category OR p.excludes_from_loyalty = TRUE)
            FROM products p WHERE p.id = $1
            "#,
        )
        .bind(product_id)
        .fetch_one(&mut **tx)
        .await?;

        if !excludes_loyalty {
            loyalty_subtotal += refund_subtotal;
        }
    }

    transaction_recalc::recalc_transaction_totals(tx, transaction_id)
        .await
        .map_err(TransactionReturnError::Db)?;

    if refund_add > Decimal::ZERO {
        let refundable_credit = refundable_credit_due(tx, transaction_id).await?;
        if refundable_credit > Decimal::ZERO {
            sync_refund_queue_row(
                tx,
                transaction_id,
                customer_id,
                refundable_credit,
                "Line return",
            )
            .await?;
        }
    }

    if loyalty_subtotal > Decimal::ZERO {
        if let Some(cid) = customer_id {
            loyalty::clawback_points_for_returned_subtotal_in_tx(
                tx,
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
    .bind(json!({
        "refund_total": refund_add.to_string(),
        "line_count": lines.len(),
        "refund_event_id": lines.first().map(|line| line.refund_event_id),
        "register_session_id": lines.first().and_then(|line| line.register_session_id),
    }))
    .execute(&mut **tx)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refundable_line_total_includes_line_tax_for_each_returned_unit() {
        let total = refundable_line_total(
            Decimal::new(10000, 2),
            Decimal::new(400, 2),
            Decimal::new(475, 2),
            2,
        );

        assert_eq!(total, Decimal::new(21750, 2));
    }

    #[test]
    fn exact_refund_components_override_the_original_line_price() {
        let input = ReturnLineInput {
            transaction_line_id: Uuid::nil(),
            quantity: 1,
            reason: Some("refund".to_string()),
            restock: Some(true),
            refund_event_id: Uuid::nil(),
            register_session_id: None,
            refund_subtotal: Some(Decimal::new(8881, 2)),
            refund_state_tax: Some(Decimal::new(337, 2)),
            refund_local_tax: Some(Decimal::ZERO),
            refund_total: Some(Decimal::new(9218, 2)),
        };

        let components = input
            .financial_components(Decimal::new(11000, 2), Decimal::new(418, 2), Decimal::ZERO)
            .expect("exact refund components should be accepted");

        assert_eq!(components.0, Decimal::new(8881, 2));
        assert_eq!(components.1, Decimal::new(337, 2));
        assert_eq!(components.3, Decimal::new(9218, 2));
    }

    #[test]
    fn mismatched_exact_refund_components_are_rejected() {
        let input = ReturnLineInput {
            transaction_line_id: Uuid::nil(),
            quantity: 1,
            reason: Some("refund".to_string()),
            restock: Some(true),
            refund_event_id: Uuid::nil(),
            register_session_id: None,
            refund_subtotal: Some(Decimal::new(8881, 2)),
            refund_state_tax: Some(Decimal::new(337, 2)),
            refund_local_tax: Some(Decimal::ZERO),
            refund_total: Some(Decimal::new(11418, 2)),
        };

        assert!(input
            .financial_components(Decimal::new(11000, 2), Decimal::new(418, 2), Decimal::ZERO,)
            .is_err());
    }
}

pub struct ReturnLineInput {
    pub transaction_line_id: Uuid,
    pub quantity: i32,
    pub reason: Option<String>,
    /// When None, restock if takeaway and fulfilled.
    pub restock: Option<bool>,
    pub refund_event_id: Uuid,
    pub register_session_id: Option<Uuid>,
    pub refund_subtotal: Option<Decimal>,
    pub refund_state_tax: Option<Decimal>,
    pub refund_local_tax: Option<Decimal>,
    pub refund_total: Option<Decimal>,
}

impl ReturnLineInput {
    fn financial_components(
        &self,
        fallback_subtotal: Decimal,
        fallback_state_tax: Decimal,
        fallback_local_tax: Decimal,
    ) -> Result<(Decimal, Decimal, Decimal, Decimal), TransactionReturnError> {
        let supplied = [
            self.refund_subtotal,
            self.refund_state_tax,
            self.refund_local_tax,
            self.refund_total,
        ];
        if supplied.iter().all(Option::is_none) {
            let total = (fallback_subtotal + fallback_state_tax + fallback_local_tax).round_dp(2);
            return Ok((
                fallback_subtotal.round_dp(2),
                fallback_state_tax.round_dp(2),
                fallback_local_tax.round_dp(2),
                total,
            ));
        }
        if supplied.iter().any(Option::is_none) {
            return Err(TransactionReturnError::BadRequest(
                "refund line financial components must be supplied together".to_string(),
            ));
        }
        let subtotal = self.refund_subtotal.unwrap_or_default().round_dp(2);
        let state_tax = self.refund_state_tax.unwrap_or_default().round_dp(2);
        let local_tax = self.refund_local_tax.unwrap_or_default().round_dp(2);
        let total = self.refund_total.unwrap_or_default().round_dp(2);
        if [subtotal, state_tax, local_tax, total]
            .iter()
            .any(|amount| *amount < Decimal::ZERO)
        {
            return Err(TransactionReturnError::BadRequest(
                "refund line financial components cannot be negative".to_string(),
            ));
        }
        if (subtotal + state_tax + local_tax).round_dp(2) != total {
            return Err(TransactionReturnError::BadRequest(
                "refund line subtotal plus tax must equal refund total".to_string(),
            ));
        }
        Ok((subtotal, state_tax, local_tax, total))
    }
}

async fn refundable_credit_due(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
) -> Result<Decimal, sqlx::Error> {
    let balance_due: Decimal = sqlx::query_scalar(
        r#"
        SELECT COALESCE(balance_due, 0)::numeric(14,2)
        FROM transactions
        WHERE id = $1
        "#,
    )
    .bind(transaction_id)
    .fetch_one(&mut **tx)
    .await?;

    if balance_due < Decimal::ZERO {
        Ok(-balance_due)
    } else {
        Ok(Decimal::ZERO)
    }
}

async fn sync_refund_queue_row(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
    customer_id: Option<Uuid>,
    refundable_remaining: Decimal,
    reason: &str,
) -> Result<(), sqlx::Error> {
    let reason_full = format!("{reason}; refund due after return");
    sqlx::query(
        r#"
        INSERT INTO transaction_refund_queue (transaction_id, customer_id, amount_due, reason)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (transaction_id) WHERE (is_open = true)
        DO UPDATE SET
            amount_due = transaction_refund_queue.amount_refunded + EXCLUDED.amount_due,
            reason = transaction_refund_queue.reason || '; ' || EXCLUDED.reason
        "#,
    )
    .bind(transaction_id)
    .bind(customer_id)
    .bind(refundable_remaining)
    .bind(reason_full)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
