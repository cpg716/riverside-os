use crate::logic::pricing::round_money_usd;
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde_json::json;
use sqlx::postgres::PgConnection;
use sqlx::FromRow;
use uuid::Uuid;

use crate::logic::report_basis::ORDER_RECOGNITION_TS_SQL;
use crate::logic::sales_commission;
use crate::logic::sales_commission::CommissionLineInput;

#[derive(Debug, FromRow)]
struct CommissionLineCalcRow {
    id: Uuid,
    salesperson_id: Option<Uuid>,
    unit_price: Decimal,
    quantity: i32,
    product_id: Uuid,
    variant_id: Uuid,
    is_employee_purchase: bool,
    calc_at: DateTime<Utc>,
    calculated_commission: Decimal,
    is_internal: bool,
    transaction_short_id: String,
}

pub async fn recalc_staff_commissions_from(
    conn: &mut PgConnection,
    staff_id: Uuid,
    effective_start_date: NaiveDate,
) -> Result<u64, sqlx::Error> {
    let rec = ORDER_RECOGNITION_TS_SQL.trim();
    // SAFETY: `rec` is a crate-local `pub const` — never user input. This format! embeds a
    // complex CASE expression that must be repeated four times inside the query.
    let sql = format!(
        r#"
        SELECT
            oi.id,
            oi.salesperson_id,
            oi.unit_price,
            oi.quantity,
            oi.product_id,
            oi.variant_id,
            COALESCE(o.is_employee_purchase, FALSE) AS is_employee_purchase,
            CASE
                WHEN oi.is_fulfilled AND ({rec}) IS NOT NULL THEN ({rec})
                ELSE o.booked_at
            END AS calc_at,
            oi.calculated_commission,
            COALESCE(oi.is_internal, FALSE) AS is_internal,
            COALESCE(o.short_id, 'TXN-' || left(o.id::text, 8)) AS transaction_short_id
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        WHERE oi.salesperson_id = $1
          AND o.status::text <> 'cancelled'
          AND NOT EXISTS (
              SELECT 1
              FROM commission_events ce
              WHERE ce.transaction_line_id = oi.id
          )
          AND (
                (
                    oi.is_fulfilled = TRUE
                    AND ({rec}) IS NOT NULL
                    AND ({rec})::date >= $2
                )
                OR (
                    oi.is_fulfilled = FALSE
                    AND o.booked_at::date >= $2
                )
          )
        ORDER BY calc_at ASC, oi.id ASC
        "#,
    );

    let rows = sqlx::query_as::<_, CommissionLineCalcRow>(&sql)
        .bind(staff_id)
        .bind(effective_start_date)
        .fetch_all(&mut *conn)
        .await?;

    let mut changed = 0u64;
    for row in rows {
        let new_commission = sales_commission::commission_for_line_at(
            conn,
            CommissionLineInput {
                unit_price: row.unit_price,
                quantity: row.quantity,
                salesperson_id: row.salesperson_id,
                product_id: row.product_id,
                variant_id: row.variant_id,
                is_employee_sale: row.is_employee_purchase,
            },
            row.calc_at,
        )
        .await?;

        if new_commission == row.calculated_commission {
            continue;
        }

        sqlx::query("UPDATE transaction_lines SET calculated_commission = $2 WHERE id = $1")
            .bind(row.id)
            .bind(new_commission)
            .execute(&mut *conn)
            .await?;
        changed += 1;
    }

    Ok(changed)
}

pub async fn recalc_transaction_line_commission(
    conn: &mut PgConnection,
    transaction_id: Uuid,
    transaction_line_id: Uuid,
    salesperson_id: Option<Uuid>,
) -> Result<Option<Decimal>, sqlx::Error> {
    let rec = ORDER_RECOGNITION_TS_SQL.trim();
    // SAFETY: `rec` is a crate-local `pub const` — never user input.
    let sql = format!(
        r#"
        SELECT
            oi.id,
            oi.salesperson_id,
            oi.unit_price,
            oi.quantity,
            oi.product_id,
            oi.variant_id,
            COALESCE(o.is_employee_purchase, FALSE) AS is_employee_purchase,
            CASE
                WHEN oi.is_fulfilled AND ({rec}) IS NOT NULL THEN ({rec})
                ELSE o.booked_at
            END AS calc_at,
            oi.calculated_commission,
            COALESCE(oi.is_internal, FALSE) AS is_internal,
            COALESCE(o.short_id, 'TXN-' || left(o.id::text, 8)) AS transaction_short_id
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        WHERE oi.id = $1
          AND oi.transaction_id = $2
          AND o.status::text <> 'cancelled'
        "#,
    );

    let row = sqlx::query_as::<_, CommissionLineCalcRow>(&sql)
        .bind(transaction_line_id)
        .bind(transaction_id)
        .fetch_optional(&mut *conn)
        .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    let breakdown = sales_commission::commission_breakdown_for_line_at(
        conn,
        CommissionLineInput {
            unit_price: row.unit_price,
            quantity: row.quantity,
            salesperson_id,
            product_id: row.product_id,
            variant_id: row.variant_id,
            is_employee_sale: row.is_employee_purchase,
        },
        row.calc_at,
    )
    .await?;

    sqlx::query(
        "UPDATE transaction_lines SET salesperson_id = $2, calculated_commission = $3 WHERE id = $1",
    )
    .bind(transaction_line_id)
    .bind(salesperson_id)
    .bind(breakdown.total_commission)
    .execute(&mut *conn)
    .await?;

    // Check if a commission event exists for this line
    let event_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM commission_events WHERE transaction_line_id = $1)",
    )
    .bind(transaction_line_id)
    .fetch_one(&mut *conn)
    .await?;

    if event_exists {
        if let Some(sid) = salesperson_id {
            // Fetch staff name
            let staff_name: String =
                sqlx::query_scalar("SELECT full_name FROM staff WHERE id = $1")
                    .bind(sid)
                    .fetch_optional(&mut *conn)
                    .await?
                    .flatten()
                    .unwrap_or_else(|| "Unassigned".to_string());

            // Fetch product name
            let product_name: String =
                sqlx::query_scalar("SELECT name FROM products WHERE id = $1")
                    .bind(row.product_id)
                    .fetch_optional(&mut *conn)
                    .await?
                    .flatten()
                    .unwrap_or_else(|| "Transaction line".to_string());

            let event_type = if row.is_internal {
                "combo_incentive"
            } else {
                "sale_commission"
            };
            let commissionable_amount = if row.is_internal {
                Decimal::ZERO
            } else {
                row.unit_price * Decimal::from(row.quantity)
            };
            let base_commission_amount = if row.is_internal {
                Decimal::ZERO
            } else {
                round_money_usd(commissionable_amount * breakdown.base_rate)
            };
            let incentive_amount = if row.is_internal {
                breakdown.total_commission
            } else {
                breakdown.total_commission - base_commission_amount
            };

            let snapshot_json = json!({
                "transaction_short_id": row.transaction_short_id,
                "product_name": product_name,
                "quantity": row.quantity,
                "unit_price": row.unit_price,
                "staff_name": staff_name,
                "source": if row.is_internal { "Combo incentive" } else { "Staff base rate plus fixed incentives" }
            });

            sqlx::query(
                r#"
                UPDATE commission_events
                SET staff_id = $2,
                    event_type = $3,
                    commissionable_amount = $4,
                    base_rate_used = $5,
                    base_commission_amount = $6,
                    incentive_amount = $7,
                    total_commission_amount = $8,
                    snapshot_json = $9
                WHERE transaction_line_id = $1
                "#,
            )
            .bind(transaction_line_id)
            .bind(sid)
            .bind(event_type)
            .bind(commissionable_amount)
            .bind(breakdown.base_rate)
            .bind(base_commission_amount)
            .bind(incentive_amount)
            .bind(breakdown.total_commission)
            .bind(snapshot_json)
            .execute(&mut *conn)
            .await?;
        } else {
            // Delete the commission event if the salesperson is removed
            sqlx::query("DELETE FROM commission_events WHERE transaction_line_id = $1")
                .bind(transaction_line_id)
                .execute(&mut *conn)
                .await?;
        }
    }

    Ok(Some(breakdown.total_commission))
}

pub async fn recalc_transaction_commissions_after_fulfillment(
    conn: &mut PgConnection,
    transaction_id: Uuid,
    delivered_item_ids: &[Uuid],
) -> Result<u64, sqlx::Error> {
    let rec = ORDER_RECOGNITION_TS_SQL.trim();
    // SAFETY: `rec` is a crate-local `pub const` — never user input.
    let filter_sql = if delivered_item_ids.is_empty() {
        String::new()
    } else {
        "AND oi.id = ANY($2)".to_string()
    };
    let sql = format!(
        r#"
        SELECT
            oi.id,
            oi.salesperson_id,
            oi.unit_price,
            oi.quantity,
            oi.product_id,
            oi.variant_id,
            COALESCE(o.is_employee_purchase, FALSE) AS is_employee_purchase,
            CASE
                WHEN oi.is_fulfilled AND ({rec}) IS NOT NULL THEN ({rec})
                ELSE o.booked_at
            END AS calc_at,
            oi.calculated_commission,
            COALESCE(oi.is_internal, FALSE) AS is_internal,
            COALESCE(o.short_id, 'TXN-' || left(o.id::text, 8)) AS transaction_short_id
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        WHERE oi.transaction_id = $1
          AND o.status::text <> 'cancelled'
          AND NOT EXISTS (
              SELECT 1
              FROM commission_events ce
              WHERE ce.transaction_line_id = oi.id
          )
          AND oi.is_fulfilled = TRUE
          {filter_sql}
        ORDER BY oi.id ASC
        "#,
    );

    let rows = if delivered_item_ids.is_empty() {
        sqlx::query_as::<_, CommissionLineCalcRow>(&sql)
            .bind(transaction_id)
            .fetch_all(&mut *conn)
            .await?
    } else {
        sqlx::query_as::<_, CommissionLineCalcRow>(&sql)
            .bind(transaction_id)
            .bind(delivered_item_ids)
            .fetch_all(&mut *conn)
            .await?
    };

    let mut changed = 0u64;
    for row in rows {
        let new_commission = sales_commission::commission_for_line_at(
            conn,
            CommissionLineInput {
                unit_price: row.unit_price,
                quantity: row.quantity,
                salesperson_id: row.salesperson_id,
                product_id: row.product_id,
                variant_id: row.variant_id,
                is_employee_sale: row.is_employee_purchase,
            },
            row.calc_at,
        )
        .await?;

        if new_commission == row.calculated_commission {
            continue;
        }

        sqlx::query("UPDATE transaction_lines SET calculated_commission = $2 WHERE id = $1")
            .bind(row.id)
            .bind(new_commission)
            .execute(&mut *conn)
            .await?;
        changed += 1;
    }

    Ok(changed)
}
