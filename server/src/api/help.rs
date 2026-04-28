//! In-app help: Meilisearch search (`ros_help`), bundled manuals with DB policy overrides, admin editor.

use std::collections::HashSet;
use std::path::{Path as FsPath, PathBuf};

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{Datelike, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;
use uuid::Uuid;

use crate::api::insights::{self, RosieReportingRunRequest};
use crate::api::{customers, inventory, products, transactions, weddings, AppState};
use crate::auth::permissions::{effective_permissions_for_staff, ALL_PERMISSION_KEYS, HELP_MANAGE};
use crate::auth::pins::authenticate_pos_staff;
use crate::auth::pins::AuthenticatedStaff;
use crate::auth::pos_session::HEADER_POS_SESSION_ID;
use crate::logic::help_manual_policy::{
    self, build_admin_manual_catalog, build_manual_detail, build_visible_manual_list,
    delete_help_manual_policy, load_all_policies, upsert_help_manual_policy,
    PutHelpManualPolicyBody,
};
use crate::logic::meilisearch_search::{help_search_hits, HelpSearchHit};
use crate::logic::rosie_intelligence::{self, RosieIntelligencePack};
use crate::logic::rosie_speech;
use crate::middleware;
use crate::models::DbStaffRole;

fn build_rosie_upstream_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(120))
        .pool_max_idle_per_host(0)
        .http1_only()
        .build()
}

async fn send_rosie_upstream_chat_request(
    upstream_client: &reqwest::Client,
    upstream_url: &str,
    body: &Value,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut last_error = None;
    for attempt in 1..=3 {
        match upstream_client.post(upstream_url).json(body).send().await {
            Ok(ok) => return Ok(ok),
            Err(error) => {
                tracing::warn!(
                    attempt,
                    error = %error,
                    %upstream_url,
                    "rosie upstream request attempt failed"
                );
                last_error = Some(error);
                if attempt < 3 {
                    tokio::time::sleep(std::time::Duration::from_millis(250 * attempt as u64))
                        .await;
                }
            }
        }
    }

    Err(last_error.expect("rosie upstream retries should capture a terminal error"))
}

#[derive(Debug, Deserialize)]
pub struct HelpSearchQuery {
    pub q: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct GenerateManifestBody {
    dry_run: bool,
    include_shadcn: bool,
    rescan_components: bool,
    cleanup_orphans: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct ReindexSearchBody {
    full_reindex_fallback: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct AidocsCoverageBody {
    include_all: bool,
    json: bool,
}

#[derive(Debug, Serialize)]
struct AdminOpsStatusOut {
    meilisearch_configured: bool,
    meilisearch_indexing: bool,
    node_available: bool,
    uv_available: bool,
    script_exists: bool,
    aidocs_config_exists: bool,
    help_docs_dir_exists: bool,
}

#[derive(Debug, Serialize)]
struct AdminOpsRunOut {
    ok: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct RosieIntelligenceRefreshBody {
    reindex_search: bool,
    dry_run: bool,
}

#[derive(Debug, Serialize)]
struct RosieIntelligenceRefreshCapabilitiesOut {
    generate_help_manifest: bool,
    reindex_search: bool,
}

#[derive(Debug, Serialize)]
struct RosieIntelligenceStatusOut {
    pack: RosieIntelligencePack,
    last_reindex_at: Option<chrono::DateTime<Utc>>,
    meilisearch_configured: bool,
    node_available: bool,
    refresh_capabilities: RosieIntelligenceRefreshCapabilitiesOut,
}

#[derive(Debug, Serialize)]
struct RosieIntelligenceRefreshOut {
    status: RosieIntelligenceStatusOut,
    generate_manifest: Option<AdminOpsRunOut>,
    reindex_search: Option<AdminOpsRunOut>,
    dry_run: bool,
}

fn default_limit() -> usize {
    12
}

#[derive(Debug, serde::Serialize)]
struct HelpSearchHitOut {
    id: String,
    manual_id: String,
    manual_title: String,
    section_slug: String,
    section_heading: String,
    excerpt: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct RosieToolContextSettings {
    enabled: bool,
    #[serde(rename = "response_style", alias = "verbosity")]
    response_style: String,
    show_citations: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct RosieToolContextRequest {
    question: String,
    #[serde(default = "default_rosie_tool_context_mode")]
    mode: String,
    settings: RosieToolContextSettings,
}

fn default_rosie_tool_context_mode() -> String {
    "help".to_string()
}

#[derive(Debug, Clone, Deserialize)]
struct RosieProductCatalogAnalyzeRequest {
    product_id: Uuid,
}

#[derive(Debug, Clone, Deserialize)]
struct RosieProductCatalogSuggestRequest {
    product_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct RosieVoiceTranscribeRequest {
    audio_base64: String,
}

#[derive(Debug, Serialize)]
struct RosieVoiceTranscribeResponse {
    transcript: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct RosieVoiceSpeakRequest {
    text: String,
    rate: Option<f32>,
    voice: Option<String>,
}

#[derive(Debug, Serialize)]
struct RosieVoiceMessageResponse {
    message: String,
}

#[derive(Debug, Serialize)]
struct RosieVoiceSynthesizeResponse {
    audio_base64: String,
    mime_type: String,
}

#[derive(Debug, Serialize)]
struct RosieVoiceStatusResponse {
    speaking: bool,
}

#[derive(Debug, Clone, Serialize)]
struct RosieToolGroundingSourceOut {
    kind: String,
    title: String,
    excerpt: String,
    content: String,
    manual_id: Option<String>,
    manual_title: Option<String>,
    section_slug: Option<String>,
    section_heading: Option<String>,
    anchor_id: Option<String>,
    report_spec_id: Option<String>,
    report_route: Option<String>,
    route: Option<String>,
    entity_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct RosieToolResultOut {
    tool_name: String,
    args: Value,
    result: Value,
}

#[derive(Debug, Clone, Serialize)]
struct RosieToolContextResponse {
    question: String,
    settings: RosieToolContextSettings,
    sources: Vec<RosieToolGroundingSourceOut>,
    tool_results: Vec<RosieToolResultOut>,
}

#[derive(Debug, Clone, Copy)]
enum HelpSearchMode {
    Meilisearch,
    Unavailable,
}

impl HelpSearchMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Meilisearch => "meilisearch",
            Self::Unavailable => "unavailable",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::http::{HeaderValue, StatusCode};
    use rust_decimal::Decimal;
    use sqlx::PgPool;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use crate::api::{store_account_rate::StoreAccountRateState, PaymentIntentMinuteWindow};
    use crate::auth::permissions::{
        CUSTOMERS_HUB_VIEW, INVENTORY_VIEW_COST, ORDERS_VIEW, WEDDINGS_VIEW,
    };
    use crate::auth::pins::hash_pin;
    use crate::logic::corecard::auth::CoreCardTokenCache;
    use crate::logic::corecard::CoreCardConfig;
    use crate::logic::podium::PodiumTokenCache;
    use crate::logic::wedding_push::WeddingEventBus;
    use crate::observability::ServerLogRing;

    async fn connect_test_db() -> PgPool {
        let database_url = std::env::var("TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .expect("TEST_DATABASE_URL or DATABASE_URL must be set for tests");
        PgPool::connect(&database_url)
            .await
            .expect("connect test database")
    }

    async fn next_staff_code(pool: &PgPool) -> String {
        for _ in 0..128 {
            let candidate = format!("{:04}", (Uuid::new_v4().as_u128() % 10_000) as u16);
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE cashier_code = $1)")
                    .bind(&candidate)
                    .fetch_one(pool)
                    .await
                    .expect("check cashier_code uniqueness");
            if !exists {
                return candidate;
            }
        }
        panic!("could not allocate unique 4-digit cashier code for test staff");
    }

    async fn insert_staff_with_permissions(
        pool: &PgPool,
        role: &str,
        permissions: &[&str],
    ) -> (Uuid, String) {
        let id = Uuid::new_v4();
        let code = next_staff_code(pool).await;
        let pin_hash = hash_pin(&code).expect("hash test staff pin");
        sqlx::query(
            r#"
            INSERT INTO staff (
                id, full_name, cashier_code, pin_hash, role, is_active, avatar_key
            )
            VALUES ($1, $2, $3, $4, $5::staff_role, TRUE, 'ros_default')
            "#,
        )
        .bind(id)
        .bind(format!("ROSIE Operational Test {}", id.simple()))
        .bind(&code)
        .bind(pin_hash)
        .bind(role)
        .execute(pool)
        .await
        .expect("insert test staff");

        for permission in permissions {
            sqlx::query(
                r#"
                INSERT INTO staff_permission (staff_id, permission_key, allowed)
                VALUES ($1, $2, TRUE)
                ON CONFLICT (staff_id, permission_key)
                DO UPDATE SET allowed = EXCLUDED.allowed
                "#,
            )
            .bind(id)
            .bind(permission)
            .execute(pool)
            .await
            .expect("insert test permission");
        }

        (id, code)
    }

    fn build_test_state(pool: PgPool) -> AppState {
        AppState {
            db: pool,
            global_employee_markup: Decimal::new(15, 0),
            stripe_client: stripe::Client::new("sk_test_rosie_operational"),
            http_client: reqwest::Client::new(),
            podium_token_cache: Arc::new(tokio::sync::Mutex::new(PodiumTokenCache::default())),
            database_url: "postgres://test".to_string(),
            counterpoint_sync_token: None,
            wedding_events: WeddingEventBus::new(),
            payment_intent_minute: Arc::new(tokio::sync::Mutex::new(PaymentIntentMinuteWindow {
                window_start: Instant::now(),
                count: 0,
            })),
            payment_intent_max_per_minute: 0,
            store_customer_jwt_secret: Arc::<[u8]>::from(b"rosie-operational-test".as_slice()),
            store_account_rate: Arc::new(tokio::sync::Mutex::new(StoreAccountRateState::default())),
            store_account_unauth_post_per_minute_ip: 0,
            store_account_authed_per_minute: 0,
            meilisearch: None,
            corecard_config: CoreCardConfig::from_env(),
            corecard_token_cache: Arc::new(tokio::sync::Mutex::new(CoreCardTokenCache::default())),
            rosie_speech_state: Arc::new(tokio::sync::Mutex::new(None)),
            server_log_ring: ServerLogRing::new(32, 512),
        }
    }

    fn auth_headers(code: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-riverside-staff-code",
            HeaderValue::from_str(code).expect("staff code header"),
        );
        headers.insert(
            "x-riverside-staff-pin",
            HeaderValue::from_str(code).expect("staff pin header"),
        );
        headers
    }

    async fn insert_customer(pool: &PgPool) -> Uuid {
        let customer_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO customers (
                id, customer_code, first_name, last_name, phone, customer_created_source
            )
            VALUES ($1, $2, 'Taylor', 'River', '5551112222', 'store')
            "#,
        )
        .bind(customer_id)
        .bind(format!("CUST-{}", &customer_id.simple().to_string()[..8]))
        .execute(pool)
        .await
        .expect("insert test customer");
        customer_id
    }

    async fn insert_transaction(pool: &PgPool, customer_id: Option<Uuid>) -> Uuid {
        let transaction_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO transactions (
                id, display_id, booked_at, status, total_price, amount_paid, balance_due, customer_id
            )
            VALUES ($1, $2, NOW(), 'open', 125.00, 25.00, 100.00, $3)
            "#,
        )
        .bind(transaction_id)
        .bind(format!("TXN-{}", &transaction_id.simple().to_string()[..8]))
        .bind(customer_id)
        .execute(pool)
        .await
        .expect("insert test transaction");
        transaction_id
    }

    async fn insert_inventory_variant(pool: &PgPool) -> Uuid {
        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO products (id, name, base_retail_price, base_cost, is_active)
            VALUES ($1, 'Midnight Tux', 199.00, 90.00, TRUE)
            "#,
        )
        .bind(product_id)
        .execute(pool)
        .await
        .expect("insert test product");
        sqlx::query(
            r#"
            INSERT INTO product_variants (
                id, product_id, sku, variation_values, variation_label, stock_on_hand, reserved_stock
            )
            VALUES ($1, $2, 'MTX-42R', '{"size":"42R"}'::jsonb, '42R', 6, 2)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .execute(pool)
        .await
        .expect("insert test variant");
        variant_id
    }

    async fn insert_catalog_analysis_product(pool: &PgPool) -> Uuid {
        let vendor_id = Uuid::new_v4();
        let product_id = Uuid::new_v4();
        let vendor_name = format!("Peerless {}", &vendor_id.simple().to_string()[..8]);
        let supplier_code = format!("MK-{}", &product_id.simple().to_string()[..6]);
        sqlx::query(
            r#"
            INSERT INTO vendors (id, name, vendor_code)
            VALUES ($1, $2, 'PRLS')
            "#,
        )
        .bind(vendor_id)
        .bind(&vendor_name)
        .execute(pool)
        .await
        .expect("insert catalog test vendor");

        sqlx::query(
            r#"
            INSERT INTO products (
                id, name, brand, catalog_handle, primary_vendor_id, base_retail_price, base_cost,
                is_active, variation_axes
            )
            VALUES (
                $1,
                $3,
                'Michael Kors',
                $4,
                $2,
                249.00,
                110.00,
                TRUE,
                ARRAY['size']
            )
            "#,
        )
        .bind(product_id)
        .bind(vendor_id)
        .bind(format!("Peerless {supplier_code} Navy Suit 40R Slim"))
        .bind(&supplier_code)
        .execute(pool)
        .await
        .expect("insert catalog test product");

        for size in ["40R", "42R"] {
            sqlx::query(
                r#"
                INSERT INTO product_variants (
                    id, product_id, sku, variation_values, variation_label, stock_on_hand
                )
                VALUES ($1, $2, $3, jsonb_build_object('size', $4), $4, 3)
                "#,
            )
            .bind(Uuid::new_v4())
            .bind(product_id)
            .bind(format!("{supplier_code}-{size}"))
            .bind(size)
            .execute(pool)
            .await
            .expect("insert catalog test variant");
        }

        product_id
    }

    async fn insert_catalog_ambiguous_product(pool: &PgPool) -> Uuid {
        let vendor_id = Uuid::new_v4();
        let product_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO vendors (id, name, vendor_code)
            VALUES ($1, $2, 'PRLS')
            "#,
        )
        .bind(vendor_id)
        .bind(format!("Peerless {}", &vendor_id.simple().to_string()[..8]))
        .execute(pool)
        .await
        .expect("insert ambiguous vendor");

        sqlx::query(
            r#"
            INSERT INTO products (
                id, name, primary_vendor_id, base_retail_price, base_cost, is_active, variation_axes
            )
            VALUES (
                $1,
                'Wedding Navy / Black Statement Collection',
                $2,
                249.00,
                110.00,
                TRUE,
                ARRAY['color', 'size']
            )
            "#,
        )
        .bind(product_id)
        .bind(vendor_id)
        .execute(pool)
        .await
        .expect("insert ambiguous product");

        for (color, size) in [("Navy", "40R"), ("Black", "42R")] {
            sqlx::query(
                r#"
                INSERT INTO product_variants (
                    id, product_id, sku, variation_values, variation_label, stock_on_hand
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    jsonb_build_object('color', $4, 'size', $5),
                    CONCAT($4, ' / ', $5),
                    2
                )
                "#,
            )
            .bind(Uuid::new_v4())
            .bind(product_id)
            .bind(format!("AMB-{}-{}", color.to_ascii_uppercase(), size))
            .bind(color)
            .bind(size)
            .execute(pool)
            .await
            .expect("insert ambiguous variant");
        }

        product_id
    }

    fn base_request(question: String) -> RosieToolContextRequest {
        RosieToolContextRequest {
            question,
            mode: "conversation".to_string(),
            settings: RosieToolContextSettings {
                enabled: true,
                response_style: "concise".to_string(),
                show_citations: true,
            },
        }
    }

    #[tokio::test]
    async fn rosie_tool_context_runs_order_summary() {
        let pool = connect_test_db().await;
        let customer_id = insert_customer(&pool).await;
        let transaction_id = insert_transaction(&pool, Some(customer_id)).await;
        let (_staff_id, code) =
            insert_staff_with_permissions(&pool, "salesperson", &[ORDERS_VIEW]).await;
        let state = build_test_state(pool);

        let Json(response) = rosie_tool_context(
            State(state),
            auth_headers(&code),
            Json(base_request(format!(
                "show order summary for transaction {transaction_id}"
            ))),
        )
        .await
        .expect("order summary should execute");

        assert!(response
            .tool_results
            .iter()
            .any(|tool| tool.tool_name == "order_summary"));
    }

    #[tokio::test]
    async fn rosie_tool_context_runs_customer_hub_snapshot() {
        let pool = connect_test_db().await;
        let customer_id = insert_customer(&pool).await;
        let (_staff_id, code) =
            insert_staff_with_permissions(&pool, "salesperson", &[CUSTOMERS_HUB_VIEW]).await;
        let state = build_test_state(pool);

        let Json(response) = rosie_tool_context(
            State(state),
            auth_headers(&code),
            Json(base_request(format!(
                "show customer hub for customer {customer_id}"
            ))),
        )
        .await
        .expect("customer hub snapshot should execute");

        assert!(response
            .tool_results
            .iter()
            .any(|tool| tool.tool_name == "customer_hub_snapshot"));
    }

    #[tokio::test]
    async fn rosie_tool_context_runs_wedding_actions() {
        let pool = connect_test_db().await;
        let (_staff_id, code) =
            insert_staff_with_permissions(&pool, "salesperson", &[WEDDINGS_VIEW]).await;
        let state = build_test_state(pool);

        let Json(response) = rosie_tool_context(
            State(state),
            auth_headers(&code),
            Json(base_request(
                "what wedding actions need attention this week".to_string(),
            )),
        )
        .await
        .expect("wedding actions should execute");

        assert!(response
            .tool_results
            .iter()
            .any(|tool| tool.tool_name == "wedding_actions"));
    }

    #[tokio::test]
    async fn rosie_tool_context_runs_inventory_variant_intelligence() {
        let pool = connect_test_db().await;
        let variant_id = insert_inventory_variant(&pool).await;
        let (_staff_id, code) =
            insert_staff_with_permissions(&pool, "salesperson", &[INVENTORY_VIEW_COST]).await;
        let state = build_test_state(pool);

        let Json(response) = rosie_tool_context(
            State(state),
            auth_headers(&code),
            Json(base_request(format!(
                "show inventory intelligence for variant {variant_id}"
            ))),
        )
        .await
        .expect("inventory intelligence should execute");

        assert!(response
            .tool_results
            .iter()
            .any(|tool| tool.tool_name == "inventory_variant_intelligence"));
        let inventory_result = response
            .tool_results
            .iter()
            .find(|tool| tool.tool_name == "inventory_variant_intelligence")
            .expect("inventory tool result");
        assert!(
            inventory_result.result.get("unit_cost").is_none(),
            "ROSIE must not expose inventory cost to non-admin staff"
        );
    }

    #[tokio::test]
    async fn rosie_tool_context_preserves_operational_permissions() {
        let pool = connect_test_db().await;
        let customer_id = insert_customer(&pool).await;
        let (_staff_id, code) =
            insert_staff_with_permissions(&pool, "salesperson", &[ORDERS_VIEW]).await;
        let state = build_test_state(pool);

        let err = rosie_tool_context(
            State(state),
            auth_headers(&code),
            Json(base_request(format!(
                "show customer hub for customer {customer_id}"
            ))),
        )
        .await
        .expect_err("customer hub permission should be enforced");

        assert_eq!(err.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn rosie_tool_context_does_not_leak_unsupported_operational_tools() {
        let pool = connect_test_db().await;
        let (_staff_id, code) = insert_staff_with_permissions(&pool, "salesperson", &[]).await;
        let state = build_test_state(pool);

        let Json(response) = rosie_tool_context(
            State(state),
            auth_headers(&code),
            Json(base_request("how do I close the register".to_string())),
        )
        .await
        .expect("help-only question should still succeed");

        assert!(!response.tool_results.iter().any(|tool| {
            matches!(
                tool.tool_name.as_str(),
                "order_summary"
                    | "customer_hub_snapshot"
                    | "wedding_actions"
                    | "inventory_variant_intelligence"
            )
        }));
    }

    #[tokio::test]
    async fn rosie_product_catalog_analysis_returns_structured_fields() {
        let pool = connect_test_db().await;
        let product_id = insert_catalog_analysis_product(&pool).await;
        let (_staff_id, code) = insert_staff_with_permissions(
            &pool,
            "salesperson",
            &[crate::auth::permissions::CATALOG_VIEW],
        )
        .await;
        let state = build_test_state(pool);

        let Json(response) = rosie_product_catalog_analysis(
            State(state),
            auth_headers(&code),
            Json(RosieProductCatalogAnalyzeRequest { product_id }),
        )
        .await
        .expect("catalog analysis should succeed");

        assert_eq!(response["tool_name"], "product_catalog_analyze");
        assert!(response["parsed_fields"]["vendor"]
            .as_str()
            .is_some_and(|value| value.starts_with("Peerless ")));
        assert_eq!(response["parsed_fields"]["brand"], "Michael Kors");
        assert!(response["parsed_fields"]["supplier_code"]
            .as_str()
            .is_some_and(|value| value.starts_with("MK-")));
        assert_eq!(response["parsed_fields"]["product_type"], "Suit");
    }

    #[tokio::test]
    async fn rosie_product_catalog_analysis_preserves_permissions() {
        let pool = connect_test_db().await;
        let product_id = insert_catalog_analysis_product(&pool).await;
        let (_staff_id, code) = insert_staff_with_permissions(&pool, "salesperson", &[]).await;
        let state = build_test_state(pool);

        let err = rosie_product_catalog_analysis(
            State(state),
            auth_headers(&code),
            Json(RosieProductCatalogAnalyzeRequest { product_id }),
        )
        .await
        .expect_err("catalog analysis should preserve permissions");

        assert_eq!(err.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn rosie_product_catalog_analysis_is_read_only() {
        let pool = connect_test_db().await;
        let product_id = insert_catalog_analysis_product(&pool).await;
        let before_name: String = sqlx::query_scalar("SELECT name FROM products WHERE id = $1")
            .bind(product_id)
            .fetch_one(&pool)
            .await
            .expect("load product before");
        let (_staff_id, code) = insert_staff_with_permissions(
            &pool,
            "salesperson",
            &[crate::auth::permissions::CATALOG_VIEW],
        )
        .await;
        let state = build_test_state(pool.clone());

        let _ = rosie_product_catalog_analysis(
            State(state),
            auth_headers(&code),
            Json(RosieProductCatalogAnalyzeRequest { product_id }),
        )
        .await
        .expect("catalog analysis should complete");

        let after_name: String = sqlx::query_scalar("SELECT name FROM products WHERE id = $1")
            .bind(product_id)
            .fetch_one(&pool)
            .await
            .expect("load product after");
        assert_eq!(before_name, after_name);
    }

    #[tokio::test]
    async fn rosie_product_catalog_suggestion_returns_grounded_parent_title() {
        let pool = connect_test_db().await;
        let product_id = insert_catalog_analysis_product(&pool).await;
        let (_staff_id, code) = insert_staff_with_permissions(
            &pool,
            "salesperson",
            &[crate::auth::permissions::CATALOG_VIEW],
        )
        .await;
        let state = build_test_state(pool);

        let Json(response) = rosie_product_catalog_suggestion(
            State(state),
            auth_headers(&code),
            Json(RosieProductCatalogSuggestRequest { product_id }),
        )
        .await
        .expect("catalog suggestion should succeed");

        assert_eq!(response["tool_name"], "product_catalog_suggest");
        assert!(response["suggested_parent_title"]
            .as_str()
            .is_some_and(|value| value.starts_with("Michael Kors Suit MK-")));
        assert_eq!(response["suggested_variant_fields"]["size"], "40R");
    }

    #[tokio::test]
    async fn rosie_product_catalog_suggestion_withholds_low_confidence_titles() {
        let pool = connect_test_db().await;
        let product_id = insert_catalog_ambiguous_product(&pool).await;
        let (_staff_id, code) = insert_staff_with_permissions(
            &pool,
            "salesperson",
            &[crate::auth::permissions::CATALOG_VIEW],
        )
        .await;
        let state = build_test_state(pool);

        let Json(response) = rosie_product_catalog_suggestion(
            State(state),
            auth_headers(&code),
            Json(RosieProductCatalogSuggestRequest { product_id }),
        )
        .await
        .expect("catalog suggestion should succeed");

        assert!(response["suggested_parent_title"].is_null());
        assert!(response["suggestion_issues"]
            .as_array()
            .is_some_and(|issues| issues.iter().any(|issue| {
                issue
                    .as_str()
                    .is_some_and(|message| message.contains("withheld"))
            })));
    }

    #[tokio::test]
    async fn rosie_intelligence_status_returns_governed_pack() {
        let pool = connect_test_db().await;
        let (_staff_id, code) = insert_staff_with_permissions(&pool, "admin", &[HELP_MANAGE]).await;
        let state = build_test_state(pool);

        let Json(response) = rosie_intelligence_status(State(state), auth_headers(&code))
            .await
            .expect("intelligence status should succeed");

        assert_eq!(
            response.pack.policy_pack_version,
            crate::logic::rosie_intelligence::ROSIE_POLICY_PACK_VERSION
        );
        assert!(response
            .pack
            .approved_source_groups
            .iter()
            .any(|group| group.key == "policy_contracts"));
        assert!(response
            .pack
            .excluded_source_rules
            .iter()
            .any(|rule| rule.contains("conversation history")));
    }

    #[tokio::test]
    async fn rosie_intelligence_refresh_dry_run_preserves_governance_boundaries() {
        let pool = connect_test_db().await;
        let (_staff_id, code) = insert_staff_with_permissions(&pool, "admin", &[HELP_MANAGE]).await;
        let state = build_test_state(pool);

        let Json(response) = rosie_intelligence_refresh(
            State(state),
            auth_headers(&code),
            Json(RosieIntelligenceRefreshBody {
                reindex_search: true,
                dry_run: true,
            }),
        )
        .await
        .expect("dry-run refresh should succeed");

        assert!(response.dry_run);
        assert!(response.generate_manifest.is_none());
        assert!(response.reindex_search.is_none());
        assert!(response
            .status
            .pack
            .approved_source_groups
            .iter()
            .any(|group| group.key == "generated_help_outputs"));
    }

    #[tokio::test]
    async fn rosie_intelligence_status_requires_help_manage() {
        let pool = connect_test_db().await;
        let (_staff_id, code) = insert_staff_with_permissions(&pool, "salesperson", &[]).await;
        let state = build_test_state(pool);

        let err = rosie_intelligence_status(State(state), auth_headers(&code))
            .await
            .expect_err("status should preserve help.manage permission");

        assert_eq!(err.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn rosie_chat_proxy_retries_transport_failures() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind retry test listener");
        let address = listener.local_addr().expect("retry test local addr");
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_for_server = Arc::clone(&attempts);

        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.expect("accept retry test socket");
                let attempt = attempts_for_server.fetch_add(1, Ordering::SeqCst) + 1;

                if attempt < 3 {
                    let mut buffer = [0_u8; 1024];
                    let _ = socket.read(&mut buffer).await;
                    drop(socket);
                    continue;
                }

                let mut request = Vec::new();
                let mut chunk = [0_u8; 1024];
                loop {
                    let read = socket
                        .read(&mut chunk)
                        .await
                        .expect("read retry test request");
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }

                let body = br#"{"choices":[{"index":0,"message":{"role":"assistant","content":"Proxy retry ok."}}]}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("write retry test headers");
                socket.write_all(body).await.expect("write retry test body");
                break;
            }
        });

        let client = build_rosie_upstream_client().expect("build rosie upstream client");
        let response = send_rosie_upstream_chat_request(
            &client,
            &format!("http://{address}/v1/chat/completions"),
            &serde_json::json!({
                "model": "local",
                "messages": [{ "role": "user", "content": "Say retry ok." }],
            }),
        )
        .await
        .expect("proxy should retry into a successful response");
        let payload = response
            .json::<Value>()
            .await
            .expect("retry test response json");

        server.await.expect("retry test server");

        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert_eq!(
            payload["choices"][0]["message"]["content"],
            Value::String("Proxy retry ok.".to_string())
        );
    }
}

fn excerpt_from_body(body: &str, max: usize) -> String {
    let t = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.len() <= max {
        t
    } else {
        format!(
            "{}…",
            t.chars().take(max.saturating_sub(1)).collect::<String>()
        )
    }
}

fn map_hit(h: HelpSearchHit) -> HelpSearchHitOut {
    let excerpt = excerpt_from_body(&h.body, 220);
    HelpSearchHitOut {
        id: h.id,
        manual_id: h.manual_id,
        manual_title: h.manual_title,
        section_slug: h.section_slug,
        section_heading: h.section_heading,
        excerpt,
    }
}

fn sanitize_excerpt(text: &str, max: usize) -> String {
    excerpt_from_body(text, max)
}

fn scrub_sensitive_economics_for_non_admin(value: &mut Value) {
    match value {
        Value::Object(object) => {
            const SENSITIVE_KEYS: &[&str] = &[
                "unit_cost",
                "cost",
                "cost_price",
                "base_cost",
                "cost_override",
                "cost_of_goods",
                "gross_margin",
                "margin",
                "margin_percent",
                "average_margin",
                "profit",
                "profit_margin",
            ];
            for key in SENSITIVE_KEYS {
                object.remove(*key);
            }
            for child in object.values_mut() {
                scrub_sensitive_economics_for_non_admin(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                scrub_sensitive_economics_for_non_admin(item);
            }
        }
        _ => {}
    }
}

fn rosie_sanitize_tool_result_for_viewer(mut result: Value, viewer: &HelpViewer) -> Value {
    if !viewer.is_admin {
        scrub_sensitive_economics_for_non_admin(&mut result);
    }
    result
}

fn question_tokens(question: &str) -> impl Iterator<Item = String> + '_ {
    question.split_whitespace().map(|token| {
        token
            .trim_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
            .to_ascii_lowercase()
    })
}

fn parse_dates_from_question(question: &str) -> Option<(NaiveDate, NaiveDate)> {
    let today = Utc::now().date_naive();
    let lower = question.to_ascii_lowercase();

    let parsed = question_tokens(question)
        .filter_map(|token| NaiveDate::parse_from_str(&token, "%Y-%m-%d").ok())
        .collect::<Vec<_>>();
    if parsed.len() >= 2 {
        let mut dates = parsed;
        dates.sort();
        return Some((dates[0], *dates.last().unwrap_or(&dates[0])));
    }
    if let Some(date) = parsed.first().copied() {
        return Some((date, date));
    }

    if lower.contains("yesterday") {
        let day = today - Duration::days(1);
        return Some((day, day));
    }
    if lower.contains("today") {
        return Some((today, today));
    }
    if lower.contains("last 7 days") || lower.contains("past 7 days") || lower.contains("last week")
    {
        return Some((today - Duration::days(6), today));
    }
    if lower.contains("last 30 days") || lower.contains("past 30 days") {
        return Some((today - Duration::days(29), today));
    }
    if lower.contains("this week") {
        let weekday_offset = i64::from(today.weekday().num_days_from_sunday());
        return Some((today - Duration::days(weekday_offset), today));
    }
    if lower.contains("this month") {
        if let Some(start) = today.with_day(1) {
            return Some((start, today));
        }
    }
    if lower.contains("last month") {
        if let Some(this_month_start) = today.with_day(1) {
            let last_month_end = this_month_start - Duration::days(1);
            if let Some(last_month_start) = last_month_end.with_day(1) {
                return Some((last_month_start, last_month_end));
            }
        }
    }

    None
}

fn default_reporting_window() -> (NaiveDate, NaiveDate) {
    let today = Utc::now().date_naive();
    (today - Duration::days(29), today)
}

fn parse_basis_from_question(question: &str) -> &'static str {
    let lower = question.to_ascii_lowercase();
    if lower.contains("completed")
        || lower.contains("pickup")
        || lower.contains("picked up")
        || lower.contains("fulfilled")
        || lower.contains("recognition")
    {
        "completed"
    } else {
        "booked"
    }
}

fn parse_sales_group_by(question: &str) -> &'static str {
    let lower = question.to_ascii_lowercase();
    if lower.contains("by brand") {
        "brand"
    } else if lower.contains("by salesperson") || lower.contains("by staff") {
        "salesperson"
    } else if lower.contains("by customer") {
        "customer"
    } else if lower.contains("by day") || lower.contains("daily") {
        "date"
    } else {
        "category"
    }
}

fn infer_reporting_request(question: &str) -> Option<RosieReportingRunRequest> {
    let lower = question.to_ascii_lowercase();
    let (from, to) = parse_dates_from_question(question).unwrap_or_else(default_reporting_window);
    let basis = parse_basis_from_question(question).to_string();

    let build = |spec_id: &str, params: Value| RosieReportingRunRequest {
        spec_id: spec_id.to_string(),
        params,
    };

    if lower.contains("best seller")
        || lower.contains("best-selling")
        || lower.contains("top seller")
        || lower.contains("top sku")
        || lower.contains("top product")
    {
        return Some(build(
            "best_sellers",
            serde_json::json!({ "from": from, "to": to, "basis": basis, "limit": 100 }),
        ));
    }
    if lower.contains("dead stock")
        || lower.contains("stale inventory")
        || lower.contains("slow-moving stock")
        || lower.contains("slow moving stock")
    {
        return Some(build(
            "dead_stock",
            serde_json::json!({
                "from": from,
                "to": to,
                "basis": basis,
                "limit": 100,
                "max_units_sold": 0
            }),
        ));
    }
    if lower.contains("wedding health")
        || lower.contains("wedding pipeline")
        || lower.contains("members without order")
        || lower.contains("wedding balance")
    {
        return Some(build("wedding_health", serde_json::json!({})));
    }
    if lower.contains("commission") {
        return Some(build(
            "commission_ledger",
            serde_json::json!({ "from": from, "to": to }),
        ));
    }
    if lower.contains("staff performance")
        || lower.contains("salesperson performance")
        || lower.contains("top staff")
    {
        return Some(build(
            "staff_performance",
            serde_json::json!({ "basis": basis }),
        ));
    }
    if lower.contains("override mix")
        || lower.contains("price override")
        || lower.contains("override reason")
    {
        return Some(build(
            "register_override_mix",
            serde_json::json!({ "from": from, "to": to, "basis": basis }),
        ));
    }
    if lower.contains("register day")
        || lower.contains("drawer activity")
        || lower.contains("day activity")
    {
        return Some(build(
            "register_day_activity",
            serde_json::json!({ "from": from, "to": to, "basis": basis }),
        ));
    }
    if lower.contains("register session")
        || lower.contains("closed drawer")
        || lower.contains("cash variance")
    {
        return Some(build(
            "register_sessions",
            serde_json::json!({ "from": from, "to": to, "limit": 200 }),
        ));
    }
    if lower.contains("sales ")
        || lower.starts_with("sales")
        || lower.contains("revenue")
        || lower.contains("sales pivot")
    {
        return Some(build(
            "sales_pivot",
            serde_json::json!({
                "from": from,
                "to": to,
                "basis": basis,
                "group_by": parse_sales_group_by(question)
            }),
        ));
    }

    None
}

fn extract_uuid_token(question: &str) -> Option<Uuid> {
    question
        .split(|c: char| {
            c.is_whitespace() || matches!(c, ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}')
        })
        .find_map(|token| {
            token
                .trim_matches(|c: char| !c.is_ascii_hexdigit() && c != '-')
                .parse::<Uuid>()
                .ok()
        })
}

fn infer_wedding_actions_window(question: &str) -> Option<i64> {
    let lower = question.to_ascii_lowercase();
    if lower.contains("today") || lower.contains("tonight") {
        Some(1)
    } else if lower.contains("this week")
        || lower.contains("next week")
        || lower.contains("next 7 day")
    {
        Some(7)
    } else if lower.contains("this month")
        || lower.contains("next month")
        || lower.contains("30 day")
    {
        Some(30)
    } else if lower.contains("this quarter") || lower.contains("90 day") {
        Some(90)
    } else {
        None
    }
}

fn infer_operational_tool_requests(question: &str, headers: &HeaderMap) -> Vec<(String, Value)> {
    let lower = question.to_ascii_lowercase();
    let mut requests = Vec::new();

    if (lower.contains("wedding") || lower.contains("tuxedo"))
        && (lower.contains("action")
            || lower.contains("needs measure")
            || lower.contains("needs order")
            || lower.contains("what needs attention"))
    {
        requests.push((
            "wedding_actions".to_string(),
            serde_json::json!({
                "days": infer_wedding_actions_window(question).unwrap_or(90)
            }),
        ));
    }

    if let Some(entity_id) = extract_uuid_token(question) {
        if lower.contains("variant")
            || lower.contains("sku")
            || lower.contains("inventory")
            || lower.contains("stock")
        {
            requests.push((
                "inventory_variant_intelligence".to_string(),
                serde_json::json!({ "variant_id": entity_id }),
            ));
        } else if lower.contains("customer")
            || lower.contains("crm")
            || lower.contains("profile")
            || lower.contains("hub")
        {
            requests.push((
                "customer_hub_snapshot".to_string(),
                serde_json::json!({ "customer_id": entity_id }),
            ));
        } else if lower.contains("order")
            || lower.contains("transaction")
            || lower.contains("balance due")
            || lower.contains("pickup")
        {
            requests.push((
                "order_summary".to_string(),
                serde_json::json!({
                    "transaction_id": entity_id,
                    "register_session_id": headers
                        .get(HEADER_POS_SESSION_ID)
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| Uuid::parse_str(value.trim()).ok()),
                }),
            ));
        }
    }

    requests
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(FsPath::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn help_manifest_script_path() -> PathBuf {
    repo_root()
        .join("client")
        .join("scripts")
        .join("generate-help-manifest.mjs")
}

async fn rosie_intelligence_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<RosieIntelligenceStatusOut>, Response> {
    let _staff = middleware::require_staff_with_permission(&state, &headers, HELP_MANAGE)
        .await
        .map_err(|e| e.into_response())?;

    Ok(Json(build_rosie_intelligence_status(&state).await))
}

async fn rosie_intelligence_refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RosieIntelligenceRefreshBody>,
) -> Result<Json<RosieIntelligenceRefreshOut>, Response> {
    let _staff = middleware::require_staff_with_permission(&state, &headers, HELP_MANAGE)
        .await
        .map_err(|e| e.into_response())?;

    let mut generate_manifest = None;
    let mut reindex_search = None;

    if !body.dry_run {
        let script = help_manifest_script_path();
        if !script.exists() {
            return Err((
                axum::http::StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": format!("manifest script not found: {}", script.display())
                })),
            )
                .into_response());
        }

        let mut cmd = Command::new("node");
        cmd.arg(script.as_os_str());
        cmd.current_dir(repo_root());
        let generated = run_command_capture(cmd).await?;
        let generate_ok = generated.ok;
        generate_manifest = Some(generated);

        if !generate_ok {
            let status = build_rosie_intelligence_status(&state).await;
            return Ok(Json(RosieIntelligenceRefreshOut {
                status,
                generate_manifest,
                reindex_search,
                dry_run: false,
            }));
        }

        if body.reindex_search {
            let Some(client) = state.meilisearch.as_ref() else {
                return Err((
                    axum::http::StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": "Meilisearch is not configured" })),
                )
                    .into_response());
            };

            match crate::logic::help_corpus::reindex_help_meilisearch(client).await {
                Ok(()) => {
                    crate::logic::meilisearch_sync::record_sync_status(
                        &state.db,
                        crate::logic::meilisearch_client::INDEX_HELP,
                        true,
                        0,
                        None,
                    )
                    .await;
                    reindex_search = Some(AdminOpsRunOut {
                        ok: true,
                        exit_code: Some(0),
                        stdout: "help search reindex completed".to_string(),
                        stderr: String::new(),
                    });
                }
                Err(error) => {
                    crate::logic::meilisearch_sync::record_sync_status(
                        &state.db,
                        crate::logic::meilisearch_client::INDEX_HELP,
                        false,
                        0,
                        Some(&error.to_string()),
                    )
                    .await;
                    reindex_search = Some(AdminOpsRunOut {
                        ok: false,
                        exit_code: None,
                        stdout: String::new(),
                        stderr: error.to_string(),
                    });
                }
            }
        }
    }

    let status = build_rosie_intelligence_status(&state).await;
    Ok(Json(RosieIntelligenceRefreshOut {
        status,
        generate_manifest,
        reindex_search,
        dry_run: body.dry_run,
    }))
}

async fn run_command_capture(mut cmd: Command) -> Result<AdminOpsRunOut, Response> {
    let out = cmd.output().await.map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("failed to start command: {e}")
            })),
        )
            .into_response()
    })?;
    Ok(AdminOpsRunOut {
        ok: out.status.success(),
        exit_code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

async fn build_rosie_intelligence_status(state: &AppState) -> RosieIntelligenceStatusOut {
    let mut node_cmd = Command::new("node");
    node_cmd.arg("--version");
    let node_available = match node_cmd.output().await {
        Ok(out) => out.status.success(),
        Err(_) => false,
    };

    RosieIntelligenceStatusOut {
        pack: rosie_intelligence::load_rosie_intelligence_pack(&repo_root()),
        last_reindex_at: load_help_reindex_time(&state.db).await,
        meilisearch_configured: state.meilisearch.is_some(),
        node_available,
        refresh_capabilities: RosieIntelligenceRefreshCapabilitiesOut {
            generate_help_manifest: help_manifest_script_path().exists(),
            reindex_search: state.meilisearch.is_some(),
        },
    }
}

async fn load_help_reindex_time(pool: &sqlx::PgPool) -> Option<chrono::DateTime<Utc>> {
    sqlx::query_scalar("SELECT last_success_at FROM meilisearch_sync_status WHERE index_name = $1")
        .bind(crate::logic::meilisearch_client::INDEX_HELP)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

struct HelpViewer {
    pos_only_mode: bool,
    is_admin: bool,
    staff_perms: HashSet<String>,
}

async fn resolve_help_viewer(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<HelpViewer, Response> {
    middleware::require_help_viewer(state, headers)
        .await
        .map_err(|e| e.into_response())?;

    let code = headers
        .get("x-riverside-staff-code")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();

    if !code.is_empty() {
        let pin = headers
            .get("x-riverside-staff-pin")
            .and_then(|v| v.to_str().ok());
        let auth = authenticate_pos_staff(&state.db, code, pin)
            .await
            .map_err(|_| {
                (
                    axum::http::StatusCode::UNAUTHORIZED,
                    axum::Json(serde_json::json!({ "error": "invalid staff credentials" })),
                )
                    .into_response()
            })?;
        let staff_perms = effective_permissions_for_staff(&state.db, auth.id, auth.role)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "effective_permissions failed (help viewer)");
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(serde_json::json!({ "error": "permission resolution failed" })),
                )
                    .into_response()
            })?;
        return Ok(HelpViewer {
            pos_only_mode: false,
            is_admin: auth.role == DbStaffRole::Admin,
            staff_perms,
        });
    }

    Ok(HelpViewer {
        pos_only_mode: true,
        is_admin: false,
        staff_perms: HashSet::new(),
    })
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/search", get(search_help))
        .route("/manuals", get(list_manuals))
        .route("/manuals/{manual_id}", get(get_manual))
        .route("/rosie/v1/tool-context", post(rosie_tool_context))
        .route("/rosie/v1/chat/completions", post(rosie_chat_completions))
        .route("/rosie/v1/runtime-status", get(rosie_runtime_status))
        .route("/rosie/v1/voice/transcribe", post(rosie_voice_transcribe))
        .route("/rosie/v1/voice/synthesize", post(rosie_voice_synthesize))
        .route("/rosie/v1/voice/speak", post(rosie_voice_speak))
        .route("/rosie/v1/voice/stop", post(rosie_voice_stop))
        .route("/rosie/v1/voice/status", get(rosie_voice_status))
        .route(
            "/rosie/v1/intelligence/status",
            get(rosie_intelligence_status),
        )
        .route(
            "/rosie/v1/intelligence/refresh",
            post(rosie_intelligence_refresh),
        )
        .route(
            "/rosie/v1/product-catalog-analyze",
            post(rosie_product_catalog_analysis),
        )
        .route(
            "/rosie/v1/product-catalog-suggest",
            post(rosie_product_catalog_suggestion),
        )
        .route("/admin/manuals", get(admin_list_manuals))
        .route(
            "/admin/manuals/{manual_id}",
            get(admin_get_manual)
                .put(admin_put_manual)
                .delete(admin_delete_manual),
        )
        .route("/admin/ops/status", get(admin_ops_status))
        .route(
            "/admin/ops/generate-manifest",
            post(admin_ops_generate_manifest),
        )
        .route(
            "/admin/ops/aidocs-coverage",
            post(admin_ops_aidocs_coverage),
        )
        .route("/admin/ops/reindex-search", post(admin_ops_reindex_search))
}

async fn rosie_product_catalog_analysis(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RosieProductCatalogAnalyzeRequest>,
) -> Result<Json<Value>, Response> {
    let value = products::rosie_product_catalog_analyze(&state, &headers, body.product_id).await?;
    Ok(Json(value))
}

async fn rosie_product_catalog_suggestion(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RosieProductCatalogSuggestRequest>,
) -> Result<Json<Value>, Response> {
    let value = products::rosie_product_catalog_suggest(&state, &headers, body.product_id).await?;
    Ok(Json(value))
}

async fn search_help(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HelpSearchQuery>,
) -> Result<Json<serde_json::Value>, Response> {
    let viewer = resolve_help_viewer(&state, &headers).await?;
    let policies = load_all_policies(&state.db).await.map_err(|e| {
        tracing::error!(error = %e, "load help_manual_policy");
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({ "error": "help policy load failed" })),
        )
            .into_response()
    })?;

    let query = q.q.trim();
    if query.is_empty() {
        return Ok(Json(serde_json::json!({
            "hits": [],
            "search_mode": HelpSearchMode::Meilisearch.as_str(),
        })));
    }

    let Some(client) = state.meilisearch.as_ref() else {
        return Ok(Json(serde_json::json!({
            "hits": [],
            "search_mode": HelpSearchMode::Unavailable.as_str(),
        })));
    };

    match help_search_hits(client, query, q.limit).await {
        Ok(rows) => {
            let hits: Vec<HelpSearchHitOut> = rows
                .into_iter()
                .filter(|h| {
                    help_manual_policy::viewer_can_see_manual(
                        &h.manual_id,
                        policies.get(&h.manual_id),
                        viewer.pos_only_mode,
                        &viewer.staff_perms,
                    )
                })
                .map(map_hit)
                .collect();
            Ok(Json(serde_json::json!({
                "hits": hits,
                "search_mode": HelpSearchMode::Meilisearch.as_str(),
            })))
        }
        Err(e) => {
            tracing::warn!(error = %e, "help_search_hits failed; returning empty hits");
            Ok(Json(serde_json::json!({
                "hits": [],
                "search_mode": HelpSearchMode::Unavailable.as_str(),
            })))
        }
    }
}

async fn list_manuals(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let viewer = resolve_help_viewer(&state, &headers).await?;
    let manuals = build_visible_manual_list(&state.db, viewer.pos_only_mode, &viewer.staff_perms)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "build_visible_manual_list");
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": "help manuals load failed" })),
            )
                .into_response()
        })?;
    Ok(Json(serde_json::json!({ "manuals": manuals })))
}

async fn get_manual(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(manual_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let viewer = resolve_help_viewer(&state, &headers).await?;
    let detail = build_manual_detail(
        &state.db,
        &manual_id,
        viewer.pos_only_mode,
        &viewer.staff_perms,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "build_manual_detail");
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({ "error": "help manual load failed" })),
        )
            .into_response()
    })?;
    let Some(d) = detail else {
        return Err((
            axum::http::StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({ "error": "manual not found" })),
        )
            .into_response());
    };
    Ok(Json(serde_json::json!(d)))
}

async fn rosie_chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, Response> {
    let _viewer = resolve_help_viewer(&state, &headers).await?;

    let upstream = std::env::var("RIVERSIDE_LLAMA_UPSTREAM")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": "ROSIE upstream is not configured",
                })),
            )
                .into_response()
        })?;

    let upstream_url = format!("{upstream}/v1/chat/completions");
    let upstream_client = build_rosie_upstream_client().map_err(|e| {
        tracing::error!(error = %e, %upstream_url, "rosie upstream client init failed");
        (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "error": "ROSIE upstream is unavailable",
            })),
        )
            .into_response()
    })?;
    let response = send_rosie_upstream_chat_request(&upstream_client, &upstream_url, &body)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, %upstream_url, "rosie upstream request failed");
            (
                axum::http::StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({
                    "error": "ROSIE upstream request failed",
                })),
            )
                .into_response()
        })?;

    let status = response.status();
    let payload = response.json::<Value>().await.map_err(|e| {
        tracing::error!(error = %e, %upstream_url, "rosie upstream response parse failed");
        (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "error": "ROSIE upstream returned an invalid response",
            })),
        )
            .into_response()
    })?;

    Ok((status, Json(payload)).into_response())
}

async fn rosie_runtime_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<rosie_speech::RosieHostRuntimeStatus>, Response> {
    let _viewer = resolve_help_viewer(&state, &headers).await?;
    let status = rosie_speech::runtime_status(&state.rosie_speech_state)
        .await
        .map_err(|error| {
            tracing::error!(%error, "rosie runtime status failed");
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": error })),
            )
                .into_response()
        })?;
    Ok(Json(status))
}

async fn rosie_voice_transcribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RosieVoiceTranscribeRequest>,
) -> Result<Json<RosieVoiceTranscribeResponse>, Response> {
    let _viewer = resolve_help_viewer(&state, &headers).await?;
    let transcript = rosie_speech::transcribe_wav(body.audio_base64.trim())
        .await
        .map_err(|error| {
            tracing::warn!(%error, "rosie voice transcribe failed");
            (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": error })),
            )
                .into_response()
        })?;
    Ok(Json(RosieVoiceTranscribeResponse { transcript }))
}

async fn rosie_voice_speak(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RosieVoiceSpeakRequest>,
) -> Result<Json<RosieVoiceMessageResponse>, Response> {
    let _viewer = resolve_help_viewer(&state, &headers).await?;
    let text = body.text.trim();
    if text.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "text is required" })),
        )
            .into_response());
    }

    let message = rosie_speech::start_tts(
        &state.rosie_speech_state,
        text,
        body.rate,
        body.voice.as_deref(),
    )
    .await
    .map_err(|error| {
        tracing::warn!(%error, "rosie voice speak failed");
        (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response()
    })?;

    Ok(Json(RosieVoiceMessageResponse { message }))
}

async fn rosie_voice_synthesize(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RosieVoiceSpeakRequest>,
) -> Result<Json<RosieVoiceSynthesizeResponse>, Response> {
    let _viewer = resolve_help_viewer(&state, &headers).await?;
    let text = body.text.trim();
    if text.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "text is required" })),
        )
            .into_response());
    }

    let audio_base64 =
        rosie_speech::synthesize_tts_wav_base64(text, body.rate, body.voice.as_deref())
            .await
            .map_err(|error| {
                tracing::warn!(%error, "rosie voice synthesize failed");
                (
                    axum::http::StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": error })),
                )
                    .into_response()
            })?;

    Ok(Json(RosieVoiceSynthesizeResponse {
        audio_base64,
        mime_type: "audio/wav".to_string(),
    }))
}

async fn rosie_voice_stop(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<RosieVoiceMessageResponse>, Response> {
    let _viewer = resolve_help_viewer(&state, &headers).await?;
    let message = rosie_speech::stop_tts(&state.rosie_speech_state)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "rosie voice stop failed");
            (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": error })),
            )
                .into_response()
        })?;
    Ok(Json(RosieVoiceMessageResponse { message }))
}

async fn rosie_voice_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<RosieVoiceStatusResponse>, Response> {
    let _viewer = resolve_help_viewer(&state, &headers).await?;
    let speaking = rosie_speech::tts_status(&state.rosie_speech_state)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "rosie voice status failed");
            (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": error })),
            )
                .into_response()
        })?;
    Ok(Json(RosieVoiceStatusResponse { speaking }))
}

async fn rosie_tool_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RosieToolContextRequest>,
) -> Result<Json<RosieToolContextResponse>, Response> {
    let viewer = resolve_help_viewer(&state, &headers).await?;
    if !body.settings.enabled {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "ROSIE is disabled for this workstation." })),
        )
            .into_response());
    }

    let mut sources = Vec::<RosieToolGroundingSourceOut>::new();
    let mut tool_results = Vec::<RosieToolResultOut>::new();
    let question = body.question.trim();
    let conversation_mode = body.mode.trim().eq_ignore_ascii_case("conversation");
    if question.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "question is required" })),
        )
            .into_response());
    }

    let policies = load_all_policies(&state.db).await.map_err(|e| {
        tracing::error!(error = %e, "load help_manual_policy for ROSIE tool context");
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "help policy load failed" })),
        )
            .into_response()
    })?;

    let help_limit = if conversation_mode { 3 } else { 6 };
    let manual_detail_limit = if conversation_mode { 0 } else { 4 };
    let source_excerpt_limit = if conversation_mode { 700 } else { 1200 };

    let help_hits = if let Some(client) = state.meilisearch.as_ref() {
        match help_search_hits(client, question, help_limit).await {
            Ok(rows) => rows
                .into_iter()
                .filter(|h| {
                    help_manual_policy::viewer_can_see_manual(
                        &h.manual_id,
                        policies.get(&h.manual_id),
                        viewer.pos_only_mode,
                        &viewer.staff_perms,
                    )
                })
                .map(map_hit)
                .collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!(error = %e, "help_search_hits failed in ROSIE tool context");
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    tool_results.push(RosieToolResultOut {
        tool_name: "help_search".to_string(),
        args: serde_json::json!({ "q": question, "limit": help_limit }),
        result: serde_json::json!({ "hits": help_hits }),
    });

    let mut seen_manuals = HashSet::<String>::new();
    for hit in help_hits.iter().take(if conversation_mode { 2 } else { 4 }) {
        sources.push(RosieToolGroundingSourceOut {
            kind: "manual".to_string(),
            title: format!("{} — {}", hit.manual_title, hit.section_heading),
            excerpt: hit.excerpt.clone(),
            content: hit.excerpt.clone(),
            manual_id: Some(hit.manual_id.clone()),
            manual_title: Some(hit.manual_title.clone()),
            section_slug: Some(hit.section_slug.clone()),
            section_heading: Some(hit.section_heading.clone()),
            anchor_id: Some(format!("help-{}-{}", hit.manual_id, hit.section_slug)),
            report_spec_id: None,
            report_route: None,
            route: None,
            entity_id: None,
        });

        if seen_manuals.len() < manual_detail_limit && seen_manuals.insert(hit.manual_id.clone()) {
            let detail = build_manual_detail(
                &state.db,
                &hit.manual_id,
                viewer.pos_only_mode,
                &viewer.staff_perms,
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, manual_id = %hit.manual_id, "build_manual_detail for ROSIE");
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "help manual load failed" })),
                )
                    .into_response()
            })?;

            if let Some(detail) = detail {
                tool_results.push(RosieToolResultOut {
                    tool_name: "help_get_manual".to_string(),
                    args: serde_json::json!({ "manual_id": hit.manual_id }),
                    result: serde_json::json!({
                        "manual_id": detail.id,
                        "title": detail.title,
                        "markdown_excerpt": sanitize_excerpt(&detail.markdown, 600),
                    }),
                });
            }
        }
    }

    let store_sop_markdown = if headers
        .get("x-riverside-staff-code")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        sqlx::query_scalar::<_, String>(
            "SELECT staff_sop_markdown FROM store_settings WHERE id = 1",
        )
        .fetch_one(&state.db)
        .await
        .unwrap_or_default()
    } else {
        String::new()
    };

    tool_results.push(RosieToolResultOut {
        tool_name: "store_sop_get".to_string(),
        args: serde_json::json!({}),
        result: serde_json::json!({
            "available": !store_sop_markdown.trim().is_empty(),
            "markdown": if store_sop_markdown.trim().is_empty() {
                String::new()
            } else {
                sanitize_excerpt(&store_sop_markdown, source_excerpt_limit)
            },
        }),
    });

    if !store_sop_markdown.trim().is_empty() {
        sources.push(RosieToolGroundingSourceOut {
            kind: "store_sop".to_string(),
            title: "Store Staff Playbook".to_string(),
            excerpt: sanitize_excerpt(&store_sop_markdown, 240),
            content: sanitize_excerpt(&store_sop_markdown, source_excerpt_limit),
            manual_id: None,
            manual_title: None,
            section_slug: None,
            section_heading: None,
            anchor_id: None,
            report_spec_id: None,
            report_route: None,
            route: None,
            entity_id: None,
        });
    }

    if conversation_mode {
        if let Some(reporting_request) = infer_reporting_request(question) {
            let reporting_result =
                insights::rosie_reporting_run(&state, &headers, reporting_request)
                    .await
                    .map_err(axum::response::IntoResponse::into_response)?;
            sources.push(RosieToolGroundingSourceOut {
                kind: "report".to_string(),
                title: format!("Report — {}", reporting_result.spec_id.replace('_', " ")),
                excerpt: format!(
                    "{} via {}",
                    reporting_result.spec_id, reporting_result.route
                ),
                content: sanitize_excerpt(&reporting_result.data.to_string(), source_excerpt_limit),
                manual_id: None,
                manual_title: None,
                section_slug: None,
                section_heading: None,
                anchor_id: None,
                report_spec_id: Some(reporting_result.spec_id.clone()),
                report_route: Some(reporting_result.route.to_string()),
                route: Some(reporting_result.route.to_string()),
                entity_id: None,
            });
            tool_results.push(RosieToolResultOut {
                tool_name: "reporting_run".to_string(),
                args: serde_json::json!({
                    "spec_id": reporting_result.spec_id,
                    "params": reporting_result.params,
                }),
                result: serde_json::json!({
                    "route": reporting_result.route,
                    "required_permission": reporting_result.required_permission,
                    "data": reporting_result.data,
                }),
            });
        }

        for (tool_name, args) in infer_operational_tool_requests(question, &headers) {
            match tool_name.as_str() {
                "order_summary" => {
                    let transaction_id = args
                        .get("transaction_id")
                        .and_then(Value::as_str)
                        .and_then(|value| Uuid::parse_str(value).ok())
                        .ok_or_else(|| {
                            (
                                axum::http::StatusCode::BAD_REQUEST,
                                Json(serde_json::json!({
                                    "error": "order_summary requires transaction_id",
                                })),
                            )
                                .into_response()
                        })?;
                    let register_session_id = args
                        .get("register_session_id")
                        .and_then(Value::as_str)
                        .and_then(|value| Uuid::parse_str(value).ok());
                    let result = transactions::rosie_order_summary(
                        &state,
                        &headers,
                        transaction_id,
                        register_session_id,
                    )
                    .await?;
                    let result = rosie_sanitize_tool_result_for_viewer(result, &viewer);
                    let display_id = result
                        .get("transaction_display_id")
                        .and_then(Value::as_str)
                        .unwrap_or("transaction");
                    sources.push(RosieToolGroundingSourceOut {
                        kind: "order".to_string(),
                        title: format!("Order Summary — {display_id}"),
                        excerpt: format!("Read from /api/transactions/{transaction_id}"),
                        content: sanitize_excerpt(&result.to_string(), source_excerpt_limit),
                        manual_id: None,
                        manual_title: None,
                        section_slug: None,
                        section_heading: None,
                        anchor_id: None,
                        report_spec_id: None,
                        report_route: None,
                        route: Some(format!("/api/transactions/{transaction_id}")),
                        entity_id: Some(transaction_id.to_string()),
                    });
                    tool_results.push(RosieToolResultOut {
                        tool_name,
                        args,
                        result,
                    });
                }
                "customer_hub_snapshot" => {
                    let customer_id = args
                        .get("customer_id")
                        .and_then(Value::as_str)
                        .and_then(|value| Uuid::parse_str(value).ok())
                        .ok_or_else(|| {
                            (
                                axum::http::StatusCode::BAD_REQUEST,
                                Json(serde_json::json!({
                                    "error": "customer_hub_snapshot requires customer_id",
                                })),
                            )
                                .into_response()
                        })?;
                    let result =
                        customers::rosie_customer_hub_snapshot(&state, &headers, customer_id)
                            .await?;
                    let result = rosie_sanitize_tool_result_for_viewer(result, &viewer);
                    let customer_name = format!(
                        "{} {}",
                        result
                            .get("first_name")
                            .and_then(Value::as_str)
                            .unwrap_or("Customer"),
                        result
                            .get("last_name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                    )
                    .trim()
                    .to_string();
                    sources.push(RosieToolGroundingSourceOut {
                        kind: "customer".to_string(),
                        title: format!(
                            "Customer Hub — {}",
                            if customer_name.is_empty() {
                                "Customer"
                            } else {
                                customer_name.as_str()
                            }
                        ),
                        excerpt: format!("Read from /api/customers/{customer_id}/hub"),
                        content: sanitize_excerpt(&result.to_string(), source_excerpt_limit),
                        manual_id: None,
                        manual_title: None,
                        section_slug: None,
                        section_heading: None,
                        anchor_id: None,
                        report_spec_id: None,
                        report_route: None,
                        route: Some(format!("/api/customers/{customer_id}/hub")),
                        entity_id: Some(customer_id.to_string()),
                    });
                    tool_results.push(RosieToolResultOut {
                        tool_name,
                        args,
                        result,
                    });
                }
                "wedding_actions" => {
                    let days = args.get("days").and_then(Value::as_i64);
                    let result = weddings::rosie_wedding_actions(&state, &headers, days).await?;
                    let result = rosie_sanitize_tool_result_for_viewer(result, &viewer);
                    sources.push(RosieToolGroundingSourceOut {
                        kind: "wedding".to_string(),
                        title: "Wedding Actions".to_string(),
                        excerpt: format!(
                            "Read from /api/weddings/actions{}",
                            days.map(|value| format!("?days={value}"))
                                .unwrap_or_default()
                        ),
                        content: sanitize_excerpt(&result.to_string(), source_excerpt_limit),
                        manual_id: None,
                        manual_title: None,
                        section_slug: None,
                        section_heading: None,
                        anchor_id: None,
                        report_spec_id: None,
                        report_route: None,
                        route: Some(
                            days.map(|value| format!("/api/weddings/actions?days={value}"))
                                .unwrap_or_else(|| "/api/weddings/actions".to_string()),
                        ),
                        entity_id: None,
                    });
                    tool_results.push(RosieToolResultOut {
                        tool_name,
                        args,
                        result,
                    });
                }
                "inventory_variant_intelligence" => {
                    let variant_id = args
                        .get("variant_id")
                        .and_then(Value::as_str)
                        .and_then(|value| Uuid::parse_str(value).ok())
                        .ok_or_else(|| {
                            (
                                axum::http::StatusCode::BAD_REQUEST,
                                Json(serde_json::json!({
                                    "error": "inventory_variant_intelligence requires variant_id",
                                })),
                            )
                                .into_response()
                        })?;
                    let result = inventory::rosie_inventory_variant_intelligence(
                        &state, &headers, variant_id,
                    )
                    .await?;
                    let result = rosie_sanitize_tool_result_for_viewer(result, &viewer);
                    let sku = result
                        .get("sku")
                        .and_then(Value::as_str)
                        .unwrap_or("variant");
                    sources.push(RosieToolGroundingSourceOut {
                        kind: "inventory".to_string(),
                        title: format!("Inventory Intelligence — {sku}"),
                        excerpt: format!("Read from /api/inventory/intelligence/{variant_id}"),
                        content: sanitize_excerpt(&result.to_string(), source_excerpt_limit),
                        manual_id: None,
                        manual_title: None,
                        section_slug: None,
                        section_heading: None,
                        anchor_id: None,
                        report_spec_id: None,
                        report_route: None,
                        route: Some(format!("/api/inventory/intelligence/{variant_id}")),
                        entity_id: Some(variant_id.to_string()),
                    });
                    tool_results.push(RosieToolResultOut {
                        tool_name,
                        args,
                        result,
                    });
                }
                _ => {}
            }
        }
    }

    Ok(Json(RosieToolContextResponse {
        question: question.to_string(),
        settings: body.settings,
        sources,
        tool_results,
    }))
}

async fn admin_get_manual(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(manual_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let _staff = middleware::require_staff_with_permission(&state, &headers, HELP_MANAGE)
        .await
        .map_err(|e| e.into_response())?;

    let Some(rel) = help_manual_policy::help_manual_rel_path(&manual_id) else {
        return Err((
            axum::http::StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({ "error": "unknown manual id" })),
        )
            .into_response());
    };

    let bundled = help_manual_policy::read_bundled_manual_raw(rel).map_err(|e| {
        tracing::error!(error = %e, "read bundled help manual");
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({ "error": "read bundled manual failed" })),
        )
            .into_response()
    })?;

    let (bundled_title, bundled_summary, bundled_order) =
        help_manual_policy::bundled_front_matter_meta(&bundled, &manual_id);

    let policies = load_all_policies(&state.db).await.map_err(|e| {
        tracing::error!(error = %e, "load policies admin get");
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({ "error": "help policy load failed" })),
        )
            .into_response()
    })?;

    let row = policies.get(&manual_id);
    let (req, pos) = help_manual_policy::default_visibility(&manual_id);
    let def = serde_json::json!({
        "required_permissions": req,
        "allow_register_session": pos,
    });

    Ok(Json(serde_json::json!({
        "manual_id": manual_id,
        "bundled_relative_path": rel,
        "bundled_markdown": bundled,
        "bundled_title": bundled_title,
        "bundled_summary": bundled_summary,
        "bundled_order": bundled_order,
        "default_visibility": def,
        "hidden": row.map(|r| r.hidden).unwrap_or(false),
        "title_override": row.and_then(|r| r.title_override.clone()),
        "summary_override": row.and_then(|r| r.summary_override.clone()),
        "markdown_override": row.and_then(|r| r.markdown_override.clone()),
        "order_override": row.and_then(|r| r.order_override),
        "required_permissions": row.and_then(|r| r.required_permissions.clone()),
        "allow_register_session": row.and_then(|r| r.allow_register_session),
    })))
}

async fn admin_list_manuals(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let _staff: AuthenticatedStaff =
        middleware::require_staff_with_permission(&state, &headers, HELP_MANAGE)
            .await
            .map_err(|e| e.into_response())?;

    let policies = load_all_policies(&state.db).await.map_err(|e| {
        tracing::error!(error = %e, "load help_manual_policy (admin)");
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({ "error": "help policy load failed" })),
        )
            .into_response()
    })?;

    let manuals = build_admin_manual_catalog(&policies).map_err(|e| {
        tracing::error!(error = %e, "build_admin_manual_catalog");
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({ "error": "help catalog build failed" })),
        )
            .into_response()
    })?;

    Ok(Json(serde_json::json!({
        "manuals": manuals,
        "permission_catalog": ALL_PERMISSION_KEYS,
    })))
}

async fn admin_put_manual(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(manual_id): Path<String>,
    Json(body): Json<PutHelpManualPolicyBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let staff = middleware::require_staff_with_permission(&state, &headers, HELP_MANAGE)
        .await
        .map_err(|e| e.into_response())?;

    let known: HashSet<&str> = help_manual_policy::HELP_MANUAL_FILES
        .iter()
        .map(|(id, _)| *id)
        .collect();
    if !known.contains(manual_id.as_str()) {
        return Err((
            axum::http::StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({ "error": "unknown manual id" })),
        )
            .into_response());
    }

    for k in &body.required_permissions {
        if !ALL_PERMISSION_KEYS.contains(&k.as_str()) {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({ "error": "unknown permission key", "key": k })),
            )
                .into_response());
        }
    }

    upsert_help_manual_policy(&state.db, &manual_id, &body, staff.id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "upsert_help_manual_policy");
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": "save failed" })),
            )
                .into_response()
        })?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn admin_delete_manual(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(manual_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let _staff = middleware::require_staff_with_permission(&state, &headers, HELP_MANAGE)
        .await
        .map_err(|e| e.into_response())?;

    let deleted = delete_help_manual_policy(&state.db, &manual_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "delete_help_manual_policy");
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": "delete failed" })),
            )
                .into_response()
        })?;

    Ok(Json(serde_json::json!({ "deleted": deleted })))
}

async fn admin_ops_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminOpsStatusOut>, Response> {
    let _staff = middleware::require_staff_with_permission(&state, &headers, HELP_MANAGE)
        .await
        .map_err(|e| e.into_response())?;

    let mut node_cmd = Command::new("node");
    node_cmd.arg("--version");
    let node_available = match node_cmd.output().await {
        Ok(out) => out.status.success(),
        Err(_) => false,
    };
    let mut uv_cmd = Command::new("uvx");
    uv_cmd.arg("--version");
    let uv_available = match uv_cmd.output().await {
        Ok(out) => out.status.success(),
        Err(_) => false,
    };

    let meilisearch_indexing = if let Some(client) = &state.meilisearch {
        crate::logic::meilisearch_client::is_indexing(client).await
    } else {
        false
    };

    let script_path = help_manifest_script_path();
    let docs_dir = repo_root()
        .join("client")
        .join("src")
        .join("assets")
        .join("docs");
    let aidocs_config = repo_root().join("docs").join("aidocs-config.yml");

    Ok(Json(AdminOpsStatusOut {
        meilisearch_configured: state.meilisearch.is_some(),
        meilisearch_indexing,
        node_available,
        uv_available,
        script_exists: script_path.exists(),
        aidocs_config_exists: aidocs_config.exists(),
        help_docs_dir_exists: docs_dir.exists(),
    }))
}

async fn admin_ops_generate_manifest(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<GenerateManifestBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let _staff = middleware::require_staff_with_permission(&state, &headers, HELP_MANAGE)
        .await
        .map_err(|e| e.into_response())?;

    if body.cleanup_orphans && !body.rescan_components {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "cleanup_orphans requires rescan_components=true"
            })),
        )
            .into_response());
    }

    let script = help_manifest_script_path();
    if !script.exists() {
        return Err((
            axum::http::StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!("manifest script not found: {}", script.display())
            })),
        )
            .into_response());
    }

    let mut cmd = Command::new("node");
    cmd.arg(script.as_os_str());

    if body.rescan_components {
        cmd.arg("--rescan-components");
    } else {
        cmd.arg("--scaffold-components");
    }

    if body.cleanup_orphans {
        cmd.arg("--delete-orphans");
    }
    if body.dry_run {
        cmd.arg("--dry-run");
    }
    if body.include_shadcn {
        cmd.arg("--include-shadcn");
    }

    cmd.current_dir(repo_root());

    let out = run_command_capture(cmd).await?;
    Ok(Json(serde_json::json!({
        "status": if out.ok { "ok" } else { "error" },
        "result": out
    })))
}

async fn admin_ops_aidocs_coverage(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AidocsCoverageBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let _staff = middleware::require_staff_with_permission(&state, &headers, HELP_MANAGE)
        .await
        .map_err(|e| e.into_response())?;

    let aidocs_config = repo_root().join("docs").join("aidocs-config.yml");
    if !aidocs_config.exists() {
        return Err((
            axum::http::StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!("AIDocs config not found: {}", aidocs_config.display())
            })),
        )
            .into_response());
    }

    let mut cmd = Command::new("uvx");
    cmd.arg("--from")
        .arg("aidocs")
        .arg("aidocs")
        .arg("coverage")
        .arg("client/src/assets/docs")
        .arg("--codebase")
        .arg("client/src")
        .arg("--format")
        .arg(if body.json { "json" } else { "summary" })
        .arg("--no-save");
    if body.include_all {
        cmd.arg("--all");
    }
    cmd.current_dir(repo_root());

    let out = run_command_capture(cmd).await?;
    Ok(Json(serde_json::json!({
        "status": if out.ok { "ok" } else { "error" },
        "result": out
    })))
}

async fn admin_ops_reindex_search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ReindexSearchBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let _staff = middleware::require_staff_with_permission(&state, &headers, HELP_MANAGE)
        .await
        .map_err(|e| e.into_response())?;

    let Some(client) = state.meilisearch.as_ref() else {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Meilisearch is not configured" })),
        )
            .into_response());
    };

    match crate::logic::help_corpus::reindex_help_meilisearch(client).await {
        Ok(()) => {
            crate::logic::meilisearch_sync::record_sync_status(
                &state.db,
                crate::logic::meilisearch_client::INDEX_HELP,
                true,
                0,
                None,
            )
            .await;
            Ok(Json(
                serde_json::json!({ "status": "ok", "mode": "help_only" }),
            ))
        }
        Err(help_err) => {
            crate::logic::meilisearch_sync::record_sync_status(
                &state.db,
                crate::logic::meilisearch_client::INDEX_HELP,
                false,
                0,
                Some(&help_err.to_string()),
            )
            .await;

            if body.full_reindex_fallback {
                crate::logic::meilisearch_sync::reindex_all_meilisearch(client, &state.db)
                    .await
                    .map_err(|e| {
                        (
                            axum::http::StatusCode::BAD_GATEWAY,
                            Json(serde_json::json!({
                                "error": format!("full fallback reindex failed: {e}")
                            })),
                        )
                            .into_response()
                    })?;
                Ok(Json(
                    serde_json::json!({ "status": "ok", "mode": "full_fallback" }),
                ))
            } else {
                Err((
                    axum::http::StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({
                        "error": format!("help reindex failed: {help_err}")
                    })),
                )
                    .into_response())
            }
        }
    }
}
