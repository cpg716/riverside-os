#![allow(clippy::items_after_test_module)]

use crate::api::{build_router, AppState};
use crate::logic::backups::{
    record_cloud_backup_failure, record_cloud_backup_success, record_local_backup_failure,
    record_local_backup_success, BackupManager, BackupSettings,
};
use crate::logic::ops_dev_center::{ops_retention_config_from_env, perform_retention_cleanup};
use crate::logic::wedding_push::WeddingEventBus;
use crate::observability::ServerLogRing;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderValue, Method};
use axum::serve;
use chrono::{NaiveDate, Timelike, Utc};
use rust_decimal_macros::dec;
use sqlx::postgres::PgPoolOptions;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_cron_scheduler::{Job, JobScheduler};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct LauncherConfig {
    pub database_url: String,
    pub bind_addr: String,
    pub frontend_dist: Option<PathBuf>,
    pub cors_origins: Vec<String>,
    pub strict_production: bool,
    pub max_body_bytes: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct LaunchReady {
    pub bind_addr: String,
    pub frontend_dist: PathBuf,
}

fn helcim_value_looks_placeholder(value: &str) -> bool {
    value.is_empty()
        || value.contains("dummy")
        || value.contains("replace_me")
        || value.contains("changeme")
        || value.contains("placeholder")
        || value.contains("example")
}

fn validate_helcim_environment(strict_production: bool) -> Result<(), Box<dyn std::error::Error>> {
    let api_token = std::env::var("HELCIM_API_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    let terminal_1_device_code = std::env::var("HELCIM_TERMINAL_1_DEVICE_CODE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let terminal_2_device_code = std::env::var("HELCIM_TERMINAL_2_DEVICE_CODE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let webhook_secret = std::env::var("HELCIM_WEBHOOK_SECRET")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let simulator_enabled = std::env::var("HELCIM_SIMULATOR_ENABLED")
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false);

    if strict_production {
        if helcim_value_looks_placeholder(&api_token) {
            return Err("Strict production requires HELCIM_API_TOKEN to be configured".into());
        }
        if terminal_1_device_code
            .as_deref()
            .map(helcim_value_looks_placeholder)
            .unwrap_or(true)
        {
            return Err(
                "Strict production requires HELCIM_TERMINAL_1_DEVICE_CODE to be configured".into(),
            );
        }
        if terminal_2_device_code
            .as_deref()
            .map(helcim_value_looks_placeholder)
            .unwrap_or(true)
        {
            return Err(
                "Strict production requires HELCIM_TERMINAL_2_DEVICE_CODE to be configured".into(),
            );
        }
    } else {
        if helcim_value_looks_placeholder(&api_token) && !simulator_enabled {
            tracing::warn!(
                "HELCIM_API_TOKEN is missing or placeholder; live Helcim payments will be unavailable until configured"
            );
        }
        if (terminal_1_device_code.is_none() || terminal_2_device_code.is_none())
            && !simulator_enabled
        {
            tracing::warn!(
                "HELCIM_TERMINAL_1_DEVICE_CODE or HELCIM_TERMINAL_2_DEVICE_CODE is missing; live terminal payments require both terminal device codes"
            );
        }
    }

    if webhook_secret.is_none() {
        tracing::warn!(
            "HELCIM_WEBHOOK_SECRET is not configured; optional Helcim webhook updates will be rejected, but local terminal polling can still be used"
        );
    }

    Ok(())
}

fn resolve_store_customer_jwt_secret(
    strict_production: bool,
) -> Result<std::sync::Arc<[u8]>, Box<dyn std::error::Error>> {
    match std::env::var("RIVERSIDE_STORE_CUSTOMER_JWT_SECRET") {
        Ok(s) if !s.trim().is_empty() => {
            let trimmed = s.trim();
            if trimmed.len() < 32 {
                tracing::warn!(
                    length = trimmed.len(),
                    "RIVERSIDE_STORE_CUSTOMER_JWT_SECRET is set but shorter than 32 characters"
                );
            }
            Ok(std::sync::Arc::from(
                trimmed.as_bytes().to_vec().into_boxed_slice(),
            ))
        }
        _ if strict_production => Err(
            "Strict production requires RIVERSIDE_STORE_CUSTOMER_JWT_SECRET for storefront account JWT signing"
                .into(),
        ),
        _ => {
            tracing::warn!(
                "RIVERSIDE_STORE_CUSTOMER_JWT_SECRET not set; using insecure development default"
            );
            Ok(std::sync::Arc::from(
                b"riverside-dev-store-customer-jwt-secret-change-me!!!!".as_slice(),
            ))
        }
    }
}

fn resolve_frontend_dist(
    frontend_dist: Option<PathBuf>,
    strict_production: bool,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let configured = frontend_dist.unwrap_or_else(|| PathBuf::from("../client/dist"));
    let resolved = if configured.is_absolute() {
        configured
    } else {
        std::env::current_dir()?.join(configured)
    };

    if resolved.is_dir() {
        tracing::info!(path = %resolved.display(), "Frontend dist directory resolved");
        return Ok(resolved);
    }

    if strict_production {
        return Err(format!(
            "Strict production requires FRONTEND_DIST to point to an existing static bundle directory (resolved: {})",
            resolved.display()
        )
        .into());
    }

    tracing::warn!(
        path = %resolved.display(),
        "Frontend dist directory does not exist; SPA/static asset requests will fail until the bundle is deployed"
    );
    Ok(resolved)
}

fn database_pool_max_connections() -> u32 {
    std::env::var("RIVERSIDE_DATABASE_MAX_CONNECTIONS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| (5..=100).contains(value))
        .unwrap_or(20)
}

/// If `RIVERSIDE_LLAMA_UPSTREAM` is not already set, derive it from the local llama-server
/// address so the Axum ROSIE proxy can reach the Tauri-managed sidecar without any manual
/// configuration. Uses `RIVERSIDE_LLAMA_HOST` (default `127.0.0.1`) and
/// `RIVERSIDE_LLAMA_PORT` (default `8080`) — the same defaults as the Tauri llama_server module.
fn ensure_rosie_upstream_from_local_llama() {
    if std::env::var("RIVERSIDE_LLAMA_UPSTREAM")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        // Already configured — respect whatever was set (e.g. a dedicated GPU machine).
        return;
    }
    let host = std::env::var("RIVERSIDE_LLAMA_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("RIVERSIDE_LLAMA_PORT").unwrap_or_else(|_| "8080".to_string());
    let upstream = format!("http://{}:{}", host.trim(), port.trim());
    std::env::set_var("RIVERSIDE_LLAMA_UPSTREAM", &upstream);
    tracing::info!(
        upstream,
        "RIVERSIDE_LLAMA_UPSTREAM auto-derived from local llama-server address"
    );
}

async fn launch_server_inner(
    config: LauncherConfig,
    server_log_ring: ServerLogRing,
    ready_tx: Option<oneshot::Sender<Result<LaunchReady, String>>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut ready_tx = ready_tx;
    let result: Result<(), Box<dyn std::error::Error>> = async {
    tracing::info!("Unified Engine: Connecting to PostgreSQL...");
    let db_max_connections = database_pool_max_connections();
    let pool = PgPoolOptions::new()
        .max_connections(db_max_connections)
        .connect(&config.database_url)
        .await?;
    tracing::info!(
        max_connections = db_max_connections,
        "Unified Engine: PostgreSQL pool configured"
    );

    // Start connection pool monitoring
    let monitor_pool = pool.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            let idle = monitor_pool.num_idle() as u32;
            let max = monitor_pool.size();
            let active = max.saturating_sub(idle);
            let utilization = if max > 0 { (active * 100) / max } else { 0 };

            if utilization >= 80 {
                tracing::warn!(
                    active_connections = active,
                    max_connections = max,
                    utilization_percent = utilization,
                    "Database connection pool utilization critical (>80%)"
                );

                // Send notification to admins
                if let Err(e) = crate::logic::notifications::broadcast_system_alert(
                    &monitor_pool,
                    &format!("Database pool utilization at {utilization}% ({active} active / {max} max)")
                ).await {
                    tracing::error!(error = %e, "Failed to send pool utilization alert");
                }
            } else if utilization >= 60 {
                tracing::info!(
                    active_connections = active,
                    max_connections = max,
                    utilization_percent = utilization,
                    "Database connection pool utilization elevated"
                );
            }
        }
    });

    crate::db_startup_diag::log_postgres_startup_context(&pool).await;

    if let Err(e) = crate::schema_bootstrap::ensure_core_schema(&pool).await {
        tracing::error!(error = %e, "Unified Engine: Schema contract validation failed");
        return Err(e.into());
    }
    tracing::info!("Unified Engine: Database schema contract OK.");

    if let Err(e) =
        crate::logic::integration_credentials::apply_all_integration_credentials_to_env(&pool).await
    {
        tracing::warn!(error = %e, "could not apply saved integration credentials; environment values remain active");
    }

    // Auto-derive RIVERSIDE_LLAMA_UPSTREAM from the local llama-server address if not already
    // set. The Tauri shell manages a llama-server sidecar on RIVERSIDE_LLAMA_HOST:RIVERSIDE_LLAMA_PORT
    // (default 127.0.0.1:8080). The Axum ROSIE proxy reads RIVERSIDE_LLAMA_UPSTREAM at request
    // time, so satellite clients and server-side insight/search-intent calls would fail without this.
    ensure_rosie_upstream_from_local_llama();

    validate_helcim_environment(config.strict_production)?;

    // Environmental Safety Interlock
    let target_mode = std::env::var("RIVERSIDE_MODE").unwrap_or_else(|_| "development".to_string());
    let db_mode: String = sqlx::query_scalar("SELECT environment_mode FROM store_settings WHERE id = 1")
        .fetch_one(&pool)
        .await?;

    if target_mode != db_mode {
        let msg = format!(
            "ENVIRONMENT MISMATCH: Server is running in '{target_mode}' mode, but database is stamped as '{db_mode}'. ABORTING to prevent data pollution."
        );
        tracing::error!("{}", msg);
        return Err(msg.into());
    }
    tracing::info!(mode = %db_mode, "Environmental safety check passed.");

    let counterpoint_sync_token = std::env::var("COUNTERPOINT_SYNC_TOKEN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let store_account_unauth_post_per_minute_ip: u32 =
        std::env::var("RIVERSIDE_STORE_ACCOUNT_UNAUTH_POST_PER_MINUTE_IP")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(20);
    let store_account_authed_per_minute: u32 =
        std::env::var("RIVERSIDE_STORE_ACCOUNT_AUTH_PER_MINUTE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(120);

    let store_customer_jwt_secret = resolve_store_customer_jwt_secret(config.strict_production)?;

    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .expect("reqwest client");

    let meilisearch = crate::logic::meilisearch_client::meilisearch_from_env();

    let global_employee_markup: rust_decimal::Decimal = match sqlx::query_scalar(
        "SELECT employee_markup_percent FROM store_settings WHERE id = 1",
    )
    .fetch_one(&pool)
    .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, "could not load store_settings.employee_markup_percent; using 15% default");
            dec!(15.0)
        }
    };

    let state = AppState {
        db: pool,
        global_employee_markup,
        http_client,
        podium_token_cache: std::sync::Arc::new(tokio::sync::Mutex::new(
            crate::logic::podium::PodiumTokenCache::default(),
        )),
        database_url: config.database_url.clone(),
        counterpoint_sync_token,
        wedding_events: WeddingEventBus::new(),
        store_customer_jwt_secret,
        store_account_rate: std::sync::Arc::new(tokio::sync::Mutex::new(
            crate::api::store_account_rate::StoreAccountRateState::default(),
        )),
        store_account_unauth_post_per_minute_ip,
        store_account_authed_per_minute,
        meilisearch,
        rosie_speech_state: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
        server_log_ring: server_log_ring.clone(),
        cache: crate::cache::CacheService::from_env().ok(),
        metrics_collector: None, // Will be initialized later if needed
        rate_limit: crate::middleware::rate_limit::rate_limit_middleware(),
        github_token: std::env::var("RIVERSIDE_GITHUB_TOKEN").ok(),
    };

    // Workers
    // Start background job worker if enabled
    if matches!(
        std::env::var("RIVERSIDE_JOB_QUEUE_ENABLED")
            .ok()
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    ) {
        if let Ok(queue) = crate::jobs::JobQueue::from_env() {
            let mut registry = crate::jobs::create_registry();
            crate::jobs::register_handler(
                &mut registry,
                std::sync::Arc::new(crate::jobs::fal_download::FalDownloadHandler::new(state.clone())),
            );
            crate::jobs::register_handler(
                &mut registry,
                std::sync::Arc::new(crate::jobs::qbo_sync::QboSyncHandler::new(state.db.clone())),
            );

            let worker_config = crate::jobs::WorkerConfig::default();
            let worker = crate::jobs::JobWorker::new(queue, registry, worker_config);
            tokio::spawn(async move {
                tracing::info!("Initializing background JobWorker...");
                if let Err(e) = worker.start().await {
                    tracing::error!(error = %e, "Failed to start background JobWorker");
                } else {
                    tracing::info!("JobWorker started successfully");
                }
            });
        } else {
            tracing::error!("Failed to initialize JobQueue for background worker");
        }
    }

    let fallback_pool = state.db.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            ticker.tick().await;
            if sqlx::query("SELECT 1").execute(&fallback_pool).await.is_ok() {
                match crate::logic::bug_reports::ingest_fallback_errors(&fallback_pool).await {
                    Ok(count) => {
                        if count > 0 {
                            tracing::info!(count, "Ingested fallback errors into database");
                        }
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "Failed to ingest fallback errors");
                    }
                }
            }
        }
    });

    let qbo_pool = state.db.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(50 * 60));
        loop {
            ticker.tick().await;
            if let Err(e) = crate::api::qbo::refresh_due_tokens(&qbo_pool).await {
                tracing::error!(error = %e, "QBO token refresh worker failed");
            }
        }
    });

    let qbo_propose_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(3600));
        let mut last_run_day: Option<chrono::NaiveDate> = None;
        loop {
            ticker.tick().await;
            let now_local = chrono::Local::now();
            let today = now_local.naive_local().date();
            let hour = now_local.hour();
            // Run once per day after 2 AM local time (after Z-close / end of day)
            if last_run_day != Some(today) && hour >= 2 {
                last_run_day = Some(today);
                let yesterday = today.pred_opt().unwrap_or(today);
                tracing::info!(activity_date = %yesterday, "QBO auto-propose worker: proposing daily journal");
                if let Err(e) = crate::logic::qbo_journal::ensure_pending_daily_journal(&qbo_propose_state.db, yesterday).await {
                    tracing::error!(error = %e, "QBO auto-propose worker failed");
                }
            }
        }
    });

    let backup_state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = start_backup_worker(backup_state).await {
            tracing::error!(error = %e, "Background backup worker failed");
        }
    });

    let notif_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            ticker.tick().await;
            crate::api::health::WorkerHealth::mark_heartbeat("notification").await;
            crate::logic::notifications_jobs::run_notification_maintenance(&notif_state.db).await;
            if let Err(e) =
                crate::logic::notifications_jobs::run_notification_generators(&notif_state.db).await
            {
                tracing::error!(error = %e, "notification generators failed");
            }
        }
    });

    let weather_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            ticker.tick().await;
            crate::api::health::WorkerHealth::mark_heartbeat("weather").await;
            if let Err(e) = crate::logic::weather::maybe_finalize_daily_weather_snapshots(
                &weather_state.http_client,
                &weather_state.db,
            )
            .await
            {
                tracing::error!(error = %e, "Weather EOD finalize failed");
            }
            if let Err(e) = perform_weather_backfill(&weather_state).await {
                tracing::error!(error = %e, "Golden Rule Weather worker failed");
            }
        }
    });

    let email_sync_interval_secs = std::env::var("RIVERSIDE_EMAIL_SYNC_INTERVAL_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30 * 60)
        .max(60);
    let email_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(
            email_sync_interval_secs,
        ));
        loop {
            ticker.tick().await;
            crate::api::health::WorkerHealth::mark_heartbeat("email").await;
            match crate::logic::email::sync_inbox(&email_state.db).await {
                Ok(summary) if summary.inserted > 0 => {
                    tracing::info!(
                        target: "email",
                        fetched = summary.fetched,
                        inserted = summary.inserted,
                        matched_customers = summary.matched_customers,
                        "Store email inbox synced"
                    );
                    if let Err(error) =
                        crate::logic::email::notify_new_mail(&email_state.db, &summary).await
                    {
                        tracing::warn!(
                            target: "email",
                            error = %error,
                            "Store email sync notification fan-out failed"
                        );
                    }
                }
                Ok(_) | Err(crate::logic::email::EmailError::NotConfigured) => {}
                Err(error) => {
                    tracing::warn!(
                        target: "email",
                        error = %error,
                        "Store email inbox sync failed"
                    );
                }
            }
        }
    });

    let podium_sync_interval_secs = std::env::var("RIVERSIDE_PODIUM_SYNC_INTERVAL_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30 * 60 * 60)
        .max(10 * 60);
    let podium_sync_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(
            podium_sync_interval_secs,
        ));
        loop {
            ticker.tick().await;
            crate::api::health::WorkerHealth::mark_heartbeat("podium").await;
            match crate::logic::podium_messaging::sync_recent_from_podium(
                &podium_sync_state.db,
                &podium_sync_state.http_client,
                &podium_sync_state.podium_token_cache,
                200,
            )
            .await
            {
                Ok(summary) => {
                    tracing::info!(
                        conversations_matched = summary.conversations_matched,
                        conversations_unmatched = summary.conversations_unmatched,
                        messages_inserted = summary.messages_inserted,
                        error_count = summary.errors.len(),
                        "Podium inbox background pull completed"
                    );
                }
                Err(crate::logic::podium::PodiumError::NotConfigured) => {}
                Err(error) => {
                    tracing::warn!(
                        target: "podium",
                        error = %error,
                        "Podium inbox background pull failed"
                    );
                }
            }
        }
    });

    // CORS
    let cors_header_values: Vec<HeaderValue> = config
        .cors_origins
        .iter()
        .filter_map(|s| HeaderValue::from_str(s).ok())
        .collect();

    if config.strict_production && cors_header_values.is_empty() {
        return Err(
            "Strict production requires RIVERSIDE_CORS_ORIGINS for browser-facing deployments"
                .into(),
        );
    }

    if config.strict_production {
        crate::logic::integration_credentials::validate_credentials_key_for_startup().map_err(
            |e| format!("Strict production integration credential configuration failed: {e}"),
        )?;
        crate::api::qbo::validate_qbo_token_key_for_startup()
            .map_err(|e| format!("Strict production QBO token configuration failed: {e}"))?;
        crate::logic::backups::validate_backup_dir_for_startup(config.strict_production)
            .map_err(|e| format!("Strict production backup directory failed: {e}"))?;
    }

    let cors = if cors_header_values.is_empty() {
        tracing::warn!(
            "CORS allow_origin(Any) enabled; set RIVERSIDE_CORS_ORIGINS and RIVERSIDE_STRICT_PRODUCTION=true for production browser deployments"
        );
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::PATCH,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers(Any)
    } else {
        tracing::info!(
            count = cors_header_values.len(),
            "CORS allowlist loaded from RIVERSIDE_CORS_ORIGINS"
        );
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(cors_header_values))
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::PATCH,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers(Any)
    };

    // Static Files
    let dist_path = resolve_frontend_dist(config.frontend_dist.clone(), config.strict_production)?;
    let index_path = dist_path.join("index.html");
    let serve_dir = ServeDir::new(dist_path.clone())
        .append_index_html_on_directories(true)
        .not_found_service(ServeFile::new(index_path));

    let max_body = config.max_body_bytes.unwrap_or(256 * 1024 * 1024);

    let uploads_dir = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("uploads");
    let serve_uploads = ServeDir::new(uploads_dir);

    let app = build_router(state.clone())
        .nest_service("/uploads", serve_uploads)
        .layer(DefaultBodyLimit::max(max_body))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
        .fallback_service(serve_dir);

    let listener = TcpListener::bind(&config.bind_addr).await?;
    tracing::info!(addr = %config.bind_addr, "Riverside OS Unified Engine listening");

    if let Some(tx) = ready_tx.take() {
        let _ = tx.send(Ok(LaunchReady {
            bind_addr: config.bind_addr.clone(),
            frontend_dist: dist_path.clone(),
        }));
    }

    serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
    }
    .await;

    if let Err(ref error) = result {
        if let Some(tx) = ready_tx.take() {
            let _ = tx.send(Err(error.to_string()));
        }
    }

    result
}

pub async fn launch_server(
    config: LauncherConfig,
    server_log_ring: ServerLogRing,
) -> Result<(), Box<dyn std::error::Error>> {
    launch_server_inner(config, server_log_ring, None).await
}

pub async fn launch_server_with_ready_signal(
    config: LauncherConfig,
    server_log_ring: ServerLogRing,
    ready_tx: oneshot::Sender<Result<LaunchReady, String>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let result = launch_server_inner(config, server_log_ring, Some(ready_tx)).await;
    result
}

#[cfg(test)]
mod tests {
    use super::helcim_value_looks_placeholder;

    #[test]
    fn helcim_placeholder_detection_catches_dummy_values() {
        assert!(helcim_value_looks_placeholder(""));
        assert!(helcim_value_looks_placeholder("replace_me"));
        assert!(!helcim_value_looks_placeholder("real-token-value"));
    }
}

async fn start_backup_worker(state: AppState) -> Result<(), anyhow::Error> {
    let sched = JobScheduler::new().await?;
    let cleanup_state = state.clone();
    let cleanup_job = Job::new_async("0 0 * * * *", move |_uuid, _l| {
        let st = cleanup_state.clone();
        Box::pin(async move {
            crate::api::health::WorkerHealth::mark_heartbeat("backup").await;
            let manager = BackupManager::new(st.database_url.clone());
            let settings_raw: serde_json::Value =
                sqlx::query_scalar("SELECT backup_settings FROM store_settings WHERE id = 1")
                    .fetch_one(&st.db)
                    .await
                    .unwrap_or_default();
            let settings: BackupSettings = serde_json::from_value(settings_raw).unwrap_or_default();
            if let Err(e) = manager
                .perform_auto_cleanup(settings.auto_cleanup_days)
                .await
            {
                tracing::error!(error = %e, "Background Worker: Auto-cleanup failed");
            }
        })
    })?;
    sched.add(cleanup_job).await?;

    let ops_retention_state = state.clone();
    let ops_retention_job = Job::new_async("0 30 3 * * *", move |_uuid, _l| {
        let st = ops_retention_state.clone();
        Box::pin(async move {
            crate::api::health::WorkerHealth::mark_heartbeat("backup").await;
            let config = ops_retention_config_from_env();
            match perform_retention_cleanup(&st.db, &config).await {
                Ok(result) => tracing::info!(
                    stale_station_alerts_resolved = result.stale_station_alerts_resolved,
                    stale_stations_deleted = result.stale_stations_deleted,
                    resolved_alerts_deleted = result.resolved_alerts_deleted,
                    station_retention_days = result.station_retention_days,
                    resolved_alert_retention_days = result.resolved_alert_retention_days,
                    "Background Worker: Ops retention cleanup completed"
                ),
                Err(e) => {
                    tracing::error!(error = %e, "Background Worker: Ops retention cleanup failed");
                }
            }
        })
    })?;
    sched.add(ops_retention_job).await?;

    let backup_state = state.clone();
    let backup_checker = Job::new_async("0 * * * * *", move |_uuid, _l| {
        let st = backup_state.clone();
        Box::pin(async move {
            crate::api::health::WorkerHealth::mark_heartbeat("backup").await;
            let settings_raw: serde_json::Value =
                sqlx::query_scalar("SELECT backup_settings FROM store_settings WHERE id = 1")
                    .fetch_one(&st.db)
                    .await
                    .unwrap_or_default();
            let settings: BackupSettings = serde_json::from_value(settings_raw).unwrap_or_default();
            let now = chrono::Local::now().format("%H:%M").to_string();
            let parts: Vec<&str> = settings.schedule_cron.split_whitespace().collect();
            if parts.len() >= 2 {
                let hour = parts[1].parse::<u32>().unwrap_or(2);
                let minute = parts[0].parse::<u32>().unwrap_or(0);
                if now == format!("{hour:02}:{minute:02}") {
                    let manager = BackupManager::new(st.database_url.clone());
                    match manager.create_backup_with_settings(&settings).await {
                        Ok(filename) => {
                            let _ = record_local_backup_success(&st.db).await;

                            let offsite_enabled = settings.cloud_storage_enabled
                                || settings
                                    .replication_targets
                                    .iter()
                                    .any(|target| !target.trim().is_empty());
                            if offsite_enabled {
                                let cloud_result =
                                    manager.sync_to_cloud(&filename, &settings).await;
                                let replica_result =
                                    manager.replicate_to_targets(&filename, &settings).await;
                                match (cloud_result, replica_result) {
                                    (Ok(_), Ok(_)) => {
                                        let _ = record_cloud_backup_success(&st.db).await;
                                    }
                                    (cloud, replica) => {
                                        let detail = format!(
                                            "Off-site backup failed. Cloud: {}; Replication: {}",
                                            cloud
                                                .err()
                                                .map(|e| e.to_string())
                                                .unwrap_or_else(|| "ok".to_string()),
                                            replica
                                                .err()
                                                .map(|e| e.to_string())
                                                .unwrap_or_else(|| "ok".to_string())
                                        );
                                        let _ = record_cloud_backup_failure(&st.db, &detail).await;
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            let _ = record_local_backup_failure(&st.db, &e.to_string()).await;
                        }
                    }
                }
            }
        })
    })?;
    sched.add(backup_checker).await?;

    sched.start().await?;
    Ok(())
}

async fn perform_weather_backfill(state: &AppState) -> Result<(), anyhow::Error> {
    let rows: Vec<(Uuid, chrono::DateTime<Utc>)> = sqlx::query_as("SELECT id, opened_at FROM register_sessions WHERE weather_snapshot IS NULL AND opened_at > (CURRENT_TIMESTAMP - INTERVAL '14 days')").fetch_all(&state.db).await?;
    if rows.is_empty() {
        return Ok(());
    }
    let mut by_date: HashMap<NaiveDate, Vec<Uuid>> = HashMap::new();
    for (id, opened_at) in rows {
        by_date.entry(opened_at.date_naive()).or_default().push(id);
    }
    for (date, ids) in by_date {
        let weather =
            crate::logic::weather::fetch_weather_range(&state.http_client, &state.db, date, date)
                .await
                .into_iter()
                .next();
        if let Some(w) = weather {
            let json = serde_json::to_value(w)?;
            for sid in ids {
                sqlx::query("UPDATE register_sessions SET weather_snapshot = $1 WHERE id = $2")
                    .bind(&json)
                    .bind(sid)
                    .execute(&state.db)
                    .await?;
            }
        }
    }
    Ok(())
}
