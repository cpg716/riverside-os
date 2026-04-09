//! Staff bug reports: submit (any authenticated staff) and admin triage under `/api/settings/bug-reports`.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::SETTINGS_ADMIN;
use crate::logic::bug_reports::{self, BugReportDetailRow, BugReportListRow, BugReportStatus};
use crate::middleware;

const MAX_SUMMARY_LEN: usize = 12_000;
const MAX_STEPS_LEN: usize = 24_000;
const MAX_CONSOLE_LEN: usize = 600_000;
/// ~6.5 MiB PNG decoded
const MAX_SCREENSHOT_BYTES: usize = 6_800_000;
/// Keep PostgreSQL `TEXT` payloads reasonable; ring snapshot is pre-truncated in memory too.
const MAX_SERVER_LOG_SNAPSHOT_BYTES: usize = 480_000;
const MAX_RESOLVER_NOTES_LEN: usize = 16_000;
const MAX_EXTERNAL_URL_LEN: usize = 2048;
/// PNG file signature (first 8 bytes).
const PNG_MAGIC: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
/// At most this many reports per staff member in the rolling window (anti-spam).
const MAX_SUBMITS_PER_STAFF_WINDOW: i64 = 12;
const SUBMIT_RATE_WINDOW_MINUTES: i64 = 15;
/// Extra JSON from the client (viewport, UA, etc.) — keep bounded.
const MAX_CLIENT_META_JSON_BYTES: usize = 65_536;

#[derive(Debug, Deserialize)]
pub struct SubmitBugReportBody {
    pub summary: String,
    pub steps_context: String,
    #[serde(default)]
    pub client_console_log: String,
    #[serde(default)]
    pub client_meta: serde_json::Value,
    /// When false, clients should skip heavy screenshot capture (server still expects a tiny PNG).
    #[serde(default = "default_true")]
    pub include_screenshot: bool,
    /// Raw base64 (no data: URL prefix required).
    pub screenshot_png_base64: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
struct SubmitBugReportResponse {
    id: Uuid,
    correlation_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct PatchBugReportBody {
    #[serde(default)]
    pub status: Option<BugReportStatus>,
    #[serde(default)]
    pub resolver_notes: Option<String>,
    #[serde(default)]
    pub external_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BugReportDetailResponse {
    pub id: Uuid,
    pub correlation_id: Uuid,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub status: BugReportStatus,
    pub summary: String,
    pub steps_context: String,
    pub client_console_log: String,
    pub client_meta: serde_json::Value,
    pub screenshot_png_base64: String,
    pub server_log_snapshot: String,
    pub resolver_notes: String,
    pub external_url: String,
    pub staff_id: Uuid,
    pub staff_name: String,
    pub resolved_at: Option<chrono::DateTime<chrono::Utc>>,
    pub resolver_name: Option<String>,
}

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

fn too_many_reports() -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({
            "error": format!(
                "bug report limit reached (max {MAX_SUBMITS_PER_STAFF_WINDOW} per {SUBMIT_RATE_WINDOW_MINUTES} minutes per staff) — try again later"
            )
        })),
    )
        .into_response()
}

async fn submit_bug_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SubmitBugReportBody>,
) -> Result<Response, Response> {
    let staff = middleware::require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|e| e.into_response())?;

    let window_start = chrono::Utc::now() - chrono::Duration::minutes(SUBMIT_RATE_WINDOW_MINUTES);
    let recent = bug_reports::count_bug_reports_since(&state.db, staff.id, window_start)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "count_bug_reports_since failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not verify submit quota" })),
            )
                .into_response()
        })?;
    if recent >= MAX_SUBMITS_PER_STAFF_WINDOW {
        return Err(too_many_reports());
    }

    let correlation_id = Uuid::new_v4();
    tracing::info!(
        correlation_id = %correlation_id,
        staff_id = %staff.id,
        include_screenshot = body.include_screenshot,
        "bug report submit received"
    );

    let summary = body.summary.trim();
    let steps = body.steps_context.trim();
    if summary.is_empty() {
        return Err(bad_request("summary required"));
    }
    if steps.is_empty() {
        return Err(bad_request("steps_context required"));
    }
    if summary.len() > MAX_SUMMARY_LEN || steps.len() > MAX_STEPS_LEN {
        return Err(bad_request("description too long"));
    }

    let mut console = body.client_console_log;
    if console.len() > MAX_CONSOLE_LEN {
        console.truncate(MAX_CONSOLE_LEN);
        console.push_str("\n… [truncated]");
    }

    let b64 = body.screenshot_png_base64.trim();
    let b64 = b64.strip_prefix("data:image/png;base64,").unwrap_or(b64);
    let png = B64
        .decode(b64)
        .map_err(|_| bad_request("invalid screenshot base64"))?;
    if png.len() > MAX_SCREENSHOT_BYTES {
        return Err(bad_request("screenshot too large"));
    }
    if png.len() < 8 {
        return Err(bad_request("screenshot payload missing"));
    }
    if png[..8] != PNG_MAGIC {
        return Err(bad_request("screenshot must be a PNG image"));
    }

    let meta = if body.client_meta.is_null() {
        json!({})
    } else {
        body.client_meta
    };
    let meta_len = serde_json::to_string(&meta)
        .map_err(|_| bad_request("client_meta is not serializable"))?
        .len();
    if meta_len > MAX_CLIENT_META_JSON_BYTES {
        return Err(bad_request("client_meta too large"));
    }

    let server_log_snapshot = state
        .server_log_ring
        .snapshot_text(MAX_SERVER_LOG_SNAPSHOT_BYTES);

    let id = bug_reports::insert_bug_report(
        &state.db,
        staff.id,
        correlation_id,
        summary,
        steps,
        &console,
        &meta,
        &png,
        &server_log_snapshot,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "insert staff_bug_report failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "could not save report" })),
        )
            .into_response()
    })?;

    tracing::info!(
        correlation_id = %correlation_id,
        bug_report_id = %id,
        staff_id = %staff.id,
        "bug report persisted"
    );

    let pool_n = state.db.clone();
    let summary_preview = summary.to_string();
    tokio::spawn(async move {
        if let Err(e) = bug_reports::notify_settings_admins_new_report(
            &pool_n,
            id,
            correlation_id,
            &summary_preview,
        )
        .await
        {
            tracing::error!(error = %e, "notify_settings_admins_new_report failed");
        }
    });

    let mut res = Json(SubmitBugReportResponse { id, correlation_id }).into_response();
    if let Ok(v) = HeaderValue::from_str(&correlation_id.to_string()) {
        res.headers_mut()
            .insert(HeaderName::from_static("x-bug-report-correlation-id"), v);
    }
    Ok(res)
}

async fn require_settings_admin(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<crate::auth::pins::AuthenticatedStaff, Response> {
    middleware::require_staff_with_permission(state, headers, SETTINGS_ADMIN)
        .await
        .map_err(|e| e.into_response())
}

async fn list_bug_reports(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<BugReportListRow>>, Response> {
    let _ = require_settings_admin(&state, &headers).await?;
    let rows = bug_reports::list_bug_reports(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "list_bug_reports failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "list failed" })),
            )
                .into_response()
        })?;
    Ok(Json(rows))
}

async fn get_bug_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<BugReportDetailResponse>, Response> {
    let _ = require_settings_admin(&state, &headers).await?;
    let row = bug_reports::get_bug_report(&state.db, id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "get_bug_report failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "load failed" })),
            )
                .into_response()
        })?;
    let Some(r) = row else {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response());
    };
    Ok(Json(detail_row_to_response(r)))
}

fn detail_row_to_response(r: BugReportDetailRow) -> BugReportDetailResponse {
    let BugReportDetailRow {
        id,
        correlation_id,
        created_at,
        updated_at,
        status,
        summary,
        steps_context,
        client_console_log,
        client_meta,
        screenshot_png,
        server_log_snapshot,
        resolver_notes,
        external_url,
        staff_id,
        staff_name,
        resolved_at,
        resolver_name,
    } = r;
    BugReportDetailResponse {
        id,
        correlation_id,
        created_at,
        updated_at,
        status,
        summary,
        steps_context,
        client_console_log,
        client_meta,
        screenshot_png_base64: B64.encode(screenshot_png),
        server_log_snapshot,
        resolver_notes,
        external_url,
        staff_id,
        staff_name,
        resolved_at,
        resolver_name,
    }
}

async fn patch_bug_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchBugReportBody>,
) -> Result<Json<BugReportDetailResponse>, Response> {
    let actor = require_settings_admin(&state, &headers).await?;
    if body.status.is_none() && body.resolver_notes.is_none() && body.external_url.is_none() {
        return Err(bad_request("no fields to update"));
    }
    if let Some(ref s) = body.resolver_notes {
        if s.len() > MAX_RESOLVER_NOTES_LEN {
            return Err(bad_request("resolver_notes too long"));
        }
    }
    if let Some(ref s) = body.external_url {
        if s.len() > MAX_EXTERNAL_URL_LEN {
            return Err(bad_request("external_url too long"));
        }
    }

    let ok = bug_reports::patch_bug_report(
        &state.db,
        id,
        actor.id,
        body.status,
        body.resolver_notes.as_deref(),
        body.external_url.as_deref(),
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "patch_bug_report failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "update failed" })),
        )
            .into_response()
    })?;
    if !ok {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response());
    }
    let row = bug_reports::get_bug_report(&state.db, id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "get_bug_report after patch failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "load failed" })),
            )
                .into_response()
        })?;
    let Some(r) = row else {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response());
    };
    Ok(Json(detail_row_to_response(r)))
}

pub fn submit_router() -> Router<AppState> {
    Router::new().route("/", post(submit_bug_report))
}

pub fn settings_subrouter() -> Router<AppState> {
    Router::new()
        .route("/bug-reports", get(list_bug_reports))
        .route(
            "/bug-reports/{id}",
            get(get_bug_report).patch(patch_bug_report),
        )
}
