//! Health check endpoints for orchestration and monitoring

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use super::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub version: String,
    pub build_sha: String,
    pub uptime_seconds: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReadyResponse {
    pub status: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub build_sha: String,
    pub database: DatabaseStatus,
    pub background_workers: WorkerStatus,
    pub backup: BackupReadinessStatus,
    /// Required dependencies/workers that are not currently ready. Empty only when status is
    /// `ready`; callers must not infer readiness from HTTP reachability alone.
    pub unavailable_components: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DatabaseStatus {
    pub connected: bool,
    pub pool_size: u32,
    pub active_connections: u32,
    pub idle_connections: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkerStatus {
    pub backup_worker: bool,
    pub notification_worker: bool,
    pub email_worker: bool,
    pub podium_worker: bool,
    pub weather_worker: bool,
    pub qbo_sync_worker: bool,
    pub job_queue_worker: bool,
    pub metrics_worker: bool,
    pub redis_configured: bool,
    pub redis_connected: bool,
    pub job_queue_enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupReadinessStatus {
    pub worker_healthy: bool,
    pub tooling_ready: bool,
    pub artifact_usable: bool,
    pub recent_verified_backup: bool,
    pub last_verified_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_verified_filename: Option<String>,
    pub verification_method: Option<String>,
    pub last_verified_size_bytes: Option<i64>,
    pub last_failure_at: Option<chrono::DateTime<chrono::Utc>>,
    pub max_age_hours: i64,
}

// Shared state for tracking worker health
pub static WORKER_HEALTH: tokio::sync::OnceCell<RwLock<WorkerHealth>> =
    tokio::sync::OnceCell::const_new();

const DATABASE_HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const BACKUP_EVIDENCE_TIMEOUT: Duration = Duration::from_secs(1);
const BACKUP_TOOLING_TIMEOUT: Duration = Duration::from_secs(2);
const BACKUP_ARTIFACT_TIMEOUT: Duration = Duration::from_secs(3);
// Redis is an optional acceleration layer. A stalled Redis node must not make
// a healthy Main Hub look offline to a POS workstation.
const REDIS_HEALTH_TIMEOUT: Duration = Duration::from_millis(500);
const JOB_QUEUE_HEARTBEAT_MAX_AGE_SECONDS: u64 = 60;

#[derive(Debug, Default)]
pub struct WorkerHealth {
    pub backup_worker: Option<Instant>,
    pub notification_worker: Option<Instant>,
    pub email_worker: Option<Instant>,
    pub podium_worker: Option<Instant>,
    pub weather_worker: Option<Instant>,
    pub qbo_sync_worker: Option<Instant>,
    pub job_queue_worker: Option<Instant>,
    pub metrics_worker: Option<Instant>,
}

impl WorkerHealth {
    pub async fn mark_heartbeat(worker: &str) {
        let lock = WORKER_HEALTH
            .get_or_init(|| async { RwLock::new(WorkerHealth::default()) })
            .await;
        let mut health = lock.write().await;
        let now = Instant::now();
        match worker {
            "backup" => health.backup_worker = Some(now),
            "notification" => health.notification_worker = Some(now),
            "email" => health.email_worker = Some(now),
            "podium" => health.podium_worker = Some(now),
            "weather" => health.weather_worker = Some(now),
            "qbo_sync" => health.qbo_sync_worker = Some(now),
            "job_queue" => health.job_queue_worker = Some(now),
            "metrics" => health.metrics_worker = Some(now),
            _ => {}
        }
    }

    pub async fn is_healthy(worker: &str, threshold_secs: u64) -> bool {
        let lock = WORKER_HEALTH
            .get_or_init(|| async { RwLock::new(WorkerHealth::default()) })
            .await;
        let health = lock.read().await;
        let threshold = std::time::Duration::from_secs(threshold_secs);
        let last = match worker {
            "backup" => health.backup_worker,
            "notification" => health.notification_worker,
            "email" => health.email_worker,
            "podium" => health.podium_worker,
            "weather" => health.weather_worker,
            "qbo_sync" => health.qbo_sync_worker,
            "job_queue" => health.job_queue_worker,
            "metrics" => health.metrics_worker,
            _ => None,
        };
        last.map(|t| t.elapsed() < threshold).unwrap_or(false)
    }
}

/// Basic health check - always returns 200 if app is running
pub async fn health() -> Result<Json<HealthResponse>, StatusCode> {
    let response = HealthResponse {
        status: "healthy".to_string(),
        timestamp: chrono::Utc::now(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        build_sha: build_sha().to_string(),
        uptime_seconds: uptime_seconds(),
    };

    Ok(Json(response))
}

/// Readiness check - verifies dependencies are ready
pub async fn ready(State(state): State<AppState>) -> Response {
    // Check database connectivity
    let database_status = match check_database_health(&state.db).await {
        Ok(status) => status,
        Err(error) => {
            tracing::warn!(%error, "readiness database check failed");
            DatabaseStatus {
                connected: false,
                pool_size: state.db.size(),
                active_connections: 0,
                idle_connections: state.db.num_idle() as u32,
            }
        }
    };

    // Check background workers using actual heartbeats
    let backup_worker_healthy = WorkerHealth::is_healthy("backup", 7200).await;
    let worker_status = WorkerStatus {
        backup_worker: backup_worker_healthy,
        notification_worker: WorkerHealth::is_healthy("notification", 7200).await,
        email_worker: WorkerHealth::is_healthy("email", 7200).await,
        podium_worker: WorkerHealth::is_healthy("podium", 86400).await,
        weather_worker: WorkerHealth::is_healthy("weather", 7200).await,
        qbo_sync_worker: WorkerHealth::is_healthy("qbo_sync", 7200).await,
        job_queue_worker: WorkerHealth::is_healthy(
            "job_queue",
            JOB_QUEUE_HEARTBEAT_MAX_AGE_SECONDS,
        )
        .await,
        metrics_worker: WorkerHealth::is_healthy("metrics", 7200).await,
        redis_configured: std::env::var("RIVERSIDE_REDIS_URL")
            .ok()
            .is_some_and(|value| !value.trim().is_empty()),
        redis_connected: check_redis_health(&state.cache).await,
        job_queue_enabled: crate::jobs::enabled_from_env(),
    };
    let backup_status = if database_status.connected {
        check_backup_readiness(&state.db, backup_worker_healthy).await
    } else {
        unavailable_backup_readiness(backup_worker_healthy)
    };

    let unavailable_components =
        readiness_failures(&database_status, &worker_status, &backup_status);
    let blocking_components = blocking_readiness_failures(&database_status, &worker_status);
    let status = if !blocking_components.is_empty() {
        "not_ready"
    } else if unavailable_components.is_empty() {
        "ready"
    } else {
        "degraded"
    };
    let response = ReadyResponse {
        status: status.to_string(),
        timestamp: chrono::Utc::now(),
        build_sha: build_sha().to_string(),
        database: database_status,
        background_workers: worker_status,
        backup: backup_status,
        unavailable_components,
    };

    (
        if blocking_components.is_empty() {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(response),
    )
        .into_response()
}

/// Liveness check - verifies the app is not deadlocked
pub async fn live() -> Result<Json<serde_json::Value>, StatusCode> {
    // Simple liveness check - if we can respond, we're alive
    let response = serde_json::json!({
        "status": "alive",
        "timestamp": chrono::Utc::now(),
        "uptime_seconds": uptime_seconds()
    });

    Ok(Json(response))
}

async fn check_database_health(pool: &PgPool) -> Result<DatabaseStatus, String> {
    // Test database connectivity with a simple query
    let _: i32 = tokio::time::timeout(
        DATABASE_HEALTH_TIMEOUT,
        sqlx::query_scalar("SELECT 1").fetch_one(pool),
    )
    .await
    .map_err(|_| "database health check timed out".to_string())?
    .map_err(|error| error.to_string())?;

    let pool_size = pool.size();
    let idle_connections = pool.num_idle() as u32;
    let active_connections = pool_size.saturating_sub(idle_connections);

    Ok(DatabaseStatus {
        connected: true,
        pool_size,
        active_connections,
        idle_connections,
    })
}

async fn check_redis_health(cache: &Option<crate::cache::CacheService>) -> bool {
    let Some(svc) = cache else { return false };
    match tokio::time::timeout(REDIS_HEALTH_TIMEOUT, svc.redis().ping()).await {
        Ok(Ok(_)) => true,
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "Redis health check failed");
            false
        }
        Err(_) => {
            tracing::warn!("Redis health check timed out");
            false
        }
    }
}

fn backup_max_age_hours() -> i64 {
    std::env::var("RIVERSIDE_BACKUP_OVERDUE_HOURS")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|hours| (1..=720).contains(hours))
        .unwrap_or(30)
}

async fn check_backup_readiness(pool: &PgPool, worker_healthy: bool) -> BackupReadinessStatus {
    let max_age_hours = backup_max_age_hours();
    let row = tokio::time::timeout(
        BACKUP_EVIDENCE_TIMEOUT,
        sqlx::query_as::<
            _,
            (
                Option<chrono::DateTime<chrono::Utc>>,
                Option<String>,
                Option<String>,
                Option<i64>,
                Option<String>,
                Option<chrono::DateTime<chrono::Utc>>,
                i32,
            ),
        >(
            r#"
            SELECT
                health.last_local_verified_at,
                health.last_local_verified_filename,
                health.last_local_verification_method,
                health.last_local_verified_size_bytes,
                health.last_local_verified_sha256,
                health.last_local_failure_at,
                current_setting('server_version_num')::integer
            FROM (VALUES (1::smallint)) AS singleton(id)
            LEFT JOIN store_backup_health health ON health.id = singleton.id
            "#,
        )
        .fetch_one(pool),
    )
    .await;

    let (
        last_verified_at,
        last_verified_filename,
        verification_method,
        last_verified_size_bytes,
        last_verified_sha256,
        last_failure_at,
        server_major,
    ) = match row {
        Ok(Ok((verified, filename, method, size_bytes, sha256, failure, server_version_num))) => (
            verified,
            filename,
            method,
            size_bytes,
            sha256,
            failure,
            Some((server_version_num / 10_000) as u32),
        ),
        Ok(Err(error)) => {
            tracing::warn!(%error, "readiness backup evidence check failed");
            (None, None, None, None, None, None, None)
        }
        Err(_) => {
            tracing::warn!("readiness backup evidence check timed out");
            (None, None, None, None, None, None, None)
        }
    };
    let evidence_is_recent = verified_backup_is_recent(
        last_verified_at,
        last_failure_at,
        chrono::Utc::now(),
        max_age_hours,
    );
    let artifact_usable = match (
        last_verified_filename.clone(),
        last_verified_size_bytes,
        last_verified_sha256.clone(),
    ) {
        (Some(filename), Some(size_bytes), Some(sha256)) => {
            match tokio::time::timeout(
                BACKUP_ARTIFACT_TIMEOUT,
                tokio::task::spawn_blocking(move || {
                    crate::logic::backups::verify_local_backup_artifact_evidence(
                        &filename, size_bytes, &sha256,
                    )
                }),
            )
            .await
            {
                Ok(Ok(Ok(()))) => true,
                Ok(Ok(Err(error))) => {
                    tracing::warn!(%error, "readiness verified backup artifact is unusable");
                    false
                }
                Ok(Err(error)) => {
                    tracing::warn!(%error, "readiness backup artifact verification task failed");
                    false
                }
                Err(_) => {
                    tracing::warn!("readiness backup artifact verification timed out");
                    false
                }
            }
        }
        _ => false,
    };
    let recent_verified_backup = evidence_is_recent && artifact_usable;
    let tooling_ready = match tokio::time::timeout(
        BACKUP_TOOLING_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            crate::logic::backups::backup_tooling_compatible_with_server(server_major)
        }),
    )
    .await
    {
        Ok(Ok(ready)) => ready,
        Ok(Err(error)) => {
            tracing::warn!(%error, "readiness backup tooling probe failed");
            false
        }
        Err(_) => {
            tracing::warn!("readiness backup tooling probe timed out");
            false
        }
    };

    BackupReadinessStatus {
        worker_healthy,
        tooling_ready,
        artifact_usable,
        recent_verified_backup,
        last_verified_at,
        last_verified_filename,
        verification_method,
        last_verified_size_bytes,
        last_failure_at,
        max_age_hours,
    }
}

fn unavailable_backup_readiness(worker_healthy: bool) -> BackupReadinessStatus {
    BackupReadinessStatus {
        worker_healthy,
        tooling_ready: false,
        artifact_usable: false,
        recent_verified_backup: false,
        last_verified_at: None,
        last_verified_filename: None,
        verification_method: None,
        last_verified_size_bytes: None,
        last_failure_at: None,
        max_age_hours: backup_max_age_hours(),
    }
}

fn verified_backup_is_recent(
    last_verified_at: Option<chrono::DateTime<chrono::Utc>>,
    last_failure_at: Option<chrono::DateTime<chrono::Utc>>,
    now: chrono::DateTime<chrono::Utc>,
    max_age_hours: i64,
) -> bool {
    last_verified_at.is_some_and(|verified| {
        verified >= now - chrono::Duration::hours(max_age_hours)
            && last_failure_at.is_none_or(|failure| failure <= verified)
    })
}

fn start_time() -> &'static Instant {
    static START_TIME: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START_TIME.get_or_init(Instant::now)
}

fn build_sha() -> &'static str {
    env!("RIVERSIDE_GIT_SHA")
}

pub(crate) fn initialize_uptime() {
    let _ = start_time();
}

pub(crate) fn uptime_seconds() -> u64 {
    start_time().elapsed().as_secs()
}

fn readiness_failures(
    database: &DatabaseStatus,
    workers: &WorkerStatus,
    backup: &BackupReadinessStatus,
) -> Vec<String> {
    let mut failures = Vec::new();
    if !database.connected {
        failures.push("database".to_string());
    }
    for (name, healthy) in [
        ("backup_worker", workers.backup_worker),
        ("notification_worker", workers.notification_worker),
        ("email_worker", workers.email_worker),
        ("podium_worker", workers.podium_worker),
        ("weather_worker", workers.weather_worker),
        ("qbo_sync_worker", workers.qbo_sync_worker),
        ("metrics_worker", workers.metrics_worker),
    ] {
        if !healthy {
            failures.push(name.to_string());
        }
    }
    if workers.redis_configured && !workers.redis_connected {
        failures.push("redis".to_string());
    }
    if workers.job_queue_enabled && !workers.job_queue_worker {
        failures.push("job_queue_worker".to_string());
    }
    if !backup.tooling_ready {
        failures.push("backup_tooling".to_string());
    }
    if !backup.recent_verified_backup {
        failures.push("backup_recent_verified".to_string());
    }
    failures
}

fn blocking_readiness_failures(database: &DatabaseStatus, workers: &WorkerStatus) -> Vec<String> {
    let mut failures = Vec::new();
    if !database.connected {
        failures.push("database".to_string());
    }
    if workers.job_queue_enabled && !workers.job_queue_worker {
        failures.push("job_queue_worker".to_string());
    }
    failures
}

#[cfg(test)]
mod tests {
    use super::{
        blocking_readiness_failures, readiness_failures, unavailable_backup_readiness,
        verified_backup_is_recent, BackupReadinessStatus, DatabaseStatus, WorkerHealth,
        WorkerStatus, JOB_QUEUE_HEARTBEAT_MAX_AGE_SECONDS,
    };

    fn healthy_workers() -> WorkerStatus {
        WorkerStatus {
            backup_worker: true,
            notification_worker: true,
            email_worker: true,
            podium_worker: true,
            weather_worker: true,
            qbo_sync_worker: true,
            job_queue_worker: false,
            metrics_worker: true,
            redis_configured: false,
            redis_connected: false,
            job_queue_enabled: false,
        }
    }

    fn healthy_backup() -> BackupReadinessStatus {
        BackupReadinessStatus {
            worker_healthy: true,
            tooling_ready: true,
            artifact_usable: true,
            recent_verified_backup: true,
            last_verified_at: Some(chrono::Utc::now()),
            last_verified_filename: Some("backup_verified.dump".to_string()),
            verification_method: Some("pg_restore_catalog".to_string()),
            last_verified_size_bytes: Some(1024),
            last_failure_at: None,
            max_age_hours: 30,
        }
    }

    #[test]
    fn optional_redis_and_disabled_job_queue_do_not_fail_readiness() {
        let database = DatabaseStatus {
            connected: true,
            pool_size: 4,
            active_connections: 1,
            idle_connections: 3,
        };
        assert!(readiness_failures(&database, &healthy_workers(), &healthy_backup()).is_empty());
        assert!(blocking_readiness_failures(&database, &healthy_workers()).is_empty());
    }

    #[test]
    fn configured_dependencies_and_required_workers_fail_closed() {
        let database = DatabaseStatus {
            connected: true,
            pool_size: 4,
            active_connections: 1,
            idle_connections: 3,
        };
        let mut workers = healthy_workers();
        workers.redis_configured = true;
        workers.job_queue_enabled = true;
        workers.metrics_worker = false;
        assert_eq!(
            readiness_failures(&database, &workers, &healthy_backup()),
            vec!["metrics_worker", "redis", "job_queue_worker"]
        );
        assert_eq!(
            blocking_readiness_failures(&database, &workers),
            vec!["job_queue_worker"]
        );
    }

    #[tokio::test]
    async fn successful_job_queue_poll_heartbeat_is_immediately_healthy() {
        WorkerHealth::mark_heartbeat("job_queue").await;
        assert!(WorkerHealth::is_healthy("job_queue", JOB_QUEUE_HEARTBEAT_MAX_AGE_SECONDS).await);
    }

    #[test]
    fn missing_verified_backup_degrades_without_blocking_register_connectivity() {
        let database = DatabaseStatus {
            connected: true,
            pool_size: 4,
            active_connections: 1,
            idle_connections: 3,
        };
        let mut backup = healthy_backup();
        backup.recent_verified_backup = false;
        assert_eq!(
            readiness_failures(&database, &healthy_workers(), &backup),
            vec!["backup_recent_verified"]
        );
        assert!(blocking_readiness_failures(&database, &healthy_workers()).is_empty());
    }

    #[test]
    fn legacy_success_without_verified_evidence_is_not_recent() {
        let now = chrono::Utc::now();
        assert!(!verified_backup_is_recent(None, None, now, 30));

        let verified = now - chrono::Duration::hours(2);
        let newer_failure = now - chrono::Duration::hours(1);
        assert!(!verified_backup_is_recent(
            Some(verified),
            Some(newer_failure),
            now,
            30
        ));
    }

    #[test]
    fn database_outage_skips_backup_evidence_and_reports_unknown_tooling() {
        let status = unavailable_backup_readiness(true);
        assert!(!status.tooling_ready);
        assert!(!status.recent_verified_backup);
        assert!(status.last_verified_at.is_none());
    }

    #[test]
    fn health_build_sha_is_compile_time_identity() {
        assert!(!super::build_sha().trim().is_empty());
        assert_eq!(super::build_sha(), env!("RIVERSIDE_GIT_SHA"));
    }
}

pub fn health_router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/", axum::routing::get(health))
        .route("/health", axum::routing::get(health))
        .route("/ready", axum::routing::get(ready))
        .route("/live", axum::routing::get(live))
}
