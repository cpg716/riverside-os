//! Weekly availability and day-level exceptions for salesperson / sales_support.
//! `staff_effective_working_day` in PostgreSQL is the source of truth; Rust calls it via `is_working_day`.

use chrono::{DateTime, Duration, NaiveDate, Utc};
use chrono_tz::Tz;
use serde::Serialize;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

use crate::logic::tasks::{self, load_store_timezone_name};
use crate::models::DbStaffScheduleExceptionKind;

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
    sqlx::query_as::<_, FloorStaffTodayRow>(
        r#"
        SELECT s.id, s.full_name, s.role, s.avatar_key
        FROM staff s
        WHERE s.is_active = TRUE
          AND s.role IN ('salesperson', 'sales_support')
          AND staff_effective_working_day(s.id, $1)
        ORDER BY s.full_name ASC
        "#,
    )
    .bind(d)
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
          AND role IN ('salesperson', 'sales_support')
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
        SELECT id, full_name, role
        FROM staff
        WHERE is_active = TRUE AND role IN ('salesperson', 'sales_support')
        ORDER BY full_name ASC
        "#,
    )
    .fetch_all(pool)
    .await
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct WeeklyRow {
    pub weekday: i16,
    pub works: bool,
}

pub async fn get_weekly_availability(
    pool: &PgPool,
    staff_id: Uuid,
) -> Result<Vec<WeeklyRow>, sqlx::Error> {
    sqlx::query_as::<_, WeeklyRow>(
        r#"
        SELECT weekday, works FROM staff_weekly_availability
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
    rows: &[(i16, bool)],
) -> Result<(), StaffScheduleError> {
    if rows.is_empty() {
        return Err(StaffScheduleError::BadRequest(
            "provide 7 weekday rows (0=Sun … 6=Sat)".into(),
        ));
    }
    if rows.len() != 7 {
        return Err(StaffScheduleError::BadRequest(
            "exactly 7 weekday rows required".into(),
        ));
    }
    for (wd, _) in rows {
        if *wd < 0 || *wd > 6 {
            return Err(StaffScheduleError::BadRequest(
                "weekday must be 0-6 (Sun-Sat)".into(),
            ));
        }
    }
    let role_ok: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM staff
            WHERE id = $1 AND is_active = TRUE AND role IN ('salesperson', 'sales_support')
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

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM staff_weekly_availability WHERE staff_id = $1")
        .bind(staff_id)
        .execute(&mut *tx)
        .await?;
    for (wd, works) in rows {
        sqlx::query(
            r#"
            INSERT INTO staff_weekly_availability (staff_id, weekday, works)
            VALUES ($1, $2, $3)
            "#,
        )
        .bind(staff_id)
        .bind(wd)
        .bind(works)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ExceptionRow {
    pub id: Uuid,
    pub staff_id: Uuid,
    pub exception_date: NaiveDate,
    pub kind: DbStaffScheduleExceptionKind,
    pub notes: Option<String>,
}

pub async fn list_exceptions_range(
    pool: &PgPool,
    staff_id: Uuid,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<ExceptionRow>, sqlx::Error> {
    sqlx::query_as::<_, ExceptionRow>(
        r#"
        SELECT id, staff_id, exception_date, kind, notes
        FROM staff_day_exception
        WHERE staff_id = $1 AND exception_date >= $2 AND exception_date <= $3
        ORDER BY exception_date ASC
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
            WHERE id = $1 AND is_active = TRUE AND role IN ('salesperson', 'sales_support')
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
    notes: Option<&str>,
    created_by: Uuid,
) -> Result<(), StaffScheduleError> {
    assert_floor_staff(pool, staff_id).await?;

    sqlx::query(
        r#"
        INSERT INTO staff_day_exception (staff_id, exception_date, kind, notes, created_by_staff_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (staff_id, exception_date) DO UPDATE SET
            kind = EXCLUDED.kind,
            notes = EXCLUDED.notes,
            created_by_staff_id = EXCLUDED.created_by_staff_id,
            created_at = now()
        "#,
    )
    .bind(staff_id)
    .bind(exception_date)
    .bind(kind)
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
        INSERT INTO staff_day_exception (staff_id, exception_date, kind, notes, created_by_staff_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (staff_id, exception_date) DO UPDATE SET
            kind = EXCLUDED.kind,
            notes = EXCLUDED.notes,
            created_by_staff_id = EXCLUDED.created_by_staff_id,
            created_at = now()
        "#,
    )
    .bind(staff_id)
    .bind(absence_date)
    .bind(kind)
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
        let working = is_working_day(pool, staff_id, d).await?;
        out.push(EffectiveDay { date: d, working });
    }
    Ok(out)
}
