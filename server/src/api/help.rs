//! In-app help: Meilisearch search (`ros_help`), bundled manuals with DB policy overrides, admin editor.

use std::collections::HashSet;

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;

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
