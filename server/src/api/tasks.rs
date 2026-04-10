//! Staff recurring tasks API (checklists, lazy materialization, admin templates/assignments).

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{self, staff_has_permission, TASKS_MANAGE, TASKS_VIEW_TEAM};
use crate::logic::tasks::{
    self, AssignmentListRow, CreateAssignmentPayload, CreateTemplatePayload, TaskError,
    TaskHistoryRow, TaskInstanceListRow, TeamTaskRow, TemplateItemRow, TemplateSummaryRow,
};
use crate::middleware::{self, StaffOrPosSession};
use crate::models::DbStaffRole;

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    pub assignee_staff_id: Option<Uuid>,
    pub q: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

fn default_limit() -> i64 {
    50
}

#[derive(Debug, Deserialize)]
pub struct PatchItemBody {
    pub done: bool,
}

#[derive(Debug, Deserialize)]
pub struct SetAssignmentActiveBody {
    pub active: bool,
}

#[derive(Debug, Serialize)]
struct MeResponse {
    open: Vec<TaskInstanceListRow>,
    completed_recent: Vec<TaskInstanceListRow>,
}

fn map_task_err(e: TaskError) -> Response {
    match e {
        TaskError::NotFound => {
            (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response()
        }
        TaskError::Forbidden => {
            (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden" }))).into_response()
        }
        TaskError::InvalidState(m) => {
            (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response()
        }
        TaskError::Database(e) => {
            tracing::error!(error = %e, "tasks database error");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response()
        }
    }
}

fn map_gate_err(e: (StatusCode, axum::Json<serde_json::Value>)) -> Response {
    let (st, body) = e;
    (st, body).into_response()
}

async fn resolve_task_actor_staff_id(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Uuid, Response> {
    match middleware::require_staff_or_pos_register_session(state, headers)
        .await
        .map_err(map_gate_err)?
    {
        StaffOrPosSession::Staff(s) => Ok(s.id),
        StaffOrPosSession::PosSession { session_id } => {
            let id: Option<Uuid> = sqlx::query_scalar(
                r#"
                SELECT COALESCE(shift_primary_staff_id, opened_by)
                FROM register_sessions
                WHERE id = $1 AND is_open = true
                "#,
            )
            .bind(session_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "register primary lookup failed (tasks)");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "database error" })),
                )
                    .into_response()
            })?;
            id.ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "no active register session" })),
                )
                    .into_response()
            })
        }
    }
}

fn spawn_meilisearch_task_upsert(state: &AppState, task_id: Uuid) {
    let state = state.clone();
    crate::logic::meilisearch_sync::spawn_meili(async move {
        if let Some(client) = crate::logic::meilisearch_client::meilisearch_from_env() {
            crate::logic::meilisearch_sync::upsert_task_document(&client, &state.db, task_id).await;
        }
    });
}

async fn may_manage_tasks(pool: &sqlx::PgPool, staff_id: Uuid) -> bool {
    let role: Option<DbStaffRole> =
        sqlx::query_scalar(r#"SELECT role FROM staff WHERE id = $1 AND is_active = TRUE"#)
            .bind(staff_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    let Some(role) = role else {
        return false;
    };
    let Ok(eff) = permissions::effective_permissions_for_staff(pool, staff_id, role).await else {
        return false;
    };
    staff_has_permission(&eff, TASKS_MANAGE)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/me", get(get_me))
        .route("/instances/{instance_id}", get(get_instance_detail_http))
        .route(
            "/instances/{instance_id}/items/{item_id}",
            patch(patch_instance_item),
        )
        .route(
            "/instances/{instance_id}/complete",
            post(post_complete_instance),
        )
        .route(
            "/admin/templates",
            get(admin_list_templates).post(admin_create_template),
        )
        .route(
            "/admin/templates/{template_id}/items",
            get(admin_get_template_items),
        )
        .route(
            "/admin/assignments",
            get(admin_list_assignments).post(admin_create_assignment),
        )
        .route(
            "/admin/assignments/{assignment_id}/active",
            patch(admin_set_assignment_active),
        )
        .route("/admin/team-open", get(admin_team_open))
        .route("/admin/history", get(admin_history))
}

async fn get_instance_detail_http(
    State(state): State<AppState>,
    Path(instance_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<tasks::TaskInstanceDetail>, Response> {
    let actor = resolve_task_actor_staff_id(&state, &headers).await?;
    let allow = may_manage_tasks(&state.db, actor).await;
    tasks::get_instance_detail_any(&state.db, instance_id, actor, allow)
        .await
        .map_err(map_task_err)
        .map(Json)
}

async fn get_me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MeResponse>, Response> {
    let actor = resolve_task_actor_staff_id(&state, &headers).await?;
    let open = tasks::list_open_instances_for_staff(&state.db, actor)
        .await
        .map_err(map_task_err)?;
    let completed_recent = tasks::list_recent_completed_for_staff(&state.db, actor, 12)
        .await
        .map_err(map_task_err)?;
    Ok(Json(MeResponse {
        open,
        completed_recent,
    }))
}

async fn patch_instance_item(
    State(state): State<AppState>,
    Path((instance_id, item_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(body): Json<PatchItemBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let actor = resolve_task_actor_staff_id(&state, &headers).await?;
    let allow = may_manage_tasks(&state.db, actor).await;
    tasks::set_instance_item_done(&state.db, instance_id, item_id, actor, body.done, allow)
        .await
        .map_err(map_task_err)?;
    spawn_meilisearch_task_upsert(&state, instance_id);
    Ok(Json(json!({ "ok": true })))
}

async fn post_complete_instance(
    State(state): State<AppState>,
    Path(instance_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let actor = resolve_task_actor_staff_id(&state, &headers).await?;
    let allow = may_manage_tasks(&state.db, actor).await;
    let done = tasks::try_complete_instance(&state.db, instance_id, actor, allow)
        .await
        .map_err(map_task_err)?;
    spawn_meilisearch_task_upsert(&state, instance_id);
    Ok(Json(json!({ "completed": done })))
}

async fn admin_list_templates(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<TemplateSummaryRow>>, Response> {
    middleware::require_staff_with_permission(&state, &headers, TASKS_MANAGE)
        .await
        .map_err(map_gate_err)?;
    let rows = tasks::admin_list_templates(&state.db)
        .await
        .map_err(map_task_err)?;
    Ok(Json(rows))
}

async fn admin_create_template(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateTemplatePayload>,
) -> Result<Json<serde_json::Value>, Response> {
    let staff = middleware::require_staff_with_permission(&state, &headers, TASKS_MANAGE)
        .await
        .map_err(map_gate_err)?;
    let id = tasks::admin_create_template(&state.db, staff.id, body)
        .await
        .map_err(map_task_err)?;
    Ok(Json(json!({ "id": id })))
}

async fn admin_get_template_items(
    State(state): State<AppState>,
    Path(template_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<TemplateItemRow>>, Response> {
    middleware::require_staff_with_permission(&state, &headers, TASKS_MANAGE)
        .await
        .map_err(map_gate_err)?;
    let rows = tasks::admin_get_template_items(&state.db, template_id)
        .await
        .map_err(map_task_err)?;
    Ok(Json(rows))
}

async fn admin_list_assignments(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AssignmentListRow>>, Response> {
    middleware::require_staff_with_permission(&state, &headers, TASKS_MANAGE)
        .await
        .map_err(map_gate_err)?;
    let rows = tasks::admin_list_assignments(&state.db)
        .await
        .map_err(map_task_err)?;
    Ok(Json(rows))
}

async fn admin_create_assignment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateAssignmentPayload>,
) -> Result<Json<serde_json::Value>, Response> {
    middleware::require_staff_with_permission(&state, &headers, TASKS_MANAGE)
        .await
        .map_err(map_gate_err)?;
    let id = tasks::admin_create_assignment(&state.db, body)
        .await
        .map_err(map_task_err)?;
    Ok(Json(json!({ "id": id })))
}

async fn admin_set_assignment_active(
    State(state): State<AppState>,
    Path(assignment_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<SetAssignmentActiveBody>,
) -> Result<Json<serde_json::Value>, Response> {
    middleware::require_staff_with_permission(&state, &headers, TASKS_MANAGE)
        .await
        .map_err(map_gate_err)?;
    tasks::admin_set_assignment_active(&state.db, assignment_id, body.active)
        .await
        .map_err(map_task_err)?;
    Ok(Json(json!({ "ok": true })))
}

async fn admin_team_open(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<TeamTaskRow>>, Response> {
    middleware::require_staff_with_permission(&state, &headers, TASKS_VIEW_TEAM)
        .await
        .map_err(map_gate_err)?;
    let rows = tasks::list_team_open_tasks(&state.db)
        .await
        .map_err(map_task_err)?;
    Ok(Json(rows))
}

async fn admin_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HistoryQuery>,
) -> Result<Json<Vec<TaskHistoryRow>>, Response> {
    middleware::require_staff_with_permission(&state, &headers, TASKS_MANAGE)
        .await
        .map_err(map_gate_err)?;
    let lim = q.limit.clamp(1, 200);
    let rows = tasks::list_task_history(&state.db, state.meilisearch.as_ref(), q.assignee_staff_id, q.q, lim, q.offset.max(0))
        .await
        .map_err(map_task_err)?;
    Ok(Json(rows))
}
