//! ROS Dev Center API: health, stations, alerts, guarded actions, and bug overlays.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_core::stream::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::time::Duration;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{OPS_DEV_CENTER_ACTIONS, OPS_DEV_CENTER_VIEW};
use crate::logic::bug_reports;
use crate::logic::ops_dev_center::{self, GuardedActionResult, StationHeartbeatIn};
use crate::logic::rosie_provider_selection::{select_llm_provider, QueryType, RosieProviderConfig};
use crate::logic::update_check;
use crate::middleware;

const MAX_SERVER_ERROR_LOG_SNAPSHOT_BYTES: usize = 240_000;

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

async fn record_server_api_error(
    state: &AppState,
    route: &str,
    message: &str,
    error: &sqlx::Error,
) {
    let server_log_snapshot = state
        .server_log_ring
        .snapshot_text(MAX_SERVER_ERROR_LOG_SNAPSHOT_BYTES);
    let meta = json!({
        "source": "server_api_error",
        "route": route,
        "error": error.to_string(),
    });
    match bug_reports::upsert_server_error_event(
        &state.db,
        &format!("server_api_error:{route}"),
        message,
        "server_api_error",
        "error",
        Some(route),
        &meta,
        &server_log_snapshot,
    )
    .await
    {
        Ok(recorded) => {
            if recorded.inserted {
                let pool_n = state.db.clone();
                let route = route.to_string();
                let message = message.to_string();
                tokio::spawn(async move {
                    if let Err(e) = bug_reports::notify_error_event_email_recipients(
                        &pool_n,
                        recorded.id,
                        None,
                        &message,
                        "server_api_error",
                        "error",
                        Some(&route),
                    )
                    .await
                    {
                        tracing::error!(error = %e, "server error email notification failed");
                    }
                });
            }
        }
        Err(e) => {
            tracing::error!(
                error = %e,
                source_error = %error,
                route,
                "failed to record server api error as staff error event"
            );
        }
    }
}

fn json_payload_len(value: &Value) -> usize {
    serde_json::to_vec(value)
        .map(|b| b.len())
        .unwrap_or(usize::MAX)
}

fn rosie_provider_label_from_completion(body: &Value) -> &'static str {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if model.contains("gemini") {
        "gemini"
    } else {
        "local"
    }
}

async fn require_view(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<crate::auth::pins::AuthenticatedStaff, Response> {
    middleware::require_staff_with_permission(state, headers, OPS_DEV_CENTER_VIEW)
        .await
        .map_err(|e| e.into_response())
}

async fn require_actions(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<crate::auth::pins::AuthenticatedStaff, Response> {
    middleware::require_staff_with_permission(state, headers, OPS_DEV_CENTER_ACTIONS)
        .await
        .map_err(|e| e.into_response())
}

async fn get_health_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ops_dev_center::OpsHealthSnapshot>, Response> {
    let _ = require_view(&state, &headers).await?;

    let server_log_snapshot = state
        .server_log_ring
        .snapshot_text(MAX_SERVER_ERROR_LOG_SNAPSHOT_BYTES);
    let snapshot = match ops_dev_center::health_snapshot(
        &state.db,
        &state.http_client,
        state.meilisearch.as_ref(),
        &server_log_snapshot,
    )
    .await
    {
        Ok(snapshot) => snapshot,
        Err(e) => {
            record_server_api_error(
                &state,
                "/api/ops/overview",
                "Operations overview failed to load on the server",
                &e,
            )
            .await;
            tracing::error!(error = %e, "ops health snapshot failed");
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not build ops health snapshot" })),
            )
                .into_response());
        }
    };

    Ok(Json(snapshot))
}

async fn get_ops_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ops_dev_center::OpsHealthSnapshot>, Response> {
    get_health_snapshot(State(state), headers).await
}

async fn get_ops_integrations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ops_dev_center::IntegrationHealthItem>>, Response> {
    let _ = require_view(&state, &headers).await?;
    let rows =
        match ops_dev_center::collect_integrations(&state.db, state.meilisearch.is_some()).await {
            Ok(rows) => rows,
            Err(e) => {
                record_server_api_error(
                    &state,
                    "/api/ops/integrations",
                    "Integration health failed to load on the server",
                    &e,
                )
                .await;
                tracing::error!(error = %e, "ops integrations failed");
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "could not load integration status" })),
                )
                    .into_response());
            }
        };
    Ok(Json(rows))
}

async fn get_runtime_diagnostics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ops_dev_center::RuntimeDiagnosticsSnapshot>, Response> {
    let _ = require_view(&state, &headers).await?;
    let snapshot =
        match ops_dev_center::runtime_diagnostics_snapshot(&state.db, state.meilisearch.is_some())
            .await
        {
            Ok(snapshot) => snapshot,
            Err(e) => {
                record_server_api_error(
                    &state,
                    "/api/ops/runtime-diagnostics",
                    "Runtime diagnostics failed to load on the server",
                    &e,
                )
                .await;
                tracing::error!(error = %e, "ops runtime diagnostics failed");
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "could not load runtime diagnostics" })),
                )
                    .into_response());
            }
        };
    Ok(Json(snapshot))
}

async fn get_e2e_health(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ops_dev_center::E2eHealthSnapshot>, Response> {
    let _ = require_view(&state, &headers).await?;
    Ok(Json(
        ops_dev_center::e2e_health_snapshot(&state.db, &state.http_client).await,
    ))
}

async fn post_station_heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<StationHeartbeatIn>,
) -> Result<Json<Value>, Response> {
    let _ = middleware::require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|e| e.into_response())?;

    if body.station_key.trim().is_empty() || body.app_version.trim().is_empty() {
        return Err(bad_request("station_key and app_version are required"));
    }

    ops_dev_center::upsert_station_heartbeat(&state.db, &body)
        .await
        .map_err(|e| {
            if matches!(e, sqlx::Error::Protocol(_)) {
                return bad_request("invalid heartbeat payload");
            }
            tracing::error!(error = %e, "ops station heartbeat failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not save station heartbeat" })),
            )
                .into_response()
        })?;

    Ok(Json(json!({ "ok": true })))
}

async fn get_ops_stations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ops_dev_center::StationRow>>, Response> {
    let _ = require_view(&state, &headers).await?;
    let rows = match ops_dev_center::list_stations(&state.db).await {
        Ok(rows) => rows,
        Err(e) => {
            record_server_api_error(
                &state,
                "/api/ops/stations",
                "Station fleet failed to load on the server",
                &e,
            )
            .await;
            tracing::error!(error = %e, "ops list stations failed");
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not load station fleet" })),
            )
                .into_response());
        }
    };
    Ok(Json(rows))
}

async fn get_readiness_signoffs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ops_dev_center::ReadinessSignoffRow>>, Response> {
    let _ = require_view(&state, &headers).await?;
    let rows = ops_dev_center::list_readiness_signoffs(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "ops readiness signoffs failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not load readiness signoffs" })),
            )
                .into_response()
        })?;
    Ok(Json(rows))
}

async fn post_readiness_signoff(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(check_key): Path<String>,
    Json(body): Json<ops_dev_center::ReadinessSignoffInput>,
) -> Result<Json<ops_dev_center::ReadinessSignoffRow>, Response> {
    let staff = require_actions(&state, &headers).await?;
    if check_key.trim().is_empty() {
        return Err(bad_request("check_key is required"));
    }
    let row = ops_dev_center::save_readiness_signoff(&state.db, &check_key, body, staff.id)
        .await
        .map_err(|e| {
            if matches!(e, sqlx::Error::Protocol(_)) {
                return bad_request(&e.to_string());
            }
            tracing::error!(error = %e, "ops readiness signoff save failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not save readiness signoff" })),
            )
                .into_response()
        })?;
    Ok(Json(row))
}

async fn get_ops_alerts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ops_dev_center::AlertEventRow>>, Response> {
    let _ = require_view(&state, &headers).await?;
    let rows = match ops_dev_center::list_alerts(&state.db).await {
        Ok(rows) => rows,
        Err(e) => {
            record_server_api_error(
                &state,
                "/api/ops/alerts",
                "Operational alerts failed to load on the server",
                &e,
            )
            .await;
            tracing::error!(error = %e, "ops list alerts failed");
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not load alerts" })),
            )
                .into_response());
        }
    };
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
struct AckAlertBody {
    alert_id: Uuid,
}

async fn post_ops_alert_ack(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AckAlertBody>,
) -> Result<Json<Value>, Response> {
    let staff = require_actions(&state, &headers).await?;
    let ok = ops_dev_center::ack_alert(&state.db, body.alert_id, staff.id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "ops ack alert failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not acknowledge alert" })),
            )
                .into_response()
        })?;

    if !ok {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "alert not found or already non-open" })),
        )
            .into_response());
    }

    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct GuardedActionBody {
    reason: String,
    #[serde(default)]
    payload: Value,
    #[serde(default)]
    confirm_primary: bool,
    #[serde(default)]
    confirm_secondary: bool,
}

async fn post_ops_action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(action_key): Path<String>,
    Json(body): Json<GuardedActionBody>,
) -> Result<Response, Response> {
    let staff = require_actions(&state, &headers).await?;

    if !body.confirm_primary || !body.confirm_secondary {
        return Err(bad_request(
            "guarded action requires confirm_primary=true and confirm_secondary=true",
        ));
    }
    if !ops_dev_center::is_allowed_action_key(&action_key) {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": "unknown action key",
                "allowed": ops_dev_center::allowed_action_keys(),
            })),
        )
            .into_response());
    }
    let reason = body.reason.trim();
    if reason.is_empty() {
        return Err(bad_request("reason is required"));
    }
    if reason.chars().count() > 500 {
        return Err(bad_request("reason exceeds 500 characters"));
    }
    if json_payload_len(&body.payload) > 32 * 1024 {
        return Err(bad_request("payload exceeds 32KB"));
    }

    let result: GuardedActionResult = ops_dev_center::run_guarded_action(
        &state.db,
        state.meilisearch.as_ref(),
        state.cache.as_ref(),
        &state.server_log_ring,
        &action_key,
        &body.payload,
    )
    .await;

    let audit = ops_dev_center::write_action_audit(
        &state.db,
        staff.id,
        &action_key,
        reason,
        &body.payload,
        &result,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "ops action audit write failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "guarded action result recorded failed" })),
        )
            .into_response()
    })?;

    let status = if result.ok {
        StatusCode::OK
    } else {
        StatusCode::BAD_REQUEST
    };

    Ok((
        status,
        Json(json!({
            "ok": result.ok,
            "message": result.message,
            "data": result.data,
            "audit": {
                "id": audit.id,
                "correlation_id": audit.correlation_id,
                "created_at": audit.created_at,
                "action_key": audit.action_key,
            }
        })),
    )
        .into_response())
}

async fn get_ops_audit_log(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ops_dev_center::ActionAuditRow>>, Response> {
    let _ = require_view(&state, &headers).await?;
    let rows = ops_dev_center::list_action_audit(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "ops list action audit failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not load action audit" })),
            )
                .into_response()
        })?;
    Ok(Json(rows))
}

async fn get_audit_probe_runs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ops_dev_center::AuditProbeRunRow>>, Response> {
    let _ = require_view(&state, &headers).await?;
    let rows = ops_dev_center::list_audit_probe_runs(&state.db, 50)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "ops list audit probe runs failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not load audit probe runs" })),
            )
                .into_response()
        })?;
    Ok(Json(rows))
}

async fn post_run_audit_probes(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ops_dev_center::AuditProbeRunRow>, Response> {
    let staff = require_view(&state, &headers).await?;
    let row = ops_dev_center::execute_audit_probes(&state.db, Some(staff.id))
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "ops run audit probes failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "audit probe execution failed" })),
            )
                .into_response()
        })?;
    Ok(Json(row))
}

async fn get_audit_probe_run_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, Response> {
    let _ = require_view(&state, &headers).await?;
    let detail = ops_dev_center::get_audit_probe_run_detail(&state.db, run_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "ops get audit probe detail failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not load audit probe detail" })),
            )
                .into_response()
        })?;

    let value = match detail {
        Some((run, results)) => json!({
            "run": run,
            "results": results,
        }),
        None => json!({ "error": "not found" }),
    };
    Ok(Json(value))
}

async fn get_update_check(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, Response> {
    let _ = middleware::require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|e| e.into_response())?;
    match update_check::check_for_update(&state.http_client).await {
        Ok(result) => Ok(Json(serde_json::to_value(result).unwrap_or_default())),
        Err(e) => Err((StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))).into_response()),
    }
}

// --- GitHub DevOps Center proxy endpoints ---

const GITHUB_API_BASE: &str = "https://api.github.com";
const GITHUB_REPO: &str = "cpg716/riverside-os";

async fn github_api_get(
    client: &reqwest::Client,
    token: &str,
    path: &str,
) -> Result<Value, String> {
    let url = format!("{GITHUB_API_BASE}{path}");
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "RiversideOS-DevCenter")
        .send()
        .await
        .map_err(|e| format!("GitHub request failed: {e}"))?;

    let status = resp.status();
    let body = resp
        .json::<Value>()
        .await
        .map_err(|e| format!("GitHub response parse failed: {e}"))?;

    if !status.is_success() {
        return Err(format!("GitHub API error {status}: {body}"));
    }
    Ok(body)
}

async fn github_api_post(
    client: &reqwest::Client,
    token: &str,
    path: &str,
    payload: Value,
) -> Result<Value, String> {
    let url = format!("{GITHUB_API_BASE}{path}");
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "RiversideOS-DevCenter")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("GitHub request failed: {e}"))?;

    let status = resp.status();
    let body = resp
        .json::<Value>()
        .await
        .map_err(|e| format!("GitHub response parse failed: {e}"))?;

    if !status.is_success() {
        return Err(format!("GitHub API error {status}: {body}"));
    }
    Ok(body)
}

async fn get_github_workflows(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, Response> {
    let _ = require_view(&state, &headers).await?;
    let token = state.github_token.as_deref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "RIVERSIDE_GITHUB_TOKEN not configured"})),
        )
            .into_response()
    })?;
    let data = github_api_get(
        &state.http_client,
        token,
        &format!("/repos/{GITHUB_REPO}/actions/runs?per_page=10"),
    )
    .await
    .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({"error": e}))).into_response())?;
    Ok(Json(data))
}

async fn get_github_releases(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, Response> {
    let _ = require_view(&state, &headers).await?;
    let token = state.github_token.as_deref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "RIVERSIDE_GITHUB_TOKEN not configured"})),
        )
            .into_response()
    })?;
    let data = github_api_get(
        &state.http_client,
        token,
        &format!("/repos/{GITHUB_REPO}/releases?per_page=10"),
    )
    .await
    .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({"error": e}))).into_response())?;
    Ok(Json(data))
}

#[derive(Deserialize)]
struct GitHubDispatchBody {
    workflow_id: String,
    branch: String,
    inputs: Option<Value>,
}

async fn post_github_dispatch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<GitHubDispatchBody>,
) -> Result<Json<Value>, Response> {
    let _ = require_actions(&state, &headers).await?;
    let token = state.github_token.as_deref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "RIVERSIDE_GITHUB_TOKEN not configured"})),
        )
            .into_response()
    })?;

    let payload = json!({
        "ref": body.branch,
        "inputs": body.inputs.unwrap_or_else(|| json!({}))
    });

    let path = format!(
        "/repos/{GITHUB_REPO}/actions/workflows/{}/dispatches",
        body.workflow_id
    );
    let data = github_api_post(&state.http_client, token, &path, payload)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({"error": e}))).into_response())?;
    Ok(Json(data))
}

// --- Comprehensive Diagnostics & AI Prompt ---

#[derive(serde::Serialize)]
struct DiagnosticsSnapshot {
    generated_at: String,
    server: ServerDiagnostics,
    database: DatabaseDiagnostics,
    errors: Vec<LogEntry>,
    warnings: Vec<LogEntry>,
    github: GitHubStatus,
    ai_prompt: String,
}

#[derive(serde::Serialize)]
struct ServerDiagnostics {
    version: String,
    uptime_seconds: u64,
    rust_version: String,
}

#[derive(serde::Serialize)]
struct DatabaseDiagnostics {
    connected: bool,
    pool_size: u32,
    active_connections: u32,
    idle_connections: u32,
    migration_count: i64,
}

#[derive(serde::Serialize)]
struct LogEntry {
    timestamp: String,
    level: String,
    target: String,
    message: String,
}

#[derive(serde::Serialize)]
struct GitHubStatus {
    token_configured: bool,
}

async fn get_diagnostics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DiagnosticsSnapshot>, Response> {
    let _ = require_view(&state, &headers).await?;

    let server = ServerDiagnostics {
        version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_seconds: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(), // Simplified; real uptime would need start tracking
        rust_version: {
            let v = rustc_version_runtime::version();
            format!("{}.{}.{}", v.major, v.minor, v.patch)
        },
    };

    // Database diagnostics
    let db_diag = match check_db_diagnostics(&state.db).await {
        Ok(d) => d,
        Err(_) => DatabaseDiagnostics {
            connected: false,
            pool_size: 0,
            active_connections: 0,
            idle_connections: 0,
            migration_count: 0,
        },
    };

    // Parse server log ring for errors and warnings (keep scan small for local LLM)
    let log_snapshot = state.server_log_ring.snapshot_text(32_000);
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    for line in log_snapshot.lines() {
        if line.contains(" ERROR ") {
            if let Some(entry) = parse_log_line(line) {
                errors.push(entry);
            }
        } else if line.contains(" WARN ") {
            if let Some(entry) = parse_log_line(line) {
                warnings.push(entry);
            }
        }
    }

    // Limit entries (local 4B model chokes on huge prompts)
    errors.truncate(10);
    warnings.truncate(10);

    let github = GitHubStatus {
        token_configured: state.github_token.is_some(),
    };

    let ai_prompt = generate_ai_prompt(&server, &db_diag, &errors, &warnings, &github);

    Ok(Json(DiagnosticsSnapshot {
        generated_at: chrono::Utc::now().to_rfc3339(),
        server,
        database: db_diag,
        errors,
        warnings,
        github,
        ai_prompt,
    }))
}

async fn check_db_diagnostics(pool: &sqlx::PgPool) -> Result<DatabaseDiagnostics, sqlx::Error> {
    let _: i32 = sqlx::query_scalar("SELECT 1").fetch_one(pool).await?;
    let pool_size = pool.size();
    let idle = pool.num_idle() as u32;
    let active = pool_size.saturating_sub(idle);

    let migration_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await
        .unwrap_or(0);

    Ok(DatabaseDiagnostics {
        connected: true,
        pool_size,
        active_connections: active,
        idle_connections: idle,
        migration_count,
    })
}

fn parse_log_line(line: &str) -> Option<LogEntry> {
    // Format: "YYYY-MM-DDTHH:MM:SS.mmmZ LEVEL target message"
    let parts: Vec<&str> = line.splitn(4, ' ').collect();
    if parts.len() >= 3 {
        let ts = parts[0].to_string();
        let level = parts[1].trim().to_string();
        let target = parts.get(2).unwrap_or(&"").to_string();
        let message = parts.get(3).unwrap_or(&"").to_string();
        Some(LogEntry {
            timestamp: ts,
            level,
            target,
            message,
        })
    } else {
        None
    }
}

fn generate_ai_prompt(
    server: &ServerDiagnostics,
    db: &DatabaseDiagnostics,
    errors: &[LogEntry],
    warnings: &[LogEntry],
    github: &GitHubStatus,
) -> String {
    let mut prompt = String::new();
    prompt.push_str("# Riverside OS Diagnostic Report\n\n");
    prompt.push_str(&format!("**Version:** {}\n", server.version));
    prompt.push_str(&format!("**Rust:** {}\n", server.rust_version));
    prompt.push_str(&format!("**DB Connected:** {}\n", db.connected));
    prompt.push_str(&format!(
        "**DB Pool:** {}/{} active ({} idle)\n",
        db.active_connections, db.pool_size, db.idle_connections
    ));
    prompt.push_str(&format!("**Migrations:** {} applied\n", db.migration_count));
    prompt.push_str(&format!(
        "**GitHub Token:** {}\n",
        if github.token_configured {
            "configured"
        } else {
            "NOT CONFIGURED"
        }
    ));

    if !errors.is_empty() {
        prompt.push_str("\n## Recent Errors (last 10)\n\n");
        for e in errors.iter().take(5) {
            prompt.push_str(&format!(
                "- `[{}]` `{}` — {}\n",
                e.timestamp, e.target, e.message
            ));
        }
    }

    if !warnings.is_empty() {
        prompt.push_str("\n## Recent Warnings (last 10)\n\n");
        for w in warnings.iter().take(5) {
            prompt.push_str(&format!(
                "- `[{}]` `{}` — {}\n",
                w.timestamp, w.target, w.message
            ));
        }
    }

    prompt.push_str("\n## AI Analysis Request\n\n");
    prompt.push_str(
        "Briefly analyze the above and suggest 1–2 fixes. Be specific about files and lines.\n",
    );

    // Hard cap: local 4B models tokenize slowly; keep prompt under ~4K chars
    const MAX_PROMPT_CHARS: usize = 4_000;
    if prompt.len() > MAX_PROMPT_CHARS {
        prompt.truncate(MAX_PROMPT_CHARS);
        prompt.push_str("\n[truncated]\n");
    }

    prompt
}

#[derive(Deserialize)]
struct DiagnosticsAnalyzeBody {
    prompt: String,
}

async fn post_diagnostics_analyze(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<DiagnosticsAnalyzeBody>,
) -> Result<Json<Value>, Response> {
    let _ = require_view(&state, &headers).await?;

    let llm_payload = json!({
        "model": "local",
        "messages": [
            { "role": "system", "content": "You are ROSIE, the Riverside OS AI assistant. Analyze diagnostic data and provide concise, actionable fixes. Always include specific file paths and line-level suggestions when possible." },
            { "role": "user", "content": body.prompt }
        ],
        "temperature": 0.3,
        "max_tokens": 2048
    });

    let provider =
        match select_llm_provider(&RosieProviderConfig::default(), QueryType::Analysis).await {
            Ok(provider) => provider,
            Err(error) => {
                return Ok(Json(json!({
                    "error": format!("ROSIE provider unavailable: {error}"),
                    "rosie_available": false
                })));
            }
        };

    let data = provider
        .chat_completion_payload(llm_payload)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "rosie diagnostics analyze failed");
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": format!("ROSIE provider failed: {e}")})),
            )
                .into_response()
        })?;

    crate::logic::rosie_intelligence::record_telemetry_from_value(
        state.db.clone(),
        rosie_provider_label_from_completion(&data),
        &data,
    );

    // Extract the message content from the completion
    let content = data
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("(no content in ROSIE response)");

    Ok(Json(json!({
        "analysis": content,
        "rosie_available": true,
        "model": data.get("model").and_then(|m| m.as_str()).unwrap_or("unknown")
    })))
}

async fn get_bugs_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ops_dev_center::BugOverviewRow>>, Response> {
    let _ = require_view(&state, &headers).await?;
    let rows = ops_dev_center::list_bug_overview(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "ops bug overview failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not load bug overview" })),
            )
                .into_response()
        })?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
struct LinkBugAlertBody {
    bug_report_id: Uuid,
    alert_event_id: Uuid,
    #[serde(default)]
    note: String,
}

async fn post_bug_alert_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LinkBugAlertBody>,
) -> Result<Json<Value>, Response> {
    let staff = require_actions(&state, &headers).await?;
    if body.note.chars().count() > 1200 {
        return Err(bad_request("note exceeds 1200 characters"));
    }
    ops_dev_center::link_bug_to_alert(
        &state.db,
        body.bug_report_id,
        body.alert_event_id,
        staff.id,
        body.note.trim(),
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "ops bug-alert link failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "could not link bug to alert" })),
        )
            .into_response()
    })?;

    Ok(Json(json!({ "ok": true })))
}

async fn stream_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>> + Send>, Response> {
    let _ = require_view(&state, &headers).await?;

    let receiver = state.server_log_ring.subscribe();
    let stream = BroadcastStream::new(receiver).filter_map(|item| match item {
        Ok(line) => Some(Ok(Event::default().data(line))),
        Err(BroadcastStreamRecvError::Lagged(n)) => {
            tracing::warn!(skipped = n, "Ops logs stream client lagged");
            None
        }
    });

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

async fn get_connectivity_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<crate::logic::integration_heartbeat::ConnectivityLog>>, Response> {
    let _ = require_view(&state, &headers).await?;
    let logs = crate::logic::integration_heartbeat::get_connectivity_logs(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "ops get connectivity logs failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not load connectivity logs" })),
            )
                .into_response()
        })?;
    Ok(Json(logs))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health/snapshot", get(get_health_snapshot))
        .route("/overview", get(get_ops_overview))
        .route("/integrations", get(get_ops_integrations))
        .route("/runtime-diagnostics", get(get_runtime_diagnostics))
        .route("/e2e-health", get(get_e2e_health))
        .route("/stations", get(get_ops_stations))
        .route("/stations/heartbeat", post(post_station_heartbeat))
        .route("/readiness/signoffs", get(get_readiness_signoffs))
        .route(
            "/readiness/signoffs/{check_key}",
            post(post_readiness_signoff),
        )
        .route("/alerts", get(get_ops_alerts))
        .route("/alerts/ack", post(post_ops_alert_ack))
        .route("/actions/{action_key}", post(post_ops_action))
        .route("/audit-log", get(get_ops_audit_log))
        .route(
            "/audit-probes",
            get(get_audit_probe_runs).post(post_run_audit_probes),
        )
        .route("/audit-probes/{run_id}", get(get_audit_probe_run_detail))
        .route("/github/workflows", get(get_github_workflows))
        .route("/github/releases", get(get_github_releases))
        .route("/github/dispatch", post(post_github_dispatch))
        .route("/diagnostics", get(get_diagnostics))
        .route("/diagnostics/analyze", post(post_diagnostics_analyze))
        .route("/bugs/overview", get(get_bugs_overview))
        .route("/bugs/link-alert", post(post_bug_alert_link))
        .route("/logs/stream", get(stream_logs))
        .route("/connectivity-logs", get(get_connectivity_logs))
        .route("/update-check", get(get_update_check))
}
