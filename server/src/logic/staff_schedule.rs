//! Weekly availability and day-level exceptions for salesperson / sales_support.
//! `staff_effective_working_day` in PostgreSQL is the source of truth; Rust calls it via `is_working_day`.

use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use chrono_tz::Tz;
use serde::Serialize;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

use crate::logic::tasks::{self, load_store_timezone_name};
use crate::models::DbStaffScheduleExceptionKind;

fn normalize_week_start(d: NaiveDate) -> NaiveDate {
    let weekday = i64::from(d.weekday().num_days_from_sunday());
    d - Duration::days(weekday)
}

#[derive(Debug, Error)]
pub enum StaffScheduleError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("{0}")]
    BadRequest(String),
    #[error("not found")]
    NotFound,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct EligibleStaffRow {
    pub id: Uuid,
    pub full_name: String,
    pub role: crate::models::DbStaffRole,
}

/// Floor staff (salesperson / sales_support) working on a given **store-local** date — e.g. morning dashboard.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct FloorStaffTodayRow {
    pub id: Uuid,
    pub full_name: String,
    pub role: crate::models::DbStaffRole,
    pub avatar_key: String,
    pub shift_label: Option<String>,
}

/// Active salesperson / sales_support who are scheduled to work on the store’s local **today**.
pub async fn list_working_floor_staff_for_local_today(
    pool: &PgPool,
) -> Result<Vec<FloorStaffTodayRow>, sqlx::Error> {
    let tz_name = load_store_timezone_name(pool).await?;
    let today = tasks::store_local_date(&tz_name);
    list_working_floor_staff_for_date(pool, today).await
}

pub async fn list_working_floor_staff_for_date(
    pool: &PgPool,
    d: NaiveDate,
) -> Result<Vec<FloorStaffTodayRow>, sqlx::Error> {
    let weekday = d.weekday().num_days_from_sunday() as i16;
    let week_start = normalize_week_start(d);

    sqlx::query_as::<_, FloorStaffTodayRow>(
        r#"
        SELECT s.id, s.full_name, s.role, s.avatar_key,
               CASE 
                 WHEN e.id IS NULL THEN COALESCE(swd.shift_label, swa.shift_label)
                 ELSE e.shift_label
               END as shift_label
        FROM staff s
        LEFT JOIN staff_weekly_availability swa ON s.id = swa.staff_id AND swa.weekday = EXTRACT(DOW FROM $1::date)::int
        LEFT JOIN staff_weekly_schedule sws
            ON sws.staff_id = s.id
           AND sws.status = 'published'
           AND sws.week_start = $2
        LEFT JOIN staff_weekly_schedule_day swd
            ON swd.staff_id = s.id
           AND swd.week_start = sws.week_start
           AND swd.weekday = $3
        LEFT JOIN staff_day_exception e ON s.id = e.staff_id AND e.exception_date = $1
        WHERE s.is_active = TRUE
          AND s.role IN ('salesperson', 'sales_support', 'staff_support', 'alterations')
          AND staff_effective_working_day(s.id, $1)
        ORDER BY
          CASE s.role
            WHEN 'salesperson' THEN 1
            WHEN 'sales_support' THEN 2
            WHEN 'staff_support' THEN 2
            WHEN 'alterations' THEN 3
            ELSE 4
          END,
          s.full_name ASC
        "#,
    )
    .bind(d)
    .bind(week_start)
    .bind(weekday)
    .fetch_all(pool)
    .await
}

pub async fn is_working_day(
    pool: &PgPool,
    staff_id: Uuid,
    d: NaiveDate,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>("SELECT staff_effective_working_day($1, $2)")
        .bind(staff_id)
        .bind(d)
        .fetch_one(pool)
        .await
}

pub async fn appointment_local_date(
    pool: &PgPool,
    starts_at: DateTime<Utc>,
) -> Result<NaiveDate, sqlx::Error> {
    let tz_name = load_store_timezone_name(pool).await?;
    let tz: Tz = tz_name.parse().unwrap_or(Tz::UTC);
    Ok(starts_at.with_timezone(&tz).date_naive())
}

/// Match active salesperson / sales_support by trimmed case-insensitive full name.
pub async fn resolve_floor_staff_id_by_name(
    pool: &PgPool,
    name: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let id: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id FROM staff
        WHERE is_active = TRUE
          AND role IN ('salesperson', 'sales_support', 'staff_support', 'alterations')
          AND lower(trim(full_name)) = lower(trim($1::text))
        ORDER BY id ASC
        LIMIT 1
        "#,
    )
    .bind(trimmed)
    .fetch_optional(pool)
    .await?;
    Ok(id)
}

/// When the name does not match roster floor staff, booking is allowed (legacy free-text).
pub async fn ensure_salesperson_booking_allowed(
    pool: &PgPool,
    salesperson: Option<&str>,
    starts_at: DateTime<Utc>,
) -> Result<(), StaffScheduleError> {
    let name = salesperson.map(str::trim).filter(|s| !s.is_empty());
    let Some(name) = name else {
        return Ok(());
    };
    let Some(sid) = resolve_floor_staff_id_by_name(pool, name).await? else {
        return Ok(());
    };
    let d = appointment_local_date(pool, starts_at).await?;
    let ok = is_working_day(pool, sid, d).await?;
    if !ok {
        return Err(StaffScheduleError::BadRequest(format!(
            "{name} is not scheduled to work on {d} (store calendar). Choose another teammate, another date, or leave unassigned."
        )));
    }
    Ok(())
}

pub async fn list_eligible_staff(pool: &PgPool) -> Result<Vec<EligibleStaffRow>, sqlx::Error> {
    sqlx::query_as::<_, EligibleStaffRow>(
        r#"
        -- Include 'admin' so the owner can add themselves to the schedule
        WHERE is_active = TRUE AND role IN ('admin', 'salesperson', 'sales_support', 'staff_support', 'alterations')
        ORDER BY
          CASE role
            WHEN 'salesperson' THEN 1
            WHEN 'sales_support' THEN 2
            WHEN 'staff_support' THEN 2
            WHEN 'alterations' THEN 3
            WHEN 'admin' THEN 4
            ELSE 5
          END,
          full_name ASC
        "#,
    )
    .fetch_all(pool)
    .await
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct WeeklyRow {
    pub weekday: i16,
    pub works: bool,
    pub shift_label: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct WeeklyScheduleInstanceRow {
    pub staff_id: Uuid,
    pub full_name: String,
    pub role: crate::models::DbStaffRole,
    pub weekday: i16,
    pub works: bool,
    pub shift_label: Option<String>,
    pub schedule_status: Option<String>,
    pub base_works: bool,
}

#[derive(Debug, Clone)]
pub struct WeekInputDay {
    pub weekday: i16,
    pub works: bool,
    pub shift_label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct WeekScheduleInput {
    pub staff_id: Uuid,
    pub weekdays: Vec<WeekInputDay>,
}

pub async fn list_week_schedule_for_week(
    pool: &PgPool,
    week_start: NaiveDate,
) -> Result<Vec<WeeklyScheduleInstanceRow>, sqlx::Error> {
    let week_start = normalize_week_start(week_start);
    sqlx::query_as::<_, WeeklyScheduleInstanceRow>(
        r#"
        SELECT
            s.id AS staff_id,
            s.full_name,
            s.role,
            gs.day::smallint AS weekday,
            COALESCE(
                CASE
                    WHEN sws.status IN ('draft','published') THEN swd.works
                    ELSE NULL
                END,
                swa.works,
                FALSE
            ) AS works,
            COALESCE(
                CASE
                    WHEN sws.status IN ('draft','published') THEN swd.shift_label
                    ELSE NULL
                END,
                swa.shift_label
            ) AS shift_label,
            CASE
                WHEN sws.status = 'published' THEN 'published'::text
                WHEN sws.status = 'draft' THEN 'draft'::text
                WHEN sws.status = 'archived' THEN 'archived'::text
                ELSE NULL
            END AS schedule_status,
            COALESCE(swa.works, FALSE) AS base_works
        FROM staff s
        CROSS JOIN generate_series(0,6) AS gs(day)
        LEFT JOIN staff_weekly_schedule sws
            ON sws.staff_id = s.id
           AND sws.week_start = $1
        LEFT JOIN staff_weekly_schedule_day swd
            ON swd.staff_id = s.id
           AND swd.week_start = $1
           AND swd.weekday = gs.day
        LEFT JOIN staff_weekly_availability swa
            ON swa.staff_id = s.id
           AND swa.weekday = gs.day
        WHERE s.is_active = TRUE
          AND s.role IN ('salesperson', 'sales_support', 'staff_support', 'alterations')
        ORDER BY
          CASE s.role
            WHEN 'salesperson' THEN 1
            WHEN 'sales_support' THEN 2
            WHEN 'staff_support' THEN 2
            WHEN 'alterations' THEN 3
            ELSE 4
          END,
          s.full_name ASC,
          gs.day ASC
        "#,
    )
    .bind(week_start)
    .fetch_all(pool)
    .await
}

pub async fn upsert_week_schedule_for_week(
    pool: &PgPool,
    actor: Uuid,
    week_start: NaiveDate,
    rows: &[WeekScheduleInput],
) -> Result<(), StaffScheduleError> {
    if rows.is_empty() {
        return Err(StaffScheduleError::BadRequest(
            "weekly schedule import requires at least one staff row".into(),
        ));
    }

    let week_start = normalize_week_start(week_start);

    let mut tx = pool.begin().await?;

    // Authoritative sync: identify staff members currently in the DB for this week who are NOT in our input list.
    let input_ids: std::collections::HashSet<Uuid> = rows.iter().map(|r| r.staff_id).collect();
    let current_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT staff_id FROM staff_weekly_schedule WHERE week_start = $1",
    )
    .bind(week_start)
    .fetch_all(&mut *tx)
    .await?;

    for cid in current_ids {
        if !input_ids.contains(&cid) {
            sqlx::query("DELETE FROM staff_weekly_schedule WHERE staff_id = $1 AND week_start = $2")
                .bind(cid)
                .bind(week_start)
                .execute(&mut *tx)
                .await?;
        }
    }

    for row in rows {
        let staff_id = row.staff_id;
        if row.weekdays.is_empty() {
            return Err(StaffScheduleError::BadRequest(
                "every staff schedule must include at least one weekday entry".into(),
            ));
        }

        let mut seen_weekday = [false; 7];
        for day in &row.weekdays {
            if day.weekday < 0 || day.weekday > 6 {
                return Err(StaffScheduleError::BadRequest(format!(
                    "invalid weekday {} for staff {}",
                    day.weekday, staff_id
                )));
            }
            let idx = day.weekday as usize;
            if seen_weekday[idx] {
                return Err(StaffScheduleError::BadRequest(format!(
                    "duplicate weekday {} for staff {}",
                    day.weekday, staff_id
                )));
            }
            seen_weekday[idx] = true;
        }

        let role_ok: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM staff
                WHERE id = $1 AND is_active = TRUE AND role IN ('admin', 'salesperson', 'sales_support', 'staff_support', 'alterations')
            )
            "#,
        )
        .bind(staff_id)
        .fetch_one(&mut *tx)
        .await?;
        if !role_ok {
            return Err(StaffScheduleError::BadRequest(
                "schedule applies only to active floor/support staff".into(),
            ));
        }

        sqlx::query(
            r#"
            INSERT INTO staff_weekly_schedule (staff_id, week_start, status, created_by_staff_id, updated_by_staff_id)
            VALUES ($1, $2, 'draft'::staff_weekly_schedule_status, $3, $3)
            ON CONFLICT (staff_id, week_start) DO UPDATE
            SET status = 'draft'::staff_weekly_schedule_status,
                updated_by_staff_id = $3,
                updated_at = NOW()
            "#,
        )
        .bind(staff_id)
        .bind(week_start)
        .bind(actor)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "DELETE FROM staff_weekly_schedule_day WHERE staff_id = $1 AND week_start = $2",
        )
        .bind(staff_id)
        .bind(week_start)
        .execute(&mut *tx)
        .await?;

        for day in &row.weekdays {
            sqlx::query(
                r#"
                INSERT INTO staff_weekly_schedule_day (staff_id, week_start, weekday, works, shift_label)
                VALUES ($1, $2, $3, $4, $5)
                "#,
            )
            .bind(staff_id)
            .bind(week_start)
            .bind(day.weekday)
            .bind(day.works)
            .bind(&day.shift_label)
            .execute(&mut *tx)
            .await?;
        }
    }

    tx.commit().await?;
    Ok(())
}

pub async fn publish_week_schedule_week(
    pool: &PgPool,
    actor: Uuid,
    week_start: NaiveDate,
) -> Result<u64, StaffScheduleError> {
    let week_start = normalize_week_start(week_start);
    let rows = sqlx::query(
        r#"
        UPDATE staff_weekly_schedule
        SET status = 'published'::staff_weekly_schedule_status,
            updated_by_staff_id = $2,
            updated_at = NOW()
        WHERE week_start = $1
        "#,
    )
    .bind(week_start)
    .bind(actor)
    .execute(pool)
    .await?
    .rows_affected();

    if rows == 0 {
        return Err(StaffScheduleError::NotFound);
    }
    Ok(rows)
}

pub async fn delete_week_schedule_week(
    pool: &PgPool,
    week_start: NaiveDate,
) -> Result<u64, StaffScheduleError> {
    let week_start = normalize_week_start(week_start);
    Ok(
        sqlx::query("DELETE FROM staff_weekly_schedule WHERE week_start = $1")
            .bind(week_start)
            .execute(pool)
            .await?
            .rows_affected(),
    )
}

pub async fn get_weekly_availability(
    pool: &PgPool,
    staff_id: Uuid,
) -> Result<Vec<WeeklyRow>, sqlx::Error> {
    sqlx::query_as::<_, WeeklyRow>(
        r#"
        SELECT weekday, works, shift_label FROM staff_weekly_availability
        WHERE staff_id = $1
        ORDER BY weekday ASC
        "#,
    )
    .bind(staff_id)
    .fetch_all(pool)
    .await
}

pub async fn put_weekly_availability(
    pool: &PgPool,
    staff_id: Uuid,
    rows: &[(i16, bool, Option<String>)],
) -> Result<(), StaffScheduleError> {
    let mut tx = pool.begin().await?;
    put_weekly_availability_in_tx(&mut tx, staff_id, rows).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn put_weekly_availability_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    staff_id: Uuid,
    rows: &[(i16, bool, Option<String>)],
) -> Result<(), StaffScheduleError> {
    if rows.is_empty() {
        return Err(StaffScheduleError::BadRequest(
            "weekly availability requires at least one day entry".into(),
        ));
    }

    // Assert floor staff
    let role_ok: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM staff
            WHERE id = $1 AND is_active = TRUE AND role IN ('salesperson', 'sales_support', 'staff_support', 'alterations')
        )
        "#,
    )
    .bind(staff_id)
    .fetch_one(&mut **tx)
    .await?;

    if !role_ok {
        return Err(StaffScheduleError::BadRequest(
            "schedule applies only to active floor/support staff".into(),
        ));
    }

    sqlx::query("DELETE FROM staff_weekly_availability WHERE staff_id = $1")
        .bind(staff_id)
        .execute(&mut **tx)
        .await?;

    for (wd, works, shift_label) in rows {
        sqlx::query(
            r#"
            INSERT INTO staff_weekly_availability (staff_id, weekday, works, shift_label)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(staff_id)
        .bind(wd)
        .bind(works)
        .bind(shift_label)
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ExceptionRow {
    pub id: Uuid,
    pub staff_id: Uuid,
    pub full_name: String,
    pub exception_date: NaiveDate,
    pub kind: DbStaffScheduleExceptionKind,
    pub shift_label: Option<String>,
    pub notes: Option<String>,
}

pub async fn list_exceptions_range(
    pool: &PgPool,
    staff_id: Option<Uuid>,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<ExceptionRow>, sqlx::Error> {
    sqlx::query_as::<_, ExceptionRow>(
        r#"
        SELECT e.id, e.staff_id, s.full_name, e.exception_date, e.kind, e.shift_label, e.notes
        FROM staff_day_exception e
        INNER JOIN staff s ON s.id = e.staff_id
        WHERE ($1::uuid IS NULL OR e.staff_id = $1)
          AND e.exception_date >= $2 AND e.exception_date <= $3
        ORDER BY e.exception_date ASC, s.full_name ASC
        "#,
    )
    .bind(staff_id)
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await
}

async fn assert_floor_staff(pool: &PgPool, staff_id: Uuid) -> Result<(), StaffScheduleError> {
    let role_ok: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM staff
            WHERE id = $1 AND is_active = TRUE AND role IN ('salesperson', 'sales_support', 'staff_support', 'alterations')
        )
        "#,
    )
    .bind(staff_id)
    .fetch_one(pool)
    .await?;
    if !role_ok {
        return Err(StaffScheduleError::BadRequest(
            "schedule applies only to active salesperson or sales support staff".into(),
        ));
    }
    Ok(())
}

pub async fn upsert_day_exception(
    pool: &PgPool,
    staff_id: Uuid,
    exception_date: NaiveDate,
    kind: DbStaffScheduleExceptionKind,
    shift_label: Option<&str>,
    notes: Option<&str>,
    created_by: Uuid,
) -> Result<(), StaffScheduleError> {
    assert_floor_staff(pool, staff_id).await?;

    sqlx::query(
        r#"
        INSERT INTO staff_day_exception (staff_id, exception_date, kind, shift_label, notes, created_by_staff_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (staff_id, exception_date) DO UPDATE SET
            kind = EXCLUDED.kind,
            shift_label = EXCLUDED.shift_label,
            notes = EXCLUDED.notes,
            created_by_staff_id = EXCLUDED.created_by_staff_id,
            created_at = now()
        "#,
    )
    .bind(staff_id)
    .bind(exception_date)
    .bind(kind)
    .bind(shift_label.map(str::trim).filter(|s| !s.is_empty()))
    .bind(notes.map(str::trim).filter(|s| !s.is_empty()))
    .bind(created_by)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_day_exception(
    pool: &PgPool,
    staff_id: Uuid,
    exception_date: NaiveDate,
) -> Result<(), StaffScheduleError> {
    let r =
        sqlx::query("DELETE FROM staff_day_exception WHERE staff_id = $1 AND exception_date = $2")
            .bind(staff_id)
            .bind(exception_date)
            .execute(pool)
            .await?
            .rows_affected();
    if r == 0 {
        return Err(StaffScheduleError::NotFound);
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct MarkAbsenceResult {
    pub appointments_updated: u64,
    pub tasks_cancelled: u64,
    pub appointment_ids: Vec<Uuid>,
}

/// Record sick / PTO / missed shift. Optionally clear or reassign same-day appointments that match this staff by name.
#[allow(clippy::too_many_arguments)]
pub async fn mark_absence_and_handle_appointments(
    pool: &PgPool,
    staff_id: Uuid,
    absence_date: NaiveDate,
    kind: DbStaffScheduleExceptionKind,
    shift_label: Option<&str>,
    notes: Option<&str>,
    created_by: Uuid,
    unassign_appointments: bool,
    reassign_to_staff_id: Option<Uuid>,
    tz_name: &str,
) -> Result<MarkAbsenceResult, StaffScheduleError> {
    if matches!(kind, DbStaffScheduleExceptionKind::ExtraShift) {
        return Err(StaffScheduleError::BadRequest(
            "mark-absence accepts sick, pto, or missed_shift only; use day exception for extra_shift"
                .into(),
        ));
    }
    if unassign_appointments && reassign_to_staff_id.is_some() {
        return Err(StaffScheduleError::BadRequest(
            "choose either unassign appointments or reassign_to_staff_id, not both".into(),
        ));
    }

    assert_floor_staff(pool, staff_id).await?;

    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO staff_day_exception (staff_id, exception_date, kind, shift_label, notes, created_by_staff_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (staff_id, exception_date) DO UPDATE SET
            kind = EXCLUDED.kind,
            shift_label = EXCLUDED.shift_label,
            notes = EXCLUDED.notes,
            created_by_staff_id = EXCLUDED.created_by_staff_id,
            created_at = now()
        "#,
    )
    .bind(staff_id)
    .bind(absence_date)
    .bind(kind)
    .bind(shift_label.map(str::trim).filter(|s| !s.is_empty()))
    .bind(notes.map(str::trim).filter(|s| !s.is_empty()))
    .bind(created_by)
    .execute(&mut *tx)
    .await?;

    let tasks_cancelled = sqlx::query(
        r#"
        UPDATE task_instance ti
        SET status = 'cancelled'::task_instance_status
        FROM task_assignment ta
        WHERE ti.assignment_id = ta.id
          AND ti.assignee_staff_id = $1
          AND ti.due_date = $2
          AND ti.status = 'open'::task_instance_status
          AND ta.recurrence = 'daily'::task_recurrence
        "#,
    )
    .bind(staff_id)
    .bind(absence_date)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    let appt_ids: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT wa.id
        FROM wedding_appointments wa
        JOIN staff s ON lower(trim(COALESCE(wa.salesperson, ''))) = lower(trim(s.full_name))
        WHERE s.id = $1
          AND (wa.starts_at AT TIME ZONE $2::text)::date = $3
        "#,
    )
    .bind(staff_id)
    .bind(tz_name)
    .bind(absence_date)
    .fetch_all(&mut *tx)
    .await?;

    let mut appointments_updated: u64 = 0;

    if !appt_ids.is_empty() {
        if let Some(new_id) = reassign_to_staff_id {
            let new_name: String = sqlx::query_scalar(
                "SELECT full_name FROM staff WHERE id = $1 AND is_active = TRUE",
            )
            .bind(new_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                StaffScheduleError::BadRequest("reassign target not found or inactive".into())
            })?;

            let works: bool = sqlx::query_scalar("SELECT staff_effective_working_day($1, $2)")
                .bind(new_id)
                .bind(absence_date)
                .fetch_one(&mut *tx)
                .await?;
            if !works {
                return Err(StaffScheduleError::BadRequest(
                    "reassign target is not scheduled to work on that date".into(),
                ));
            }

            let n = sqlx::query(
                r#"UPDATE wedding_appointments SET salesperson = $1 WHERE id = ANY($2)"#,
            )
            .bind(new_name)
            .bind(&appt_ids)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            appointments_updated = n;
        } else if unassign_appointments {
            let n = sqlx::query(
                r#"UPDATE wedding_appointments SET salesperson = NULL WHERE id = ANY($1)"#,
            )
            .bind(&appt_ids)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            appointments_updated = n;
        }
    }

    tx.commit().await?;

    Ok(MarkAbsenceResult {
        appointments_updated,
        tasks_cancelled,
        appointment_ids: appt_ids,
    })
}

#[derive(Debug, Serialize)]
pub struct EffectiveDay {
    pub date: NaiveDate,
    pub working: bool,
    pub shift_label: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct WeeklyScheduleRangeRow {
    pub staff_id: Uuid,
    pub full_name: String,
    pub role: crate::models::DbStaffRole,
    pub date: NaiveDate,
    pub working: bool,
    pub shift_label: Option<String>,
}

pub async fn get_effective_day_details(
    pool: &PgPool,
    staff_id: Uuid,
    d: NaiveDate,
) -> Result<EffectiveDay, sqlx::Error> {
    let weekday = d.weekday().num_days_from_sunday() as i16;
    let week_start = normalize_week_start(d);
    let working = is_working_day(pool, staff_id, d).await?;

    let shift_label: Option<String> = sqlx::query_scalar(
        r#"
        SELECT 
            CASE 
                WHEN e.id IS NOT NULL THEN e.shift_label
                WHEN sws.status = 'published' THEN COALESCE(swd.shift_label, swa.shift_label)
                ELSE swa.shift_label
            END
        FROM staff s
        LEFT JOIN staff_weekly_availability swa ON s.id = swa.staff_id AND swa.weekday = $3
        LEFT JOIN staff_weekly_schedule sws
            ON sws.staff_id = s.id
           AND sws.status = 'published'
           AND sws.week_start = $4
        LEFT JOIN staff_weekly_schedule_day swd
            ON swd.staff_id = s.id
           AND swd.week_start = sws.week_start
           AND swd.weekday = $3
        LEFT JOIN staff_day_exception e ON s.id = e.staff_id AND e.exception_date = $2
        WHERE s.id = $1
        "#,
    )
    .bind(staff_id)
    .bind(d)
    .bind(weekday)
    .bind(week_start)
    .fetch_one(pool)
    .await?;

    Ok(EffectiveDay {
        date: d,
        working,
        shift_label,
    })
}

pub async fn list_effective_days(
    pool: &PgPool,
    staff_id: Uuid,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<EffectiveDay>, sqlx::Error> {
    let mut out = Vec::new();
    let n = (to.signed_duration_since(from)).num_days().max(0);
    for i in 0..=n {
        let d = from.checked_add_signed(Duration::days(i)).unwrap_or(to);
        let details = get_effective_day_details(pool, staff_id, d).await?;
        out.push(details);
    }
    Ok(out)
}

pub async fn list_effective_schedule_for_date_range(
    pool: &PgPool,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<WeeklyScheduleRangeRow>, sqlx::Error> {
    if from > to {
        return Ok(Vec::new());
    }

    sqlx::query_as::<_, WeeklyScheduleRangeRow>(
        r#"
        WITH dates AS (
            SELECT generate_series($1::date, $2::date, interval '1 day')::date AS date
        )
        SELECT
            s.id AS staff_id,
            s.full_name,
            s.role,
            d.date,
            staff_effective_working_day(s.id, d.date) AS working,
            CASE
                WHEN e.id IS NOT NULL THEN e.shift_label
                WHEN sws.status = 'published' THEN COALESCE(swd.shift_label, swa.shift_label)
                ELSE swa.shift_label
            END AS shift_label
        FROM staff s
        CROSS JOIN dates d
        LEFT JOIN staff_weekly_availability swa
            ON s.id = swa.staff_id
           AND swa.weekday = EXTRACT(DOW FROM d.date)::int
        LEFT JOIN staff_weekly_schedule sws
            ON sws.staff_id = s.id
           AND sws.status = 'published'
           AND sws.week_start = (d.date - (EXTRACT(DOW FROM d.date)::int * INTERVAL '1 day'))::date
        LEFT JOIN staff_weekly_schedule_day swd
            ON swd.staff_id = s.id
           AND swd.week_start = sws.week_start
           AND swd.weekday = EXTRACT(DOW FROM d.date)::int
        LEFT JOIN staff_day_exception e
            ON s.id = e.staff_id
           AND e.exception_date = d.date
        WHERE s.is_active = TRUE
          AND s.role IN ('salesperson', 'sales_support', 'staff_support', 'alterations')
          AND d.date >= $1
          AND d.date <= $2
        ORDER BY
          CASE s.role
            WHEN 'salesperson' THEN 1
            WHEN 'sales_support' THEN 2
            WHEN 'staff_support' THEN 2
            WHEN 'alterations' THEN 3
            ELSE 4
          END,
          s.full_name ASC,
          d.date ASC
        "#,
    )
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await
}
pub async fn list_master_template(pool: &PgPool) -> Result<Vec<MasterTemplateRow>, sqlx::Error> {
    sqlx::query_as::<_, MasterTemplateRow>(
        r#"
        SELECT s.id AS staff_id, s.full_name, s.role, gs.day::smallint AS weekday,
               COALESCE(swa.works, FALSE) AS works,
               swa.shift_label
        FROM staff s
        CROSS JOIN (SELECT generate_series(0, 6) AS day) gs
        LEFT JOIN staff_weekly_availability swa 
            ON swa.staff_id = s.id 
           AND swa.weekday = gs.day
        WHERE s.is_active = TRUE
          AND s.role IN ('salesperson', 'sales_support', 'staff_support', 'alterations')
        ORDER BY s.full_name, gs.day
        "#,
    )
    .fetch_all(pool)
    .await
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct MasterTemplateRow {
    pub staff_id: Uuid,
    pub full_name: String,
    pub role: crate::models::DbStaffRole,
    pub weekday: i16,
    pub works: bool,
    pub shift_label: Option<String>,
}

pub async fn clone_week_schedule_week(
    pool: &PgPool,
    actor_id: Uuid,
    target_week_start: NaiveDate,
) -> Result<u64, StaffScheduleError> {
    let source_week_start = target_week_start - Duration::days(7);

    let mut tx = pool.begin().await?;

    // Check if source exists
    let source_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM staff_weekly_schedule WHERE week_start = $1 AND status = 'published')",
    )
    .bind(source_week_start)
    .fetch_one(&mut *tx)
    .await?;

    if !source_exists {
        return Err(StaffScheduleError::BadRequest(
            "Source week (previous week) is not published".into(),
        ));
    }

    // Delete existing target if any (draft or published)
    sqlx::query("DELETE FROM staff_weekly_schedule WHERE week_start = $1")
        .bind(target_week_start)
        .execute(&mut *tx)
        .await?;

    // Create new draft
    sqlx::query(
        r#"
        INSERT INTO staff_weekly_schedule (week_start, status, created_by, updated_by)
        VALUES ($1, 'draft', $2, $2)
        "#,
    )
    .bind(target_week_start)
    .bind(actor_id)
    .execute(&mut *tx)
    .await?;

    // Copy days
    let copied = sqlx::query(
        r#"
        INSERT INTO staff_weekly_schedule_day (week_start, staff_id, weekday, works, shift_label)
        SELECT $1, staff_id, weekday, works, shift_label
        FROM staff_weekly_schedule_day
        WHERE week_start = $2
        "#,
    )
    .bind(target_week_start)
    .bind(source_week_start)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    tx.commit().await?;
    Ok(copied)
}
