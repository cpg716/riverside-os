//! Riverside OS HTTP server (Axum + PostgreSQL).

use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderValue, Method};
use axum::serve;
use riverside_server::logic::backups::{
    record_cloud_backup_failure, record_cloud_backup_success, record_local_backup_failure,
    record_local_backup_success, BackupManager, BackupSettings,
};
use rust_decimal_macros::dec;
use sqlx::postgres::PgPoolOptions;
use std::net::SocketAddr;
use std::path::PathBuf;
use tokio::net::TcpListener;
use tokio_cron_scheduler::{Job, JobScheduler};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

use riverside_server::observability::{init_tracing_with_optional_otel, ServerLogRing};

use chrono::{NaiveDate, Utc};
use riverside_server::api::{build_router, AppState};
use riverside_server::logic::wedding_push::WeddingEventBus;
use std::collections::HashMap;
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();

    // 1. Structured logging + bounded in-memory ring for bug-report server log snapshots.
    let server_log_ring = ServerLogRing::new(800, 2_048);
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("riverside_server=info,warn"));
    init_tracing_with_optional_otel(server_log_ring.clone(), env_filter);

    // 2. Database Connection
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:password@localhost/riverside_os".to_string());

    tracing::info!("Connecting to PostgreSQL...");

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    tracing::info!("Database connected.");

    riverside_server::db_startup_diag::log_postgres_startup_context(&pool).await;

    if let Err(e) = riverside_server::schema_bootstrap::ensure_core_schema(&pool).await {
        tracing::error!(
            error = %e,
            "Failed to ensure core database schema; check migrations/ folder and DATABASE_URL"
        );
        return Err(e.into());
    }
    tracing::info!("Core database schema (RBAC + Counterpoint Finishing) OK.");

    // 3. Application State
    let stripe_secret_key = std::env::var("STRIPE_SECRET_KEY")
        .unwrap_or_else(|_| "sk_test_dummy_replace_me_later".to_string());

    let counterpoint_sync_token = std::env::var("COUNTERPOINT_SYNC_TOKEN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if counterpoint_sync_token.is_some() {
        tracing::info!("Counterpoint sync API enabled (/api/sync/counterpoint/*)");
    }

    let payment_intent_max_per_minute: u32 = std::env::var("RIVERSIDE_PAYMENTS_INTENT_PER_MINUTE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(120);

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

    let store_customer_jwt_secret: std::sync::Arc<[u8]> = match std::env::var(
        "RIVERSIDE_STORE_CUSTOMER_JWT_SECRET",
    ) {
        Ok(s) if !s.trim().is_empty() => {
            std::sync::Arc::from(s.trim().as_bytes().to_vec().into_boxed_slice())
        }
        _ => {
            tracing::warn!(
                "RIVERSIDE_STORE_CUSTOMER_JWT_SECRET not set; using insecure development default for store customer JWTs"
            );
            std::sync::Arc::from(
                b"riverside-dev-store-customer-jwt-secret-change-me!!!!".as_slice(),
            )
        }
    };

    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .expect("reqwest client");

    let meilisearch = riverside_server::logic::meilisearch_client::meilisearch_from_env();

    let global_employee_markup: rust_decimal::Decimal =
        match sqlx::query_scalar("SELECT employee_markup_percent FROM store_settings WHERE id = 1")
            .fetch_one(&pool)
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "could not load store_settings.employee_markup_percent; using 15% default"
                );
                dec!(15.0)
            }
        };

    let state = AppState {
        db: pool,
        global_employee_markup,
        stripe_client: stripe::Client::new(stripe_secret_key),
        http_client,
        podium_token_cache: std::sync::Arc::new(tokio::sync::Mutex::new(
            riverside_server::logic::podium::PodiumTokenCache::default(),
        )),
        database_url,
        counterpoint_sync_token,
        wedding_events: WeddingEventBus::new(),
        payment_intent_minute: std::sync::Arc::new(tokio::sync::Mutex::new(
            riverside_server::api::PaymentIntentMinuteWindow {
                window_start: std::time::Instant::now(),
                count: 0,
            },
        )),
        payment_intent_max_per_minute,
        store_customer_jwt_secret,
        store_account_rate: std::sync::Arc::new(tokio::sync::Mutex::new(
            riverside_server::api::store_account_rate::StoreAccountRateState::default(),
        )),
        store_account_unauth_post_per_minute_ip,
        store_account_authed_per_minute,
        meilisearch,
        server_log_ring,
    };

    // QBO token refresh worker: keep bridge active by refreshing ~every 50 minutes.
    let qbo_pool = state.db.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(50 * 60));
        loop {
            ticker.tick().await;
            if let Err(e) = riverside_server::api::qbo::refresh_due_tokens(&qbo_pool).await {
                tracing::error!(error = %e, "QBO token refresh worker failed");
            }
        }
    });

    // Background Backup Worker
    let backup_state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = start_backup_worker(backup_state).await {
            tracing::error!(error = %e, "Background backup worker failed");
        }
    });

    // Notification center: hourly retention + operational generators.
    let notif_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            ticker.tick().await;
            riverside_server::logic::notifications_jobs::run_notification_maintenance(
                &notif_state.db,
            )
            .await;
            if let Err(e) =
                riverside_server::logic::notifications_jobs::run_notification_generators(
                    &notif_state.db,
                )
                .await
            {
                tracing::error!(error = %e, "notification generators failed");
            }
        }
    });

    // Golden Rule Weather Background Worker: Ensure every closed session has an environmental snapshot.
    let weather_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(3600)); // Every hour
        loop {
            ticker.tick().await;
            if let Err(e) =
                riverside_server::logic::weather::maybe_finalize_daily_weather_snapshots(
                    &weather_state.http_client,
                    &weather_state.db,
                )
                .await
            {
                tracing::error!(error = %e, "Weather EOD finalize failed");
                let _ = riverside_server::logic::integration_alerts::record_integration_failure(
                    &weather_state.db,
                    "weather_finalize",
                    &e.to_string(),
                )
                .await;
            }
            if let Err(e) = perform_weather_backfill(&weather_state).await {
                tracing::error!(error = %e, "Golden Rule Weather worker failed");
            }
        }
    });

    // 4. CORS — `RIVERSIDE_CORS_ORIGINS` = comma-separated list (e.g. `http://localhost:5173,https://app.example.com`).
    // When unset or empty, any origin is allowed (local dev / Tauri). Production should set an explicit allowlist.
    let cors_origins: Vec<HeaderValue> = std::env::var("RIVERSIDE_CORS_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|s| HeaderValue::from_str(s).ok())
        .collect();

    let strict_production = std::env::var("RIVERSIDE_STRICT_PRODUCTION")
        .unwrap_or_default()
        .eq_ignore_ascii_case("true");
    if strict_production && cors_origins.is_empty() {
        return Err(
            "RIVERSIDE_STRICT_PRODUCTION=true requires a non-empty RIVERSIDE_CORS_ORIGINS allowlist"
                .into(),
        );
    }

    let cors = if cors_origins.is_empty() {
        tracing::info!("CORS: allowing any origin (set RIVERSIDE_CORS_ORIGINS in production)");
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
            count = cors_origins.len(),
            "CORS: allowlist from RIVERSIDE_CORS_ORIGINS"
        );
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(cors_origins))
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

    // 5. Build Router and apply State and CORS
    // Frontend static files from the dist folder
    let dist_path = std::env::var("FRONTEND_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../client/dist"));

    let index_path = dist_path.join("index.html");
    let serve_dir = ServeDir::new(dist_path)
        .append_index_html_on_directories(true)
        .not_found_service(ServeFile::new(index_path));

    // Large JSON bodies (e.g. catalog import): serialized size is often several times the raw CSV due to JSON quoting.
    // Override with RIVERSIDE_MAX_BODY_BYTES (decimal bytes, e.g. 536870912 for 512 MiB).
    let max_json_body: usize = std::env::var("RIVERSIDE_MAX_BODY_BYTES")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&n| n >= 1024 * 1024)
        .unwrap_or(256 * 1024 * 1024);
    tracing::info!(
        max_json_body_bytes = max_json_body,
        "HTTP request body limit"
    );

    let app = build_router()
        .layer(DefaultBodyLimit::max(max_json_body))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
        .fallback_service(serve_dir);

    // 6. Start Server
    // Default 0.0.0.0:3000 for LAN / Tailscale; override with RIVERSIDE_HTTP_BIND (e.g. 127.0.0.1:3000).
    let bind_addr =
        std::env::var("RIVERSIDE_HTTP_BIND").unwrap_or_else(|_| "0.0.0.0:3000".to_string());
    let listener = TcpListener::bind(&bind_addr).await?;
    tracing::info!(addr = %bind_addr, "Riverside OS Server listening (set RIVERSIDE_HTTP_BIND to change)");

    serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    opentelemetry::global::shutdown_tracer_provider();
    Ok(())
}

async fn start_backup_worker(state: AppState) -> Result<(), anyhow::Error> {
    let sched = JobScheduler::new().await?;

    // We run a "master" job every hour to check for schedule updates or perform cleanup.
    // Cleanup is safe to run frequently as it's non-blocking.
    let cleanup_state = state.clone();
    let cleanup_job = Job::new_async("0 0 * * * *", move |_uuid, _l| {
        let st = cleanup_state.clone();
        Box::pin(async move {
            let manager = BackupManager::new(st.database_url.clone());
            // Fetch current settings
            let settings_raw: serde_json::Value =
                sqlx::query_scalar("SELECT backup_settings FROM store_settings WHERE id = 1")
                    .fetch_one(&st.db)
                    .await
                    .unwrap_or_default();

            let settings: BackupSettings = serde_json::from_value(settings_raw).unwrap_or_default();

            info!(
                "Background Worker: Running auto-cleanup ({} days)",
                settings.auto_cleanup_days
            );
            if let Err(e) = manager
                .perform_auto_cleanup(settings.auto_cleanup_days)
                .await
            {
                tracing::error!(error = %e, "Background Worker: Auto-cleanup failed");
            }
        })
    })?;

    sched.add(cleanup_job).await?;

    // Backup checker runs every minute.
    let backup_state = state.clone();
    let backup_checker = Job::new_async("0 * * * * *", move |_uuid, _l| {
        let st = backup_state.clone();
        Box::pin(async move {
            let settings_raw: serde_json::Value =
                sqlx::query_scalar("SELECT backup_settings FROM store_settings WHERE id = 1")
                    .fetch_one(&st.db)
                    .await
                    .unwrap_or_default();

            let settings: BackupSettings = serde_json::from_value(settings_raw).unwrap_or_default();

            // Check if current time matches the cron schedule.
            let now = chrono::Local::now().format("%H:%M").to_string();
            // schedule_cron is "0 2 * * *" -> we expect the backup at 02:00.
            // Crude parsing for MVP schedule: "0 2 * * *" => 02:00
            let parts: Vec<&str> = settings.schedule_cron.split_whitespace().collect();
            if parts.len() >= 2 {
                let hour = parts[1].parse::<u32>().unwrap_or(2);
                let minute = parts[0].parse::<u32>().unwrap_or(0);
                let sched_time = format!("{hour:02}:{minute:02}");

                if now == sched_time {
                    info!("Background Worker: Scheduled backup triggered at {}", now);
                    let manager = BackupManager::new(st.database_url.clone());
                    match manager.create_backup().await {
                        Ok(filename) => {
                            if let Err(e) = record_local_backup_success(&st.db).await {
                                tracing::error!(error = %e, "Background Worker: record_local_backup_success failed");
                            }
                            if settings.cloud_storage_enabled {
                                match manager.sync_to_cloud(&filename, &settings).await {
                                    Ok(()) => {
                                        if let Err(e) = record_cloud_backup_success(&st.db).await {
                                            tracing::error!(error = %e, "Background Worker: record_cloud_backup_success failed");
                                        }
                                    }
                                    Err(e) => {
                                        tracing::error!(error = %e, "Background Worker: Cloud sync failed");
                                        if let Err(err) =
                                            record_cloud_backup_failure(&st.db, &e.to_string())
                                                .await
                                        {
                                            tracing::error!(error = %err, "Background Worker: record_cloud_backup_failure failed");
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            tracing::error!(error = %e, "Background Worker: Scheduled backup failed");
                            if let Err(err) =
                                record_local_backup_failure(&st.db, &e.to_string()).await
                            {
                                tracing::error!(error = %err, "Background Worker: record_local_backup_failure failed");
                            }
                        }
                    }
                }
            }
        })
    })?;

    sched.add(backup_checker).await?;

    // Bug report retention: daily at 04:00 local (scheduler TZ = server local).
    let bug_report_state = state.clone();
    let bug_retention_job = Job::new_async("0 0 4 * * *", move |_uuid, _l| {
        let st = bug_report_state.clone();
        Box::pin(async move {
            let days: i64 = std::env::var("RIVERSIDE_BUG_REPORT_RETENTION_DAYS")
                .ok()
                .and_then(|s| s.parse().ok())
                .filter(|&d| d >= 30)
                .unwrap_or(365);
            match riverside_server::logic::bug_reports::purge_bug_reports_older_than(&st.db, days)
                .await
            {
                Ok(n) if n > 0 => {
                    tracing::info!(
                        deleted = n,
                        retention_days = days,
                        "bug report retention purge"
                    );
                }
                Ok(_) => {}
                Err(e) => tracing::error!(error = %e, "bug report retention purge failed"),
            }
        })
    })?;
    sched.add(bug_retention_job).await?;

    // System health audit: daily at 03:00 local.
    let health_state = state.clone();
    let health_audit_job = Job::new_async("0 0 3 * * *", move |_uuid, _l| {
        let st = health_state.clone();
        Box::pin(async move {
            if let Err(e) =
                riverside_server::logic::maintenance::run_system_health_audit(&st.db).await
            {
                tracing::error!(error = %e, "daily system health audit failed");
            }
        })
    })?;
    sched.add(health_audit_job).await?;

    sched.start().await?;

    info!("Background backup scheduler started.");
    Ok(())
}

async fn perform_weather_backfill(state: &AppState) -> Result<(), anyhow::Error> {
    let rows: Vec<(Uuid, chrono::DateTime<Utc>)> = sqlx::query_as(
        r#"SELECT id, opened_at FROM register_sessions
           WHERE weather_snapshot IS NULL
             AND opened_at > (CURRENT_TIMESTAMP - INTERVAL '14 days')"#,
    )
    .fetch_all(&state.db)
    .await?;

    if rows.is_empty() {
        return Ok(());
    }

    let mut by_date: HashMap<NaiveDate, Vec<Uuid>> = HashMap::new();
    for (id, opened_at) in rows {
        by_date.entry(opened_at.date_naive()).or_default().push(id);
    }

    info!(
        distinct_dates = by_date.len(),
        sessions = by_date.values().map(|v| v.len()).sum::<usize>(),
        "Golden Rule: Backfilling weather (batched by opened_at date)"
    );

    for (date, ids) in by_date {
        let weather = riverside_server::logic::weather::fetch_weather_range(
            &state.http_client,
            &state.db,
            date,
            date,
        )
        .await
        .into_iter()
        .next();

        let Some(w) = weather else {
            continue;
        };
        let json = serde_json::to_value(w)?;
        for sid in ids {
            sqlx::query("UPDATE register_sessions SET weather_snapshot = $1 WHERE id = $2")
                .bind(&json)
                .bind(sid)
                .execute(&state.db)
                .await?;
        }
    }

    Ok(())
}
