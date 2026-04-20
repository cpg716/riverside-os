//! Riverside OS Standalone HTTP server (Binary wrapper for library).

use riverside_server::launcher::{launch_server, LauncherConfig};
use riverside_server::observability::{init_tracing_with_optional_otel, ServerLogRing};
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();

    // Setup logging
    let server_log_ring = ServerLogRing::new(800, 2_048);
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("riverside_server=info,warn"));
    init_tracing_with_optional_otel(server_log_ring.clone(), env_filter);

    // Load configuration from environment
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:password@localhost/riverside_os".to_string());

    let stripe_secret_key = std::env::var("STRIPE_SECRET_KEY")
        .unwrap_or_else(|_| "sk_test_dummy_replace_me_later".to_string());
    let stripe_public_key = std::env::var("STRIPE_PUBLIC_KEY").unwrap_or_default();
    let stripe_webhook_secret = std::env::var("STRIPE_WEBHOOK_SECRET").ok();

    let bind_addr =
        std::env::var("RIVERSIDE_HTTP_BIND").unwrap_or_else(|_| "0.0.0.0:3000".to_string());

    let frontend_dist = std::env::var("FRONTEND_DIST").ok().map(PathBuf::from);

    let cors_origins: Vec<String> = std::env::var("RIVERSIDE_CORS_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let strict_production = std::env::var("RIVERSIDE_STRICT_PRODUCTION")
        .unwrap_or_default()
        .eq_ignore_ascii_case("true");

    let max_body_bytes = std::env::var("RIVERSIDE_MAX_BODY_BYTES")
        .ok()
        .and_then(|s| s.parse().ok());

    let config = LauncherConfig {
        database_url,
        stripe_secret_key,
        stripe_public_key,
        stripe_webhook_secret,
        bind_addr,
        frontend_dist,
        cors_origins,
        strict_production,
        max_body_bytes,
    };

    launch_server(config, server_log_ring).await
}
