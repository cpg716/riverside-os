//! Staff weekly schedule + day exceptions (salesperson / sales_support).

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use chrono::{Datelike, Duration, NaiveDate};
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

use std::collections::HashMap;

fn normalize_week_start(d: NaiveDate) -> NaiveDate {
    let weekday = i64::from(d.weekday().num_days_from_sunday());
    d - Duration::days(weekday)
}

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

#[derive(Debug, Deserialize, Serialize)]
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

#[derive(Debug, Serialize)]
struct WeekStaffScheduleResponse {
    pub staff_id: Uuid,
    pub full_name: String,
    pub role: crate::models::DbStaffRole,
    pub status: Option<String>,
    pub weekdays: Vec<WeekdayEntry>,
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

#[derive(Debug, Deserialize)]
pub struct WeeklyViewQuery {
    pub from: chrono::NaiveDate,
    pub to: chrono::NaiveDate,
}

#[derive(Debug, Serialize)]
struct WeeklyScheduleByStaff {
    pub staff_id: Uuid,
    pub full_name: String,
    pub role: crate::models::DbStaffRole,
    pub days: Vec<staff_schedule::EffectiveDay>,
}

#[derive(Debug, Serialize)]
struct WeeklyScheduleViewResponse {
    pub from: chrono::NaiveDate,
    pub to: chrono::NaiveDate,
    pub rows: Vec<WeeklyScheduleByStaff>,
}

fn role_order_value(role: crate::models::DbStaffRole) -> &'static str {
    match role {
        crate::models::DbStaffRole::Salesperson => "salesperson",
        crate::models::DbStaffRole::SalesSupport => "sales_support",
        crate::models::DbStaffRole::StaffSupport => "staff_support",
        crate::models::DbStaffRole::Alterations => "alterations",
        crate::models::DbStaffRole::Admin => "admin",
    }
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
            "/weeks/{week_start}",
            get(get_week_schedule)
                .put(put_week_schedule)
                .delete(delete_week_schedule),
        )
        .route("/weeks/{week_start}/publish", post(publish_week_schedule))
        .route("/weekly-view", get(get_weekly_view))
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

async fn get_weekly_view(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<WeeklyViewQuery>,
) -> Result<Json<WeeklyScheduleViewResponse>, Response> {
    middleware::require_staff_with_permission(&state, &headers, STAFF_VIEW)
        .await
        .map_err(map_gate)?;

    if q.from > q.to {
        return Err(map_err(StaffScheduleError::BadRequest(
            "`from` date must not be after `to` date".into(),
        )));
    }

    let rows = staff_schedule::list_effective_schedule_for_date_range(&state.db, q.from, q.to)
        .await
        .map_err(StaffScheduleError::Database)
        .map_err(map_err)?;

    let mut staff_map: HashMap<Uuid, WeeklyScheduleByStaff> = HashMap::new();
    for row in rows {
        let entry = staff_map
            .entry(row.staff_id)
            .or_insert_with(|| WeeklyScheduleByStaff {
                staff_id: row.staff_id,
                full_name: row.full_name.clone(),
                role: row.role,
                days: Vec::new(),
            });
        entry.days.push(staff_schedule::EffectiveDay {
            date: row.date,
            working: row.working,
            shift_label: row.shift_label,
        });
    }

    for entry in staff_map.values_mut() {
        entry.days.sort_by_key(|d| d.date);
    }

    let mut rows: Vec<WeeklyScheduleByStaff> = staff_map.into_values().collect();
    rows.sort_by(|a, b| a.full_name.cmp(&b.full_name));

    Ok(Json(WeeklyScheduleViewResponse {
        from: q.from,
        to: q.to,
        rows,
    }))
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
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| map_err(StaffScheduleError::Database(e)))?;
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
    tx.commit()
        .await
        .map_err(|e| map_err(StaffScheduleError::Database(e)))?;
    Ok(Json(json!({ "ok": true })))
}

async fn get_week_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(week_start): Path<NaiveDate>,
) -> Result<Json<Vec<WeekStaffScheduleResponse>>, Response> {
    middleware::require_staff_with_permission(&state, &headers, STAFF_VIEW)
        .await
        .map_err(map_gate)?;

    let rows =
        staff_schedule::list_week_schedule_for_week(&state.db, normalize_week_start(week_start))
            .await
            .map_err(StaffScheduleError::Database)
            .map_err(map_err)?;

    let mut grouped: HashMap<Uuid, WeekStaffScheduleResponse> = HashMap::new();
    for row in rows {
        let entry = grouped
            .entry(row.staff_id)
            .or_insert_with(|| WeekStaffScheduleResponse {
                staff_id: row.staff_id,
                full_name: row.full_name.clone(),
                role: row.role,
                status: row.schedule_status,
                weekdays: Vec::with_capacity(7),
            });
        entry.weekdays.push(WeekdayEntry {
            weekday: row.weekday,
            works: row.works,
            shift_label: row.shift_label,
        });
    }

    let mut rows: Vec<WeekStaffScheduleResponse> = grouped
        .into_values()
        .map(|mut row| {
            row.weekdays.sort_by_key(|d| d.weekday);
            row
        })
        .collect();

    rows.sort_by(|a, b| {
        role_order_value(a.role)
            .cmp(role_order_value(b.role))
            .then(a.full_name.cmp(&b.full_name))
    });

    Ok(Json(rows))
}

async fn put_week_schedule(
    State(state): State<AppState>,
    Path(week_start): Path<NaiveDate>,
    headers: HeaderMap,
    Json(body): Json<BulkPutWeeklyBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let actor = require_editor(&state, &headers).await?;
    let normalized_week_start = normalize_week_start(week_start);

    let schedules = body
        .schedules
        .into_iter()
        .map(|s| staff_schedule::WeekScheduleInput {
            staff_id: s.staff_id,
            weekdays: s
                .weekdays
                .into_iter()
                .map(|day| staff_schedule::WeekInputDay {
                    weekday: day.weekday,
                    works: day.works,
                    shift_label: day.shift_label,
                })
                .collect(),
        })
        .collect::<Vec<_>>();

    staff_schedule::upsert_week_schedule_for_week(
        &state.db,
        actor,
        normalized_week_start,
        &schedules,
    )
    .await
    .map_err(map_err)?;

    Ok(Json(
        json!({ "ok": true, "week_start": normalized_week_start }),
    ))
}

async fn publish_week_schedule(
    State(state): State<AppState>,
    Path(week_start): Path<NaiveDate>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let actor = require_editor(&state, &headers).await?;
    let normalized_week_start = normalize_week_start(week_start);
    let published =
        staff_schedule::publish_week_schedule_week(&state.db, actor, normalized_week_start)
            .await
            .map_err(map_err)?;
    if published == 0 {
        return Err(map_err(StaffScheduleError::NotFound));
    }
    Ok(Json(json!({
        "ok": true,
        "week_start": normalized_week_start,
        "published": published,
    })))
}

async fn delete_week_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(week_start): Path<NaiveDate>,
) -> Result<Json<serde_json::Value>, Response> {
    let _actor = require_editor(&state, &headers).await?;
    let normalized_week_start = normalize_week_start(week_start);
    let deleted = staff_schedule::delete_week_schedule_week(&state.db, normalized_week_start)
        .await
        .map_err(map_err)?;
    if deleted == 0 {
        return Err(map_err(StaffScheduleError::NotFound));
    }
    Ok(Json(json!({
        "ok": true,
        "week_start": normalized_week_start,
        "deleted": deleted,
    })))
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
