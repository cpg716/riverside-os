//! Per-line commission snapshot on `order_items.calculated_commission`.

use rust_decimal::Decimal;
use sqlx::postgres::PgConnection;
use uuid::Uuid;

use crate::logic::pricing::round_money_usd;
use crate::models::DbStaffRole;

/// Retail line gross × effective rate. Precedence: Variant Rule > Product Rule > Category Rule > Category Legacy Override > Staff Base.
/// Employee-purchase orders carry zero commission.
pub async fn commission_for_line(
    conn: &mut PgConnection,
    unit_price: Decimal,
    quantity: i32,
    salesperson_id: Option<Uuid>,
    product_id: Uuid,
    variant_id: Uuid,
    is_employee_sale: bool,
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
        SELECT base_commission_rate, role
        FROM staff
        WHERE id = $1 AND is_active = TRUE
        "#,
    )
    .bind(sid)
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
          AND (start_date IS NULL OR start_date <= now())
          AND (end_date IS NULL OR end_date >= now())
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
