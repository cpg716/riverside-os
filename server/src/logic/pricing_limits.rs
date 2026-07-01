//! Role-based discount caps for POS price overrides (checkout).

use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::permissions::{
    effective_permissions_for_staff, staff_has_permission, MANAGER_APPROVAL,
};
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
    let row: Option<(DbStaffRole,)> =
        sqlx::query_as("SELECT role FROM staff WHERE id = $1 AND is_active = TRUE")
            .bind(staff_id)
            .fetch_optional(pool)
            .await?;

    let Some((role,)) = row else {
        return Ok(false);
    };

    let effective = effective_permissions_for_staff(pool, staff_id, role).await?;
    Ok(staff_has_permission(&effective, MANAGER_APPROVAL))
}
