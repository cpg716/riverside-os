use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde_json::json;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::logic::pricing::round_money_usd;
use crate::logic::report_basis::ORDER_RECOGNITION_TS_SQL;

#[derive(Debug, Clone)]
pub struct ManualCommissionAdjustment {
    pub staff_id: Uuid,
    pub reporting_date: chrono::NaiveDate,
    pub amount: Decimal,
    pub note: String,
    pub created_by_staff_id: Uuid,
}

#[derive(Debug, Clone)]
pub struct ReturnCommissionAdjustment {
    pub transaction_id: Uuid,
    pub transaction_line_id: Uuid,
    pub return_line_id: Uuid,
    pub returned_qty: i32,
    pub sold_qty: i32,
    pub original_commission: Decimal,
    pub reason: String,
    pub created_by_staff_id: Option<Uuid>,
}

pub async fn upsert_fulfilled_transaction_events(
    tx: &mut Transaction<'_, Postgres>,
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
        WITH line_rows AS (
            SELECT
                oi.id AS transaction_line_id,
                oi.transaction_id,
                oi.salesperson_id,
                COALESCE(oi.is_internal, FALSE) AS is_internal,
                COALESCE(oi.custom_item_type, '') AS custom_item_type,
                oi.unit_price,
                oi.quantity,
                oi.calculated_commission,
                COALESCE(({rec}), oi.fulfilled_at, o.fulfilled_at, o.booked_at) AS event_at,
                COALESCE(o.short_id, 'TXN-' || left(o.id::text, 8)) AS transaction_short_id,
                p.name AS product_name,
                st.full_name AS staff_name,
                COALESCE((
                    SELECT h.base_commission_rate
                    FROM staff_commission_rate_history h
                    WHERE h.staff_id = oi.salesperson_id
                      AND h.effective_start_date <= COALESCE(({rec}), oi.fulfilled_at, o.fulfilled_at, o.booked_at)::date
                    ORDER BY h.effective_start_date DESC, h.created_at DESC
                    LIMIT 1
                ), st.base_commission_rate, 0) AS base_rate_used
            FROM transaction_lines oi
            INNER JOIN transactions o ON o.id = oi.transaction_id
            LEFT JOIN products p ON p.id = oi.product_id
            LEFT JOIN staff st ON st.id = oi.salesperson_id
            WHERE oi.transaction_id = $1
              AND o.status::text <> 'cancelled'
              AND oi.is_fulfilled = TRUE
              AND COALESCE(({rec}), oi.fulfilled_at, o.fulfilled_at, o.booked_at) IS NOT NULL
              AND oi.salesperson_id IS NOT NULL
              AND oi.calculated_commission <> 0
              {filter_sql}
        ),
        prepared AS (
            SELECT
                *,
                CASE WHEN is_internal THEN 'combo_incentive' ELSE 'sale_commission' END AS event_type,
                CASE WHEN is_internal THEN 0 ELSE (unit_price * quantity)::numeric(14, 2) END AS commissionable_amount,
                CASE
                    WHEN is_internal THEN 0
                    ELSE ROUND((unit_price * quantity) * base_rate_used, 2)
                END AS base_commission_amount
            FROM line_rows
        )
        INSERT INTO commission_events (
            staff_id, transaction_id, transaction_line_id, source_event_id, event_type,
            event_at, reporting_date, commissionable_amount, base_rate_used,
            base_commission_amount, incentive_amount, adjustment_amount,
            total_commission_amount, snapshot_json, note
        )
        SELECT
            salesperson_id,
            transaction_id,
            transaction_line_id,
            transaction_line_id,
            event_type,
            event_at,
            event_at::date,
            commissionable_amount,
            base_rate_used,
            base_commission_amount,
            CASE
                WHEN is_internal THEN calculated_commission
                ELSE calculated_commission - base_commission_amount
            END,
            0,
            calculated_commission,
            jsonb_build_object(
                'transaction_short_id', transaction_short_id,
                'product_name', product_name,
                'quantity', quantity,
                'unit_price', unit_price,
                'staff_name', staff_name,
                'source', CASE WHEN is_internal THEN 'Combo incentive' ELSE 'Staff base rate plus fixed incentives' END
            ),
            CASE WHEN is_internal THEN 'Combo/SPIFF internal incentive event.' ELSE 'Sale commission event.' END
        FROM prepared
        ON CONFLICT (source_event_id, event_type)
        WHERE source_event_id IS NOT NULL
        DO UPDATE SET
            event_at = EXCLUDED.event_at,
            reporting_date = EXCLUDED.reporting_date,
            commissionable_amount = EXCLUDED.commissionable_amount,
            base_rate_used = EXCLUDED.base_rate_used,
            base_commission_amount = EXCLUDED.base_commission_amount,
            incentive_amount = EXCLUDED.incentive_amount,
            total_commission_amount = EXCLUDED.total_commission_amount,
            snapshot_json = EXCLUDED.snapshot_json
        "#,
    );

    let res = if delivered_item_ids.is_empty() {
        sqlx::query(&sql)
            .bind(transaction_id)
            .execute(&mut **tx)
            .await?
    } else {
        sqlx::query(&sql)
            .bind(transaction_id)
            .bind(delivered_item_ids)
            .execute(&mut **tx)
            .await?
    };
    Ok(res.rows_affected())
}

pub async fn insert_return_adjustment_event(
    tx: &mut Transaction<'_, Postgres>,
    adjustment_input: ReturnCommissionAdjustment,
) -> Result<(), sqlx::Error> {
    if adjustment_input.returned_qty <= 0
        || adjustment_input.sold_qty <= 0
        || adjustment_input.original_commission <= Decimal::ZERO
    {
        return Ok(());
    }
    let adjustment = -round_money_usd(
        adjustment_input.original_commission * Decimal::from(adjustment_input.returned_qty)
            / Decimal::from(adjustment_input.sold_qty),
    );
    if adjustment == Decimal::ZERO {
        return Ok(());
    }

    sqlx::query(
        r#"
        INSERT INTO commission_events (
            staff_id, transaction_id, transaction_line_id, source_event_id, event_type,
            event_at, reporting_date, commissionable_amount, base_rate_used,
            base_commission_amount, incentive_amount, adjustment_amount,
            total_commission_amount, snapshot_json, note, created_by_staff_id
        )
        SELECT
            oi.salesperson_id,
            oi.transaction_id,
            oi.id,
            $3,
            'return_adjustment',
            NOW(),
            (NOW() AT TIME ZONE 'UTC')::date,
            0,
            0,
            0,
            0,
            $4,
            $4,
            jsonb_build_object(
                'transaction_short_id', COALESCE(o.short_id, 'TXN-' || left(o.id::text, 8)),
                'product_name', p.name,
                'returned_quantity', $5,
                'sold_quantity', $6,
                'reason', $7,
                'source', 'Return adjustment'
            ),
            $7,
            $8
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.transaction_id = $1 AND oi.id = $2 AND oi.salesperson_id IS NOT NULL
        ON CONFLICT (source_event_id, event_type)
        WHERE source_event_id IS NOT NULL
        DO NOTHING
        "#,
    )
    .bind(adjustment_input.transaction_id)
    .bind(adjustment_input.transaction_line_id)
    .bind(adjustment_input.return_line_id)
    .bind(adjustment)
    .bind(adjustment_input.returned_qty)
    .bind(adjustment_input.sold_qty)
    .bind(adjustment_input.reason)
    .bind(adjustment_input.created_by_staff_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub async fn insert_manual_adjustment(
    tx: &mut Transaction<'_, Postgres>,
    adj: ManualCommissionAdjustment,
) -> Result<Uuid, sqlx::Error> {
    let id = Uuid::new_v4();
    let event_at: DateTime<Utc> = DateTime::from_naive_utc_and_offset(
        adj.reporting_date
            .and_hms_opt(12, 0, 0)
            .unwrap_or_else(|| Utc::now().naive_utc()),
        Utc,
    );
    sqlx::query(
        r#"
        INSERT INTO commission_events (
            id, staff_id, source_event_id, event_type, event_at, reporting_date,
            adjustment_amount, total_commission_amount, snapshot_json, note, created_by_staff_id
        )
        VALUES ($1, $2, $1, 'manual_adjustment', $3, $4, $5, $5, $6, $7, $8)
        "#,
    )
    .bind(id)
    .bind(adj.staff_id)
    .bind(event_at)
    .bind(adj.reporting_date)
    .bind(adj.amount)
    .bind(json!({
        "source": "Manual adjustment",
        "note": adj.note,
    }))
    .bind(adj.note)
    .bind(adj.created_by_staff_id)
    .execute(&mut **tx)
    .await?;
    Ok(id)
}
