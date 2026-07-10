use serde_json::Value;
use sqlx::PgPool;
use std::time::Duration;
use uuid::Uuid;

#[allow(clippy::too_many_arguments)]
pub fn record_phase(
    pool: PgPool,
    operation: &'static str,
    phase: &'static str,
    duration: Duration,
    success: bool,
    transaction_id: Option<Uuid>,
    register_session_id: Option<Uuid>,
    metadata: Value,
) {
    tokio::spawn(async move {
        if let Err(error) = sqlx::query(
            r#"
            INSERT INTO operational_phase_metric (
                operation, phase, duration_ms, success, transaction_id,
                register_session_id, metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
        )
        .bind(operation)
        .bind(phase)
        .bind(duration.as_secs_f64() * 1000.0)
        .bind(success)
        .bind(transaction_id)
        .bind(register_session_id)
        .bind(metadata)
        .execute(&pool)
        .await
        {
            tracing::warn!(%error, operation, phase, "operational phase metric write failed");
        }
    });
}
