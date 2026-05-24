//! Health check endpoints for orchestration and monitoring

use axum::{extract::State, http::StatusCode, response::Json};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::time::Instant;
use tokio::sync::RwLock;

use super::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub version: String,
    pub uptime_seconds: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReadyResponse {
    pub status: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub database: DatabaseStatus,
    pub background_workers: WorkerStatus,
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
}

// Shared state for tracking worker health
pub static WORKER_HEALTH: tokio::sync::OnceCell<RwLock<WorkerHealth>> =
    tokio::sync::OnceCell::const_new();

#[derive(Debug, Default)]
pub struct WorkerHealth {
    pub backup_worker: Option<Instant>,
    pub notification_worker: Option<Instant>,
    pub email_worker: Option<Instant>,
    pub podium_worker: Option<Instant>,
    pub weather_worker: Option<Instant>,
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
        uptime_seconds: { start_time().elapsed().as_secs() as u32 },
    };

    Ok(Json(response))
}

/// Readiness check - verifies dependencies are ready
pub async fn ready(State(state): State<AppState>) -> Result<Json<ReadyResponse>, StatusCode> {
    // Check database connectivity
    let database_status = match check_database_health(&state.db).await {
        Ok(status) => status,
        Err(_) => return Err(StatusCode::SERVICE_UNAVAILABLE),
    };

    // Check background workers using actual heartbeats
    let worker_status = WorkerStatus {
        backup_worker: WorkerHealth::is_healthy("backup", 7200).await,
        notification_worker: WorkerHealth::is_healthy("notification", 7200).await,
        email_worker: WorkerHealth::is_healthy("email", 7200).await,
        podium_worker: WorkerHealth::is_healthy("podium", 86400).await,
        weather_worker: WorkerHealth::is_healthy("weather", 7200).await,
    };

    let response = ReadyResponse {
        status: "ready".to_string(),
        timestamp: chrono::Utc::now(),
        database: database_status,
        background_workers: worker_status,
    };

    Ok(Json(response))
}

/// Liveness check - verifies the app is not deadlocked
pub async fn live() -> Result<Json<serde_json::Value>, StatusCode> {
    // Simple liveness check - if we can respond, we're alive
    let response = serde_json::json!({
        "status": "alive",
        "timestamp": chrono::Utc::now(),
        "uptime_seconds": start_time().elapsed().as_secs()
    });

    Ok(Json(response))
}

async fn check_database_health(pool: &PgPool) -> Result<DatabaseStatus, sqlx::Error> {
    // Test database connectivity with a simple query
    let _: i32 = sqlx::query_scalar("SELECT 1").fetch_one(pool).await?;

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

fn start_time() -> &'static Instant {
    static START_TIME: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START_TIME.get_or_init(Instant::now)
}

pub fn health_router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/health", axum::routing::get(health))
        .route("/ready", axum::routing::get(ready))
        .route("/live", axum::routing::get(live))
}
