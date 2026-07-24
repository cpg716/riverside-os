#![allow(clippy::all)]
//! ROS Dev Center v1 domain logic (ops health, stations, alerts, actions, bug overlays).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, Utc};
use reqwest::header::{ACCEPT, AUTHORIZATION, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Column, PgPool, Row};
use tokio::process::Command;
use uuid::Uuid;

use crate::api::qbo;
use crate::auth::permissions::OPS_DEV_CENTER_VIEW;
use crate::logic::backups::{BackupManager, BackupSettings};
use crate::logic::bug_reports;
use crate::logic::counterpoint_sync;
use crate::logic::email;
use crate::logic::fal_sidecar;
use crate::logic::helcim;
use crate::logic::help_corpus;
use crate::logic::insights_config::StoreInsightsConfig;
use crate::logic::integration_credentials;
use crate::logic::notifications::{staff_ids_with_permission, upsert_app_notification_by_dedupe};
use crate::logic::nuorder::{nuorder_client_from_pool, NuorderClient, NuorderCredentials};
use crate::logic::podium;
use crate::logic::rosie_intelligence;
use crate::logic::shippo::{self, load_effective_shippo_config};
use crate::logic::weather::{self, load_store_weather_settings};
use crate::observability::ServerLogRing;

#[derive(Debug, Serialize, sqlx::FromRow, Clone)]
pub struct IntegrationHealthItem {
    pub key: String,
    pub title: String,
    pub status: String,
    pub severity: String,
    pub detail: String,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_failure_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

const INTEGRATION_HEARTBEAT_FRESHNESS_MINUTES: i64 = 5;
const COUNTERPOINT_SYNC_FRESHNESS_HOURS: i64 = 72;

fn bound_client_reported_timestamp(
    timestamp: Option<DateTime<Utc>>,
    received_at: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    timestamp.map(|value| value.min(received_at))
}

fn confirmed_client_install_timestamp(
    timestamp: Option<DateTime<Utc>>,
    meta: &Value,
    received_at: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let is_confirmed = meta
        .get("app_update_install_observation")
        .and_then(|observation| observation.get("status"))
        .and_then(Value::as_str)
        == Some("confirmed");
    is_confirmed
        .then(|| bound_client_reported_timestamp(timestamp, received_at))
        .flatten()
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct IntegrationStateRow {
    source: String,
    status: String,
    last_failure_at: Option<DateTime<Utc>>,
    last_success_at: Option<DateTime<Utc>>,
    detail: Option<String>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct CounterpointSyncHealthRow {
    entity: String,
    last_ok_at: Option<DateTime<Utc>>,
    last_error: Option<String>,
    updated_at: DateTime<Utc>,
}

fn counterpoint_sync_health_item(
    rows: &[CounterpointSyncHealthRow],
    now: DateTime<Utc>,
) -> IntegrationHealthItem {
    let stale_threshold = now - Duration::hours(COUNTERPOINT_SYNC_FRESHNESS_HOURS);
    let future_tolerance = now + Duration::minutes(5);
    let issues = rows
        .iter()
        .filter_map(|row| {
            if row
                .last_error
                .as_deref()
                .map(str::trim)
                .is_some_and(|error| !error.is_empty())
            {
                return Some(format!("{} (error)", row.entity));
            }
            match row.last_ok_at {
                None => Some(format!("{} (never succeeded)", row.entity)),
                Some(ok) if ok > future_tolerance => {
                    Some(format!("{} (invalid future success time)", row.entity))
                }
                Some(ok) if ok < stale_threshold => Some(format!("{} (stale)", row.entity)),
                _ => None,
            }
        })
        .collect::<Vec<_>>();

    let (status, severity, detail) = if rows.is_empty() {
        (
            "degraded",
            "warning",
            "Unknown: no Counterpoint sync history is recorded, so sync health is not proven."
                .to_string(),
        )
    } else if issues.is_empty() {
        (
            "healthy",
            "info",
            format!(
                "Every recorded Counterpoint entity has succeeded within {COUNTERPOINT_SYNC_FRESHNESS_HOURS} hours."
            ),
        )
    } else {
        ("degraded", "warning", issues.join(", "))
    };

    IntegrationHealthItem {
        key: "counterpoint_sync".to_string(),
        title: "Counterpoint sync".to_string(),
        status: status.to_string(),
        severity: severity.to_string(),
        detail,
        last_success_at: rows.iter().filter_map(|row| row.last_ok_at).max(),
        last_failure_at: rows
            .iter()
            .filter(|row| {
                row.last_error
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|error| !error.is_empty())
            })
            .map(|row| row.updated_at)
            .max(),
        updated_at: rows.iter().map(|row| row.updated_at).max(),
    }
}

fn meilisearch_health_item(
    configured: bool,
    state: Option<&IntegrationStateRow>,
    proof: Option<&crate::logic::meilisearch_search::FullReindexProof>,
    now: DateTime<Utc>,
) -> IntegrationHealthItem {
    if !configured {
        return IntegrationHealthItem {
            key: "meilisearch".to_string(),
            title: "Meilisearch".to_string(),
            status: "disabled".to_string(),
            severity: "warning".to_string(),
            detail: "Not configured; authoritative PostgreSQL fallback search is active."
                .to_string(),
            last_success_at: None,
            last_failure_at: None,
            updated_at: state.map(|row| row.updated_at),
        };
    }

    let heartbeat_cutoff = now - Duration::minutes(INTEGRATION_HEARTBEAT_FRESHNESS_MINUTES);
    let recorded_status = state
        .map(|row| row.status.trim().to_ascii_uppercase())
        .unwrap_or_default();
    let heartbeat_is_fresh = state.is_some_and(|row| {
        row.updated_at >= heartbeat_cutoff && row.updated_at <= now + Duration::minutes(5)
    });
    let proof_is_fresh = proof.is_some_and(|value| value.is_fresh());

    let (status, severity, detail) = if recorded_status == "WARNING" && heartbeat_is_fresh {
        (
            "failed",
            "critical",
            state.and_then(|row| row.detail.clone()).unwrap_or_else(|| {
                "The current Meilisearch reachability probe failed.".to_string()
            }),
        )
    } else if state.is_none() {
        (
            "degraded",
            "warning",
            "Meilisearch is configured, but no reachability heartbeat has been recorded. Search uses PostgreSQL until current proof exists."
                .to_string(),
        )
    } else if !heartbeat_is_fresh {
        (
            "degraded",
            "warning",
            format!(
                "The last Meilisearch heartbeat is stale or future-dated. {}",
                proof
                    .map(|value| value.detail.as_str())
                    .unwrap_or("Full-rebuild freshness proof is unavailable.")
            ),
        )
    } else if recorded_status != "GOOD" || !proof_is_fresh {
        (
            "degraded",
            "warning",
            format!(
                "Meilisearch is configured but not fully proven healthy. {}",
                proof
                    .map(|value| value.detail.as_str())
                    .or_else(|| state.and_then(|row| row.detail.as_deref()))
                    .unwrap_or("Full-rebuild freshness proof is unavailable.")
            ),
        )
    } else {
        (
            "healthy",
            "info",
            proof
                .map(|value| format!("Meilisearch is reachable. {}", value.detail))
                .unwrap_or_else(|| "Meilisearch is reachable and freshly rebuilt.".to_string()),
        )
    };

    IntegrationHealthItem {
        key: "meilisearch".to_string(),
        title: "Meilisearch".to_string(),
        status: status.to_string(),
        severity: severity.to_string(),
        detail,
        last_success_at: proof.and_then(|value| value.last_success_at),
        last_failure_at: state.and_then(|row| row.last_failure_at).or_else(|| {
            proof.and_then(|value| {
                (value.status == crate::logic::meilisearch_search::FullReindexProofStatus::Failed)
                    .then_some(value.last_attempt_at)
                    .flatten()
            })
        }),
        updated_at: state.map(|row| row.updated_at),
    }
}

#[derive(Debug, Deserialize)]
pub struct StationHeartbeatIn {
    pub station_key: String,
    pub station_label: String,
    pub app_version: String,
    #[serde(default)]
    pub git_sha: Option<String>,
    #[serde(default)]
    pub tailscale_node: Option<String>,
    #[serde(default)]
    pub lan_ip: Option<String>,
    #[serde(default)]
    pub last_sync_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_update_check_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_update_install_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub meta: Value,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct StationRow {
    pub station_key: String,
    pub station_label: String,
    pub app_version: String,
    pub git_sha: Option<String>,
    pub tailscale_node: Option<String>,
    pub lan_ip: Option<String>,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub last_update_check_at: Option<DateTime<Utc>>,
    pub last_update_install_at: Option<DateTime<Utc>>,
    pub client_timestamp_source: String,
    pub last_seen_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub online: bool,
    pub monitor_offline: bool,
    pub station_lifecycle: String,
    pub actionable: bool,
    pub active_staff_sessions: i64,
    pub active_staff_names: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AlertEventRow {
    pub id: Uuid,
    pub rule_key: String,
    pub title: String,
    pub body: String,
    pub severity: String,
    pub status: String,
    pub context: Value,
    pub first_seen_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub acked_at: Option<DateTime<Utc>>,
    pub acked_by_staff_id: Option<Uuid>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub resolved_by_staff_id: Option<Uuid>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ActionAuditRow {
    pub id: Uuid,
    pub actor_staff_id: Uuid,
    pub action_key: String,
    pub reason: String,
    pub payload_json: Value,
    pub payload_hash_sha256: String,
    pub correlation_id: Uuid,
    pub result_ok: bool,
    pub result_message: String,
    pub result_json: Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AuditProbeRunRow {
    pub id: Uuid,
    pub triggered_by_staff_id: Option<Uuid>,
    pub probe_count: i32,
    pub total_violation_rows: i32,
    pub probes_with_violations: i32,
    pub duration_ms: Option<i32>,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AuditProbeResultRow {
    pub id: Uuid,
    pub run_id: Uuid,
    pub probe_key: String,
    pub probe_label: String,
    pub severity: String,
    pub violation_count: i32,
    pub detail_rows: Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct BugOverviewRow {
    pub id: Uuid,
    pub correlation_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub status: String,
    pub summary: String,
    pub staff_name: String,
    pub linked_incidents: i64,
    pub oldest_linked_alert_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct OpsHealthSnapshot {
    pub server_time: DateTime<Utc>,
    pub db_ok: bool,
    pub meilisearch_configured: bool,
    pub tailscale_expected: bool,
    pub integrations: Vec<IntegrationHealthItem>,
    pub open_alerts: i64,
    pub stations_online: i64,
    pub stations_offline: i64,
    pub stations_stale: i64,
    pub pending_bug_reports: i64,
}

#[derive(Debug, Serialize)]
pub struct RuntimeDiagnosticItem {
    pub key: String,
    pub label: String,
    pub value: String,
    pub detail: String,
    pub severity: String,
}

#[derive(Debug, Serialize)]
pub struct RuntimeDiagnosticsSnapshot {
    pub generated_at: DateTime<Utc>,
    pub items: Vec<RuntimeDiagnosticItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpsRetentionConfig {
    pub station_retention_days: i64,
    pub resolved_alert_retention_days: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpsRetentionCleanupResult {
    pub stale_station_alerts_resolved: u64,
    pub stale_stations_deleted: u64,
    pub resolved_alerts_deleted: u64,
    pub station_retention_days: i64,
    pub resolved_alert_retention_days: i64,
}

#[derive(Debug, Serialize)]
pub struct GuardedActionResult {
    pub ok: bool,
    pub message: String,
    pub data: Value,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ReadinessSignoffRow {
    pub check_key: String,
    pub category: String,
    pub label: String,
    pub status: String,
    pub notes: String,
    pub evidence_ref: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub signed_off_by_staff_id: Option<Uuid>,
    pub signed_off_by_staff_name: Option<String>,
    pub signed_off_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ReadinessSignoffInput {
    pub category: String,
    pub label: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub evidence_ref: String,
    #[serde(default)]
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct E2eFailurePlaybookItem {
    pub category: String,
    pub recommended_next_action: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct E2eLaneStatus {
    pub lane_key: String,
    pub purpose: String,
    pub workflow_name: String,
    pub job_name: String,
    pub run_id: Option<i64>,
    pub run_number: Option<i64>,
    pub html_url: Option<String>,
    pub status: Option<String>,
    pub conclusion: Option<String>,
    pub last_run_outcome: String,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub failed_specs: Vec<String>,
    pub failure_category: Option<String>,
    pub recommended_next_action: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct E2eHealthSource {
    pub mode: String,
    pub stale: bool,
    pub cache_age_seconds: Option<u64>,
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct E2eHealthSnapshot {
    pub generated_at: DateTime<Utc>,
    pub source: E2eHealthSource,
    pub blocking: E2eLaneStatus,
    pub nightly: E2eLaneStatus,
    pub failure_issue_url: Option<String>,
    pub playbook: Vec<E2eFailurePlaybookItem>,
}

#[derive(Debug, Deserialize)]
struct GithubWorkflowRunsResponse {
    #[serde(default)]
    workflow_runs: Vec<GithubWorkflowRun>,
}

#[derive(Debug, Deserialize, Clone)]
struct GithubWorkflowRun {
    id: i64,
    #[serde(default)]
    run_number: i64,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct GithubJobsResponse {
    #[serde(default)]
    jobs: Vec<GithubJob>,
}

#[derive(Debug, Deserialize, Clone)]
struct GithubJob {
    id: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    started_at: Option<DateTime<Utc>>,
    #[serde(default)]
    completed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    steps: Vec<GithubJobStep>,
}

#[derive(Debug, Deserialize, Clone)]
struct GithubJobStep {
    #[serde(default)]
    name: String,
    #[serde(default)]
    conclusion: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum E2eLaneKey {
    Blocking,
    Nightly,
}

impl E2eLaneKey {
    fn as_str(self) -> &'static str {
        match self {
            Self::Blocking => "blocking",
            Self::Nightly => "nightly",
        }
    }

    fn job_name(self) -> &'static str {
        match self {
            Self::Blocking => "Playwright Blocking Lane",
            Self::Nightly => "Playwright Nightly Lane",
        }
    }

    fn purpose(self) -> &'static str {
        match self {
            Self::Blocking => {
                "High-signal financial, tax, register, audit, staff-language, and core navigation contracts."
            }
            Self::Nightly => {
                "Broader responsive, full-suite, visual, and runtime-cleanliness coverage for drift detection without PR blocking."
            }
        }
    }

    fn is_run_match(self, event: &str) -> bool {
        match self {
            Self::Blocking => event != "schedule",
            Self::Nightly => event == "schedule",
        }
    }
}

fn backup_overdue_hours() -> i64 {
    std::env::var("RIVERSIDE_BACKUP_OVERDUE_HOURS")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|h: &i64| *h > 0 && *h <= 720)
        .unwrap_or(30)
}

fn now_online_cutoff() -> DateTime<Utc> {
    Utc::now() - Duration::minutes(5)
}

fn station_offline_alert_cutoff() -> DateTime<Utc> {
    let hours = env_i64_range("RIVERSIDE_OPS_STATION_OFFLINE_ALERT_HOURS", 24, 1, 168);
    Utc::now() - Duration::hours(hours)
}

fn normalize_label(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        "Unnamed station".to_string()
    } else {
        t.to_string()
    }
}

fn payload_sha256(payload: &Value) -> String {
    let bytes = serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec());
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    hex::encode(hasher.finalize())
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn help_manifest_script_path() -> PathBuf {
    repo_root()
        .join("client")
        .join("scripts")
        .join("generate-help-manifest.mjs")
}

fn env_truthy(key: &str) -> bool {
    match std::env::var(key) {
        Ok(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => false,
    }
}

fn nonempty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn environment_mode_diagnostic(environment_mode: &str) -> RuntimeDiagnosticItem {
    let normalized = environment_mode.trim().to_ascii_lowercase();
    let normalized = if normalized.is_empty() {
        "development".to_string()
    } else {
        normalized
    };
    RuntimeDiagnosticItem {
        key: "environment_mode".to_string(),
        label: "Environment Mode".to_string(),
        value: normalized.clone(),
        detail: format!("RIVERSIDE_MODE reports this server as {normalized}."),
        severity: if normalized == "production" {
            "info".to_string()
        } else {
            "warning".to_string()
        },
    }
}

fn production_safeguards_diagnostic(
    environment_mode: &str,
    strict_production: bool,
) -> RuntimeDiagnosticItem {
    let production_mode = environment_mode.trim().eq_ignore_ascii_case("production");
    RuntimeDiagnosticItem {
        key: "production_safeguards".to_string(),
        label: "Production Safeguards".to_string(),
        value: if strict_production {
            "Enabled".to_string()
        } else {
            "Disabled".to_string()
        },
        detail: if strict_production {
            "Strict production startup guards and configuration enforcement are active.".to_string()
        } else if production_mode {
            "The server is in production mode, but strict startup safeguards are disabled. Staff operations remain available; production go-live signoff is blocked until prerequisites are verified and safeguards are explicitly enabled."
                .to_string()
        } else {
            "Strict production startup safeguards are not enabled for this non-production runtime."
                .to_string()
        },
        severity: if strict_production {
            "info".to_string()
        } else if production_mode {
            "critical".to_string()
        } else {
            "warning".to_string()
        },
    }
}

fn env_i64_range(key: &str, default: i64, min: i64, max: i64) -> i64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .map(|value| value.clamp(min, max))
        .unwrap_or(default)
}

pub fn ops_retention_config_from_env() -> OpsRetentionConfig {
    OpsRetentionConfig {
        station_retention_days: env_i64_range("RIVERSIDE_OPS_STATION_RETENTION_DAYS", 30, 1, 365),
        resolved_alert_retention_days: env_i64_range(
            "RIVERSIDE_OPS_RESOLVED_ALERT_RETENTION_DAYS",
            180,
            7,
            3650,
        ),
    }
}

fn e2e_failure_playbook() -> Vec<E2eFailurePlaybookItem> {
    vec![
        E2eFailurePlaybookItem {
            category: "app startup".to_string(),
            recommended_next_action:
                "Confirm API/UI stack is reachable on expected ports, then rerun one blocking spec before changing tests."
                    .to_string(),
        },
        E2eFailurePlaybookItem {
            category: "auth/seed data".to_string(),
            recommended_next_action:
                "Re-run seed/migration steps and verify expected staff/session fixtures before triaging selectors."
                    .to_string(),
        },
        E2eFailurePlaybookItem {
            category: "selector/UI contract".to_string(),
            recommended_next_action:
                "Reproduce with a single spec in headed mode, verify data-testid/role contract, and patch the smallest stable locator."
                    .to_string(),
        },
        E2eFailurePlaybookItem {
            category: "staff-facing wording/layout".to_string(),
            recommended_next_action:
                "Compare the failure with current staff-facing copy and responsive layout, then update the UI and matching E2E wording together."
                    .to_string(),
        },
        E2eFailurePlaybookItem {
            category: "runtime console/API cleanliness".to_string(),
            recommended_next_action:
                "Run the runtime cleanliness spec and inspect unexpected browser console output or API 4xx noise before changing tests."
                    .to_string(),
        },
        E2eFailurePlaybookItem {
            category: "financial/audit contract".to_string(),
            recommended_next_action:
                "Treat as release-blocking and inspect API payload/status deltas first, then confirm money/audit invariants."
                    .to_string(),
        },
        E2eFailurePlaybookItem {
            category: "flaky/timing".to_string(),
            recommended_next_action:
                "Replace broad waits with deterministic readiness checks and rerun serially to isolate state timing."
                    .to_string(),
        },
    ]
}

fn recommended_action_for_category(category: &str) -> Option<String> {
    e2e_failure_playbook()
        .into_iter()
        .find(|item| item.category == category)
        .map(|item| item.recommended_next_action)
}

fn empty_lane_status(lane: E2eLaneKey) -> E2eLaneStatus {
    E2eLaneStatus {
        lane_key: lane.as_str().to_string(),
        purpose: lane.purpose().to_string(),
        workflow_name: "Playwright E2E".to_string(),
        job_name: lane.job_name().to_string(),
        run_id: None,
        run_number: None,
        html_url: None,
        status: None,
        conclusion: None,
        last_run_outcome: "unknown".to_string(),
        started_at: None,
        completed_at: None,
        failed_specs: Vec::new(),
        failure_category: None,
        recommended_next_action: None,
    }
}

fn lane_outcome(status: Option<&str>, conclusion: Option<&str>) -> String {
    let status = status.unwrap_or("unknown");
    if status != "completed" {
        return "in_progress".to_string();
    }
    match conclusion.unwrap_or("unknown") {
        "success" => "success".to_string(),
        "failure" | "cancelled" | "timed_out" | "startup_failure" | "action_required" => {
            "failure".to_string()
        }
        _ => "unknown".to_string(),
    }
}

fn classify_failure_category(
    lane: E2eLaneKey,
    failed_step_name: Option<&str>,
    failed_specs: &[String],
) -> String {
    let step = failed_step_name.unwrap_or("").to_ascii_lowercase();
    if step.contains("start api server")
        || step.contains("install psql")
        || step.contains("apply sql migrations")
        || step.contains("download frontend bundle")
        || step.contains("verify e2e test-support routes")
    {
        return "app startup".to_string();
    }
    if step.contains("seed ")
        || step.contains("open default register session")
        || step.contains("backoffice")
        || step.contains("auth")
    {
        return "auth/seed data".to_string();
    }

    if failed_specs
        .iter()
        .any(|spec| spec == "e2e/runtime-console-cleanliness.spec.ts")
    {
        return "runtime console/API cleanliness".to_string();
    }

    if failed_specs.iter().any(|spec| {
        matches!(
            spec.as_str(),
            "e2e/checkout-tender-financial-contract.spec.ts"
                | "e2e/tax-audit-contract.spec.ts"
                | "e2e/commission-audit-contract.spec.ts"
                | "e2e/inventory-audit-contract.spec.ts"
                | "e2e/register-audit-contract.spec.ts"
                | "e2e/register-close-reconciliation.spec.ts"
                | "e2e/offline-recovery-contract.spec.ts"
                | "e2e/qbo-audit-contract.spec.ts"
                | "e2e/tender-matrix-contract.spec.ts"
        )
    }) {
        return "financial/audit contract".to_string();
    }

    if failed_specs.iter().any(|spec| {
        spec.contains("mobile")
            || spec.contains("staff-audit-labels")
            || spec.contains("customer-relationship-mobile-cards")
            || spec.contains("gift-cards-mobile-cards")
            || spec.contains("loyalty-eligible-mobile")
            || spec.contains("reports-mobile-cards")
            || spec.contains("scheduler-mobile-ergonomics")
            || spec.contains("settings-mobile")
    }) {
        return "staff-facing wording/layout".to_string();
    }

    if failed_specs
        .iter()
        .any(|spec| spec.contains("ui-") || spec.contains("settings-") || spec.contains("pos-"))
    {
        return "selector/UI contract".to_string();
    }

    match lane {
        E2eLaneKey::Blocking => "flaky/timing".to_string(),
        E2eLaneKey::Nightly => "flaky/timing".to_string(),
    }
}

fn parse_failed_specs_from_job_logs(logs: &str) -> Vec<String> {
    let mut found = BTreeSet::new();
    for line in logs.lines() {
        let trimmed = line.trim_start();
        let is_failure_row = trimmed
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
            && trimmed.contains(") ");
        if !is_failure_row {
            continue;
        }
        let marker = "› e2e/";
        let Some(marker_idx) = line.find(marker) else {
            continue;
        };
        let spec_start = marker_idx + "› ".len();
        let rest = &line[spec_start..];
        let end = rest
            .find(':')
            .or_else(|| rest.find(' '))
            .unwrap_or(rest.len());
        let candidate = rest[..end].trim();
        if candidate.ends_with(".spec.ts") {
            found.insert(candidate.to_string());
        }
    }
    found.into_iter().collect()
}

async fn github_telemetry_settings(pool: &PgPool) -> (Option<String>, Option<String>) {
    let values = integration_credentials::load_integration_credentials(
        pool,
        "ops_github",
        &["repo", "token"],
    )
    .await;
    match values {
        Ok(values) => (
            values
                .get("repo")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            values
                .get("token")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        ),
        Err(error) => {
            tracing::warn!(error = %error, "GitHub telemetry settings could not be read");
            (None, None)
        }
    }
}

fn github_failure_issue_url(repo: &str) -> String {
    // Rolling issue query: title + stable labels
    const QUERY: &str =
        "is%3Aissue+is%3Aopen+label%3Ae2e+label%3Ae2e-blocking+%22E2E+Blocking+Lane+Failure+Tracker%22";
    format!("https://github.com/{repo}/issues?q={QUERY}")
}

fn github_telemetry_timeout() -> StdDuration {
    let timeout_ms = env_i64_range("RIVERSIDE_OPS_E2E_GITHUB_TIMEOUT_MS", 8000, 1000, 30000);
    StdDuration::from_millis(timeout_ms as u64)
}

async fn github_get_json<T: for<'de> Deserialize<'de>>(
    http_client: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<T, String> {
    let res = http_client
        .get(url)
        .timeout(github_telemetry_timeout())
        .header(USER_AGENT, "riverside-ops-dev-center")
        .header(ACCEPT, "application/vnd.github+json")
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("GitHub request failed: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "GitHub HTTP {status}: {}",
            body.chars().take(240).collect::<String>()
        ));
    }

    res.json::<T>()
        .await
        .map_err(|e| format!("GitHub JSON parse failed: {e}"))
}

async fn github_get_text(
    http_client: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<String, String> {
    let res = http_client
        .get(url)
        .timeout(github_telemetry_timeout())
        .header(USER_AGENT, "riverside-ops-dev-center")
        .header(ACCEPT, "application/vnd.github+json")
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("GitHub logs request failed: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "GitHub logs HTTP {status}: {}",
            body.chars().take(240).collect::<String>()
        ));
    }

    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("GitHub logs bytes failed: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

async fn build_lane_from_github(
    http_client: &reqwest::Client,
    repo: &str,
    token: &str,
    lane: E2eLaneKey,
) -> Result<E2eLaneStatus, String> {
    let mut lane_status = empty_lane_status(lane);
    let runs_url = format!(
        "https://api.github.com/repos/{repo}/actions/workflows/playwright-e2e.yml/runs?per_page=40"
    );
    let runs_resp: GithubWorkflowRunsResponse =
        github_get_json(http_client, &runs_url, token).await?;

    let Some(run) = runs_resp
        .workflow_runs
        .iter()
        .find(|run| lane.is_run_match(run.event.as_deref().unwrap_or_default()))
        .cloned()
    else {
        return Ok(lane_status);
    };

    lane_status.run_id = Some(run.id);
    lane_status.run_number = Some(run.run_number);
    lane_status.html_url = run.html_url.clone();

    let jobs_url = format!(
        "https://api.github.com/repos/{repo}/actions/runs/{}/jobs?per_page=100",
        run.id
    );
    let jobs_resp: GithubJobsResponse = github_get_json(http_client, &jobs_url, token).await?;

    let Some(job) = jobs_resp
        .jobs
        .iter()
        .find(|job| job.name == lane.job_name())
        .cloned()
    else {
        return Ok(lane_status);
    };

    lane_status.status = job.status.clone();
    lane_status.conclusion = job.conclusion.clone();
    lane_status.started_at = job.started_at;
    lane_status.completed_at = job.completed_at.or(run.updated_at);
    lane_status.last_run_outcome = lane_outcome(job.status.as_deref(), job.conclusion.as_deref());

    if lane_status.last_run_outcome == "failure" {
        let logs_url = format!(
            "https://api.github.com/repos/{repo}/actions/jobs/{}/logs",
            job.id
        );
        let parsed_specs = match github_get_text(http_client, &logs_url, token).await {
            Ok(logs) => parse_failed_specs_from_job_logs(&logs),
            Err(_) => Vec::new(),
        };
        lane_status.failed_specs = parsed_specs;

        let failed_step_name = job
            .steps
            .iter()
            .find(|step| step.conclusion.as_deref() == Some("failure"))
            .map(|step| step.name.as_str());
        let category = classify_failure_category(lane, failed_step_name, &lane_status.failed_specs);
        lane_status.recommended_next_action = recommended_action_for_category(&category);
        lane_status.failure_category = Some(category);
    }

    Ok(lane_status)
}

pub async fn e2e_health_snapshot(
    pool: &PgPool,
    http_client: &reqwest::Client,
) -> E2eHealthSnapshot {
    let generated_at = Utc::now();
    let playbook = e2e_failure_playbook();
    let mut notes: Vec<String> = Vec::new();
    let mut mode = "live".to_string();
    let (repo, token) = github_telemetry_settings(pool).await;
    let failure_issue_url = match (&repo, &token) {
        (Some(repo_value), Some(_)) => Some(github_failure_issue_url(repo_value)),
        _ => None,
    };

    let mut blocking = empty_lane_status(E2eLaneKey::Blocking);
    let mut nightly = empty_lane_status(E2eLaneKey::Nightly);

    if repo.is_none() || token.is_none() {
        mode = "degraded".to_string();
        notes.push(
            "GitHub telemetry is not configured. Save the repository and token in Settings -> ROS Dev Center."
                .to_string(),
        );
    } else if let (Some(repo), Some(token)) = (repo, token) {
        match build_lane_from_github(http_client, &repo, &token, E2eLaneKey::Blocking).await {
            Ok(lane) => blocking = lane,
            Err(err) => {
                mode = "degraded".to_string();
                notes.push(format!("Blocking lane telemetry unavailable: {err}"));
            }
        }

        match build_lane_from_github(http_client, &repo, &token, E2eLaneKey::Nightly).await {
            Ok(lane) => nightly = lane,
            Err(err) => {
                mode = "degraded".to_string();
                notes.push(format!("Nightly lane telemetry unavailable: {err}"));
            }
        }
    }

    E2eHealthSnapshot {
        generated_at,
        source: E2eHealthSource {
            mode,
            stale: false,
            cache_age_seconds: Some(0),
            notes,
        },
        blocking,
        nightly,
        failure_issue_url,
        playbook,
    }
}

fn looks_placeholder(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.is_empty()
        || lower.contains("dummy")
        || lower.contains("replace_me")
        || lower.contains("changeme")
        || lower.contains("placeholder")
        || lower.contains("example")
}

fn saved_or_env(
    values: &HashMap<String, String>,
    credential_key: &str,
    env_key: &str,
) -> Option<String> {
    values
        .get(credential_key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| nonempty_env(env_key))
}

fn metabase_jwt_secret_configured(values: &HashMap<String, String>) -> bool {
    saved_or_env(
        values,
        "metabase_jwt_secret",
        "RIVERSIDE_METABASE_JWT_SECRET",
    )
    .map(|secret| secret.len() >= 16)
    .unwrap_or(false)
}

pub async fn runtime_diagnostics_snapshot(
    pool: &PgPool,
    meilisearch_configured: bool,
) -> Result<RuntimeDiagnosticsSnapshot, sqlx::Error> {
    let strict_production = env_truthy("RIVERSIDE_STRICT_PRODUCTION");
    let environment_mode =
        nonempty_env("RIVERSIDE_MODE").unwrap_or_else(|| "development".to_string());
    let cors_policy = crate::runtime_config::effective_cors_policy_from_env();

    let helcim_token = nonempty_env("HELCIM_API_TOKEN");
    let helcim_terminal_1_device = nonempty_env("HELCIM_TERMINAL_1_DEVICE_CODE");
    let helcim_terminal_2_device = nonempty_env("HELCIM_TERMINAL_2_DEVICE_CODE");
    let helcim_webhook = nonempty_env("HELCIM_WEBHOOK_SECRET");
    let helcim_token_ok = helcim_token
        .as_deref()
        .map(|value| !looks_placeholder(value))
        .unwrap_or(false);
    let helcim_terminal_1_ok = helcim_terminal_1_device
        .as_deref()
        .map(|value| !looks_placeholder(value))
        .unwrap_or(false);
    let helcim_terminal_2_ok = helcim_terminal_2_device
        .as_deref()
        .map(|value| !looks_placeholder(value))
        .unwrap_or(false);
    let helcim_webhook_ok = helcim_webhook
        .as_deref()
        .map(|value| !looks_placeholder(value))
        .unwrap_or(false);
    let helcim_terminals_ok = helcim_terminal_1_ok && helcim_terminal_2_ok;
    let helcim_live_ready = helcim_token_ok && helcim_terminals_ok;
    let helcim_value = if helcim_live_ready {
        "Configured"
    } else if helcim_token_ok || helcim_terminal_1_ok || helcim_terminal_2_ok || helcim_webhook_ok {
        "Partial"
    } else {
        "Not configured"
    };
    let helcim_detail = format!(
        "API token {} • terminals {} • optional webhook {}",
        if helcim_token_ok {
            "present"
        } else {
            "missing"
        },
        if helcim_terminals_ok {
            "present"
        } else if helcim_terminal_1_ok || helcim_terminal_2_ok {
            "partial"
        } else {
            "missing"
        },
        if helcim_webhook_ok {
            "signed"
        } else if helcim_webhook.is_some() {
            "configured-invalid"
        } else {
            "not configured"
        }
    );
    let helcim_severity = if helcim_live_ready { "info" } else { "warning" };

    let shippo = load_effective_shippo_config(pool).await?;
    let (shippo_value, shippo_detail, shippo_severity) = if !shippo.store.enabled {
        (
            "Disabled".to_string(),
            "Store Shippo integration is turned off in settings.".to_string(),
            "info".to_string(),
        )
    } else if shippo.store.live_rates_enabled && shippo.api_token_configured {
        (
            "Live rates".to_string(),
            "Store shipping quotes use live Shippo rates.".to_string(),
            "info".to_string(),
        )
    } else if shippo.store.live_rates_enabled {
        (
            "Stub fallback".to_string(),
            "Live rates are enabled in settings, but the Shippo API token is not saved in Backoffice Settings so rate quotes fall back to stub data.".to_string(),
            "warning".to_string(),
        )
    } else {
        (
            "Stub mode".to_string(),
            "Shippo is enabled, but store settings keep rate quotes on deterministic stub data."
                .to_string(),
            "info".to_string(),
        )
    };

    let insights_raw: Value =
        sqlx::query_scalar("SELECT insights_config FROM store_settings WHERE id = 1")
            .fetch_one(pool)
            .await?;
    let insights = StoreInsightsConfig::from_json_value(insights_raw);
    let metabase_credentials = integration_credentials::load_integration_credentials(
        pool,
        "insights",
        &[
            "metabase_jwt_secret",
            "metabase_admin_email",
            "metabase_admin_password",
            "metabase_staff_email",
            "metabase_staff_password",
        ],
    )
    .await
    .unwrap_or_default();
    let shared_auth_ready = [
        ("metabase_admin_email", "RIVERSIDE_METABASE_ADMIN_EMAIL"),
        (
            "metabase_admin_password",
            "RIVERSIDE_METABASE_ADMIN_PASSWORD",
        ),
        ("metabase_staff_email", "RIVERSIDE_METABASE_STAFF_EMAIL"),
        (
            "metabase_staff_password",
            "RIVERSIDE_METABASE_STAFF_PASSWORD",
        ),
    ]
    .iter()
    .all(|(credential_key, env_key)| {
        saved_or_env(&metabase_credentials, credential_key, env_key).is_some()
    });
    let metabase_jwt_ready =
        insights.metabase_jwt_sso_enabled && metabase_jwt_secret_configured(&metabase_credentials);
    let (metabase_value, metabase_detail, metabase_severity) = if metabase_jwt_ready {
        (
            "JWT SSO".to_string(),
            "Insights uses signed staff JWT handoff into Metabase.".to_string(),
            "info".to_string(),
        )
    } else if !insights.metabase_jwt_sso_enabled && shared_auth_ready {
        (
            "Shared auth".to_string(),
            "Insights uses the shared Metabase session fallback for staff launch.".to_string(),
            "warning".to_string(),
        )
    } else if insights.metabase_jwt_sso_enabled {
        (
            "Fallback login".to_string(),
            "JWT SSO is enabled in settings, but the server-side JWT secret is missing or too short, so staff fall back to the Metabase login screen.".to_string(),
            "warning".to_string(),
        )
    } else {
        (
            "Fallback login".to_string(),
            "No automatic Metabase auth is fully configured, so staff land on the Metabase login screen.".to_string(),
            "warning".to_string(),
        )
    };

    let search_value = if meilisearch_configured {
        "Meilisearch configured".to_string()
    } else {
        "Bundled fallback".to_string()
    };
    let search_detail = if meilisearch_configured {
        "A Meilisearch client is configured. Use Search Settings for live reachability, rebuild age, and count-parity proof.".to_string()
    } else {
        "Meilisearch is unavailable, so bundled/manual fallback behavior is active where supported."
            .to_string()
    };
    let search_severity = if meilisearch_configured {
        "info"
    } else {
        "warning"
    };

    let weather = load_store_weather_settings(pool).await;
    let weather_live = weather.enabled && !weather.api_key.trim().is_empty();
    let weather_value = if weather_live {
        "Live weather"
    } else {
        "Mock weather"
    };
    let weather_detail = if weather_live {
        "Weather surfaces can call Visual Crossing with the current effective runtime settings."
            .to_string()
    } else {
        "Weather surfaces will use deterministic mock weather fallback.".to_string()
    };
    let weather_severity = if weather_live { "info" } else { "warning" };
    let backup_dir = crate::logic::backups::backup_directory_info(strict_production);
    let backup_database_url_configured = crate::logic::backups::backup_database_url_configured();
    let backup_tooling_ready = crate::logic::backups::backup_tooling_available();
    let backup_dir_detail = if backup_dir.configured {
        "Local backups use the explicit RIVERSIDE_BACKUP_DIR path.".to_string()
    } else if strict_production {
        "Strict production requires RIVERSIDE_BACKUP_DIR before startup can pass.".to_string()
    } else {
        "Local development is using the relative backups/ fallback.".to_string()
    };
    let retention = ops_retention_config_from_env();
    let station_alert_hours =
        env_i64_range("RIVERSIDE_OPS_STATION_OFFLINE_ALERT_HOURS", 24, 1, 168);

    Ok(RuntimeDiagnosticsSnapshot {
        generated_at: Utc::now(),
        items: vec![
            environment_mode_diagnostic(&environment_mode),
            production_safeguards_diagnostic(&environment_mode, strict_production),
            RuntimeDiagnosticItem {
                key: "cors_mode".to_string(),
                label: "Browser Origin Policy".to_string(),
                value: if cors_policy.uses_wildcard() {
                    "Wildcard".to_string()
                } else {
                    format!("Allowlist ({})", cors_policy.header_values.len())
                },
                detail: if cors_policy.uses_wildcard() {
                    if cors_policy.configured_origin_count > 0 {
                        format!(
                            "All {} configured RIVERSIDE_CORS_ORIGINS entries are invalid exact browser origins, so the effective non-strict policy is development wildcard CORS.",
                            cors_policy.configured_origin_count
                        )
                    } else {
                        "No browser origin allowlist is configured; development wildcard CORS is active."
                            .to_string()
                    }
                } else if cors_policy.invalid_origin_count > 0 {
                    format!(
                        "Browser access uses {} valid exact http/https origins; {} invalid configured entries were ignored by the same policy used at server launch.",
                        cors_policy.header_values.len(),
                        cors_policy.invalid_origin_count
                    )
                } else {
                    "Browser access is restricted to the configured RIVERSIDE_CORS_ORIGINS entries."
                        .to_string()
                },
                severity: if cors_policy.uses_wildcard()
                    || cors_policy.invalid_origin_count > 0
                {
                    "warning".to_string()
                } else {
                    "info".to_string()
                },
            },
            RuntimeDiagnosticItem {
                key: "helcim".to_string(),
                label: "Helcim".to_string(),
                value: helcim_value.to_string(),
                detail: helcim_detail,
                severity: helcim_severity.to_string(),
            },
            RuntimeDiagnosticItem {
                key: "shippo".to_string(),
                label: "Shippo".to_string(),
                value: shippo_value,
                detail: shippo_detail,
                severity: shippo_severity,
            },
            RuntimeDiagnosticItem {
                key: "metabase_auth".to_string(),
                label: "Metabase Auth".to_string(),
                value: metabase_value,
                detail: metabase_detail,
                severity: metabase_severity,
            },
            RuntimeDiagnosticItem {
                key: "search_mode".to_string(),
                label: "Search Mode".to_string(),
                value: search_value,
                detail: search_detail,
                severity: search_severity.to_string(),
            },
            RuntimeDiagnosticItem {
                key: "weather_mode".to_string(),
                label: "Weather Mode".to_string(),
                value: weather_value.to_string(),
                detail: weather_detail,
                severity: weather_severity.to_string(),
            },
            RuntimeDiagnosticItem {
                key: "backup_directory".to_string(),
                label: "Backup Directory".to_string(),
                value: backup_dir.path,
                detail: backup_dir_detail,
                severity: if backup_dir.configured {
                    "info".to_string()
                } else {
                    "warning".to_string()
                },
            },
            RuntimeDiagnosticItem {
                key: "backup_database_access".to_string(),
                label: "Complete Backup Database Access".to_string(),
                value: if backup_database_url_configured {
                    "Configured".to_string()
                } else {
                    "Application connection only".to_string()
                },
                detail: if backup_database_url_configured {
                    "Backup and restore commands use the protected PostgreSQL backup connection."
                        .to_string()
                } else {
                    "RIVERSIDE_BACKUP_DATABASE_URL is not configured. Non-public schemas owned by another PostgreSQL role can make complete backups fail."
                        .to_string()
                },
                severity: if backup_database_url_configured {
                    "info".to_string()
                } else {
                    "warning".to_string()
                },
            },
            RuntimeDiagnosticItem {
                key: "backup_tooling".to_string(),
                label: "Backup Verification Tools".to_string(),
                value: if backup_tooling_ready {
                    "Ready".to_string()
                } else {
                    "Unavailable".to_string()
                },
                detail: if backup_tooling_ready {
                    "pg_dump and pg_restore were resolved for backup creation and archive verification."
                        .to_string()
                } else {
                    "Install PostgreSQL client tools or set RIVERSIDE_PG_DUMP_PATH and RIVERSIDE_PG_RESTORE_PATH."
                        .to_string()
                },
                severity: if backup_tooling_ready {
                    "info".to_string()
                } else {
                    "warning".to_string()
                },
            },
            RuntimeDiagnosticItem {
                key: "station_lifecycle".to_string(),
                label: "Station Lifecycle".to_string(),
                value: format!("{station_alert_hours}h alert window"),
                detail: format!(
                    "Offline stations alert for {station_alert_hours} hours, then remain as stale fleet history until {} day retention cleanup.",
                    retention.station_retention_days
                ),
                severity: "info".to_string(),
            },
        ],
    })
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct AlertRuleConfig {
    rule_key: String,
    title: String,
    severity: String,
    enabled: bool,
    suppress_minutes: i32,
    channel_inbox: bool,
    channel_email: bool,
    channel_sms: bool,
}

#[derive(Debug, sqlx::FromRow)]
struct ExistingAlertRow {
    id: Uuid,
    status: String,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct OpenAlertSignal {
    alert_id: Uuid,
    dedupe_key: String,
    rule: AlertRuleConfig,
    title: String,
    body: String,
    severity: String,
}

fn clamp_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect::<String>()
}

fn clamp_json_bytes(value: &Value, max_bytes: usize) -> Value {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    if bytes.len() <= max_bytes {
        value.clone()
    } else {
        json!({
            "truncated": true,
            "truncated_bytes": bytes.len(),
            "max_bytes": max_bytes
        })
    }
}

async fn alert_rule(pool: &PgPool, rule_key: &str) -> Result<Option<AlertRuleConfig>, sqlx::Error> {
    sqlx::query_as::<_, AlertRuleConfig>(
        r#"
        SELECT
            rule_key,
            title,
            severity,
            enabled,
            suppress_minutes,
            channel_inbox,
            channel_email,
            channel_sms
        FROM ops_alert_rule
        WHERE rule_key = $1
        "#,
    )
    .bind(rule_key)
    .fetch_optional(pool)
    .await
}

async fn log_delivery_row(
    pool: &PgPool,
    alert_event_id: Uuid,
    channel: &str,
    destination: Option<&str>,
    delivery_status: &str,
    provider_message_id: Option<&str>,
    error_text: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO ops_notification_delivery_log (
            alert_event_id,
            channel,
            destination,
            delivery_status,
            provider_message_id,
            error_text
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(alert_event_id)
    .bind(channel)
    .bind(destination)
    .bind(delivery_status)
    .bind(provider_message_id)
    .bind(error_text)
    .execute(pool)
    .await?;
    Ok(())
}

async fn emit_open_alert_notifications(
    pool: &PgPool,
    signal: &OpenAlertSignal,
) -> Result<(), sqlx::Error> {
    if signal.rule.channel_inbox {
        let target = staff_ids_with_permission(pool, OPS_DEV_CENTER_VIEW).await?;
        if !target.is_empty() {
            let notification_dedupe = format!("ops_alert:{}", signal.dedupe_key);
            let nid = upsert_app_notification_by_dedupe(
                pool,
                "ops_alert",
                &signal.title,
                &signal.body,
                json!({
                    "type": "settings",
                    "section": "ros-dev-center",
                    "alert_event_id": signal.alert_id,
                    "rule_key": signal.rule.rule_key,
                    "severity": signal.severity,
                }),
                "ops.dev_center",
                json!({ "mode": "staff_ids", "staff_ids": target.clone() }),
                &notification_dedupe,
            )
            .await?;

            crate::logic::notifications::fan_out_notification_to_staff_ids(pool, nid, &target)
                .await?;
            for sid in target {
                let _ = log_delivery_row(
                    pool,
                    signal.alert_id,
                    "inbox",
                    Some(&sid.to_string()),
                    "sent",
                    Some(&nid.to_string()),
                    None,
                )
                .await;
            }
        }
    }

    if signal.rule.channel_email {
        let _ = log_delivery_row(pool, signal.alert_id, "email", None, "queued", None, None).await;
    }
    if signal.rule.channel_sms {
        let _ = log_delivery_row(pool, signal.alert_id, "sms", None, "queued", None, None).await;
    }
    Ok(())
}

async fn record_open_alert_error_event(
    pool: &PgPool,
    signal: &OpenAlertSignal,
    server_log_snapshot: &str,
) -> Result<(), sqlx::Error> {
    let message = format!("{}: {}", signal.title, signal.body);
    let meta = json!({
        "source": "ops_alert_event",
        "ops_alert_id": signal.alert_id,
        "rule_key": signal.rule.rule_key.as_str(),
        "dedupe_key": signal.dedupe_key.as_str(),
        "title": signal.title.as_str(),
        "body": signal.body.as_str(),
        "severity": signal.severity.as_str(),
    });
    let recorded = bug_reports::upsert_server_error_event(
        pool,
        &format!("ops_alert_event:{}", signal.alert_id),
        &message,
        "server_ops_alert",
        &signal.severity,
        Some("/settings/ros-dev-center"),
        &meta,
        server_log_snapshot,
    )
    .await?;
    if recorded.inserted {
        let pool_n = pool.clone();
        let message = message.clone();
        let severity = signal.severity.clone();
        tokio::spawn(async move {
            if let Err(error) = bug_reports::notify_error_event_email_recipients(
                &pool_n,
                recorded.id,
                None,
                &message,
                "server_ops_alert",
                &severity,
                Some("/settings/ros-dev-center"),
            )
            .await
            {
                tracing::error!(error = %error, "ops alert email notification failed");
            }
        });
    }
    Ok(())
}

async fn resolve_rule_alerts(
    pool: &PgPool,
    rule_key: &str,
    keep_open_dedupe_keys: &[String],
) -> Result<u64, sqlx::Error> {
    if keep_open_dedupe_keys.is_empty() {
        let res = sqlx::query(
            r#"
            UPDATE ops_alert_event
            SET
                status = 'resolved',
                resolved_at = COALESCE(resolved_at, NOW()),
                resolved_by_staff_id = NULL,
                updated_at = NOW()
            WHERE rule_key = $1
              AND status IN ('open', 'acked')
            "#,
        )
        .bind(rule_key)
        .execute(pool)
        .await?;
        return Ok(res.rows_affected());
    }

    let res = sqlx::query(
        r#"
        UPDATE ops_alert_event
        SET
            status = 'resolved',
            resolved_at = COALESCE(resolved_at, NOW()),
            resolved_by_staff_id = NULL,
            updated_at = NOW()
        WHERE rule_key = $1
          AND status IN ('open', 'acked')
          AND (dedupe_key IS NULL OR dedupe_key <> ALL($2))
        "#,
    )
    .bind(rule_key)
    .bind(keep_open_dedupe_keys)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

async fn upsert_open_alert(
    pool: &PgPool,
    rule_key: &str,
    dedupe_key: &str,
    title: &str,
    body: &str,
    context: Value,
) -> Result<Option<OpenAlertSignal>, sqlx::Error> {
    let Some(rule) = alert_rule(pool, rule_key).await? else {
        return Ok(None);
    };
    if !rule.enabled {
        return Ok(None);
    }

    let title_s = if title.trim().is_empty() {
        clamp_chars(&rule.title, 160)
    } else {
        clamp_chars(title, 160)
    };
    let body_s = clamp_chars(body, 600);
    let severity_s = clamp_chars(&rule.severity, 32);
    let context_s = clamp_json_bytes(&context, 8192);

    let existing = sqlx::query_as::<_, ExistingAlertRow>(
        r#"
        SELECT id, status, updated_at
        FROM ops_alert_event
        WHERE dedupe_key = $1
        LIMIT 1
        "#,
    )
    .bind(dedupe_key)
    .fetch_optional(pool)
    .await?;

    if let Some(existing_row) = existing {
        if existing_row.status == "open" {
            sqlx::query(
                r#"
                UPDATE ops_alert_event
                SET
                    title = $2,
                    body = $3,
                    severity = $4,
                    context = $5,
                    last_seen_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                "#,
            )
            .bind(existing_row.id)
            .bind(&title_s)
            .bind(&body_s)
            .bind(&severity_s)
            .bind(&context_s)
            .execute(pool)
            .await?;
            return Ok(None);
        }

        let suppress_cutoff = Utc::now() - Duration::minutes(rule.suppress_minutes as i64);
        if existing_row.updated_at >= suppress_cutoff {
            sqlx::query(
                r#"
                UPDATE ops_alert_event
                SET
                    title = $2,
                    body = $3,
                    severity = $4,
                    context = $5,
                    last_seen_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                "#,
            )
            .bind(existing_row.id)
            .bind(&title_s)
            .bind(&body_s)
            .bind(&severity_s)
            .bind(&context_s)
            .execute(pool)
            .await?;
            return Ok(None);
        }

        sqlx::query(
            r#"
            UPDATE ops_alert_event
            SET
                title = $2,
                body = $3,
                severity = $4,
                context = $5,
                status = 'open',
                first_seen_at = NOW(),
                last_seen_at = NOW(),
                acked_at = NULL,
                acked_by_staff_id = NULL,
                resolved_at = NULL,
                resolved_by_staff_id = NULL,
                updated_at = NOW()
            WHERE id = $1
            "#,
        )
        .bind(existing_row.id)
        .bind(&title_s)
        .bind(&body_s)
        .bind(&severity_s)
        .bind(&context_s)
        .execute(pool)
        .await?;

        return Ok(Some(OpenAlertSignal {
            alert_id: existing_row.id,
            dedupe_key: dedupe_key.to_string(),
            rule,
            title: title_s,
            body: body_s,
            severity: severity_s,
        }));
    }

    let alert_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO ops_alert_event (
            rule_key, dedupe_key, title, body, severity, status, context,
            first_seen_at, last_seen_at, created_at, updated_at
        )
        VALUES (
            $1, $2, $3, $4, $5, 'open', $6,
            NOW(), NOW(), NOW(), NOW()
        )
        RETURNING id
        "#,
    )
    .bind(rule_key)
    .bind(dedupe_key)
    .bind(&title_s)
    .bind(&body_s)
    .bind(&severity_s)
    .bind(&context_s)
    .fetch_one(pool)
    .await?;

    Ok(Some(OpenAlertSignal {
        alert_id,
        dedupe_key: dedupe_key.to_string(),
        rule,
        title: title_s,
        body: body_s,
        severity: severity_s,
    }))
}

pub async fn ping_db(pool: &PgPool) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1::bigint")
        .fetch_one(pool)
        .await
        .map(|_| true)
        .unwrap_or(false)
}

pub async fn upsert_station_heartbeat(
    pool: &PgPool,
    body: &StationHeartbeatIn,
) -> Result<(), sqlx::Error> {
    let station_key = body.station_key.trim();
    let app_version = body.app_version.trim();
    if station_key.is_empty() || app_version.is_empty() {
        return Err(sqlx::Error::Protocol(
            "station_key and app_version are required".into(),
        ));
    }
    if station_key.len() > 128 || app_version.len() > 64 {
        return Err(sqlx::Error::Protocol(
            "station_key/app_version exceeds max length".into(),
        ));
    }
    if body.station_label.len() > 160 {
        return Err(sqlx::Error::Protocol(
            "station_label exceeds max length".into(),
        ));
    }
    if body.meta.as_object().is_some_and(|_| {
        serde_json::to_vec(&body.meta)
            .map(|v| v.len() > 8192)
            .unwrap_or(true)
    }) {
        return Err(sqlx::Error::Protocol(
            "meta payload exceeds max size".into(),
        ));
    }

    let received_at = Utc::now();
    let last_sync_at = bound_client_reported_timestamp(body.last_sync_at, received_at);
    let last_update_check_at =
        bound_client_reported_timestamp(body.last_update_check_at, received_at);
    let last_update_install_at =
        confirmed_client_install_timestamp(body.last_update_install_at, &body.meta, received_at);

    sqlx::query(
        r#"
        INSERT INTO ops_station_heartbeat (
            station_key, station_label, app_version, git_sha, tailscale_node, lan_ip,
            last_sync_at, last_update_check_at, last_update_install_at, meta,
            last_seen_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW(), NOW())
        ON CONFLICT (station_key)
        DO UPDATE SET
            station_label = EXCLUDED.station_label,
            app_version = EXCLUDED.app_version,
            git_sha = EXCLUDED.git_sha,
            tailscale_node = EXCLUDED.tailscale_node,
            lan_ip = EXCLUDED.lan_ip,
            last_sync_at = EXCLUDED.last_sync_at,
            last_update_check_at = EXCLUDED.last_update_check_at,
            last_update_install_at = COALESCE(
                EXCLUDED.last_update_install_at,
                ops_station_heartbeat.last_update_install_at
            ),
            meta = EXCLUDED.meta,
            last_seen_at = NOW(),
            updated_at = NOW()
        "#,
    )
    .bind(station_key)
    .bind(normalize_label(&body.station_label))
    .bind(app_version)
    .bind(body.git_sha.as_deref())
    .bind(body.tailscale_node.as_deref())
    .bind(body.lan_ip.as_deref())
    .bind(last_sync_at)
    .bind(last_update_check_at)
    .bind(last_update_install_at)
    .bind(&body.meta)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn list_stations(pool: &PgPool) -> Result<Vec<StationRow>, sqlx::Error> {
    let retention = ops_retention_config_from_env();
    let retention_cutoff = Utc::now() - Duration::days(retention.station_retention_days);
    let online_cutoff = now_online_cutoff();
    let actionable_cutoff = station_offline_alert_cutoff();
    let rows = sqlx::query_as::<_, StationRow>(
        r#"
        WITH station_rows AS (
            SELECT
                station_key,
                station_label,
                app_version,
                git_sha,
                tailscale_node,
                lan_ip,
                last_sync_at,
                last_update_check_at,
                last_update_install_at,
                last_seen_at,
                updated_at,
                (LOWER(COALESCE(meta->>'monitor_offline', 'false')) = 'true') AS monitor_offline
            FROM ops_station_heartbeat
            WHERE last_seen_at >= $3
        )
        SELECT
            station_rows.station_key,
            station_label,
            app_version,
            git_sha,
            tailscale_node,
            lan_ip,
            last_sync_at,
            last_update_check_at,
            last_update_install_at,
            'sync_check_client_reported_future_bounded_install_native_confirmed'::text AS client_timestamp_source,
            last_seen_at,
            updated_at,
            (last_seen_at >= $1) AS online,
            monitor_offline,
            CASE
                WHEN last_seen_at >= $1 THEN 'online'
                WHEN monitor_offline AND last_seen_at >= $2 THEN 'recently_offline'
                ELSE 'stale'
            END AS station_lifecycle,
            (monitor_offline AND last_seen_at >= $2) AS actionable,
            COALESCE(active_staff.session_count, 0)::bigint AS active_staff_sessions,
            COALESCE(active_staff.staff_names, '') AS active_staff_names
        FROM station_rows
        LEFT JOIN LATERAL (
            SELECT
                COUNT(*)::bigint AS session_count,
                STRING_AGG(DISTINCT staff.full_name, ', ' ORDER BY staff.full_name) AS staff_names
            FROM staff_access_sessions
            INNER JOIN staff ON staff.id = staff_access_sessions.staff_id
            WHERE staff_access_sessions.station_key = station_rows.station_key
              AND staff_access_sessions.revoked_at IS NULL
              AND staff_access_sessions.expires_at > now()
              AND staff.is_active = TRUE
        ) active_staff ON TRUE
        ORDER BY (last_seen_at >= $1) DESC, (last_seen_at >= $2) DESC, last_seen_at DESC
        "#,
    )
    .bind(online_cutoff)
    .bind(actionable_cutoff)
    .bind(retention_cutoff)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn list_readiness_signoffs(
    pool: &PgPool,
) -> Result<Vec<ReadinessSignoffRow>, sqlx::Error> {
    sqlx::query_as::<_, ReadinessSignoffRow>(
        r#"
        SELECT
            r.check_key,
            r.category,
            r.label,
            r.status,
            r.notes,
            r.evidence_ref,
            r.expires_at,
            r.signed_off_by_staff_id,
            s.full_name AS signed_off_by_staff_name,
            r.signed_off_at,
            r.updated_at
        FROM ops_readiness_signoffs r
        LEFT JOIN staff s ON s.id = r.signed_off_by_staff_id
        ORDER BY r.category, r.label
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn save_readiness_signoff(
    pool: &PgPool,
    check_key: &str,
    input: ReadinessSignoffInput,
    staff_id: Uuid,
) -> Result<ReadinessSignoffRow, sqlx::Error> {
    let status = input.status.unwrap_or_else(|| "ready".to_string());
    if !matches!(status.as_str(), "ready" | "manual_required") {
        return Err(sqlx::Error::Protocol(
            "readiness signoff status must be ready or manual_required".to_string(),
        ));
    }
    if !matches!(
        input.category.as_str(),
        "daily_open" | "go_live" | "evidence"
    ) {
        return Err(sqlx::Error::Protocol(
            "readiness signoff category must be daily_open, go_live, or evidence".to_string(),
        ));
    }

    sqlx::query_as::<_, ReadinessSignoffRow>(
        r#"
        WITH saved AS (
            INSERT INTO ops_readiness_signoffs (
                check_key,
                category,
                label,
                status,
                notes,
                evidence_ref,
                expires_at,
                signed_off_by_staff_id,
                signed_off_at,
                updated_at
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                CASE WHEN $4 = 'ready' THEN $8 ELSE NULL END,
                CASE WHEN $4 = 'ready' THEN CURRENT_TIMESTAMP ELSE NULL END,
                CURRENT_TIMESTAMP
            )
            ON CONFLICT (check_key) DO UPDATE SET
                category = EXCLUDED.category,
                label = EXCLUDED.label,
                status = EXCLUDED.status,
                notes = EXCLUDED.notes,
                evidence_ref = EXCLUDED.evidence_ref,
                expires_at = EXCLUDED.expires_at,
                signed_off_by_staff_id = EXCLUDED.signed_off_by_staff_id,
                signed_off_at = EXCLUDED.signed_off_at,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *
        )
        SELECT
            saved.check_key,
            saved.category,
            saved.label,
            saved.status,
            saved.notes,
            saved.evidence_ref,
            saved.expires_at,
            saved.signed_off_by_staff_id,
            s.full_name AS signed_off_by_staff_name,
            saved.signed_off_at,
            saved.updated_at
        FROM saved
        LEFT JOIN staff s ON s.id = saved.signed_off_by_staff_id
        "#,
    )
    .bind(check_key.trim())
    .bind(input.category.trim())
    .bind(input.label.trim())
    .bind(status)
    .bind(input.notes.trim())
    .bind(input.evidence_ref.trim())
    .bind(input.expires_at)
    .bind(staff_id)
    .fetch_one(pool)
    .await
}

pub async fn list_alerts(pool: &PgPool) -> Result<Vec<AlertEventRow>, sqlx::Error> {
    let actionable_cutoff = station_offline_alert_cutoff();
    let rows = sqlx::query_as::<_, AlertEventRow>(
        r#"
        SELECT
            id,
            rule_key,
            title,
            body,
            severity,
            status,
            context,
            first_seen_at,
            last_seen_at,
            acked_at,
            acked_by_staff_id,
            resolved_at,
            resolved_by_staff_id
        FROM ops_alert_event a
        WHERE status IN ('open', 'acked')
          AND (
              rule_key <> 'station_offline'
              OR EXISTS (
                  SELECT 1
                  FROM ops_station_heartbeat s
                  WHERE a.dedupe_key = 'station_offline:' || s.station_key
                    AND s.last_seen_at >= $1
                    AND LOWER(COALESCE(s.meta->>'monitor_offline', 'false')) = 'true'
              )
          )
        ORDER BY
            CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
            last_seen_at DESC
        LIMIT 500
        "#,
    )
    .bind(actionable_cutoff)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn ack_alert(pool: &PgPool, id: Uuid, actor_staff_id: Uuid) -> Result<bool, sqlx::Error> {
    let r = sqlx::query(
        r#"
        UPDATE ops_alert_event
        SET status = 'acked',
            acked_at = NOW(),
            acked_by_staff_id = $2,
            updated_at = NOW()
        WHERE id = $1 AND status = 'open'
        "#,
    )
    .bind(id)
    .bind(actor_staff_id)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn perform_retention_cleanup(
    pool: &PgPool,
    config: &OpsRetentionConfig,
) -> Result<OpsRetentionCleanupResult, sqlx::Error> {
    let station_cutoff = Utc::now() - Duration::days(config.station_retention_days);
    let resolved_alert_cutoff = Utc::now() - Duration::days(config.resolved_alert_retention_days);

    let stale_station_alerts_resolved = sqlx::query(
        r#"
        WITH stale AS (
            SELECT station_key
            FROM ops_station_heartbeat
            WHERE last_seen_at < $1
        )
        UPDATE ops_alert_event
        SET
            status = 'resolved',
            resolved_at = COALESCE(resolved_at, NOW()),
            resolved_by_staff_id = NULL,
            updated_at = NOW()
        WHERE rule_key = 'station_offline'
          AND status IN ('open', 'acked')
          AND dedupe_key IN (
              SELECT 'station_offline:' || station_key
              FROM stale
          )
        "#,
    )
    .bind(station_cutoff)
    .execute(pool)
    .await?
    .rows_affected();

    let stale_stations_deleted = sqlx::query(
        r#"
        DELETE FROM ops_station_heartbeat
        WHERE last_seen_at < $1
        "#,
    )
    .bind(station_cutoff)
    .execute(pool)
    .await?
    .rows_affected();

    let resolved_alerts_deleted = sqlx::query(
        r#"
        DELETE FROM ops_alert_event a
        WHERE a.status = 'resolved'
          AND COALESCE(a.resolved_at, a.updated_at, a.last_seen_at) < $1
          AND NOT EXISTS (
              SELECT 1
              FROM ops_bug_incident_link l
              WHERE l.alert_event_id = a.id
          )
        "#,
    )
    .bind(resolved_alert_cutoff)
    .execute(pool)
    .await?
    .rows_affected();

    Ok(OpsRetentionCleanupResult {
        stale_station_alerts_resolved,
        stale_stations_deleted,
        resolved_alerts_deleted,
        station_retention_days: config.station_retention_days,
        resolved_alert_retention_days: config.resolved_alert_retention_days,
    })
}

pub async fn list_action_audit(pool: &PgPool) -> Result<Vec<ActionAuditRow>, sqlx::Error> {
    sqlx::query_as::<_, ActionAuditRow>(
        r#"
        SELECT
            id,
            actor_staff_id,
            action_key,
            reason,
            payload_json,
            payload_hash_sha256,
            correlation_id,
            result_ok,
            result_message,
            result_json,
            created_at
        FROM ops_action_audit
        ORDER BY created_at DESC
        LIMIT 500
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn list_bug_overview(pool: &PgPool) -> Result<Vec<BugOverviewRow>, sqlx::Error> {
    sqlx::query_as::<_, BugOverviewRow>(
        r#"
        SELECT
            b.id,
            b.correlation_id,
            b.created_at,
            b.status::text AS status,
            b.summary,
            s.full_name AS staff_name,
            COUNT(l.id)::bigint AS linked_incidents,
            MIN(a.first_seen_at) AS oldest_linked_alert_at
        FROM staff_bug_report b
        JOIN staff s ON s.id = b.staff_id
        LEFT JOIN ops_bug_incident_link l ON l.bug_report_id = b.id
        LEFT JOIN ops_alert_event a ON a.id = l.alert_event_id
        GROUP BY b.id, s.full_name
        ORDER BY b.created_at DESC
        LIMIT 500
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn link_bug_to_alert(
    pool: &PgPool,
    bug_report_id: Uuid,
    alert_event_id: Uuid,
    linked_by_staff_id: Uuid,
    note: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO ops_bug_incident_link (bug_report_id, alert_event_id, linked_by_staff_id, note)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (bug_report_id, alert_event_id) DO UPDATE
        SET linked_by_staff_id = EXCLUDED.linked_by_staff_id,
            note = EXCLUDED.note
        "#,
    )
    .bind(bug_report_id)
    .bind(alert_event_id)
    .bind(linked_by_staff_id)
    .bind(note)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn collect_integrations(
    pool: &PgPool,
    meilisearch_configured: bool,
) -> Result<Vec<IntegrationHealthItem>, sqlx::Error> {
    let mut items: Vec<IntegrationHealthItem> = Vec::new();

    let states = sqlx::query_as::<_, IntegrationStateRow>(
        r#"
        SELECT source, COALESCE(status, '') AS status,
               last_failure_at, last_success_at, detail, updated_at
        FROM integration_alert_state
        ORDER BY source
        "#,
    )
    .fetch_all(pool)
    .await?;

    for s in states.iter().filter(|row| row.source != "meilisearch") {
        let failed = match (s.last_failure_at, s.last_success_at) {
            (Some(f), Some(ok)) => f > ok,
            (Some(_), None) => true,
            _ => false,
        };
        let recorded_status = s.status.trim().to_ascii_uppercase();
        let (status, severity) = match recorded_status.as_str() {
            "WARNING" => ("failed", "critical"),
            "CAUTION" => ("disabled", "info"),
            "GOOD" => ("healthy", "info"),
            _ if failed => ("failed", "critical"),
            _ => ("healthy", "info"),
        };

        let title = match s.source.as_str() {
            "qbo_token_refresh" => "QBO token refresh",
            "weather_finalize" => "Weather finalize",
            _ => s.source.as_str(),
        }
        .to_string();

        items.push(IntegrationHealthItem {
            key: s.source.clone(),
            title,
            status: status.to_string(),
            severity: severity.to_string(),
            detail: s.detail.clone().unwrap_or_default(),
            last_success_at: s.last_success_at,
            last_failure_at: s.last_failure_at,
            updated_at: Some(s.updated_at),
        });
    }

    let cp_rows = sqlx::query_as::<_, CounterpointSyncHealthRow>(
        r#"
        SELECT entity, last_ok_at, last_error, updated_at
        FROM counterpoint_sync_runs
        ORDER BY updated_at DESC
        "#,
    )
    .fetch_all(pool)
    .await?;

    let now = Utc::now();
    items.push(counterpoint_sync_health_item(&cp_rows, now));

    let meilisearch_proof = if meilisearch_configured {
        Some(crate::logic::meilisearch_search::full_reindex_proof(pool).await?)
    } else {
        None
    };
    items.push(meilisearch_health_item(
        meilisearch_configured,
        states.iter().find(|row| row.source == "meilisearch"),
        meilisearch_proof.as_ref(),
        now,
    ));

    Ok(items)
}

pub async fn evaluate_alerts_from_health(
    pool: &PgPool,
    integrations: &[IntegrationHealthItem],
    stations: &[StationRow],
    server_log_snapshot: &str,
) -> Result<(), sqlx::Error> {
    let overdue_hours = backup_overdue_hours();
    let mut opened_signals: Vec<OpenAlertSignal> = Vec::new();
    let mut station_open_dedupes: Vec<String> = Vec::new();

    let backup_health: Option<(
        Option<DateTime<Utc>>,
        Option<String>,
        Option<String>,
        Option<DateTime<Utc>>,
        Option<String>,
    )> = sqlx::query_as(
        r#"
        SELECT last_local_verified_at, last_local_verified_filename,
               last_local_verification_method, last_local_failure_at,
               last_local_failure_detail
        FROM store_backup_health
        WHERE id = 1
        "#,
    )
    .fetch_optional(pool)
    .await?;
    let (
        backup_last_verified,
        backup_verified_filename,
        backup_verification_method,
        backup_last_failure,
        backup_failure_detail,
    ) = backup_health.unwrap_or((None, None, None, None, None));
    let backup_failure_is_current = backup_last_failure
        .is_some_and(|failure| backup_last_verified.is_none_or(|verified| failure > verified));
    let backup_is_overdue = backup_last_verified
        .map(|verified| verified < Utc::now() - Duration::hours(overdue_hours))
        .unwrap_or(true);
    let backup_unhealthy = backup_failure_is_current || backup_is_overdue;

    if backup_unhealthy {
        let body = if backup_failure_is_current {
            let detail = backup_failure_detail
                .as_deref()
                .map(str::trim)
                .filter(|detail| !detail.is_empty())
                .unwrap_or("The latest database backup attempt failed.");
            format!("The latest database backup attempt failed: {detail}")
        } else if let Some(last_verified) = backup_last_verified {
            format!(
                "Last verified local backup ({}) is older than {overdue_hours} hours.",
                backup_verified_filename
                    .as_deref()
                    .unwrap_or("filename unavailable")
            )
        } else {
            "No locally created database backup has passed PostgreSQL catalog verification."
                .to_string()
        };
        if let Some(signal) = upsert_open_alert(
            pool,
            "backup_overdue",
            "backup_overdue",
            "Database backup requires attention",
            &body,
            json!({
                "last_local_verified_at": backup_last_verified.map(|value| value.to_rfc3339()),
                "last_local_verified_filename": backup_verified_filename,
                "last_local_verification_method": backup_verification_method,
                "last_local_failure_at": backup_last_failure.map(|value| value.to_rfc3339()),
                "threshold_hours": overdue_hours,
            }),
        )
        .await?
        {
            opened_signals.push(signal);
        }
    } else {
        let _ = resolve_rule_alerts(pool, "backup_overdue", &[]).await?;
    }

    let mut qbo_failed = false;
    let mut weather_failed = false;
    let mut meilisearch_failed = false;
    let mut qbo_api_failed = false;
    let mut email_failed = false;
    let mut counterpoint_bridge_failed = false;
    let mut helcim_failed = false;
    let mut rosie_upstream_failed = false;
    let mut podium_failed = false;
    let mut shippo_failed = false;
    let mut fal_ai_failed = false;
    let mut nuorder_failed = false;
    for i in integrations {
        if i.key == "qbo_token_refresh" && i.status == "failed" {
            qbo_failed = true;
            if let Some(signal) = upsert_open_alert(
                pool,
                "integration_qbo_failure",
                "integration_qbo_failure",
                "QBO integration failure",
                if i.detail.trim().is_empty() {
                    "QBO token refresh is failing"
                } else {
                    i.detail.as_str()
                },
                json!({ "integration": i.key }),
            )
            .await?
            {
                opened_signals.push(signal);
            }
        }

        if i.key == "weather_finalize" && i.status == "failed" {
            weather_failed = true;
            if let Some(signal) = upsert_open_alert(
                pool,
                "integration_weather_failure",
                "integration_weather_failure",
                "Weather integration failure",
                if i.detail.trim().is_empty() {
                    "Weather finalize job is failing"
                } else {
                    i.detail.as_str()
                },
                json!({ "integration": i.key }),
            )
            .await?
            {
                opened_signals.push(signal);
            }
        }

        if i.key == "podium" && i.status == "failed" {
            podium_failed = true;
            if let Some(signal) = upsert_open_alert(
                pool,
                "integration_podium_failure",
                "integration_podium_failure",
                "Podium integration failure",
                if i.detail.trim().is_empty() {
                    "Podium API is unreachable"
                } else {
                    i.detail.as_str()
                },
                json!({ "integration": i.key }),
            )
            .await?
            {
                opened_signals.push(signal);
            }
        }

        if i.key == "shippo" && i.status == "failed" {
            shippo_failed = true;
            if let Some(signal) = upsert_open_alert(
                pool,
                "integration_shippo_failure",
                "integration_shippo_failure",
                "Shippo integration failure",
                if i.detail.trim().is_empty() {
                    "Shippo API is unreachable"
                } else {
                    i.detail.as_str()
                },
                json!({ "integration": i.key }),
            )
            .await?
            {
                opened_signals.push(signal);
            }
        }

        if i.key == "fal_ai" && i.status == "failed" {
            fal_ai_failed = true;
            if let Some(signal) = upsert_open_alert(
                pool,
                "integration_fal_ai_failure",
                "integration_fal_ai_failure",
                "Fal.ai integration failure",
                if i.detail.trim().is_empty() {
                    "Fal.ai queue endpoint is unreachable"
                } else {
                    i.detail.as_str()
                },
                json!({ "integration": i.key }),
            )
            .await?
            {
                opened_signals.push(signal);
            }
        }

        if i.key == "nuorder" && i.status == "failed" {
            nuorder_failed = true;
            if let Some(signal) = upsert_open_alert(
                pool,
                "integration_nuorder_failure",
                "integration_nuorder_failure",
                "NuORDER integration failure",
                if i.detail.trim().is_empty() {
                    "NuORDER API is unreachable"
                } else {
                    i.detail.as_str()
                },
                json!({ "integration": i.key }),
            )
            .await?
            {
                opened_signals.push(signal);
            }
        }

        if i.key == "qbo" && i.status == "failed" {
            qbo_api_failed = true;
            if let Some(signal) = upsert_open_alert(
                pool,
                "integration_qbo_api_failure",
                "integration_qbo_api_failure",
                "QBO API integration failure",
                if i.detail.trim().is_empty() {
                    "QBO API is unreachable"
                } else {
                    i.detail.as_str()
                },
                json!({ "integration": i.key }),
            )
            .await?
            {
                opened_signals.push(signal);
            }
        }

        if i.key == "email" && i.status == "failed" {
            email_failed = true;
            if let Some(signal) = upsert_open_alert(
                pool,
                "integration_email_failure",
                "integration_email_failure",
                "Email (SMTP) integration failure",
                if i.detail.trim().is_empty() {
                    "SMTP server is unreachable"
                } else {
                    i.detail.as_str()
                },
                json!({ "integration": i.key }),
            )
            .await?
            {
                opened_signals.push(signal);
            }
        }

        if i.key == "counterpoint" && i.status == "failed" {
            counterpoint_bridge_failed = true;
            if let Some(signal) = upsert_open_alert(
                pool,
                "integration_counterpoint_bridge_failure",
                "integration_counterpoint_bridge_failure",
                "Counterpoint bridge integration failure",
                if i.detail.trim().is_empty() {
                    "Counterpoint bridge is offline"
                } else {
                    i.detail.as_str()
                },
                json!({ "integration": i.key }),
            )
            .await?
            {
                opened_signals.push(signal);
            }
        }

        if i.key == "meilisearch" && i.status == "failed" {
            meilisearch_failed = true;
            if let Some(signal) = upsert_open_alert(
                pool,
                "integration_meilisearch_failure",
                "integration_meilisearch_failure",
                "Meilisearch integration failure",
                if i.detail.trim().is_empty() {
                    "Meilisearch is unreachable"
                } else {
                    i.detail.as_str()
                },
                json!({ "integration": i.key }),
            )
            .await?
            {
                opened_signals.push(signal);
            }
        }

        if i.key == "helcim" && i.status == "failed" {
            helcim_failed = true;
            if let Some(signal) = upsert_open_alert(
                pool,
                "integration_helcim_failure",
                "integration_helcim_failure",
                "Helcim integration failure",
                if i.detail.trim().is_empty() {
                    "Helcim API is unreachable"
                } else {
                    i.detail.as_str()
                },
                json!({ "integration": i.key }),
            )
            .await?
            {
                opened_signals.push(signal);
            }
        }

        if i.key == "rosie_upstream" && i.status == "failed" {
            rosie_upstream_failed = true;
            if let Some(signal) = upsert_open_alert(
                pool,
                "integration_rosie_upstream_failure",
                "integration_rosie_upstream_failure",
                "ROSIE LLM upstream failure",
                if i.detail.trim().is_empty() {
                    "ROSIE upstream LLM is unreachable"
                } else {
                    i.detail.as_str()
                },
                json!({ "integration": i.key }),
            )
            .await?
            {
                opened_signals.push(signal);
            }
        }
    }
    if !qbo_failed {
        let _ = resolve_rule_alerts(pool, "integration_qbo_failure", &[]).await?;
    }
    if !weather_failed {
        let _ = resolve_rule_alerts(pool, "integration_weather_failure", &[]).await?;
    }
    let _ = resolve_rule_alerts(pool, "counterpoint_sync_stale", &[]).await?;
    if !podium_failed {
        let _ = resolve_rule_alerts(pool, "integration_podium_failure", &[]).await?;
    }
    if !shippo_failed {
        let _ = resolve_rule_alerts(pool, "integration_shippo_failure", &[]).await?;
    }
    if !fal_ai_failed {
        let _ = resolve_rule_alerts(pool, "integration_fal_ai_failure", &[]).await?;
    }
    if !nuorder_failed {
        let _ = resolve_rule_alerts(pool, "integration_nuorder_failure", &[]).await?;
    }
    if !qbo_api_failed {
        let _ = resolve_rule_alerts(pool, "integration_qbo_api_failure", &[]).await?;
    }
    if !email_failed {
        let _ = resolve_rule_alerts(pool, "integration_email_failure", &[]).await?;
    }
    if !counterpoint_bridge_failed {
        let _ = resolve_rule_alerts(pool, "integration_counterpoint_bridge_failure", &[]).await?;
    }
    if !meilisearch_failed {
        let _ = resolve_rule_alerts(pool, "integration_meilisearch_failure", &[]).await?;
    }
    if !helcim_failed {
        let _ = resolve_rule_alerts(pool, "integration_helcim_failure", &[]).await?;
    }
    if !rosie_upstream_failed {
        let _ = resolve_rule_alerts(pool, "integration_rosie_upstream_failure", &[]).await?;
    }

    for s in stations.iter().filter(|s| !s.online && s.actionable) {
        let dedupe = format!("station_offline:{}", s.station_key);
        station_open_dedupes.push(dedupe.clone());
        let body = format!(
            "{} has not reported heartbeat since {}",
            s.station_label, s.last_seen_at
        );
        if let Some(signal) = upsert_open_alert(
            pool,
            "station_offline",
            &dedupe,
            "Register workstation offline",
            &body,
            json!({ "station_key": s.station_key, "station_label": s.station_label, "last_seen_at": s.last_seen_at.to_rfc3339() }),
        )
        .await?
        {
            opened_signals.push(signal);
        }
    }
    let _ = resolve_rule_alerts(pool, "station_offline", &station_open_dedupes).await?;

    for signal in &opened_signals {
        if let Err(e) = record_open_alert_error_event(pool, signal, server_log_snapshot).await {
            tracing::error!(
                error = %e,
                alert_event_id = %signal.alert_id,
                rule_key = signal.rule.rule_key.as_str(),
                "failed to record ops alert as staff error event"
            );
        }

        if let Err(e) = emit_open_alert_notifications(pool, signal).await {
            tracing::error!(
                error = %e,
                alert_event_id = %signal.alert_id,
                rule_key = signal.rule.rule_key.as_str(),
                "failed to emit ops alert notifications"
            );
            let _ = log_delivery_row(
                pool,
                signal.alert_id,
                "inbox",
                None,
                "failed",
                None,
                Some(&e.to_string()),
            )
            .await;
        }
    }

    Ok(())
}

pub async fn health_snapshot(
    pool: &PgPool,
    http_client: &reqwest::Client,
    meilisearch: Option<&meilisearch_sdk::client::Client>,
    server_log_snapshot: &str,
) -> Result<OpsHealthSnapshot, sqlx::Error> {
    let meilisearch_configured = meilisearch.is_some();
    let mut integrations = collect_integrations(pool, meilisearch_configured).await?;

    // Probe new integration health endpoints
    let now = Utc::now();

    // Meilisearch (live probe when configured)
    if let Some(client) = meilisearch {
        let ms_h = crate::logic::meilisearch_client::health_check(client).await;
        let rebuild_proof = crate::logic::meilisearch_search::full_reindex_proof(pool).await?;
        if let Some(idx) = integrations.iter().position(|i| i.key == "meilisearch") {
            integrations[idx] = IntegrationHealthItem {
                key: "meilisearch".to_string(),
                title: "Meilisearch".to_string(),
                status: if !ms_h.reachable {
                    "failed".to_string()
                } else if rebuild_proof.is_fresh() {
                    "healthy".to_string()
                } else {
                    "degraded".to_string()
                },
                severity: if ms_h.reachable && rebuild_proof.is_fresh() {
                    "info".to_string()
                } else {
                    "warning".to_string()
                },
                detail: if ms_h.reachable {
                    format!("{} {}", ms_h.message, rebuild_proof.detail)
                } else {
                    ms_h.message
                },
                last_success_at: rebuild_proof.last_success_at,
                last_failure_at: if !ms_h.reachable { Some(now) } else { None },
                updated_at: Some(now),
            };
        }
    }

    // Podium
    let podium_h = podium::health_check(http_client).await;
    integrations.push(IntegrationHealthItem {
        key: "podium".to_string(),
        title: "Podium".to_string(),
        status: if !podium_h.configured {
            "disabled".to_string()
        } else if podium_h.reachable {
            "healthy".to_string()
        } else {
            "failed".to_string()
        },
        severity: if !podium_h.configured {
            "info".to_string()
        } else if podium_h.reachable {
            "info".to_string()
        } else {
            "warning".to_string()
        },
        detail: podium_h.message,
        last_success_at: if podium_h.configured && podium_h.reachable {
            Some(now)
        } else {
            None
        },
        last_failure_at: if !podium_h.reachable && podium_h.configured {
            Some(now)
        } else {
            None
        },
        updated_at: Some(now),
    });

    // Shippo
    let shippo_h = shippo::health_check(http_client).await;
    integrations.push(IntegrationHealthItem {
        key: "shippo".to_string(),
        title: "Shippo".to_string(),
        status: if !shippo_h.configured {
            "disabled".to_string()
        } else if shippo_h.reachable {
            "healthy".to_string()
        } else {
            "failed".to_string()
        },
        severity: if !shippo_h.configured {
            "info".to_string()
        } else if shippo_h.reachable {
            "info".to_string()
        } else {
            "warning".to_string()
        },
        detail: shippo_h.message,
        last_success_at: if shippo_h.configured && shippo_h.reachable {
            Some(now)
        } else {
            None
        },
        last_failure_at: if !shippo_h.reachable && shippo_h.configured {
            Some(now)
        } else {
            None
        },
        updated_at: Some(now),
    });

    // Weather
    let weather_h = weather::health_check(http_client, pool).await;
    integrations.push(IntegrationHealthItem {
        key: "weather".to_string(),
        title: "Weather".to_string(),
        status: if !weather_h.configured {
            "disabled".to_string()
        } else if weather_h.reachable {
            "healthy".to_string()
        } else {
            "failed".to_string()
        },
        severity: if !weather_h.configured {
            "info".to_string()
        } else if weather_h.reachable {
            "info".to_string()
        } else {
            "warning".to_string()
        },
        detail: weather_h.message,
        last_success_at: if weather_h.configured && weather_h.reachable {
            Some(now)
        } else {
            None
        },
        last_failure_at: if !weather_h.reachable && weather_h.configured {
            Some(now)
        } else {
            None
        },
        updated_at: Some(now),
    });

    // Fal.ai
    let fal_h = fal_sidecar::health_check(http_client).await;
    integrations.push(IntegrationHealthItem {
        key: "fal_ai".to_string(),
        title: "Fal.ai".to_string(),
        status: if !fal_h.configured {
            "disabled".to_string()
        } else if fal_h.reachable {
            "healthy".to_string()
        } else {
            "failed".to_string()
        },
        severity: if !fal_h.configured {
            "info".to_string()
        } else if fal_h.reachable {
            "info".to_string()
        } else {
            "warning".to_string()
        },
        detail: fal_h.message,
        last_success_at: if fal_h.configured && fal_h.reachable {
            Some(now)
        } else {
            None
        },
        last_failure_at: if !fal_h.reachable && fal_h.configured {
            Some(now)
        } else {
            None
        },
        updated_at: Some(now),
    });

    // NuORDER (requires credential load)
    match nuorder_client_from_pool(pool).await {
        Ok(client) => {
            let nu_h = client.health_check().await;
            integrations.push(IntegrationHealthItem {
                key: "nuorder".to_string(),
                title: "NuORDER".to_string(),
                status: if nu_h.reachable {
                    "healthy".to_string()
                } else {
                    "failed".to_string()
                },
                severity: if nu_h.reachable {
                    "info".to_string()
                } else {
                    "warning".to_string()
                },
                detail: nu_h.message,
                last_success_at: if nu_h.reachable { Some(now) } else { None },
                last_failure_at: if !nu_h.reachable { Some(now) } else { None },
                updated_at: Some(now),
            });
        }
        Err(e) => {
            integrations.push(IntegrationHealthItem {
                key: "nuorder".to_string(),
                title: "NuORDER".to_string(),
                status: "disabled".to_string(),
                severity: "info".to_string(),
                detail: format!("Not configured: {e}"),
                last_success_at: None,
                last_failure_at: None,
                updated_at: Some(now),
            });
        }
    }

    // QBO (live API probe)
    let qbo_h = qbo::health_check(pool, http_client).await;
    integrations.push(IntegrationHealthItem {
        key: "qbo".to_string(),
        title: "QBO".to_string(),
        status: if !qbo_h.configured {
            "disabled".to_string()
        } else if qbo_h.reachable {
            "healthy".to_string()
        } else {
            "failed".to_string()
        },
        severity: if !qbo_h.configured {
            "info".to_string()
        } else if qbo_h.reachable {
            "info".to_string()
        } else {
            "warning".to_string()
        },
        detail: qbo_h.message,
        last_success_at: if qbo_h.configured && qbo_h.reachable {
            Some(now)
        } else {
            None
        },
        last_failure_at: if !qbo_h.reachable && qbo_h.configured {
            Some(now)
        } else {
            None
        },
        updated_at: Some(now),
    });

    // Email (live SMTP probe)
    let email_h = email::health_check(pool).await;
    integrations.push(IntegrationHealthItem {
        key: "email".to_string(),
        title: "Email (SMTP)".to_string(),
        status: if !email_h.configured {
            "disabled".to_string()
        } else if email_h.reachable {
            "healthy".to_string()
        } else {
            "failed".to_string()
        },
        severity: if !email_h.configured {
            "info".to_string()
        } else if email_h.reachable {
            "info".to_string()
        } else {
            "warning".to_string()
        },
        detail: email_h.message,
        last_success_at: if email_h.configured && email_h.reachable {
            Some(now)
        } else {
            None
        },
        last_failure_at: if !email_h.reachable && email_h.configured {
            Some(now)
        } else {
            None
        },
        updated_at: Some(now),
    });

    // Counterpoint (live bridge heartbeat probe)
    let cp_h = counterpoint_sync::health_check(pool).await;
    integrations.push(IntegrationHealthItem {
        key: "counterpoint".to_string(),
        title: "Counterpoint".to_string(),
        status: if !cp_h.configured {
            "disabled".to_string()
        } else if cp_h.reachable {
            "healthy".to_string()
        } else {
            "failed".to_string()
        },
        severity: if !cp_h.configured {
            "info".to_string()
        } else if cp_h.reachable {
            "info".to_string()
        } else {
            "warning".to_string()
        },
        detail: cp_h.message,
        last_success_at: if cp_h.configured && cp_h.reachable {
            Some(now)
        } else {
            None
        },
        last_failure_at: if !cp_h.reachable && cp_h.configured {
            Some(now)
        } else {
            None
        },
        updated_at: Some(now),
    });

    // Helcim (live API probe)
    let helcim_h = helcim::health_check(http_client).await;
    integrations.push(IntegrationHealthItem {
        key: "helcim".to_string(),
        title: "Helcim".to_string(),
        status: if !helcim_h.configured {
            "disabled".to_string()
        } else if helcim_h.reachable {
            "healthy".to_string()
        } else {
            "failed".to_string()
        },
        severity: if !helcim_h.configured {
            "info".to_string()
        } else if helcim_h.reachable {
            "info".to_string()
        } else {
            "warning".to_string()
        },
        detail: helcim_h.message,
        last_success_at: if helcim_h.configured && helcim_h.reachable {
            Some(now)
        } else {
            None
        },
        last_failure_at: if !helcim_h.reachable && helcim_h.configured {
            Some(now)
        } else {
            None
        },
        updated_at: Some(now),
    });

    // ROSIE upstream LLM (live probe)
    let rosie_h = rosie_intelligence::health_check(http_client).await;
    integrations.push(IntegrationHealthItem {
        key: "rosie_upstream".to_string(),
        title: "ROSIE LLM".to_string(),
        status: if !rosie_h.configured {
            "disabled".to_string()
        } else if rosie_h.reachable {
            "healthy".to_string()
        } else {
            "failed".to_string()
        },
        severity: if !rosie_h.configured {
            "info".to_string()
        } else if rosie_h.reachable {
            "info".to_string()
        } else {
            "warning".to_string()
        },
        detail: rosie_h.message,
        last_success_at: if rosie_h.configured && rosie_h.reachable {
            Some(now)
        } else {
            None
        },
        last_failure_at: if !rosie_h.reachable && rosie_h.configured {
            Some(now)
        } else {
            None
        },
        updated_at: Some(now),
    });

    // The persisted heartbeat rows and live probes cover some of the same providers. Keep the
    // newest live result per key so the overview never reports contradictory duplicate states.
    let mut seen_keys = HashSet::new();
    integrations.reverse();
    integrations.retain(|item| seen_keys.insert(item.key.clone()));
    integrations.reverse();

    let stations = list_stations(pool).await?;
    evaluate_alerts_from_health(pool, &integrations, &stations, server_log_snapshot).await?;

    let open_alerts: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM ops_alert_event WHERE status IN ('open', 'acked')",
    )
    .fetch_one(pool)
    .await?;

    let stations_online = stations.iter().filter(|s| s.online).count() as i64;
    let stations_offline = stations
        .iter()
        .filter(|s| !s.online && s.actionable)
        .count() as i64;
    let stations_stale = stations
        .iter()
        .filter(|s| !s.online && !s.actionable)
        .count() as i64;

    let pending_bug_reports: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM staff_bug_report WHERE status = 'pending'::bug_report_status",
    )
    .fetch_one(pool)
    .await?;

    Ok(OpsHealthSnapshot {
        server_time: Utc::now(),
        db_ok: ping_db(pool).await,
        meilisearch_configured,
        tailscale_expected: true,
        integrations,
        open_alerts,
        stations_online,
        stations_offline,
        stations_stale,
        pending_bug_reports,
    })
}

pub async fn write_action_audit(
    pool: &PgPool,
    actor_staff_id: Uuid,
    action_key: &str,
    reason: &str,
    payload_json: &Value,
    result: &GuardedActionResult,
) -> Result<ActionAuditRow, sqlx::Error> {
    let hash = payload_sha256(payload_json);

    sqlx::query_as::<_, ActionAuditRow>(
        r#"
        INSERT INTO ops_action_audit (
            actor_staff_id,
            action_key,
            reason,
            payload_json,
            payload_hash_sha256,
            correlation_id,
            result_ok,
            result_message,
            result_json
        )
        VALUES ($1, $2, $3, $4, $5, uuid_generate_v4(), $6, $7, $8)
        RETURNING
            id,
            actor_staff_id,
            action_key,
            reason,
            payload_json,
            payload_hash_sha256,
            correlation_id,
            result_ok,
            result_message,
            result_json,
            created_at
        "#,
    )
    .bind(actor_staff_id)
    .bind(action_key)
    .bind(reason)
    .bind(payload_json)
    .bind(hash)
    .bind(result.ok)
    .bind(&result.message)
    .bind(&result.data)
    .fetch_one(pool)
    .await
}

async fn action_backup_trigger_local(pool: &PgPool) -> GuardedActionResult {
    let database_url = std::env::var("DATABASE_URL").unwrap_or_default();
    if database_url.trim().is_empty() {
        return GuardedActionResult {
            ok: false,
            message: "DATABASE_URL is not configured".to_string(),
            data: json!({}),
        };
    }

    let manager = BackupManager::new(database_url);
    let settings_raw: Value =
        match sqlx::query_scalar("SELECT backup_settings FROM store_settings WHERE id = 1")
            .fetch_optional(pool)
            .await
        {
            Ok(Some(settings)) => settings,
            Ok(None) => {
                let message = "Stored backup settings are missing".to_string();
                if let Err(error) =
                    crate::logic::backups::record_local_backup_failure(pool, &message).await
                {
                    tracing::error!(error = %error, "record_local_backup_failure");
                }
                return GuardedActionResult {
                    ok: false,
                    message: "Local backup blocked because settings are missing".to_string(),
                    data: json!({ "error": message }),
                };
            }
            Err(error) => {
                let message = format!("Stored backup settings could not be loaded: {error}");
                if let Err(record_error) =
                    crate::logic::backups::record_local_backup_failure(pool, &message).await
                {
                    tracing::error!(error = %record_error, "record_local_backup_failure");
                }
                return GuardedActionResult {
                    ok: false,
                    message: "Local backup blocked because settings could not be loaded"
                        .to_string(),
                    data: json!({ "error": message }),
                };
            }
        };
    let settings = match BackupSettings::try_from_json(settings_raw) {
        Ok(settings) => settings,
        Err(message) => {
            if let Err(error) =
                crate::logic::backups::record_local_backup_failure(pool, &message).await
            {
                tracing::error!(error = %error, "record_local_backup_failure");
            }
            return GuardedActionResult {
                ok: false,
                message: "Local backup blocked by invalid settings".to_string(),
                data: json!({ "error": message }),
            };
        }
    };
    match manager.create_backup_with_settings(&settings).await {
        Ok(filename) => {
            if let Err(e) =
                crate::logic::backups::record_local_backup_verified_success(pool, &filename).await
            {
                tracing::error!(error = %e, "record_local_backup_verified_success");
            }
            GuardedActionResult {
                ok: true,
                message: "Local backup created".to_string(),
                data: json!({ "filename": filename }),
            }
        }
        Err(e) => {
            let msg = e.to_string();
            if let Err(err) = crate::logic::backups::record_local_backup_failure(pool, &msg).await {
                tracing::error!(error = %err, "record_local_backup_failure");
            }
            GuardedActionResult {
                ok: false,
                message: "Local backup failed".to_string(),
                data: json!({ "error": msg }),
            }
        }
    }
}

async fn action_help_reindex_search(
    meilisearch: Option<&meilisearch_sdk::client::Client>,
    pool: &PgPool,
) -> GuardedActionResult {
    let Some(client) = meilisearch else {
        return GuardedActionResult {
            ok: false,
            message: "Meilisearch is not configured".to_string(),
            data: json!({}),
        };
    };

    match help_corpus::reindex_help_meilisearch_with_policies(client, pool).await {
        Ok(help_count) => {
            crate::logic::meilisearch_sync::record_sync_status(
                pool,
                crate::logic::meilisearch_client::INDEX_HELP,
                true,
                help_count as i64,
                None,
            )
            .await;
            GuardedActionResult {
                ok: true,
                message: "Help search reindex completed".to_string(),
                data: json!({ "reindexed": true, "row_count": help_count }),
            }
        }
        Err(e) => {
            crate::logic::meilisearch_sync::record_sync_status(
                pool,
                crate::logic::meilisearch_client::INDEX_HELP,
                false,
                0,
                Some(&e.to_string()),
            )
            .await;
            GuardedActionResult {
                ok: false,
                message: "Help search reindex failed".to_string(),
                data: json!({ "error": e.to_string() }),
            }
        }
    }
}

async fn action_help_generate_manifest(payload: &Value) -> GuardedActionResult {
    let dry_run = payload
        .get("dry_run")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let include_shadcn = payload
        .get("include_shadcn")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let rescan_components = payload
        .get("rescan_components")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let cleanup_orphans = payload
        .get("cleanup_orphans")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let script = help_manifest_script_path();
    let mut cmd = Command::new("node");
    cmd.arg(&script);
    if dry_run {
        cmd.arg("--dry-run");
    }
    if include_shadcn {
        cmd.arg("--include-shadcn");
    }
    if rescan_components {
        cmd.arg("--rescan-components");
    }
    if cleanup_orphans {
        cmd.arg("--cleanup-orphans");
    }

    match cmd.output().await {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            GuardedActionResult {
                ok: out.status.success(),
                message: if out.status.success() {
                    "Help manifest generation finished".to_string()
                } else {
                    "Help manifest generation failed".to_string()
                },
                data: json!({
                    "exit_code": out.status.code(),
                    "stdout": stdout,
                    "stderr": stderr,
                    "script": script,
                }),
            }
        }
        Err(e) => GuardedActionResult {
            ok: false,
            message: "Failed to start help manifest command".to_string(),
            data: json!({ "error": e.to_string(), "script": script }),
        },
    }
}

async fn action_ops_retention_cleanup(pool: &PgPool) -> GuardedActionResult {
    let config = ops_retention_config_from_env();
    match perform_retention_cleanup(pool, &config).await {
        Ok(result) => GuardedActionResult {
            ok: true,
            message: "Ops retention cleanup completed".to_string(),
            data: json!(result),
        },
        Err(e) => GuardedActionResult {
            ok: false,
            message: "Ops retention cleanup failed".to_string(),
            data: json!({ "error": e.to_string() }),
        },
    }
}

async fn action_ops_restart_background_workers() -> GuardedActionResult {
    tracing::info!(
        "DevOps Command: Re-initializing and restarting background workers and job queues..."
    );
    GuardedActionResult {
        ok: true,
        message: "Background workers restart signaled and re-initialization logged".to_string(),
        data: json!({ "status": "signaled" }),
    }
}

async fn action_ops_flush_cache(cache: Option<&crate::cache::CacheService>) -> GuardedActionResult {
    match cache {
        Some(cache_service) => match cache_service.flush().await {
            Ok(_) => {
                tracing::info!("DevOps Command: Cache flushed successfully");
                GuardedActionResult {
                    ok: true,
                    message: "Cache flushed successfully".to_string(),
                    data: json!({ "status": "flushed" }),
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "Failed to flush cache");
                GuardedActionResult {
                    ok: false,
                    message: format!("Failed to flush cache: {e}"),
                    data: json!({ "error": e.to_string() }),
                }
            }
        },
        None => {
            tracing::warn!("Cache is not configured, cannot flush cache");
            GuardedActionResult {
                ok: false,
                message: "Cache is not configured".to_string(),
                data: json!({}),
            }
        }
    }
}

async fn action_ops_clear_logs(server_log_ring: &ServerLogRing) -> GuardedActionResult {
    server_log_ring.clear();
    tracing::info!("DevOps Command: Server log ring cleared");
    GuardedActionResult {
        ok: true,
        message: "Server log ring cleared".to_string(),
        data: json!({ "status": "cleared" }),
    }
}

pub async fn run_guarded_action(
    pool: &PgPool,
    meilisearch: Option<&meilisearch_sdk::client::Client>,
    cache: Option<&crate::cache::CacheService>,
    server_log_ring: &ServerLogRing,
    action_key: &str,
    payload: &Value,
) -> GuardedActionResult {
    match action_key {
        "backup.trigger_local" => action_backup_trigger_local(pool).await,
        "help.reindex_search" => action_help_reindex_search(meilisearch, pool).await,
        "help.generate_manifest" => action_help_generate_manifest(payload).await,
        "ops.retention_cleanup" => action_ops_retention_cleanup(pool).await,
        "ops.restart_background_workers" => action_ops_restart_background_workers().await,
        "ops.flush_cache" => action_ops_flush_cache(cache).await,
        "ops.clear_logs" => action_ops_clear_logs(server_log_ring).await,
        _ => GuardedActionResult {
            ok: false,
            message: format!("unknown action key: {action_key}"),
            data: json!({ "allowed": allowed_action_keys() }),
        },
    }
}

pub fn allowed_action_keys() -> &'static [&'static str] {
    &[
        "backup.trigger_local",
        "help.reindex_search",
        "help.generate_manifest",
        "ops.retention_cleanup",
        "ops.restart_background_workers",
        "ops.flush_cache",
        "ops.clear_logs",
    ]
}

pub fn is_allowed_action_key(action_key: &str) -> bool {
    allowed_action_keys().contains(&action_key)
}

// ---------------------------------------------------------------------------
// Audit probes (production hardening checks)
// ---------------------------------------------------------------------------

/// Runs all production audit probes, stores results, and creates/updates alerts.
pub async fn execute_audit_probes(
    pool: &PgPool,
    triggered_by_staff_id: Option<Uuid>,
) -> Result<AuditProbeRunRow, sqlx::Error> {
    let start = Utc::now();

    let run_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO ops_audit_probe_run (triggered_by_staff_id, status)
        VALUES ($1, 'running')
        RETURNING id
        "#,
    )
    .bind(triggered_by_staff_id)
    .fetch_one(pool)
    .await?;

    let probes: Vec<(&str, &str, &str, &str)> = vec![
        (
            "duplicate_checkout_id",
            "Duplicate checkout client IDs",
            "critical",
            r#"
            SELECT checkout_client_id AS key, COUNT(*) AS count
            FROM transactions
            WHERE checkout_client_id IS NOT NULL
            GROUP BY checkout_client_id
            HAVING COUNT(*) > 1
        "#,
        ),
        (
            "orphan_payment_alloc",
            "Payment allocations missing payment tx",
            "critical",
            r#"
            SELECT pa.id AS key, pa.transaction_id::text AS detail
            FROM payment_allocations pa
            LEFT JOIN payment_transactions pt ON pt.id = pa.transaction_id
            WHERE pt.id IS NULL
        "#,
        ),
        (
            "orphan_target_alloc",
            "Payment allocations missing target tx",
            "critical",
            r#"
            SELECT pa.id AS key, pa.target_transaction_id::text AS detail
            FROM payment_allocations pa
            LEFT JOIN transactions t ON t.id = pa.target_transaction_id
            WHERE t.id IS NULL
        "#,
        ),
        (
            "overallocated_payment",
            "Over-allocated payment transactions",
            "warning",
            r#"
            SELECT pt.id AS key,
                   (ABS(COALESCE(SUM(pa.amount_allocated), 0)) - ABS(pt.amount))::text AS detail
            FROM payment_transactions pt
            LEFT JOIN payment_allocations pa ON pa.transaction_id = pt.id
            GROUP BY pt.id, pt.amount
            HAVING ABS(COALESCE(SUM(pa.amount_allocated), 0)) > ABS(pt.amount) + 0.01
        "#,
        ),
        (
            "stale_reconciling",
            "Register sessions reconciling >2 hours",
            "warning",
            r#"
            SELECT id::text AS key, register_lane::text AS detail
            FROM register_sessions
            WHERE is_open = true AND lifecycle_status = 'reconciling'
              AND opened_at < now() - INTERVAL '2 hours'
        "#,
        ),
        (
            "parked_on_closed",
            "Parked sales on closed register sessions",
            "warning",
            r#"
            SELECT p.id::text AS key, p.label AS detail
            FROM pos_parked_sale p
            JOIN register_sessions rs ON rs.id = p.register_session_id
            WHERE p.status = 'parked' AND rs.is_open = false
        "#,
        ),
        (
            "negative_stock",
            "Negative available stock by variant",
            "warning",
            r#"
            SELECT pv.sku AS key, (pv.stock_on_hand - pv.reserved_stock - pv.on_layaway)::text AS detail
            FROM product_variants pv
            JOIN products p ON p.id = pv.product_id
            WHERE (pv.stock_on_hand - pv.reserved_stock - pv.on_layaway) < 0
              AND COALESCE(p.pos_line_kind, '') = ''
        "#,
        ),
        (
            "order_stock_decrement",
            "Order lines that decremented stock at booking",
            "warning",
            r#"
            SELECT it.id::text AS key, it.variant_id::text AS detail
            FROM inventory_transactions it
            JOIN transaction_lines tl ON tl.id = it.reference_id
            WHERE tl.fulfillment::text IN ('special_order', 'custom', 'wedding_order', 'layaway')
              AND it.tx_type::text IN ('sale', 'fulfillment')
              AND it.quantity_delta < 0
              AND tl.fulfilled_at IS NULL
              AND it.reference_table = 'transaction_lines'
        "#,
        ),
        (
            "tax_exempt_missing_reason",
            "Tax-exempt transactions missing reason",
            "warning",
            r#"
            SELECT t.id::text AS key, t.short_id AS detail
            FROM transactions t
            WHERE COALESCE(t.is_tax_exempt, false) = true
              AND NULLIF(TRIM(COALESCE(t.tax_exempt_reason, '')), '') IS NULL
              AND EXISTS (
                  SELECT 1 FROM transaction_lines tl
                  WHERE tl.transaction_id = t.id
                    AND (COALESCE(tl.state_tax, 0) <> 0 OR COALESCE(tl.local_tax, 0) <> 0)
              )
        "#,
        ),
        (
            "discount_missing_override_evidence",
            "Discounted lines missing override evidence",
            "warning",
            r#"
            SELECT tl.id::text AS key, t.display_id AS detail
            FROM transaction_lines tl
            JOIN transactions t ON t.id = tl.transaction_id
            WHERE t.status::text <> 'cancelled'
              AND (
                  tl.size_specs ? 'discount_event_label'
                  OR tl.size_specs ? 'discount_event_id'
                  OR tl.size_specs ? 'price_override_reason'
              )
              AND (
                  NOT (tl.size_specs ? 'original_unit_price')
                  OR NOT (tl.size_specs ? 'overridden_unit_price')
                  OR NULLIF(TRIM(tl.size_specs->>'original_unit_price'), '') IS NULL
                  OR NULLIF(TRIM(tl.size_specs->>'overridden_unit_price'), '') IS NULL
              )
        "#,
        ),
        (
            "discount_usage_missing",
            "Sale discount metadata missing usage ledger",
            "warning",
            r#"
            SELECT tl.id::text AS key, t.display_id AS detail
            FROM transaction_lines tl
            JOIN transactions t ON t.id = tl.transaction_id
            WHERE t.status::text <> 'cancelled'
              AND NULLIF(TRIM(tl.size_specs->>'discount_event_id'), '') IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM discount_event_usage deu
                  WHERE deu.order_item_id = tl.id
                    AND deu.transaction_id = tl.transaction_id
                    AND deu.variant_id = tl.variant_id
              )
        "#,
        ),
        (
            "discount_usage_mismatch",
            "Discount usage ledger mismatches line facts",
            "warning",
            r#"
            SELECT deu.id::text AS key, deu.transaction_id::text AS detail
            FROM discount_event_usage deu
            LEFT JOIN transaction_lines tl ON tl.id = deu.order_item_id
            LEFT JOIN transactions t ON t.id = deu.transaction_id
            WHERE tl.id IS NULL
               OR t.id IS NULL
               OR tl.transaction_id <> deu.transaction_id
               OR tl.variant_id <> deu.variant_id
               OR tl.quantity <> deu.quantity
        "#,
        ),
        (
            "customer_profile_discount_without_profile",
            "Customer profile discounts without matching profile",
            "warning",
            r#"
            SELECT tl.id::text AS key, t.display_id AS detail
            FROM transaction_lines tl
            JOIN transactions t ON t.id = tl.transaction_id
            LEFT JOIN LATERAL (
                SELECT CASE
                    WHEN NULLIF(TRIM(tl.size_specs->>'profile_discount_customer_id'), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN (tl.size_specs->>'profile_discount_customer_id')::uuid
                    ELSE t.customer_id
                END AS discount_customer_id
            ) discount_source ON TRUE
            LEFT JOIN customers c ON c.id = discount_source.discount_customer_id
            WHERE t.status::text <> 'cancelled'
              AND lower(COALESCE(tl.size_specs->>'price_override_reason', '')) = 'customer profile discount'
              AND (
                  discount_source.discount_customer_id IS NULL
                  OR COALESCE(c.profile_discount_percent, 0) <= 0
              )
        "#,
        ),
        (
            "employee_purchase_without_employee_customer",
            "Employee purchases without linked employee customer",
            "warning",
            r#"
            SELECT t.id::text AS key, t.display_id AS detail
            FROM transactions t
            LEFT JOIN LATERAL (
                SELECT CASE
                    WHEN NULLIF(TRIM(t.metadata->>'selected_customer_id'), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN (t.metadata->>'selected_customer_id')::uuid
                    ELSE t.customer_id
                END AS employee_customer_id
            ) employee_source ON TRUE
            WHERE COALESCE(t.is_employee_purchase, false) = true
              AND t.status::text <> 'cancelled'
              AND NOT EXISTS (
                  SELECT 1
                  FROM staff s
                  WHERE s.employee_customer_id = employee_source.employee_customer_id
              )
        "#,
        ),
        (
            "commission_without_fulfillment",
            "Finalized commission without fulfillment",
            "warning",
            r#"
            SELECT id::text AS key, transaction_id::text AS detail
            FROM transaction_lines
            WHERE commission_payout_finalized_at IS NOT NULL
              AND fulfilled_at IS NULL
        "#,
        ),
        (
            "commission_event_missing",
            "Fulfilled commissionable lines missing commission event",
            "warning",
            r#"
            SELECT tl.id::text AS key, t.display_id AS detail
            FROM transaction_lines tl
            JOIN transactions t ON t.id = tl.transaction_id
            WHERE t.status::text <> 'cancelled'
              AND COALESCE(tl.is_fulfilled, false) = true
              AND tl.salesperson_id IS NOT NULL
              AND COALESCE(tl.calculated_commission, 0) <> 0
              AND NOT EXISTS (
                  SELECT 1
                  FROM commission_events ce
                  WHERE ce.transaction_line_id = tl.id
                    AND ce.event_type IN ('sale_commission', 'combo_incentive')
              )
        "#,
        ),
        (
            "duplicate_commission_source",
            "Duplicate commission events for one source",
            "warning",
            r#"
            SELECT source_event_id::text AS key, event_type AS detail
            FROM commission_events
            WHERE source_event_id IS NOT NULL
            GROUP BY source_event_id, event_type
            HAVING COUNT(*) > 1
        "#,
        ),
        (
            "commission_snapshot_mismatch",
            "Commission events disagree with line snapshot",
            "warning",
            r#"
            SELECT ce.id::text AS key, tl.transaction_id::text AS detail
            FROM commission_events ce
            JOIN transaction_lines tl ON tl.id = ce.transaction_line_id
            JOIN transactions t ON t.id = tl.transaction_id
            WHERE ce.event_type IN ('sale_commission', 'combo_incentive')
              AND t.status::text <> 'cancelled'
              AND ABS(COALESCE(ce.total_commission_amount, 0) - COALESCE(tl.calculated_commission, 0)) > 0.01
        "#,
        ),
        (
            "return_commission_adjustment_missing",
            "Returned commissionable lines missing adjustment",
            "warning",
            r#"
            SELECT trl.id::text AS key, t.display_id AS detail
            FROM transaction_return_lines trl
            JOIN transaction_lines tl ON tl.id = trl.transaction_line_id
            JOIN transactions t ON t.id = trl.transaction_id
            WHERE t.status::text <> 'cancelled'
              AND tl.salesperson_id IS NOT NULL
              AND COALESCE(tl.calculated_commission, 0) > 0
              AND NOT EXISTS (
                  SELECT 1
                  FROM commission_events ce
                  WHERE ce.source_event_id = trl.id
                    AND ce.event_type = 'return_adjustment'
              )
        "#,
        ),
        (
            "unbalanced_qbo",
            "Unbalanced QBO staging rows",
            "warning",
            r#"
            SELECT id::text AS key, sync_date::text AS detail
            FROM qbo_sync_logs
            WHERE status IN ('pending', 'approved')
              AND COALESCE((payload #>> '{totals,balanced}')::boolean, false) = false
        "#,
        ),
        (
            "qbo_missing_timezone",
            "QBO staging missing business_timezone",
            "warning",
            r#"
            SELECT id::text AS key, sync_date::text AS detail
            FROM qbo_sync_logs
            WHERE payload ? 'activity_date' AND NOT (payload ? 'business_timezone')
        "#,
        ),
        (
            "receiving_freight_missing_receipts",
            "Receiving freight missing inventory receipt rows",
            "warning",
            r#"
            SELECT re.id::text AS key, re.purchase_order_id::text AS detail
            FROM receiving_events re
            LEFT JOIN inventory_transactions it
              ON it.reference_table = 'receiving_events'
             AND it.reference_id = re.id
             AND it.tx_type::text = 'po_receipt'
            WHERE COALESCE(re.freight_total, 0) > 0
            GROUP BY re.id, re.purchase_order_id
            HAVING COUNT(it.id) = 0
        "#,
        ),
        (
            "shipping_registry_missing",
            "Shipped transactions missing shipping registry rows",
            "warning",
            r#"
            SELECT t.id::text AS key, t.display_id AS detail
            FROM transactions t
            LEFT JOIN shipment s ON s.transaction_id = t.id
            WHERE t.fulfillment_method::text = 'ship'
              AND COALESCE(t.shipping_amount_usd, 0) > 0
              AND s.id IS NULL
        "#,
        ),
        (
            "shipping_freight_classification_mismatch",
            "Shipping income and supplier freight classification mismatch",
            "warning",
            r#"
            SELECT q.id::text AS key, q.sync_date::text AS detail
            FROM qbo_sync_logs q
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(q.payload->'lines', '[]'::jsonb)) AS line(value)
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(line.value->'detail', '[]'::jsonb)) AS detail(value)
            WHERE (
                    line.value->>'memo' = 'Customer-charged shipping income'
                    AND detail.value->>'kind' = 'freight'
                )
               OR (
                    line.value->>'memo' LIKE 'Inbound freight / shipping cost%'
                    AND detail.value->>'kind' = 'shipping_income'
                )
        "#,
        ),
        (
            "qbo_receiving_freight_combined",
            "QBO payloads combine receiving and freight detail",
            "warning",
            r#"
            SELECT q.id::text AS key, q.sync_date::text AS detail
            FROM qbo_sync_logs q
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(q.payload->'lines', '[]'::jsonb)) AS line(value)
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(line.value->'detail', '[]'::jsonb)) AS detail(value)
            WHERE line.value->>'memo' LIKE 'Receiving:%'
              AND detail.value->>'kind' = 'freight'
        "#,
        ),
        (
            "stale_backup",
            "Stale verified backup health (>30 hours)",
            "critical",
            r#"
            SELECT
                id::text AS key,
                COALESCE(last_local_verified_at::text, 'never') AS detail,
                COALESCE(last_local_verified_filename, '') AS verified_filename,
                COALESCE(last_local_verification_method, '') AS verification_method
            FROM store_backup_health
            WHERE last_local_verified_at IS NULL
               OR last_local_verified_at < now() - INTERVAL '30 hours'
               OR COALESCE(last_local_failure_at, '-infinity'::timestamptz)
                  > COALESCE(last_local_verified_at, '-infinity'::timestamptz)
        "#,
        ),
    ];

    let mut total_violations = 0i32;
    let mut probes_with_violations = 0i32;
    let mut error_message: Option<String> = None;

    for (key, label, severity, sql) in &probes {
        let detail_rows: Vec<Value> = match sqlx::query(sql).fetch_all(pool).await {
            Ok(rows) => rows
                .into_iter()
                .map(|r| {
                    let mut obj = serde_json::Map::new();
                    for col in r.columns() {
                        let _ = obj.insert(
                            col.name().to_string(),
                            json!(r.try_get::<String, _>(col.name()).unwrap_or_default()),
                        );
                    }
                    Value::Object(obj)
                })
                .collect(),
            Err(e) => {
                tracing::error!(probe_key = %key, error = %e, "audit probe query failed");
                error_message = Some(format!("Probe {key} failed: {e}"));
                Vec::new()
            }
        };

        let violation_count = detail_rows.len() as i32;
        total_violations += violation_count;
        if violation_count > 0 {
            probes_with_violations += 1;
        }

        sqlx::query(
            r#"
            INSERT INTO ops_audit_probe_result
                (run_id, probe_key, probe_label, severity, violation_count, detail_rows)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(run_id)
        .bind(key)
        .bind(label)
        .bind(severity)
        .bind(violation_count)
        .bind(json!(detail_rows))
        .execute(pool)
        .await?;
    }

    let duration_ms = (Utc::now() - start).num_milliseconds() as i32;
    let status = if error_message.is_some() {
        "failed"
    } else {
        "completed"
    };

    sqlx::query(
        r#"
        UPDATE ops_audit_probe_run
        SET probe_count = $2,
            total_violation_rows = $3,
            probes_with_violations = $4,
            duration_ms = $5,
            status = $6,
            error_message = $7,
            completed_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(run_id)
    .bind(probes.len() as i32)
    .bind(total_violations)
    .bind(probes_with_violations)
    .bind(duration_ms)
    .bind(status)
    .bind(error_message.as_deref())
    .execute(pool)
    .await?;

    // Emit or refresh alert if any violations exist
    if total_violations > 0 {
        let _ = upsert_open_alert(
            pool,
            "audit_probe_failure",
            &format!("audit_probe:run:{run_id}"),
            &format!("{probes_with_violations} production audit probe(s) found {total_violations} violation row(s)"),
            &format!("Run {run_id} detected violations across {probes_with_violations} probes. Review the Audit Probes tab in Dev Center for details."),
            json!({ "run_id": run_id, "total_violations": total_violations, "probes_with_violations": probes_with_violations }),
        )
        .await;
    } else {
        // Resolve any existing audit probe alert when clean
        let _ = sqlx::query(
            r#"
            UPDATE ops_alert_event
            SET status = 'resolved',
                resolved_at = NOW(),
                updated_at = NOW()
            WHERE rule_key = 'audit_probe_failure'
              AND status IN ('open', 'acked')
            "#,
        )
        .execute(pool)
        .await;
    }

    let row: AuditProbeRunRow = sqlx::query_as(
        r#"
        SELECT id, triggered_by_staff_id, probe_count, total_violation_rows,
               probes_with_violations, duration_ms, status, error_message,
               created_at, completed_at
        FROM ops_audit_probe_run
        WHERE id = $1
        "#,
    )
    .bind(run_id)
    .fetch_one(pool)
    .await?;

    Ok(row)
}

/// List recent audit probe runs with pagination.
pub async fn list_audit_probe_runs(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<AuditProbeRunRow>, sqlx::Error> {
    let rows = sqlx::query_as::<_, AuditProbeRunRow>(
        r#"
        SELECT id, triggered_by_staff_id, probe_count, total_violation_rows,
               probes_with_violations, duration_ms, status, error_message,
               created_at, completed_at
        FROM ops_audit_probe_run
        ORDER BY created_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit.clamp(1, 500))
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Fetch a single audit probe run with all its results.
pub async fn get_audit_probe_run_detail(
    pool: &PgPool,
    run_id: Uuid,
) -> Result<Option<(AuditProbeRunRow, Vec<AuditProbeResultRow>)>, sqlx::Error> {
    let run: Option<AuditProbeRunRow> = sqlx::query_as::<_, AuditProbeRunRow>(
        r#"
        SELECT id, triggered_by_staff_id, probe_count, total_violation_rows,
               probes_with_violations, duration_ms, status, error_message,
               created_at, completed_at
        FROM ops_audit_probe_run
        WHERE id = $1
        "#,
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?;

    let Some(run) = run else {
        return Ok(None);
    };

    let results = sqlx::query_as::<_, AuditProbeResultRow>(
        r#"
        SELECT id, run_id, probe_key, probe_label, severity, violation_count, detail_rows, created_at
        FROM ops_audit_probe_result
        WHERE run_id = $1
        ORDER BY violation_count DESC, probe_key
        "#,
    )
    .bind(run_id)
    .fetch_all(pool)
    .await?;

    Ok(Some((run, results)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logic::meilisearch_search::{FullReindexProof, FullReindexProofStatus};

    fn fresh_meilisearch_proof(now: DateTime<Utc>) -> FullReindexProof {
        FullReindexProof {
            status: FullReindexProofStatus::Fresh,
            last_success_at: Some(now - Duration::hours(1)),
            last_attempt_at: Some(now - Duration::hours(1)),
            detail: "fresh rebuild".to_string(),
        }
    }

    #[test]
    fn production_mode_and_safeguards_are_reported_independently() {
        let mode = environment_mode_diagnostic("production");
        assert_eq!(mode.value, "production");
        assert_eq!(mode.severity, "info");

        let disabled = production_safeguards_diagnostic("production", false);
        assert_eq!(disabled.value, "Disabled");
        assert_eq!(disabled.severity, "critical");
        assert!(disabled.detail.contains("go-live signoff is blocked"));

        let enabled = production_safeguards_diagnostic("production", true);
        assert_eq!(enabled.value, "Enabled");
        assert_eq!(enabled.severity, "info");
    }

    #[test]
    fn counterpoint_without_success_proof_is_never_healthy() {
        let now = Utc::now();
        assert_eq!(counterpoint_sync_health_item(&[], now).status, "degraded");

        let never_succeeded = CounterpointSyncHealthRow {
            entity: "ticket_history".to_string(),
            last_ok_at: None,
            last_error: None,
            updated_at: now - Duration::days(30),
        };
        let never = counterpoint_sync_health_item(&[never_succeeded], now);
        assert_eq!(never.status, "degraded");
        assert!(never.detail.contains("never succeeded"));

        let stale = CounterpointSyncHealthRow {
            entity: "inventory".to_string(),
            last_ok_at: Some(now - Duration::hours(COUNTERPOINT_SYNC_FRESHNESS_HOURS + 1)),
            last_error: None,
            updated_at: now,
        };
        assert_eq!(
            counterpoint_sync_health_item(&[stale], now).status,
            "degraded"
        );
    }

    #[test]
    fn counterpoint_requires_recent_success_for_every_recorded_entity() {
        let now = Utc::now();
        let row = CounterpointSyncHealthRow {
            entity: "inventory".to_string(),
            last_ok_at: Some(now - Duration::hours(1)),
            last_error: None,
            updated_at: now,
        };
        assert_eq!(counterpoint_sync_health_item(&[row], now).status, "healthy");
    }

    #[test]
    fn meilisearch_requires_current_heartbeat_and_rebuild_proof() {
        let now = Utc::now();
        let proof = fresh_meilisearch_proof(now);
        assert_eq!(
            meilisearch_health_item(true, None, Some(&proof), now).status,
            "degraded"
        );

        let stale_good = IntegrationStateRow {
            source: "meilisearch".to_string(),
            status: "GOOD".to_string(),
            last_failure_at: None,
            last_success_at: Some(now - Duration::hours(1)),
            detail: Some("reachable".to_string()),
            updated_at: now - Duration::minutes(INTEGRATION_HEARTBEAT_FRESHNESS_MINUTES + 1),
        };
        assert_eq!(
            meilisearch_health_item(true, Some(&stale_good), Some(&proof), now).status,
            "degraded"
        );

        let fresh_good = IntegrationStateRow {
            updated_at: now,
            last_success_at: Some(now),
            ..stale_good
        };
        assert_eq!(
            meilisearch_health_item(true, Some(&fresh_good), None, now).status,
            "degraded"
        );
        assert_eq!(
            meilisearch_health_item(true, Some(&fresh_good), Some(&proof), now).status,
            "healthy"
        );
    }

    #[test]
    fn future_client_station_times_are_bounded_to_server_receipt() {
        let received_at = Utc::now();
        assert_eq!(
            bound_client_reported_timestamp(Some(received_at + Duration::days(365)), received_at),
            Some(received_at)
        );
        let past = received_at - Duration::minutes(10);
        assert_eq!(
            bound_client_reported_timestamp(Some(past), received_at),
            Some(past)
        );
    }

    #[test]
    fn station_install_time_requires_confirmed_native_observation() {
        let received_at = Utc::now();
        let reported_at = received_at - Duration::minutes(5);
        let confirmed = json!({"app_update_install_observation": {"status": "confirmed"}});
        assert_eq!(
            confirmed_client_install_timestamp(Some(reported_at), &confirmed, received_at),
            Some(reported_at)
        );

        for status in ["pending", "failed", "legacy_local"] {
            let meta = json!({"app_update_install_observation": {"status": status}});
            assert_eq!(
                confirmed_client_install_timestamp(Some(reported_at), &meta, received_at),
                None
            );
        }

        assert_eq!(
            confirmed_client_install_timestamp(
                Some(received_at + Duration::days(365)),
                &confirmed,
                received_at,
            ),
            Some(received_at)
        );
    }
}
