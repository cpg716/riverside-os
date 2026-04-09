//! Idempotent DDL for staff contacts + RBAC (`migrations/34_staff_contacts_and_permissions.sql`).
//! Runs once at process start so a database that only had older migrations still matches the server.

use sqlx::PgPool;

const STAFF_RBAC_SQL: &str = include_str!("../../migrations/34_staff_contacts_and_permissions.sql");
const CP_FINISHING_SQL: &str =
    include_str!("../../migrations/114_counterpoint_historical_finishing.sql");

/// Ensures core database schema requirements are met (RBAC, Counterpoint Finishing, etc).
/// Safe to call on every startup.
pub async fn ensure_core_schema(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(STAFF_RBAC_SQL).execute(pool).await?;
    sqlx::raw_sql(CP_FINISHING_SQL).execute(pool).await?;
    Ok(())
}
