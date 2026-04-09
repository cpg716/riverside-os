//! Per-line commission snapshot on `order_items.calculated_commission`.

use rust_decimal::Decimal;
use sqlx::postgres::PgConnection;
use uuid::Uuid;

use crate::logic::pricing::round_money_usd;
use crate::models::DbStaffRole;

/// Retail line gross × effective rate. `sales_support` always 0. Category override wins over staff base.
/// Employee-purchase orders carry zero commission.
pub async fn commission_for_line(
    conn: &mut PgConnection,
    unit_price: Decimal,
    quantity: i32,
    salesperson_id: Option<Uuid>,
    product_id: Uuid,
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

    let override_rate = if let Some(cid) = category_id {
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

    let rate = override_rate.unwrap_or(base_rate);
    let gross = unit_price * Decimal::from(quantity);
    Ok(round_money_usd(gross * rate))
}
