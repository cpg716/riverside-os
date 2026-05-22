//! Persistence for in-app staff bug reports.

use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, serde::Serialize, serde::Deserialize)]
#[sqlx(type_name = "bug_report_status", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum BugReportStatus {
    Pending,
    Complete,
    Dismissed,
}

#[derive(Debug, serde::Serialize, sqlx::FromRow)]
pub struct BugReportListRow {
    pub id: Uuid,
    pub correlation_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub status: BugReportStatus,
    pub summary: String,
    pub staff_id: Uuid,
    pub staff_name: String,
}

#[derive(Debug, serde::Serialize, sqlx::FromRow)]
pub struct BugReportDetailRow {
    pub id: Uuid,
    pub correlation_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub status: BugReportStatus,
    pub summary: String,
    pub steps_context: String,
    pub client_console_log: String,
    pub client_meta: Value,
    pub screenshot_png: Vec<u8>,
    pub server_log_snapshot: String,
    pub resolver_notes: String,
    pub external_url: String,
    pub staff_id: Uuid,
    pub staff_name: String,
    pub resolved_at: Option<DateTime<Utc>>,
    pub resolver_name: Option<String>,
}

#[derive(Debug, serde::Serialize, sqlx::FromRow)]
pub struct StaffErrorEventRow {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub staff_id: Option<Uuid>,
    pub staff_name: Option<String>,
    pub status: String,
    pub message: String,
    pub event_source: String,
    pub severity: String,
    pub route: Option<String>,
    pub client_meta: Value,
    pub server_log_snapshot: String,
}

/// Count submissions by this staff member since `since` (for abuse throttling).
pub async fn count_bug_reports_since(
    pool: &PgPool,
    staff_id: Uuid,
    since: DateTime<Utc>,
) -> Result<i64, sqlx::Error> {
    let row: (i64,) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint
        FROM staff_bug_report
        WHERE staff_id = $1 AND created_at >= $2
        "#,
    )
    .bind(staff_id)
    .bind(since)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_bug_report(
    pool: &PgPool,
    staff_id: Uuid,
    correlation_id: Uuid,
    summary: &str,
    steps_context: &str,
    client_console_log: &str,
    client_meta: &Value,
    screenshot_png: &[u8],
    server_log_snapshot: &str,
) -> Result<Uuid, sqlx::Error> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        INSERT INTO staff_bug_report (
            staff_id, correlation_id, summary, steps_context, client_console_log, client_meta,
            screenshot_png, server_log_snapshot
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
        "#,
    )
    .bind(staff_id)
    .bind(correlation_id)
    .bind(summary)
    .bind(steps_context)
    .bind(client_console_log)
    .bind(client_meta)
    .bind(screenshot_png)
    .bind(server_log_snapshot)
    .fetch_one(pool)
    .await
}

pub async fn list_bug_reports(pool: &PgPool) -> Result<Vec<BugReportListRow>, sqlx::Error> {
    sqlx::query_as::<_, BugReportListRow>(
        r#"
        SELECT
            b.id,
            b.correlation_id,
            b.created_at,
            b.status,
            b.summary,
            b.staff_id,
            s.full_name AS staff_name
        FROM staff_bug_report b
        JOIN staff s ON s.id = b.staff_id
        ORDER BY b.created_at DESC
        LIMIT 500
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn get_bug_report(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<BugReportDetailRow>, sqlx::Error> {
    let row = sqlx::query_as::<_, BugReportDetailRow>(
        r#"
        SELECT
            b.id,
            b.correlation_id,
            b.created_at,
            b.updated_at,
            b.status,
            b.summary,
            b.steps_context,
            b.client_console_log,
            b.client_meta,
            b.screenshot_png,
            b.server_log_snapshot,
            b.resolver_notes,
            b.external_url,
            b.staff_id,
            s.full_name AS staff_name,
            b.resolved_at,
            rs.full_name AS resolver_name
        FROM staff_bug_report b
        JOIN staff s ON s.id = b.staff_id
        LEFT JOIN staff rs ON rs.id = b.resolved_by_staff_id
        WHERE b.id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Merge PATCH fields; at least one of `status`, `resolver_notes`, `external_url` should be `Some` (caller validates).
pub async fn patch_bug_report(
    pool: &PgPool,
    id: Uuid,
    actor_staff_id: Uuid,
    status: Option<BugReportStatus>,
    resolver_notes: Option<&str>,
    external_url: Option<&str>,
) -> Result<bool, sqlx::Error> {
    type PatchBugReportPreflight = (
        BugReportStatus,
        String,
        String,
        Option<DateTime<Utc>>,
        Option<Uuid>,
    );
    let row: Option<PatchBugReportPreflight> = sqlx::query_as(
        r#"
        SELECT status, resolver_notes, external_url, resolved_at, resolved_by_staff_id
        FROM staff_bug_report
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    let Some((cur_status, cur_notes, cur_url, cur_resolved_at, cur_resolved_by)) = row else {
        return Ok(false);
    };

    let new_status = status.unwrap_or(cur_status);
    let new_notes = match resolver_notes {
        None => cur_notes,
        Some(s) => s.to_string(),
    };
    let new_url = match external_url {
        None => cur_url,
        Some(s) => s.to_string(),
    };

    let (new_resolved_at, new_resolved_by) = if new_status == BugReportStatus::Pending {
        (None, None)
    } else if matches!(cur_status, BugReportStatus::Pending) {
        (Some(Utc::now()), Some(actor_staff_id))
    } else {
        (cur_resolved_at, cur_resolved_by)
    };

    let r = sqlx::query(
        r#"
        UPDATE staff_bug_report
        SET status = $2,
            resolver_notes = $3,
            external_url = $4,
            updated_at = now(),
            resolved_at = $5,
            resolved_by_staff_id = $6
        WHERE id = $1
        "#,
    )
    .bind(id)
    .bind(new_status)
    .bind(new_notes)
    .bind(new_url)
    .bind(new_resolved_at)
    .bind(new_resolved_by)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_staff_error_event(
    pool: &PgPool,
    staff_id: Option<Uuid>,
    message: &str,
    event_source: &str,
    severity: &str,
    route: Option<&str>,
    client_meta: &Value,
    server_log_snapshot: &str,
) -> Result<Uuid, sqlx::Error> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        INSERT INTO staff_error_event (
            staff_id, status, message, event_source, severity, route, client_meta, server_log_snapshot
        )
        VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7)
        RETURNING id
        "#,
    )
    .bind(staff_id)
    .bind(message)
    .bind(event_source)
    .bind(severity)
    .bind(route)
    .bind(client_meta)
    .bind(server_log_snapshot)
    .fetch_one(pool)
    .await
}

static FALLBACK_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

fn fallback_mutex() -> &'static Mutex<()> {
    FALLBACK_MUTEX.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FallbackErrorEvent {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub staff_id: Option<Uuid>,
    pub message: String,
    pub event_source: String,
    pub severity: String,
    pub route: Option<String>,
    pub client_meta: Value,
    pub server_log_snapshot: String,
}

pub fn save_to_fallback_file(event: FallbackErrorEvent) -> Result<(), std::io::Error> {
    let _guard = fallback_mutex().lock().unwrap();
    let dir = std::path::Path::new("fallback_logs");
    std::fs::create_dir_all(dir)?;
    let path = dir.join("fallback_errors.json");

    let mut events: Vec<FallbackErrorEvent> = if path.exists() {
        let content = std::fs::read_to_string(&path)?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    };

    events.push(event);
    let serialized = serde_json::to_string_pretty(&events)?;
    std::fs::write(&path, serialized)?;
    Ok(())
}

pub async fn ingest_fallback_errors(pool: &PgPool) -> Result<usize, sqlx::Error> {
    let path = std::path::Path::new("fallback_logs").join("fallback_errors.json");

    // Acquire lock and read the events
    let events = {
        let _guard = fallback_mutex().lock().unwrap();
        if !path.exists() {
            return Ok(0);
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, "Failed to read fallback_errors.json");
                return Ok(0);
            }
        };
        let events: Vec<FallbackErrorEvent> = match serde_json::from_str(&content) {
            Ok(evs) => evs,
            Err(e) => {
                tracing::error!(error = %e, "Failed to parse fallback_errors.json");
                return Ok(0);
            }
        };
        events
    };

    if events.is_empty() {
        return Ok(0);
    }

    let mut count = 0;
    for event in &events {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff_error_event WHERE id = $1)")
                .bind(event.id)
                .fetch_one(pool)
                .await?;
        if exists {
            continue;
        }

        sqlx::query(
            r#"
            INSERT INTO staff_error_event (
                id, created_at, staff_id, status, message, event_source, severity, route, client_meta, server_log_snapshot
            )
            VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9)
            "#,
        )
        .bind(event.id)
        .bind(event.created_at)
        .bind(event.staff_id)
        .bind(&event.message)
        .bind(&event.event_source)
        .bind(&event.severity)
        .bind(event.route.as_deref())
        .bind(&event.client_meta)
        .bind(&event.server_log_snapshot)
        .execute(pool)
        .await?;

        count += 1;
    }

    // Cleanup/truncate the file under lock by filtering out successfully ingested events
    {
        let _guard = fallback_mutex().lock().unwrap();
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(mut current_events) =
                    serde_json::from_str::<Vec<FallbackErrorEvent>>(&content)
                {
                    let before_count = current_events.len();
                    current_events.retain(|e| !events.iter().any(|ingested| ingested.id == e.id));
                    if current_events.is_empty() {
                        let _ = std::fs::remove_file(&path);
                    } else if current_events.len() < before_count {
                        if let Ok(serialized) = serde_json::to_string_pretty(&current_events) {
                            let _ = std::fs::write(&path, serialized);
                        }
                    }
                }
            }
        }
    }

    Ok(count)
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert_server_error_event(
    pool: &PgPool,
    server_dedupe_key: &str,
    message: &str,
    event_source: &str,
    severity: &str,
    route: Option<&str>,
    client_meta: &Value,
    server_log_snapshot: &str,
) -> Result<Uuid, sqlx::Error> {
    let mut meta = client_meta.as_object().cloned().unwrap_or_else(Map::new);
    meta.insert(
        "server_dedupe_key".to_string(),
        json!(server_dedupe_key.trim()),
    );
    let meta = Value::Object(meta);

    let db_result = async {
        if let Some(id) = sqlx::query_scalar::<_, Uuid>(
            r#"
            SELECT id
            FROM staff_error_event
            WHERE event_source = $1
              AND client_meta->>'server_dedupe_key' = $2
              AND lower(coalesce(status, 'pending')) = 'pending'
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )
        .bind(event_source)
        .bind(server_dedupe_key.trim())
        .fetch_optional(pool)
        .await?
        {
            sqlx::query(
                r#"
                UPDATE staff_error_event
                SET
                    message = $2,
                    severity = $3,
                    route = $4,
                    client_meta = $5,
                    server_log_snapshot = $6
                WHERE id = $1
                "#,
            )
            .bind(id)
            .bind(message)
            .bind(severity)
            .bind(route)
            .bind(&meta)
            .bind(server_log_snapshot)
            .execute(pool)
            .await?;
            Ok(id)
        } else {
            insert_staff_error_event(
                pool,
                None,
                message,
                event_source,
                severity,
                route,
                &meta,
                server_log_snapshot,
            )
            .await
        }
    }
    .await;

    match db_result {
        Ok(id) => Ok(id),
        Err(db_err) => {
            let fallback_id = Uuid::new_v4();
            let fallback_event = FallbackErrorEvent {
                id: fallback_id,
                created_at: Utc::now(),
                staff_id: None,
                message: message.to_string(),
                event_source: event_source.to_string(),
                severity: severity.to_string(),
                route: route.map(|s| s.to_string()),
                client_meta: meta,
                server_log_snapshot: server_log_snapshot.to_string(),
            };
            match save_to_fallback_file(fallback_event) {
                Ok(_) => {
                    tracing::warn!(
                        error = %db_err,
                        fallback_id = %fallback_id,
                        "Database unavailable. Server error event saved to fallback file."
                    );
                    Ok(fallback_id)
                }
                Err(file_err) => {
                    tracing::error!(
                        db_error = %db_err,
                        file_error = %file_err,
                        "Database unavailable AND fallback file write failed!"
                    );
                    Err(db_err)
                }
            }
        }
    }
}

pub async fn get_staff_error_event(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<StaffErrorEventRow>, sqlx::Error> {
    sqlx::query_as::<_, StaffErrorEventRow>(
        r#"
        SELECT
            e.id,
            e.created_at,
            e.staff_id,
            s.full_name AS staff_name,
            lower(coalesce(e.status, 'pending')) as status,
            e.message,
            e.event_source,
            e.severity,
            e.route,
            e.client_meta,
            e.server_log_snapshot
        FROM staff_error_event e
        LEFT JOIN staff s ON s.id = e.staff_id
        WHERE e.id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub async fn set_staff_error_event_status(
    pool: &PgPool,
    id: Uuid,
    status: &str,
) -> Result<bool, sqlx::Error> {
    let r = sqlx::query(
        r#"
        UPDATE staff_error_event
        SET status = $2
        WHERE id = $1
        "#,
    )
    .bind(id)
    .bind(status)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn delete_staff_error_event(pool: &PgPool, id: Uuid) -> Result<bool, sqlx::Error> {
    let r = sqlx::query(
        r#"
        DELETE FROM staff_error_event
        WHERE id = $1
        "#,
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn list_staff_error_events(
    pool: &PgPool,
) -> Result<Vec<StaffErrorEventRow>, sqlx::Error> {
    sqlx::query_as::<_, StaffErrorEventRow>(
        r#"
        SELECT
            e.id,
            e.created_at,
            e.staff_id,
            s.full_name AS staff_name,
            lower(coalesce(e.status, 'pending')) as status,
            e.message,
            e.event_source,
            e.severity,
            e.route,
            e.client_meta,
            e.server_log_snapshot
        FROM staff_error_event e
        LEFT JOIN staff s ON s.id = e.staff_id
        WHERE lower(coalesce(e.status, 'pending')) IN ('pending', 'complete', 'archived')
        ORDER BY e.created_at DESC
        LIMIT 500
        "#,
    )
    .fetch_all(pool)
    .await
}

/// Deletes reports older than `retention_days`. Returns rows deleted.
pub async fn purge_bug_reports_older_than(
    pool: &PgPool,
    retention_days: i64,
) -> Result<u64, sqlx::Error> {
    let r = sqlx::query(
        r#"
        DELETE FROM staff_bug_report
        WHERE created_at < (now() - ($1::bigint * interval '1 day'))
        "#,
    )
    .bind(retention_days)
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}

/// Notify all staff with `settings.admin` (in-app inbox).
pub async fn notify_settings_admins_new_report(
    pool: &PgPool,
    report_id: Uuid,
    correlation_id: Uuid,
    summary_preview: &str,
) -> Result<(), sqlx::Error> {
    use crate::auth::permissions::SETTINGS_ADMIN;
    use crate::logic::notifications::{insert_app_notification_deduped, staff_ids_with_permission};
    use serde_json::json;

    let staff = staff_ids_with_permission(pool, SETTINGS_ADMIN).await?;
    if staff.is_empty() {
        return Ok(());
    }

    let body = if summary_preview.chars().count() > 400 {
        format!("{}…", summary_preview.chars().take(400).collect::<String>())
    } else {
        summary_preview.to_string()
    };

    if let Some(nid) = insert_app_notification_deduped(
        pool,
        "staff_bug_report",
        "New bug report",
        &body,
        json!({
            "type": "settings",
            "section": "bug-reports",
            "bug_report_id": report_id.to_string(),
            "correlation_id": correlation_id.to_string(),
        }),
        "bug_reports",
        json!({}),
        None,
    )
    .await?
    {
        crate::logic::notifications::fan_out_notification_to_staff_ids(pool, nid, &staff).await?;
    }
    Ok(())
}
