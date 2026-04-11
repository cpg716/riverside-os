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
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::api::AppState;
use crate::auth::permissions::{effective_permissions_for_staff, ALL_PERMISSION_KEYS, HELP_MANAGE};
use crate::auth::pins::authenticate_pos_staff;
use crate::auth::pins::AuthenticatedStaff;
use crate::logic::help_manual_policy::{
    self, build_admin_manual_catalog, build_manual_detail, build_visible_manual_list,
    delete_help_manual_policy, load_all_policies, upsert_help_manual_policy,
    PutHelpManualPolicyBody,
};
use crate::logic::meilisearch_search::{help_search_hits, HelpSearchHit};
use crate::middleware;

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

#[derive(Debug, Serialize)]
struct AdminOpsStatusOut {
    meilisearch_configured: bool,
    meilisearch_indexing: bool,
    node_available: bool,
    script_exists: bool,
    help_docs_dir_exists: bool,
}

#[derive(Debug, Serialize)]
struct AdminOpsRunOut {
    ok: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
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

struct HelpViewer {
    pos_only_mode: bool,
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
            staff_perms,
        });
    }

    Ok(HelpViewer {
        pos_only_mode: true,
        staff_perms: HashSet::new(),
    })
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/search", get(search_help))
        .route("/manuals", get(list_manuals))
        .route("/manuals/{manual_id}", get(get_manual))
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
        .route("/admin/ops/reindex-search", post(admin_ops_reindex_search))
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
        return Ok(Json(serde_json::json!({ "hits": [] })));
    }

    let Some(client) = state.meilisearch.as_ref() else {
        return Ok(Json(serde_json::json!({ "hits": [] })));
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
            Ok(Json(serde_json::json!({ "hits": hits })))
        }
        Err(e) => {
            tracing::warn!(error = %e, "help_search_hits failed; returning empty hits");
            Ok(Json(serde_json::json!({ "hits": [] })))
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

    Ok(Json(AdminOpsStatusOut {
        meilisearch_configured: state.meilisearch.is_some(),
        meilisearch_indexing,
        node_available,
        script_exists: script_path.exists(),
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
