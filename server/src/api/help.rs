#![allow(clippy::items_after_test_module)]

//! In-app help: Meilisearch search (`ros_help`), bundled manuals with DB policy overrides, admin editor.

use std::collections::HashSet;
use std::path::{Path as FsPath, PathBuf};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header::CONTENT_TYPE, HeaderMap},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{Datelike, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;
use uuid::Uuid;

use crate::api::e2e_gateway;
use crate::api::insights::{self, RosieReportingRunRequest};
use crate::api::{customers, inventory, products, transactions, weddings, AppState};
use crate::auth::permissions::{
    effective_permissions_for_staff, staff_has_permission, ALL_PERMISSION_KEYS, HELP_MANAGE,
};
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
use crate::logic::rosie_knowledge::{search_rosie_knowledge, RosieKnowledgeQuery};
use crate::logic::rosie_provider_selection::{select_llm_provider, QueryType, RosieProviderConfig};
use crate::logic::rosie_read_tools::{
    self, RosieReadToolDefinition, RosieReadToolError, RosieReadToolResponse,
};
use crate::logic::rosie_speech;
use crate::middleware;
use crate::models::DbStaffRole;

#[path = "../logic/rosie_insight_summary.rs"]
mod rosie_insight_summary;
#[path = "../logic/rosie_search_intent.rs"]
mod rosie_search_intent;

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
    let body = rosie_disable_model_reasoning(body);
    let mut last_error = None;
    for attempt in 1..=3 {
        match upstream_client.post(upstream_url).json(&body).send().await {
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

async fn send_rosie_provider_chat_request(
    query_type: QueryType,
    body: &Value,
) -> Result<Value, String> {
    let provider = select_llm_provider(&RosieProviderConfig::default(), query_type).await?;
    provider
        .chat_completion_payload(rosie_disable_model_reasoning(body))
        .await
}

fn rosie_disable_model_reasoning(body: &Value) -> Value {
    let mut payload = body.clone();
    let Some(object) = payload.as_object_mut() else {
        return payload;
    };
    object.insert("reasoning".to_string(), Value::Bool(false));

    let kwargs = object
        .entry("chat_template_kwargs")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(kwargs_object) = kwargs.as_object_mut() {
        kwargs_object.insert("enable_thinking".to_string(), Value::Bool(false));
    } else {
        *kwargs = serde_json::json!({ "enable_thinking": false });
    }

    payload
}

fn rosie_provider_label_from_completion(body: &Value) -> &'static str {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if model.contains("openai")
        || model.contains("gpt-")
        || model.contains("o1")
        || model.contains("o3")
    {
        "openai"
    } else if model.contains("gemini") {
        "gemini"
    } else {
        "local"
    }
}

const RIVERSIDEOS_CREATOR_ANSWER: &str =
    "RiversideOS was designed by Christopher Garcia and released first on June of 2026.";

fn normalize_rosie_question_text(question: &str) -> String {
    question
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch.is_ascii_whitespace() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn rosie_creator_answer(question: &str) -> Option<&'static str> {
    let normalized = normalize_rosie_question_text(question);
    let names_product = normalized.contains("riversideos")
        || normalized.contains("riverside os")
        || normalized
            .split_whitespace()
            .any(|token| token == "ros" || token == "rosie");
    let asks_creator = normalized.split_whitespace().any(|token| token == "who")
        && [
            "created", "made", "designed", "built", "founded", "invented", "released",
        ]
        .iter()
        .any(|term| normalized.split_whitespace().any(|token| token == *term));
    let asks_origin = [
        "creator", "designer", "founder", "author", "origin", "history",
    ]
    .iter()
    .any(|term| normalized.split_whitespace().any(|token| token == *term));
    if names_product && (asks_creator || asks_origin) {
        Some(RIVERSIDEOS_CREATOR_ANSWER)
    } else {
        None
    }
}

fn rosie_last_user_message(body: &Value) -> Option<String> {
    body.get("messages")
        .and_then(Value::as_array)?
        .iter()
        .rev()
        .find(|message| {
            message
                .get("role")
                .and_then(Value::as_str)
                .is_some_and(|role| role.eq_ignore_ascii_case("user"))
        })
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn rosie_static_chat_completion(answer: &str) -> Value {
    serde_json::json!({
        "id": "rosie-static-riversideos-creator",
        "object": "chat.completion",
        "model": "riverside-rosie-static",
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {
                "role": "assistant",
                "content": answer
            }
        }]
    })
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

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct CaptureHelpScreenshotsBody {
    base_url: Option<String>,
    api_base: Option<String>,
    target: Option<String>,
}

#[derive(Debug, Serialize)]
struct AdminOpsStatusOut {
    meilisearch_configured: bool,
    meilisearch_indexing: bool,
    node_available: bool,
    uv_available: bool,
    script_exists: bool,
    screenshot_script_exists: bool,
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
    #[serde(default)]
    client_context: Option<RosieClientContextIn>,
}

fn default_rosie_tool_context_mode() -> String {
    "help".to_string()
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct RosieClientContextIn {
    current_surface: Option<String>,
    active_manual_id: Option<String>,
    active_manual_title: Option<String>,
    active_customer_id: Option<Uuid>,
    active_transaction_id: Option<Uuid>,
    active_inventory_variant_id: Option<Uuid>,
    last_user_question: Option<String>,
    last_assistant_summary: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RosieProductCatalogAnalyzeRequest {
    product_id: Uuid,
}

#[derive(Debug, Clone, Deserialize)]
struct RosieProductCatalogSuggestRequest {
    product_id: Uuid,
}

#[derive(Debug, Clone, Deserialize)]
struct RosieReadToolExecuteRequest {
    tool_name: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Debug, Clone, Serialize)]
struct RosieReadToolExecuteResponse {
    tool_name: String,
    basis: String,
    filters_applied: Value,
    row_count: usize,
    limited: bool,
    warnings: Vec<String>,
    data_freshness: String,
    generated_at: chrono::DateTime<Utc>,
    data: Value,
}

impl From<RosieReadToolResponse> for RosieReadToolExecuteResponse {
    fn from(value: RosieReadToolResponse) -> Self {
        Self {
            tool_name: value.tool_name,
            basis: value.basis,
            filters_applied: value.filters_applied,
            row_count: value.row_count,
            limited: value.limited,
            warnings: value.warnings,
            data_freshness: value.data_freshness,
            generated_at: value.generated_at,
            data: value.data,
        }
    }
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
struct RosieSuggestedActionOut {
    id: String,
    label: String,
    description: String,
    target: String,
}

#[derive(Debug, Clone, Serialize)]
struct RosieToolContextResponse {
    question: String,
    settings: RosieToolContextSettings,
    sources: Vec<RosieToolGroundingSourceOut>,
    tool_results: Vec<RosieToolResultOut>,
    suggested_actions: Vec<RosieSuggestedActionOut>,
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use crate::api::store_account_rate::StoreAccountRateState;
    use crate::auth::permissions::{
        CUSTOMERS_HUB_VIEW, INVENTORY_VIEW_COST, ORDERS_VIEW, WEDDINGS_VIEW,
    };
    use crate::auth::pins::hash_pin;
    use crate::logic::podium::PodiumTokenCache;
    use crate::logic::wedding_push::WeddingEventBus;
    use crate::observability::ServerLogRing;

    async fn connect_test_db() -> PgPool {
        let _ =
            dotenvy::from_filename(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env"));
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
            http_client: reqwest::Client::new(),
            podium_token_cache: Arc::new(tokio::sync::Mutex::new(PodiumTokenCache::default())),
            database_url: "postgres://test".to_string(),
            counterpoint_sync_token: None,
            wedding_events: WeddingEventBus::new(),
            store_customer_jwt_secret: Arc::<[u8]>::from(b"rosie-operational-test".as_slice()),
            store_account_rate: Arc::new(tokio::sync::Mutex::new(StoreAccountRateState::default())),
            store_account_unauth_post_per_minute_ip: 0,
            store_account_authed_per_minute: 0,
            meilisearch: None,
            rosie_speech_state: Arc::new(tokio::sync::Mutex::new(None)),
            server_log_ring: ServerLogRing::new(32, 512),
            cache: None,
            metrics_collector: None,
            rate_limit: crate::middleware::rate_limit::rate_limit_middleware(),
            github_token: None,
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
        let sku = format!("MTX-{}-42R", &variant_id.simple().to_string()[..8]);
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
            VALUES ($1, $2, $3, '{"size":"42R"}'::jsonb, '42R', 6, 2)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(sku)
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
        let sku_token = product_id.simple().to_string()[..8].to_ascii_uppercase();
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
            .bind(format!(
                "AMB-{sku_token}-{}-{}",
                color.to_ascii_uppercase(),
                size
            ))
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
            client_context: None,
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
    async fn rosie_capabilities_allows_authenticated_staff_without_help_manage() {
        let pool = connect_test_db().await;
        let (_staff_id, code) = insert_staff_with_permissions(&pool, "salesperson", &[]).await;
        let state = build_test_state(pool);

        let Json(response) = rosie_capabilities(State(state), auth_headers(&code))
            .await
            .expect("authenticated staff can read ROSIE capabilities");

        assert!(!response.available_tools.is_empty());
        assert!(response
            .available_tools
            .iter()
            .any(|tool| tool.requires_permission.is_some()));
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

    #[test]
    fn rosie_upstream_payload_disables_gemma_reasoning() {
        let payload = rosie_disable_model_reasoning(&serde_json::json!({
            "model": "local",
            "messages": [{ "role": "user", "content": "Help me close the register." }],
            "chat_template_kwargs": { "existing": true }
        }));

        assert_eq!(payload["reasoning"], Value::Bool(false));
        assert_eq!(
            payload["chat_template_kwargs"]["enable_thinking"],
            Value::Bool(false)
        );
        assert_eq!(
            payload["chat_template_kwargs"]["existing"],
            Value::Bool(true)
        );
    }

    #[test]
    fn rosie_creator_answer_matches_riversideos_origin_questions() {
        assert_eq!(
            rosie_creator_answer("Who created RiversideOS?"),
            Some(RIVERSIDEOS_CREATOR_ANSWER)
        );
        assert_eq!(
            rosie_creator_answer("who designed ROS"),
            Some(RIVERSIDEOS_CREATOR_ANSWER)
        );
        assert_eq!(rosie_creator_answer("How do I close the register?"), None);
    }

    #[test]
    fn rosie_read_tool_inference_handles_product_sales_by_month() {
        let range = parse_dates_from_question("How many navy suits sold in June 2025?")
            .expect("month range should parse");
        assert_eq!(range.0, NaiveDate::from_ymd_opt(2025, 6, 1).unwrap());
        assert_eq!(range.1, NaiveDate::from_ymd_opt(2025, 6, 30).unwrap());

        let requests = infer_read_tool_requests("How many navy suits sold in June 2025?", None);
        let (_, args) = requests
            .iter()
            .find(|(tool_name, _)| tool_name == "get_product_sales_by_query")
            .expect("product sales tool should be inferred");
        assert_eq!(args["query"], Value::String("navy suits".to_string()));
    }

    #[test]
    fn rosie_read_tool_inference_handles_plain_sold_last_month() {
        let requests = infer_read_tool_requests("How many Gruppo suits sold last month?", None);
        let (_, args) = requests
            .iter()
            .find(|(tool_name, _)| tool_name == "get_product_sales_by_query")
            .expect("product sales tool should be inferred");
        assert_eq!(args["query"], Value::String("gruppo suits".to_string()));
    }

    #[test]
    fn rosie_read_tool_inference_handles_inventory_lookup() {
        let requests = infer_read_tool_requests("Do we have navy suits in inventory?", None);
        let (_, args) = requests
            .iter()
            .find(|(tool_name, _)| tool_name == "get_inventory_availability")
            .expect("inventory availability tool should be inferred");
        assert_eq!(args["query"], Value::String("navy suits".to_string()));
    }

    #[test]
    fn rosie_read_tool_inference_handles_wedding_risk_and_stale_pickups() {
        let wedding_requests =
            infer_read_tool_requests("Which weddings need attention this week?", None);
        assert!(wedding_requests
            .iter()
            .any(|(tool_name, _)| tool_name == "get_upcoming_wedding_risk_report"));

        let pickup_requests = infer_read_tool_requests("Which customers have stale pickups?", None);
        assert!(pickup_requests
            .iter()
            .any(|(tool_name, _)| tool_name == "get_customers_with_stale_pickups"));
    }

    #[test]
    fn rosie_read_tool_inference_handles_manager_attention_and_blocks_mutations() {
        let requests = infer_read_tool_requests("What needs manager attention today?", None);
        assert!(requests
            .iter()
            .any(|(tool_name, _)| tool_name == "get_manager_attention_queue"));

        let blocked = infer_read_tool_requests("Fix QBO errors and reconcile the drawer.", None);
        assert!(blocked.is_empty());
    }

    #[test]
    fn rosie_workflow_playbooks_emit_operational_actions() {
        let playbooks = workflow_playbooks("Register close blocked by offline recovery.");
        assert!(playbooks.iter().any(|playbook| {
            playbook.get("id").and_then(Value::as_str) == Some("register_close_blockers")
        }));

        let actions = playbooks
            .iter()
            .flat_map(suggested_actions_from_playbook)
            .collect::<Vec<_>>();
        assert!(actions
            .iter()
            .any(|action| action.id == "review_offline_recovery"));
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

async fn rosie_knowledge_context_sections(
    state: &AppState,
    viewer: &HelpViewer,
    question: &str,
    client_context: Option<&RosieClientContextIn>,
    limit: usize,
) -> Result<crate::logic::rosie_knowledge::RosieKnowledgeSearchResult, Response> {
    let manuals = build_visible_manual_list(&state.db, viewer.pos_only_mode, &viewer.staff_perms)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "build visible manual list for ROSIE");
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "help manuals load failed" })),
            )
                .into_response()
        })?;
    let allowed_manual_ids = manuals
        .into_iter()
        .map(|manual| manual.id)
        .collect::<HashSet<_>>();

    search_rosie_knowledge(
        &state.db,
        RosieKnowledgeQuery {
            question: question.to_string(),
            allowed_manual_ids: Some(allowed_manual_ids),
            active_manual_id: client_context.and_then(|context| context.active_manual_id.clone()),
            current_surface: client_context.and_then(|context| context.current_surface.clone()),
            limit,
            max_total_chars: if limit > 7 { 9_000 } else { 6_000 },
        },
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "search ROSIE local knowledge index");
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "ROSIE knowledge retrieval failed" })),
        )
            .into_response()
    })
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
    if let Some(month_range) = parse_named_month_from_question(question) {
        return Some(month_range);
    }

    None
}

fn default_reporting_window() -> (NaiveDate, NaiveDate) {
    let today = Utc::now().date_naive();
    (today - Duration::days(29), today)
}

fn month_number_from_token(token: &str) -> Option<u32> {
    match token {
        "jan" | "january" => Some(1),
        "feb" | "february" => Some(2),
        "mar" | "march" => Some(3),
        "apr" | "april" => Some(4),
        "may" => Some(5),
        "jun" | "june" => Some(6),
        "jul" | "july" => Some(7),
        "aug" | "august" => Some(8),
        "sep" | "sept" | "september" => Some(9),
        "oct" | "october" => Some(10),
        "nov" | "november" => Some(11),
        "dec" | "december" => Some(12),
        _ => None,
    }
}

fn parse_named_month_from_question(question: &str) -> Option<(NaiveDate, NaiveDate)> {
    let today = Utc::now().date_naive();
    let tokens = question_tokens(question).collect::<Vec<_>>();
    let (index, month) = tokens
        .iter()
        .enumerate()
        .find_map(|(index, token)| month_number_from_token(token).map(|month| (index, month)))?;
    let year = tokens
        .get(index + 1)
        .and_then(|token| {
            if token.len() == 4 {
                token.parse::<i32>().ok()
            } else {
                None
            }
        })
        .unwrap_or_else(|| today.year());
    let start = NaiveDate::from_ymd_opt(year, month, 1)?;
    let next_month = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)?
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)?
    };
    let month_end = next_month - Duration::days(1);
    let end = if year == today.year() && month == today.month() {
        month_end.min(today)
    } else {
        month_end
    };
    Some((start, end))
}

fn clean_rosie_item_query(candidate: &str) -> Option<String> {
    let cleaned = candidate
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch.is_ascii_whitespace() || ch == '-' {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>();
    let noise = [
        "how",
        "many",
        "of",
        "did",
        "do",
        "we",
        "sell",
        "sold",
        "sales",
        "unit",
        "units",
        "have",
        "has",
        "in",
        "during",
        "for",
        "stock",
        "inventory",
        "available",
        "availability",
        "on",
        "hand",
        "left",
        "any",
        "the",
        "a",
        "an",
        "this",
        "last",
        "today",
        "yesterday",
        "month",
        "week",
        "period",
        "time",
    ];
    let value = cleaned
        .split_whitespace()
        .filter(|token| !noise.contains(token))
        .filter(|token| month_number_from_token(token).is_none())
        .filter(|token| {
            token
                .parse::<i32>()
                .map_or(true, |year| !(2000..=2100).contains(&year))
        })
        .collect::<Vec<_>>()
        .join(" ");
    if value.len() >= 2 {
        Some(value)
    } else {
        None
    }
}

fn rosie_product_query_from_question(question: &str) -> Option<String> {
    let lower = question.to_ascii_lowercase();
    for marker in ["sales of ", "units of ", "how many of "] {
        if let Some((_, tail)) = lower.split_once(marker) {
            return clean_rosie_item_query(tail);
        }
    }
    if let Some((head, _)) = lower.split_once(" sold") {
        return clean_rosie_item_query(head);
    }
    if let Some((_, tail)) = lower.split_once("sell ") {
        return clean_rosie_item_query(tail);
    }
    None
}

fn rosie_inventory_query_from_question(question: &str) -> Option<String> {
    let lower = question.to_ascii_lowercase();
    for marker in [
        "do we have ",
        "stock for ",
        "inventory for ",
        "available in ",
    ] {
        if let Some((_, tail)) = lower.split_once(marker) {
            return clean_rosie_item_query(tail);
        }
    }
    if let Some((head, _)) = lower.split_once(" in stock") {
        return clean_rosie_item_query(head);
    }
    if let Some((head, _)) = lower.split_once(" in inventory") {
        return clean_rosie_item_query(head);
    }
    None
}

fn rosie_question_asks_mutation(question: &str) -> bool {
    let lower = question.to_ascii_lowercase();
    [
        "fix ",
        "adjust ",
        "reconcile ",
        "post ",
        "receive ",
        "refund ",
        "discount ",
        "fulfill ",
        "delete ",
        "merge ",
        "change ",
        "update ",
        "void ",
        "import ",
    ]
    .iter()
    .any(|term| lower.starts_with(term) || lower.contains(&format!(" {term}")))
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

fn infer_read_tool_requests(
    question: &str,
    client_context: Option<&RosieClientContextIn>,
) -> Vec<(String, Value)> {
    let lower = question.to_ascii_lowercase();
    let mut requests = Vec::new();

    if rosie_question_asks_mutation(question) {
        return requests;
    }

    if lower.contains("manager brief")
        || lower.contains("daily brief")
        || lower.contains("what should i pay attention")
        || lower.contains("top risks today")
    {
        requests.push(("get_daily_manager_brief".to_string(), serde_json::json!({})));
    }

    if lower.contains("manager attention")
        || lower.contains("needs manager attention")
        || lower.contains("what needs attention")
        || lower.contains("top 10 risks")
        || lower.contains("before opening")
        || lower.contains("before closing")
    {
        requests.push((
            "get_manager_attention_queue".to_string(),
            serde_json::json!({}),
        ));
    }

    if lower.contains("data quality")
        || lower.contains("cleanup issues")
        || lower.contains("bad data")
        || lower.contains("missing barcode")
        || lower.contains("unmatched vendor")
    {
        if lower.contains("cleanup") || lower.contains("needs work") || lower.contains("tasks") {
            requests.push(("get_data_cleanup_tasks".to_string(), serde_json::json!({})));
        }
        requests.push((
            "get_data_quality_summary".to_string(),
            serde_json::json!({}),
        ));
    }

    if (lower.contains("how many") || lower.contains("units") || lower.contains("sold"))
        && (lower.contains(" sold") || lower.contains("sell ") || lower.contains("sales of"))
    {
        if let Some(query) = rosie_product_query_from_question(question) {
            let (from, to) =
                parse_dates_from_question(question).unwrap_or_else(default_reporting_window);
            requests.push((
                "get_product_sales_by_query".to_string(),
                serde_json::json!({ "query": query, "from": from, "to": to, "limit": 25 }),
            ));
        }
    }

    if (lower.contains("do we have")
        || lower.contains("in inventory")
        || lower.contains("in stock")
        || lower.contains("stock for")
        || lower.contains("available"))
        && !lower.contains("appointment")
        && !lower.contains("wedding")
    {
        if let Some(query) = rosie_inventory_query_from_question(question) {
            requests.push((
                "get_inventory_availability".to_string(),
                serde_json::json!({ "query": query, "limit": 25 }),
            ));
        }
    }

    if lower.contains("open balance")
        || lower.contains("balance due")
        || lower.contains("customers owe")
    {
        requests.push((
            "get_customers_with_open_balances".to_string(),
            serde_json::json!({ "limit": 25 }),
        ));
    }

    if lower.contains("follow-up")
        || lower.contains("follow up")
        || lower.contains("need a call")
        || lower.contains("needs a call")
        || lower.contains("customers need attention")
    {
        requests.push((
            "get_customers_needing_follow_up".to_string(),
            serde_json::json!({ "limit": 25 }),
        ));
    }

    if lower.contains("stale pickup")
        || lower.contains("items ready but not picked up")
        || lower.contains("ready but not picked up")
    {
        requests.push((
            "get_customers_with_stale_pickups".to_string(),
            serde_json::json!({ "limit": 25 }),
        ));
    }

    if lower.contains("missing phone")
        || lower.contains("missing email")
        || lower.contains("missing contact")
    {
        requests.push((
            "get_customers_with_missing_contact_info".to_string(),
            serde_json::json!({ "limit": 25 }),
        ));
    }

    if (lower.contains("ready for pickup") || lower.contains("ready to pick up"))
        && (lower.contains("open order") || lower.contains("orders") || lower.contains("items"))
    {
        requests.push((
            "get_open_orders_ready_for_pickup".to_string(),
            serde_json::json!({ "limit": 25 }),
        ));
    }

    if (lower.contains("purchase history")
        || lower.contains("buy last")
        || lower.contains("bought last")
        || lower.contains("last bought")
        || lower.contains("last purchase"))
        && client_context
            .and_then(|context| context.active_customer_id)
            .is_some()
    {
        let customer_id = client_context
            .and_then(|context| context.active_customer_id)
            .expect("checked above");
        requests.push((
            "get_customer_purchase_history_summary".to_string(),
            serde_json::json!({ "customer_id": customer_id }),
        ));
    }

    if (lower.contains("size profile")
        || lower.contains("measurements")
        || lower.contains("what size")
        || lower.contains("usually wear"))
        && client_context
            .and_then(|context| context.active_customer_id)
            .is_some()
    {
        let customer_id = client_context
            .and_then(|context| context.active_customer_id)
            .expect("checked above");
        requests.push((
            "get_customer_size_profile_summary".to_string(),
            serde_json::json!({ "customer_id": customer_id }),
        ));
    }

    if lower.contains("appointment") || lower.contains("appointments") {
        let (from, to) = parse_dates_from_question(question).unwrap_or_else(|| {
            let today = Utc::now().date_naive();
            if lower.contains("tomorrow") {
                let tomorrow = today + Duration::days(1);
                (tomorrow, tomorrow)
            } else if lower.contains("week") {
                (today, today + Duration::days(7))
            } else {
                (today, today)
            }
        });
        requests.push((
            "get_appointments_by_date".to_string(),
            serde_json::json!({ "from": from, "to": to, "limit": 25 }),
        ));
    }

    if (lower.contains("wedding") || lower.contains("weddings")) && !lower.contains("action") {
        let (from, to) = parse_dates_from_question(question).unwrap_or_else(|| {
            let today = Utc::now().date_naive();
            if lower.contains("week") {
                (today, today + Duration::days(7))
            } else if lower.contains("14 day") || lower.contains("two week") {
                (today, today + Duration::days(14))
            } else {
                (today, today + Duration::days(30))
            }
        });
        if lower.contains("missing measurement") || lower.contains("need measurement") {
            requests.push((
                "get_wedding_members_missing_measurements".to_string(),
                serde_json::json!({ "from": from, "to": to, "limit": 25 }),
            ));
        } else if lower.contains("missing fitting")
            || lower.contains("need fitting")
            || lower.contains("needs a fitting")
        {
            requests.push((
                "get_wedding_members_missing_fittings".to_string(),
                serde_json::json!({ "from": from, "to": to, "limit": 25 }),
            ));
        } else if lower.contains("open balance") || lower.contains("balance issue") {
            requests.push((
                "get_wedding_members_with_open_balances".to_string(),
                serde_json::json!({ "from": from, "to": to, "limit": 25 }),
            ));
        } else if lower.contains("ready for pickup") || lower.contains("ready to pick up") {
            requests.push((
                "get_wedding_orders_ready_for_pickup".to_string(),
                serde_json::json!({ "from": from, "to": to, "limit": 25 }),
            ));
        } else if lower.contains("missing item") || lower.contains("unfulfilled") {
            requests.push((
                "get_wedding_unfulfilled_items".to_string(),
                serde_json::json!({ "from": from, "to": to, "limit": 25 }),
            ));
        } else if lower.contains("follow-up")
            || lower.contains("follow up")
            || lower.contains("need a call")
        {
            requests.push((
                "get_wedding_follow_up_list".to_string(),
                serde_json::json!({ "from": from, "to": to, "limit": 25 }),
            ));
        } else if lower.contains("ready")
            || lower.contains("readiness")
            || lower.contains("need attention")
            || lower.contains("not ready")
        {
            requests.push((
                "get_upcoming_wedding_risk_report".to_string(),
                serde_json::json!({ "from": from, "to": to, "limit": 25 }),
            ));
            requests.push((
                "get_weddings_by_event_date_range".to_string(),
                serde_json::json!({ "from": from, "to": to, "limit": 25 }),
            ));
        }
    }

    if lower.contains("alteration") || lower.contains("alterations") {
        let (from, to) = parse_dates_from_question(question).unwrap_or_else(|| {
            let today = Utc::now().date_naive();
            if lower.contains("overdue") {
                (today - Duration::days(30), today)
            } else if lower.contains("today") {
                (today, today)
            } else {
                (today, today + Duration::days(7))
            }
        });
        requests.push((
            "get_alterations_due".to_string(),
            serde_json::json!({ "from": from, "to": to, "limit": 25 }),
        ));
    }

    if lower.contains("purchase order")
        || lower.contains("open po")
        || lower.contains("what pos are open")
        || lower.contains("pos are open")
        || lower.contains("on order")
    {
        if lower.contains("on order") || lower.contains("what is on order") {
            requests.push((
                "get_items_on_order".to_string(),
                serde_json::json!({ "limit": 25 }),
            ));
        } else {
            requests.push((
                "get_open_purchase_orders".to_string(),
                serde_json::json!({ "limit": 25 }),
            ));
        }
    }

    if lower.contains("received this week")
        || lower.contains("recent receipt")
        || lower.contains("recent receiving")
        || lower.contains("what did we receive")
    {
        let (from, to) = parse_dates_from_question(question).unwrap_or_else(|| {
            let today = Utc::now().date_naive();
            (today - Duration::days(7), today)
        });
        requests.push((
            "get_recent_receipts".to_string(),
            serde_json::json!({ "from": from, "to": to, "limit": 25 }),
        ));
    }

    if lower.contains("reorder")
        || lower.contains("should we order")
        || lower.contains("what should we order")
    {
        requests.push((
            "get_inventory_reorder_candidates".to_string(),
            serde_json::json!({ "limit": 25 }),
        ));
    }

    if lower.contains("vendor item")
        && (lower.contains("unmatched") || lower.contains("missing mapping"))
    {
        requests.push((
            "get_unmatched_vendor_items".to_string(),
            serde_json::json!({ "limit": 25 }),
        ));
    }

    if lower.contains("invoice")
        && (lower.contains("review") || lower.contains("exception") || lower.contains("missing"))
    {
        requests.push((
            "get_po_invoice_exception_report".to_string(),
            serde_json::json!({ "limit": 25 }),
        ));
    }

    if lower.contains("loyalty") || lower.contains("points") || lower.contains("loyalty balance") {
        if let Some(customer_id) = client_context.and_then(|context| context.active_customer_id) {
            requests.push((
                "get_customer_loyalty_balance".to_string(),
                serde_json::json!({ "customer_id": customer_id }),
            ));
        }
    }

    if lower.contains("store credit") {
        let mut args = serde_json::json!({ "limit": 25 });
        if let Some(customer_id) = client_context.and_then(|context| context.active_customer_id) {
            requests.push((
                "get_customer_credit_summary".to_string(),
                serde_json::json!({ "customer_id": customer_id }),
            ));
        } else {
            args["customer_id"] = serde_json::Value::Null;
            requests.push(("get_store_credit_summary".to_string(), args));
        }
    }

    if lower.contains("gift card") && (lower.contains("summary") || lower.contains("balance")) {
        requests.push(("get_gift_card_summary".to_string(), serde_json::json!({})));
    }

    if lower.contains("gift card") && (lower.contains("exception") || lower.contains("review")) {
        requests.push((
            "get_gift_card_exception_report".to_string(),
            serde_json::json!({ "limit": 25 }),
        ));
    }

    if lower.contains("credit liability")
        || lower.contains("gift card liability")
        || lower.contains("outstanding credit")
    {
        requests.push((
            "get_outstanding_credit_liability_summary".to_string(),
            serde_json::json!({}),
        ));
    }

    if lower.contains("qbo")
        && (lower.contains("exception")
            || lower.contains("error")
            || lower.contains("pending")
            || lower.contains("review"))
    {
        requests.push((
            "get_qbo_exception_summary".to_string(),
            serde_json::json!({ "limit": 25 }),
        ));
    }

    if lower.contains("qbo") && (lower.contains("sync") || lower.contains("status")) {
        let (from, to) =
            parse_dates_from_question(question).unwrap_or_else(default_reporting_window);
        requests.push((
            "get_qbo_sync_summary".to_string(),
            serde_json::json!({ "from": from, "to": to }),
        ));
    }

    if lower.contains("register close")
        || lower.contains("drawer")
        || lower.contains("cash variance")
        || lower.contains("tender reconciliation")
    {
        let (from, to) = parse_dates_from_question(question).unwrap_or_else(|| {
            let today = Utc::now().date_naive();
            (today - Duration::days(7), today)
        });
        requests.push((
            "get_register_exception_summary".to_string(),
            serde_json::json!({ "from": from, "to": to, "limit": 25 }),
        ));
    }

    requests
}

fn action(id: &str, label: &str, description: &str, target: &str) -> RosieSuggestedActionOut {
    RosieSuggestedActionOut {
        id: id.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        target: target.to_string(),
    }
}

fn workflow_playbooks(question: &str) -> Vec<Value> {
    let lower = question.to_ascii_lowercase();
    let mut playbooks = Vec::new();

    if lower.contains("close blocker")
        || lower.contains("close blocked")
        || lower.contains("register close blocked")
        || lower.contains("z close")
        || lower.contains("z-close")
    {
        playbooks.push(serde_json::json!({
            "id": "register_close_blockers",
            "title": "Register close blocker recovery",
            "voice_prompt": "What is blocking register close?",
            "steps": [
                "Confirm whether offline checkout recovery is pending or blocked before counting the drawer.",
                "Review the close warning and keep the register open until the blocking queue is cleared or assigned.",
                "If the blocker is payment uncertainty, preserve the transaction state and escalate for Manager Access.",
                "After recovery is clear, rerun the register close review and compare expected cash before submitting."
            ],
            "do_not": [
                "Do not force-close the register while checkout recovery is unresolved.",
                "Do not clear a blocker just to remove it from the close screen."
            ],
            "actions": [
                { "id": "open_register_close", "label": "Open Register Close", "target": "pos:register-close" },
                { "id": "review_offline_recovery", "label": "Review Offline Recovery", "target": "help:offline-recovery" }
            ]
        }));
    }

    if lower.contains("refund")
        || lower.contains("return failed")
        || lower.contains("refund failed")
        || lower.contains("exchange failed")
    {
        playbooks.push(serde_json::json!({
            "id": "refund_recovery",
            "title": "Refund and return recovery",
            "voice_prompt": "Help me recover a refund.",
            "steps": [
                "Start from the original Transaction Record and confirm the payment, line, and return-window state.",
                "If the transaction is older than the standard window, require Manager Access before continuing.",
                "For payment failures, preserve the visible error and do not retry until the tender state is clear.",
                "Use the guided return or exchange flow so inventory, payment allocation, and audit notes stay aligned."
            ],
            "do_not": [
                "Do not issue an off-system refund to make the screen match.",
                "Do not bypass Manager Access for out-of-window returns."
            ],
            "actions": [
                { "id": "open_transactions", "label": "Open Transactions", "target": "orders:transactions" },
                { "id": "open_returns_help", "label": "Open Returns Help", "target": "help:returns" }
            ]
        }));
    }

    if lower.contains("inventory mismatch")
        || lower.contains("stock mismatch")
        || lower.contains("wrong stock")
        || lower.contains("inventory count")
    {
        playbooks.push(serde_json::json!({
            "id": "inventory_mismatch",
            "title": "Inventory mismatch triage",
            "voice_prompt": "Help me check an inventory mismatch.",
            "steps": [
                "Identify the exact SKU or variant before changing quantities.",
                "Compare on-hand, reserved, layaway, and available stock instead of relying on one number.",
                "Check recent receiving, pickup, layaway, and physical count activity for the variant.",
                "Use traceable receiving or physical inventory adjustments only after the source of mismatch is clear."
            ],
            "do_not": [
                "Do not edit stock as a shortcut without a traceable movement.",
                "Do not ignore reserved or layaway stock when explaining available inventory."
            ],
            "actions": [
                { "id": "open_inventory_control", "label": "Open Inventory Control", "target": "inventory:control-board" },
                { "id": "start_inventory_lookup", "label": "Lookup SKU", "target": "voice:inventory-lookup" }
            ]
        }));
    }

    if lower.contains("qbo")
        || lower.contains("quickbooks")
        || lower.contains("journal exception")
        || lower.contains("journal failed")
    {
        playbooks.push(serde_json::json!({
            "id": "qbo_exception",
            "title": "QBO exception interpretation",
            "voice_prompt": "Explain this QBO exception.",
            "steps": [
                "Open the proposal or sync run and read the exact exception before retrying.",
                "Confirm the proposal balances to Riverside reporting totals for the same business date.",
                "Check mapping, account, tax, tender, and rounding warnings before approving a retry.",
                "Escalate to accounting when the exception affects balanced totals or revenue classification."
            ],
            "do_not": [
                "Do not sync an unbalanced proposal.",
                "Do not treat a QBO failure as a Riverside ledger change unless the returned evidence says so."
            ],
            "actions": [
                { "id": "open_qbo", "label": "Open QBO Workspace", "target": "settings:qbo" },
                { "id": "review_qbo_help", "label": "Review QBO Help", "target": "help:qbo" }
            ]
        }));
    }

    if lower.contains("receiving")
        || lower.contains("receive stock")
        || lower.contains("hands busy")
    {
        playbooks.push(serde_json::json!({
            "id": "voice_receiving",
            "title": "Voice receiving assistance",
            "voice_prompt": "ROSIE, help me receive stock.",
            "steps": [
                "Use voice to identify the PO, vendor, SKU, or interrupted receiving step.",
                "Confirm whether stock already posted before re-entering quantities.",
                "Read back the SKU and quantity before any staff member submits the receiving action.",
                "Keep all mutations in the normal Receive Stock UI; ROSIE only guides and explains."
            ],
            "do_not": [
                "Do not let voice create stock movements by itself.",
                "Do not re-enter interrupted quantities until posted state is verified."
            ],
            "actions": [
                { "id": "open_receive_stock", "label": "Open Receive Stock", "target": "inventory:receive-stock" },
                { "id": "voice_lookup_sku", "label": "Voice SKU Lookup", "target": "voice:inventory-lookup" }
            ]
        }));
    }

    if lower.contains("appointment")
        || lower.contains("schedule appointment")
        || lower.contains("fitting")
        || lower.contains("calendar")
    {
        playbooks.push(serde_json::json!({
            "id": "voice_appointment",
            "title": "Voice appointment scheduling guidance",
            "voice_prompt": "ROSIE, help schedule an appointment.",
            "steps": [
                "Capture customer name, appointment type, date preference, and staff or room constraints.",
                "Check the scheduler availability before promising a time.",
                "Use the normal scheduler form for the final booking so reminders and audit context are saved.",
                "Read back the selected time and customer before staff confirms."
            ],
            "do_not": [
                "Do not book from voice alone.",
                "Do not invent availability when the scheduler has not returned it."
            ],
            "actions": [
                { "id": "open_scheduler", "label": "Open Scheduler", "target": "scheduler:appointments" },
                { "id": "capture_appointment_details", "label": "Capture Details", "target": "voice:appointment-details" }
            ]
        }));
    }

    if lower.contains("alteration")
        || lower.contains("alterations")
        || lower.contains("tailor")
        || lower.contains("pickup fit")
    {
        playbooks.push(serde_json::json!({
            "id": "alteration_triage",
            "title": "Alteration intake and follow-up triage",
            "voice_prompt": "ROSIE, help me triage this alteration.",
            "steps": [
                "Start from the customer, garment, due date, and promised pickup date before discussing work.",
                "Confirm whether the item is a new alteration, rework, wedding-party fitting, or pickup concern.",
                "Use the Alterations UI for measurements, pins, notes, assignments, and status changes.",
                "Read back due dates, staff assignment, and customer communication before saving."
            ],
            "do_not": [
                "Do not let ROSIE change measurements, charges, or pickup status without staff confirmation.",
                "Do not promise a date until scheduler capacity and existing alteration work are checked."
            ],
            "actions": [
                { "id": "open_alterations", "label": "Open Alterations", "target": "alterations:workspace" },
                { "id": "capture_alteration_details", "label": "Capture Details", "target": "voice:alteration-details" }
            ]
        }));
    }

    if lower.contains("staff schedule")
        || lower.contains("coverage")
        || lower.contains("shift")
        || lower.contains("capacity")
    {
        playbooks.push(serde_json::json!({
            "id": "staff_schedule_capacity",
            "title": "Staff schedule and capacity review",
            "voice_prompt": "ROSIE, help review staff coverage.",
            "steps": [
                "Check published schedule coverage before using draft or requested shifts.",
                "Compare appointments, alteration due work, events, and register coverage for the same day.",
                "Flag capacity risks as review items instead of changing schedules automatically.",
                "Use the normal staff scheduling workflow for final publish or correction."
            ],
            "do_not": [
                "Do not treat draft schedules as live coverage.",
                "Do not reassign appointments or tasks without staff confirmation."
            ],
            "actions": [
                { "id": "open_staff_schedule", "label": "Open Staff Schedule", "target": "staff:schedule" },
                { "id": "review_capacity", "label": "Review Capacity", "target": "voice:capacity-review" }
            ]
        }));
    }

    if lower.contains("task")
        || lower.contains("to do")
        || lower.contains("todo")
        || lower.contains("follow up")
    {
        playbooks.push(serde_json::json!({
            "id": "task_priority_triage",
            "title": "Task priority triage",
            "voice_prompt": "ROSIE, help prioritize tasks.",
            "steps": [
                "Separate customer-impacting work from internal cleanup before prioritizing.",
                "Check due date, linked customer, linked order, appointment, alteration, and assigned staff.",
                "Escalate blocked work with a clear reason instead of creating duplicate reminders.",
                "Use the task drawer for final assignment, due date, and completion state."
            ],
            "do_not": [
                "Do not duplicate tasks that already exist for the same customer or order.",
                "Do not mark work complete from ROSIE guidance alone."
            ],
            "actions": [
                { "id": "open_tasks", "label": "Open Tasks", "target": "tasks:workspace" },
                { "id": "review_blocked_tasks", "label": "Review Blocked", "target": "voice:task-blockers" }
            ]
        }));
    }

    playbooks
}

fn suggested_actions_from_playbook(playbook: &Value) -> Vec<RosieSuggestedActionOut> {
    playbook
        .get("actions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|action_value| {
            Some(action(
                action_value.get("id")?.as_str()?,
                action_value.get("label")?.as_str()?,
                playbook
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Workflow action"),
                action_value.get("target")?.as_str()?,
            ))
        })
        .collect()
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

fn help_screenshot_script_path() -> PathBuf {
    repo_root()
        .join("client")
        .join("scripts")
        .join("capture-help-screenshots.mjs")
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
        if generate_ok {
            crate::logic::rosie_knowledge::invalidate_rosie_knowledge_index().await;
        }

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

            match crate::logic::help_corpus::reindex_help_meilisearch_with_policies(
                client, &state.db,
            )
            .await
            {
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

async fn rosie_capabilities(
    State(_state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<crate::logic::rosie_intelligence::RosieSelfReflection>, Response> {
    // Allow any authenticated staff to query capabilities (no special permission needed)
    let _staff = middleware::require_authenticated_staff_headers(&_state, &headers)
        .await
        .map_err(|e| e.into_response())?;

    let context = headers
        .get("x-rosie-context")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    Ok(Json(
        crate::logic::rosie_intelligence::get_rosie_self_reflection(context),
    ))
}

async fn rosie_read_tools(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RosieReadToolDefinition>>, Response> {
    let (_staff, _perms) = resolve_rosie_tool_staff(&state, &headers).await?;
    Ok(Json(rosie_read_tools::list_rosie_read_tools().to_vec()))
}

async fn resolve_rosie_tool_staff(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(AuthenticatedStaff, HashSet<String>), Response> {
    let code = headers
        .get("x-riverside-staff-code")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();
    let pin = headers
        .get("x-riverside-staff-pin")
        .and_then(|v| v.to_str().ok());

    let staff = authenticate_pos_staff(&state.db, code, pin).await.map_err(|_| {
        (
            axum::http::StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Staff Access is required for ROSIE live data tools" })),
        )
            .into_response()
    })?;
    let perms = effective_permissions_for_staff(&state.db, staff.id, staff.role)
        .await
        .map_err(|error| {
            tracing::error!(%error, staff_id = %staff.id, "resolve ROSIE tool permissions");
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "permission resolution failed" })),
            )
                .into_response()
        })?;
    Ok((staff, perms))
}

fn rosie_tool_args_summary(args: &Value) -> Value {
    match args {
        Value::Object(map) => {
            let mut redacted = serde_json::Map::new();
            for (key, value) in map.iter().take(12) {
                let lower = key.to_ascii_lowercase();
                if lower.contains("phone")
                    || lower.contains("email")
                    || lower.contains("payment")
                    || lower.contains("token")
                    || lower.contains("secret")
                {
                    redacted.insert(key.clone(), Value::String("[redacted]".to_string()));
                } else if let Some(s) = value.as_str() {
                    redacted.insert(
                        key.clone(),
                        Value::String(s.chars().take(120).collect::<String>()),
                    );
                } else {
                    redacted.insert(key.clone(), value.clone());
                }
            }
            Value::Object(redacted)
        }
        _ => serde_json::json!({}),
    }
}

async fn audit_rosie_read_tool_call(
    state: &AppState,
    staff_id: Uuid,
    tool_name: &str,
    args: &Value,
    permission_result: &str,
    row_count: usize,
    success: bool,
    error_category: Option<&str>,
) -> bool {
    match sqlx::query(
        r#"
        INSERT INTO rosie_read_tool_audit (
            staff_id, tool_name, arguments_summary, permission_result,
            row_count, success, error_category
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(staff_id)
    .bind(tool_name)
    .bind(rosie_tool_args_summary(args))
    .bind(permission_result)
    .bind(row_count as i32)
    .bind(success)
    .bind(error_category)
    .execute(&state.db)
    .await
    {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, staff_id = %staff_id, %tool_name, "failed to audit ROSIE read tool call");
            false
        }
    }
}

fn rosie_read_tool_error_response(error: RosieReadToolError) -> (axum::http::StatusCode, Value) {
    match error {
        RosieReadToolError::UnknownTool => (
            axum::http::StatusCode::NOT_FOUND,
            serde_json::json!({ "error": "unknown ROSIE read-only tool" }),
        ),
        RosieReadToolError::MutationToolRejected => (
            axum::http::StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": "ROSIE tools are read-only; mutation-like tool names are rejected" }),
        ),
        RosieReadToolError::InvalidInput(message) => (
            axum::http::StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": message }),
        ),
        RosieReadToolError::Database(error) => {
            tracing::error!(%error, "ROSIE read-only tool database error");
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                serde_json::json!({ "error": "ROSIE read-only tool failed" }),
            )
        }
    }
}

fn date_arg(args: &Value, key: &str) -> Option<NaiveDate> {
    args.get(key)
        .and_then(Value::as_str)
        .and_then(|value| NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d").ok())
}

fn rosie_reporting_request_for_read_tool(
    tool_name: &str,
    args: &Value,
) -> Option<RosieReportingRunRequest> {
    let (default_from, default_to) = default_reporting_window();
    let from = date_arg(args, "from").unwrap_or(default_from);
    let to = date_arg(args, "to").unwrap_or(default_to);
    let basis = args
        .get("basis")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "booked" | "sale" | "completed" | "pickup"))
        .unwrap_or("booked");
    let limit = args
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(50)
        .clamp(1, 100);

    let (spec_id, params) = match tool_name {
        "get_best_sellers" => (
            "best_sellers",
            serde_json::json!({ "from": from, "to": to, "basis": basis, "limit": limit }),
        ),
        "get_sales_summary" => (
            "sales_pivot",
            serde_json::json!({
                "from": from,
                "to": to,
                "basis": basis,
                "group_by": args
                    .get("group_by")
                    .and_then(Value::as_str)
                    .unwrap_or("category")
            }),
        ),
        "get_stale_inventory" => (
            "dead_stock",
            serde_json::json!({
                "from": from,
                "to": to,
                "basis": basis,
                "limit": limit,
                "max_units_sold": args
                    .get("max_units_sold")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            }),
        ),
        _ => return None,
    };

    Some(RosieReportingRunRequest {
        spec_id: spec_id.to_string(),
        params,
    })
}

async fn execute_rosie_read_tool_inner(
    state: &AppState,
    headers: &HeaderMap,
    tool_name: &str,
    args: Value,
) -> Result<RosieReadToolResponse, Response> {
    if rosie_read_tools::mutation_like_tool_name(tool_name) {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "ROSIE tools are read-only; mutation-like tool names are rejected" })),
        )
            .into_response());
    }
    let def = rosie_read_tools::tool_definition(tool_name).ok_or_else(|| {
        (
            axum::http::StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "unknown ROSIE read-only tool" })),
        )
            .into_response()
    })?;
    let (staff, perms) = resolve_rosie_tool_staff(state, headers).await?;
    if !staff_has_permission(&perms, def.required_permission) {
        audit_rosie_read_tool_call(
            state,
            staff.id,
            tool_name,
            &args,
            "denied",
            0,
            false,
            Some("permission_denied"),
        )
        .await;
        return Err((
            axum::http::StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "Staff Access does not include this ROSIE read-only tool",
                "required_permission": def.required_permission,
            })),
        )
            .into_response());
    }

    let result = if let Some(reporting_request) =
        rosie_reporting_request_for_read_tool(tool_name, &args)
    {
        let report = match insights::rosie_reporting_run(state, headers, reporting_request).await {
            Ok(report) => report,
            Err(error) => {
                audit_rosie_read_tool_call(
                    state,
                    staff.id,
                    tool_name,
                    &args,
                    "allowed",
                    0,
                    false,
                    Some("reporting_error"),
                )
                .await;
                return Err(error.into_response());
            }
        };
        Ok(RosieReadToolResponse {
            tool_name: tool_name.to_string(),
            basis: def.basis.to_string(),
            filters_applied: report.params,
            row_count: 1,
            limited: false,
            warnings: vec![format!(
                "Result came from approved report {} via {}.",
                report.spec_id, report.route
            )],
            data_freshness: "approved_reporting_run".to_string(),
            generated_at: Utc::now(),
            data: serde_json::json!({
                "route": report.route,
                "required_permission": report.required_permission,
                "report": report.data
            }),
        })
    } else {
        rosie_read_tools::execute_rosie_read_tool(&state.db, tool_name, args.clone()).await
    };

    match result {
        Ok(response) => {
            let audited = audit_rosie_read_tool_call(
                state,
                staff.id,
                tool_name,
                &args,
                "allowed",
                response.row_count,
                true,
                None,
            )
            .await;
            if !audited && rosie_read_tools::tool_requires_audit_fail_closed(tool_name) {
                return Err((
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": "ROSIE could not audit this live-data read-only tool call, so the data was not returned"
                    })),
                )
                    .into_response());
            }
            Ok(response)
        }
        Err(error) => {
            let error_category = match &error {
                RosieReadToolError::UnknownTool => "unknown_tool",
                RosieReadToolError::MutationToolRejected => "mutation_tool_rejected",
                RosieReadToolError::InvalidInput(_) => "invalid_input",
                RosieReadToolError::Database(_) => "database_error",
            };
            audit_rosie_read_tool_call(
                state,
                staff.id,
                tool_name,
                &args,
                "allowed",
                0,
                false,
                Some(error_category),
            )
            .await;
            let (status, body) = rosie_read_tool_error_response(error);
            Err((status, Json(body)).into_response())
        }
    }
}

async fn rosie_execute_read_tool(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RosieReadToolExecuteRequest>,
) -> Result<Json<RosieReadToolExecuteResponse>, Response> {
    let tool_name = body.tool_name.trim();
    let result = execute_rosie_read_tool_inner(&state, &headers, tool_name, body.arguments).await?;
    Ok(Json(result.into()))
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
        if let Ok(auth) = authenticate_pos_staff(&state.db, code, pin).await {
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
        .route(
            "/rosie/v1/insight-summary",
            post(post_rosie_insight_summary),
        )
        .route("/rosie/v1/search-intent", post(post_rosie_search_intent))
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
        .route("/rosie/v1/capabilities", get(rosie_capabilities))
        .route("/rosie/v1/tools", get(rosie_read_tools))
        .route("/rosie/v1/tools/execute", post(rosie_execute_read_tool))
        .route(
            "/rosie/v1/product-catalog-analyze",
            post(rosie_product_catalog_analysis),
        )
        .route(
            "/rosie/v1/product-catalog-suggest",
            post(rosie_product_catalog_suggestion),
        )
        .route(
            "/rosie/v1/e2e/workflow/run",
            post(e2e_gateway::rosie_e2e_run_workflow),
        )
        .route(
            "/rosie/v1/e2e/manual/generate",
            post(e2e_gateway::rosie_e2e_generate_manual),
        )
        .route(
            "/rosie/v1/e2e/workflow/test",
            post(e2e_gateway::rosie_e2e_test_workflow),
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
        .route(
            "/admin/ops/capture-screenshots",
            post(admin_ops_capture_screenshots),
        )
        .route("/admin/ops/reindex-search", post(admin_ops_reindex_search))
        .route(
            "/admin/ops/meilisearch-health",
            get(admin_ops_meilisearch_health),
        )
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
    let stream_requested = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    if let Some(answer) =
        rosie_last_user_message(&body).and_then(|question| rosie_creator_answer(&question))
    {
        if !stream_requested {
            return Ok(Json(rosie_static_chat_completion(answer)).into_response());
        }
    }

    if !stream_requested {
        let payload = send_rosie_provider_chat_request(QueryType::Conversation, &body)
            .await
            .map_err(|error| {
                tracing::error!(%error, "rosie provider request failed");
                (
                    axum::http::StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({
                        "error": "ROSIE provider request failed",
                    })),
                )
                    .into_response()
            })?;

        crate::logic::rosie_intelligence::record_telemetry_from_value(
            state.db.clone(),
            rosie_provider_label_from_completion(&payload),
            &payload,
        );

        return Ok(Json(payload).into_response());
    }

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
    let stream = response.bytes_stream();
    Ok((
        status,
        [(CONTENT_TYPE, "text/event-stream; charset=utf-8")],
        Body::from_stream(stream),
    )
        .into_response())
}

async fn post_rosie_insight_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<rosie_insight_summary::RosieInsightSummaryRequest>,
) -> Result<Json<rosie_insight_summary::RosieInsightSummaryResponse>, Response> {
    let _viewer = resolve_help_viewer(&state, &headers).await?;
    if let Err(message) = rosie_insight_summary::validate_request(&body) {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": message })),
        )
            .into_response());
    }

    let payload = rosie_insight_summary::build_completion_payload(&body);
    let completion = match send_rosie_provider_chat_request(QueryType::Analysis, &payload).await {
        Ok(completion) => completion,
        Err(error) => {
            tracing::warn!(%error, "rosie insight provider request failed");
            return Ok(Json(rosie_insight_summary::unavailable_response()));
        }
    };

    crate::logic::rosie_intelligence::record_telemetry_from_value(
        state.db.clone(),
        rosie_provider_label_from_completion(&completion),
        &completion,
    );

    Ok(Json(rosie_insight_summary::parse_completion_response(
        &body,
        &completion,
    )))
}

async fn post_rosie_search_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<rosie_search_intent::RosieSearchIntentRequest>,
) -> Result<Json<rosie_search_intent::RosieSearchIntentResponse>, Response> {
    let _viewer = resolve_help_viewer(&state, &headers).await?;
    if let Err(message) = rosie_search_intent::validate_request(&body) {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": message })),
        )
            .into_response());
    }

    let payload = rosie_search_intent::build_completion_payload(&body);
    let completion = match send_rosie_provider_chat_request(QueryType::Help, &payload).await {
        Ok(completion) => completion,
        Err(error) => {
            tracing::warn!(%error, "rosie search intent provider request failed");
            return Ok(Json(rosie_search_intent::unavailable_response()));
        }
    };

    crate::logic::rosie_intelligence::record_telemetry_from_value(
        state.db.clone(),
        rosie_provider_label_from_completion(&completion),
        &completion,
    );

    Ok(Json(rosie_search_intent::parse_completion_response(
        &body,
        &completion,
    )))
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
    let mut suggested_actions = Vec::<RosieSuggestedActionOut>::new();
    let question = body.question.trim();
    let conversation_mode = body.mode.trim().eq_ignore_ascii_case("conversation");
    let source_excerpt_limit = if conversation_mode { 700 } else { 1200 };
    if question.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "question is required" })),
        )
            .into_response());
    }

    if let Some(answer) = rosie_creator_answer(question) {
        sources.push(RosieToolGroundingSourceOut {
            kind: "workflow".to_string(),
            title: "RiversideOS origin".to_string(),
            excerpt: answer.to_string(),
            content: answer.to_string(),
            manual_id: None,
            manual_title: None,
            section_slug: None,
            section_heading: None,
            anchor_id: None,
            report_spec_id: None,
            report_route: None,
            route: None,
            entity_id: Some("riversideos_origin".to_string()),
        });
        tool_results.push(RosieToolResultOut {
            tool_name: "riversideos_origin".to_string(),
            args: serde_json::json!({}),
            result: serde_json::json!({ "answer": answer }),
        });
    }

    if let Some(client_context) = body.client_context.as_ref() {
        tool_results.push(RosieToolResultOut {
            tool_name: "client_workflow_context".to_string(),
            args: serde_json::json!({}),
            result: serde_json::json!({
                "current_surface": client_context.current_surface,
                "active_manual_id": client_context.active_manual_id,
                "active_manual_title": client_context.active_manual_title,
                "active_customer_id": client_context.active_customer_id,
                "active_transaction_id": client_context.active_transaction_id,
                "active_inventory_variant_id": client_context.active_inventory_variant_id,
                "last_user_question": client_context
                    .last_user_question
                    .as_deref()
                    .map(|value| sanitize_excerpt(value, 180)),
                "last_assistant_summary": client_context
                    .last_assistant_summary
                    .as_deref()
                    .map(|value| sanitize_excerpt(value, 240)),
            }),
        });
    }

    for playbook in workflow_playbooks(question) {
        let playbook_id = playbook
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("operational_playbook")
            .to_string();
        let title = playbook
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Operational workflow");
        let steps = playbook
            .get("steps")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        suggested_actions.extend(suggested_actions_from_playbook(&playbook));
        sources.push(RosieToolGroundingSourceOut {
            kind: "workflow".to_string(),
            title: title.to_string(),
            excerpt: sanitize_excerpt(&steps, 260),
            content: sanitize_excerpt(&playbook.to_string(), source_excerpt_limit),
            manual_id: None,
            manual_title: None,
            section_slug: None,
            section_heading: None,
            anchor_id: None,
            report_spec_id: None,
            report_route: None,
            route: None,
            entity_id: Some(playbook_id.clone()),
        });
        tool_results.push(RosieToolResultOut {
            tool_name: "operational_playbook".to_string(),
            args: serde_json::json!({ "playbook_id": playbook_id }),
            result: playbook,
        });
    }

    let manual_context_limit = if conversation_mode { 7 } else { 9 };
    let knowledge_result = rosie_knowledge_context_sections(
        &state,
        &viewer,
        question,
        body.client_context.as_ref(),
        manual_context_limit,
    )
    .await?;

    tool_results.push(RosieToolResultOut {
        tool_name: "rosie_knowledge_retrieval".to_string(),
        args: serde_json::json!({
            "question": question,
            "reviewed_chunk_count": knowledge_result.reviewed_chunk_count,
            "indexed_chunk_count": knowledge_result.indexed_chunk_count,
            "elapsed_ms": knowledge_result.elapsed_ms,
            "limit": manual_context_limit,
            "source_counts": knowledge_result.source_counts.clone(),
        }),
        result: serde_json::json!({
            "sections": knowledge_result.hits
                .iter()
                .map(|hit| serde_json::json!({
                    "source_group": hit.chunk.source_group,
                    "source_path": hit.chunk.source_path,
                    "manual_id": hit.chunk.manual_id,
                    "manual_title": hit.chunk.manual_title,
                    "section_slug": hit.chunk.section_slug,
                    "section_heading": hit.chunk.section_heading,
                    "excerpt": sanitize_excerpt(&hit.chunk.body, 700),
                    "score": hit.score,
                    "matched_terms": hit.matched_terms,
                }))
                .collect::<Vec<_>>()
        }),
    });

    let mut seen_manuals = HashSet::<String>::new();
    for hit in knowledge_result.hits.iter() {
        let chunk = &hit.chunk;
        let source_title = chunk
            .manual_title
            .as_deref()
            .or(chunk.source_path.as_deref())
            .unwrap_or("Riverside source");
        let title = format!("{} — {}", source_title, chunk.section_heading);
        sources.push(RosieToolGroundingSourceOut {
            kind: if chunk.manual_id.is_some() {
                "manual".to_string()
            } else {
                chunk.source_group.clone()
            },
            title,
            excerpt: sanitize_excerpt(&chunk.body, 260),
            content: sanitize_excerpt(&chunk.body, source_excerpt_limit),
            manual_id: chunk.manual_id.clone(),
            manual_title: chunk.manual_title.clone(),
            section_slug: Some(chunk.section_slug.clone()),
            section_heading: Some(chunk.section_heading.clone()),
            anchor_id: chunk
                .manual_id
                .as_ref()
                .map(|manual_id| format!("help-{}-{}", manual_id, chunk.section_slug)),
            report_spec_id: None,
            report_route: None,
            route: None,
            entity_id: chunk.source_path.clone(),
        });

        if let Some(manual_id) = &chunk.manual_id {
            if seen_manuals.len() >= 4 || !seen_manuals.insert(manual_id.clone()) {
                continue;
            }
            tool_results.push(RosieToolResultOut {
                tool_name: "help_manual_section".to_string(),
                args: serde_json::json!({
                    "manual_id": manual_id,
                    "section_slug": chunk.section_slug
                }),
                result: serde_json::json!({
                    "manual_id": manual_id,
                    "title": chunk.manual_title,
                    "section_heading": chunk.section_heading,
                    "markdown_excerpt": sanitize_excerpt(&chunk.body, 1000),
                }),
            });
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

        for (tool_name, args) in infer_read_tool_requests(question, body.client_context.as_ref()) {
            let result =
                execute_rosie_read_tool_inner(&state, &headers, tool_name.as_str(), args.clone())
                    .await?;
            sources.push(RosieToolGroundingSourceOut {
                kind: "rosie_read_tool".to_string(),
                title: format!("ROSIE Read Tool — {}", tool_name.replace('_', " ")),
                excerpt: format!(
                    "{} rows, basis {}{}",
                    result.row_count,
                    result.basis,
                    if result.limited { ", limited" } else { "" }
                ),
                content: sanitize_excerpt(&result.data.to_string(), source_excerpt_limit),
                manual_id: None,
                manual_title: None,
                section_slug: None,
                section_heading: None,
                anchor_id: None,
                report_spec_id: None,
                report_route: None,
                route: Some(format!("/api/help/rosie/v1/tools/execute#{tool_name}")),
                entity_id: None,
            });
            tool_results.push(RosieToolResultOut {
                tool_name: "rosie_read_tool".to_string(),
                args: serde_json::json!({
                    "tool_name": tool_name,
                    "arguments": args,
                }),
                result: serde_json::to_value(result).unwrap_or_else(|_| serde_json::json!({})),
            });
        }
    }

    Ok(Json(RosieToolContextResponse {
        question: question.to_string(),
        settings: body.settings,
        sources,
        tool_results,
        suggested_actions,
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
    crate::logic::rosie_knowledge::invalidate_rosie_knowledge_index().await;

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
    if deleted {
        crate::logic::rosie_knowledge::invalidate_rosie_knowledge_index().await;
    }

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
    let screenshot_script = help_screenshot_script_path();
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
        screenshot_script_exists: screenshot_script.exists(),
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
    if out.ok && !body.dry_run {
        crate::logic::rosie_knowledge::invalidate_rosie_knowledge_index().await;
    }
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

async fn admin_ops_capture_screenshots(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CaptureHelpScreenshotsBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let _staff = middleware::require_staff_with_permission(&state, &headers, HELP_MANAGE)
        .await
        .map_err(|e| e.into_response())?;

    let script = help_screenshot_script_path();
    if !script.exists() {
        return Err((
            axum::http::StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!("screenshot script not found: {}", script.display())
            })),
        )
            .into_response());
    }

    let base_url = match body.base_url.as_deref().map(str::trim) {
        Some("") => None,
        Some(value) if value.starts_with("http://") || value.starts_with("https://") => {
            Some(value.trim_end_matches('/').to_string())
        }
        Some(_) => {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "base_url must be an HTTP or HTTPS URL"
                })),
            )
                .into_response());
        }
        None => None,
    }
    .or_else(|| std::env::var("RIVERSIDE_HELP_SCREENSHOT_BASE_URL").ok())
    .unwrap_or_else(|| "http://127.0.0.1:3000".to_string());

    let api_base = match body.api_base.as_deref().map(str::trim) {
        Some("") => None,
        Some(value) if value.starts_with("http://") || value.starts_with("https://") => {
            Some(value.trim_end_matches('/').to_string())
        }
        Some(_) => {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "api_base must be an HTTP or HTTPS URL"
                })),
            )
                .into_response());
        }
        None => None,
    }
    .or_else(|| std::env::var("RIVERSIDE_HELP_SCREENSHOT_API_BASE").ok())
    .unwrap_or_else(|| base_url.clone());

    let mut cmd = Command::new("node");
    cmd.arg(script.as_os_str())
        .arg("--base-url")
        .arg(base_url)
        .arg("--api-base")
        .arg(api_base);

    if let Some(target) = body
        .target
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        cmd.arg("--target").arg(target);
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

    match crate::logic::help_corpus::reindex_help_meilisearch_with_policies(client, &state.db).await
    {
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

async fn admin_ops_meilisearch_health(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let _staff = middleware::require_staff_with_permission(&state, &headers, HELP_MANAGE)
        .await
        .map_err(|e| e.into_response())?;

    let Some(client) = state.meilisearch.as_ref() else {
        return Ok(Json(serde_json::json!({
            "configured": false,
            "reachable": false,
            "indexing": false,
            "latency_ms": 0,
            "message": "Meilisearch is not configured (RIVERSIDE_MEILISEARCH_URL unset)",
        })));
    };

    let health = crate::logic::meilisearch_client::health_check(client).await;
    Ok(Json(serde_json::json!({
        "configured": true,
        "reachable": health.reachable,
        "indexing": health.indexing,
        "latency_ms": health.latency_ms,
        "message": health.message,
    })))
}
