//! HTTP API (Axum): maps domain types to JSON and status codes for the Tauri POS.

use axum::Router;
use rust_decimal::Decimal;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

pub mod alterations;
pub mod bug_reports;
pub mod categories;
pub mod counterpoint_sync;
pub mod customers;
pub mod discount_events;
pub mod gift_cards;
pub mod hardware;
pub mod help;
pub mod insights;
pub mod inventory;
pub mod loyalty;
pub mod metabase_proxy;
pub mod notifications;
pub mod ops;
pub mod payments;
pub mod physical_inventory;
pub mod pos;
pub mod pos_parked_sales;
pub mod products;
pub mod public_api;
pub mod purchase_orders;
pub mod qbo;
pub mod reviews;
pub mod sessions;
pub mod settings;
pub mod shipments;
pub mod staff;
pub mod staff_schedule;
pub mod store;
pub mod store_account;
pub mod store_account_rate;
pub mod tasks;
pub mod test_support;
pub mod transactions;
pub mod vendors;
pub mod weather;
pub mod webhooks;
pub mod weddings;

use meilisearch_sdk::client::Client as MeilisearchClient;
use stripe::Client as StripeClient;

use crate::logic::corecard::{CoreCardConfig, CoreCardTokenCache};
use crate::logic::wedding_push::WeddingEventBus;
use crate::observability::ServerLogRing;

/// Sliding 60s window for `POST /api/payments/intent` (global). `max_per_minute == 0` disables.
#[derive(Debug)]
pub struct PaymentIntentMinuteWindow {
    pub window_start: Instant,
    pub count: u32,
}

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub global_employee_markup: Decimal,
    pub stripe_client: StripeClient,
    /// Shared HTTP client (Visual Crossing weather, Podium, etc.).
    pub http_client: reqwest::Client,
    /// Cached Podium OAuth access token (refresh with env credentials).
    pub podium_token_cache:
        std::sync::Arc<tokio::sync::Mutex<crate::logic::podium::PodiumTokenCache>>,
    pub database_url: String,
    /// When set, `/api/sync/counterpoint/*` accepts `x-ros-sync-token` or `Authorization: Bearer …`.
    pub counterpoint_sync_token: Option<String>,
    pub wedding_events: WeddingEventBus,
    pub payment_intent_minute: Arc<Mutex<PaymentIntentMinuteWindow>>,
    pub payment_intent_max_per_minute: u32,
    /// HS256 secret for `POST /api/store/account/login` JWTs (`RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`).
    pub store_customer_jwt_secret: std::sync::Arc<[u8]>,
    pub store_account_rate: Arc<Mutex<store_account_rate::StoreAccountRateState>>,
    /// Per client key (IP / `X-Forwarded-For`) per rolling minute for login, register, activate. **0** = unlimited.
    pub store_account_unauth_post_per_minute_ip: u32,
    /// Per `customer_id` per rolling minute for authenticated account routes. **0** = unlimited.
    pub store_account_authed_per_minute: u32,
    /// Optional Meilisearch sidecar (`RIVERSIDE_MEILISEARCH_URL`). When `None`, search uses PostgreSQL only.
    pub meilisearch: Option<MeilisearchClient>,
    /// CoreCard / CoreCredit integration broker settings (server-side only).
    pub corecard_config: CoreCardConfig,
    /// Cached CoreCard bearer token for server-to-server requests.
    pub corecard_token_cache: std::sync::Arc<tokio::sync::Mutex<CoreCardTokenCache>>,
    /// Shared host-machine ROSIE speech playback state for TTS start/stop/status.
    pub rosie_speech_state: crate::logic::rosie_speech::RosieSpeechState,
    /// Recent API server `tracing` lines (shared with [`ServerLogRingLayer`](crate::observability::ServerLogRingLayer)).
    pub server_log_ring: ServerLogRing,
}
pub fn build_router() -> Router<AppState> {
    let mut router = Router::new()
        .merge(metabase_proxy::router())
        .nest("/api/inventory", inventory::router())
        .nest("/api/inventory/physical", physical_inventory::router())
        .nest("/api/alterations", alterations::router())
        .nest("/api/insights", insights::router())
        .nest("/api/transactions", transactions::router())
        .nest("/api/categories", categories::router())
        .nest("/api/products", products::router())
        .nest("/api/discount-events", discount_events::router())
        .nest("/api/purchase-orders", purchase_orders::router())
        .nest("/api/qbo", qbo::router())
        .nest(
            "/api/auth",
            staff::auth_router().nest("/qbo", qbo::auth_router()),
        )
        .nest("/api/vendors", vendors::router())
        .nest(
            "/api/sessions",
            sessions::router().merge(crate::api::pos_parked_sales::session_subrouter()),
        )
        .nest("/api/staff", staff::router())
        .nest("/api/tasks", tasks::router())
        .nest("/api/payments", payments::router())
        .nest("/api/pos", pos::router())
        .nest("/api/customers", customers::router())
        .nest("/api/gift-cards", gift_cards::router())
        .nest("/api/help", help::router())
        .nest("/api/loyalty", loyalty::router())
        .nest("/api/reviews", reviews::router())
        .nest("/api/notifications", notifications::router())
        .nest("/api/ops", ops::router())
        .nest(
            "/api/settings",
            settings::router().merge(bug_reports::settings_subrouter()),
        )
        .nest("/api/bug-reports", bug_reports::submit_router())
        .nest("/api/shipments", shipments::router())
        .nest("/api/store", store::public_router())
        .nest("/api/admin/store", store::admin_router())
        .nest("/api/public", public_api::router())
        .nest("/api/webhooks", webhooks::router())
        .nest("/api/integrations", webhooks::integrations_router())
        .nest("/api/weddings", weddings::router())
        .nest("/api/weather", weather::router())
        .nest("/api/hardware", hardware::router())
        .nest("/api/sync", counterpoint_sync::router())
        .nest(
            "/api/settings/counterpoint-sync",
            counterpoint_sync::settings_router(),
        );

    if matches!(
        std::env::var("RIVERSIDE_ENABLE_E2E_TEST_SUPPORT")
            .ok()
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    ) {
        router = router.nest("/api/test-support", test_support::router());
    }

    router
}
