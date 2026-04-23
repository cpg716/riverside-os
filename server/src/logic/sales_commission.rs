//! Per-line commission snapshot on `transaction_lines.calculated_commission`.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use sqlx::postgres::PgConnection;
use uuid::Uuid;

use crate::logic::pricing::round_money_usd;
use crate::models::DbStaffRole;

/// Retail line gross × effective rate. Precedence: Variant Rule > Product Rule > Category Rule > Category Legacy Override > Staff Base.
/// Employee-purchase transactions carry zero commission.
pub async fn commission_for_line(
    conn: &mut PgConnection,
    unit_price: Decimal,
    quantity: i32,
    salesperson_id: Option<Uuid>,
    product_id: Uuid,
    variant_id: Uuid,
    is_employee_sale: bool,
) -> Result<Decimal, sqlx::Error> {
    commission_for_line_at(
        conn,
        unit_price,
        quantity,
        salesperson_id,
        product_id,
        variant_id,
        is_employee_sale,
        Utc::now(),
    )
    .await
}

/// Effective-dated commission snapshot. Fulfillment-based recalculation paths use the line's
/// recognition / booked timestamp instead of "right now".
pub async fn commission_for_line_at(
    conn: &mut PgConnection,
    unit_price: Decimal,
    quantity: i32,
    salesperson_id: Option<Uuid>,
    product_id: Uuid,
    variant_id: Uuid,
    is_employee_sale: bool,
    as_of: DateTime<Utc>,
) -> Result<Decimal, sqlx::Error> {
    if is_employee_sale {
        return Ok(Decimal::ZERO);
    }
    let Some(sid) = salesperson_id else {
        return Ok(Decimal::ZERO);
    };
    if quantity <= 0 {
        return Ok(Decimal::ZERO);
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
        return Ok(Decimal::ZERO);
    };

    if role == DbStaffRole::SalesSupport {
        return Ok(Decimal::ZERO);
    }

    let category_id: Option<Uuid> =
        sqlx::query_scalar("SELECT category_id FROM products WHERE id = $1")
            .bind(product_id)
            .fetch_optional(&mut *conn)
            .await?;

    // 1) specificity-based rule lookup (Variant > Product > Category)
    #[derive(sqlx::FromRow)]
    struct RuleMatch {
        override_rate: Option<Decimal>,
        fixed_spiff_amount: Decimal,
    }

    let rule: Option<RuleMatch> = sqlx::query_as(
        r#"
        SELECT override_rate, fixed_spiff_amount
        FROM commission_rules
        WHERE is_active = TRUE
          AND (start_date IS NULL OR start_date <= $4)
          AND (end_date IS NULL OR end_date >= $4)
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
    .bind(variant_id)
    .bind(product_id)
    .bind(category_id)
    .bind(as_of.date_naive())
    .fetch_optional(&mut *conn)
    .await?;

    let (rate, flat_bonus) = if let Some(r) = rule {
        (
            r.override_rate.unwrap_or(base_rate),
            r.fixed_spiff_amount * Decimal::from(quantity),
        )
    } else {
        // Fallback to legacy category overrides
        let legacy_override = if let Some(cid) = category_id {
            sqlx::query_scalar::<_, Decimal>(
                r#"
                SELECT commission_rate
                FROM category_commission_overrides
                WHERE category_id = $1
                "#,
            )
            .bind(cid)
            .fetch_optional(&mut *conn)
            .await?
        } else {
            None
        };
        (legacy_override.unwrap_or(base_rate), Decimal::ZERO)
    };

    let gross = unit_price * Decimal::from(quantity);
    Ok(round_money_usd(gross * rate + flat_bonus))
}
