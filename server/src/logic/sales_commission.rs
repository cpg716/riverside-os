//! Per-line commission snapshot on `transaction_lines.calculated_commission`.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use sqlx::postgres::PgConnection;
use uuid::Uuid;

use crate::logic::pricing::round_money_usd;
use crate::models::DbStaffRole;

#[derive(Clone, Copy)]
pub struct CommissionLineInput {
    pub unit_price: Decimal,
    pub quantity: i32,
    pub salesperson_id: Option<Uuid>,
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub is_employee_sale: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct CommissionBreakdown {
    pub base_rate: Decimal,
    pub commissionable_amount: Decimal,
    pub base_commission: Decimal,
    pub incentive_amount: Decimal,
    pub total_commission: Decimal,
}

/// Retail line gross × staff effective rate plus fixed SPIFF add-ons.
/// Staff Profile is the only base-rate authority; percentage/category overrides are retired.
/// Employee-purchase transactions carry zero commission.
pub async fn commission_for_line(
    conn: &mut PgConnection,
    input: CommissionLineInput,
) -> Result<Decimal, sqlx::Error> {
    commission_for_line_at(conn, input, Utc::now()).await
}

/// Effective-dated commission snapshot. Fulfillment-based recalculation paths use the line's
/// recognition / booked timestamp instead of "right now".
pub async fn commission_for_line_at(
    conn: &mut PgConnection,
    input: CommissionLineInput,
    as_of: DateTime<Utc>,
) -> Result<Decimal, sqlx::Error> {
    Ok(commission_breakdown_for_line_at(conn, input, as_of)
        .await?
        .total_commission)
}

pub async fn commission_breakdown_for_line_at(
    conn: &mut PgConnection,
    input: CommissionLineInput,
    as_of: DateTime<Utc>,
) -> Result<CommissionBreakdown, sqlx::Error> {
    if input.is_employee_sale {
        return Ok(CommissionBreakdown::zero());
    }
    let Some(sid) = input.salesperson_id else {
        return Ok(CommissionBreakdown::zero());
    };
    if input.quantity <= 0 {
        return Ok(CommissionBreakdown::zero());
    }

    let staff_row: Option<(Decimal, DbStaffRole)> = sqlx::query_as(
        r#"
        SELECT
            COALESCE(
                (
                    SELECT h.base_commission_rate
                    FROM staff_commission_rate_history h
                    WHERE h.staff_id = s.id
                      AND h.effective_start_date <= $2
                    ORDER BY h.effective_start_date DESC, h.created_at DESC
                    LIMIT 1
                ),
                s.base_commission_rate
            ) AS base_commission_rate,
            s.role
        FROM staff s
        WHERE s.id = $1 AND s.is_active = TRUE
        "#,
    )
    .bind(sid)
    .bind(as_of.date_naive())
    .fetch_optional(&mut *conn)
    .await?;

    let Some((base_rate, role)) = staff_row else {
        return Ok(CommissionBreakdown::zero());
    };

    if role == DbStaffRole::SalesSupport {
        return Ok(CommissionBreakdown::zero());
    }

    let category_id: Option<Uuid> =
        sqlx::query_scalar("SELECT category_id FROM products WHERE id = $1")
            .bind(input.product_id)
            .fetch_optional(&mut *conn)
            .await?;

    // Fixed-dollar SPIFF lookup only. Percentage/category overrides are intentionally ignored.
    #[derive(sqlx::FromRow)]
    struct SpiffMatch {
        fixed_spiff_amount: Decimal,
    }

    let spiff: Option<SpiffMatch> = sqlx::query_as(
        r#"
        SELECT fixed_spiff_amount
        FROM commission_rules
        WHERE is_active = TRUE
          AND (start_date IS NULL OR start_date <= $4)
          AND (end_date IS NULL OR end_date >= $4)
          AND fixed_spiff_amount > 0
          AND (
            (match_type = 'variant' AND match_id = $1)
            OR (match_type = 'product' AND match_id = $2)
            OR (match_type = 'category' AND match_id = $3)
          )
        ORDER BY 
          CASE match_type 
            WHEN 'variant' THEN 1 
            WHEN 'product' THEN 2 
            WHEN 'category' THEN 3 
          END ASC
        LIMIT 1
        "#,
    )
    .bind(input.variant_id)
    .bind(input.product_id)
    .bind(category_id)
    .bind(as_of.date_naive())
    .fetch_optional(&mut *conn)
    .await?;

    let gross = input.unit_price * Decimal::from(input.quantity);
    let base_commission = round_money_usd(gross * base_rate);
    let incentive_amount = spiff
        .map(|r| r.fixed_spiff_amount * Decimal::from(input.quantity))
        .unwrap_or(Decimal::ZERO);
    Ok(CommissionBreakdown {
        base_rate,
        commissionable_amount: gross,
        base_commission,
        incentive_amount,
        total_commission: round_money_usd(base_commission + incentive_amount),
    })
}

impl CommissionBreakdown {
    pub fn zero() -> Self {
        Self {
            base_rate: Decimal::ZERO,
            commissionable_amount: Decimal::ZERO,
            base_commission: Decimal::ZERO,
            incentive_amount: Decimal::ZERO,
            total_commission: Decimal::ZERO,
        }
    }
}
