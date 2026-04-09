//! Counterpoint → ROS ingest (Windows bridge). One-way upserts into PostgreSQL.
//! Covers: customers, inventory, catalog (products + variants), gift cards,
//! ticket history (orders + payments + optional PS_TKT_HIST_GFT), open docs,
//! vendor items (PO_VEND_ITEM), loyalty history (PS_LOY_PTS_HIST), and heartbeat / sync status.
//! Ticket and open-doc orders are only inserted after **every** line resolves to a variant
//! (no partial orders with mismatched totals).

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};
use thiserror::Error;
use uuid::Uuid;

use crate::logic::store_credit;

#[derive(Debug, Error)]
pub enum CounterpointSyncError {
    #[error("invalid payload: {0}")]
    InvalidPayload(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Deserialize)]
pub struct SyncCursorIn {
    pub entity: String,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointCustomerRow {
    /// Becomes `customers.customer_code` (Counterpoint `CUST_NO`).
    pub cust_no: String,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
    /// Counterpoint `NAM` when bridge does not split names.
    #[serde(default)]
    pub full_name: Option<String>,
    #[serde(default)]
    pub company_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub address_line1: Option<String>,
    #[serde(default)]
    pub address_line2: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub postal_code: Option<String>,
    #[serde(default)]
    pub date_of_birth: Option<String>,
    #[serde(default)]
    pub marketing_email_opt_in: Option<bool>,
    #[serde(default)]
    pub marketing_sms_opt_in: Option<bool>,
    /// Counterpoint `PTS_BAL` → `customers.loyalty_points`.
    #[serde(default)]
    pub loyalty_points: Option<i32>,
    /// Counterpoint `CUST_TYP` → `customers.custom_field_1` (customer type tag).
    #[serde(default)]
    pub customer_type: Option<String>,
    /// Counterpoint A/R `BAL` → `customers.custom_field_2` (as string for reference).
    #[serde(default)]
    pub ar_balance: Option<String>,
    /// Counterpoint `SLS_REP` → `customers.preferred_salesperson_id` (resolved via staff map).
    #[serde(default)]
    pub sls_rep: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointCustomerBatchSummary {
    pub created: i32,
    pub updated: i32,
    pub skipped: i32,
    pub email_conflicts: i32,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointCustomersPayload {
    pub rows: Vec<CounterpointCustomerRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointInventoryRow {
    pub sku: String,
    pub stock_on_hand: i32,
    #[serde(default)]
    pub counterpoint_item_key: Option<String>,
    #[serde(default)]
    pub unit_cost: Option<Decimal>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointInventoryPayload {
    pub rows: Vec<CounterpointInventoryRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointInventorySummary {
    pub updated: i32,
    pub skipped: i32,
}

fn trim_opt(s: &Option<String>) -> Option<String> {
    s.as_ref()
        .map(|x| x.trim())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
}

/// Keep within `customers` varchar limits so Counterpoint-wide fields do not fail the batch.
fn clamp_chars(s: &str, max_chars: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max_chars {
        return t.to_string();
    }
    t.chars().take(max_chars).collect()
}

/// `vendors.name` is UNIQUE (exact string). Counterpoint repeats `NAM` across `VEND_NO`; suffix + retry
/// covers same-batch inserts, pre-existing `Name [code]` rows, and truncation collisions.
async fn allocate_unique_vendor_display_name(
    tx: &mut Transaction<'_, Postgres>,
    row_name: &Option<String>,
    vend_no: &str,
) -> Result<String, CounterpointSyncError> {
    let base_display = trim_opt(row_name).unwrap_or_else(|| vend_no.to_string());
    let base_trim = base_display.trim();

    let lower_clash: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM vendors
            WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
              AND (vendor_code IS NULL OR TRIM(vendor_code) <> TRIM($2))
        )
        "#,
    )
    .bind(base_trim)
    .bind(vend_no)
    .fetch_one(&mut **tx)
    .await?;

    let mut attempt: u32 = 0;
    loop {
        let candidate = if attempt == 0 && !lower_clash {
            clamp_chars(base_trim, 255)
        } else if attempt == 0 {
            let sfx = format!(" [{vend_no}]");
            let room = 255usize.saturating_sub(sfx.chars().count()).max(1);
            format!("{}{}", clamp_chars(base_trim, room), sfx)
        } else {
            let sfx = format!(" [{vend_no}]#{attempt}");
            let room = 255usize.saturating_sub(sfx.chars().count()).max(1);
            format!("{}{}", clamp_chars(base_trim, room), sfx)
        };

        let name_taken: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM vendors
                WHERE name = $1
                  AND (vendor_code IS NULL OR TRIM(vendor_code) <> TRIM($2))
            )
            "#,
        )
        .bind(&candidate)
        .bind(vend_no)
        .fetch_one(&mut **tx)
        .await?;

        if !name_taken {
            return Ok(candidate);
        }

        attempt += 1;
        if attempt > 200 {
            return Err(CounterpointSyncError::InvalidPayload(format!(
                "could not allocate unique vendor name for VEND_NO {vend_no} (base={base_trim:?})"
            )));
        }
    }
}

fn parse_dob(raw: &str) -> Option<NaiveDate> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    NaiveDate::parse_from_str(t, "%Y-%m-%d")
        .ok()
        .or_else(|| NaiveDate::parse_from_str(t, "%m/%d/%Y").ok())
}

fn resolve_names(row: &CounterpointCustomerRow, code: &str) -> (String, String, Option<String>) {
    let company = trim_opt(&row.company_name);
    let mut first = trim_opt(&row.first_name).unwrap_or_default();
    let mut last = trim_opt(&row.last_name).unwrap_or_default();
    if first.is_empty() && last.is_empty() {
        if let Some(ref nam) = trim_opt(&row.full_name) {
            if let Some((a, b)) = nam.split_once(',') {
                last = a.trim().to_string();
                first = b.trim().to_string();
            } else if let Some(idx) = nam.find(' ') {
                first = nam[..idx].trim().to_string();
                last = nam[idx..].trim().to_string();
            } else {
                first = nam.clone();
            }
        }
    }
    if first.is_empty() && last.is_empty() {
        if let Some(ref c) = company {
            first = "Company".to_string();
            last = c.clone();
        } else {
            first = "Imported".to_string();
            last = code.to_string();
        }
    }
    (first, last, company)
}

async fn email_taken_by_other(
    tx: &mut Transaction<'_, Postgres>,
    email: &str,
    exclude_customer_id: Option<Uuid>,
) -> Result<bool, sqlx::Error> {
    let exists: bool = match exclude_customer_id {
        Some(id) => sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM customers WHERE lower(trim(email)) = lower(trim($1)) AND id <> $2)",
        )
        .bind(email)
        .bind(id)
        .fetch_one(&mut **tx)
        .await?,
        None => sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM customers WHERE lower(trim(email)) = lower(trim($1)))",
        )
        .bind(email)
        .fetch_one(&mut **tx)
        .await?,
    };
    Ok(exists)
}

async fn upsert_customer_row(
    pool: &PgPool,
    tx: &mut Transaction<'_, Postgres>,
    row: &CounterpointCustomerRow,
    summary: &mut CounterpointCustomerBatchSummary,
) -> Result<(), sqlx::Error> {
    let code = row.cust_no.trim();
    if code.is_empty() {
        summary.skipped += 1;
        return Ok(());
    }
    let code = code.to_string();

    let (first_name, last_name, company_name) = resolve_names(row, &code);
    let first_name = clamp_chars(&first_name, 100);
    let last_name = clamp_chars(&last_name, 100);
    let email_raw = trim_opt(&row.email)
        .map(|e| e.to_lowercase())
        .map(|e| clamp_chars(&e, 255));
    let phone = trim_opt(&row.phone).map(|p| clamp_chars(&p, 20));
    let address_line1 = trim_opt(&row.address_line1);
    let address_line2 = trim_opt(&row.address_line2);
    let city = trim_opt(&row.city);
    let state = trim_opt(&row.state);
    let postal_code = trim_opt(&row.postal_code);

    let dob = row.date_of_birth.as_deref().and_then(parse_dob);

    let m_email = row.marketing_email_opt_in.unwrap_or(false);
    let m_sms = row.marketing_sms_opt_in.unwrap_or(false);
    let loyalty_pts = row.loyalty_points;
    let cust_type = trim_opt(&row.customer_type);
    let ar_bal = trim_opt(&row.ar_balance);
    let preferred_rep = resolve_staff_id(pool, row.sls_rep.as_deref()).await;

    let existing_id: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM customers WHERE customer_code = $1")
            .bind(&code)
            .fetch_optional(&mut **tx)
            .await?;

    let mut email_to_set = email_raw.clone();
    if let Some(ref em) = email_to_set {
        if email_taken_by_other(tx, em, existing_id).await? {
            email_to_set = None;
            summary.email_conflicts += 1;
        }
    }

    if let Some(id) = existing_id {
        sqlx::query(
            r#"
            UPDATE customers SET
                first_name = $2, last_name = $3, company_name = $4,
                email = COALESCE($5, email),
                phone = $6,
                address_line1 = $7, address_line2 = $8, city = $9, state = $10, postal_code = $11,
                date_of_birth = COALESCE($12, date_of_birth),
                marketing_email_opt_in = $13, marketing_sms_opt_in = $14,
                transactional_sms_opt_in = $15,
                transactional_email_opt_in = $16,
                loyalty_points = COALESCE($17, loyalty_points),
                custom_field_1 = COALESCE($18, custom_field_1),
                custom_field_2 = COALESCE($19, custom_field_2),
                preferred_salesperson_id = COALESCE($20, preferred_salesperson_id)
            WHERE id = $1
            "#,
        )
        .bind(id)
        .bind(&first_name)
        .bind(&last_name)
        .bind(&company_name)
        .bind(&email_to_set)
        .bind(&phone)
        .bind(&address_line1)
        .bind(&address_line2)
        .bind(&city)
        .bind(&state)
        .bind(&postal_code)
        .bind(dob)
        .bind(m_email)
        .bind(m_sms)
        .bind(m_sms)
        .bind(m_email)
        .bind(loyalty_pts)
        .bind(&cust_type)
        .bind(&ar_bal)
        .bind(preferred_rep)
        .execute(&mut **tx)
        .await?;
        summary.updated += 1;
    } else {
        sqlx::query(
            r#"
            INSERT INTO customers (
                customer_code, first_name, last_name, company_name,
                email, phone,
                address_line1, address_line2, city, state, postal_code,
                date_of_birth, anniversary_date,
                custom_field_1, custom_field_2, custom_field_3, custom_field_4,
                marketing_email_opt_in, marketing_sms_opt_in, transactional_sms_opt_in,
                transactional_email_opt_in, customer_created_source, loyalty_points,
                preferred_salesperson_id
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14,NULL,NULL,$15,$16,$17,$18,'counterpoint',COALESCE($19,0),$20)
            "#,
        )
        .bind(&code)
        .bind(&first_name)
        .bind(&last_name)
        .bind(&company_name)
        .bind(&email_to_set)
        .bind(&phone)
        .bind(&address_line1)
        .bind(&address_line2)
        .bind(&city)
        .bind(&state)
        .bind(&postal_code)
        .bind(dob)
        .bind(&cust_type)
        .bind(&ar_bal)
        .bind(m_email)
        .bind(m_sms)
        .bind(m_sms)
        .bind(m_email)
        .bind(loyalty_pts)
        .bind(preferred_rep)
        .execute(&mut **tx)
        .await?;
        summary.created += 1;
    }

    Ok(())
}

pub async fn execute_counterpoint_customer_batch(
    pool: &PgPool,
    payload: CounterpointCustomersPayload,
) -> Result<CounterpointCustomerBatchSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = CounterpointCustomerBatchSummary {
        created: 0,
        updated: 0,
        skipped: 0,
        email_conflicts: 0,
    };

    for row in &payload.rows {
        upsert_customer_row(pool, &mut tx, row, &mut summary).await?;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "customers" {
            let _ = record_sync_run(pool, "customers", s.cursor.as_deref(), true, None).await;
        }
    }

    Ok(summary)
}

pub async fn execute_counterpoint_inventory_batch(
    pool: &PgPool,
    payload: CounterpointInventoryPayload,
) -> Result<CounterpointInventorySummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut updated = 0i32;
    let mut skipped = 0i32;

    for row in &payload.rows {
        let sku = row.sku.trim();
        if sku.is_empty() {
            skipped += 1;
            continue;
        }

        let mut done = false;

        if let Some(ref key) = trim_opt(&row.counterpoint_item_key) {
            let r = sqlx::query(
                r#"
                UPDATE product_variants SET
                    stock_on_hand = $1,
                    cost_override = COALESCE($2, cost_override)
                WHERE counterpoint_item_key = $3
                "#,
            )
            .bind(row.stock_on_hand)
            .bind(row.unit_cost)
            .bind(key)
            .execute(pool)
            .await?;
            if r.rows_affected() > 0 {
                updated += 1;
                done = true;
            }
        }

        if !done {
            let r = sqlx::query(
                r#"
                UPDATE product_variants SET
                    stock_on_hand = $1,
                    cost_override = COALESCE($2, cost_override),
                    counterpoint_item_key = COALESCE($3, counterpoint_item_key)
                WHERE lower(trim(sku)) = lower(trim($4))
                "#,
            )
            .bind(row.stock_on_hand)
            .bind(row.unit_cost)
            .bind(trim_opt(&row.counterpoint_item_key))
            .bind(sku)
            .execute(pool)
            .await?;
            if r.rows_affected() > 0 {
                updated += 1;
            } else {
                skipped += 1;
            }
        }
    }

    if let Some(ref s) = payload.sync {
        if s.entity == "inventory" {
            let _ = record_sync_run(pool, "inventory", s.cursor.as_deref(), true, None).await;
        }
    }

    Ok(CounterpointInventorySummary { updated, skipped })
}

pub async fn record_sync_run(
    pool: &PgPool,
    entity: &str,
    cursor: Option<&str>,
    ok: bool,
    err: Option<&str>,
) -> Result<(), sqlx::Error> {
    if ok {
        sqlx::query(
            r#"
            INSERT INTO counterpoint_sync_runs (entity, cursor_value, last_ok_at, last_error, updated_at)
            VALUES ($1, $2, NOW(), NULL, NOW())
            ON CONFLICT (entity) DO UPDATE SET
                cursor_value = EXCLUDED.cursor_value,
                last_ok_at = NOW(),
                last_error = NULL,
                updated_at = NOW()
            "#,
        )
        .bind(entity)
        .bind(cursor)
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO counterpoint_sync_runs (entity, cursor_value, last_ok_at, last_error, updated_at)
            VALUES ($1, $2, NULL, $3, NOW())
            ON CONFLICT (entity) DO UPDATE SET
                last_error = EXCLUDED.last_error,
                updated_at = NOW()
            "#,
        )
        .bind(entity)
        .bind(cursor)
        .bind(err)
        .execute(pool)
        .await?;
    }
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// Heartbeat
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct HeartbeatPayload {
    pub phase: String,
    #[serde(default)]
    pub current_entity: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub hostname: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HeartbeatResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_request_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_request_entity: Option<String>,
}

pub async fn upsert_heartbeat(
    pool: &PgPool,
    payload: &HeartbeatPayload,
) -> Result<HeartbeatResponse, sqlx::Error> {
    let phase = payload.phase.trim();
    let phase = if phase.is_empty() { "idle" } else { phase };

    sqlx::query(
        r#"
        UPDATE counterpoint_bridge_heartbeat SET
            last_seen_at = NOW(),
            bridge_phase = $1,
            current_entity = $2,
            bridge_version = $3,
            bridge_hostname = $4,
            updated_at = NOW()
        WHERE id = 1
        "#,
    )
    .bind(phase)
    .bind(&payload.current_entity)
    .bind(&payload.version)
    .bind(&payload.hostname)
    .execute(pool)
    .await?;

    let pending: Option<(i64, Option<String>)> = sqlx::query_as(
        "SELECT id, entity FROM counterpoint_sync_request WHERE acked_at IS NULL AND completed_at IS NULL ORDER BY requested_at LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;

    Ok(HeartbeatResponse {
        ok: true,
        pending_request_id: pending.as_ref().map(|r| r.0),
        pending_request_entity: pending.and_then(|r| r.1),
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Sync status for Settings UI
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct SyncStatusResponse {
    pub windows_sync_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offline_reason: Option<String>,
    pub bridge_phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_entity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<DateTime<Utc>>,
    pub entity_runs: Vec<EntityRunRow>,
    pub recent_issues: Vec<SyncIssueRow>,
    pub token_configured: bool,
    pub counterpoint_staging_enabled: bool,
    pub staging_pending_count: i64,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct EntityRunRow {
    pub entity: String,
    pub cursor_value: Option<String>,
    pub last_ok_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SyncIssueRow {
    pub id: i64,
    pub entity: String,
    pub external_key: Option<String>,
    pub severity: String,
    pub message: String,
    pub resolved: bool,
    pub created_at: DateTime<Utc>,
}

const HEARTBEAT_TTL_SECONDS: i64 = 120;

pub async fn get_sync_status(
    pool: &PgPool,
    token_configured: bool,
) -> Result<SyncStatusResponse, sqlx::Error> {
    let hb = sqlx::query_as::<_, (DateTime<Utc>, String, Option<String>, Option<String>, Option<String>)>(
        "SELECT last_seen_at, bridge_phase, current_entity, bridge_version, bridge_hostname FROM counterpoint_bridge_heartbeat WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?;

    let (state, offline_reason, phase, entity, version, hostname, last_seen) = match hb {
        Some((seen, phase, entity, ver, host)) => {
            if !token_configured {
                (
                    "offline".into(),
                    Some("COUNTERPOINT_SYNC_TOKEN not set on server".into()),
                    phase,
                    entity,
                    ver,
                    host,
                    Some(seen),
                )
            } else {
                let age = Utc::now().signed_duration_since(seen).num_seconds();
                if age > HEARTBEAT_TTL_SECONDS {
                    (
                        "offline".into(),
                        Some(format!(
                            "Last heartbeat {age}s ago (TTL {HEARTBEAT_TTL_SECONDS}s)"
                        )),
                        phase,
                        entity,
                        ver,
                        host,
                        Some(seen),
                    )
                } else if phase == "syncing" {
                    ("syncing".into(), None, phase, entity, ver, host, Some(seen))
                } else {
                    ("online".into(), None, phase, entity, ver, host, Some(seen))
                }
            }
        }
        None => {
            if !token_configured {
                (
                    "offline".into(),
                    Some("COUNTERPOINT_SYNC_TOKEN not set on server".into()),
                    "idle".into(),
                    None,
                    None,
                    None,
                    None,
                )
            } else {
                (
                    "offline".into(),
                    Some("No heartbeat received yet".into()),
                    "idle".into(),
                    None,
                    None,
                    None,
                    None,
                )
            }
        }
    };

    let entity_runs: Vec<EntityRunRow> = sqlx::query_as(
        "SELECT entity, cursor_value, last_ok_at, last_error, updated_at FROM counterpoint_sync_runs ORDER BY updated_at DESC",
    )
    .fetch_all(pool)
    .await?;

    let recent_issues: Vec<SyncIssueRow> = sqlx::query_as(
        "SELECT id, entity, external_key, severity, message, resolved, created_at FROM counterpoint_sync_issue WHERE NOT resolved ORDER BY created_at DESC LIMIT 50",
    )
    .fetch_all(pool)
    .await?;

    let counterpoint_staging_enabled: bool = sqlx::query_scalar(
        r#"SELECT COALESCE((counterpoint_config->>'staging_enabled')::boolean, false) FROM store_settings WHERE id = 1"#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or(false);

    let staging_pending_count: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)::bigint FROM counterpoint_staging_batch WHERE status = 'pending'"#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    Ok(SyncStatusResponse {
        windows_sync_state: state,
        offline_reason,
        bridge_phase: phase,
        current_entity: entity,
        bridge_version: version,
        bridge_hostname: hostname,
        last_seen_at: last_seen,
        entity_runs,
        recent_issues,
        token_configured,
        counterpoint_staging_enabled,
        staging_pending_count,
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Sync request queue
// ────────────────────────────────────────────────────────────────────────────

pub async fn create_sync_request(
    pool: &PgPool,
    staff_id: Option<Uuid>,
    entity: Option<&str>,
) -> Result<i64, sqlx::Error> {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO counterpoint_sync_request (requested_by, entity) VALUES ($1, $2) RETURNING id",
    )
    .bind(staff_id)
    .bind(entity)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn ack_sync_request(pool: &PgPool, request_id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE counterpoint_sync_request SET acked_at = NOW() WHERE id = $1")
        .bind(request_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn complete_sync_request(
    pool: &PgPool,
    request_id: i64,
    error: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE counterpoint_sync_request SET completed_at = NOW(), error_message = $2 WHERE id = $1",
    )
    .bind(request_id)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// Sync issues
// ────────────────────────────────────────────────────────────────────────────

async fn record_sync_issue(
    pool: &PgPool,
    entity: &str,
    external_key: Option<&str>,
    severity: &str,
    message: &str,
) {
    let _ = sqlx::query(
        "INSERT INTO counterpoint_sync_issue (entity, external_key, severity, message) VALUES ($1, $2, $3, $4)",
    )
    .bind(entity)
    .bind(external_key)
    .bind(severity)
    .bind(message)
    .execute(pool)
    .await;
}

pub async fn resolve_sync_issue(pool: &PgPool, issue_id: i64) -> Result<bool, sqlx::Error> {
    let r = sqlx::query(
        "UPDATE counterpoint_sync_issue SET resolved = TRUE, resolved_at = NOW() WHERE id = $1 AND NOT resolved",
    )
    .bind(issue_id)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

// ────────────────────────────────────────────────────────────────────────────
// Category masters (IM_CATEG / IM_SUBCAT + IM_ITEM distinct keys → categories + counterpoint_category_map)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointCategoryMasterRow {
    /// Same string the bridge sends as `category` / `categ_cod` on catalog rows (CATEG + optional SUBCATEG).
    pub cp_category: String,
    /// Human-readable name; when absent, server uses `cp_category`.
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointCategoryMastersPayload {
    pub rows: Vec<CounterpointCategoryMasterRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct CategoryMasterSummary {
    pub categories_created: i32,
    pub maps_upserted: i32,
    pub skipped: i32,
    pub already_mapped: i32,
}

async fn get_or_create_category_id_for_cp(
    tx: &mut Transaction<'_, Postgres>,
    display_label: &str,
    summary: &mut CategoryMasterSummary,
) -> Result<Uuid, sqlx::Error> {
    let label = display_label.trim();
    if let Some(id) =
        sqlx::query_scalar("SELECT id FROM categories WHERE lower(trim(name)) = lower(trim($1))")
            .bind(label)
            .fetch_optional(&mut **tx)
            .await?
    {
        return Ok(id);
    }

    if let Some(id) = sqlx::query_scalar(
        r#"
        INSERT INTO categories (name)
        VALUES ($1)
        ON CONFLICT (name) DO NOTHING
        RETURNING id
        "#,
    )
    .bind(label)
    .fetch_optional(&mut **tx)
    .await?
    {
        summary.categories_created += 1;
        return Ok(id);
    }

    let id: Uuid =
        sqlx::query_scalar("SELECT id FROM categories WHERE lower(trim(name)) = lower(trim($1))")
            .bind(label)
            .fetch_one(&mut **tx)
            .await?;
    Ok(id)
}

/// Upserts `categories` + `counterpoint_category_map`. Skips rows that already have a non-null `ros_category_id`
/// so manual Settings mappings are not overwritten.
pub async fn execute_counterpoint_category_masters_batch(
    pool: &PgPool,
    payload: CounterpointCategoryMastersPayload,
) -> Result<CategoryMasterSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = CategoryMasterSummary {
        categories_created: 0,
        maps_upserted: 0,
        skipped: 0,
        already_mapped: 0,
    };

    for row in &payload.rows {
        let cp = row.cp_category.trim();
        if cp.is_empty() {
            summary.skipped += 1;
            continue;
        }

        let has_mapped: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM counterpoint_category_map WHERE cp_category = $1 AND ros_category_id IS NOT NULL)",
        )
        .bind(cp)
        .fetch_one(&mut *tx)
        .await?;

        if has_mapped {
            summary.already_mapped += 1;
            continue;
        }

        let label_src = trim_opt(&row.display_name).unwrap_or_else(|| cp.to_string());
        let label = clamp_chars(&label_src, 500);

        let cat_id = get_or_create_category_id_for_cp(&mut tx, &label, &mut summary).await?;

        sqlx::query(
            r#"
            INSERT INTO counterpoint_category_map (cp_category, ros_category_id)
            VALUES ($1, $2)
            ON CONFLICT (cp_category) DO UPDATE SET
                ros_category_id = COALESCE(counterpoint_category_map.ros_category_id, EXCLUDED.ros_category_id)
            "#,
        )
        .bind(cp)
        .bind(cat_id)
        .execute(&mut *tx)
        .await?;
        summary.maps_upserted += 1;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "category_masters" {
            let _ =
                record_sync_run(pool, "category_masters", s.cursor.as_deref(), true, None).await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Catalog upsert (IM_ITEM + IM_INV_CELL → products + product_variants)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointCatalogRow {
    pub item_no: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Counterpoint `LONG_DESCR` → `products.description`.
    #[serde(default)]
    pub long_description: Option<String>,
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    /// Counterpoint `VEND_NO` — resolved to `vendors.id` via `vendor_code`.
    #[serde(default)]
    pub vendor_no: Option<String>,
    #[serde(default)]
    pub retail_price: Option<Decimal>,
    /// Counterpoint `IM_PRC.PRC_2` / `PRC_3` (optional reference; ROS employee sale price is cost-plus).
    #[serde(default)]
    pub prc_2: Option<Decimal>,
    #[serde(default)]
    pub prc_3: Option<Decimal>,
    #[serde(default)]
    pub unit_cost: Option<Decimal>,
    #[serde(default)]
    pub is_grid: Option<bool>,
    #[serde(default)]
    pub variation_axes: Option<Vec<String>>,
    #[serde(default)]
    pub barcode: Option<String>,
    /// Grid cells: each is a variant row nested under the parent item.
    #[serde(default)]
    pub cells: Vec<CatalogCellRow>,
}

#[derive(Debug, Deserialize)]
pub struct CatalogCellRow {
    pub counterpoint_item_key: String,
    pub sku: String,
    #[serde(default)]
    pub barcode: Option<String>,
    #[serde(default)]
    pub variation_label: Option<String>,
    #[serde(default)]
    pub variation_values: Option<serde_json::Value>,
    #[serde(default)]
    pub stock_on_hand: Option<i32>,
    /// Counterpoint `MIN_QTY` → `product_variants.reorder_point`.
    #[serde(default)]
    pub reorder_point: Option<i32>,
    #[serde(default)]
    pub retail_price: Option<Decimal>,
    #[serde(default)]
    pub prc_2: Option<Decimal>,
    #[serde(default)]
    pub prc_3: Option<Decimal>,
    #[serde(default)]
    pub unit_cost: Option<Decimal>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointCatalogPayload {
    pub rows: Vec<CounterpointCatalogRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct CatalogUpsertSummary {
    pub products_created: i32,
    pub products_updated: i32,
    pub variants_created: i32,
    pub variants_updated: i32,
    pub skipped: i32,
}

pub async fn execute_counterpoint_catalog_batch(
    pool: &PgPool,
    payload: CounterpointCatalogPayload,
) -> Result<CatalogUpsertSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = CatalogUpsertSummary {
        products_created: 0,
        products_updated: 0,
        variants_created: 0,
        variants_updated: 0,
        skipped: 0,
    };

    for row in &payload.rows {
        if let Err(e) = upsert_catalog_item(&mut tx, row, &mut summary).await {
            tracing::warn!(item_no = %row.item_no, error = %e, "catalog row upsert failed, recording issue");
            record_sync_issue(pool, "catalog", Some(&row.item_no), "error", &e.to_string()).await;
            summary.skipped += 1;
        }
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "catalog" {
            let _ = record_sync_run(pool, "catalog", s.cursor.as_deref(), true, None).await;
        }
    }

    Ok(summary)
}

async fn resolve_category_id(
    tx: &mut Transaction<'_, Postgres>,
    cp_category: Option<&str>,
) -> Result<Option<Uuid>, sqlx::Error> {
    let cat = match cp_category {
        Some(c) if !c.trim().is_empty() => c.trim(),
        _ => return Ok(None),
    };
    let mapped: Option<Option<Uuid>> = sqlx::query_scalar(
        "SELECT ros_category_id FROM counterpoint_category_map WHERE cp_category = $1",
    )
    .bind(cat)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(id) = mapped.flatten() {
        return Ok(Some(id));
    }
    let existing: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM categories WHERE lower(trim(name)) = lower(trim($1))")
            .bind(cat)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(existing)
}

async fn resolve_vendor_id(
    tx: &mut Transaction<'_, Postgres>,
    vendor_no: Option<&str>,
) -> Result<Option<Uuid>, sqlx::Error> {
    let vn = match vendor_no {
        Some(v) if !v.trim().is_empty() => v.trim(),
        _ => return Ok(None),
    };
    let id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM vendors WHERE vendor_code = $1")
        .bind(vn)
        .fetch_optional(&mut **tx)
        .await?;
    Ok(id)
}

async fn upsert_catalog_item(
    tx: &mut Transaction<'_, Postgres>,
    row: &CounterpointCatalogRow,
    summary: &mut CatalogUpsertSummary,
) -> Result<(), CounterpointSyncError> {
    let item_no = row.item_no.trim();
    if item_no.is_empty() {
        summary.skipped += 1;
        return Ok(());
    }

    let name = trim_opt(&row.description).unwrap_or_else(|| item_no.to_string());
    let long_desc = trim_opt(&row.long_description);
    let brand = trim_opt(&row.brand);
    let retail = row.retail_price.unwrap_or(Decimal::ZERO);
    let cost = row.unit_cost.unwrap_or(Decimal::ZERO);
    let is_grid = row.is_grid.unwrap_or(!row.cells.is_empty());
    let category_id = resolve_category_id(tx, row.category.as_deref()).await?;
    let vendor_id = resolve_vendor_id(tx, row.vendor_no.as_deref()).await?;

    let existing_product: Option<Uuid> = sqlx::query_scalar(
        "SELECT p.id FROM products p JOIN product_variants pv ON pv.product_id = p.id WHERE pv.counterpoint_item_key = $1 LIMIT 1",
    )
    .bind(item_no)
    .fetch_optional(&mut **tx)
    .await?;

    let product_id = if let Some(pid) = existing_product {
        sqlx::query(
            r#"
            UPDATE products SET
                name = $2, brand = $3,
                base_retail_price = $4, base_cost = $5,
                category_id = COALESCE($6, category_id),
                description = COALESCE($7, description),
                primary_vendor_id = COALESCE($8, primary_vendor_id)
            WHERE id = $1
            "#,
        )
        .bind(pid)
        .bind(&name)
        .bind(&brand)
        .bind(retail)
        .bind(cost)
        .bind(category_id)
        .bind(&long_desc)
        .bind(vendor_id)
        .execute(&mut **tx)
        .await?;
        summary.products_updated += 1;
        pid
    } else {
        let pid: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO products (name, description, brand, base_retail_price, base_cost, category_id, primary_vendor_id, spiff_amount, data_source)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'counterpoint')
            RETURNING id
            "#,
        )
        .bind(&name)
        .bind(&long_desc)
        .bind(&brand)
        .bind(retail)
        .bind(cost)
        .bind(category_id)
        .bind(vendor_id)
        .fetch_one(&mut **tx)
        .await?;
        summary.products_created += 1;
        pid
    };

    if !is_grid || row.cells.is_empty() {
        let sku = trim_opt(&row.barcode).unwrap_or_else(|| item_no.to_string());
        let key = item_no.to_string();
        upsert_variant(
            tx,
            product_id,
            &key,
            &sku,
            row.barcode.as_deref(),
            None,
            None,
            row.retail_price,
            row.unit_cost,
            row.prc_2,
            row.prc_3,
            None,
            None,
            summary,
        )
        .await?;
    } else {
        for cell in &row.cells {
            let key = cell.counterpoint_item_key.trim();
            if key.is_empty() {
                summary.skipped += 1;
                continue;
            }
            upsert_variant(
                tx,
                product_id,
                key,
                &cell.sku,
                cell.barcode.as_deref(),
                cell.variation_label.as_deref(),
                cell.variation_values.as_ref(),
                cell.retail_price,
                cell.unit_cost,
                cell.prc_2,
                cell.prc_3,
                cell.stock_on_hand,
                cell.reorder_point,
                summary,
            )
            .await?;
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn upsert_variant(
    tx: &mut Transaction<'_, Postgres>,
    product_id: Uuid,
    cp_key: &str,
    sku: &str,
    barcode: Option<&str>,
    variation_label: Option<&str>,
    variation_values: Option<&serde_json::Value>,
    override_retail: Option<Decimal>,
    override_cost: Option<Decimal>,
    counterpoint_prc_2: Option<Decimal>,
    counterpoint_prc_3: Option<Decimal>,
    stock: Option<i32>,
    reorder_point: Option<i32>,
    summary: &mut CatalogUpsertSummary,
) -> Result<(), sqlx::Error> {
    let sku = sku.trim();
    if sku.is_empty() {
        summary.skipped += 1;
        return Ok(());
    }

    let existing: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM product_variants WHERE counterpoint_item_key = $1")
            .bind(cp_key)
            .fetch_optional(&mut **tx)
            .await?;

    if let Some(vid) = existing {
        sqlx::query(
            r#"
            UPDATE product_variants SET
                sku = $2,
                barcode = COALESCE($3, barcode),
                variation_label = COALESCE($4, variation_label),
                retail_price_override = COALESCE($5, retail_price_override),
                cost_override = COALESCE($6, cost_override),
                counterpoint_prc_2 = COALESCE($7, counterpoint_prc_2),
                counterpoint_prc_3 = COALESCE($8, counterpoint_prc_3),
                stock_on_hand = COALESCE($9, stock_on_hand),
                reorder_point = COALESCE($10, reorder_point)
            WHERE id = $1
            "#,
        )
        .bind(vid)
        .bind(sku)
        .bind(barcode)
        .bind(variation_label)
        .bind(override_retail)
        .bind(override_cost)
        .bind(counterpoint_prc_2)
        .bind(counterpoint_prc_3)
        .bind(stock)
        .bind(reorder_point)
        .execute(&mut **tx)
        .await?;
        summary.variants_updated += 1;
    } else {
        let vv = variation_values
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        sqlx::query(
            r#"
            INSERT INTO product_variants (
                product_id, sku, barcode, counterpoint_item_key,
                variation_values, variation_label, retail_price_override, cost_override,
                counterpoint_prc_2, counterpoint_prc_3,
                stock_on_hand, reorder_point, reserved_stock
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 0), COALESCE($12, 0), 0)
            "#,
        )
        .bind(product_id)
        .bind(sku)
        .bind(barcode)
        .bind(cp_key)
        .bind(vv)
        .bind(variation_label)
        .bind(override_retail)
        .bind(override_cost)
        .bind(counterpoint_prc_2)
        .bind(counterpoint_prc_3)
        .bind(stock)
        .bind(reorder_point)
        .execute(&mut **tx)
        .await?;
        summary.variants_created += 1;
    }
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// Gift card ingest (SY_GFT_CERT → gift_cards + gift_card_events)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointGiftCardRow {
    pub cert_no: String,
    pub balance: Decimal,
    #[serde(default)]
    pub original_value: Option<Decimal>,
    #[serde(default)]
    pub reason_cod: Option<String>,
    /// Explicit expiration override; if absent, computed from `issued_at` + card kind.
    #[serde(default)]
    pub expires_at: Option<String>,
    /// CP `ISSUE_DAT` — when the card was created/sold.
    #[serde(default)]
    pub issued_at: Option<String>,
    #[serde(default)]
    pub events: Vec<GiftCardEventRow>,
}

#[derive(Debug, Deserialize)]
pub struct GiftCardEventRow {
    pub event_kind: String,
    pub amount: Decimal,
    pub balance_after: Decimal,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointGiftCardsPayload {
    pub rows: Vec<CounterpointGiftCardRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct GiftCardSyncSummary {
    pub created: i32,
    pub updated: i32,
    pub events_created: i32,
    pub skipped: i32,
}

async fn resolve_gift_card_kind(
    tx: &mut Transaction<'_, Postgres>,
    reason_cod: Option<&str>,
) -> String {
    if let Some(code) = reason_cod {
        let mapped: Option<String> = sqlx::query_scalar(
            "SELECT ros_card_kind FROM counterpoint_gift_reason_map WHERE cp_reason_cod = $1",
        )
        .bind(code.trim())
        .fetch_optional(&mut **tx)
        .await
        .unwrap_or(None);
        if let Some(kind) = mapped {
            return kind;
        }
    }
    "purchased".to_string()
}

pub async fn execute_counterpoint_gift_card_batch(
    pool: &PgPool,
    payload: CounterpointGiftCardsPayload,
) -> Result<GiftCardSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = GiftCardSyncSummary {
        created: 0,
        updated: 0,
        events_created: 0,
        skipped: 0,
    };

    for row in &payload.rows {
        let code = row.cert_no.trim();
        if code.is_empty() {
            summary.skipped += 1;
            continue;
        }

        let kind = resolve_gift_card_kind(&mut tx, row.reason_cod.as_deref()).await;
        let is_liability = kind == "purchased";
        let original = row.original_value.unwrap_or(row.balance);

        let issued_at = row.issued_at.as_deref().and_then(|s| {
            DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|d| d.with_timezone(&Utc))
        });

        let expiry_years: i64 = if kind == "purchased" { 9 } else { 1 };

        let expires = row
            .expires_at
            .as_deref()
            .and_then(|s| {
                DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|d| d.with_timezone(&Utc))
            })
            .unwrap_or_else(|| {
                let base = issued_at.unwrap_or_else(Utc::now);
                base + chrono::Duration::days(expiry_years * 365)
            });

        let existing: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM gift_cards WHERE code = $1")
                .bind(code)
                .fetch_optional(&mut *tx)
                .await?;

        let gc_id = if let Some(gid) = existing {
            sqlx::query(
                r#"
                UPDATE gift_cards SET
                    current_balance = $2,
                    card_kind = $3::gift_card_kind,
                    is_liability = $4,
                    expires_at = $5,
                    created_at = COALESCE($6, created_at)
                WHERE id = $1
                "#,
            )
            .bind(gid)
            .bind(row.balance)
            .bind(&kind)
            .bind(is_liability)
            .bind(expires)
            .bind(issued_at)
            .execute(&mut *tx)
            .await?;
            summary.updated += 1;
            gid
        } else {
            let gid: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO gift_cards (code, current_balance, original_value, is_liability, card_kind, card_status, expires_at, created_at)
                VALUES ($1, $2, $3, $4, $5::gift_card_kind, 'active'::gift_card_status, $6, COALESCE($7, CURRENT_TIMESTAMP))
                RETURNING id
                "#,
            )
            .bind(code)
            .bind(row.balance)
            .bind(original)
            .bind(is_liability)
            .bind(&kind)
            .bind(expires)
            .bind(issued_at)
            .fetch_one(&mut *tx)
            .await?;
            summary.created += 1;
            gid
        };

        for evt in &row.events {
            let ts = evt
                .created_at
                .as_deref()
                .and_then(|s| {
                    DateTime::parse_from_rfc3339(s)
                        .ok()
                        .map(|d| d.with_timezone(&Utc))
                })
                .unwrap_or_else(Utc::now);

            sqlx::query(
                r#"
                INSERT INTO gift_card_events (gift_card_id, event_kind, amount, balance_after, notes, created_at)
                VALUES ($1, $2, $3, $4, $5, $6)
                "#,
            )
            .bind(gc_id)
            .bind(&evt.event_kind)
            .bind(evt.amount)
            .bind(evt.balance_after)
            .bind(&evt.notes)
            .bind(ts)
            .execute(&mut *tx)
            .await?;
            summary.events_created += 1;
        }
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "gift_cards" {
            let _ = record_sync_run(pool, "gift_cards", s.cursor.as_deref(), true, None).await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Ticket history ingest (PS_TKT_HIST → orders / order_items / payments)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointTicketRow {
    pub ticket_ref: String,
    #[serde(default)]
    pub cust_no: Option<String>,
    #[serde(default)]
    pub booked_at: Option<String>,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    /// CP `USR_ID` — who rang up / processed the sale.
    #[serde(default)]
    pub usr_id: Option<String>,
    /// CP `SLS_REP` — who earns commission.
    #[serde(default)]
    pub sls_rep: Option<String>,
    #[serde(default)]
    pub lines: Vec<TicketLineRow>,
    #[serde(default)]
    pub payments: Vec<TicketPaymentRow>,
    /// Counterpoint `PS_TKT_HIST_GFT` — gift certificate applications on the ticket (redemptions).
    #[serde(default)]
    pub gift_applications: Vec<TicketGiftApplicationRow>,
}

#[derive(Debug, Deserialize)]
pub struct TicketGiftApplicationRow {
    pub gift_cert_no: String,
    pub amount: Decimal,
    /// CP `ACTION` — rows that look like load/issue are skipped (redemption only here).
    #[serde(default)]
    pub action: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TicketLineRow {
    #[serde(default)]
    pub sku: Option<String>,
    #[serde(default)]
    pub counterpoint_item_key: Option<String>,
    /// Ignored by ingest; bridge may send for debugging (PS_TKT_HIST_LIN.LIN_SEQ_NO).
    #[serde(default)]
    pub lin_seq_no: Option<i32>,
    pub quantity: i32,
    pub unit_price: Decimal,
    #[serde(default)]
    pub unit_cost: Option<Decimal>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TicketPaymentRow {
    pub pmt_typ: String,
    pub amount: Decimal,
    #[serde(default)]
    pub gift_cert_no: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointTicketsPayload {
    pub rows: Vec<CounterpointTicketRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct TicketSyncSummary {
    pub orders_created: i32,
    pub orders_skipped_existing: i32,
    pub line_items_created: i32,
    pub payments_created: i32,
    pub gift_payments_created: i32,
    pub skipped: i32,
}

async fn resolve_payment_method(tx: &mut Transaction<'_, Postgres>, pmt_typ: &str) -> String {
    let mapped: Option<String> = sqlx::query_scalar(
        "SELECT ros_method FROM counterpoint_payment_method_map WHERE cp_pmt_typ = $1",
    )
    .bind(pmt_typ.trim().to_uppercase())
    .fetch_optional(&mut **tx)
    .await
    .unwrap_or(None);
    mapped.unwrap_or_else(|| "cash".to_string())
}

fn cp_gift_hist_row_is_redemption(action: Option<&str>) -> bool {
    match action
        .map(|s| s.trim().to_uppercase())
        .filter(|s| !s.is_empty())
    {
        None => true,
        Some(a) if a.starts_with('L') || a.contains("LOAD") || a.contains("ISSUE") => false,
        _ => true,
    }
}

/// When `PS_TKT_HIST_CELL` is unavailable, ticket lines often carry only the **parent** `ITEM_NO`.
/// Resolve to the single matrix variant whose `counterpoint_item_key` / `sku` shares that parent prefix,
/// disambiguating by **unit price** when multiple matrix rows exist.
async fn resolve_variant_matrix_parent_price_fallback(
    tx: &mut Transaction<'_, Postgres>,
    parent_item_no: &str,
    unit_price: Decimal,
) -> Result<Option<(Uuid, Uuid)>, sqlx::Error> {
    let parent = parent_item_no.trim();
    if parent.is_empty() || parent.contains('|') {
        return Ok(None);
    }
    let parent_lc = parent.to_lowercase();

    let rows: Vec<(Uuid, Uuid, Decimal)> = sqlx::query_as(
        r#"
        SELECT pv.id, pv.product_id,
               COALESCE(pv.retail_price_override, p.base_retail_price) AS eff_price
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        WHERE LOWER(TRIM(SPLIT_PART(COALESCE(pv.counterpoint_item_key, ''), '|', 1))) = $1
           OR LOWER(TRIM(SPLIT_PART(COALESCE(pv.sku, ''), '|', 1))) = $1
        "#,
    )
    .bind(&parent_lc)
    .fetch_all(&mut **tx)
    .await?;

    if rows.is_empty() {
        return Ok(None);
    }
    if rows.len() == 1 {
        return Ok(Some((rows[0].0, rows[0].1)));
    }

    let tol = Decimal::new(1, 2); // $0.01
    let exact: Vec<(Uuid, Uuid)> = rows
        .iter()
        .filter(|(_, _, eff)| (*eff - unit_price).abs() <= tol)
        .map(|(a, b, _)| (*a, *b))
        .collect();
    if exact.len() == 1 {
        return Ok(Some(exact[0]));
    }

    Ok(None)
}

async fn resolve_variant_for_cp_item_no(
    tx: &mut Transaction<'_, Postgres>,
    item_no: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    let item_no = item_no.trim();
    if item_no.is_empty() {
        return Ok(None);
    }
    let by_key: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM product_variants WHERE counterpoint_item_key = $1 LIMIT 1",
    )
    .bind(item_no)
    .fetch_optional(&mut **tx)
    .await?;
    if by_key.is_some() {
        return Ok(by_key);
    }
    sqlx::query_scalar(
        "SELECT id FROM product_variants WHERE lower(trim(sku)) = lower(trim($1)) LIMIT 1",
    )
    .bind(item_no)
    .fetch_optional(&mut **tx)
    .await
}

async fn resolve_variant_for_line(
    tx: &mut Transaction<'_, Postgres>,
    line: &TicketLineRow,
) -> Result<Option<(Uuid, Uuid)>, sqlx::Error> {
    if let Some(ref key) = line.counterpoint_item_key {
        let key = key.trim();
        if !key.is_empty() {
            let row: Option<(Uuid, Uuid)> = sqlx::query_as(
                "SELECT id, product_id FROM product_variants WHERE counterpoint_item_key = $1",
            )
            .bind(key)
            .fetch_optional(&mut **tx)
            .await?;
            if row.is_some() {
                return Ok(row);
            }
        }
    }
    if let Some(ref sku) = line.sku {
        let sku = sku.trim();
        if !sku.is_empty() {
            let row: Option<(Uuid, Uuid)> = sqlx::query_as(
                "SELECT id, product_id FROM product_variants WHERE lower(trim(sku)) = lower(trim($1))",
            )
            .bind(sku)
            .fetch_optional(&mut **tx)
            .await?;
            if row.is_some() {
                return Ok(row);
            }
        }
    }

    // Parent ITEM_NO only (no PS_TKT_HIST_CELL): match matrix variants under same parent + line price.
    let parent_only = line
        .counterpoint_item_key
        .as_deref()
        .or(line.sku.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.contains('|'));
    if let Some(parent) = parent_only {
        if let Some(pair) =
            resolve_variant_matrix_parent_price_fallback(tx, parent, line.unit_price).await?
        {
            return Ok(Some(pair));
        }
    }

    Ok(None)
}

/// Resolves every line to a variant **before** inserting an order so header totals and line items stay consistent.
/// On failure returns `Err(message)` for the first unresolved line. Pairs are in the same order as `lines`.
async fn resolve_ticket_lines_for_import(
    tx: &mut Transaction<'_, Postgres>,
    lines: &[TicketLineRow],
) -> Result<Result<Vec<(Uuid, Uuid)>, String>, sqlx::Error> {
    let mut out = Vec::with_capacity(lines.len());
    for line in lines {
        match resolve_variant_for_line(tx, line).await? {
            Some((vid, pid)) => out.push((vid, pid)),
            None => {
                let sku_str = line.sku.as_deref().unwrap_or("");
                let key = line.counterpoint_item_key.as_deref().unwrap_or("");
                let desc = line.description.as_deref().unwrap_or("Unknown item");
                return Ok(Err(format!(
                    "unresolved line (sku={sku_str:?} counterpoint_item_key={key:?} descr={desc:?}); import catalog and align SKUs or cell keys"
                )));
            }
        }
    }
    Ok(Ok(out))
}

pub async fn execute_counterpoint_ticket_batch(
    pool: &PgPool,
    payload: CounterpointTicketsPayload,
) -> Result<TicketSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = TicketSyncSummary {
        orders_created: 0,
        orders_skipped_existing: 0,
        line_items_created: 0,
        payments_created: 0,
        gift_payments_created: 0,
        skipped: 0,
    };

    for tkt in &payload.rows {
        let ticket_ref = tkt.ticket_ref.trim();
        if ticket_ref.is_empty() {
            summary.skipped += 1;
            continue;
        }

        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM orders WHERE counterpoint_ticket_ref = $1)",
        )
        .bind(ticket_ref)
        .fetch_one(&mut *tx)
        .await?;

        if exists {
            summary.orders_skipped_existing += 1;
            continue;
        }

        if tkt.lines.is_empty() {
            record_sync_issue(
                pool,
                "tickets",
                Some(ticket_ref),
                "warning",
                "Ticket skipped: no line items in payload",
            )
            .await;
            summary.skipped += 1;
            continue;
        }

        let resolved_lines = match resolve_ticket_lines_for_import(&mut tx, &tkt.lines).await? {
            Ok(v) => v,
            Err(msg) => {
                record_sync_issue(pool, "tickets", Some(ticket_ref), "error", &msg).await;
                summary.skipped += 1;
                continue;
            }
        };

        let customer_id: Option<Uuid> = if let Some(ref cn) = tkt.cust_no {
            let cn = cn.trim();
            if !cn.is_empty() {
                sqlx::query_scalar("SELECT id FROM customers WHERE customer_code = $1")
                    .bind(cn)
                    .fetch_optional(&mut *tx)
                    .await?
            } else {
                None
            }
        } else {
            None
        };

        let booked_at = tkt
            .booked_at
            .as_deref()
            .and_then(|s| {
                DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|d| d.with_timezone(&Utc))
            })
            .unwrap_or_else(Utc::now);

        let balance = tkt.total_price - tkt.amount_paid;
        let status = if balance <= Decimal::ZERO {
            "fulfilled"
        } else {
            "open"
        };

        let processed_by = resolve_staff_id(pool, tkt.usr_id.as_deref()).await;
        let salesperson = resolve_staff_id(pool, tkt.sls_rep.as_deref()).await;

        let order_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO orders (
                customer_id, counterpoint_ticket_ref, is_counterpoint_import,
                status, booked_at, total_price, amount_paid, balance_due,
                processed_by_staff_id, primary_salesperson_id
            )
            VALUES ($1, $2, TRUE, $3::order_status, $4, $5, $6, $7, $8, $9)
            RETURNING id
            "#,
        )
        .bind(customer_id)
        .bind(ticket_ref)
        .bind(status)
        .bind(booked_at)
        .bind(tkt.total_price)
        .bind(tkt.amount_paid)
        .bind(balance)
        .bind(processed_by)
        .bind(salesperson)
        .fetch_one(&mut *tx)
        .await?;
        summary.orders_created += 1;

        for ((variant_id, product_id), line) in resolved_lines.iter().zip(tkt.lines.iter()) {
            let cost = line.unit_cost.unwrap_or(Decimal::ZERO);

            sqlx::query(
                r#"
                INSERT INTO order_items (
                    order_id, product_id, variant_id, salesperson_id, fulfillment,
                    quantity, unit_price, unit_cost,
                    state_tax, local_tax, applied_spiff, calculated_commission
                )
                VALUES ($1, $2, $3, $4, 'takeaway'::fulfillment_type, $5, $6, $7, 0, 0, 0, 0)
                "#,
            )
            .bind(order_id)
            .bind(product_id)
            .bind(variant_id)
            .bind(salesperson)
            .bind(line.quantity)
            .bind(line.unit_price)
            .bind(cost)
            .execute(&mut *tx)
            .await?;
            summary.line_items_created += 1;
        }

        for pmt in &tkt.payments {
            let method = resolve_payment_method(&mut tx, &pmt.pmt_typ).await;

            let txn_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO payment_transactions (
                    payer_id, category, payment_method, amount, created_at
                )
                VALUES ($1, 'retail_sale', $2, $3, $4)
                RETURNING id
                "#,
            )
            .bind(customer_id)
            .bind(&method)
            .bind(pmt.amount)
            .bind(booked_at)
            .fetch_one(&mut *tx)
            .await?;

            sqlx::query(
                "INSERT INTO payment_allocations (transaction_id, target_order_id, amount_allocated) VALUES ($1, $2, $3)",
            )
            .bind(txn_id)
            .bind(order_id)
            .bind(pmt.amount)
            .execute(&mut *tx)
            .await?;
            summary.payments_created += 1;
        }

        for ga in &tkt.gift_applications {
            if !cp_gift_hist_row_is_redemption(ga.action.as_deref()) {
                continue;
            }
            let cert = ga.gift_cert_no.trim();
            if cert.is_empty() || ga.amount <= Decimal::ZERO {
                summary.skipped += 1;
                continue;
            }
            let gc_row: Option<(Uuid, Decimal)> =
                sqlx::query_as("SELECT id, current_balance FROM gift_cards WHERE code = $1")
                    .bind(cert)
                    .fetch_optional(&mut *tx)
                    .await?;
            let Some((gc_id, mut bal)) = gc_row else {
                record_sync_issue(
                    pool,
                    "tickets",
                    Some(ticket_ref),
                    "warning",
                    &format!("PS_TKT_HIST_GFT: gift card code not in ROS: {cert}"),
                )
                .await;
                summary.skipped += 1;
                continue;
            };
            let redeem = ga.amount.min(bal);
            if redeem <= Decimal::ZERO {
                summary.skipped += 1;
                continue;
            }
            bal -= redeem;
            sqlx::query("UPDATE gift_cards SET current_balance = $1 WHERE id = $2")
                .bind(bal)
                .bind(gc_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                r#"
                INSERT INTO gift_card_events (
                    gift_card_id, event_kind, amount, balance_after, order_id, notes, created_at
                )
                VALUES ($1, 'redeemed', $2, $3, $4, $5, $6)
                "#,
            )
            .bind(gc_id)
            .bind(-redeem)
            .bind(bal)
            .bind(order_id)
            .bind(format!("Counterpoint ticket {ticket_ref}"))
            .bind(booked_at)
            .execute(&mut *tx)
            .await?;

            let txn_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO payment_transactions (
                    payer_id, category, payment_method, amount, created_at
                )
                VALUES ($1, 'retail_sale', 'gift_card', $2, $3)
                RETURNING id
                "#,
            )
            .bind(customer_id)
            .bind(redeem)
            .bind(booked_at)
            .fetch_one(&mut *tx)
            .await?;

            sqlx::query(
                "INSERT INTO payment_allocations (transaction_id, target_order_id, amount_allocated) VALUES ($1, $2, $3)",
            )
            .bind(txn_id)
            .bind(order_id)
            .bind(redeem)
            .execute(&mut *tx)
            .await?;
            summary.gift_payments_created += 1;
        }
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "tickets" {
            let _ = record_sync_run(pool, "tickets", s.cursor.as_deref(), true, None).await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Store credit opening (Counterpoint → store_credit_accounts + ledger)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointStoreCreditOpeningRow {
    pub cust_no: String,
    pub balance: Decimal,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointStoreCreditOpeningPayload {
    pub rows: Vec<CounterpointStoreCreditOpeningRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct StoreCreditOpeningSyncSummary {
    pub applied: i32,
    pub skipped_non_positive: i32,
    pub skipped_already_imported: i32,
    pub skipped_no_customer: i32,
}

pub async fn execute_counterpoint_store_credit_opening_batch(
    pool: &PgPool,
    payload: CounterpointStoreCreditOpeningPayload,
) -> Result<StoreCreditOpeningSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = StoreCreditOpeningSyncSummary {
        applied: 0,
        skipped_non_positive: 0,
        skipped_already_imported: 0,
        skipped_no_customer: 0,
    };

    for row in &payload.rows {
        let cust = row.cust_no.trim();
        if cust.is_empty() {
            summary.skipped_no_customer += 1;
            continue;
        }
        let customer_id: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM customers WHERE customer_code = $1")
                .bind(cust)
                .fetch_optional(&mut *tx)
                .await?;
        let Some(customer_id) = customer_id else {
            summary.skipped_no_customer += 1;
            continue;
        };

        match store_credit::apply_counterpoint_opening_balance(&mut tx, customer_id, row.balance)
            .await
        {
            Ok(store_credit::CounterpointOpeningBalanceOutcome::Applied) => {
                summary.applied += 1;
            }
            Ok(store_credit::CounterpointOpeningBalanceOutcome::SkippedNonPositive) => {
                summary.skipped_non_positive += 1;
            }
            Ok(store_credit::CounterpointOpeningBalanceOutcome::SkippedAlreadyImported) => {
                summary.skipped_already_imported += 1;
            }
            Err(store_credit::StoreCreditError::Database(d)) => {
                return Err(CounterpointSyncError::Database(d));
            }
            Err(e) => return Err(CounterpointSyncError::InvalidPayload(e.to_string())),
        }
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "store_credit_opening" {
            let _ = record_sync_run(
                pool,
                "store_credit_opening",
                s.cursor.as_deref(),
                true,
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

fn order_status_for_cp_open_doc(
    cp_status: Option<&str>,
    total_price: Decimal,
    amount_paid: Decimal,
) -> &'static str {
    let flag = cp_status
        .map(|s| s.trim().to_uppercase())
        .unwrap_or_default();
    if flag.contains("VOID") || flag.contains("CANCEL") || flag == "V" {
        return "cancelled";
    }
    let balance = total_price - amount_paid;
    if balance <= Decimal::ZERO {
        "fulfilled"
    } else {
        "open"
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Open documents (PS_DOC → orders as special_order lines; idempotent on doc ref)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointOpenDocRow {
    pub doc_ref: String,
    #[serde(default)]
    pub cust_no: Option<String>,
    #[serde(default)]
    pub booked_at: Option<String>,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    #[serde(default)]
    pub usr_id: Option<String>,
    #[serde(default)]
    pub sls_rep: Option<String>,
    /// Raw Counterpoint doc / status flag when available (VOID, cancel markers, etc.).
    #[serde(default)]
    pub cp_status: Option<String>,
    #[serde(default)]
    pub lines: Vec<TicketLineRow>,
    #[serde(default)]
    pub payments: Vec<TicketPaymentRow>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointOpenDocsPayload {
    pub rows: Vec<CounterpointOpenDocRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct OpenDocSyncSummary {
    pub orders_created: i32,
    pub orders_skipped_existing: i32,
    pub line_items_created: i32,
    pub payments_created: i32,
    pub skipped: i32,
}

pub async fn execute_counterpoint_open_doc_batch(
    pool: &PgPool,
    payload: CounterpointOpenDocsPayload,
) -> Result<OpenDocSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = OpenDocSyncSummary {
        orders_created: 0,
        orders_skipped_existing: 0,
        line_items_created: 0,
        payments_created: 0,
        skipped: 0,
    };

    for doc in &payload.rows {
        let doc_ref = doc.doc_ref.trim();
        if doc_ref.is_empty() {
            summary.skipped += 1;
            continue;
        }

        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM orders WHERE counterpoint_doc_ref = $1)",
        )
        .bind(doc_ref)
        .fetch_one(&mut *tx)
        .await?;

        if exists {
            summary.orders_skipped_existing += 1;
            continue;
        }

        let customer_id: Option<Uuid> = if let Some(ref cn) = doc.cust_no {
            let cn = cn.trim();
            if !cn.is_empty() {
                sqlx::query_scalar("SELECT id FROM customers WHERE customer_code = $1")
                    .bind(cn)
                    .fetch_optional(&mut *tx)
                    .await?
            } else {
                None
            }
        } else {
            None
        };

        let booked_at = doc
            .booked_at
            .as_deref()
            .and_then(|s| {
                DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|d| d.with_timezone(&Utc))
            })
            .unwrap_or_else(Utc::now);

        let balance = doc.total_price - doc.amount_paid;
        let status = order_status_for_cp_open_doc(
            doc.cp_status.as_deref(),
            doc.total_price,
            doc.amount_paid,
        );

        let processed_by = resolve_staff_id(pool, doc.usr_id.as_deref()).await;
        let salesperson = resolve_staff_id(pool, doc.sls_rep.as_deref()).await;

        if doc.lines.is_empty() {
            record_sync_issue(
                pool,
                "open_docs",
                Some(doc_ref),
                "warning",
                "Open doc skipped: no line items in payload",
            )
            .await;
            summary.skipped += 1;
            continue;
        }

        let resolved_lines = match resolve_ticket_lines_for_import(&mut tx, &doc.lines).await? {
            Ok(v) => v,
            Err(msg) => {
                record_sync_issue(
                    pool,
                    "open_docs",
                    Some(doc_ref),
                    "error",
                    &format!("Open doc skipped: {msg}"),
                )
                .await;
                summary.skipped += 1;
                continue;
            }
        };

        let order_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO orders (
                customer_id, counterpoint_ticket_ref, counterpoint_doc_ref, is_counterpoint_import,
                status, booked_at, total_price, amount_paid, balance_due,
                processed_by_staff_id, primary_salesperson_id
            )
            VALUES ($1, NULL, $2, TRUE, $3::order_status, $4, $5, $6, $7, $8, $9)
            RETURNING id
            "#,
        )
        .bind(customer_id)
        .bind(doc_ref)
        .bind(status)
        .bind(booked_at)
        .bind(doc.total_price)
        .bind(doc.amount_paid)
        .bind(balance)
        .bind(processed_by)
        .bind(salesperson)
        .fetch_one(&mut *tx)
        .await?;
        summary.orders_created += 1;

        for ((variant_id, product_id), line) in resolved_lines.iter().zip(doc.lines.iter()) {
            let cost = line.unit_cost.unwrap_or(Decimal::ZERO);

            sqlx::query(
                r#"
                INSERT INTO order_items (
                    order_id, product_id, variant_id, salesperson_id, fulfillment,
                    quantity, unit_price, unit_cost,
                    state_tax, local_tax, applied_spiff, calculated_commission
                )
                VALUES ($1, $2, $3, $4, 'special_order'::fulfillment_type, $5, $6, $7, 0, 0, 0, 0)
                "#,
            )
            .bind(order_id)
            .bind(product_id)
            .bind(variant_id)
            .bind(salesperson)
            .bind(line.quantity)
            .bind(line.unit_price)
            .bind(cost)
            .execute(&mut *tx)
            .await?;
            summary.line_items_created += 1;
        }

        for pmt in &doc.payments {
            let method = resolve_payment_method(&mut tx, &pmt.pmt_typ).await;

            let txn_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO payment_transactions (
                    payer_id, category, payment_method, amount, created_at
                )
                VALUES ($1, 'retail_sale', $2, $3, $4)
                RETURNING id
                "#,
            )
            .bind(customer_id)
            .bind(&method)
            .bind(pmt.amount)
            .bind(booked_at)
            .fetch_one(&mut *tx)
            .await?;

            sqlx::query(
                "INSERT INTO payment_allocations (transaction_id, target_order_id, amount_allocated) VALUES ($1, $2, $3)",
            )
            .bind(txn_id)
            .bind(order_id)
            .bind(pmt.amount)
            .execute(&mut *tx)
            .await?;
            summary.payments_created += 1;
        }
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "open_docs" {
            let _ = record_sync_run(pool, "open_docs", s.cursor.as_deref(), true, None).await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Vendor ingest (Counterpoint `PO_VEND` / legacy `AP_VEND` → `vendors`)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointVendorRow {
    pub vend_no: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub account_number: Option<String>,
    /// Counterpoint `TERMS_COD` — payment terms, not the AP account number.
    #[serde(default)]
    pub payment_terms: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointVendorsPayload {
    pub rows: Vec<CounterpointVendorRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct VendorSyncSummary {
    pub created: i32,
    pub updated: i32,
    pub skipped: i32,
}

pub async fn execute_counterpoint_vendor_batch(
    pool: &PgPool,
    payload: CounterpointVendorsPayload,
) -> Result<VendorSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = VendorSyncSummary {
        created: 0,
        updated: 0,
        skipped: 0,
    };

    for row in &payload.rows {
        let vend_no = row.vend_no.trim();
        if vend_no.is_empty() {
            summary.skipped += 1;
            continue;
        }

        let name = allocate_unique_vendor_display_name(&mut tx, &row.name, vend_no).await?;

        let email = trim_opt(&row.email);
        let phone = trim_opt(&row.phone);
        let account_number = trim_opt(&row.account_number);
        let payment_terms = trim_opt(&row.payment_terms).map(|p| clamp_chars(&p, 500));

        let existing: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM vendors WHERE vendor_code = $1")
                .bind(vend_no)
                .fetch_optional(&mut *tx)
                .await?;

        if let Some(vid) = existing {
            sqlx::query(
                "UPDATE vendors SET name = $2, email = COALESCE($3, email), phone = COALESCE($4, phone), account_number = COALESCE($5, account_number), payment_terms = COALESCE($6, payment_terms) WHERE id = $1",
            )
            .bind(vid)
            .bind(&name)
            .bind(&email)
            .bind(&phone)
            .bind(&account_number)
            .bind(&payment_terms)
            .execute(&mut *tx)
            .await?;
            summary.updated += 1;
        } else {
            sqlx::query(
                "INSERT INTO vendors (name, vendor_code, email, phone, account_number, payment_terms, is_active, use_vendor_upc) VALUES ($1, $2, $3, $4, $5, $6, true, false)",
            )
            .bind(&name)
            .bind(vend_no)
            .bind(&email)
            .bind(&phone)
            .bind(&account_number)
            .bind(&payment_terms)
            .execute(&mut *tx)
            .await?;
            summary.created += 1;
        }
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "vendors" {
            let _ = record_sync_run(pool, "vendors", s.cursor.as_deref(), true, None).await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Customer notes ingest (AR_CUST_NOTE → customer_timeline_notes)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointCustomerNoteRow {
    pub cust_no: String,
    pub note_id: String,
    #[serde(default)]
    pub note_date: Option<String>,
    pub note_text: String,
    #[serde(default)]
    pub user_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointCustomerNotesPayload {
    pub rows: Vec<CounterpointCustomerNoteRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct CustomerNotesSyncSummary {
    pub created: i32,
    pub skipped_no_customer: i32,
    pub skipped_duplicate: i32,
}

pub async fn execute_counterpoint_customer_notes_batch(
    pool: &PgPool,
    payload: CounterpointCustomerNotesPayload,
) -> Result<CustomerNotesSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = CustomerNotesSyncSummary {
        created: 0,
        skipped_no_customer: 0,
        skipped_duplicate: 0,
    };

    for row in &payload.rows {
        let cust_no = row.cust_no.trim();
        if cust_no.is_empty() || row.note_text.trim().is_empty() {
            summary.skipped_no_customer += 1;
            continue;
        }

        let customer_id: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM customers WHERE customer_code = $1")
                .bind(cust_no)
                .fetch_optional(&mut *tx)
                .await?;

        let Some(cid) = customer_id else {
            summary.skipped_no_customer += 1;
            continue;
        };

        let tag = format!("[CP:{}]", row.note_id.trim());
        let body = format!(
            "{} {}\n{}",
            tag,
            row.user_id.as_deref().unwrap_or(""),
            row.note_text.trim()
        );

        let already: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM customer_timeline_notes WHERE customer_id = $1 AND body LIKE $2)",
        )
        .bind(cid)
        .bind(format!("{tag}%"))
        .fetch_one(&mut *tx)
        .await?;

        if already {
            summary.skipped_duplicate += 1;
            continue;
        }

        let ts = row
            .note_date
            .as_deref()
            .and_then(|s| {
                DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|d| d.with_timezone(&Utc))
            })
            .unwrap_or_else(Utc::now);

        sqlx::query(
            "INSERT INTO customer_timeline_notes (customer_id, body, created_at) VALUES ($1, $2, $3)",
        )
        .bind(cid)
        .bind(&body)
        .bind(ts)
        .execute(&mut *tx)
        .await?;
        summary.created += 1;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "customer_notes" {
            let _ = record_sync_run(pool, "customer_notes", s.cursor.as_deref(), true, None).await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Staff ingest (SY_USR + PS_SLS_REP → staff + counterpoint_staff_map)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointStaffRow {
    /// The CP identifier (USR_ID or SLS_REP code).
    pub code: String,
    /// "user", "sales_rep", or "buyer".
    #[serde(default = "default_staff_source")]
    pub source: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub commission_rate: Option<Decimal>,
    /// Counterpoint STAT: "A" = active, "I" = inactive.
    #[serde(default)]
    pub status: Option<String>,
    /// SY_USR.USR_GRP_ID — used for role hint (e.g. "MGR" → admin).
    #[serde(default)]
    pub user_group: Option<String>,
}

fn default_staff_source() -> String {
    "user".to_string()
}

#[derive(Debug, Deserialize)]
pub struct CounterpointStaffPayload {
    pub rows: Vec<CounterpointStaffRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct StaffSyncSummary {
    pub created: i32,
    pub updated: i32,
    pub merged: i32,
    pub skipped: i32,
}

fn cp_role_hint(source: &str, user_group: Option<&str>) -> &'static str {
    if let Some(g) = user_group {
        let g = g.trim().to_uppercase();
        if g.contains("MGR") || g.contains("MANAGER") || g.contains("ADMIN") || g.contains("OWNER")
        {
            return "admin";
        }
    }
    match source {
        "sales_rep" => "salesperson",
        "buyer" => "sales_support",
        _ => "sales_support",
    }
}

fn make_cashier_code(code: &str) -> String {
    let trimmed = code.trim();
    let candidate = format!("CP{trimmed}");
    if candidate.len() <= 10 {
        candidate
    } else {
        candidate[..10].to_string()
    }
}

pub async fn execute_counterpoint_staff_batch(
    pool: &PgPool,
    payload: CounterpointStaffPayload,
) -> Result<StaffSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = StaffSyncSummary {
        created: 0,
        updated: 0,
        merged: 0,
        skipped: 0,
    };

    for row in &payload.rows {
        let code = row.code.trim();
        if code.is_empty() {
            summary.skipped += 1;
            continue;
        }
        let source = row.source.trim();
        let source = if source.is_empty() { "user" } else { source };

        let name = trim_opt(&row.name).unwrap_or_else(|| code.to_string());
        let name = clamp_chars(&name, 255);
        let email = trim_opt(&row.email).map(|e| clamp_chars(&e, 255));
        let is_active = row
            .status
            .as_deref()
            .map(|s| s.trim().to_uppercase() != "I")
            .unwrap_or(true);
        let commission = row.commission_rate.unwrap_or(Decimal::ZERO);
        let role = cp_role_hint(source, row.user_group.as_deref());

        let existing_map: Option<Uuid> = sqlx::query_scalar(
            "SELECT ros_staff_id FROM counterpoint_staff_map WHERE cp_code = $1 AND cp_source = $2",
        )
        .bind(code)
        .bind(source)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(staff_id) = existing_map {
            sqlx::query(
                r#"
                UPDATE staff SET
                    full_name = $2,
                    email = COALESCE($3, email),
                    base_commission_rate = $4,
                    is_active = $5
                WHERE id = $1
                "#,
            )
            .bind(staff_id)
            .bind(&name)
            .bind(&email)
            .bind(commission)
            .bind(is_active)
            .execute(&mut *tx)
            .await?;
            summary.updated += 1;
            continue;
        }

        let name_match: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM staff WHERE lower(trim(full_name)) = lower(trim($1))",
        )
        .bind(&name)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(staff_id) = name_match {
            let cp_usr = if source == "user" { Some(code) } else { None };
            let cp_sls = if source == "sales_rep" {
                Some(code)
            } else {
                None
            };
            sqlx::query(
                r#"
                UPDATE staff SET
                    counterpoint_user_id = COALESCE($2, counterpoint_user_id),
                    counterpoint_sls_rep = COALESCE($3, counterpoint_sls_rep),
                    data_source = COALESCE(data_source, 'counterpoint'),
                    email = COALESCE($4, email),
                    base_commission_rate = CASE WHEN $5 > 0 THEN $5 ELSE base_commission_rate END,
                    is_active = $6
                WHERE id = $1
                "#,
            )
            .bind(staff_id)
            .bind(cp_usr)
            .bind(cp_sls)
            .bind(&email)
            .bind(commission)
            .bind(is_active)
            .execute(&mut *tx)
            .await?;

            sqlx::query(
                "INSERT INTO counterpoint_staff_map (cp_code, cp_source, ros_staff_id) VALUES ($1, $2, $3) ON CONFLICT (cp_code, cp_source) DO NOTHING",
            )
            .bind(code)
            .bind(source)
            .bind(staff_id)
            .execute(&mut *tx)
            .await?;
            summary.merged += 1;
            continue;
        }

        let cashier_code = make_cashier_code(code);
        let code_conflict: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE cashier_code = $1)")
                .bind(&cashier_code)
                .fetch_one(&mut *tx)
                .await?;
        if code_conflict {
            record_sync_issue(
                pool,
                "staff",
                Some(code),
                "warning",
                &format!("Cashier code '{cashier_code}' already taken; staff '{name}' skipped"),
            )
            .await;
            summary.skipped += 1;
            continue;
        }

        let cp_usr = if source == "user" {
            Some(code.to_string())
        } else {
            None
        };
        let cp_sls = if source == "sales_rep" {
            Some(code.to_string())
        } else {
            None
        };

        let insert_result: Result<Uuid, sqlx::Error> = sqlx::query_scalar(
            r#"
            INSERT INTO staff (
                full_name, cashier_code, role, base_commission_rate,
                is_active, email, data_source, counterpoint_user_id, counterpoint_sls_rep
            )
            VALUES ($1, $2, $3::staff_role, $4, $5, $6, 'counterpoint', $7, $8)
            RETURNING id
            "#,
        )
        .bind(&name)
        .bind(&cashier_code)
        .bind(role)
        .bind(commission)
        .bind(is_active)
        .bind(&email)
        .bind(&cp_usr)
        .bind(&cp_sls)
        .fetch_one(&mut *tx)
        .await;

        let staff_id: Uuid = match insert_result {
            Ok(sid) => sid,
            Err(e) => {
                record_sync_issue(pool, "staff", Some(code), "error", &e.to_string()).await;
                summary.skipped += 1;
                continue;
            }
        };

        sqlx::query(
            "INSERT INTO counterpoint_staff_map (cp_code, cp_source, ros_staff_id) VALUES ($1, $2, $3)",
        )
        .bind(code)
        .bind(source)
        .bind(staff_id)
        .execute(&mut *tx)
        .await?;
        summary.created += 1;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "staff" {
            let _ = record_sync_run(pool, "staff", s.cursor.as_deref(), true, None).await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// SLS_REP stubs (when PS_SLS_REP is not visible — distinct codes from AR_CUST / PS_TKT_HIST)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointSlsRepStubPayload {
    #[serde(default)]
    pub codes: Vec<String>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct SlsRepStubSummary {
    pub created: i32,
    pub skipped_already_mapped: i32,
    pub skipped_empty: i32,
    pub skipped_cashier_conflict: i32,
}

/// Creates minimal `staff` + `counterpoint_staff_map` rows for `SLS_REP` codes not present in the map.
/// Skips any `cp_code` already mapped (e.g. SY_USR) to avoid duplicate identities.
pub async fn execute_counterpoint_sls_rep_stub_batch(
    pool: &PgPool,
    payload: CounterpointSlsRepStubPayload,
) -> Result<SlsRepStubSummary, CounterpointSyncError> {
    let mut summary = SlsRepStubSummary {
        created: 0,
        skipped_already_mapped: 0,
        skipped_empty: 0,
        skipped_cashier_conflict: 0,
    };

    if payload.codes.is_empty() {
        return Ok(summary);
    }

    let mut tx = pool.begin().await?;

    for raw in &payload.codes {
        let code = raw.trim();
        if code.is_empty() {
            summary.skipped_empty += 1;
            continue;
        }

        let already: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM counterpoint_staff_map WHERE cp_code = $1)",
        )
        .bind(code)
        .fetch_one(&mut *tx)
        .await?;
        if already {
            summary.skipped_already_mapped += 1;
            continue;
        }

        let name = clamp_chars(&format!("Counterpoint rep {code}"), 255);
        let role = cp_role_hint("sales_rep", None);
        let cashier_code = make_cashier_code(code);
        let code_conflict: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE cashier_code = $1)")
                .bind(&cashier_code)
                .fetch_one(&mut *tx)
                .await?;
        if code_conflict {
            record_sync_issue(
                pool,
                "sales_rep_stubs",
                Some(code),
                "warning",
                &format!(
                    "Cashier code '{cashier_code}' already taken; SLS_REP '{code}' stub skipped"
                ),
            )
            .await;
            summary.skipped_cashier_conflict += 1;
            continue;
        }

        let insert_result: Result<Uuid, sqlx::Error> = sqlx::query_scalar(
            r#"
            INSERT INTO staff (
                full_name, cashier_code, role, base_commission_rate,
                is_active, email, data_source, counterpoint_user_id, counterpoint_sls_rep
            )
            VALUES ($1, $2, $3::staff_role, 0, TRUE, NULL, 'counterpoint', NULL, $4)
            RETURNING id
            "#,
        )
        .bind(&name)
        .bind(&cashier_code)
        .bind(role)
        .bind(code)
        .fetch_one(&mut *tx)
        .await;

        let staff_id = match insert_result {
            Ok(sid) => sid,
            Err(e) => {
                record_sync_issue(pool, "sales_rep_stubs", Some(code), "error", &e.to_string())
                    .await;
                summary.skipped_cashier_conflict += 1;
                continue;
            }
        };

        sqlx::query(
            "INSERT INTO counterpoint_staff_map (cp_code, cp_source, ros_staff_id) VALUES ($1, 'sales_rep', $2)",
        )
        .bind(code)
        .bind(staff_id)
        .execute(&mut *tx)
        .await?;
        summary.created += 1;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "sales_rep_stubs" {
            let _ = record_sync_run(pool, "sales_rep_stubs", s.cursor.as_deref(), true, None).await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Loyalty history (PS_LOY_PTS_HIST → loyalty_point_ledger)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointLoyaltyHistRow {
    pub cust_no: String,
    #[serde(default)]
    pub bus_dat: Option<String>,
    #[serde(default)]
    pub pts_earnd: Option<i32>,
    #[serde(default)]
    pub pts_redeemd: Option<i32>,
    #[serde(default)]
    pub ref_no: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointLoyaltyHistPayload {
    pub rows: Vec<CounterpointLoyaltyHistRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct LoyaltyHistSyncSummary {
    pub inserted: i32,
    pub skipped: i32,
}

fn parse_cp_loyalty_bus_dat(raw: Option<&str>) -> Option<DateTime<Utc>> {
    let s = raw?.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(12, 0, 0))
        .map(|nd| nd.and_utc())
}

pub async fn execute_counterpoint_loyalty_hist_batch(
    pool: &PgPool,
    payload: CounterpointLoyaltyHistPayload,
) -> Result<LoyaltyHistSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut rows = payload.rows;
    rows.sort_by(|a, b| {
        a.cust_no
            .trim()
            .cmp(b.cust_no.trim())
            .then_with(|| a.bus_dat.cmp(&b.bus_dat))
            .then_with(|| a.ref_no.cmp(&b.ref_no))
    });

    let mut tx = pool.begin().await?;
    let mut summary = LoyaltyHistSyncSummary {
        inserted: 0,
        skipped: 0,
    };

    // Sum of (earned − redeemed) per customer in this batch. With `customers.loyalty_points` from AR_CUST,
    // opening = balance_now − sum(batch) so partial `PS_LOY_PTS_HIST` since CP_IMPORT_SINCE chains to CP balance.
    let mut sum_by_cust: HashMap<String, i32> = HashMap::new();
    for row in &rows {
        let cn = row.cust_no.trim();
        if cn.is_empty() {
            continue;
        }
        let earnd = row.pts_earnd.unwrap_or(0);
        let redeemd = row.pts_redeemd.unwrap_or(0);
        let delta = earnd - redeemd;
        if delta == 0 {
            continue;
        }
        *sum_by_cust.entry(cn.to_string()).or_insert(0) += delta;
    }

    let cust_codes: Vec<String> = rows
        .iter()
        .filter_map(|r| {
            let s = r.cust_no.trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        })
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    let loyalty_by_code: HashMap<String, i32> = if cust_codes.is_empty() {
        HashMap::new()
    } else {
        let recs = sqlx::query_as::<_, (String, i32)>(
            r#"SELECT customer_code, COALESCE(loyalty_points, 0)::int FROM customers WHERE customer_code = ANY($1)"#,
        )
        .bind(&cust_codes[..])
        .fetch_all(&mut *tx)
        .await?;
        recs.into_iter().collect()
    };

    for row in &rows {
        let cust_no = row.cust_no.trim();
        if cust_no.is_empty() {
            summary.skipped += 1;
            continue;
        }
        let earnd = row.pts_earnd.unwrap_or(0);
        let redeemd = row.pts_redeemd.unwrap_or(0);
        let delta = earnd - redeemd;
        if delta == 0 {
            summary.skipped += 1;
            continue;
        }

        let customer_id: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM customers WHERE customer_code = $1")
                .bind(cust_no)
                .fetch_optional(&mut *tx)
                .await?;

        let Some(cid) = customer_id else {
            summary.skipped += 1;
            continue;
        };

        let date_part = row
            .bus_dat
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("_");
        let ref_part = row.ref_no.as_deref().map(str::trim).unwrap_or("");
        let cp_ref = format!("{cust_no}|{date_part}|{ref_part}");

        let dup: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM loyalty_point_ledger
                WHERE reason = 'cp_loy_pts_hist' AND metadata->>'cp_ref' = $1
            )
            "#,
        )
        .bind(&cp_ref)
        .fetch_one(&mut *tx)
        .await?;

        if dup {
            summary.skipped += 1;
            continue;
        }

        let prev_bal: Option<i32> = sqlx::query_scalar(
            r#"
            SELECT balance_after FROM loyalty_point_ledger
            WHERE customer_id = $1
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            "#,
        )
        .bind(cid)
        .fetch_optional(&mut *tx)
        .await?;

        let prev = match prev_bal {
            Some(p) => p,
            None => {
                let cp_bal = loyalty_by_code.get(cust_no).copied().unwrap_or(0);
                let sum_d = sum_by_cust.get(cust_no).copied().unwrap_or(0);
                match cp_bal.checked_sub(sum_d) {
                    Some(opening) => opening,
                    None => {
                        tracing::warn!(
                            cust_no = %cust_no,
                            cp_balance = cp_bal,
                            sum_payload_deltas = sum_d,
                            "counterpoint loyalty import: opening balance underflow; using 0"
                        );
                        0
                    }
                }
            }
        };

        let bal_after = prev + delta;
        let meta = serde_json::json!({
            "cp_ref": cp_ref,
            "source": "ps_loy_pts_hist",
            "pts_earnd": earnd,
            "pts_redeemd": redeemd,
        });

        sqlx::query(
            r#"
            INSERT INTO loyalty_point_ledger (
                customer_id, delta_points, balance_after, reason, metadata, created_at
            )
            VALUES ($1, $2, $3, 'cp_loy_pts_hist', $4, COALESCE($5::timestamptz, CURRENT_TIMESTAMP))
            "#,
        )
        .bind(cid)
        .bind(delta)
        .bind(bal_after)
        .bind(meta)
        .bind(parse_cp_loyalty_bus_dat(row.bus_dat.as_deref()))
        .execute(&mut *tx)
        .await?;
        summary.inserted += 1;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "loyalty_hist" {
            let _ = record_sync_run(pool, "loyalty_hist", s.cursor.as_deref(), true, None).await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Vendor item cross-ref (PO_VEND_ITEM → vendor_supplier_item)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CounterpointVendorItemRow {
    pub vend_no: String,
    pub item_no: String,
    #[serde(default)]
    pub vend_item_no: Option<String>,
    #[serde(default)]
    pub vend_cost: Option<Decimal>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointVendorItemsPayload {
    pub rows: Vec<CounterpointVendorItemRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct VendorItemSyncSummary {
    pub upserted: i32,
    pub skipped: i32,
}

pub async fn execute_counterpoint_vendor_item_batch(
    pool: &PgPool,
    payload: CounterpointVendorItemsPayload,
) -> Result<VendorItemSyncSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let mut summary = VendorItemSyncSummary {
        upserted: 0,
        skipped: 0,
    };

    for row in &payload.rows {
        let vend_no = row.vend_no.trim();
        let item_no = row.item_no.trim();
        if vend_no.is_empty() || item_no.is_empty() {
            summary.skipped += 1;
            continue;
        }
        let vendor_id: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM vendors WHERE vendor_code = $1")
                .bind(vend_no)
                .fetch_optional(&mut *tx)
                .await?;

        let Some(vid) = vendor_id else {
            summary.skipped += 1;
            continue;
        };

        let v_item = row
            .vend_item_no
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("");
        let variant_id = resolve_variant_for_cp_item_no(&mut tx, item_no).await?;

        sqlx::query(
            r#"
            INSERT INTO vendor_supplier_item (
                vendor_id, cp_item_no, vendor_item_no, vend_cost, variant_id
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT ON CONSTRAINT vendor_supplier_item_vendor_item_uidx
            DO UPDATE SET
                vend_cost = COALESCE(EXCLUDED.vend_cost, vendor_supplier_item.vend_cost),
                variant_id = COALESCE(EXCLUDED.variant_id, vendor_supplier_item.variant_id),
                updated_at = now()
            "#,
        )
        .bind(vid)
        .bind(item_no)
        .bind(v_item)
        .bind(row.vend_cost)
        .bind(variant_id)
        .execute(&mut *tx)
        .await?;
        summary.upserted += 1;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "vendor_items" {
            let _ = record_sync_run(pool, "vendor_items", s.cursor.as_deref(), true, None).await;
        }
    }

    Ok(summary)
}

/// Resolve a Counterpoint user ID or sales rep code to a ROS `staff.id`.
pub async fn resolve_staff_id(pool: &PgPool, cp_code: Option<&str>) -> Option<Uuid> {
    let code = cp_code?.trim();
    if code.is_empty() {
        return None;
    }
    sqlx::query_scalar("SELECT ros_staff_id FROM counterpoint_staff_map WHERE cp_code = $1 LIMIT 1")
        .bind(code)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}
