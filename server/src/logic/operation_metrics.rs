use serde_json::Value;
use sqlx::PgPool;
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct PosJourneyMetricSample {
    pub phase: &'static str,
    pub duration_ms: f64,
    pub success: bool,
    pub runtime_surface: &'static str,
    pub online: bool,
}

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

pub async fn record_pos_journey_batch(
    pool: &PgPool,
    register_session_id: Uuid,
    client_build_sha: Option<&str>,
    station_key: Option<&str>,
    samples: &[PosJourneyMetricSample],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for sample in samples {
        let metadata = serde_json::json!({
            "runtime_surface": sample.runtime_surface,
            "online": sample.online,
            "client_build_sha": client_build_sha,
            "station_key": station_key,
        });
        sqlx::query(
            r#"
            INSERT INTO operational_phase_metric (
                operation, phase, duration_ms, success, transaction_id,
                register_session_id, metadata
            )
            VALUES ('pos_journey', $1, $2, $3, NULL, $4, $5)
            "#,
        )
        .bind(sample.phase)
        .bind(sample.duration_ms)
        .bind(sample.success)
        .bind(register_session_id)
        .bind(metadata)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}
