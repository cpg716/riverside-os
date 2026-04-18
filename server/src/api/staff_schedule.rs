//! Staff weekly schedule + day exceptions (salesperson / sales_support).

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    effective_permissions_for_staff, staff_has_permission, STAFF_MANAGE_ACCESS, STAFF_VIEW,
    TASKS_MANAGE, WEDDINGS_VIEW,
};
use crate::logic::staff_schedule::{
    self, EligibleStaffRow, ExceptionRow, MarkAbsenceResult, StaffScheduleError, WeeklyRow,
};
use crate::logic::tasks::load_store_timezone_name;
use crate::middleware::{self, require_authenticated_staff_headers};
use crate::models::DbStaffScheduleExceptionKind;

#[derive(Debug, Deserialize)]
pub struct RangeQuery {
    pub staff_id: Uuid,
    pub from: NaiveDate,
    pub to: NaiveDate,
}

#[derive(Debug, Deserialize)]
pub struct PutWeeklyBody {
    pub staff_id: Uuid,
    /// Seven entries: weekday 0=Sun … 6=Sat.
    pub weekdays: Vec<WeekdayEntry>,
}

#[derive(Debug, Deserialize)]
pub struct WeekdayEntry {
    pub weekday: i16,
    pub works: bool,
    pub shift_label: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ExceptionBody {
    pub staff_id: Uuid,
    pub exception_date: NaiveDate,
    pub kind: DbStaffScheduleExceptionKind,
    #[serde(default)]
    pub shift_label: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteExceptionQuery {
    pub staff_id: Uuid,
    pub exception_date: NaiveDate,
}

#[derive(Debug, Deserialize)]
pub struct MarkAbsenceBody {
    pub staff_id: Uuid,
    pub absence_date: NaiveDate,
    pub kind: DbStaffScheduleExceptionKind,
    #[serde(default)]
    pub shift_label: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    /// Clear salesperson on same-calendar-day appointments that match this staff member.
    #[serde(default)]
    pub unassign_appointments: bool,
    #[serde(default)]
    pub reassign_to_staff_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct BulkPutWeeklyBody {
    pub schedules: Vec<StaffWeeklySchedule>,
}

#[derive(Debug, Deserialize)]
pub struct StaffWeeklySchedule {
    pub staff_id: Uuid,
    pub weekdays: Vec<WeekdayEntry>,
}

#[derive(Debug, Deserialize)]
pub struct ValidateBookingQuery {
    pub full_name: String,
    pub starts_at: chrono::DateTime<chrono::Utc>,
}

fn map_err(e: StaffScheduleError) -> Response {
    match e {
        StaffScheduleError::NotFound => {
            (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response()
        }
        StaffScheduleError::BadRequest(m) => {
            (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response()
        }
        StaffScheduleError::Database(e) => {
            tracing::error!(error = %e, "staff_schedule database error");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal error" })),
            )
                .into_response()
        }
    }
}

fn map_gate(e: (StatusCode, axum::Json<serde_json::Value>)) -> Response {
    let (st, body) = e;
    (st, body).into_response()
}

async fn may_edit_schedule(pool: &sqlx::PgPool, staff_id: Uuid) -> bool {
    let role: Option<crate::models::DbStaffRole> =
        sqlx::query_scalar(r#"SELECT role FROM staff WHERE id = $1 AND is_active = TRUE"#)
            .bind(staff_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    let Some(role) = role else {
        return false;
    };
    let Ok(eff) = effective_permissions_for_staff(pool, staff_id, role).await else {
        return false;
    };
    staff_has_permission(&eff, TASKS_MANAGE) || staff_has_permission(&eff, STAFF_MANAGE_ACCESS)
}

async fn require_editor(state: &AppState, headers: &HeaderMap) -> Result<Uuid, Response> {
    let s = require_authenticated_staff_headers(state, headers)
        .await
        .map_err(map_gate)?;
    if !may_edit_schedule(&state.db, s.id).await {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "tasks.manage or staff.manage_access required" })),
        )
            .into_response());
    }
    Ok(s.id)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/eligible", get(get_eligible))
        .route("/weekly/{staff_id}", get(get_weekly))
        .route("/weekly", put(put_weekly))
        .route("/weekly/bulk", post(post_bulk_weekly))
        .route(
            "/exceptions",
            get(list_exceptions)
                .post(post_exception)
                .delete(delete_exception),
        )
        .route("/effective", get(get_effective))
        .route("/mark-absence", post(post_mark_absence))
        .route("/validate-booking", get(get_validate_booking))
}

async fn get_eligible(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<EligibleStaffRow>>, Response> {
    middleware::require_staff_with_permission(&state, &headers, STAFF_VIEW)
        .await
        .map_err(map_gate)?;
    let rows = staff_schedule::list_eligible_staff(&state.db)
        .await
        .map_err(StaffScheduleError::Database)
        .map_err(map_err)?;
    Ok(Json(rows))
}

async fn get_weekly(
    State(state): State<AppState>,
    Path(staff_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<WeeklyRow>>, Response> {
    middleware::require_staff_with_permission(&state, &headers, STAFF_VIEW)
        .await
        .map_err(map_gate)?;
    let rows = staff_schedule::get_weekly_availability(&state.db, staff_id)
        .await
        .map_err(StaffScheduleError::Database)
        .map_err(map_err)?;
    Ok(Json(rows))
}

async fn put_weekly(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PutWeeklyBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let _actor = require_editor(&state, &headers).await?;
    let staff_id = body.staff_id;
    let mut flat: Vec<(i16, bool, Option<String>)> = body
        .weekdays
        .into_iter()
        .map(|w| (w.weekday, w.works, w.shift_label))
        .collect();
    flat.sort_by_key(|(d, _, _)| *d);
    staff_schedule::put_weekly_availability(&state.db, staff_id, &flat)
        .await
        .map_err(map_err)?;
    Ok(Json(json!({ "ok": true })))
}

async fn post_bulk_weekly(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BulkPutWeeklyBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let _actor = require_editor(&state, &headers).await?;
    let mut tx = state.db.begin().await.map_err(|e| map_err(StaffScheduleError::Database(e)))?;
    for s in body.schedules {
        let mut flat: Vec<(i16, bool, Option<String>)> = s
            .weekdays
            .into_iter()
            .map(|w| (w.weekday, w.works, w.shift_label))
            .collect();
        flat.sort_by_key(|(d, _, _)| *d);
        staff_schedule::put_weekly_availability_in_tx(&mut tx, s.staff_id, &flat)
            .await
            .map_err(map_err)?;
    }
    tx.commit().await.map_err(|e| map_err(StaffScheduleError::Database(e)))?;
    Ok(Json(json!({ "ok": true })))
}

async fn list_exceptions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<RangeQuery>,
) -> Result<Json<Vec<ExceptionRow>>, Response> {
    middleware::require_staff_with_permission(&state, &headers, STAFF_VIEW)
        .await
        .map_err(map_gate)?;
    let rows = staff_schedule::list_exceptions_range(&state.db, q.staff_id, q.from, q.to)
        .await
        .map_err(StaffScheduleError::Database)
        .map_err(map_err)?;
    Ok(Json(rows))
}

async fn post_exception(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ExceptionBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let actor = require_editor(&state, &headers).await?;
    staff_schedule::upsert_day_exception(
        &state.db,
        body.staff_id,
        body.exception_date,
        body.kind,
        body.shift_label.as_deref(),
        body.notes.as_deref(),
        actor,
    )
    .await
    .map_err(map_err)?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_exception(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DeleteExceptionQuery>,
) -> Result<Json<serde_json::Value>, Response> {
    let _actor = require_editor(&state, &headers).await?;
    staff_schedule::delete_day_exception(&state.db, q.staff_id, q.exception_date)
        .await
        .map_err(map_err)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Serialize)]
struct EffectiveResponse {
    days: Vec<staff_schedule::EffectiveDay>,
}

async fn get_effective(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<RangeQuery>,
) -> Result<Json<EffectiveResponse>, Response> {
    middleware::require_staff_with_permission(&state, &headers, STAFF_VIEW)
        .await
        .map_err(map_gate)?;
    let days = staff_schedule::list_effective_days(&state.db, q.staff_id, q.from, q.to)
        .await
        .map_err(StaffScheduleError::Database)
        .map_err(map_err)?;
    Ok(Json(EffectiveResponse { days }))
}

async fn post_mark_absence(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<MarkAbsenceBody>,
) -> Result<Json<MarkAbsenceResult>, Response> {
    let actor = require_editor(&state, &headers).await?;
    let tz = load_store_timezone_name(&state.db)
        .await
        .map_err(StaffScheduleError::Database)
        .map_err(map_err)?;
    let res = staff_schedule::mark_absence_and_handle_appointments(
        &state.db,
        body.staff_id,
        body.absence_date,
        body.kind,
        body.shift_label.as_deref(),
        body.notes.as_deref(),
        actor,
        body.unassign_appointments,
        body.reassign_to_staff_id,
        &tz,
    )
    .await
    .map_err(map_err)?;
    Ok(Json(res))
}

async fn get_validate_booking(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ValidateBookingQuery>,
) -> Result<Json<serde_json::Value>, Response> {
    middleware::require_staff_with_permission(&state, &headers, WEDDINGS_VIEW)
        .await
        .map_err(map_gate)?;
    staff_schedule::ensure_salesperson_booking_allowed(&state.db, Some(&q.full_name), q.starts_at)
        .await
        .map_err(map_err)?;
    Ok(Json(json!({ "ok": true })))
}
