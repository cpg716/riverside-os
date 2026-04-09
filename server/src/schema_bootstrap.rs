//! Idempotent DDL for staff contacts + RBAC (`migrations/34_staff_contacts_and_permissions.sql`).
//! Runs once at process start so a database that only had older migrations still matches the server.

use sqlx::PgPool;

const STAFF_RBAC_SQL: &str = include_str!("../../migrations/34_staff_contacts_and_permissions.sql");

/// Ensures `staff.phone` / `staff.email`, `staff_role_permission`, and `staff_permission_override`
/// exist with seed data. Safe to call on every startup (matches migration 34 semantics).
pub async fn ensure_staff_rbac_schema(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(STAFF_RBAC_SQL).execute(pool).await?;
    Ok(())
}
