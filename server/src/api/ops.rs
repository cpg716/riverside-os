//! ROS Dev Center API: health, stations, alerts, guarded actions, and bug overlays.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{OPS_DEV_CENTER_ACTIONS, OPS_DEV_CENTER_VIEW};
use crate::logic::ops_dev_center::{self, GuardedActionResult, StationHeartbeatIn};
use crate::middleware;

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
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

    let snapshot = ops_dev_center::health_snapshot(&state.db, state.meilisearch.is_some())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "ops health snapshot failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not build ops health snapshot" })),
            )
                .into_response()
        })?;

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
    let rows = ops_dev_center::collect_integrations(&state.db, state.meilisearch.is_some())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "ops integrations failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not load integration status" })),
            )
                .into_response()
        })?;
    Ok(Json(rows))
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
    let rows = ops_dev_center::list_stations(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "ops list stations failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "could not load station fleet" })),
            )
                .into_response()
        })?;
    Ok(Json(rows))
}

async fn get_ops_alerts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ops_dev_center::AlertEventRow>>, Response> {
    let _ = require_view(&state, &headers).await?;
    let rows = ops_dev_center::list_alerts(&state.db).await.map_err(|e| {
        tracing::error!(error = %e, "ops list alerts failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "could not load alerts" })),
        )
            .into_response()
    })?;
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
    let reason = body.reason.trim();
    if reason.is_empty() {
        return Err(bad_request("reason is required"));
    }

    let result: GuardedActionResult = ops_dev_center::run_guarded_action(
        &state.db,
        state.meilisearch.as_ref(),
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

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health/snapshot", get(get_health_snapshot))
        .route("/overview", get(get_ops_overview))
        .route("/integrations", get(get_ops_integrations))
        .route("/stations", get(get_ops_stations))
        .route("/stations/heartbeat", post(post_station_heartbeat))
        .route("/alerts", get(get_ops_alerts))
        .route("/alerts/ack", post(post_ops_alert_ack))
        .route("/actions/{action_key}", post(post_ops_action))
        .route("/audit-log", get(get_ops_audit_log))
        .route("/bugs/overview", get(get_bugs_overview))
        .route("/bugs/link-alert", post(post_bug_alert_link))
}
