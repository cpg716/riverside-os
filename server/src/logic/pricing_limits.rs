//! Role-based discount caps for POS price overrides (checkout).

use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

use crate::models::DbStaffRole;

pub async fn max_discount_percent_for_staff(
    pool: &PgPool,
    staff_id: Uuid,
) -> Result<Decimal, sqlx::Error> {
    let row: Option<(DbStaffRole, Decimal)> = sqlx::query_as(
        r#"
        SELECT role, max_discount_percent
        FROM staff
        WHERE id = $1 AND is_active = TRUE
        "#,
    )
    .bind(staff_id)
    .fetch_optional(pool)
    .await?;

    let Some((role, pct)) = row else {
        return Ok(Decimal::new(30, 0));
    };

    if role == DbStaffRole::Admin {
        return Ok(Decimal::new(100, 0));
    }

    Ok(pct)
}
pub async fn is_admin_or_manager(pool: &PgPool, staff_id: Uuid) -> Result<bool, sqlx::Error> {
    let role: Option<DbStaffRole> =
        sqlx::query_scalar("SELECT role FROM staff WHERE id = $1 AND is_active = TRUE")
            .bind(staff_id)
            .fetch_optional(pool)
            .await?;

    let Some(r) = role else {
        return Ok(false);
    };

    Ok(r == DbStaffRole::Admin)
}
