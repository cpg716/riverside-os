//! Governed ROSIE intelligence source registry and status helpers.
//!
//! This is intentionally narrow: ROSIE may improve from approved manuals,
//! staff docs, contract docs, generated help outputs, and optional curated /
//! redacted traces. It must not learn from uncontrolled memory, raw
//! production data, or unrestricted conversation logs.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::logic::help_manual_policy::HELP_MANUAL_FILES;

#[derive(Debug, serde::Serialize)]
pub struct RosieUpstreamHealth {
    pub configured: bool,
    pub reachable: bool,
    pub latency_ms: u64,
    pub message: String,
}

/// Token telemetry summary for cost analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosieTokenMetrics {
    pub daily_tokens: i64,
    pub daily_input_tokens: i64,
    pub daily_output_tokens: i64,
    pub monthly_tokens: i64,
    pub monthly_input_tokens: i64,
    pub monthly_output_tokens: i64,
    pub estimated_monthly_cost: Decimal,
    pub estimated_monthly_input_cost: Decimal,
    pub estimated_monthly_output_cost: Decimal,
    pub comparison_provider: String,
    pub comparison_model: String,
    pub input_cost_per_1m_tokens: Decimal,
    pub output_cost_per_1m_tokens: Decimal,
    pub estimate_basis: String,
    pub speech_cost_note: String,
}

/// Record token usage telemetry (non-blocking, fire-and-forget)
///
/// This function spawns a background task to write telemetry without blocking
/// the calling thread, ensuring POS performance is not impacted.
pub fn record_token_telemetry(
    pool: PgPool,
    provider: String,
    model_name: String,
    input_tokens: i32,
    output_tokens: i32,
) {
    tokio::spawn(async move {
        let query = r#"
            INSERT INTO rosie_token_telemetry (model_name, provider, input_tokens, output_tokens)
            VALUES ($1, $2, $3, $4)
        "#;

        if let Err(error) = sqlx::query(query)
            .bind(&model_name)
            .bind(&provider)
            .bind(input_tokens)
            .bind(output_tokens)
            .execute(&pool)
            .await
        {
            tracing::warn!(%error, "failed to record ROSIE token telemetry");
        }
    });
}

/// Extract token usage from a JSON response value and record telemetry in the background (fire-and-forget).
pub fn record_telemetry_from_value(pool: PgPool, provider: &str, body: &serde_json::Value) {
    if let Some(usage) = body.get("usage") {
        let input_tokens = usage
            .get("prompt_tokens")
            .and_then(|t| t.as_i64())
            .unwrap_or(0) as i32;
        let output_tokens = usage
            .get("completion_tokens")
            .and_then(|t| t.as_i64())
            .unwrap_or(0) as i32;
        let model_name = body
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown")
            .to_string();
        if input_tokens > 0 || output_tokens > 0 {
            record_token_telemetry(
                pool,
                provider.to_string(),
                model_name,
                input_tokens,
                output_tokens,
            );
        }
    }
}

/// Query token telemetry summary for external API cost comparison.
pub async fn get_token_metrics(pool: &PgPool) -> Result<RosieTokenMetrics, sqlx::Error> {
    let query = r#"
        WITH daily AS (
            SELECT
                COALESCE(SUM(input_tokens), 0)::bigint AS input_total,
                COALESCE(SUM(output_tokens), 0)::bigint AS output_total
            FROM rosie_token_telemetry
            WHERE DATE(timestamp) = CURRENT_DATE
        ),
        monthly AS (
            SELECT
                COALESCE(SUM(input_tokens), 0)::bigint AS input_total,
                COALESCE(SUM(output_tokens), 0)::bigint AS output_total
            FROM rosie_token_telemetry
            WHERE DATE_TRUNC('month', timestamp) = DATE_TRUNC('month', CURRENT_DATE)
        )
        SELECT
            (SELECT input_total FROM daily) AS daily_input_tokens,
            (SELECT output_total FROM daily) AS daily_output_tokens,
            (SELECT input_total FROM monthly) AS monthly_input_tokens,
            (SELECT output_total FROM monthly) AS monthly_output_tokens,
            COALESCE(rosie_config->>'cost_comparison_provider', 'custom_external_api') AS comparison_provider,
            COALESCE(rosie_config->>'cost_comparison_model', 'set_model_in_settings') AS comparison_model,
            COALESCE(NULLIF(rosie_config->>'external_input_cost_per_1m_tokens', '')::numeric, 0)::numeric AS input_cost_per_1m_tokens,
            COALESCE(NULLIF(rosie_config->>'external_output_cost_per_1m_tokens', '')::numeric, 0)::numeric AS output_cost_per_1m_tokens
        FROM store_settings
        WHERE id = 1
    "#;

    let row = sqlx::query(query).fetch_one(pool).await?;

    let daily_input_tokens: i64 = row.get("daily_input_tokens");
    let daily_output_tokens: i64 = row.get("daily_output_tokens");
    let monthly_input_tokens: i64 = row.get("monthly_input_tokens");
    let monthly_output_tokens: i64 = row.get("monthly_output_tokens");
    let input_cost_per_1m_tokens: Decimal = row.get("input_cost_per_1m_tokens");
    let output_cost_per_1m_tokens: Decimal = row.get("output_cost_per_1m_tokens");

    let estimated_monthly_input_cost =
        (Decimal::from(monthly_input_tokens) * input_cost_per_1m_tokens) / Decimal::from(1_000_000);
    let estimated_monthly_output_cost = (Decimal::from(monthly_output_tokens)
        * output_cost_per_1m_tokens)
        / Decimal::from(1_000_000);
    let estimated_monthly_cost = estimated_monthly_input_cost + estimated_monthly_output_cost;
    let daily_tokens = daily_input_tokens + daily_output_tokens;
    let monthly_tokens = monthly_input_tokens + monthly_output_tokens;

    Ok(RosieTokenMetrics {
        daily_tokens,
        daily_input_tokens,
        daily_output_tokens,
        monthly_tokens,
        monthly_input_tokens,
        monthly_output_tokens,
        estimated_monthly_cost,
        estimated_monthly_input_cost,
        estimated_monthly_output_cost,
        comparison_provider: row.get("comparison_provider"),
        comparison_model: row.get("comparison_model"),
        input_cost_per_1m_tokens,
        output_cost_per_1m_tokens,
        estimate_basis: "Compares recorded local ROSIE LLM token usage against configured external API input/output token rates.".to_string(),
        speech_cost_note: "TTS/STT API cost is not included until speech usage minutes are metered.".to_string(),
    })
}

pub async fn health_check(http: &reqwest::Client) -> RosieUpstreamHealth {
    let start = std::time::Instant::now();
    let provider = std::env::var("ROSIE_PROVIDER")
        .or_else(|_| std::env::var("ROSIE_PROVIDER_MODE"))
        .or_else(|_| std::env::var("RIVERSIDE_LLAMA_PROVIDER"))
        .unwrap_or_else(|_| "local_llm".to_string())
        .trim()
        .to_ascii_lowercase();

    let (url, auth_bearer, missing_message) = match provider.as_str() {
        "remote-lmstudio" | "remote_lmstudio" | "lmstudio" | "lmstudio-remote"
        | "lmstudio_remote" => {
            let base = std::env::var("ROSIE_REMOTE_LMSTUDIO_BASE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:1234/v1".to_string())
                .trim_end_matches('/')
                .to_string();
            let models_url = if base.ends_with("/v1") {
                format!("{base}/models")
            } else {
                format!("{base}/v1/models")
            };
            (models_url, None, None)
        }
        "openai" | "openai-api" | "cloud-openai" | "cloud_openai" => {
            let api_key = std::env::var("OPENAI_API_KEY")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let base = std::env::var("OPENAI_BASE_URL")
                .unwrap_or_else(|_| "https://api.openai.com".to_string())
                .trim_end_matches('/')
                .to_string();
            (
                format!("{base}/v1/models"),
                api_key,
                Some("OpenAI API key is not configured in Settings or OPENAI_API_KEY"),
            )
        }
        "gemini" | "gemini-api" | "gemini_api" => {
            let api_key = match std::env::var("GEMINI_API_KEY")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            {
                Some(api_key) => api_key,
                None => {
                    return RosieUpstreamHealth {
                        configured: false,
                        reachable: false,
                        latency_ms: 0,
                        message: "Gemini API key is not configured in Settings or GEMINI_API_KEY"
                            .to_string(),
                    };
                }
            };
            let base = std::env::var("ROSIE_GEMINI_BASE_URL")
                .unwrap_or_else(|_| "https://generativelanguage.googleapis.com".to_string())
                .trim_end_matches('/')
                .to_string();
            (format!("{base}/v1beta/models?key={api_key}"), None, None)
        }
        _ => {
            let upstream = match std::env::var("ROSIE_LOCAL_LLM_BASE_URL")
                .or_else(|_| std::env::var("RIVERSIDE_LLAMA_UPSTREAM"))
                .ok()
                .map(|v| v.trim().trim_end_matches('/').to_string())
                .filter(|v| !v.is_empty())
            {
                Some(u) => u,
                None => {
                    return RosieUpstreamHealth {
                        configured: false,
                        reachable: false,
                        latency_ms: 0,
                        message: "ROSIE upstream not configured (RIVERSIDE_LLAMA_UPSTREAM unset)"
                            .to_string(),
                    };
                }
            };
            (format!("{upstream}/health"), None, None)
        }
    };

    if auth_bearer.is_none() && missing_message.is_some() {
        return RosieUpstreamHealth {
            configured: false,
            reachable: false,
            latency_ms: 0,
            message: missing_message.unwrap().to_string(),
        };
    }

    let mut request = http.get(&url).timeout(std::time::Duration::from_secs(5));
    if let Some(token) = auth_bearer {
        request = request.bearer_auth(token);
    }

    match request.send().await {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                RosieUpstreamHealth {
                    configured: true,
                    reachable: true,
                    latency_ms: start.elapsed().as_millis() as u64,
                    message: "ROSIE upstream LLM is reachable".to_string(),
                }
            } else {
                RosieUpstreamHealth {
                    configured: true,
                    reachable: false,
                    latency_ms: start.elapsed().as_millis() as u64,
                    message: format!("ROSIE upstream returned HTTP {status}"),
                }
            }
        }
        Err(e) => RosieUpstreamHealth {
            configured: true,
            reachable: false,
            latency_ms: start.elapsed().as_millis() as u64,
            message: format!("ROSIE upstream network error: {e}"),
        },
    }
}

pub const ROSIE_POLICY_PACK_VERSION: &str = "rosie-policy-pack-2026-05-16-v1";
pub const ROSIE_INTELLIGENCE_PACK_VERSION: &str = "rosie-intelligence-pack-2026-05-16-v1";
pub const OPTIONAL_CURATED_TRACE_ROOT: &str = "docs/rosie/curated_examples";

const GENERATED_HELP_OUTPUTS: &[&str] = &[
    "client/src/lib/help/help-manifest.generated.ts",
    "server/src/logic/help_corpus_manuals.generated.rs",
];

const POLICY_CONTRACT_DOCS: &[&str] = &[
    "docs/AI_CONTEXT_FOR_ASSISTANTS.md",
    "docs/AI_REPORTING_DATA_CATALOG.md",
    "docs/HELP_CENTER_AUTOMATION.md",
    "docs/PLAN_LOCAL_LLM_HELP.md",
    "docs/ROS_AI_HELP_CORPUS.md",
    "docs/ROSIE_OPERATING_CONTRACT.md",
];

const EXCLUDED_SOURCE_RULES: &[&str] = &[
    "raw live customer, order, payment, and catalog database content",
    "arbitrary production database exports or ad-hoc SQL results",
    "unrestricted conversation history or chat transcripts",
    "unreviewed generated content outside approved Help/manual outputs",
    "autonomous prompt or policy mutation",
    "customer PII or payment artifacts used as learning corpora",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RosieIntelligenceSourceGroup {
    pub key: String,
    pub label: String,
    pub description: String,
    pub source_count: usize,
    pub source_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RosieIntelligenceIssue {
    pub path: String,
    pub issue: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RosieCapabilityCategory {
    Knowledge,
    DataRetrieval,
    Workflow,
    Analysis,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosieCapability {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: RosieCapabilityCategory,
    pub requires_permission: Option<String>,
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosieSelfReflection {
    pub available_tools: Vec<RosieCapability>,
    pub knowledge_sources: Vec<String>,
    pub current_context: Option<String>,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosieIntelligencePack {
    pub policy_pack_version: String,
    pub intelligence_pack_version: String,
    pub approved_source_groups: Vec<RosieIntelligenceSourceGroup>,
    pub excluded_source_rules: Vec<String>,
    pub issues_detected: Vec<RosieIntelligenceIssue>,
    pub last_generated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct StaffCorpusManifest {
    files: Vec<String>,
}

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn load_rosie_intelligence_pack(root: &Path) -> RosieIntelligencePack {
    let help_manuals = HELP_MANUAL_FILES
        .iter()
        .map(|(_, path)| (*path).to_string())
        .collect::<Vec<_>>();
    let staff_corpus = load_staff_corpus_paths();
    let curated_traces = load_optional_curated_trace_paths(root);

    let approved_source_groups = vec![
        RosieIntelligenceSourceGroup {
            key: "help_manuals".to_string(),
            label: "Help manuals".to_string(),
            description: "Bundled in-app Help Center manuals generated from client/src/assets/docs/*-manual.md.".to_string(),
            source_count: help_manuals.len(),
            source_paths: help_manuals,
        },
        RosieIntelligenceSourceGroup {
            key: "staff_corpus".to_string(),
            label: "Staff docs".to_string(),
            description: "Approved docs/staff and linked operational docs from docs/staff/CORPUS.manifest.json.".to_string(),
            source_count: staff_corpus.len(),
            source_paths: staff_corpus,
        },
        RosieIntelligenceSourceGroup {
            key: "policy_contracts".to_string(),
            label: "ROSIE contract docs".to_string(),
            description:
                "Versioned ROSIE policy and reporting contract bundle loaded only from reviewed repo docs."
                    .to_string(),
            source_count: POLICY_CONTRACT_DOCS.len(),
            source_paths: POLICY_CONTRACT_DOCS.iter().map(|path| (*path).to_string()).collect(),
        },
        RosieIntelligenceSourceGroup {
            key: "generated_help_outputs".to_string(),
            label: "Generated help outputs".to_string(),
            description:
                "Generated help manifest outputs that keep bundled manuals and server help corpus wiring aligned."
                    .to_string(),
            source_count: GENERATED_HELP_OUTPUTS.len(),
            source_paths: GENERATED_HELP_OUTPUTS
                .iter()
                .map(|path| (*path).to_string())
                .collect(),
        },
        RosieIntelligenceSourceGroup {
            key: "curated_redacted_traces".to_string(),
            label: "Curated redacted traces".to_string(),
            description:
                "Optional curated/redacted tool traces under docs/rosie/curated_examples only when explicitly reviewed and present."
                    .to_string(),
            source_count: curated_traces.len(),
            source_paths: curated_traces,
        },
    ];

    RosieIntelligencePack {
        policy_pack_version: ROSIE_POLICY_PACK_VERSION.to_string(),
        intelligence_pack_version: ROSIE_INTELLIGENCE_PACK_VERSION.to_string(),
        issues_detected: detect_pack_issues(root, &approved_source_groups),
        excluded_source_rules: EXCLUDED_SOURCE_RULES
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        last_generated_at: latest_generated_artifact_time(root),
        approved_source_groups,
    }
}

pub fn is_approved_curated_trace_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized.starts_with(OPTIONAL_CURATED_TRACE_ROOT) && normalized.ends_with(".md")
}

fn detect_pack_issues(
    root: &Path,
    approved_source_groups: &[RosieIntelligenceSourceGroup],
) -> Vec<RosieIntelligenceIssue> {
    let mut issues = Vec::new();

    for group in approved_source_groups {
        if group.key == "curated_redacted_traces" {
            continue;
        }
        for rel_path in &group.source_paths {
            let full_path = root.join(rel_path);
            if !full_path.exists() {
                issues.push(RosieIntelligenceIssue {
                    path: rel_path.clone(),
                    issue: "approved source path is missing on disk".to_string(),
                });
            }
        }
    }

    issues
}

fn load_staff_corpus_paths() -> Vec<String> {
    let manifest: StaffCorpusManifest =
        serde_json::from_str(include_str!("../../../docs/staff/CORPUS.manifest.json"))
            .unwrap_or_else(|_| StaffCorpusManifest { files: Vec::new() });
    manifest.files
}

fn load_optional_curated_trace_paths(root: &Path) -> Vec<String> {
    let traces_dir = root.join(OPTIONAL_CURATED_TRACE_ROOT);
    let mut paths = Vec::new();

    let Ok(entries) = fs::read_dir(traces_dir) else {
        return paths;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if is_approved_curated_trace_path(&relative) {
            paths.push(relative);
        }
    }

    paths.sort();
    paths
}

fn latest_generated_artifact_time(root: &Path) -> Option<DateTime<Utc>> {
    GENERATED_HELP_OUTPUTS
        .iter()
        .filter_map(|path| fs::metadata(root.join(path)).ok())
        .filter_map(|metadata| metadata.modified().ok())
        .max()
        .map(system_time_to_utc)
}

fn system_time_to_utc(value: SystemTime) -> DateTime<Utc> {
    DateTime::<Utc>::from(value)
}

/// Get all ROSIE capabilities for self-awareness
pub fn get_all_capabilities() -> Vec<RosieCapability> {
    vec![
        RosieCapability {
            id: "help_search".to_string(),
            name: "Help Manual Search".to_string(),
            description: "Search in-app help manuals for workflow guidance and procedures".to_string(),
            category: RosieCapabilityCategory::Knowledge,
            requires_permission: None,
            examples: vec![
                "How do I process a refund?".to_string(),
                "Where is the register close workflow?".to_string(),
                "How do I add a customer to an order?".to_string(),
            ],
        },
        RosieCapability {
            id: "customer_search".to_string(),
            name: "Customer Lookup".to_string(),
            description: "Search and retrieve customer information from the CRM".to_string(),
            category: RosieCapabilityCategory::DataRetrieval,
            requires_permission: Some("customers.view".to_string()),
            examples: vec![
                "Find customer John Smith".to_string(),
                "Show customer order history".to_string(),
                "What is this customer's balance?".to_string(),
            ],
        },
        RosieCapability {
            id: "order_search".to_string(),
            name: "Order Lookup".to_string(),
            description: "Search and retrieve order information including special orders, custom orders, and wedding orders".to_string(),
            category: RosieCapabilityCategory::DataRetrieval,
            requires_permission: Some("orders.view".to_string()),
            examples: vec![
                "Find order #12345".to_string(),
                "Show open special orders".to_string(),
                "What is the status of this wedding order?".to_string(),
            ],
        },
        RosieCapability {
            id: "inventory_search".to_string(),
            name: "Inventory Lookup".to_string(),
            description: "Search catalog inventory and check stock levels".to_string(),
            category: RosieCapabilityCategory::DataRetrieval,
            requires_permission: Some("inventory.view".to_string()),
            examples: vec![
                "Find a black tuxedo size 42R".to_string(),
                "Check stock for SKU ABC123".to_string(),
                "Show all available vests".to_string(),
            ],
        },
        RosieCapability {
            id: "reporting_query".to_string(),
            name: "Curated Reports".to_string(),
            description: "Run approved reporting queries for sales, inventory, and financial data".to_string(),
            category: RosieCapabilityCategory::Analysis,
            requires_permission: Some("reports.view".to_string()),
            examples: vec![
                "Show today's sales".to_string(),
                "What is our current inventory value?".to_string(),
                "Generate a margin report".to_string(),
            ],
        },
        RosieCapability {
            id: "workflow_guidance".to_string(),
            name: "Workflow Guidance".to_string(),
            description: "Provide step-by-step guidance for Riverside OS workflows based on help manuals".to_string(),
            category: RosieCapabilityCategory::Workflow,
            requires_permission: None,
            examples: vec![
                "Walk me through the checkout process".to_string(),
                "How do I handle a return?".to_string(),
                "Steps for receiving inventory".to_string(),
            ],
        },
        RosieCapability {
            id: "alteration_lookup".to_string(),
            name: "Alteration Lookup".to_string(),
            description: "Search and retrieve alteration work information".to_string(),
            category: RosieCapabilityCategory::DataRetrieval,
            requires_permission: Some("alterations.view".to_string()),
            examples: vec![
                "Find alteration #789".to_string(),
                "Show pending alterations".to_string(),
                "What is the status of this alteration?".to_string(),
            ],
        },
        RosieCapability {
            id: "wedding_lookup".to_string(),
            name: "Wedding Lookup".to_string(),
            description: "Search and retrieve wedding party information".to_string(),
            category: RosieCapabilityCategory::DataRetrieval,
            requires_permission: Some("weddings.view".to_string()),
            examples: vec![
                "Find wedding for John Smith".to_string(),
                "Show wedding party members".to_string(),
                "What is the wedding status?".to_string(),
            ],
        },
        RosieCapability {
            id: "e2e_manual_generation".to_string(),
            name: "E2E Manual Generation".to_string(),
            description: "Generate help center manuals with screenshots using the isolated E2E test environment".to_string(),
            category: RosieCapabilityCategory::Workflow,
            requires_permission: Some("help.manage".to_string()),
            examples: vec![
                "Generate a manual for the checkout workflow".to_string(),
                "Create documentation for customer orders with screenshots".to_string(),
                "Produce help manual for inventory receiving".to_string(),
            ],
        },
        RosieCapability {
            id: "e2e_workflow_testing".to_string(),
            name: "E2E Workflow Testing".to_string(),
            description: "Test workflows for bugs and errors using the isolated E2E test environment without affecting production data".to_string(),
            category: RosieCapabilityCategory::Workflow,
            requires_permission: Some("help.manage".to_string()),
            examples: vec![
                "Test the checkout workflow for bugs".to_string(),
                "Verify the refund process works correctly".to_string(),
                "Run bug test on inventory receiving workflow".to_string(),
            ],
        },
    ]
}

/// Get ROSIE self-reflection including capabilities, knowledge sources, and limitations
pub fn get_rosie_self_reflection(context: Option<String>) -> RosieSelfReflection {
    let pack = load_rosie_intelligence_pack(&repo_root());
    let knowledge_sources = pack
        .approved_source_groups
        .iter()
        .map(|group| format!("{}: {}", group.label, group.description))
        .collect();

    RosieSelfReflection {
        available_tools: get_all_capabilities(),
        knowledge_sources,
        current_context: context,
        limitations: vec![
            "Cannot modify production data or business logic".to_string(),
            "Cannot execute SQL queries directly".to_string(),
            "Cannot bypass permissions or access controls".to_string(),
            "Cannot write to database tables".to_string(),
            "Cannot learn from raw production data or PII".to_string(),
            "Cannot autonomously mutate application code".to_string(),
            "Cannot perform financial transactions".to_string(),
            "Cannot access customer payment information".to_string(),
            "E2E workflows run on isolated test environment only".to_string(),
            "E2E operations require help.manage permission".to_string(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn health_check_returns_not_configured_when_upstream_unset() {
        let previous = std::env::var("RIVERSIDE_LLAMA_UPSTREAM").ok();
        std::env::remove_var("RIVERSIDE_LLAMA_UPSTREAM");
        let health = health_check(&reqwest::Client::new()).await;
        assert!(!health.configured);
        assert!(!health.reachable);
        assert_eq!(health.latency_ms, 0);
        assert!(
            health.message.contains("not configured"),
            "unexpected message: {}",
            health.message
        );
        if let Some(v) = previous {
            std::env::set_var("RIVERSIDE_LLAMA_UPSTREAM", v);
        }
    }

    #[test]
    fn intelligence_pack_includes_expected_groups() {
        let pack = load_rosie_intelligence_pack(&repo_root());
        let keys = pack
            .approved_source_groups
            .iter()
            .map(|group| group.key.as_str())
            .collect::<Vec<_>>();

        assert!(keys.contains(&"help_manuals"));
        assert!(keys.contains(&"staff_corpus"));
        assert!(keys.contains(&"policy_contracts"));
        assert!(keys.contains(&"generated_help_outputs"));
        assert!(keys.contains(&"curated_redacted_traces"));
    }

    #[test]
    fn intelligence_pack_contract_docs_are_explicit() {
        let pack = load_rosie_intelligence_pack(&repo_root());
        let contracts = pack
            .approved_source_groups
            .iter()
            .find(|group| group.key == "policy_contracts")
            .expect("policy contract group");

        assert_eq!(contracts.source_paths, POLICY_CONTRACT_DOCS);
    }

    #[test]
    fn rejects_non_approved_curated_trace_paths() {
        assert!(is_approved_curated_trace_path(
            "docs/rosie/curated_examples/register-close.md"
        ));
        assert!(!is_approved_curated_trace_path(
            "docs/rosie/raw/customer-export.json"
        ));
        assert!(!is_approved_curated_trace_path("docs/staff/README.md"));
    }

    #[test]
    fn excluded_source_rules_block_uncontrolled_learning_inputs() {
        let pack = load_rosie_intelligence_pack(&repo_root());

        assert!(pack
            .excluded_source_rules
            .iter()
            .any(|rule| rule.contains("conversation history")));
        assert!(pack
            .excluded_source_rules
            .iter()
            .any(|rule| rule.contains("production database")));
        assert!(pack
            .excluded_source_rules
            .iter()
            .any(|rule| rule.contains("autonomous prompt or policy mutation")));
    }
}
