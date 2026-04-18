//! ROS Dev Center v1 domain logic (ops health, stations, alerts, actions, bug overlays).

use std::path::PathBuf;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tokio::process::Command;
use uuid::Uuid;

use crate::logic::backups::BackupManager;
use crate::logic::help_corpus;

#[derive(Debug, Serialize, sqlx::FromRow, Clone)]
pub struct IntegrationHealthItem {
    pub key: String,
    pub title: String,
    pub status: String,
    pub severity: String,
    pub detail: String,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_failure_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct StationHeartbeatIn {
    pub station_key: String,
    pub station_label: String,
    pub app_version: String,
    #[serde(default)]
    pub git_sha: Option<String>,
    #[serde(default)]
    pub tailscale_node: Option<String>,
    #[serde(default)]
    pub lan_ip: Option<String>,
    #[serde(default)]
    pub last_sync_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_update_check_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_update_install_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub meta: Value,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct StationRow {
    pub station_key: String,
    pub station_label: String,
    pub app_version: String,
    pub git_sha: Option<String>,
    pub tailscale_node: Option<String>,
    pub lan_ip: Option<String>,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub last_update_check_at: Option<DateTime<Utc>>,
    pub last_update_install_at: Option<DateTime<Utc>>,
    pub last_seen_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub online: bool,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AlertEventRow {
    pub id: Uuid,
    pub rule_key: String,
    pub title: String,
    pub body: String,
    pub severity: String,
    pub status: String,
    pub context: Value,
    pub first_seen_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub acked_at: Option<DateTime<Utc>>,
    pub acked_by_staff_id: Option<Uuid>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub resolved_by_staff_id: Option<Uuid>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ActionAuditRow {
    pub id: Uuid,
    pub actor_staff_id: Uuid,
    pub action_key: String,
    pub reason: String,
    pub payload_json: Value,
    pub payload_hash_sha256: String,
    pub correlation_id: Uuid,
    pub result_ok: bool,
    pub result_message: String,
    pub result_json: Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct BugOverviewRow {
    pub id: Uuid,
    pub correlation_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub status: String,
    pub summary: String,
    pub staff_name: String,
    pub linked_incidents: i64,
    pub oldest_linked_alert_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct OpsHealthSnapshot {
    pub server_time: DateTime<Utc>,
    pub db_ok: bool,
    pub meilisearch_configured: bool,
    pub tailscale_expected: bool,
    pub integrations: Vec<IntegrationHealthItem>,
    pub open_alerts: i64,
    pub stations_online: i64,
    pub stations_offline: i64,
    pub pending_bug_reports: i64,
}

#[derive(Debug, Serialize)]
pub struct GuardedActionResult {
    pub ok: bool,
    pub message: String,
    pub data: Value,
}

fn backup_overdue_hours() -> i64 {
    std::env::var("RIVERSIDE_BACKUP_OVERDUE_HOURS")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|h: &i64| *h > 0 && *h <= 720)
        .unwrap_or(30)
}

fn now_online_cutoff() -> DateTime<Utc> {
    Utc::now() - Duration::minutes(5)
}

fn normalize_label(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        "Unnamed station".to_string()
    } else {
        t.to_string()
    }
}

fn payload_sha256(payload: &Value) -> String {
    let bytes = serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec());
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    hex::encode(hasher.finalize())
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn help_manifest_script_path() -> PathBuf {
    repo_root()
        .join("client")
        .join("scripts")
        .join("generate-help-manifest.mjs")
}

async fn upsert_open_alert(
    pool: &PgPool,
    rule_key: &str,
    dedupe_key: &str,
    title: &str,
    body: &str,
    severity: &str,
    context: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO ops_alert_event (
            rule_key, dedupe_key, title, body, severity, status, context,
            first_seen_at, last_seen_at, created_at, updated_at,
            acked_at, acked_by_staff_id, resolved_at, resolved_by_staff_id
        )
        VALUES (
            $1, $2, $3, $4, $5, 'open', $6,
            NOW(), NOW(), NOW(), NOW(),
            NULL, NULL, NULL, NULL
        )
        ON CONFLICT (dedupe_key)
        DO UPDATE SET
            title = EXCLUDED.title,
            body = EXCLUDED.body,
            severity = EXCLUDED.severity,
            context = EXCLUDED.context,
            status = 'open',
            last_seen_at = NOW(),
            updated_at = NOW(),
            acked_at = NULL,
            acked_by_staff_id = NULL,
            resolved_at = NULL,
            resolved_by_staff_id = NULL
        "#,
    )
    .bind(rule_key)
    .bind(dedupe_key)
    .bind(title)
    .bind(body)
    .bind(severity)
    .bind(context)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn ping_db(pool: &PgPool) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(pool)
        .await
        .map(|_| true)
        .unwrap_or(false)
}

pub async fn upsert_station_heartbeat(
    pool: &PgPool,
    body: &StationHeartbeatIn,
) -> Result<(), sqlx::Error> {
    let station_key = body.station_key.trim();
    let app_version = body.app_version.trim();
    if station_key.is_empty() || app_version.is_empty() {
        return Err(sqlx::Error::Protocol(
            "station_key and app_version are required".into(),
        ));
    }

    sqlx::query(
        r#"
        INSERT INTO ops_station_heartbeat (
            station_key, station_label, app_version, git_sha, tailscale_node, lan_ip,
            last_sync_at, last_update_check_at, last_update_install_at, meta,
            last_seen_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW(), NOW())
        ON CONFLICT (station_key)
        DO UPDATE SET
            station_label = EXCLUDED.station_label,
            app_version = EXCLUDED.app_version,
            git_sha = EXCLUDED.git_sha,
            tailscale_node = EXCLUDED.tailscale_node,
            lan_ip = EXCLUDED.lan_ip,
            last_sync_at = EXCLUDED.last_sync_at,
            last_update_check_at = EXCLUDED.last_update_check_at,
            last_update_install_at = EXCLUDED.last_update_install_at,
            meta = EXCLUDED.meta,
            last_seen_at = NOW(),
            updated_at = NOW()
        "#,
    )
    .bind(station_key)
    .bind(normalize_label(&body.station_label))
    .bind(app_version)
    .bind(body.git_sha.as_deref())
    .bind(body.tailscale_node.as_deref())
    .bind(body.lan_ip.as_deref())
    .bind(body.last_sync_at)
    .bind(body.last_update_check_at)
    .bind(body.last_update_install_at)
    .bind(&body.meta)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn list_stations(pool: &PgPool) -> Result<Vec<StationRow>, sqlx::Error> {
    let rows = sqlx::query_as::<_, StationRow>(
        r#"
        SELECT
            station_key,
            station_label,
            app_version,
            git_sha,
            tailscale_node,
            lan_ip,
            last_sync_at,
            last_update_check_at,
            last_update_install_at,
            last_seen_at,
            updated_at,
            (last_seen_at >= $1) AS online
        FROM ops_station_heartbeat
        ORDER BY last_seen_at DESC
        "#,
    )
    .bind(now_online_cutoff())
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn list_alerts(pool: &PgPool) -> Result<Vec<AlertEventRow>, sqlx::Error> {
    let rows = sqlx::query_as::<_, AlertEventRow>(
        r#"
        SELECT
            id,
            rule_key,
            title,
            body,
            severity,
            status,
            context,
            first_seen_at,
            last_seen_at,
            acked_at,
            acked_by_staff_id,
            resolved_at,
            resolved_by_staff_id
        FROM ops_alert_event
        ORDER BY
            CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
            last_seen_at DESC
        LIMIT 500
        "#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn ack_alert(pool: &PgPool, id: Uuid, actor_staff_id: Uuid) -> Result<bool, sqlx::Error> {
    let r = sqlx::query(
        r#"
        UPDATE ops_alert_event
        SET status = 'acked',
            acked_at = NOW(),
            acked_by_staff_id = $2,
            updated_at = NOW()
        WHERE id = $1 AND status = 'open'
        "#,
    )
    .bind(id)
    .bind(actor_staff_id)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn list_action_audit(pool: &PgPool) -> Result<Vec<ActionAuditRow>, sqlx::Error> {
    sqlx::query_as::<_, ActionAuditRow>(
        r#"
        SELECT
            id,
            actor_staff_id,
            action_key,
            reason,
            payload_json,
            payload_hash_sha256,
            correlation_id,
            result_ok,
            result_message,
            result_json,
            created_at
        FROM ops_action_audit
        ORDER BY created_at DESC
        LIMIT 500
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn list_bug_overview(pool: &PgPool) -> Result<Vec<BugOverviewRow>, sqlx::Error> {
    sqlx::query_as::<_, BugOverviewRow>(
        r#"
        SELECT
            b.id,
            b.correlation_id,
            b.created_at,
            b.status::text AS status,
            b.summary,
            s.full_name AS staff_name,
            COUNT(l.id)::bigint AS linked_incidents,
            MIN(a.first_seen_at) AS oldest_linked_alert_at
        FROM staff_bug_report b
        JOIN staff s ON s.id = b.staff_id
        LEFT JOIN ops_bug_incident_link l ON l.bug_report_id = b.id
        LEFT JOIN ops_alert_event a ON a.id = l.alert_event_id
        GROUP BY b.id, s.full_name
        ORDER BY b.created_at DESC
        LIMIT 500
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn link_bug_to_alert(
    pool: &PgPool,
    bug_report_id: Uuid,
    alert_event_id: Uuid,
    linked_by_staff_id: Uuid,
    note: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO ops_bug_incident_link (bug_report_id, alert_event_id, linked_by_staff_id, note)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (bug_report_id, alert_event_id) DO UPDATE
        SET linked_by_staff_id = EXCLUDED.linked_by_staff_id,
            note = EXCLUDED.note
        "#,
    )
    .bind(bug_report_id)
    .bind(alert_event_id)
    .bind(linked_by_staff_id)
    .bind(note)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn collect_integrations(
    pool: &PgPool,
    meilisearch_configured: bool,
) -> Result<Vec<IntegrationHealthItem>, sqlx::Error> {
    #[derive(sqlx::FromRow)]
    struct IntegrationStateRow {
        source: String,
        last_failure_at: Option<DateTime<Utc>>,
        last_success_at: Option<DateTime<Utc>>,
        detail: Option<String>,
        updated_at: DateTime<Utc>,
    }

    let mut items: Vec<IntegrationHealthItem> = Vec::new();

    let states = sqlx::query_as::<_, IntegrationStateRow>(
        r#"
        SELECT source, last_failure_at, last_success_at, detail, updated_at
        FROM integration_alert_state
        ORDER BY source
        "#,
    )
    .fetch_all(pool)
    .await?;

    for s in states {
        let failed = match (s.last_failure_at, s.last_success_at) {
            (Some(f), Some(ok)) => f > ok,
            (Some(_), None) => true,
            _ => false,
        };
        let (status, severity) = if failed {
            ("failed", "critical")
        } else {
            ("healthy", "info")
        };

        let title = match s.source.as_str() {
            "qbo_token_refresh" => "QBO token refresh",
            "weather_finalize" => "Weather finalize",
            _ => s.source.as_str(),
        }
        .to_string();

        items.push(IntegrationHealthItem {
            key: s.source,
            title,
            status: status.to_string(),
            severity: severity.to_string(),
            detail: s.detail.unwrap_or_default(),
            last_success_at: s.last_success_at,
            last_failure_at: s.last_failure_at,
            updated_at: Some(s.updated_at),
        });
    }

    #[derive(sqlx::FromRow)]
    struct CounterpointRow {
        entity: String,
        last_ok_at: Option<DateTime<Utc>>,
        last_error: Option<String>,
        updated_at: DateTime<Utc>,
    }

    let cp_rows = sqlx::query_as::<_, CounterpointRow>(
        r#"
        SELECT entity, last_ok_at, last_error, updated_at
        FROM counterpoint_sync_runs
        ORDER BY updated_at DESC
        "#,
    )
    .fetch_all(pool)
    .await?;

    let now = Utc::now();
    let stale_threshold = now - Duration::hours(72);
    let mut cp_failed = false;
    let cp_detail: String;
    if cp_rows.is_empty() {
        cp_detail = "No Counterpoint sync runs recorded yet".to_string();
    } else {
        let stale_entities: Vec<String> = cp_rows
            .iter()
            .filter_map(|r| {
                if r.last_error
                    .as_deref()
                    .map(|x| !x.trim().is_empty())
                    .unwrap_or(false)
                {
                    return Some(format!("{} (error)", r.entity));
                }
                match r.last_ok_at {
                    Some(ok) if ok < stale_threshold => Some(format!("{} (stale)", r.entity)),
                    None => Some(format!("{} (never succeeded)", r.entity)),
                    _ => None,
                }
            })
            .collect();
        cp_failed = !stale_entities.is_empty();
        if cp_failed {
            cp_detail = format!("{}", stale_entities.join(", "));
        } else {
            cp_detail = "All Counterpoint entities recently healthy".to_string();
        }
    }

    items.push(IntegrationHealthItem {
        key: "counterpoint_sync".to_string(),
        title: "Counterpoint sync".to_string(),
        status: if cp_failed { "degraded" } else { "healthy" }.to_string(),
        severity: if cp_failed {
            "warning".to_string()
        } else {
            "info".to_string()
        },
        detail: cp_detail,
        last_success_at: cp_rows.iter().filter_map(|r| r.last_ok_at).max(),
        last_failure_at: None,
        updated_at: cp_rows.first().map(|r| r.updated_at),
    });

    items.push(IntegrationHealthItem {
        key: "meilisearch".to_string(),
        title: "Meilisearch".to_string(),
        status: if meilisearch_configured {
            "healthy"
        } else {
            "disabled"
        }
        .to_string(),
        severity: if meilisearch_configured {
            "info".to_string()
        } else {
            "warning".to_string()
        },
        detail: if meilisearch_configured {
            "Configured".to_string()
        } else {
            "Not configured (fallback search path active)".to_string()
        },
        last_success_at: None,
        last_failure_at: None,
        updated_at: None,
    });

    Ok(items)
}

pub async fn evaluate_alerts_from_health(
    pool: &PgPool,
    integrations: &[IntegrationHealthItem],
    stations: &[StationRow],
) -> Result<(), sqlx::Error> {
    let overdue_hours = backup_overdue_hours();

    let backup_last_ok: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT last_local_success_at FROM store_backup_health WHERE id = 1")
            .fetch_optional(pool)
            .await?
            .flatten();

    if let Some(last_ok) = backup_last_ok {
        if last_ok < Utc::now() - Duration::hours(overdue_hours) {
            let body = format!("Last successful local backup is older than {overdue_hours} hours.");
            upsert_open_alert(
                pool,
                "backup_overdue",
                "backup_overdue",
                "Database backup overdue",
                &body,
                "critical",
                json!({ "last_local_success_at": last_ok.to_rfc3339(), "threshold_hours": overdue_hours }),
            )
            .await?;
        }
    }

    for i in integrations {
        if i.key == "qbo_token_refresh" && i.status == "failed" {
            upsert_open_alert(
                pool,
                "integration_qbo_failure",
                "integration_qbo_failure",
                "QBO integration failure",
                if i.detail.trim().is_empty() {
                    "QBO token refresh is failing"
                } else {
                    i.detail.as_str()
                },
                "critical",
                json!({ "integration": i.key }),
            )
            .await?;
        }

        if i.key == "weather_finalize" && i.status == "failed" {
            upsert_open_alert(
                pool,
                "integration_weather_failure",
                "integration_weather_failure",
                "Weather integration failure",
                if i.detail.trim().is_empty() {
                    "Weather finalize job is failing"
                } else {
                    i.detail.as_str()
                },
                "warning",
                json!({ "integration": i.key }),
            )
            .await?;
        }

        if i.key == "counterpoint_sync" && i.status != "healthy" {
            upsert_open_alert(
                pool,
                "counterpoint_sync_stale",
                "counterpoint_sync_stale",
                "Counterpoint sync stale",
                if i.detail.trim().is_empty() {
                    "Counterpoint sync entities are stale or failing"
                } else {
                    i.detail.as_str()
                },
                "warning",
                json!({ "integration": i.key }),
            )
            .await?;
        }
    }

    for s in stations.iter().filter(|s| !s.online) {
        let dedupe = format!("station_offline:{}", s.station_key);
        let body = format!(
            "{} has not reported heartbeat since {}",
            s.station_label, s.last_seen_at
        );
        upsert_open_alert(
            pool,
            "station_offline",
            &dedupe,
            "Register workstation offline",
            &body,
            "warning",
            json!({ "station_key": s.station_key, "station_label": s.station_label, "last_seen_at": s.last_seen_at.to_rfc3339() }),
        )
        .await?;
    }

    Ok(())
}

pub async fn health_snapshot(
    pool: &PgPool,
    meilisearch_configured: bool,
) -> Result<OpsHealthSnapshot, sqlx::Error> {
    let integrations = collect_integrations(pool, meilisearch_configured).await?;
    let stations = list_stations(pool).await?;
    evaluate_alerts_from_health(pool, &integrations, &stations).await?;

    let open_alerts: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM ops_alert_event WHERE status IN ('open', 'acked')",
    )
    .fetch_one(pool)
    .await?;

    let stations_online = stations.iter().filter(|s| s.online).count() as i64;
    let stations_offline = stations.iter().filter(|s| !s.online).count() as i64;

    let pending_bug_reports: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM staff_bug_report WHERE status = 'pending'::bug_report_status",
    )
    .fetch_one(pool)
    .await?;

    Ok(OpsHealthSnapshot {
        server_time: Utc::now(),
        db_ok: ping_db(pool).await,
        meilisearch_configured,
        tailscale_expected: true,
        integrations,
        open_alerts,
        stations_online,
        stations_offline,
        pending_bug_reports,
    })
}

pub async fn write_action_audit(
    pool: &PgPool,
    actor_staff_id: Uuid,
    action_key: &str,
    reason: &str,
    payload_json: &Value,
    result: &GuardedActionResult,
) -> Result<ActionAuditRow, sqlx::Error> {
    let hash = payload_sha256(payload_json);

    sqlx::query_as::<_, ActionAuditRow>(
        r#"
        INSERT INTO ops_action_audit (
            actor_staff_id,
            action_key,
            reason,
            payload_json,
            payload_hash_sha256,
            correlation_id,
            result_ok,
            result_message,
            result_json
        )
        VALUES ($1, $2, $3, $4, $5, uuid_generate_v4(), $6, $7, $8)
        RETURNING
            id,
            actor_staff_id,
            action_key,
            reason,
            payload_json,
            payload_hash_sha256,
            correlation_id,
            result_ok,
            result_message,
            result_json,
            created_at
        "#,
    )
    .bind(actor_staff_id)
    .bind(action_key)
    .bind(reason)
    .bind(payload_json)
    .bind(hash)
    .bind(result.ok)
    .bind(&result.message)
    .bind(&result.data)
    .fetch_one(pool)
    .await
}

async fn action_backup_trigger_local(pool: &PgPool) -> GuardedActionResult {
    let database_url = std::env::var("DATABASE_URL").unwrap_or_default();
    if database_url.trim().is_empty() {
        return GuardedActionResult {
            ok: false,
            message: "DATABASE_URL is not configured".to_string(),
            data: json!({}),
        };
    }

    let manager = BackupManager::new(database_url);
    match manager.create_backup().await {
        Ok(filename) => {
            if let Err(e) = crate::logic::backups::record_local_backup_success(pool).await {
                tracing::error!(error = %e, "record_local_backup_success");
            }
            GuardedActionResult {
                ok: true,
                message: "Local backup created".to_string(),
                data: json!({ "filename": filename }),
            }
        }
        Err(e) => {
            let msg = e.to_string();
            if let Err(err) = crate::logic::backups::record_local_backup_failure(pool, &msg).await {
                tracing::error!(error = %err, "record_local_backup_failure");
            }
            GuardedActionResult {
                ok: false,
                message: "Local backup failed".to_string(),
                data: json!({ "error": msg }),
            }
        }
    }
}

async fn action_help_reindex_search(
    meilisearch: Option<&meilisearch_sdk::client::Client>,
) -> GuardedActionResult {
    let Some(client) = meilisearch else {
        return GuardedActionResult {
            ok: false,
            message: "Meilisearch is not configured".to_string(),
            data: json!({}),
        };
    };

    match help_corpus::reindex_help_meilisearch(client).await {
        Ok(_) => GuardedActionResult {
            ok: true,
            message: "Help search reindex completed".to_string(),
            data: json!({ "reindexed": true }),
        },
        Err(e) => GuardedActionResult {
            ok: false,
            message: "Help search reindex failed".to_string(),
            data: json!({ "error": e.to_string() }),
        },
    }
}

async fn action_help_generate_manifest(payload: &Value) -> GuardedActionResult {
    let dry_run = payload
        .get("dry_run")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let include_shadcn = payload
        .get("include_shadcn")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let rescan_components = payload
        .get("rescan_components")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let cleanup_orphans = payload
        .get("cleanup_orphans")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let script = help_manifest_script_path();
    let mut cmd = Command::new("node");
    cmd.arg(&script);
    if dry_run {
        cmd.arg("--dry-run");
    }
    if include_shadcn {
        cmd.arg("--include-shadcn");
    }
    if rescan_components {
        cmd.arg("--rescan-components");
    }
    if cleanup_orphans {
        cmd.arg("--cleanup-orphans");
    }

    match cmd.output().await {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            GuardedActionResult {
                ok: out.status.success(),
                message: if out.status.success() {
                    "Help manifest generation finished".to_string()
                } else {
                    "Help manifest generation failed".to_string()
                },
                data: json!({
                    "exit_code": out.status.code(),
                    "stdout": stdout,
                    "stderr": stderr,
                    "script": script,
                }),
            }
        }
        Err(e) => GuardedActionResult {
            ok: false,
            message: "Failed to start help manifest command".to_string(),
            data: json!({ "error": e.to_string(), "script": script }),
        },
    }
}

pub async fn run_guarded_action(
    pool: &PgPool,
    meilisearch: Option<&meilisearch_sdk::client::Client>,
    action_key: &str,
    payload: &Value,
) -> GuardedActionResult {
    match action_key {
        "backup.trigger_local" => action_backup_trigger_local(pool).await,
        "help.reindex_search" => action_help_reindex_search(meilisearch).await,
        "help.generate_manifest" => action_help_generate_manifest(payload).await,
        _ => GuardedActionResult {
            ok: false,
            message: format!("unknown action key: {action_key}"),
            data: json!({ "allowed": ["backup.trigger_local", "help.reindex_search", "help.generate_manifest"] }),
        },
    }
}
