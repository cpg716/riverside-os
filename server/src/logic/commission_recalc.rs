use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use sqlx::postgres::PgConnection;
use sqlx::FromRow;
use uuid::Uuid;

use crate::logic::report_basis::ORDER_RECOGNITION_TS_SQL;
use crate::logic::sales_commission;

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
}

pub async fn recalc_staff_commissions_from(
    conn: &mut PgConnection,
    staff_id: Uuid,
    effective_start_date: NaiveDate,
) -> Result<u64, sqlx::Error> {
    let rec = ORDER_RECOGNITION_TS_SQL.trim();
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
            oi.calculated_commission
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        WHERE oi.salesperson_id = $1
          AND o.status::text <> 'cancelled'
          AND oi.commission_payout_finalized_at IS NULL
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
            row.unit_price,
            row.quantity,
            row.salesperson_id,
            row.product_id,
            row.variant_id,
            row.is_employee_purchase,
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
            oi.calculated_commission
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        WHERE oi.id = $1
          AND oi.transaction_id = $2
          AND o.status::text <> 'cancelled'
          AND oi.commission_payout_finalized_at IS NULL
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

    let new_commission = sales_commission::commission_for_line_at(
        conn,
        row.unit_price,
        row.quantity,
        salesperson_id,
        row.product_id,
        row.variant_id,
        row.is_employee_purchase,
        row.calc_at,
    )
    .await?;

    sqlx::query(
        "UPDATE transaction_lines SET salesperson_id = $2, calculated_commission = $3 WHERE id = $1",
    )
    .bind(transaction_line_id)
    .bind(salesperson_id)
    .bind(new_commission)
    .execute(&mut *conn)
    .await?;

    Ok(Some(new_commission))
}

pub async fn recalc_transaction_commissions_after_fulfillment(
    conn: &mut PgConnection,
    transaction_id: Uuid,
    delivered_item_ids: &[Uuid],
) -> Result<u64, sqlx::Error> {
    let rec = ORDER_RECOGNITION_TS_SQL.trim();
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
            oi.calculated_commission
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        WHERE oi.transaction_id = $1
          AND o.status::text <> 'cancelled'
          AND oi.commission_payout_finalized_at IS NULL
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
            row.unit_price,
            row.quantity,
            row.salesperson_id,
            row.product_id,
            row.variant_id,
            row.is_employee_purchase,
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
