//! Recurring staff tasks: lazy materialization (no penalty on days off), checklist completion.

use chrono::{Datelike, Duration, NaiveDate, Utc};
use chrono_tz::Tz;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

use crate::models::{DbStaffRole, DbTaskAssigneeKind, DbTaskInstanceStatus, DbTaskRecurrence};

#[derive(Debug, Error)]
pub enum TaskError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("not found")]
    NotFound,
    #[error("forbidden")]
    Forbidden,
    #[error("invalid state: {0}")]
    InvalidState(String),
}

type PendingTaskInstance = (
    Uuid,
    Uuid,
    Uuid,
    String,
    NaiveDate,
    Option<Uuid>,
    String,
    Option<Uuid>,
);
type DueTaskAssignment = (
    Uuid,
    Uuid,
    DbTaskRecurrence,
    Option<Uuid>,
    String,
    Uuid,
    DbStaffRole,
    Option<Uuid>,
);

pub async fn load_store_timezone_name(pool: &PgPool) -> Result<String, sqlx::Error> {
    let raw: Option<Value> =
        sqlx::query_scalar("SELECT receipt_config FROM store_settings WHERE id = 1 LIMIT 1")
            .fetch_optional(pool)
            .await?;

    let tz = raw
        .as_ref()
        .and_then(|v| v.get("timezone"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("America/New_York")
        .to_string();

    Ok(tz)
}

pub fn store_local_date(tz_name: &str) -> NaiveDate {
    let tz: Tz = tz_name.parse().unwrap_or(Tz::UTC);
    Utc::now().with_timezone(&tz).date_naive()
}

pub fn period_key_for(recurrence: DbTaskRecurrence, anchor: NaiveDate) -> String {
    match recurrence {
        DbTaskRecurrence::Daily => anchor.format("%Y-%m-%d").to_string(),
        DbTaskRecurrence::Weekly => {
            let iso = anchor.iso_week();
            format!("{}-W{:02}", iso.year(), iso.week())
        }
        DbTaskRecurrence::Monthly => format!("{}-{:02}", anchor.year(), anchor.month()),
        DbTaskRecurrence::Yearly => format!("{}", anchor.year()),
    }
}

fn sunday_of_week_containing(d: NaiveDate) -> NaiveDate {
    let n = d.weekday().num_days_from_sunday() as i64;
    d - Duration::days(n)
}

fn due_date_for(recurrence: DbTaskRecurrence, anchor: NaiveDate) -> NaiveDate {
    match recurrence {
        DbTaskRecurrence::Daily => anchor,
        DbTaskRecurrence::Weekly => sunday_of_week_containing(anchor) + Duration::days(6),
        DbTaskRecurrence::Monthly => last_day_of_month(anchor.year(), anchor.month()),
        DbTaskRecurrence::Yearly => {
            NaiveDate::from_ymd_opt(anchor.year(), 12, 31).unwrap_or(anchor)
        }
    }
}

fn last_day_of_month(year: i32, month: u32) -> NaiveDate {
    let (ny, nm) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .unwrap_or_else(|| NaiveDate::from_ymd_opt(year, month, 1).unwrap())
}

/// Materialize open instances for this staff member for the current period (store-local). Idempotent.
pub async fn ensure_task_instances(pool: &PgPool, staff_id: Uuid) -> Result<(), TaskError> {
    let tz_name = load_store_timezone_name(pool).await?;
    let today = store_local_date(&tz_name);

    let role: DbStaffRole = sqlx::query_scalar(r#"SELECT role FROM staff WHERE id = $1"#)
        .bind(staff_id)
        .fetch_optional(pool)
        .await?
        .ok_or(TaskError::NotFound)?;

    if matches!(
        role,
        DbStaffRole::Admin
            | DbStaffRole::Salesperson
            | DbStaffRole::SalesSupport
            | DbStaffRole::StaffSupport
            | DbStaffRole::Alterations
    ) {
        let working = crate::logic::staff_schedule::is_working_day(pool, staff_id, today)
            .await
            .map_err(TaskError::Database)?;
        if !working {
            return Ok(());
        }
    }

    let mut tx = pool.begin().await?;

    let rows: Vec<(
        Uuid,
        Uuid,
        DbTaskRecurrence,
        Option<Uuid>,
        String,
        Option<Uuid>,
    )> = sqlx::query_as(
        r#"
        SELECT
            ta.id,
            ta.template_id,
            ta.recurrence,
            ta.customer_id,
            t.title,
            ta.assigned_by_staff_id
        FROM task_assignment ta
        JOIN task_checklist_template t ON t.id = ta.template_id
        WHERE ta.active = TRUE
          AND (ta.starts_on IS NULL OR ta.starts_on <= $1)
          AND (ta.ends_on IS NULL OR ta.ends_on >= $1)
          AND (
            (ta.assignee_kind = 'staff' AND ta.assignee_staff_id = $2)
            OR (ta.assignee_kind = 'role' AND ta.assignee_role = $3)
          )
        "#,
    )
    .bind(today)
    .bind(staff_id)
    .bind(role)
    .fetch_all(&mut *tx)
    .await?;

    for (assignment_id, template_id, recurrence, customer_id, title, assigned_by_staff_id) in rows {
        let period_key = period_key_for(recurrence, today);
        let due_date = due_date_for(recurrence, today);

        let exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM task_instance
                WHERE assignment_id = $1 AND assignee_staff_id = $2 AND period_key = $3
            )
            "#,
        )
        .bind(assignment_id)
        .bind(staff_id)
        .bind(&period_key)
        .fetch_one(&mut *tx)
        .await?;

        if exists {
            continue;
        }

        let instance_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO task_instance (
                assignment_id, assignee_staff_id, period_key, due_date, status,
                customer_id, title_snapshot, assigned_by_staff_id
            )
            VALUES ($1, $2, $3, $4, 'open', $5, $6, $7)
            RETURNING id
            "#,
        )
        .bind(assignment_id)
        .bind(staff_id)
        .bind(&period_key)
        .bind(due_date)
        .bind(customer_id)
        .bind(&title)
        .bind(assigned_by_staff_id)
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO task_instance_item (
                task_instance_id, template_item_id, sort_order, label, required
            )
            SELECT $1, id, sort_order, label, required
            FROM task_checklist_template_item
            WHERE template_id = $2
            ORDER BY sort_order
            "#,
        )
        .bind(instance_id)
        .bind(template_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Materialize due-soon recurring task instances for notification sweeps.
///
/// This keeps reminders from depending on a staff member opening Tasks first,
/// while preserving the working-day guard used by the normal lazy path.
pub async fn materialize_due_task_instances_between(
    pool: &PgPool,
    from_d: NaiveDate,
    to_d: NaiveDate,
) -> Result<(), TaskError> {
    let mut pending: Vec<PendingTaskInstance> = Vec::new();

    let mut anchor = from_d;
    while anchor <= to_d {
        let rows: Vec<DueTaskAssignment> = sqlx::query_as(
            r#"
                SELECT
                    ta.id,
                    ta.template_id,
                    ta.recurrence,
                    ta.customer_id,
                    t.title,
                    s.id,
                    s.role,
                    ta.assigned_by_staff_id
                FROM task_assignment ta
                JOIN task_checklist_template t ON t.id = ta.template_id
                JOIN staff s ON s.is_active = TRUE
                  AND (
                    (ta.assignee_kind = 'staff' AND ta.assignee_staff_id = s.id)
                    OR (ta.assignee_kind = 'role' AND ta.assignee_role = s.role)
                  )
                WHERE ta.active = TRUE
                  AND (ta.starts_on IS NULL OR ta.starts_on <= $1)
                  AND (ta.ends_on IS NULL OR ta.ends_on >= $1)
                "#,
        )
        .bind(anchor)
        .fetch_all(pool)
        .await?;

        for (
            assignment_id,
            template_id,
            recurrence,
            customer_id,
            title,
            staff_id,
            role,
            assigned_by_staff_id,
        ) in rows
        {
            let period_key = period_key_for(recurrence, anchor);
            let due_date = due_date_for(recurrence, anchor);
            if due_date < from_d || due_date > to_d {
                continue;
            }
            if matches!(
                role,
                DbStaffRole::Admin
                    | DbStaffRole::Salesperson
                    | DbStaffRole::SalesSupport
                    | DbStaffRole::StaffSupport
                    | DbStaffRole::Alterations
            ) {
                let working =
                    crate::logic::staff_schedule::is_working_day(pool, staff_id, due_date)
                        .await
                        .map_err(TaskError::Database)?;
                if !working {
                    continue;
                }
            }
            pending.push((
                assignment_id,
                template_id,
                staff_id,
                period_key,
                due_date,
                customer_id,
                title,
                assigned_by_staff_id,
            ));
        }

        anchor += Duration::days(1);
    }

    let mut tx = pool.begin().await?;
    for (
        assignment_id,
        template_id,
        staff_id,
        period_key,
        due_date,
        customer_id,
        title,
        assigned_by_staff_id,
    ) in pending
    {
        let inserted_id: Option<Uuid> = sqlx::query_scalar(
            r#"
            INSERT INTO task_instance (
                assignment_id, assignee_staff_id, period_key, due_date, status,
                customer_id, title_snapshot, assigned_by_staff_id
            )
            VALUES ($1, $2, $3, $4, 'open', $5, $6, $7)
            ON CONFLICT (assignment_id, assignee_staff_id, period_key) DO NOTHING
            RETURNING id
            "#,
        )
        .bind(assignment_id)
        .bind(staff_id)
        .bind(&period_key)
        .bind(due_date)
        .bind(customer_id)
        .bind(&title)
        .bind(assigned_by_staff_id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(instance_id) = inserted_id else {
            continue;
        };

        sqlx::query(
            r#"
            INSERT INTO task_instance_item (
                task_instance_id, template_item_id, sort_order, label, required
            )
            SELECT $1, id, sort_order, label, required
            FROM task_checklist_template_item
            WHERE template_id = $2
            ORDER BY sort_order
            "#,
        )
        .bind(instance_id)
        .bind(template_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    Ok(())
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TaskInstanceItemRow {
    pub id: Uuid,
    pub sort_order: i32,
    pub label: String,
    pub required: bool,
    pub done_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TaskInstanceListRow {
    pub id: Uuid,
    pub title_snapshot: String,
    pub due_date: Option<NaiveDate>,
    pub status: DbTaskInstanceStatus,
    pub customer_id: Option<Uuid>,
    pub period_key: String,
    pub assigned_by_staff_id: Option<Uuid>,
    pub assigned_by_name: Option<String>,
    pub overdue_days: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct TaskInstanceDetail {
    #[serde(flatten)]
    pub meta: TaskInstanceListRow,
    pub items: Vec<TaskInstanceItemRow>,
}

pub async fn list_open_instances_for_staff(
    pool: &PgPool,
    staff_id: Uuid,
) -> Result<Vec<TaskInstanceListRow>, TaskError> {
    ensure_task_instances(pool, staff_id).await?;
    let rows = sqlx::query_as::<_, TaskInstanceListRow>(
        r#"
        SELECT
            ti.id,
            ti.title_snapshot,
            ti.due_date,
            ti.status,
            ti.customer_id,
            ti.period_key,
            ti.assigned_by_staff_id,
            assigner.full_name AS assigned_by_name,
            CASE
                WHEN ti.due_date IS NOT NULL AND ti.due_date < CURRENT_DATE
                THEN (CURRENT_DATE - ti.due_date)::int
                ELSE NULL
            END AS overdue_days
        FROM task_instance ti
        LEFT JOIN staff assigner ON assigner.id = ti.assigned_by_staff_id
        WHERE ti.assignee_staff_id = $1 AND ti.status = 'open'
        ORDER BY ti.due_date NULLS LAST, ti.materialized_at ASC
        "#,
    )
    .bind(staff_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn list_recent_completed_for_staff(
    pool: &PgPool,
    staff_id: Uuid,
    limit: i64,
) -> Result<Vec<TaskInstanceListRow>, TaskError> {
    let rows = sqlx::query_as::<_, TaskInstanceListRow>(
        r#"
        SELECT
            ti.id,
            ti.title_snapshot,
            ti.due_date,
            ti.status,
            ti.customer_id,
            ti.period_key,
            ti.assigned_by_staff_id,
            assigner.full_name AS assigned_by_name,
            NULL::int AS overdue_days
        FROM task_instance ti
        LEFT JOIN staff assigner ON assigner.id = ti.assigned_by_staff_id
        WHERE ti.assignee_staff_id = $1 AND ti.status = 'completed'
        ORDER BY ti.completed_at DESC NULLS LAST
        LIMIT $2
        "#,
    )
    .bind(staff_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_instance_detail(
    pool: &PgPool,
    instance_id: Uuid,
    staff_id: Uuid,
) -> Result<TaskInstanceDetail, TaskError> {
    let meta: Option<TaskInstanceListRow> = sqlx::query_as(
        r#"
        SELECT
            ti.id,
            ti.title_snapshot,
            ti.due_date,
            ti.status,
            ti.customer_id,
            ti.period_key,
            ti.assigned_by_staff_id,
            assigner.full_name AS assigned_by_name,
            CASE
                WHEN ti.status = 'open'::task_instance_status
                  AND ti.due_date IS NOT NULL
                  AND ti.due_date < CURRENT_DATE
                THEN (CURRENT_DATE - ti.due_date)::int
                ELSE NULL
            END AS overdue_days
        FROM task_instance ti
        LEFT JOIN staff assigner ON assigner.id = ti.assigned_by_staff_id
        WHERE ti.id = $1 AND ti.assignee_staff_id = $2
        "#,
    )
    .bind(instance_id)
    .bind(staff_id)
    .fetch_optional(pool)
    .await?;

    let Some(meta) = meta else {
        return Err(TaskError::NotFound);
    };

    load_instance_items(pool, instance_id, meta).await
}

async fn load_instance_items(
    pool: &PgPool,
    instance_id: Uuid,
    meta: TaskInstanceListRow,
) -> Result<TaskInstanceDetail, TaskError> {
    let items: Vec<TaskInstanceItemRow> = sqlx::query_as(
        r#"
        SELECT id, sort_order, label, required, done_at
        FROM task_instance_item
        WHERE task_instance_id = $1
        ORDER BY sort_order ASC
        "#,
    )
    .bind(instance_id)
    .fetch_all(pool)
    .await?;

    Ok(TaskInstanceDetail { meta, items })
}

pub async fn get_instance_detail_any(
    pool: &PgPool,
    instance_id: Uuid,
    actor_staff_id: Uuid,
    allow_manage: bool,
) -> Result<TaskInstanceDetail, TaskError> {
    if allow_manage {
        let meta: Option<TaskInstanceListRow> = sqlx::query_as(
            r#"
            SELECT
                ti.id,
                ti.title_snapshot,
                ti.due_date,
                ti.status,
                ti.customer_id,
                ti.period_key,
                ti.assigned_by_staff_id,
                assigner.full_name AS assigned_by_name,
                CASE
                    WHEN ti.status = 'open'::task_instance_status
                      AND ti.due_date IS NOT NULL
                      AND ti.due_date < CURRENT_DATE
                    THEN (CURRENT_DATE - ti.due_date)::int
                    ELSE NULL
                END AS overdue_days
            FROM task_instance ti
            LEFT JOIN staff assigner ON assigner.id = ti.assigned_by_staff_id
            WHERE ti.id = $1
            "#,
        )
        .bind(instance_id)
        .fetch_optional(pool)
        .await?;

        let Some(meta) = meta else {
            return Err(TaskError::NotFound);
        };

        return load_instance_items(pool, instance_id, meta).await;
    }

    get_instance_detail(pool, instance_id, actor_staff_id).await
}

pub async fn set_instance_item_done(
    pool: &PgPool,
    instance_id: Uuid,
    item_id: Uuid,
    actor_staff_id: Uuid,
    done: bool,
    allow_manage: bool,
) -> Result<(), TaskError> {
    let assignee: Option<Uuid> = sqlx::query_scalar(
        r#"SELECT assignee_staff_id FROM task_instance WHERE id = $1 AND status = 'open'"#,
    )
    .bind(instance_id)
    .fetch_optional(pool)
    .await?;

    let Some(assignee) = assignee else {
        return Err(TaskError::NotFound);
    };

    if assignee != actor_staff_id && !allow_manage {
        return Err(TaskError::Forbidden);
    }

    let belongs: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(SELECT 1 FROM task_instance_item WHERE id = $1 AND task_instance_id = $2)"#,
    )
    .bind(item_id)
    .bind(instance_id)
    .fetch_one(pool)
    .await?;

    if !belongs {
        return Err(TaskError::NotFound);
    }

    if done {
        sqlx::query(
            r#"
            UPDATE task_instance_item
            SET done_at = now(), done_by_staff_id = $1
            WHERE id = $2 AND task_instance_id = $3 AND done_at IS NULL
            "#,
        )
        .bind(actor_staff_id)
        .bind(item_id)
        .bind(instance_id)
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            r#"
            UPDATE task_instance_item
            SET done_at = NULL, done_by_staff_id = NULL
            WHERE id = $1 AND task_instance_id = $2
            "#,
        )
        .bind(item_id)
        .bind(instance_id)
        .execute(pool)
        .await?;
    }

    Ok(())
}

pub async fn try_complete_instance(
    pool: &PgPool,
    instance_id: Uuid,
    actor_staff_id: Uuid,
    allow_manage: bool,
) -> Result<bool, TaskError> {
    let assignee: Option<Uuid> = sqlx::query_scalar(
        r#"SELECT assignee_staff_id FROM task_instance WHERE id = $1 AND status = 'open'"#,
    )
    .bind(instance_id)
    .fetch_optional(pool)
    .await?;

    let Some(assignee) = assignee else {
        return Err(TaskError::NotFound);
    };

    if assignee != actor_staff_id && !allow_manage {
        return Err(TaskError::Forbidden);
    }

    let pending_required: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint FROM task_instance_item
        WHERE task_instance_id = $1 AND required = TRUE AND done_at IS NULL
        "#,
    )
    .bind(instance_id)
    .fetch_one(pool)
    .await?;

    if pending_required > 0 {
        return Ok(false);
    }

    let n = sqlx::query(
        r#"
        UPDATE task_instance
        SET status = 'completed', completed_at = now(), completed_by_staff_id = $1
        WHERE id = $2 AND status = 'open'
        "#,
    )
    .bind(actor_staff_id)
    .bind(instance_id)
    .execute(pool)
    .await?
    .rows_affected();

    Ok(n > 0)
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TeamTaskRow {
    pub instance_id: Uuid,
    pub title_snapshot: String,
    pub due_date: Option<NaiveDate>,
    pub status: DbTaskInstanceStatus,
    pub assignee_staff_id: Uuid,
    pub assignee_name: String,
    pub assignee_avatar_key: String,
    pub assigned_by_staff_id: Option<Uuid>,
    pub assigned_by_name: Option<String>,
    pub overdue_days: Option<i32>,
}

pub async fn list_team_open_tasks(pool: &PgPool) -> Result<Vec<TeamTaskRow>, TaskError> {
    let rows = sqlx::query_as::<_, TeamTaskRow>(
        r#"
        SELECT
            ti.id AS instance_id,
            ti.title_snapshot,
            ti.due_date,
            ti.status,
            ti.assignee_staff_id,
            s.full_name AS assignee_name,
            s.avatar_key AS assignee_avatar_key,
            ti.assigned_by_staff_id,
            assigner.full_name AS assigned_by_name,
            CASE
                WHEN ti.due_date IS NOT NULL AND ti.due_date < CURRENT_DATE
                THEN (CURRENT_DATE - ti.due_date)::int
                ELSE NULL
            END AS overdue_days
        FROM task_instance ti
        JOIN staff s ON s.id = ti.assignee_staff_id
        LEFT JOIN staff assigner ON assigner.id = ti.assigned_by_staff_id
        WHERE ti.status = 'open'
        ORDER BY ti.due_date NULLS LAST, s.full_name ASC
        "#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TaskHistoryRow {
    pub instance_id: Uuid,
    pub title_snapshot: String,
    pub period_key: String,
    pub status: DbTaskInstanceStatus,
    pub completed_at: Option<chrono::DateTime<chrono::Utc>>,
    pub assignee_staff_id: Uuid,
    pub assignee_name: String,
    pub assignee_avatar_key: String,
    pub assigned_by_staff_id: Option<Uuid>,
    pub assigned_by_name: Option<String>,
    pub overdue_days: Option<i32>,
}

pub async fn list_task_history(
    pool: &PgPool,
    meili: Option<&meilisearch_sdk::client::Client>,
    assignee_filter: Option<Uuid>,
    search_text: Option<String>,
    limit: i64,
    offset: i64,
) -> Result<Vec<TaskHistoryRow>, TaskError> {
    let mut search_ids: Option<Vec<Uuid>> = None;
    if let (Some(m), Some(q)) = (meili, search_text.as_ref()) {
        match crate::logic::meilisearch_search::task_search_ids(m, q).await {
            Ok(ids) if !ids.is_empty() => search_ids = Some(ids),
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "Meilisearch task search failed; using PostgreSQL ILIKE"
                );
            }
        }
    }

    let rows = if let Some(ids) = search_ids {
        sqlx::query_as::<_, TaskHistoryRow>(
            r#"
            SELECT
                ti.id AS instance_id,
                ti.title_snapshot,
                ti.period_key,
                ti.status,
                ti.completed_at,
                ti.assignee_staff_id,
                s.full_name AS assignee_name,
                s.avatar_key AS assignee_avatar_key,
                ti.assigned_by_staff_id,
                assigner.full_name AS assigned_by_name,
                CASE
                    WHEN ti.status = 'open'::task_instance_status
                      AND ti.due_date IS NOT NULL
                      AND ti.due_date < CURRENT_DATE
                    THEN (CURRENT_DATE - ti.due_date)::int
                    ELSE NULL
                END AS overdue_days
            FROM UNNEST($1::uuid[]) WITH ORDINALITY AS t(id, ord)
            JOIN task_instance ti ON ti.id = t.id
            JOIN staff s ON s.id = ti.assignee_staff_id
            LEFT JOIN staff assigner ON assigner.id = ti.assigned_by_staff_id
            WHERE ($2::uuid IS NULL OR ti.assignee_staff_id = $2)
            ORDER BY t.ord
            LIMIT $3 OFFSET $4
            "#,
        )
        .bind(&ids)
        .bind(assignee_filter)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?
    } else {
        let q = search_text.map(|s| format!("%{}%", s.to_lowercase()));
        sqlx::query_as::<_, TaskHistoryRow>(
            r#"
            SELECT
                ti.id AS instance_id,
                ti.title_snapshot,
                ti.period_key,
                ti.status,
                ti.completed_at,
                ti.assignee_staff_id,
                s.full_name AS assignee_name,
                s.avatar_key AS assignee_avatar_key,
                ti.assigned_by_staff_id,
                assigner.full_name AS assigned_by_name,
                CASE
                    WHEN ti.status = 'open'::task_instance_status
                      AND ti.due_date IS NOT NULL
                      AND ti.due_date < CURRENT_DATE
                    THEN (CURRENT_DATE - ti.due_date)::int
                    ELSE NULL
                END AS overdue_days
            FROM task_instance ti
            JOIN staff s ON s.id = ti.assignee_staff_id
            LEFT JOIN staff assigner ON assigner.id = ti.assigned_by_staff_id
            WHERE ($1::uuid IS NULL OR ti.assignee_staff_id = $1)
              AND ($2::text IS NULL OR (
                LOWER(ti.title_snapshot) LIKE $2
                OR LOWER(ti.period_key) LIKE $2
                OR LOWER(s.full_name) LIKE $2
                OR LOWER(COALESCE(assigner.full_name, '')) LIKE $2
              ))
            ORDER BY ti.completed_at DESC NULLS LAST, ti.materialized_at DESC
            LIMIT $3 OFFSET $4
            "#,
        )
        .bind(assignee_filter)
        .bind(q)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?
    };

    Ok(rows)
}

// --- Admin CRUD ---

#[derive(Debug, Deserialize)]
pub struct CreateTemplatePayload {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub items: Vec<TemplateItemPayload>,
}

#[derive(Debug, Deserialize)]
pub struct TemplateItemPayload {
    pub label: String,
    #[serde(default = "default_true")]
    pub required: bool,
}

fn default_true() -> bool {
    true
}

pub async fn admin_create_template(
    pool: &PgPool,
    created_by: Uuid,
    body: CreateTemplatePayload,
) -> Result<Uuid, TaskError> {
    let title = body.title.trim();
    if title.is_empty() {
        return Err(TaskError::InvalidState("title required".into()));
    }

    let mut tx = pool.begin().await?;

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO task_checklist_template (title, description, created_by_staff_id)
        VALUES ($1, $2, $3)
        RETURNING id
        "#,
    )
    .bind(title)
    .bind(
        body.description
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty()),
    )
    .bind(created_by)
    .fetch_one(&mut *tx)
    .await?;

    for (i, it) in body.items.iter().enumerate() {
        let lab = it.label.trim();
        if lab.is_empty() {
            continue;
        }
        sqlx::query(
            r#"
            INSERT INTO task_checklist_template_item (template_id, sort_order, label, required)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(id)
        .bind(i as i32)
        .bind(lab)
        .bind(it.required)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(id)
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TemplateSummaryRow {
    pub id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

pub async fn admin_list_templates(pool: &PgPool) -> Result<Vec<TemplateSummaryRow>, TaskError> {
    let rows = sqlx::query_as::<_, TemplateSummaryRow>(
        r#"
        SELECT id, title, description, created_at
        FROM task_checklist_template
        ORDER BY updated_at DESC
        "#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TemplateItemRow {
    pub id: Uuid,
    pub sort_order: i32,
    pub label: String,
    pub required: bool,
}

pub async fn admin_get_template_items(
    pool: &PgPool,
    template_id: Uuid,
) -> Result<Vec<TemplateItemRow>, TaskError> {
    let rows = sqlx::query_as::<_, TemplateItemRow>(
        r#"
        SELECT id, sort_order, label, required
        FROM task_checklist_template_item
        WHERE template_id = $1
        ORDER BY sort_order ASC
        "#,
    )
    .bind(template_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
pub struct CreateAssignmentPayload {
    pub template_id: Uuid,
    pub recurrence: DbTaskRecurrence,
    #[serde(default)]
    pub recurrence_config: Value,
    pub assignee_kind: DbTaskAssigneeKind,
    #[serde(default)]
    pub assignee_staff_id: Option<Uuid>,
    #[serde(default)]
    pub assignee_role: Option<DbStaffRole>,
    #[serde(default)]
    pub customer_id: Option<Uuid>,
    #[serde(default = "default_active")]
    pub active: bool,
    #[serde(default)]
    pub starts_on: Option<NaiveDate>,
    #[serde(default)]
    pub ends_on: Option<NaiveDate>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAssignmentPayload {
    pub template_id: Uuid,
    pub recurrence: DbTaskRecurrence,
    #[serde(default)]
    pub recurrence_config: Value,
    pub assignee_kind: DbTaskAssigneeKind,
    #[serde(default)]
    pub assignee_staff_id: Option<Uuid>,
    #[serde(default)]
    pub assignee_role: Option<DbStaffRole>,
    #[serde(default)]
    pub customer_id: Option<Uuid>,
    #[serde(default = "default_active")]
    pub active: bool,
    #[serde(default)]
    pub starts_on: Option<NaiveDate>,
    #[serde(default)]
    pub ends_on: Option<NaiveDate>,
}

fn default_active() -> bool {
    true
}

fn validate_assignment_target(
    assignee_kind: DbTaskAssigneeKind,
    assignee_staff_id: Option<Uuid>,
    assignee_role: Option<DbStaffRole>,
) -> Result<(), TaskError> {
    match assignee_kind {
        DbTaskAssigneeKind::Staff if assignee_staff_id.is_none() => Err(TaskError::InvalidState(
            "assignee_staff_id required for staff assignment".into(),
        )),
        DbTaskAssigneeKind::Role if assignee_role.is_none() => Err(TaskError::InvalidState(
            "assignee_role required for role assignment".into(),
        )),
        _ => Ok(()),
    }
}

pub async fn admin_create_assignment(
    pool: &PgPool,
    assigned_by_staff_id: Uuid,
    body: CreateAssignmentPayload,
) -> Result<Uuid, TaskError> {
    validate_assignment_target(
        body.assignee_kind,
        body.assignee_staff_id,
        body.assignee_role,
    )?;

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO task_assignment (
            template_id, recurrence, recurrence_config, assignee_kind,
            assignee_staff_id, assignee_role, customer_id, active, starts_on, ends_on,
            assigned_by_staff_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
        "#,
    )
    .bind(body.template_id)
    .bind(body.recurrence)
    .bind(body.recurrence_config)
    .bind(body.assignee_kind)
    .bind(body.assignee_staff_id)
    .bind(body.assignee_role)
    .bind(body.customer_id)
    .bind(body.active)
    .bind(body.starts_on)
    .bind(body.ends_on)
    .bind(assigned_by_staff_id)
    .fetch_one(pool)
    .await?;

    Ok(id)
}

pub async fn admin_update_assignment(
    pool: &PgPool,
    assignment_id: Uuid,
    body: UpdateAssignmentPayload,
) -> Result<(), TaskError> {
    validate_assignment_target(
        body.assignee_kind,
        body.assignee_staff_id,
        body.assignee_role,
    )?;

    let rows = sqlx::query(
        r#"
        UPDATE task_assignment
        SET
            template_id = $1,
            recurrence = $2,
            recurrence_config = $3,
            assignee_kind = $4,
            assignee_staff_id = $5,
            assignee_role = $6,
            customer_id = $7,
            active = $8,
            starts_on = $9,
            ends_on = $10,
            updated_at = now()
        WHERE id = $11
        "#,
    )
    .bind(body.template_id)
    .bind(body.recurrence)
    .bind(body.recurrence_config)
    .bind(body.assignee_kind)
    .bind(body.assignee_staff_id)
    .bind(body.assignee_role)
    .bind(body.customer_id)
    .bind(body.active)
    .bind(body.starts_on)
    .bind(body.ends_on)
    .bind(assignment_id)
    .execute(pool)
    .await?
    .rows_affected();

    if rows == 0 {
        return Err(TaskError::NotFound);
    }

    Ok(())
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AssignmentListRow {
    pub id: Uuid,
    pub template_id: Uuid,
    pub template_title: String,
    pub recurrence: DbTaskRecurrence,
    pub assignee_kind: DbTaskAssigneeKind,
    pub assignee_staff_id: Option<Uuid>,
    pub assignee_role: Option<DbStaffRole>,
    pub customer_id: Option<Uuid>,
    pub customer_display_name: Option<String>,
    pub customer_code: Option<String>,
    pub customer_phone: Option<String>,
    pub active: bool,
    pub starts_on: Option<NaiveDate>,
    pub ends_on: Option<NaiveDate>,
    pub assigned_by_staff_id: Option<Uuid>,
    pub assigned_by_name: Option<String>,
}

pub async fn admin_list_assignments(pool: &PgPool) -> Result<Vec<AssignmentListRow>, TaskError> {
    let rows = sqlx::query_as::<_, AssignmentListRow>(
        r#"
        SELECT
            ta.id,
            ta.template_id,
            t.title AS template_title,
            ta.recurrence,
            ta.assignee_kind,
            ta.assignee_staff_id,
            ta.assignee_role,
            ta.customer_id,
            NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_display_name,
            c.customer_code,
            c.phone AS customer_phone,
            ta.active,
            ta.starts_on,
            ta.ends_on,
            ta.assigned_by_staff_id,
            assigner.full_name AS assigned_by_name
        FROM task_assignment ta
        JOIN task_checklist_template t ON t.id = ta.template_id
        LEFT JOIN customers c ON c.id = ta.customer_id
        LEFT JOIN staff assigner ON assigner.id = ta.assigned_by_staff_id
        ORDER BY ta.created_at DESC
        "#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn admin_set_assignment_active(
    pool: &PgPool,
    assignment_id: Uuid,
    active: bool,
) -> Result<(), TaskError> {
    let n =
        sqlx::query(r#"UPDATE task_assignment SET active = $1, updated_at = now() WHERE id = $2"#)
            .bind(active)
            .bind(assignment_id)
            .execute(pool)
            .await?
            .rows_affected();

    if n == 0 {
        return Err(TaskError::NotFound);
    }
    Ok(())
}

#[derive(Debug, sqlx::FromRow)]
pub struct DueInstanceRow {
    pub id: Uuid,
    pub assignee_staff_id: Uuid,
    pub title_snapshot: String,
    pub due_date: NaiveDate,
}

#[derive(Debug, sqlx::FromRow)]
pub struct OverdueAssignerTaskRow {
    pub id: Uuid,
    pub assigned_by_staff_id: Uuid,
    pub assignee_name: String,
    pub title_snapshot: String,
    pub due_date: NaiveDate,
    pub overdue_days: i32,
}

/// Open instances with due_date between `from_d` and `to_d` inclusive (store-local), for notification sweep.
pub async fn open_instances_due_between(
    pool: &PgPool,
    from_d: NaiveDate,
    to_d: NaiveDate,
) -> Result<Vec<DueInstanceRow>, sqlx::Error> {
    sqlx::query_as::<_, DueInstanceRow>(
        r#"
        SELECT ti.id, ti.assignee_staff_id, ti.title_snapshot, ti.due_date
        FROM task_instance ti
        JOIN staff s ON s.id = ti.assignee_staff_id
        WHERE ti.status = 'open'
          AND ti.due_date IS NOT NULL
          AND ti.due_date >= $1
          AND ti.due_date <= $2
          AND (
            s.role NOT IN ('admin', 'salesperson', 'sales_support', 'staff_support', 'alterations')
            OR staff_effective_working_day(ti.assignee_staff_id, ti.due_date)
          )
        "#,
    )
    .bind(from_d)
    .bind(to_d)
    .fetch_all(pool)
    .await
}

/// Open tasks past due, grouped later by the staff member who assigned them.
pub async fn open_instances_overdue_for_assigners(
    pool: &PgPool,
    today: NaiveDate,
) -> Result<Vec<OverdueAssignerTaskRow>, sqlx::Error> {
    sqlx::query_as::<_, OverdueAssignerTaskRow>(
        r#"
        SELECT
            ti.id,
            ti.assigned_by_staff_id,
            assignee.full_name AS assignee_name,
            ti.title_snapshot,
            ti.due_date,
            ($1::date - ti.due_date)::int AS overdue_days
        FROM task_instance ti
        JOIN staff assignee ON assignee.id = ti.assignee_staff_id
        JOIN staff assigner ON assigner.id = ti.assigned_by_staff_id
        WHERE ti.status = 'open'
          AND ti.assigned_by_staff_id IS NOT NULL
          AND ti.due_date IS NOT NULL
          AND ti.due_date < $1
          AND assigner.is_active = TRUE
        ORDER BY ti.due_date ASC, assignee.full_name ASC
        "#,
    )
    .bind(today)
    .fetch_all(pool)
    .await
}

/// Ad-hoc checklist for each active sales_support staff: post cash/check R2S payment in portal.
#[allow(clippy::too_many_arguments)]
pub async fn create_adhoc_rms_payment_followup_tasks(
    pool: &PgPool,
    transaction_id: Uuid,
    customer_id: Uuid,
    customer_display: Option<&str>,
    order_short_ref: &str,
    amount_paid: Decimal,
    payment_methods_label: &str,
    operator_staff_id: Uuid,
) -> Result<(), TaskError> {
    let staff_ids: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id FROM staff
        WHERE is_active = TRUE AND role = 'sales_support'::staff_role
        "#,
    )
    .fetch_all(pool)
    .await?;

    if staff_ids.is_empty() {
        tracing::warn!("no active sales_support staff for R2S payment follow-up tasks");
        return Ok(());
    }

    let assignee_count = staff_ids.len();
    let tz_name = load_store_timezone_name(pool).await?;
    let today = store_local_date(&tz_name);
    let cust = customer_display
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Customer");

    let title = "Post payment to R2S";
    let item_label = format!(
        "Post this payment in the R2S portal. Order ref: {order_short_ref}. Amount: ${amount_paid}. Tender: {payment_methods_label}. Customer: {cust} (id {customer_id})."
    );

    for sid in staff_ids {
        let period_key = format!("rms_r2s_payment:{transaction_id}:{sid}");
        let instance_id: Option<Uuid> = sqlx::query_scalar(
            r#"
            INSERT INTO task_instance (
                assignment_id, assignee_staff_id, period_key, due_date, status,
                customer_id, title_snapshot, assigned_by_staff_id, idempotency_key
            )
            VALUES (NULL, $1, $2, $3, 'open', $4, $5, $6, $2)
            ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
            RETURNING id
            "#,
        )
        .bind(sid)
        .bind(&period_key)
        .bind(today)
        .bind(customer_id)
        .bind(title)
        .bind(operator_staff_id)
        .fetch_optional(pool)
        .await?;

        let Some(instance_id) = instance_id else {
            continue;
        };

        sqlx::query(
            r#"
            INSERT INTO task_instance_item (
                task_instance_id, template_item_id, sort_order, label, required
            )
            VALUES ($1, NULL, 0, $2, true)
            "#,
        )
        .bind(instance_id)
        .bind(&item_label)
        .execute(pool)
        .await?;
    }

    let _ = crate::auth::pins::log_staff_access_once(
        pool,
        operator_staff_id,
        "rms_payment_tasks_created",
        serde_json::json!({
            "transaction_id": transaction_id,
            "customer_id": customer_id,
            "assignee_count": assignee_count,
        }),
        &format!("rms_payment_tasks_created:{transaction_id}"),
    )
    .await;

    Ok(())
}
