use crate::api::{build_router, AppState};
use crate::logic::backups::{
    record_cloud_backup_success, record_local_backup_success, BackupManager, BackupSettings,
};
use crate::logic::wedding_push::WeddingEventBus;
use crate::observability::ServerLogRing;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderValue, Method};
use axum::serve;
use chrono::{NaiveDate, Utc};
use rust_decimal_macros::dec;
use sqlx::postgres::PgPoolOptions;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use tokio::net::TcpListener;
use tokio_cron_scheduler::{Job, JobScheduler};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct LauncherConfig {
    pub database_url: String,
    pub stripe_secret_key: String,
    pub stripe_public_key: String,
    pub stripe_webhook_secret: Option<String>,
    pub bind_addr: String,
    pub frontend_dist: Option<PathBuf>,
    pub cors_origins: Vec<String>,
    pub strict_production: bool,
    pub max_body_bytes: Option<usize>,
}

fn stripe_value_looks_placeholder(value: &str) -> bool {
    value.is_empty()
        || value.contains("dummy")
        || value.contains("replace_me")
        || value.contains("changeme")
        || value.contains("placeholder")
        || value.contains("example")
}

fn resolve_stripe_secret_key(
    stripe_secret_key: String,
    strict_production: bool,
) -> Result<String, Box<dyn std::error::Error>> {
    let trimmed = stripe_secret_key.trim();
    let looks_dummy = stripe_value_looks_placeholder(trimmed);
    let is_test_key = trimmed.starts_with("sk_test_");
    let is_live_key = trimmed.starts_with("sk_live_");

    if strict_production {
        if !is_live_key || looks_dummy {
            return Err(
                "Strict production requires STRIPE_SECRET_KEY to be configured with a valid live Stripe secret key (sk_live_...)"
                    .into(),
            );
        }
        return Ok(trimmed.to_string());
    }

    if looks_dummy {
        tracing::warn!(
            "STRIPE_SECRET_KEY is missing or using the built-in dummy development fallback; live payment flows will fail until a real Stripe key is configured"
        );
    } else if !is_test_key && !is_live_key {
        tracing::warn!(
            "STRIPE_SECRET_KEY is set but does not look like a standard Stripe secret key (expected sk_test_... or sk_live_...)"
        );
    }

    Ok(trimmed.to_string())
}

fn resolve_stripe_public_key(
    stripe_public_key: String,
    strict_production: bool,
) -> Result<String, Box<dyn std::error::Error>> {
    let trimmed = stripe_public_key.trim();
    let looks_placeholder = stripe_value_looks_placeholder(trimmed);
    let is_test_key = trimmed.starts_with("pk_test_");
    let is_live_key = trimmed.starts_with("pk_live_");

    if strict_production {
        if !is_live_key || looks_placeholder {
            return Err(
                "Strict production requires STRIPE_PUBLIC_KEY to be configured with a valid live Stripe publishable key (pk_live_...)"
                    .into(),
            );
        }
        return Ok(trimmed.to_string());
    }

    if looks_placeholder {
        tracing::warn!(
            "STRIPE_PUBLIC_KEY is missing or using a placeholder value; Stripe Elements flows such as card vaulting will be unavailable until a real key is configured"
        );
    } else if !is_test_key && !is_live_key {
        tracing::warn!(
            "STRIPE_PUBLIC_KEY is set but does not look like a standard Stripe publishable key (expected pk_test_... or pk_live_...)"
        );
    }

    Ok(trimmed.to_string())
}

fn resolve_stripe_webhook_secret(
    stripe_webhook_secret: Option<String>,
    strict_production: bool,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let trimmed = stripe_webhook_secret
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let Some(trimmed) = trimmed else {
        tracing::warn!(
            "STRIPE_WEBHOOK_SECRET is not configured; Stripe webhook reconciliation will stay disabled until a signing secret is provided"
        );
        return Ok(None);
    };

    let looks_placeholder = stripe_value_looks_placeholder(trimmed);
    let looks_valid = trimmed.starts_with("whsec_");

    if strict_production && (!looks_valid || looks_placeholder) {
        return Err(
            "Strict production requires STRIPE_WEBHOOK_SECRET to use a valid Stripe webhook signing secret (whsec_...) when configured"
                .into(),
        );
    }

    if looks_placeholder {
        tracing::warn!(
            "STRIPE_WEBHOOK_SECRET is set but still looks like a placeholder; Stripe webhook verification will fail until a real signing secret is configured"
        );
    } else if !looks_valid {
        tracing::warn!(
            "STRIPE_WEBHOOK_SECRET is set but does not look like a standard Stripe webhook signing secret (expected whsec_...)"
        );
    }

    Ok(Some(trimmed.to_string()))
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

pub async fn launch_server(
    config: LauncherConfig,
    server_log_ring: ServerLogRing,
) -> Result<(), Box<dyn std::error::Error>> {
    let stripe_secret_key =
        resolve_stripe_secret_key(config.stripe_secret_key.clone(), config.strict_production)?;
    let _stripe_public_key =
        resolve_stripe_public_key(config.stripe_public_key.clone(), config.strict_production)?;
    let _stripe_webhook_secret = resolve_stripe_webhook_secret(
        config.stripe_webhook_secret.clone(),
        config.strict_production,
    )?;

    tracing::info!("Unified Engine: Connecting to PostgreSQL...");
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await?;

    crate::db_startup_diag::log_postgres_startup_context(&pool).await;

    if let Err(e) = crate::schema_bootstrap::ensure_core_schema(&pool).await {
        tracing::error!(error = %e, "Unified Engine: Schema bootstrap failed");
        return Err(e.into());
    }
    tracing::info!("Unified Engine: Core database schema OK.");

    let counterpoint_sync_token = std::env::var("COUNTERPOINT_SYNC_TOKEN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

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
        stripe_client: stripe::Client::new(stripe_secret_key),
        http_client,
        podium_token_cache: std::sync::Arc::new(tokio::sync::Mutex::new(
            crate::logic::podium::PodiumTokenCache::default(),
        )),
        database_url: config.database_url.clone(),
        counterpoint_sync_token,
        wedding_events: WeddingEventBus::new(),
        payment_intent_minute: std::sync::Arc::new(tokio::sync::Mutex::new(
            crate::api::PaymentIntentMinuteWindow {
                window_start: std::time::Instant::now(),
                count: 0,
            },
        )),
        payment_intent_max_per_minute,
        store_customer_jwt_secret,
        store_account_rate: std::sync::Arc::new(tokio::sync::Mutex::new(
            crate::api::store_account_rate::StoreAccountRateState::default(),
        )),
        store_account_unauth_post_per_minute_ip,
        store_account_authed_per_minute,
        meilisearch,
        server_log_ring: server_log_ring.clone(),
    };

    // Workers
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
    let serve_dir = ServeDir::new(dist_path)
        .append_index_html_on_directories(true)
        .not_found_service(ServeFile::new(index_path));

    let max_body = config.max_body_bytes.unwrap_or(256 * 1024 * 1024);

    let app = build_router()
        .layer(DefaultBodyLimit::max(max_body))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
        .fallback_service(serve_dir);

    let listener = TcpListener::bind(&config.bind_addr).await?;
    tracing::info!(addr = %config.bind_addr, "Riverside OS Unified Engine listening");

    serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_stripe_public_key, resolve_stripe_secret_key, resolve_stripe_webhook_secret,
    };

    #[test]
    fn strict_production_rejects_dummy_and_test_stripe_keys() {
        assert!(
            resolve_stripe_secret_key("sk_test_dummy_replace_me_later".to_string(), true).is_err()
        );
        assert!(resolve_stripe_secret_key("sk_test_123".to_string(), true).is_err());
        assert!(resolve_stripe_secret_key("".to_string(), true).is_err());
    }

    #[test]
    fn strict_production_accepts_live_stripe_key() {
        let key = resolve_stripe_secret_key(" sk_live_123 ".to_string(), true).unwrap();
        assert_eq!(key, "sk_live_123");
    }

    #[test]
    fn non_strict_mode_preserves_dev_fallback_behavior() {
        let key =
            resolve_stripe_secret_key("sk_test_dummy_replace_me_later".to_string(), false).unwrap();
        assert_eq!(key, "sk_test_dummy_replace_me_later");
    }

    #[test]
    fn strict_production_rejects_missing_or_test_stripe_public_key() {
        assert!(resolve_stripe_public_key(String::new(), true).is_err());
        assert!(resolve_stripe_public_key("pk_test_123".to_string(), true).is_err());
        assert!(resolve_stripe_public_key("pk_live_placeholder".to_string(), true).is_err());
    }

    #[test]
    fn strict_production_accepts_live_stripe_public_key() {
        let key = resolve_stripe_public_key(" pk_live_123 ".to_string(), true).unwrap();
        assert_eq!(key, "pk_live_123");
    }

    #[test]
    fn strict_production_allows_missing_webhook_secret_but_rejects_invalid_configured_value() {
        assert!(resolve_stripe_webhook_secret(None, true).unwrap().is_none());
        assert!(
            resolve_stripe_webhook_secret(Some("whsec_placeholder".to_string()), true).is_err()
        );
        assert!(resolve_stripe_webhook_secret(Some("not-a-secret".to_string()), true).is_err());
    }

    #[test]
    fn strict_production_accepts_valid_webhook_secret_when_configured() {
        let secret =
            resolve_stripe_webhook_secret(Some(" whsec_live_123 ".to_string()), true).unwrap();
        assert_eq!(secret.as_deref(), Some("whsec_live_123"));
    }
}

async fn start_backup_worker(state: AppState) -> Result<(), anyhow::Error> {
    let sched = JobScheduler::new().await?;
    let cleanup_state = state.clone();
    let cleanup_job = Job::new_async("0 0 * * * *", move |_uuid, _l| {
        let st = cleanup_state.clone();
        Box::pin(async move {
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
            let now = chrono::Local::now().format("%H:%M").to_string();
            let parts: Vec<&str> = settings.schedule_cron.split_whitespace().collect();
            if parts.len() >= 2 {
                let hour = parts[1].parse::<u32>().unwrap_or(2);
                let minute = parts[0].parse::<u32>().unwrap_or(0);
                if now == format!("{hour:02}:{minute:02}") {
                    let manager = BackupManager::new(st.database_url.clone());
                    if let Ok(filename) = manager.create_backup().await {
                        let _ = record_local_backup_success(&st.db).await;
                        if settings.cloud_storage_enabled
                            && manager.sync_to_cloud(&filename, &settings).await.is_ok()
                        {
                            let _ = record_cloud_backup_success(&st.db).await;
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
