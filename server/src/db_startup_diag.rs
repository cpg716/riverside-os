//! One-shot PostgreSQL context at process start (no secrets). Helps confirm which DB/session the pool sees.

use sqlx::PgPool;
use tracing::{info, warn};

#[derive(Debug, sqlx::FromRow)]
pub struct PostgresStartupContext {
    pub current_database: String,
    pub db_user: String,
    pub server_inet: Option<String>,
    pub server_port: Option<i32>,
    pub search_path: String,
    pub weather_finalize_ledger: Option<String>,
    pub weather_vc_daily_usage: Option<String>,
}

/// Logs identity of the connected database, server endpoint, `search_path`, and key weather DDL visibility.
/// Does not log `DATABASE_URL` or credentials. Failure is non-fatal (warn only).
pub async fn log_postgres_startup_context(pool: &PgPool) {
    let row = sqlx::query_as::<_, PostgresStartupContext>(
        r#"
        SELECT
            current_database() AS current_database,
            current_user::text AS db_user,
            NULLIF(inet_server_addr()::text, '') AS server_inet,
            inet_server_port() AS server_port,
            COALESCE(current_setting('search_path', true), '') AS search_path,
            to_regclass('public.weather_snapshot_finalize_ledger')::text AS weather_finalize_ledger,
            to_regclass('public.weather_vc_daily_usage')::text AS weather_vc_daily_usage
        "#,
    )
    .fetch_one(pool)
    .await;

    match row {
        Ok(ctx) => {
            info!(
                current_database = %ctx.current_database,
                db_user = %ctx.db_user,
                server_inet = ?ctx.server_inet,
                server_port = ?ctx.server_port,
                search_path = %ctx.search_path,
                weather_finalize_ledger = ?ctx.weather_finalize_ledger,
                weather_vc_daily_usage = ?ctx.weather_vc_daily_usage,
                "PostgreSQL startup context (compare with migration target DB)"
            );
        }
        Err(e) => {
            warn!(
                error = %e,
                "Could not read PostgreSQL startup context (diagnostic query failed)"
            );
        }
    }
}
