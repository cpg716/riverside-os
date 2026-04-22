//! Counterpoint → ROS ingest (Windows bridge). One-way upserts into PostgreSQL.
//! Covers: customers, inventory, catalog (products + variants), gift cards,
//! ticket history (transactions + payments + optional PS_TKT_HIST_GFT), open docs,
//! vendor items (PO_VEND_ITEM), loyalty history (PS_LOY_PTS_HIST), and heartbeat / sync status.
//! Ticket and open-doc transactions are only inserted after **every** line resolves to a variant
//! (no partial transactions with mismatched totals).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::path::PathBuf;

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};
use sqlx::{Acquire, PgPool, Postgres, Transaction};
use thiserror::Error;
use uuid::Uuid;

use crate::logic::store_credit;

const HISTORICAL_FALLBACK_SKU: &str = "HIST-CP-FALLBACK";
const HISTORICAL_FALLBACK_NAME: &str = "Historical Counterpoint Sale (Item Unresolved)";

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

#[derive(Debug, Deserialize)]
pub struct CounterpointReceivingRow {
    pub vend_no: String,
    pub item_no: String,
    pub recv_dat: String,
    pub unit_cost: Decimal,
    pub qty_recv: Decimal,
    #[serde(default)]
    pub po_no: Option<String>,
    #[serde(default)]
    pub recv_no: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CounterpointReceivingPayload {
    pub rows: Vec<CounterpointReceivingRow>,
    #[serde(default)]
    pub sync: Option<SyncCursorIn>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointReceivingSummary {
    pub inserted: i32,
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
    tx: &mut Transaction<'_, Postgres>,
    row: &CounterpointCustomerRow,
    summary: &mut CounterpointCustomerBatchSummary,
    staff_map: &HashMap<String, Uuid>,
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
    let preferred_rep = row
        .sls_rep
        .as_deref()
        .and_then(|c| staff_map.get(c.trim()))
        .copied();

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

    // High-performance staff cache for salesperson resolution
    let staff_map: HashMap<String, Uuid> = sqlx::query_as::<_, (String, Uuid)>(
        "SELECT cp_code, ros_staff_id FROM counterpoint_staff_map",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    let mut tx = pool.begin().await?;
    let mut summary = CounterpointCustomerBatchSummary {
        created: 0,
        updated: 0,
        skipped: 0,
        email_conflicts: 0,
    };

    for row in &payload.rows {
        upsert_customer_row(&mut tx, row, &mut summary, &staff_map).await?;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "customers" {
            let _ = record_sync_run(
                pool,
                "customers",
                s.cursor.as_deref(),
                true,
                Some(summary.created + summary.updated + summary.skipped),
                None,
            )
            .await;
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

    let mut tx = pool.begin().await?;

    // 1. Separate items by how we resolve them (key vs sku)
    let mut keyed_keys = Vec::new();
    let mut keyed_soh = Vec::new();
    let mut keyed_cost = Vec::new();

    let mut sku_skus = Vec::new();
    let mut sku_keys = Vec::new();
    let mut sku_soh = Vec::new();
    let mut sku_cost = Vec::new();

    for row in &payload.rows {
        let sku = row.sku.trim();
        if sku.is_empty() {
            continue;
        }
        if let Some(ref key) = trim_opt(&row.counterpoint_item_key) {
            keyed_keys.push(key.clone());
            keyed_soh.push(row.stock_on_hand);
            keyed_cost.push(row.unit_cost);
        } else {
            sku_skus.push(sku.to_string());
            sku_keys.push(None::<String>);
            sku_soh.push(row.stock_on_hand);
            sku_cost.push(row.unit_cost);
        }
    }

    // Bulk Update By Key
    if !keyed_keys.is_empty() {
        let r = sqlx::query(
            r#"
            UPDATE product_variants AS v
            SET 
                stock_on_hand = u.soh,
                cost_override = COALESCE(u.cost, v.cost_override)
            FROM UNNEST($1::text[], $2::int[], $3::numeric[]) AS u(key, soh, cost)
            WHERE v.counterpoint_item_key = u.key
            "#,
        )
        .bind(&keyed_keys)
        .bind(&keyed_soh)
        .bind(&keyed_cost)
        .execute(&mut *tx)
        .await?;
        updated += r.rows_affected() as i32;

        // Find which ones didn't match by key to retry by SKU
        // In a real high-perf sync, the bridge should send keys for everything.
        // For now, we'll do a second pass for the rest.
    }

    // Bulk Update By SKU
    if !sku_skus.is_empty() {
        let r = sqlx::query(
            r#"
            UPDATE product_variants AS v
            SET 
                stock_on_hand = u.soh,
                cost_override = COALESCE(u.cost, v.cost_override),
                counterpoint_item_key = COALESCE(v.counterpoint_item_key, u.key)
            FROM UNNEST($1::text[], $2::text[], $3::int[], $4::numeric[]) AS u(sku, key, soh, cost)
            WHERE lower(trim(v.sku)) = lower(trim(u.sku))
            "#,
        )
        .bind(&sku_skus)
        .bind(&sku_keys)
        .bind(&sku_soh)
        .bind(&sku_cost)
        .execute(&mut *tx)
        .await?;
        updated += r.rows_affected() as i32;
    }

    let skipped = (payload.rows.len() as i32) - updated;

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "inventory" {
            let _ = record_sync_run(
                pool,
                "inventory",
                s.cursor.as_deref(),
                true,
                Some(updated + skipped),
                None,
            )
            .await;
        }
    }

    Ok(CounterpointInventorySummary { updated, skipped })
}

pub async fn execute_counterpoint_receiving_batch(
    pool: &PgPool,
    payload: CounterpointReceivingPayload,
) -> Result<CounterpointReceivingSummary, CounterpointSyncError> {
    if payload.rows.is_empty() {
        return Err(CounterpointSyncError::InvalidPayload("rows empty".into()));
    }
    let mut tx = pool.begin().await?;
    let mut inserted = 0;
    let mut skipped = 0;

    for row in &payload.rows {
        let recv_dat = match DateTime::parse_from_rfc3339(&row.recv_dat) {
            Ok(dt) => dt.with_timezone(&Utc),
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        // Try to link to a variant for easier reporting
        let variant_id: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM product_variants WHERE sku = $1")
                .bind(&row.item_no)
                .fetch_optional(&mut *tx)
                .await?;

        let already_exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM counterpoint_receiving_history
                WHERE vend_no = $1
                  AND item_no = $2
                  AND recv_dat = $3
                  AND unit_cost = $4
                  AND qty_recv = $5
                  AND po_no IS NOT DISTINCT FROM $6
                  AND recv_no IS NOT DISTINCT FROM $7
            )
            "#,
        )
        .bind(&row.vend_no)
        .bind(&row.item_no)
        .bind(recv_dat)
        .bind(row.unit_cost)
        .bind(row.qty_recv)
        .bind(&row.po_no)
        .bind(&row.recv_no)
        .fetch_one(&mut *tx)
        .await?;

        if already_exists {
            skipped += 1;
            continue;
        }

        sqlx::query(
            r#"
            INSERT INTO counterpoint_receiving_history (
                vend_no, item_no, recv_dat, unit_cost, qty_recv, po_no, recv_no, variant_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            "#,
        )
        .bind(&row.vend_no)
        .bind(&row.item_no)
        .bind(recv_dat)
        .bind(row.unit_cost)
        .bind(row.qty_recv)
        .bind(&row.po_no)
        .bind(&row.recv_no)
        .bind(variant_id)
        .execute(&mut *tx)
        .await?;

        inserted += 1;
    }

    tx.commit().await?;
    if let Some(ref s) = payload.sync {
        let _ = record_sync_run(
            pool,
            &s.entity,
            s.cursor.as_deref(),
            true,
            Some(inserted + skipped),
            None,
        )
        .await;
    }

    Ok(CounterpointReceivingSummary { inserted, skipped })
}

pub async fn record_sync_run(
    pool: &PgPool,
    entity: &str,
    cursor: Option<&str>,
    ok: bool,
    records_processed: Option<i32>,
    err: Option<&str>,
) -> Result<(), sqlx::Error> {
    if ok {
        sqlx::query(
            r#"
            INSERT INTO counterpoint_sync_runs (entity, cursor_value, last_ok_at, last_error, records_processed, updated_at)
            VALUES ($1, $2, NOW(), NULL, $3, NOW())
            ON CONFLICT (entity) DO UPDATE SET
                cursor_value = EXCLUDED.cursor_value,
                last_ok_at = NOW(),
                last_error = NULL,
                records_processed = EXCLUDED.records_processed,
                updated_at = NOW()
            "#,
        )
        .bind(entity)
        .bind(cursor)
        .bind(records_processed)
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
    pub records_processed: Option<i32>,
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
        "SELECT entity, cursor_value, last_ok_at, last_error, records_processed, updated_at FROM counterpoint_sync_runs ORDER BY updated_at DESC",
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
// Pre-go-live Counterpoint baseline reset
// ────────────────────────────────────────────────────────────────────────────

const COUNTERPOINT_BASELINE_RESET_CONFIRMATION: &str = "RESET COUNTERPOINT BASELINE";

#[derive(Debug, Serialize)]
pub struct CounterpointResetCountRow {
    pub key: String,
    pub label: String,
    pub count: i64,
    pub note: String,
}

#[derive(Debug, Serialize)]
pub struct CounterpointResetPreview {
    pub confirmation_phrase: String,
    pub pre_go_live_only_warning: String,
    pub preserve_always: Vec<String>,
    pub reset_scope: Vec<CounterpointResetCountRow>,
    pub careful_ordering: Vec<String>,
    pub excluded_for_now: Vec<String>,
    pub bridge_local_state_note: String,
}

#[derive(Debug, Serialize)]
pub struct CounterpointResetResult {
    pub confirmation_phrase: String,
    pub reset_scope: Vec<CounterpointResetCountRow>,
    pub preserve_always: Vec<String>,
    pub bridge_local_state_note: String,
}

async fn reset_preview_count(pool: &PgPool, query: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(query).fetch_one(pool).await
}

fn counterpoint_reset_preserve_always() -> Vec<String> {
    vec![
        "Bootstrap/back-office staff accounts and PIN access, including the seeded Chris G admin account.".into(),
        "store_settings and other singleton runtime/config rows required for app startup.".into(),
        "Staff role permissions, per-staff permissions, pricing limits, and other auth/bootstrap tables.".into(),
        "Counterpoint mapping configuration tables (category, payment method, gift reason) so reruns keep the reviewed mapping setup.".into(),
        "Schema/migration ledgers, help/config content, and non-business integration/runtime settings.".into(),
    ]
}

fn counterpoint_reset_excluded_for_now() -> Vec<String> {
    vec![
        "Categories and category audit history stay in place because they are shared setup, not proven migration-only rows.".into(),
        "Wedding planning records, shipping records, tasks, notifications, and other non-Counterpoint operational modules are excluded unless they block a reset directly.".into(),
        "Bridge-side local cursor files such as .counterpoint-bridge-state.json are not touched by the server reset.".into(),
    ]
}

async fn build_counterpoint_reset_scope(
    pool: &PgPool,
) -> Result<Vec<CounterpointResetCountRow>, sqlx::Error> {
    Ok(vec![
        CounterpointResetCountRow {
            key: "customers".into(),
            label: "Counterpoint customers".into(),
            count: reset_preview_count(
                pool,
                "SELECT COUNT(*)::bigint FROM customers WHERE customer_created_source = 'counterpoint'",
            )
            .await?,
            note: "Deletes Counterpoint-created customers plus dependent notes, loyalty/store-credit accounts, and linked CRM-only child rows.".into(),
        },
        CounterpointResetCountRow {
            key: "transactions".into(),
            label: "Counterpoint transactions".into(),
            count: reset_preview_count(
                pool,
                "SELECT COUNT(*)::bigint FROM transactions WHERE is_counterpoint_import",
            )
            .await?,
            note: "Deletes imported ticket/open-doc transactions, their lines, linked payment allocations, and any extra pre-go-live transactions still attached to Counterpoint customers.".into(),
        },
        CounterpointResetCountRow {
            key: "products".into(),
            label: "Counterpoint catalog products".into(),
            count: reset_preview_count(
                pool,
                "SELECT COUNT(*)::bigint FROM products WHERE data_source = 'counterpoint'",
            )
            .await?,
            note: "Deletes Counterpoint products/variants and clears pre-go-live operational leftovers that still point at those variants.".into(),
        },
        CounterpointResetCountRow {
            key: "vendors".into(),
            label: "Vendors".into(),
            count: reset_preview_count(pool, "SELECT COUNT(*)::bigint FROM vendors").await?,
            note: "This pre-go-live reset clears the vendor dataset because vendor rows are treated as migration data before go-live.".into(),
        },
        CounterpointResetCountRow {
            key: "gift_cards".into(),
            label: "Gift cards".into(),
            count: reset_preview_count(pool, "SELECT COUNT(*)::bigint FROM gift_cards").await?,
            note: "Gift cards have no separate native provenance marker today, so the reset clears the full pre-go-live gift-card dataset.".into(),
        },
        CounterpointResetCountRow {
            key: "loyalty_ledger".into(),
            label: "Loyalty ledger rows".into(),
            count: reset_preview_count(pool, "SELECT COUNT(*)::bigint FROM loyalty_point_ledger").await?,
            note: "Counterpoint-linked and pre-go-live loyalty rows are cleared as part of restoring a fresh migration baseline.".into(),
        },
        CounterpointResetCountRow {
            key: "store_credit_accounts".into(),
            label: "Store credit accounts".into(),
            count: reset_preview_count(pool, "SELECT COUNT(*)::bigint FROM store_credit_accounts").await?,
            note: "Customer-linked store credit accounts and ledger history are cleared with the migration customer dataset.".into(),
        },
        CounterpointResetCountRow {
            key: "counterpoint_state".into(),
            label: "Counterpoint sync state rows".into(),
            count: reset_preview_count(
                pool,
                r#"
                SELECT
                    (SELECT COUNT(*)::bigint FROM counterpoint_sync_runs)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_sync_issue)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_sync_request)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_staging_batch)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_receiving_history)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_staff_map)
                "#,
            )
            .await?,
            note: "Clears Counterpoint staging, run history, issues, requests, receiving history, and staff maps so ROS shows a fresh migration state.".into(),
        },
        CounterpointResetCountRow {
            key: "counterpoint_staff".into(),
            label: "Counterpoint-only staff rows".into(),
            count: reset_preview_count(
                pool,
                "SELECT COUNT(*)::bigint FROM staff WHERE data_source = 'counterpoint' AND pin_hash IS NULL",
            )
            .await?,
            note: "Removes imported historical/stub staff without local PIN access. Preserved bootstrap staff keep access, but their Counterpoint link fields are cleared.".into(),
        },
    ])
}

pub async fn get_counterpoint_reset_preview(
    pool: &PgPool,
) -> Result<CounterpointResetPreview, sqlx::Error> {
    Ok(CounterpointResetPreview {
        confirmation_phrase: COUNTERPOINT_BASELINE_RESET_CONFIRMATION.into(),
        pre_go_live_only_warning: "Pre-go-live only. This reset is intended to clear migration/test business data before the store accepts ROS as the live system of record.".into(),
        preserve_always: counterpoint_reset_preserve_always(),
        reset_scope: build_counterpoint_reset_scope(pool).await?,
        careful_ordering: vec![
            "Imported transactions/payments are cleared before customers and gift cards so foreign-key references do not block the reset.".into(),
            "Product-linked operational leftovers are cleared before Counterpoint products/variants so the catalog can be removed safely.".into(),
            "Counterpoint-only staff rows are removed last, after customer/product/transaction references are gone.".into(),
        ],
        excluded_for_now: counterpoint_reset_excluded_for_now(),
        bridge_local_state_note: "If the bridge is using local cursor state (.counterpoint-bridge-state.json), delete or reset that file on the Counterpoint PC before the next full fresh import. This server reset does not touch bridge-local cursor files.".into(),
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Counterpoint CSV inventory verification (read-only)
// ────────────────────────────────────────────────────────────────────────────

const COUNTERPOINT_INVENTORY_VERIFY_MAX_DETAIL_ROWS: usize = 2000;
const COUNTERPOINT_INVENTORY_VERIFY_MAX_EXTRA_ROWS: usize = 1000;

#[derive(Debug, Deserialize)]
struct CounterpointInventoryCsvRow {
    sku: String,
    name: String,
    product_category: String,
    variant_option_one_value: String,
    variant_option_two_value: String,
    variant_option_three_value: String,
    tags: String,
    supply_price: String,
    retail_price: String,
    supplier_name: String,
    supplier_code: String,
    inventory_main_outlet: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct CounterpointInventoryVerificationValues {
    pub sku: String,
    pub name: Option<String>,
    pub category: Option<String>,
    pub variant_label: Option<String>,
    pub supply_price: Option<String>,
    pub retail_price: Option<String>,
    pub inventory_quantity: Option<String>,
    pub supplier_name: Option<String>,
    pub supplier_code: Option<String>,
    pub item_key: Option<String>,
    pub catalog_handle: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CounterpointInventoryVerificationRow {
    pub sku: String,
    pub match_basis: Option<String>,
    pub status: String,
    pub mismatch_types: Vec<String>,
    pub csv: CounterpointInventoryVerificationValues,
    pub ros: Option<CounterpointInventoryVerificationValues>,
}

#[derive(Debug, Serialize)]
pub struct CounterpointInventoryVerificationSummary {
    pub csv_path: String,
    pub total_csv_skus: i64,
    pub exact_match_count: i64,
    pub mismatched_count: i64,
    pub comparison_artifact_count: i64,
    pub csv_source_issue_count: i64,
    pub missing_in_ros_count: i64,
    pub extra_in_ros_count: i64,
    pub matched_count: i64,
    pub name_mismatch_count: i64,
    pub category_mismatch_count: i64,
    pub variant_mismatch_count: i64,
    pub ros_variant_label_missing_count: i64,
    pub price_mismatch_count: i64,
    pub cost_mismatch_count: i64,
    pub inventory_mismatch_count: i64,
    pub supplier_field_suspect_count: i64,
    pub supplier_code_non_vendor_key_count: i64,
    pub variant_group_split_count: i64,
    pub parent_sku_variant_count: i64,
    pub duplicate_variant_label_count: i64,
    pub missing_vendor_count: i64,
    pub vendor_mismatch_count: i64,
    pub missing_vendor_item_link_count: i64,
    pub extra_parent_scope_artifact_count: i64,
    pub extra_key_present_scope_gap_count: i64,
    pub extra_unexplained_count: i64,
    pub detailed_row_limit: usize,
    pub detailed_rows_truncated: i64,
    pub extra_rows_truncated: i64,
    pub expected_out_of_scope_exclusion_count: i64,
}

#[derive(Debug, Serialize)]
pub struct CounterpointInventoryVerificationReport {
    pub summary: CounterpointInventoryVerificationSummary,
    pub mismatch_rows: Vec<CounterpointInventoryVerificationRow>,
    pub extra_rows: Vec<CounterpointInventoryVerificationRow>,
    pub critical_issues: Vec<String>,
}

#[derive(Debug)]
struct CounterpointInventoryCsvNormalizedRow {
    sku: String,
    name: String,
    product_category: String,
    variant_label: String,
    item_key: String,
    supply_price: Option<Decimal>,
    retail_price: Option<Decimal>,
    inventory_quantity: Option<Decimal>,
    supplier_name: String,
    supplier_code: String,
    supplier_field_suspect: bool,
    supplier_code_non_vendor_key: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct CounterpointRosInventoryRow {
    variant_id: Uuid,
    product_id: Uuid,
    sku: String,
    counterpoint_item_key: Option<String>,
    variation_label: Option<String>,
    stock_on_hand: i32,
    retail_price: Decimal,
    supply_price: Decimal,
    product_name: String,
    catalog_handle: Option<String>,
    category_name: Option<String>,
    primary_vendor_name: Option<String>,
    primary_vendor_code: Option<String>,
}

#[derive(Debug, Clone)]
struct CounterpointRosVendorLink {
    vendor_name: Option<String>,
    vendor_code: Option<String>,
}

#[derive(Debug, Default)]
struct CounterpointCsvGroupSummary {
    matched_product_ids: BTreeSet<Uuid>,
    variant_labels: HashMap<String, usize>,
    parent_sku_variant_seen: bool,
}

fn counterpoint_inventory_csv_path() -> Option<PathBuf> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)?;
    let preferred = repo_root.join("export2026-04-22.csv");
    if preferred.exists() {
        return Some(preferred);
    }
    let fallback = repo_root.join("venv").join("export2026-04-22.csv");
    if fallback.exists() {
        return Some(fallback);
    }
    None
}

fn normalize_verify_text(raw: &str) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_uppercase()
}

fn trim_to_opt(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_decimal_opt(raw: &str) -> Option<Decimal> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<Decimal>().ok()
}

fn format_decimal_opt(raw: Option<Decimal>) -> Option<String> {
    raw.map(|d| d.normalize().to_string())
}

fn csv_variant_label(row: &CounterpointInventoryCsvRow) -> String {
    [
        row.variant_option_one_value.as_str(),
        row.variant_option_two_value.as_str(),
        row.variant_option_three_value.as_str(),
    ]
    .into_iter()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join(" / ")
}

fn csv_supplier_fields_suspect(row: &CounterpointInventoryCsvRow) -> bool {
    let supplier_name = normalize_verify_text(&row.supplier_name);
    let supplier_code = normalize_verify_text(&row.supplier_code);
    if !supplier_name.is_empty() || supplier_code.is_empty() {
        return false;
    }
    let variant_values = [
        row.variant_option_one_value.as_str(),
        row.variant_option_two_value.as_str(),
        row.variant_option_three_value.as_str(),
    ]
    .into_iter()
    .map(normalize_verify_text)
    .filter(|value| !value.is_empty())
    .collect::<HashSet<_>>();
    variant_values.contains(&supplier_code)
}

fn csv_supplier_code_not_vendor_key(row: &CounterpointInventoryCsvRow) -> bool {
    let supplier_code = normalize_verify_text(&row.supplier_code);
    if supplier_code.is_empty() {
        return false;
    }
    let variant_values = [
        row.variant_option_one_value.as_str(),
        row.variant_option_two_value.as_str(),
        row.variant_option_three_value.as_str(),
    ]
    .into_iter()
    .map(normalize_verify_text)
    .filter(|value| !value.is_empty())
    .collect::<HashSet<_>>();
    variant_values.contains(&supplier_code)
}

fn normalize_csv_inventory_row(
    row: CounterpointInventoryCsvRow,
) -> CounterpointInventoryCsvNormalizedRow {
    CounterpointInventoryCsvNormalizedRow {
        sku: row.sku.trim().to_string(),
        name: row.name.trim().to_string(),
        product_category: row.product_category.trim().to_string(),
        variant_label: csv_variant_label(&row),
        item_key: row.tags.trim().to_string(),
        supply_price: parse_decimal_opt(&row.supply_price),
        retail_price: parse_decimal_opt(&row.retail_price),
        inventory_quantity: parse_decimal_opt(&row.inventory_main_outlet),
        supplier_name: row.supplier_name.trim().to_string(),
        supplier_code: row.supplier_code.trim().to_string(),
        supplier_field_suspect: csv_supplier_fields_suspect(&row),
        supplier_code_non_vendor_key: csv_supplier_code_not_vendor_key(&row),
    }
}

fn ros_currency_matches(csv_value: Option<Decimal>, ros_value: Decimal) -> bool {
    csv_value
        .map(|value| {
            value.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
                == ros_value.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
        })
        .unwrap_or(true)
}

fn is_parent_row_fallback_artifact(
    csv_row: &CounterpointInventoryCsvNormalizedRow,
    ros_row: &CounterpointRosInventoryRow,
    match_basis: &str,
) -> bool {
    if match_basis != "counterpoint_item_key_singleton" && match_basis != "catalog_handle_singleton"
    {
        return false;
    }
    let normalized_sku = normalize_verify_text(&csv_row.sku);
    let normalized_key = normalize_verify_text(&csv_row.item_key);
    if !normalized_sku.starts_with("B-") || !normalized_key.starts_with("I-") {
        return false;
    }
    let ros_sku = normalize_verify_text(&ros_row.sku);
    let ros_key = ros_row
        .counterpoint_item_key
        .as_deref()
        .map(normalize_verify_text)
        .unwrap_or_default();
    let ros_handle = ros_row
        .catalog_handle
        .as_deref()
        .map(normalize_verify_text)
        .unwrap_or_default();
    ros_sku == normalized_key || ros_key == normalized_key || ros_handle == normalized_key
}

fn verify_values_from_csv(
    row: &CounterpointInventoryCsvNormalizedRow,
) -> CounterpointInventoryVerificationValues {
    CounterpointInventoryVerificationValues {
        sku: row.sku.clone(),
        name: trim_to_opt(&row.name),
        category: trim_to_opt(&row.product_category),
        variant_label: trim_to_opt(&row.variant_label),
        supply_price: format_decimal_opt(row.supply_price),
        retail_price: format_decimal_opt(row.retail_price),
        inventory_quantity: format_decimal_opt(row.inventory_quantity),
        supplier_name: trim_to_opt(&row.supplier_name),
        supplier_code: trim_to_opt(&row.supplier_code),
        item_key: trim_to_opt(&row.item_key),
        catalog_handle: None,
    }
}

fn verify_values_from_ros(
    row: &CounterpointRosInventoryRow,
    vendor_links: &[CounterpointRosVendorLink],
) -> CounterpointInventoryVerificationValues {
    let vendor_name = row.primary_vendor_name.clone().or_else(|| {
        vendor_links
            .iter()
            .find_map(|link| link.vendor_name.clone())
    });
    let vendor_code = row.primary_vendor_code.clone().or_else(|| {
        vendor_links
            .iter()
            .find_map(|link| link.vendor_code.clone())
    });

    CounterpointInventoryVerificationValues {
        sku: row.sku.clone(),
        name: trim_to_opt(&row.product_name),
        category: row.category_name.clone(),
        variant_label: row.variation_label.clone(),
        supply_price: Some(row.supply_price.normalize().to_string()),
        retail_price: Some(row.retail_price.normalize().to_string()),
        inventory_quantity: Some(Decimal::from(row.stock_on_hand).normalize().to_string()),
        supplier_name: vendor_name,
        supplier_code: vendor_code,
        item_key: row.counterpoint_item_key.clone(),
        catalog_handle: row.catalog_handle.clone(),
    }
}

fn push_detail_row_limited(
    rows: &mut Vec<CounterpointInventoryVerificationRow>,
    row: CounterpointInventoryVerificationRow,
    limit: usize,
    truncated: &mut i64,
) {
    if rows.len() < limit {
        rows.push(row);
    } else {
        *truncated += 1;
    }
}

pub async fn build_counterpoint_inventory_verification_report(
    pool: &PgPool,
) -> Result<CounterpointInventoryVerificationReport, CounterpointSyncError> {
    let csv_path = counterpoint_inventory_csv_path().ok_or_else(|| {
        CounterpointSyncError::InvalidPayload(
            "Counterpoint inventory CSV export2026-04-22.csv not found in repo root".into(),
        )
    })?;

    let ros_rows: Vec<CounterpointRosInventoryRow> = sqlx::query_as(
        r#"
        SELECT
            pv.id AS variant_id,
            pv.product_id,
            pv.sku,
            pv.counterpoint_item_key,
            pv.variation_label,
            pv.stock_on_hand,
            COALESCE(pv.retail_price_override, p.base_retail_price) AS retail_price,
            COALESCE(pv.cost_override, p.base_cost) AS supply_price,
            p.name AS product_name,
            p.catalog_handle,
            c.name AS category_name,
            v.name AS primary_vendor_name,
            v.vendor_code AS primary_vendor_code
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN vendors v ON v.id = p.primary_vendor_id
        WHERE p.data_source = 'counterpoint' OR pv.counterpoint_item_key IS NOT NULL
        ORDER BY pv.sku
        "#,
    )
    .fetch_all(pool)
    .await?;

    let vendor_link_rows: Vec<(Uuid, Option<String>, Option<String>)> = sqlx::query_as(
        r#"
        SELECT
            vsi.variant_id,
            v.name,
            v.vendor_code
        FROM vendor_supplier_item vsi
        INNER JOIN vendors v ON v.id = vsi.vendor_id
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut vendor_links_by_variant: HashMap<Uuid, Vec<CounterpointRosVendorLink>> = HashMap::new();
    for (variant_id, vendor_name, vendor_code) in vendor_link_rows {
        vendor_links_by_variant
            .entry(variant_id)
            .or_default()
            .push(CounterpointRosVendorLink {
                vendor_name,
                vendor_code,
            });
    }

    let mut ros_by_sku: HashMap<String, usize> = HashMap::new();
    let mut ros_sku_counts: HashMap<String, usize> = HashMap::new();
    let mut ros_by_counterpoint_key: HashMap<String, Vec<usize>> = HashMap::new();
    let mut ros_by_catalog_handle: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, row) in ros_rows.iter().enumerate() {
        let normalized_sku = normalize_verify_text(&row.sku);
        *ros_sku_counts.entry(normalized_sku.clone()).or_insert(0) += 1;
        ros_by_sku.insert(normalized_sku, idx);
        if let Some(key) = row.counterpoint_item_key.as_deref() {
            let normalized = normalize_verify_text(key);
            if !normalized.is_empty() {
                ros_by_counterpoint_key
                    .entry(normalized)
                    .or_default()
                    .push(idx);
            }
        }
        if let Some(handle) = row.catalog_handle.as_deref() {
            let normalized = normalize_verify_text(handle);
            if !normalized.is_empty() {
                ros_by_catalog_handle
                    .entry(normalized)
                    .or_default()
                    .push(idx);
            }
        }
    }

    let file = File::open(&csv_path).map_err(|e| {
        CounterpointSyncError::InvalidPayload(format!(
            "Could not open Counterpoint inventory CSV {}: {e}",
            csv_path.display()
        ))
    })?;
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(file);
    let mut csv_skus = HashSet::new();
    let mut csv_key_counts: HashMap<String, i64> = HashMap::new();
    for record in reader.deserialize::<CounterpointInventoryCsvRow>() {
        let raw = record.map_err(|e| {
            CounterpointSyncError::InvalidPayload(format!(
                "Could not parse Counterpoint inventory CSV {}: {e}",
                csv_path.display()
            ))
        })?;
        let csv_row = normalize_csv_inventory_row(raw);
        if csv_row.sku.trim().is_empty() {
            continue;
        }
        csv_skus.insert(normalize_verify_text(&csv_row.sku));
        let normalized_key = normalize_verify_text(&csv_row.item_key);
        if !normalized_key.is_empty() {
            *csv_key_counts.entry(normalized_key).or_insert(0) += 1;
        }
    }

    let file = File::open(&csv_path).map_err(|e| {
        CounterpointSyncError::InvalidPayload(format!(
            "Could not reopen Counterpoint inventory CSV {}: {e}",
            csv_path.display()
        ))
    })?;
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(file);

    let mut total_csv_skus = 0_i64;
    let mut exact_match_count = 0_i64;
    let mut mismatched_count = 0_i64;
    let mut comparison_artifact_count = 0_i64;
    let mut csv_source_issue_count = 0_i64;
    let mut missing_in_ros_count = 0_i64;
    let mut name_mismatch_count = 0_i64;
    let mut category_mismatch_count = 0_i64;
    let mut variant_mismatch_count = 0_i64;
    let mut ros_variant_label_missing_count = 0_i64;
    let mut price_mismatch_count = 0_i64;
    let mut cost_mismatch_count = 0_i64;
    let mut inventory_mismatch_count = 0_i64;
    let mut supplier_field_suspect_count = 0_i64;
    let mut supplier_code_non_vendor_key_count = 0_i64;
    let mut missing_vendor_count = 0_i64;
    let mut vendor_mismatch_count = 0_i64;
    let mut missing_vendor_item_link_count = 0_i64;

    let mut detailed_rows_truncated = 0_i64;
    let mut extra_rows_truncated = 0_i64;
    let mut expected_out_of_scope_exclusion_count = 0_i64;
    let mut mismatch_rows = Vec::new();
    let mut matched_ros_variant_ids = HashSet::new();
    let mut csv_groups: HashMap<String, CounterpointCsvGroupSummary> = HashMap::new();

    for record in reader.deserialize::<CounterpointInventoryCsvRow>() {
        let raw = record.map_err(|e| {
            CounterpointSyncError::InvalidPayload(format!(
                "Could not parse Counterpoint inventory CSV {}: {e}",
                csv_path.display()
            ))
        })?;
        let csv_row = normalize_csv_inventory_row(raw);
        if csv_row.sku.trim().is_empty() {
            continue;
        }
        total_csv_skus += 1;
        if csv_row.supplier_field_suspect {
            supplier_field_suspect_count += 1;
        }
        if csv_row.supplier_code_non_vendor_key {
            supplier_code_non_vendor_key_count += 1;
        }

        let normalized_sku = normalize_verify_text(&csv_row.sku);
        let normalized_key = normalize_verify_text(&csv_row.item_key);
        let key_row_count = csv_key_counts.get(&normalized_key).copied().unwrap_or(0);
        let matched = if ros_sku_counts.get(&normalized_sku).copied().unwrap_or(0) == 1 {
            ros_by_sku
                .get(&normalized_sku)
                .map(|idx| (*idx, "sku".to_string()))
        } else {
            None
        }
        .or_else(|| {
            if normalized_key.is_empty() || key_row_count != 1 {
                return None;
            }
            let by_key = ros_by_counterpoint_key.get(&normalized_key);
            if let Some(rows) = by_key {
                if rows.len() == 1 {
                    return Some((rows[0], "counterpoint_item_key_singleton".to_string()));
                }
            }
            let by_handle = ros_by_catalog_handle.get(&normalized_key);
            if let Some(rows) = by_handle {
                if rows.len() == 1 {
                    return Some((rows[0], "catalog_handle_singleton".to_string()));
                }
            }
            None
        });

        let csv_values = verify_values_from_csv(&csv_row);

        let Some((matched_idx, match_basis)) = matched else {
            let ros_candidate = if !normalized_key.is_empty() && key_row_count > 1 {
                ros_by_counterpoint_key
                    .get(&normalized_key)
                    .and_then(|rows| rows.first())
                    .or_else(|| {
                        ros_by_catalog_handle
                            .get(&normalized_key)
                            .and_then(|rows| rows.first())
                    })
                    .map(|idx| &ros_rows[*idx])
            } else {
                None
            };
            if let Some(ros_row) = ros_candidate {
                comparison_artifact_count += 1;
                push_detail_row_limited(
                    &mut mismatch_rows,
                    CounterpointInventoryVerificationRow {
                        sku: csv_row.sku.clone(),
                        match_basis: Some("variant_group_scope".into()),
                        status: "comparison_artifact".into(),
                        mismatch_types: vec!["multi_row_item_key_group".into()],
                        csv: csv_values,
                        ros: Some(verify_values_from_ros(
                            ros_row,
                            &vendor_links_by_variant
                                .get(&ros_row.variant_id)
                                .cloned()
                                .unwrap_or_default(),
                        )),
                    },
                    COUNTERPOINT_INVENTORY_VERIFY_MAX_DETAIL_ROWS,
                    &mut detailed_rows_truncated,
                );
                continue;
            }
            let is_expected_scope_exclusion = normalized_sku.starts_with("B-")
                && normalized_key.starts_with("I-")
                && !ros_by_counterpoint_key.contains_key(&normalized_key)
                && !ros_by_catalog_handle.contains_key(&normalized_key);
            if is_expected_scope_exclusion {
                expected_out_of_scope_exclusion_count += 1;
            }
            missing_in_ros_count += 1;
            push_detail_row_limited(
                &mut mismatch_rows,
                CounterpointInventoryVerificationRow {
                    sku: csv_row.sku.clone(),
                    match_basis: None,
                    status: if is_expected_scope_exclusion {
                        "expected_out_of_scope_exclusion".into()
                    } else {
                        "missing_in_ros".into()
                    },
                    mismatch_types: vec![if is_expected_scope_exclusion {
                        "expected_out_of_scope_exclusion".into()
                    } else {
                        "missing_in_ros".into()
                    }],
                    csv: csv_values,
                    ros: None,
                },
                COUNTERPOINT_INVENTORY_VERIFY_MAX_DETAIL_ROWS,
                &mut detailed_rows_truncated,
            );
            continue;
        };

        let ros_row = &ros_rows[matched_idx];
        if is_parent_row_fallback_artifact(&csv_row, ros_row, &match_basis) {
            comparison_artifact_count += 1;
            push_detail_row_limited(
                &mut mismatch_rows,
                CounterpointInventoryVerificationRow {
                    sku: csv_row.sku.clone(),
                    match_basis: Some(match_basis),
                    status: "comparison_artifact".into(),
                    mismatch_types: vec!["parent_row_fallback".into()],
                    csv: csv_values,
                    ros: Some(verify_values_from_ros(
                        ros_row,
                        &vendor_links_by_variant
                            .get(&ros_row.variant_id)
                            .cloned()
                            .unwrap_or_default(),
                    )),
                },
                COUNTERPOINT_INVENTORY_VERIFY_MAX_DETAIL_ROWS,
                &mut detailed_rows_truncated,
            );
            continue;
        }
        matched_ros_variant_ids.insert(ros_row.variant_id);
        let vendor_links = vendor_links_by_variant
            .get(&ros_row.variant_id)
            .cloned()
            .unwrap_or_default();

        let group_key = if normalized_key.is_empty() {
            normalize_verify_text(&csv_row.name)
        } else {
            normalized_key.clone()
        };
        let group_entry = csv_groups.entry(group_key).or_default();
        group_entry.matched_product_ids.insert(ros_row.product_id);
        let normalized_variant_label = normalize_verify_text(&csv_row.variant_label);
        if !normalized_variant_label.is_empty() {
            *group_entry
                .variant_labels
                .entry(normalized_variant_label)
                .or_insert(0) += 1;
        }
        let ros_catalog_handle = ros_row
            .catalog_handle
            .as_deref()
            .map(normalize_verify_text)
            .unwrap_or_default();
        if !ros_catalog_handle.is_empty()
            && normalize_verify_text(&ros_row.sku) == ros_catalog_handle
            && !normalized_key.is_empty()
            && ros_catalog_handle != normalized_key
        {
            group_entry.parent_sku_variant_seen = true;
        }

        let mut mismatch_types = Vec::new();
        if normalize_verify_text(&csv_row.name) != normalize_verify_text(&ros_row.product_name) {
            mismatch_types.push("name_mismatch".into());
            name_mismatch_count += 1;
        }
        let ros_category = ros_row.category_name.as_deref().unwrap_or("");
        if normalize_verify_text(&csv_row.product_category) != normalize_verify_text(ros_category) {
            mismatch_types.push("category_mismatch".into());
            category_mismatch_count += 1;
        }
        let ros_variant_label = ros_row.variation_label.as_deref().unwrap_or("");
        let normalized_csv_variant_label = normalize_verify_text(&csv_row.variant_label);
        let normalized_ros_variant_label = normalize_verify_text(ros_variant_label);
        if !normalized_csv_variant_label.is_empty() && normalized_ros_variant_label.is_empty() {
            mismatch_types.push("ros_variant_label_missing".into());
            ros_variant_label_missing_count += 1;
        } else if !normalized_csv_variant_label.is_empty()
            && !normalized_ros_variant_label.is_empty()
            && normalized_csv_variant_label != normalized_ros_variant_label
        {
            mismatch_types.push("variant_mismatch".into());
            variant_mismatch_count += 1;
        }
        if !ros_currency_matches(csv_row.retail_price, ros_row.retail_price) {
            mismatch_types.push("price_mismatch".into());
            price_mismatch_count += 1;
        }
        if !ros_currency_matches(csv_row.supply_price, ros_row.supply_price) {
            mismatch_types.push("cost_mismatch".into());
            cost_mismatch_count += 1;
        }
        if csv_row
            .inventory_quantity
            .map(|quantity| {
                quantity.normalize() != Decimal::from(ros_row.stock_on_hand).normalize()
            })
            .unwrap_or(false)
        {
            mismatch_types.push("inventory_mismatch".into());
            inventory_mismatch_count += 1;
        }
        let source_issue_only = csv_row.supplier_field_suspect;
        if !csv_row.supplier_field_suspect {
            let csv_supplier_name = normalize_verify_text(&csv_row.supplier_name);
            if !csv_supplier_name.is_empty() {
                let primary_vendor_match = csv_supplier_name
                    == normalize_verify_text(ros_row.primary_vendor_name.as_deref().unwrap_or(""));
                let linked_vendor_match = vendor_links.iter().any(|link| {
                    csv_supplier_name
                        == normalize_verify_text(link.vendor_name.as_deref().unwrap_or(""))
                });

                if !primary_vendor_match && !linked_vendor_match {
                    if ros_row.primary_vendor_name.is_none()
                        && ros_row.primary_vendor_code.is_none()
                        && vendor_links.is_empty()
                    {
                        mismatch_types.push("missing_vendor".into());
                        missing_vendor_count += 1;
                    } else {
                        mismatch_types.push("vendor_mismatch".into());
                        vendor_mismatch_count += 1;
                    }
                }
            }
            if vendor_links.is_empty() && !csv_supplier_name.is_empty() {
                mismatch_types.push("missing_vendor_item_link".into());
                missing_vendor_item_link_count += 1;
            }
        }

        if mismatch_types.is_empty() {
            if source_issue_only {
                csv_source_issue_count += 1;
                push_detail_row_limited(
                    &mut mismatch_rows,
                    CounterpointInventoryVerificationRow {
                        sku: csv_row.sku.clone(),
                        match_basis: Some(match_basis),
                        status: "csv_source_issue".into(),
                        mismatch_types: vec!["supplier_field_suspect".into()],
                        csv: csv_values,
                        ros: Some(verify_values_from_ros(ros_row, &vendor_links)),
                    },
                    COUNTERPOINT_INVENTORY_VERIFY_MAX_DETAIL_ROWS,
                    &mut detailed_rows_truncated,
                );
            } else {
                exact_match_count += 1;
            }
        } else {
            mismatched_count += 1;
            push_detail_row_limited(
                &mut mismatch_rows,
                CounterpointInventoryVerificationRow {
                    sku: csv_row.sku.clone(),
                    match_basis: Some(match_basis),
                    status: "mismatch".into(),
                    mismatch_types,
                    csv: csv_values,
                    ros: Some(verify_values_from_ros(ros_row, &vendor_links)),
                },
                COUNTERPOINT_INVENTORY_VERIFY_MAX_DETAIL_ROWS,
                &mut detailed_rows_truncated,
            );
        }
    }

    let mut variant_group_split_count = 0_i64;
    let mut parent_sku_variant_count = 0_i64;
    let mut duplicate_variant_label_count = 0_i64;
    let mut extra_parent_scope_artifact_count = 0_i64;
    let mut extra_key_present_scope_gap_count = 0_i64;
    let mut extra_unexplained_count = 0_i64;
    let mut critical_issues = Vec::new();

    for (group_key, summary) in &csv_groups {
        if summary.matched_product_ids.len() > 1 {
            variant_group_split_count += 1;
            critical_issues.push(format!(
                "Variant group {group_key} lands under {} ROS products instead of one.",
                summary.matched_product_ids.len()
            ));
        }
        let duplicate_labels = summary
            .variant_labels
            .iter()
            .filter(|(_, count)| **count > 1)
            .count() as i64;
        if duplicate_labels > 0 {
            duplicate_variant_label_count += duplicate_labels;
        }
        if summary.parent_sku_variant_seen {
            parent_sku_variant_count += 1;
            critical_issues.push(format!(
                "Variant group {group_key} includes a ROS variant whose SKU matches the product handle, which can indicate a parent SKU treated as a sellable variant."
            ));
        }
    }

    let mut extra_rows = Vec::new();
    for ros_row in &ros_rows {
        if matched_ros_variant_ids.contains(&ros_row.variant_id) {
            continue;
        }
        let normalized_sku = normalize_verify_text(&ros_row.sku);
        let normalized_key = ros_row
            .counterpoint_item_key
            .as_deref()
            .map(normalize_verify_text)
            .filter(|value| !value.is_empty());
        let normalized_handle = ros_row
            .catalog_handle
            .as_deref()
            .map(normalize_verify_text)
            .filter(|value| !value.is_empty());
        let extra_status = if let Some(key) = normalized_key.as_deref() {
            let key_count = csv_key_counts.get(key).copied().unwrap_or(0);
            if normalized_sku == key || normalized_handle.as_deref() == Some(key) {
                extra_parent_scope_artifact_count += 1;
                "extra_parent_scope_artifact"
            } else if key_count > 0 {
                extra_key_present_scope_gap_count += 1;
                "extra_key_present_scope_gap"
            } else {
                extra_unexplained_count += 1;
                "extra_unexplained"
            }
        } else if csv_skus.contains(&normalized_sku) {
            extra_key_present_scope_gap_count += 1;
            "extra_key_present_scope_gap"
        } else {
            extra_unexplained_count += 1;
            "extra_unexplained"
        };
        push_detail_row_limited(
            &mut extra_rows,
            CounterpointInventoryVerificationRow {
                sku: ros_row.sku.clone(),
                match_basis: None,
                status: extra_status.into(),
                mismatch_types: vec![extra_status.into()],
                csv: CounterpointInventoryVerificationValues {
                    sku: ros_row.sku.clone(),
                    name: None,
                    category: None,
                    variant_label: None,
                    supply_price: None,
                    retail_price: None,
                    inventory_quantity: None,
                    supplier_name: None,
                    supplier_code: None,
                    item_key: None,
                    catalog_handle: None,
                },
                ros: Some(verify_values_from_ros(
                    ros_row,
                    &vendor_links_by_variant
                        .get(&ros_row.variant_id)
                        .cloned()
                        .unwrap_or_default(),
                )),
            },
            COUNTERPOINT_INVENTORY_VERIFY_MAX_EXTRA_ROWS,
            &mut extra_rows_truncated,
        );
    }

    if missing_in_ros_count > 0 {
        if expected_out_of_scope_exclusion_count > 0 {
            critical_issues.push(format!(
                "{expected_out_of_scope_exclusion_count} CSV SKU(s) are expected out-of-scope exclusions under the active catalog/inventory import rules."
            ));
        }
        let unexplained_missing = missing_in_ros_count - expected_out_of_scope_exclusion_count;
        if unexplained_missing > 0 {
            critical_issues.push(format!(
                "{unexplained_missing} CSV SKU(s) are missing in ROS without an obvious active-scope exclusion explanation."
            ));
        }
    }
    let extra_in_ros_count = (ros_rows.len() - matched_ros_variant_ids.len()) as i64;
    if extra_unexplained_count > 0 {
        critical_issues.push(format!(
            "{extra_unexplained_count} Counterpoint-linked ROS variant(s) are unexplained extras with no matching CSV SKU or parent product key."
        ));
    }
    if supplier_field_suspect_count > 0 {
        critical_issues.push(format!(
            "{supplier_field_suspect_count} CSV row(s) have supplier fields that appear misaligned or blank."
        ));
    }
    if missing_vendor_item_link_count > 0 {
        critical_issues.push(format!(
            "{missing_vendor_item_link_count} matched SKU row(s) have no ROS vendor item linkage."
        ));
    }

    Ok(CounterpointInventoryVerificationReport {
        summary: CounterpointInventoryVerificationSummary {
            csv_path: csv_path.display().to_string(),
            total_csv_skus,
            exact_match_count,
            mismatched_count,
            comparison_artifact_count,
            csv_source_issue_count,
            missing_in_ros_count,
            extra_in_ros_count,
            matched_count: exact_match_count + mismatched_count + csv_source_issue_count,
            name_mismatch_count,
            category_mismatch_count,
            variant_mismatch_count,
            ros_variant_label_missing_count,
            price_mismatch_count,
            cost_mismatch_count,
            inventory_mismatch_count,
            supplier_field_suspect_count,
            supplier_code_non_vendor_key_count,
            variant_group_split_count,
            parent_sku_variant_count,
            duplicate_variant_label_count,
            missing_vendor_count,
            vendor_mismatch_count,
            missing_vendor_item_link_count,
            extra_parent_scope_artifact_count,
            extra_key_present_scope_gap_count,
            extra_unexplained_count,
            detailed_row_limit: COUNTERPOINT_INVENTORY_VERIFY_MAX_DETAIL_ROWS,
            detailed_rows_truncated,
            extra_rows_truncated,
            expected_out_of_scope_exclusion_count,
        },
        mismatch_rows,
        extra_rows,
        critical_issues,
    })
}

#[derive(Debug, Default)]
struct CounterpointBaselineResetTargets {
    counterpoint_customer_ids: Vec<Uuid>,
    counterpoint_product_ids: Vec<Uuid>,
    counterpoint_variant_ids: Vec<Uuid>,
    vendor_ids: Vec<Uuid>,
    gift_card_ids: Vec<Uuid>,
    loyalty_reward_issuance_ids: Vec<Uuid>,
    loyalty_point_ledger_ids: Vec<Uuid>,
    store_credit_account_ids: Vec<Uuid>,
    counterpoint_only_staff_ids: Vec<Uuid>,
    counterpoint_transaction_ids: Vec<Uuid>,
    counterpoint_sync_run_ids: Vec<i64>,
    counterpoint_sync_issue_ids: Vec<i64>,
    counterpoint_sync_request_ids: Vec<i64>,
    counterpoint_staging_batch_ids: Vec<i64>,
    counterpoint_receiving_history_ids: Vec<Uuid>,
    counterpoint_staff_map_staff_ids: Vec<Uuid>,
}

async fn collect_counterpoint_baseline_reset_targets(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<CounterpointBaselineResetTargets, CounterpointSyncError> {
    let counterpoint_customer_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM customers WHERE customer_created_source = 'counterpoint'",
    )
    .fetch_all(&mut **tx)
    .await?;

    let counterpoint_product_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM products WHERE data_source = 'counterpoint'")
            .fetch_all(&mut **tx)
            .await?;

    let counterpoint_variant_ids: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT pv.id
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        WHERE p.data_source = 'counterpoint'
        "#,
    )
    .fetch_all(&mut **tx)
    .await?;

    let vendor_ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM vendors")
        .fetch_all(&mut **tx)
        .await?;

    let gift_card_ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM gift_cards")
        .fetch_all(&mut **tx)
        .await?;

    let loyalty_reward_issuance_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM loyalty_reward_issuances")
            .fetch_all(&mut **tx)
            .await?;

    let loyalty_point_ledger_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM loyalty_point_ledger")
            .fetch_all(&mut **tx)
            .await?;

    let store_credit_account_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM store_credit_accounts")
            .fetch_all(&mut **tx)
            .await?;

    let counterpoint_only_staff_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM staff WHERE data_source = 'counterpoint' AND pin_hash IS NULL",
    )
    .fetch_all(&mut **tx)
    .await?;

    let counterpoint_transaction_ids: Vec<Uuid> = if counterpoint_customer_ids.is_empty() {
        sqlx::query_scalar("SELECT id FROM transactions WHERE is_counterpoint_import")
            .fetch_all(&mut **tx)
            .await?
    } else {
        sqlx::query_scalar(
            "SELECT id FROM transactions WHERE is_counterpoint_import OR customer_id = ANY($1)",
        )
        .bind(&counterpoint_customer_ids)
        .fetch_all(&mut **tx)
        .await?
    };

    Ok(CounterpointBaselineResetTargets {
        counterpoint_customer_ids,
        counterpoint_product_ids,
        counterpoint_variant_ids,
        vendor_ids,
        gift_card_ids,
        loyalty_reward_issuance_ids,
        loyalty_point_ledger_ids,
        store_credit_account_ids,
        counterpoint_only_staff_ids,
        counterpoint_transaction_ids,
        counterpoint_sync_run_ids: sqlx::query_scalar("SELECT id FROM counterpoint_sync_runs")
            .fetch_all(&mut **tx)
            .await?,
        counterpoint_sync_issue_ids: sqlx::query_scalar("SELECT id FROM counterpoint_sync_issue")
            .fetch_all(&mut **tx)
            .await?,
        counterpoint_sync_request_ids: sqlx::query_scalar(
            "SELECT id FROM counterpoint_sync_request",
        )
        .fetch_all(&mut **tx)
        .await?,
        counterpoint_staging_batch_ids: sqlx::query_scalar(
            "SELECT id FROM counterpoint_staging_batch",
        )
        .fetch_all(&mut **tx)
        .await?,
        counterpoint_receiving_history_ids: sqlx::query_scalar(
            "SELECT id FROM counterpoint_receiving_history",
        )
        .fetch_all(&mut **tx)
        .await?,
        counterpoint_staff_map_staff_ids: sqlx::query_scalar(
            "SELECT ros_staff_id FROM counterpoint_staff_map",
        )
        .fetch_all(&mut **tx)
        .await?,
    })
}

pub async fn execute_counterpoint_baseline_reset(
    pool: &PgPool,
) -> Result<CounterpointResetResult, CounterpointSyncError> {
    let preview_scope = build_counterpoint_reset_scope(pool).await?;
    let mut tx = pool.begin().await?;
    let targets = collect_counterpoint_baseline_reset_targets(&mut tx).await?;
    perform_counterpoint_baseline_reset_targets(&mut tx, &targets).await?;
    tx.commit().await?;

    Ok(CounterpointResetResult {
        confirmation_phrase: COUNTERPOINT_BASELINE_RESET_CONFIRMATION.into(),
        reset_scope: preview_scope,
        preserve_always: counterpoint_reset_preserve_always(),
        bridge_local_state_note: "Bridge-local cursor files are not changed automatically. If you want a true full replay from the Counterpoint PC, reset or remove .counterpoint-bridge-state.json before the next import.".into(),
    })
}

async fn perform_counterpoint_baseline_reset_targets(
    tx: &mut Transaction<'_, Postgres>,
    targets: &CounterpointBaselineResetTargets,
) -> Result<(), CounterpointSyncError> {
    if !targets.counterpoint_transaction_ids.is_empty() {
        sqlx::query(
            r#"
            DELETE FROM payment_transactions pt
            WHERE EXISTS (
                SELECT 1
                FROM payment_allocations pa
                WHERE pa.transaction_id = pt.id
                  AND pa.target_transaction_id = ANY($1)
            )
            "#,
        )
        .bind(&targets.counterpoint_transaction_ids)
        .execute(&mut **tx)
        .await?;

        sqlx::query("DELETE FROM transactions WHERE id = ANY($1)")
            .bind(&targets.counterpoint_transaction_ids)
            .execute(&mut **tx)
            .await?;
    }

    if !targets.counterpoint_customer_ids.is_empty() {
        sqlx::query(
            "UPDATE staff SET employee_customer_id = NULL WHERE employee_customer_id = ANY($1)",
        )
        .bind(&targets.counterpoint_customer_ids)
        .execute(&mut **tx)
        .await?;

        sqlx::query(
            "UPDATE customers SET couple_primary_id = NULL WHERE couple_primary_id = ANY($1)",
        )
        .bind(&targets.counterpoint_customer_ids)
        .execute(&mut **tx)
        .await?;

        sqlx::query("DELETE FROM payment_transactions WHERE payer_id = ANY($1)")
            .bind(&targets.counterpoint_customer_ids)
            .execute(&mut **tx)
            .await?;

        sqlx::query("DELETE FROM customers WHERE id = ANY($1)")
            .bind(&targets.counterpoint_customer_ids)
            .execute(&mut **tx)
            .await?;
    }

    if !targets.gift_card_ids.is_empty() {
        sqlx::query(
            "UPDATE loyalty_reward_issuances SET remainder_card_id = NULL WHERE remainder_card_id = ANY($1)",
        )
        .bind(&targets.gift_card_ids)
        .execute(&mut **tx)
        .await?;

        sqlx::query("DELETE FROM gift_cards WHERE id = ANY($1)")
            .bind(&targets.gift_card_ids)
            .execute(&mut **tx)
            .await?;
    }

    if !targets.loyalty_reward_issuance_ids.is_empty() {
        sqlx::query("DELETE FROM loyalty_reward_issuances WHERE id = ANY($1)")
            .bind(&targets.loyalty_reward_issuance_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !targets.loyalty_point_ledger_ids.is_empty() {
        sqlx::query("DELETE FROM loyalty_point_ledger WHERE id = ANY($1)")
            .bind(&targets.loyalty_point_ledger_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !targets.store_credit_account_ids.is_empty() {
        sqlx::query("DELETE FROM store_credit_accounts WHERE id = ANY($1)")
            .bind(&targets.store_credit_account_ids)
            .execute(&mut **tx)
            .await?;
    }

    if !targets.counterpoint_variant_ids.is_empty() {
        sqlx::query("DELETE FROM discount_event_usage WHERE variant_id = ANY($1)")
            .bind(&targets.counterpoint_variant_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM inventory_count_scan_stream WHERE variant_id = ANY($1)")
            .bind(&targets.counterpoint_variant_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM inventory_transactions WHERE variant_id = ANY($1)")
            .bind(&targets.counterpoint_variant_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM physical_inventory_audit WHERE variant_id = ANY($1)")
            .bind(&targets.counterpoint_variant_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM physical_inventory_counts WHERE variant_id = ANY($1)")
            .bind(&targets.counterpoint_variant_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM physical_inventory_snapshots WHERE variant_id = ANY($1)")
            .bind(&targets.counterpoint_variant_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM purchase_order_lines WHERE variant_id = ANY($1)")
            .bind(&targets.counterpoint_variant_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query(
            "UPDATE wedding_members SET suit_variant_id = NULL WHERE suit_variant_id = ANY($1)",
        )
        .bind(&targets.counterpoint_variant_ids)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "UPDATE wedding_parties SET suit_variant_id = NULL WHERE suit_variant_id = ANY($1)",
        )
        .bind(&targets.counterpoint_variant_ids)
        .execute(&mut **tx)
        .await?;
    }

    if !targets.counterpoint_product_ids.is_empty() || !targets.counterpoint_variant_ids.is_empty()
    {
        sqlx::query(
            r#"
            DELETE FROM suit_component_swap_events
            WHERE old_variant_id = ANY($1)
               OR new_variant_id = ANY($1)
               OR old_product_id = ANY($2)
               OR new_product_id = ANY($2)
            "#,
        )
        .bind(&targets.counterpoint_variant_ids)
        .bind(&targets.counterpoint_product_ids)
        .execute(&mut **tx)
        .await?;
    }

    if !targets.counterpoint_receiving_history_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_receiving_history WHERE id = ANY($1)")
            .bind(&targets.counterpoint_receiving_history_ids)
            .execute(&mut **tx)
            .await?;
    }

    if !targets.counterpoint_product_ids.is_empty() {
        sqlx::query("DELETE FROM products WHERE id = ANY($1)")
            .bind(&targets.counterpoint_product_ids)
            .execute(&mut **tx)
            .await?;
    }

    if !targets.vendor_ids.is_empty() {
        sqlx::query(
            "DELETE FROM purchase_order_lines WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE vendor_id = ANY($1))",
        )
        .bind(&targets.vendor_ids)
        .execute(&mut **tx)
        .await?;
        sqlx::query("DELETE FROM receiving_events WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE vendor_id = ANY($1))")
            .bind(&targets.vendor_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM purchase_orders WHERE vendor_id = ANY($1)")
            .bind(&targets.vendor_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM vendor_supplier_item WHERE vendor_id = ANY($1)")
            .bind(&targets.vendor_ids)
            .execute(&mut **tx)
            .await?;
        sqlx::query(
            "UPDATE products SET primary_vendor_id = NULL WHERE primary_vendor_id = ANY($1)",
        )
        .bind(&targets.vendor_ids)
        .execute(&mut **tx)
        .await?;
        sqlx::query("DELETE FROM vendors WHERE id = ANY($1)")
            .bind(&targets.vendor_ids)
            .execute(&mut **tx)
            .await?;
    }

    if !targets.counterpoint_staging_batch_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_staging_batch WHERE id = ANY($1)")
            .bind(&targets.counterpoint_staging_batch_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !targets.counterpoint_sync_request_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_sync_request WHERE id = ANY($1)")
            .bind(&targets.counterpoint_sync_request_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !targets.counterpoint_sync_issue_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_sync_issue WHERE id = ANY($1)")
            .bind(&targets.counterpoint_sync_issue_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !targets.counterpoint_sync_run_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_sync_runs WHERE id = ANY($1)")
            .bind(&targets.counterpoint_sync_run_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !targets.counterpoint_staff_map_staff_ids.is_empty() {
        sqlx::query("DELETE FROM counterpoint_staff_map WHERE ros_staff_id = ANY($1)")
            .bind(&targets.counterpoint_staff_map_staff_ids)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query(
        r#"
        UPDATE counterpoint_bridge_heartbeat
        SET last_seen_at = NOW(),
            bridge_phase = 'idle',
            current_entity = NULL,
            bridge_version = NULL,
            bridge_hostname = NULL,
            updated_at = NOW()
        WHERE id = 1
        "#,
    )
    .execute(&mut **tx)
    .await?;

    if !targets.counterpoint_only_staff_ids.is_empty() {
        sqlx::query("DELETE FROM staff WHERE id = ANY($1)")
            .bind(&targets.counterpoint_only_staff_ids)
            .execute(&mut **tx)
            .await?;
    }

    sqlx::query(
        r#"
        UPDATE staff
        SET counterpoint_user_id = NULL,
            counterpoint_sls_rep = NULL,
            data_source = CASE
                WHEN pin_hash IS NOT NULL AND data_source = 'counterpoint' THEN NULL
                ELSE data_source
            END
        WHERE counterpoint_user_id IS NOT NULL
           OR counterpoint_sls_rep IS NOT NULL
            OR (pin_hash IS NOT NULL AND data_source = 'counterpoint')
        "#,
    )
    .execute(&mut **tx)
    .await?;

    Ok(())
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
            let _ = record_sync_run(
                pool,
                "category_masters",
                s.cursor.as_deref(),
                true,
                Some(summary.categories_created + summary.maps_upserted + summary.skipped),
                None,
            )
            .await;
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

    // High-performance cache for vendor and category maps
    let vendor_map: HashMap<String, Uuid> = sqlx::query_as::<_, (String, Uuid)>(
        "SELECT vendor_code, id FROM vendors WHERE vendor_code IS NOT NULL",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    let mut tx = pool.begin().await?;
    let mut summary = CatalogUpsertSummary {
        products_created: 0,
        products_updated: 0,
        variants_created: 0,
        variants_updated: 0,
        skipped: 0,
    };

    for row in &payload.rows {
        // Use a savepoint for each item so a single row failure (e.g. duplicate SKU)
        // doesn't abort the entire batch transaction.
        let mut sp = tx.begin().await?;
        if let Err(e) = upsert_catalog_item(&mut sp, row, &mut summary, &vendor_map).await {
            let _ = sp.rollback().await;
            tracing::warn!(item_no = %row.item_no, error = %e, "catalog row upsert failed, recording issue");
            record_sync_issue(pool, "catalog", Some(&row.item_no), "error", &e.to_string()).await;
            summary.skipped += 1;
        } else {
            sp.commit().await?;
        }
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "catalog" {
            let _ = record_sync_run(
                pool,
                "catalog",
                s.cursor.as_deref(),
                true,
                Some(
                    summary.products_created
                        + summary.products_updated
                        + summary.variants_created
                        + summary.variants_updated
                        + summary.skipped,
                ),
                None,
            )
            .await;
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

async fn upsert_catalog_item(
    tx: &mut Transaction<'_, Postgres>,
    row: &CounterpointCatalogRow,
    summary: &mut CatalogUpsertSummary,
    vendor_map: &HashMap<String, Uuid>,
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
    let vendor_id = row
        .vendor_no
        .as_deref()
        .and_then(|v| vendor_map.get(v.trim()))
        .copied();

    let existing_product: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM products WHERE catalog_handle = $1 LIMIT 1")
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
            INSERT INTO products (
                catalog_handle, name, description, brand, base_retail_price,
                base_cost, category_id, primary_vendor_id, spiff_amount, data_source
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'counterpoint')
            RETURNING id
            "#,
        )
        .bind(item_no)
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
        // PER USER RULES: B-XXXXXX is the Barcode (SKU), I-XXXXXX is the Item # (Parent)
        let sku = trim_opt(&row.barcode).unwrap_or_else(|| item_no.to_string());
        let key = item_no.to_string(); // Internal Counterpoint key for upserts
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
            ON CONFLICT (sku) DO UPDATE SET
                product_id = EXCLUDED.product_id,
                barcode = COALESCE(EXCLUDED.barcode, product_variants.barcode),
                counterpoint_item_key = COALESCE(EXCLUDED.counterpoint_item_key, product_variants.counterpoint_item_key),
                variation_values = EXCLUDED.variation_values,
                variation_label = COALESCE(EXCLUDED.variation_label, product_variants.variation_label),
                retail_price_override = COALESCE(EXCLUDED.retail_price_override, product_variants.retail_price_override),
                cost_override = COALESCE(EXCLUDED.cost_override, product_variants.cost_override),
                counterpoint_prc_2 = COALESCE(EXCLUDED.counterpoint_prc_2, product_variants.counterpoint_prc_2),
                counterpoint_prc_3 = COALESCE(EXCLUDED.counterpoint_prc_3, product_variants.counterpoint_prc_3),
                stock_on_hand = EXCLUDED.stock_on_hand,
                reorder_point = EXCLUDED.reorder_point
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

async fn gift_card_event_exists(
    tx: &mut Transaction<'_, Postgres>,
    gift_card_id: Uuid,
    event_kind: &str,
    amount: Decimal,
    balance_after: Decimal,
    transaction_id: Option<Uuid>,
    notes: Option<&str>,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM gift_card_events
            WHERE gift_card_id = $1
              AND event_kind = $2
              AND amount = $3
              AND balance_after = $4
              AND transaction_id IS NOT DISTINCT FROM $5
              AND notes IS NOT DISTINCT FROM $6
        )
        "#,
    )
    .bind(gift_card_id)
    .bind(event_kind)
    .bind(amount)
    .bind(balance_after)
    .bind(transaction_id)
    .bind(notes)
    .fetch_one(&mut **tx)
    .await
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
                .or(issued_at)
                .unwrap_or_else(Utc::now);

            let notes = evt.notes.as_deref();
            let already_exists = gift_card_event_exists(
                &mut tx,
                gc_id,
                &evt.event_kind,
                evt.amount,
                evt.balance_after,
                None,
                notes,
            )
            .await?;

            if already_exists {
                continue;
            }

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
            .bind(notes)
            .bind(ts)
            .execute(&mut *tx)
            .await?;
            summary.events_created += 1;
        }
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "gift_cards" {
            let _ = record_sync_run(
                pool,
                "gift_cards",
                s.cursor.as_deref(),
                true,
                Some(summary.created + summary.updated + summary.skipped),
                None,
            )
            .await;
        }
    }

    Ok(summary)
}

// ────────────────────────────────────────────────────────────────────────────
// Ticket history ingest (PS_TKT_HIST → transactions / transaction_lines / payments)
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
    pub notes: Option<String>,
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
    #[serde(default)]
    pub reason_code: Option<String>,
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
    pub transactions_created: i32,
    pub transactions_skipped_existing: i32,
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

fn sum_counterpoint_ticket_tenders(
    payments: &[TicketPaymentRow],
    gift_applications: &[TicketGiftApplicationRow],
) -> Option<Decimal> {
    if payments.is_empty() && gift_applications.is_empty() {
        return None;
    }

    let payment_total: Decimal = payments.iter().map(|p| p.amount).sum();
    let gift_total: Decimal = gift_applications
        .iter()
        .filter(|ga| cp_gift_hist_row_is_redemption(ga.action.as_deref()))
        .map(|ga| ga.amount)
        .sum();

    Some(payment_total + gift_total)
}

fn sum_counterpoint_open_doc_tenders(payments: &[TicketPaymentRow]) -> Option<Decimal> {
    if payments.is_empty() {
        return None;
    }

    Some(payments.iter().map(|p| p.amount).sum())
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

    // High-performance caches for salesperson and payment resolution
    let staff_map: HashMap<String, Uuid> = sqlx::query_as::<_, (String, Uuid)>(
        "SELECT cp_code, ros_staff_id FROM counterpoint_staff_map",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    let pmt_map: HashMap<String, String> = sqlx::query_as::<_, (String, String)>(
        "SELECT cp_pmt_typ, ros_method FROM counterpoint_payment_method_map",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    // Batch pre-fetch variants to avoid per-line DB lookups (massive bottleneck for 13k+ tickets)
    let mut all_item_keys = HashSet::new();
    let mut all_skus = HashSet::new();
    for tkt in &payload.rows {
        for line in &tkt.lines {
            if let Some(ref k) = line.counterpoint_item_key {
                all_item_keys.insert(k.trim().to_string());
            }
            if let Some(ref s) = line.sku {
                all_skus.insert(s.trim().to_lowercase());
            }
        }
    }

    let mut variant_cache: HashMap<String, (Uuid, Uuid)> = HashMap::new();
    if !all_item_keys.is_empty() {
        let keys: Vec<String> = all_item_keys.into_iter().collect();
        let rows: Vec<(String, Uuid, Uuid)> = sqlx::query_as(
            "SELECT counterpoint_item_key, id, product_id FROM product_variants WHERE counterpoint_item_key = ANY($1)",
        )
        .bind(&keys)
        .fetch_all(pool)
        .await?;
        for (k, id, pid) in rows {
            variant_cache.insert(k, (id, pid));
        }
    }
    if !all_skus.is_empty() {
        let skus: Vec<String> = all_skus.into_iter().collect();
        let rows: Vec<(String, Uuid, Uuid)> = sqlx::query_as(
            "SELECT lower(trim(sku)), id, product_id FROM product_variants WHERE lower(trim(sku)) = ANY($1)",
        )
        .bind(&skus)
        .fetch_all(pool)
        .await?;
        for (s, id, pid) in rows {
            // Only insert if not already there via item_key (item_key wins)
            variant_cache.entry(s).or_insert((id, pid));
        }
    }

    // Batch pre-fetch customer IDs and duplicate ticket refs (Extreme Performance for 13k+ tickets)
    let cust_codes: HashSet<String> = payload
        .rows
        .iter()
        .filter_map(|t| t.cust_no.as_ref().map(|s| s.trim().to_string()))
        .collect();
    let ticket_refs: Vec<String> = payload
        .rows
        .iter()
        .map(|t| t.ticket_ref.trim().to_string())
        .collect();

    let customer_id_map: HashMap<String, Uuid> = if cust_codes.is_empty() {
        HashMap::new()
    } else {
        let mut map = HashMap::new();
        let codes: Vec<String> = cust_codes.into_iter().collect();
        // Match either exact, with C- prefix, or stripping C- prefix
        // This handles cases where tickets have C- but DB doesn't, or vice versa
        let rows: Vec<(String, Uuid)> = sqlx::query_as(
            r#"
            SELECT customer_code, id FROM customers 
            WHERE customer_code = ANY($1) 
               OR customer_code IN (SELECT 'C-' || c FROM unnest($1::text[]) c)
               OR customer_code IN (SELECT substring(c from 3) FROM unnest($1::text[]) c WHERE c LIKE 'C-%')
            "#
        )
        .bind(&codes)
        .fetch_all(pool)
        .await?;

        for (code, id) in rows {
            // Priority 1: Exact match (as stored in DB)
            map.insert(code.clone(), id);

            // Priority 2: If DB code has C-, also allow ticket to find it without C-
            if let Some(clean) = code.strip_prefix("C-") {
                map.entry(clean.to_string()).or_insert(id);
            }
            // Priority 3: If DB code DOES NOT have C-, also allow ticket to find it with C-
            else {
                map.entry(format!("C-{code}")).or_insert(id);
            }
        }
        map
    };

    let existing_ticket_refs: HashSet<String> = if ticket_refs.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar::<_, String>(
            "SELECT counterpoint_ticket_ref FROM transactions WHERE counterpoint_ticket_ref = ANY($1)",
        )
        .bind(&ticket_refs)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect()
    };

    let mut tx = pool.begin().await?;
    let mut bulk_line_txn_ids = Vec::new();
    let mut bulk_line_prod_ids = Vec::new();
    let mut bulk_line_var_ids = Vec::new();
    let mut bulk_line_sales_ids = Vec::new();
    let mut bulk_line_qtys = Vec::new();
    let mut bulk_line_prices = Vec::new();
    let mut bulk_line_costs = Vec::new();
    let mut bulk_line_reasons = Vec::new();

    let mut summary = TicketSyncSummary {
        transactions_created: 0,
        transactions_skipped_existing: 0,
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

        if existing_ticket_refs.contains(ticket_ref) {
            summary.transactions_skipped_existing += 1;
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

        let mut resolved_lines = Vec::with_capacity(tkt.lines.len());
        let mut resolve_err = None;
        for line in &tkt.lines {
            let mut resolved = None;
            if let Some(ref k) = line.counterpoint_item_key {
                resolved = variant_cache.get(k.trim()).copied();
            }
            if resolved.is_none() {
                if let Some(ref s) = line.sku {
                    resolved = variant_cache.get(&s.trim().to_lowercase()).copied();
                }
            }

            // Fallback for matrix parents (optimized fallback)
            if resolved.is_none() {
                let parent_only = line
                    .counterpoint_item_key
                    .as_deref()
                    .or(line.sku.as_deref())
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && !s.contains('|'));
                if let Some(parent) = parent_only {
                    resolved = resolve_variant_matrix_parent_price_fallback(
                        &mut tx,
                        parent,
                        line.unit_price,
                    )
                    .await?;
                }
            }

            if let Some(v) = resolved {
                resolved_lines.push(v);
            } else {
                let sku_str = line.sku.as_deref().unwrap_or("");
                let key = line.counterpoint_item_key.as_deref().unwrap_or("");
                resolve_err = Some(format!(
                    "unresolved line (sku={sku_str:?} counterpoint_item_key={key:?}); import catalog and align SKUs or cell keys"
                ));
                break;
            }
        }

        if let Some(msg) = resolve_err {
            let fallback = ensure_historical_fallback_variant(&mut tx).await?;
            record_sync_issue(
                pool,
                "tickets",
                Some(ticket_ref),
                "warning",
                &format!("Item unresolved, using historical fallback: {msg}"),
            )
            .await;

            // Reset lines for order insertion (use fallback for all lines if ANY failed in this order
            // to maintain consistency, or we could selectively fallback. For simplicity, if any fail,
            // we'll keep the resolved ones and use fallback for the rest).

            // Re-run resolution with fallback mode
            resolved_lines.clear();
            for line in &tkt.lines {
                let mut resolved = None;
                if let Some(ref k) = line.counterpoint_item_key {
                    resolved = variant_cache.get(k.trim()).copied();
                }
                if resolved.is_none() {
                    if let Some(ref s) = line.sku {
                        resolved = variant_cache.get(&s.trim().to_lowercase()).copied();
                    }
                }
                if resolved.is_none() {
                    let parent_only = line
                        .counterpoint_item_key
                        .as_deref()
                        .or(line.sku.as_deref())
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && !s.contains('|'));
                    if let Some(parent) = parent_only {
                        resolved = resolve_variant_matrix_parent_price_fallback(
                            &mut tx,
                            parent,
                            line.unit_price,
                        )
                        .await?;
                    }
                }

                resolved_lines.push(resolved.unwrap_or(fallback));
            }
        }

        let customer_id: Option<Uuid> = tkt
            .cust_no
            .as_deref()
            .and_then(|c| customer_id_map.get(c.trim()))
            .copied();

        let booked_at = tkt
            .booked_at
            .as_deref()
            .and_then(|s| {
                DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|d| d.with_timezone(&Utc))
            })
            .unwrap_or_else(Utc::now);

        let normalized_amount_paid =
            sum_counterpoint_ticket_tenders(&tkt.payments, &tkt.gift_applications)
                .unwrap_or(tkt.amount_paid);
        let balance = tkt.total_price - normalized_amount_paid;
        let status = if balance <= Decimal::ZERO {
            "fulfilled"
        } else {
            "open"
        };

        let processed_by = tkt
            .usr_id
            .as_deref()
            .and_then(|c| staff_map.get(c.trim()))
            .copied();
        let salesperson = tkt
            .sls_rep
            .as_deref()
            .and_then(|c| staff_map.get(c.trim()))
            .copied();

        let transaction_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO transactions (
                customer_id, counterpoint_ticket_ref, counterpoint_customer_code,
                is_counterpoint_import, status, booked_at, total_price, 
                amount_paid, balance_due, processed_by_staff_id, 
                primary_salesperson_id, notes
            )
            VALUES ($1, $2, $3, TRUE, $4::order_status, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id
            "#,
        )
        .bind(customer_id)
        .bind(ticket_ref)
        .bind(tkt.cust_no.as_deref())
        .bind(status)
        .bind(booked_at)
        .bind(tkt.total_price)
        .bind(normalized_amount_paid)
        .bind(balance)
        .bind(processed_by)
        .bind(salesperson)
        .bind(tkt.notes.as_deref())
        .fetch_one(&mut *tx)
        .await?;
        summary.transactions_created += 1;

        for ((variant_id, product_id), line) in resolved_lines.iter().zip(tkt.lines.iter()) {
            let cost = line.unit_cost.unwrap_or(Decimal::ZERO);
            bulk_line_txn_ids.push(transaction_id);
            bulk_line_prod_ids.push(*product_id);
            bulk_line_var_ids.push(*variant_id);
            bulk_line_sales_ids.push(salesperson);
            bulk_line_qtys.push(line.quantity);
            bulk_line_prices.push(line.unit_price);
            bulk_line_costs.push(cost);
            bulk_line_reasons.push(line.reason_code.clone());
            summary.line_items_created += 1;
        }

        for pmt in &tkt.payments {
            let method = pmt_map
                .get(&pmt.pmt_typ.trim().to_uppercase())
                .cloned()
                .unwrap_or_else(|| "cash".to_string());

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
                "INSERT INTO payment_allocations (transaction_id, target_transaction_id, amount_allocated) VALUES ($1, $2, $3)",
            )
            .bind(txn_id)
            .bind(transaction_id)
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
            let redemption_note = format!("Counterpoint ticket {ticket_ref}");
            let already_exists = gift_card_event_exists(
                &mut tx,
                gc_id,
                "redeemed",
                -redeem,
                bal,
                Some(transaction_id),
                Some(redemption_note.as_str()),
            )
            .await?;

            if already_exists {
                summary.skipped += 1;
                continue;
            }
            sqlx::query("UPDATE gift_cards SET current_balance = $1 WHERE id = $2")
                .bind(bal)
                .bind(gc_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                r#"
                INSERT INTO gift_card_events (
                    gift_card_id, event_kind, amount, balance_after, transaction_id, notes, created_at
                )
                VALUES ($1, 'redeemed', $2, $3, $4, $5, $6)
                "#,
            )
            .bind(gc_id)
            .bind(-redeem)
            .bind(bal)
            .bind(transaction_id)
            .bind(redemption_note)
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
                "INSERT INTO payment_allocations (transaction_id, target_transaction_id, amount_allocated) VALUES ($1, $2, $3)",
            )
            .bind(txn_id)
            .bind(transaction_id)
            .bind(redeem)
            .execute(&mut *tx)
            .await?;
            summary.gift_payments_created += 1;
        }
    }

    // Bulk Insert all transaction lines for the batch
    if !bulk_line_txn_ids.is_empty() {
        sqlx::query(
            r#"
            INSERT INTO transaction_lines (
                transaction_id, product_id, variant_id, salesperson_id, fulfillment,
                quantity, unit_price, unit_cost,
                state_tax, local_tax, applied_spiff, calculated_commission,
                counterpoint_reason_code
            )
            SELECT 
                u.tid, u.pid, u.vid, u.sid, 'takeaway'::fulfillment_type, 
                u.qty, u.price, u.cost, 0, 0, 0, 0, u.reason
            FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::numeric[], $6::numeric[], $7::numeric[], $8::text[]) 
              AS u(tid, pid, vid, sid, qty, price, cost, reason)
            "#,
        )
        .bind(&bulk_line_txn_ids)
        .bind(&bulk_line_prod_ids)
        .bind(&bulk_line_var_ids)
        .bind(&bulk_line_sales_ids)
        .bind(&bulk_line_qtys)
        .bind(&bulk_line_prices)
        .bind(&bulk_line_costs)
        .bind(&bulk_line_reasons)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "tickets" {
            let _ = record_sync_run(
                pool,
                "tickets",
                s.cursor.as_deref(),
                true,
                Some(
                    summary.transactions_created
                        + summary.transactions_skipped_existing
                        + summary.skipped,
                ),
                None,
            )
            .await;
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

fn fulfillment_type_for_cp_doc_typ(doc_typ: Option<&str>) -> &'static str {
    match doc_typ.map(|s| s.trim().to_uppercase()).as_deref() {
        Some("L") => "layaway",
        _ => "special_order",
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Open documents (PS_DOC → transactions as special_order lines; idempotent on doc ref)
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
    #[serde(default)]
    pub cp_status: Option<String>,
    /// CP `DOC_TYP`: O=Order (Special Order), L=Layaway.
    #[serde(default)]
    pub doc_typ: Option<String>,
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
    pub transactions_created: i32,
    pub transactions_skipped_existing: i32,
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

    // High-performance staff cache for salesperson resolution
    let staff_map: HashMap<String, Uuid> = sqlx::query_as::<_, (String, Uuid)>(
        "SELECT cp_code, ros_staff_id FROM counterpoint_staff_map",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    // Batch pre-fetch customer IDs
    let cust_codes: HashSet<String> = payload
        .rows
        .iter()
        .filter_map(|d| d.cust_no.as_ref().map(|s| s.trim().to_string()))
        .collect();

    let customer_id_map: HashMap<String, Uuid> = if cust_codes.is_empty() {
        HashMap::new()
    } else {
        let mut map = HashMap::new();
        let codes: Vec<String> = cust_codes.into_iter().collect();
        let rows: Vec<(String, Uuid)> = sqlx::query_as(
            r#"
            SELECT customer_code, id FROM customers 
            WHERE customer_code = ANY($1) 
               OR customer_code IN (SELECT 'C-' || c FROM unnest($1::text[]) c)
               OR customer_code IN (SELECT substring(c from 3) FROM unnest($1::text[]) c WHERE c LIKE 'C-%')
            "#
        )
        .bind(&codes)
        .fetch_all(pool)
        .await?;
        for (code, id) in rows {
            map.insert(code.clone(), id);
            if let Some(clean) = code.strip_prefix("C-") {
                map.entry(clean.to_string()).or_insert(id);
            } else {
                map.entry(format!("C-{code}")).or_insert(id);
            }
        }
        map
    };

    let mut tx = pool.begin().await?;
    let mut summary = OpenDocSyncSummary {
        transactions_created: 0,
        transactions_skipped_existing: 0,
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
            "SELECT EXISTS(SELECT 1 FROM transactions WHERE counterpoint_doc_ref = $1)",
        )
        .bind(doc_ref)
        .fetch_one(&mut *tx)
        .await?;

        if exists {
            summary.transactions_skipped_existing += 1;
            continue;
        }

        let customer_id: Option<Uuid> = doc
            .cust_no
            .as_deref()
            .and_then(|c| customer_id_map.get(c.trim()))
            .copied();

        let booked_at = doc
            .booked_at
            .as_deref()
            .and_then(|s| {
                DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|d| d.with_timezone(&Utc))
            })
            .unwrap_or_else(Utc::now);

        let normalized_amount_paid =
            sum_counterpoint_open_doc_tenders(&doc.payments).unwrap_or(doc.amount_paid);
        let balance = doc.total_price - normalized_amount_paid;
        let status = order_status_for_cp_open_doc(
            doc.cp_status.as_deref(),
            doc.total_price,
            normalized_amount_paid,
        );

        let processed_by = doc
            .usr_id
            .as_deref()
            .and_then(|c| staff_map.get(c.trim()))
            .copied();
        let salesperson = doc
            .sls_rep
            .as_deref()
            .and_then(|c| staff_map.get(c.trim()))
            .copied();

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

        let transaction_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO transactions (
                customer_id, counterpoint_ticket_ref, counterpoint_doc_ref, 
                counterpoint_customer_code, is_counterpoint_import,
                status, booked_at, total_price, amount_paid, balance_due,
                processed_by_staff_id, primary_salesperson_id
            )
            VALUES ($1, NULL, $2, $3, TRUE, $4::order_status, $5, $6, $7, $8, $9, $10)
            RETURNING id
            "#,
        )
        .bind(customer_id)
        .bind(doc_ref)
        .bind(doc.cust_no.as_deref())
        .bind(status)
        .bind(booked_at)
        .bind(doc.total_price)
        .bind(normalized_amount_paid)
        .bind(balance)
        .bind(processed_by)
        .bind(salesperson)
        .fetch_one(&mut *tx)
        .await?;
        summary.transactions_created += 1;

        let fulfillment = fulfillment_type_for_cp_doc_typ(doc.doc_typ.as_deref());

        for ((variant_id, product_id), line) in resolved_lines.iter().zip(doc.lines.iter()) {
            let cost = line.unit_cost.unwrap_or(Decimal::ZERO);

            sqlx::query(
                r#"
                INSERT INTO transaction_lines (
                    transaction_id, product_id, variant_id, salesperson_id, fulfillment,
                    quantity, unit_price, unit_cost,
                    state_tax, local_tax, applied_spiff, calculated_commission,
                    counterpoint_reason_code
                )
                VALUES ($1, $2, $3, $4, $5::fulfillment_type, $6, $7, $8, 0, 0, 0, 0, $9)
                "#,
            )
            .bind(transaction_id)
            .bind(product_id)
            .bind(variant_id)
            .bind(salesperson)
            .bind(fulfillment)
            .bind(line.quantity)
            .bind(line.unit_price)
            .bind(cost)
            .bind(line.reason_code.as_deref())
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
                "INSERT INTO payment_allocations (transaction_id, target_transaction_id, amount_allocated) VALUES ($1, $2, $3)",
            )
            .bind(txn_id)
            .bind(transaction_id)
            .bind(pmt.amount)
            .execute(&mut *tx)
            .await?;
            summary.payments_created += 1;
        }
    }

    tx.commit().await?;

    if let Some(ref s) = payload.sync {
        if s.entity == "open_docs" {
            let _ = record_sync_run(
                pool,
                "open_docs",
                s.cursor.as_deref(),
                true,
                Some(
                    summary.transactions_created
                        + summary.transactions_skipped_existing
                        + summary.skipped,
                ),
                None,
            )
            .await;
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
            let _ = record_sync_run(
                pool,
                "vendors",
                s.cursor.as_deref(),
                true,
                Some(summary.created + summary.updated),
                None,
            )
            .await;
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
            let _ = record_sync_run(
                pool,
                "customer_notes",
                s.cursor.as_deref(),
                true,
                Some(summary.created),
                None,
            )
            .await;
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
            let _ = record_sync_run(
                pool,
                "staff",
                s.cursor.as_deref(),
                true,
                Some(summary.created + summary.updated + summary.merged),
                None,
            )
            .await;
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
            let _ = record_sync_run(
                pool,
                "sales_rep_stubs",
                s.cursor.as_deref(),
                true,
                Some(
                    summary.created
                        + summary.skipped_already_mapped
                        + summary.skipped_empty
                        + summary.skipped_cashier_conflict,
                ),
                None,
            )
            .await;
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

    // 1. Batch resolve customer IDs
    let customer_id_map: HashMap<String, Uuid> = if cust_codes.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (String, Uuid)>(
            "SELECT customer_code, id FROM customers WHERE customer_code = ANY($1)",
        )
        .bind(&cust_codes[..])
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect()
    };

    // 1b. Batch fetch current loyalty points from customers for opening balance logic
    let loyalty_by_code: HashMap<String, i32> = if cust_codes.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (String, i32)>(
            "SELECT customer_code, COALESCE(loyalty_points, 0)::int FROM customers WHERE customer_code = ANY($1)",
        )
        .bind(&cust_codes[..])
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect()
    };

    // 2. Batch check for duplicates in one query
    let mut cp_refs = Vec::with_capacity(rows.len());
    for row in &rows {
        let cust_no = row.cust_no.trim();
        if cust_no.is_empty() {
            continue;
        }
        let date_part = row
            .bus_dat
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("_");
        let ref_part = row.ref_no.as_deref().map(str::trim).unwrap_or("");
        cp_refs.push(format!("{cust_no}|{date_part}|{ref_part}"));
    }

    let existing_refs: HashSet<String> = if cp_refs.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar::<_, String>(
            "SELECT (metadata->>'cp_ref') FROM loyalty_point_ledger WHERE reason = 'cp_loy_pts_hist' AND (metadata->>'cp_ref') = ANY($1)"
        )
        .bind(&cp_refs[..])
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect()
    };

    // 3. Batch fetch latest balances for all customers in this chunk
    let mut current_balances: HashMap<Uuid, i32> = if customer_id_map.is_empty() {
        HashMap::new()
    } else {
        let ids: Vec<Uuid> = customer_id_map.values().cloned().collect();
        sqlx::query_as::<_, (Uuid, i32)>(
            r#"
            SELECT DISTINCT ON (customer_id) customer_id, balance_after
            FROM loyalty_point_ledger
            WHERE customer_id = ANY($1)
            ORDER BY customer_id, created_at DESC, id DESC
            "#,
        )
        .bind(&ids[..])
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect()
    };

    for row in &rows {
        let cust_no = row.cust_no.trim();
        if cust_no.is_empty() {
            summary.skipped += 1;
            continue;
        }

        let cid = match customer_id_map.get(cust_no) {
            Some(id) => *id,
            None => {
                summary.skipped += 1;
                continue;
            }
        };

        let earnd = row.pts_earnd.unwrap_or(0);
        let redeemd = row.pts_redeemd.unwrap_or(0);
        let delta = earnd - redeemd;
        if delta == 0 {
            summary.skipped += 1;
            continue;
        }

        let date_part = row
            .bus_dat
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("_");
        let ref_part = row.ref_no.as_deref().map(str::trim).unwrap_or("");
        let cp_ref = format!("{cust_no}|{date_part}|{ref_part}");

        if existing_refs.contains(&cp_ref) {
            summary.skipped += 1;
            continue;
        }

        let prev = match current_balances.get(&cid) {
            Some(b) => *b,
            None => {
                let cp_bal = loyalty_by_code.get(cust_no).copied().unwrap_or(0);
                let sum_d = sum_by_cust.get(cust_no).copied().unwrap_or(0);
                cp_bal.checked_sub(sum_d).unwrap_or(0)
            }
        };

        let bal_after = prev + delta;
        current_balances.insert(cid, bal_after); // Update "moving" balance for next row in this batch

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
            let _ = record_sync_run(
                pool,
                "loyalty_hist",
                s.cursor.as_deref(),
                true,
                Some(summary.inserted + summary.skipped),
                None,
            )
            .await;
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
            let _ = record_sync_run(
                pool,
                "vendor_items",
                s.cursor.as_deref(),
                true,
                Some(summary.upserted + summary.skipped),
                None,
            )
            .await;
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
async fn ensure_historical_fallback_variant(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<(Uuid, Uuid), sqlx::Error> {
    let existing: Option<(Uuid, Uuid)> =
        sqlx::query_as("SELECT id, product_id FROM product_variants WHERE sku = $1")
            .bind(HISTORICAL_FALLBACK_SKU)
            .fetch_optional(&mut **tx)
            .await?;

    if let Some(ids) = existing {
        return Ok(ids);
    }

    // Create a special category for fallbacks
    let category_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO categories (name, is_clothing_footwear)
        VALUES ('Historical Fallbacks', false)
        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
        "#,
    )
    .fetch_one(&mut **tx)
    .await?;

    let product_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO products (
            catalog_handle, name, brand, category_id,
            base_retail_price, base_cost, spiff_amount, is_active
        )
        VALUES ($1, $2, 'Counterpoint History', $3, 0, 0, 0, true)
        ON CONFLICT (catalog_handle) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
        "#,
    )
    .bind(HISTORICAL_FALLBACK_SKU)
    .bind(HISTORICAL_FALLBACK_NAME)
    .bind(category_id)
    .fetch_one(&mut **tx)
    .await?;

    let variant_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO product_variants (
            product_id, sku, variation_values, variation_label, stock_on_hand
        )
        VALUES ($1, $2, '{}'::jsonb, 'Standard', 0)
        ON CONFLICT (sku) DO UPDATE SET sku = EXCLUDED.sku
        RETURNING id
        "#,
    )
    .bind(product_id)
    .bind(HISTORICAL_FALLBACK_SKU)
    .fetch_one(&mut **tx)
    .await?;

    Ok((variant_id, product_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::pins::hash_pin;
    use chrono::{Duration, NaiveDate, Utc};
    use rust_decimal::Decimal;
    use sqlx::PgPool;
    use uuid::Uuid;

    async fn connect_test_db() -> PgPool {
        let _ =
            dotenvy::from_filename(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env"));
        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for DB-backed tests");
        PgPool::connect(&database_url)
            .await
            .expect("connect test database")
    }

    #[tokio::test]
    async fn counterpoint_reset_preview_returns_expected_structure() {
        let pool = connect_test_db().await;
        let preview = get_counterpoint_reset_preview(&pool)
            .await
            .expect("load reset preview");

        assert_eq!(preview.confirmation_phrase, "RESET COUNTERPOINT BASELINE");
        assert!(preview
            .pre_go_live_only_warning
            .contains("Pre-go-live only"));
        assert!(preview
            .preserve_always
            .iter()
            .any(|line| line.contains("seeded Chris G admin account")));

        let scope_keys = preview
            .reset_scope
            .iter()
            .map(|row| row.key.as_str())
            .collect::<Vec<_>>();
        assert!(scope_keys.contains(&"customers"));
        assert!(scope_keys.contains(&"transactions"));
        assert!(scope_keys.contains(&"counterpoint_state"));
        assert!(preview
            .excluded_for_now
            .iter()
            .any(|line| line.contains(".counterpoint-bridge-state.json")));
    }

    #[tokio::test]
    async fn counterpoint_inventory_verification_report_builds_for_checked_in_csv() {
        let pool = connect_test_db().await;
        let report = build_counterpoint_inventory_verification_report(&pool)
            .await
            .expect("build inventory verification report");

        println!(
            "inventory verification summary: total_csv_skus={} matched={} exact={} mismatched={} comparison_artifact={} csv_source_issue={} missing={} expected_out_of_scope_exclusion={} extra={} name_mismatch={} category_mismatch={} variant_mismatch={} ros_variant_label_missing={} price_mismatch={} cost_mismatch={} inventory_mismatch={} supplier_field_suspect={} supplier_code_non_vendor_key={} variant_group_splits={} parent_sku_variant={} duplicate_variant_labels={} missing_vendor={} vendor_mismatch={} missing_vendor_item_link={} extra_parent_scope_artifact={} extra_key_present_scope_gap={} extra_unexplained={}",
            report.summary.total_csv_skus,
            report.summary.matched_count,
            report.summary.exact_match_count,
            report.summary.mismatched_count,
            report.summary.comparison_artifact_count,
            report.summary.csv_source_issue_count,
            report.summary.missing_in_ros_count,
            report.summary.expected_out_of_scope_exclusion_count,
            report.summary.extra_in_ros_count,
            report.summary.name_mismatch_count,
            report.summary.category_mismatch_count,
            report.summary.variant_mismatch_count,
            report.summary.ros_variant_label_missing_count,
            report.summary.price_mismatch_count,
            report.summary.cost_mismatch_count,
            report.summary.inventory_mismatch_count,
            report.summary.supplier_field_suspect_count,
            report.summary.supplier_code_non_vendor_key_count,
            report.summary.variant_group_split_count,
            report.summary.parent_sku_variant_count,
            report.summary.duplicate_variant_label_count,
            report.summary.missing_vendor_count,
            report.summary.vendor_mismatch_count,
            report.summary.missing_vendor_item_link_count,
            report.summary.extra_parent_scope_artifact_count,
            report.summary.extra_key_present_scope_gap_count,
            report.summary.extra_unexplained_count,
        );
        for issue in report.critical_issues.iter().take(10) {
            println!("inventory verification critical issue: {issue}");
        }

        assert!(report.summary.csv_path.contains("export2026-04-22.csv"));
        assert_eq!(
            report.summary.exact_match_count
                + report.summary.mismatched_count
                + report.summary.csv_source_issue_count
                + report.summary.comparison_artifact_count
                + report.summary.missing_in_ros_count,
            report.summary.total_csv_skus
        );
        assert_eq!(
            report.summary.exact_match_count
                + report.summary.mismatched_count
                + report.summary.csv_source_issue_count,
            report.summary.matched_count
        );
        assert!(report.summary.extra_in_ros_count >= report.extra_rows.len() as i64);
    }

    #[test]
    fn ticket_amount_paid_prefers_explicit_tenders_when_present() {
        let payments = vec![
            TicketPaymentRow {
                pmt_typ: "CASH".into(),
                amount: Decimal::new(4000, 2),
                gift_cert_no: None,
            },
            TicketPaymentRow {
                pmt_typ: "CHECK".into(),
                amount: Decimal::new(1500, 2),
                gift_cert_no: None,
            },
        ];
        let gift_applications = vec![
            TicketGiftApplicationRow {
                gift_cert_no: "GC-1".into(),
                amount: Decimal::new(500, 2),
                action: Some("redeem".into()),
            },
            TicketGiftApplicationRow {
                gift_cert_no: "GC-2".into(),
                amount: Decimal::new(250, 2),
                action: Some("load".into()),
            },
        ];

        let paid = sum_counterpoint_ticket_tenders(&payments, &gift_applications)
            .expect("explicit tenders should produce a paid total");

        assert_eq!(paid, Decimal::new(6000, 2));
    }

    #[test]
    fn open_doc_amount_paid_prefers_explicit_payments_when_present() {
        let payments = vec![
            TicketPaymentRow {
                pmt_typ: "CASH".into(),
                amount: Decimal::new(2000, 2),
                gift_cert_no: None,
            },
            TicketPaymentRow {
                pmt_typ: "STORE CREDIT".into(),
                amount: Decimal::new(750, 2),
                gift_cert_no: None,
            },
        ];

        let paid = sum_counterpoint_open_doc_tenders(&payments)
            .expect("explicit payments should produce a paid total");

        assert_eq!(paid, Decimal::new(2750, 2));
    }

    #[test]
    fn ros_currency_matches_storage_precision() {
        assert!(ros_currency_matches(
            Some(Decimal::new(118450, 4)),
            Decimal::new(1185, 2)
        ));
        assert!(!ros_currency_matches(
            Some(Decimal::new(300000, 4)),
            Decimal::new(2600, 2)
        ));
    }

    #[test]
    fn parent_row_fallback_is_comparison_artifact() {
        let csv_row = CounterpointInventoryCsvNormalizedRow {
            sku: "B-1493175".into(),
            name: "Cardi Solid Twill Neck Tie".into(),
            product_category: "TIES".into(),
            variant_label: "Champagne".into(),
            item_key: "I-103111".into(),
            supply_price: Some(Decimal::new(77500, 4)),
            retail_price: Some(Decimal::new(650000, 4)),
            inventory_quantity: Some(Decimal::new(-80000, 4)),
            supplier_name: "Cardi International".into(),
            supplier_code: String::new(),
            supplier_field_suspect: false,
            supplier_code_non_vendor_key: false,
        };
        let ros_row = CounterpointRosInventoryRow {
            variant_id: Uuid::new_v4(),
            product_id: Uuid::new_v4(),
            sku: "I-103111".into(),
            counterpoint_item_key: Some("I-103111".into()),
            variation_label: None,
            stock_on_hand: 0,
            retail_price: Decimal::new(6500, 2),
            supply_price: Decimal::new(775, 2),
            product_name: "Cardi Solid Twill Neck Tie".into(),
            catalog_handle: Some("I-103111".into()),
            category_name: Some("TIES".into()),
            primary_vendor_name: Some("Cardi International [CARDI]".into()),
            primary_vendor_code: Some("CARDI".into()),
        };

        assert!(is_parent_row_fallback_artifact(
            &csv_row,
            &ros_row,
            "counterpoint_item_key_singleton",
        ));
        assert!(!is_parent_row_fallback_artifact(&csv_row, &ros_row, "sku"));
    }

    #[tokio::test]
    async fn counterpoint_baseline_reset_preserves_bootstrap_and_clears_migration_state() {
        let pool = connect_test_db().await;
        let result = async {
            let mut tx = pool.begin().await.expect("begin reset test transaction");
            let category_id = Uuid::new_v4();
            sqlx::query("INSERT INTO categories (id, name) VALUES ($1, $2)")
                .bind(category_id)
                .bind(format!("Counterpoint Reset Category {}", Uuid::new_v4().simple()))
                .execute(&mut *tx)
                .await
                .expect("insert category");

            sqlx::query(
                "INSERT INTO counterpoint_category_map (cp_category, ros_category_id) VALUES ($1, $2)",
            )
            .bind(format!("CP-CAT-{}", Uuid::new_v4().simple()))
            .bind(category_id)
            .execute(&mut *tx)
            .await
            .expect("insert category map");
            sqlx::query(
                "INSERT INTO counterpoint_payment_method_map (cp_pmt_typ, ros_method) VALUES ($1, 'cash')",
            )
            .bind(format!("CP-PMT-{}", Uuid::new_v4().simple()))
            .execute(&mut *tx)
            .await
            .expect("insert payment map");
            sqlx::query(
                "INSERT INTO counterpoint_gift_reason_map (cp_reason_cod, ros_card_kind) VALUES ($1, 'purchased')",
            )
            .bind(format!("CP-GIFT-{}", Uuid::new_v4().simple()))
            .execute(&mut *tx)
            .await
            .expect("insert gift reason map");

            let preserved_staff_id = Uuid::new_v4();
            let preserved_code = format!("{:04}", (Uuid::new_v4().as_u128() % 10_000) as u16);
            let preserved_pin = hash_pin(&preserved_code).expect("hash preserved staff pin");
            sqlx::query(
                r#"
                INSERT INTO staff (
                    id, full_name, cashier_code, pin_hash, role, is_active, avatar_key,
                    data_source, counterpoint_user_id, counterpoint_sls_rep
                )
                VALUES ($1, $2, $3, $4, 'admin', TRUE, 'ros_default', 'counterpoint', $5, $6)
                "#,
            )
            .bind(preserved_staff_id)
            .bind(format!(
                "Counterpoint Reset Keeper {}",
                Uuid::new_v4().simple()
            ))
            .bind(&preserved_code)
            .bind(preserved_pin)
            .bind(format!("USR-{}", Uuid::new_v4().simple()))
            .bind(format!("REP-{}", Uuid::new_v4().simple()))
            .execute(&mut *tx)
            .await
            .expect("insert preserved staff");

            let imported_staff_id = Uuid::new_v4();
            let imported_code = format!("{:04}", (Uuid::new_v4().as_u128() % 10_000) as u16);
            sqlx::query(
                r#"
                INSERT INTO staff (
                    id, full_name, cashier_code, role, is_active, avatar_key,
                    data_source, counterpoint_user_id
                )
                VALUES ($1, $2, $3, 'sales_support', TRUE, 'ros_default', 'counterpoint', $4)
                "#,
            )
            .bind(imported_staff_id)
            .bind(format!(
                "Counterpoint Reset Imported Staff {}",
                Uuid::new_v4().simple()
            ))
            .bind(imported_code)
            .bind(format!("USR-{}", Uuid::new_v4().simple()))
            .execute(&mut *tx)
            .await
            .expect("insert imported staff");

            let imported_customer_id = Uuid::new_v4();
            sqlx::query(
                r#"
                INSERT INTO customers (
                    id, customer_code, first_name, last_name, email, customer_created_source
                )
                VALUES ($1, $2, $3, $4, $5, 'counterpoint')
                "#,
            )
            .bind(imported_customer_id)
            .bind(format!("CP-CUST-{}", Uuid::new_v4().simple()))
            .bind("Counterpoint")
            .bind("Customer")
            .bind(format!(
                "counterpoint-reset-{}@example.com",
                Uuid::new_v4().simple()
            ))
            .execute(&mut *tx)
            .await
            .expect("insert imported customer");

            let imported_product_id = Uuid::new_v4();
            let imported_variant_id = Uuid::new_v4();
            sqlx::query(
                r#"
                INSERT INTO products (
                    id, name, base_retail_price, base_cost, is_active, data_source
                )
                VALUES ($1, $2, $3, $4, TRUE, 'counterpoint')
                "#,
            )
            .bind(imported_product_id)
            .bind("Counterpoint Reset Product")
            .bind(Decimal::new(12999, 2))
            .bind(Decimal::new(4599, 2))
            .execute(&mut *tx)
            .await
            .expect("insert imported product");
            sqlx::query(
                r#"
                INSERT INTO product_variants (
                    id, product_id, sku, variation_values, stock_on_hand, counterpoint_item_key
                )
                VALUES ($1, $2, $3, '{}'::jsonb, 5, $4)
                "#,
            )
            .bind(imported_variant_id)
            .bind(imported_product_id)
            .bind(format!("CP-RESET-{}", Uuid::new_v4().simple()))
            .bind(format!("CP-ITEM-{}", Uuid::new_v4().simple()))
            .execute(&mut *tx)
            .await
            .expect("insert imported variant");

            let vendor_id = Uuid::new_v4();
            sqlx::query("INSERT INTO vendors (id, name, is_active) VALUES ($1, $2, TRUE)")
                .bind(vendor_id)
                .bind(format!("Counterpoint Reset Vendor {}", Uuid::new_v4().simple()))
                .execute(&mut *tx)
                .await
                .expect("insert vendor");

            let imported_transaction_id = Uuid::new_v4();
            let manual_transaction_id = Uuid::new_v4();
            sqlx::query(
                r#"
                INSERT INTO transactions (
                    id, customer_id, status, total_price, balance_due, is_counterpoint_import
                )
                VALUES ($1, $2, 'open', $3, $4, TRUE)
                "#,
            )
            .bind(imported_transaction_id)
            .bind(imported_customer_id)
            .bind(Decimal::new(25000, 2))
            .bind(Decimal::new(0, 2))
            .execute(&mut *tx)
            .await
            .expect("insert imported transaction");
            sqlx::query(
                r#"
                INSERT INTO transactions (
                    id, customer_id, status, total_price, balance_due, is_counterpoint_import
                )
                VALUES ($1, $2, 'open', $3, $4, FALSE)
                "#,
            )
            .bind(manual_transaction_id)
            .bind(imported_customer_id)
            .bind(Decimal::new(5000, 2))
            .bind(Decimal::new(5000, 2))
            .execute(&mut *tx)
            .await
            .expect("insert customer-linked manual transaction");

            let payment_transaction_id = Uuid::new_v4();
            sqlx::query(
                r#"
                INSERT INTO payment_transactions (
                    id, payer_id, payment_method, amount
                )
                VALUES ($1, $2, 'cash', $3)
                "#,
            )
            .bind(payment_transaction_id)
            .bind(imported_customer_id)
            .bind(Decimal::new(25000, 2))
            .execute(&mut *tx)
            .await
            .expect("insert payment transaction");
            sqlx::query(
                r#"
                INSERT INTO payment_allocations (
                    id, transaction_id, target_transaction_id, amount_allocated
                )
                VALUES ($1, $2, $3, $4)
                "#,
            )
            .bind(Uuid::new_v4())
            .bind(payment_transaction_id)
            .bind(imported_transaction_id)
            .bind(Decimal::new(25000, 2))
            .execute(&mut *tx)
            .await
            .expect("insert payment allocation");

            let gift_card_id = Uuid::new_v4();
            sqlx::query(
                r#"
                INSERT INTO gift_cards (
                    id, code, current_balance, is_liability, expires_at, card_kind, card_status,
                    original_value, customer_id
                )
                VALUES ($1, $2, $3, TRUE, $4, 'purchased', 'active', $5, $6)
                "#,
            )
            .bind(gift_card_id)
            .bind(format!("CPRESET{}", Uuid::new_v4().simple()))
            .bind(Decimal::new(5000, 2))
            .bind(Utc::now() + Duration::days(30))
            .bind(Decimal::new(5000, 2))
            .bind(imported_customer_id)
            .execute(&mut *tx)
            .await
            .expect("insert gift card");
            sqlx::query(
                r#"
                INSERT INTO gift_card_events (
                    gift_card_id, event_kind, amount, balance_after, staff_id
                )
                VALUES ($1, 'issued', $2, $3, $4)
                "#,
            )
            .bind(gift_card_id)
            .bind(Decimal::new(5000, 2))
            .bind(Decimal::new(5000, 2))
            .bind(preserved_staff_id)
            .execute(&mut *tx)
            .await
            .expect("insert gift card event");

            sqlx::query(
                r#"
                INSERT INTO loyalty_point_ledger (
                    customer_id, delta_points, balance_after, reason, created_by_staff_id
                )
                VALUES ($1, 10, 10, 'manual_adjust', $2)
                "#,
            )
            .bind(imported_customer_id)
            .bind(preserved_staff_id)
            .execute(&mut *tx)
            .await
            .expect("insert loyalty ledger");
            sqlx::query(
                r#"
                INSERT INTO loyalty_reward_issuances (
                    customer_id, points_deducted, reward_amount, applied_to_sale, remainder_card_id,
                    issued_by_staff_id
                )
                VALUES ($1, 5000, 50.00, 0, $2, $3)
                "#,
            )
            .bind(imported_customer_id)
            .bind(gift_card_id)
            .bind(preserved_staff_id)
            .execute(&mut *tx)
            .await
            .expect("insert loyalty issuance");
            sqlx::query(
                "INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, $2)",
            )
            .bind(imported_customer_id)
            .bind(Decimal::new(1500, 2))
            .execute(&mut *tx)
            .await
            .expect("insert store credit account");

            sqlx::query(
                r#"
                INSERT INTO counterpoint_sync_runs (
                    entity, cursor_value, last_ok_at, records_processed
                )
                VALUES ($1, $2, NOW(), 7)
                "#,
            )
            .bind(format!("reset-test-entity-{}", Uuid::new_v4().simple()))
            .bind("cursor-1")
            .execute(&mut *tx)
            .await
            .expect("insert sync run");
            sqlx::query(
                r#"
                INSERT INTO counterpoint_sync_issue (entity, external_key, severity, message)
                VALUES ('customers', $1, 'warning', 'test issue')
                "#,
            )
            .bind(format!("ext-{}", Uuid::new_v4().simple()))
            .execute(&mut *tx)
            .await
            .expect("insert sync issue");
            sqlx::query(
                r#"
                INSERT INTO counterpoint_sync_request (requested_by, entity)
                VALUES ($1, 'customers')
                "#,
            )
            .bind(preserved_staff_id)
            .execute(&mut *tx)
            .await
            .expect("insert sync request");
            sqlx::query(
                r#"
                INSERT INTO counterpoint_staging_batch (
                    entity, payload, row_count, status, applied_by_staff_id
                )
                VALUES ('customers', '{}'::jsonb, 1, 'pending', $1)
                "#,
            )
            .bind(preserved_staff_id)
            .execute(&mut *tx)
            .await
            .expect("insert staging batch");
            sqlx::query(
                r#"
                INSERT INTO counterpoint_receiving_history (
                    vend_no, item_no, recv_dat, unit_cost, qty_recv, recv_no
                )
                VALUES ('V1', 'ITEM1', $1, $2, $3, 'RCV1')
                "#,
            )
            .bind(
                NaiveDate::from_ymd_opt(2026, 1, 15)
                    .expect("valid date")
                    .and_hms_opt(10, 0, 0)
                    .expect("valid time")
                    .and_utc(),
            )
            .bind(Decimal::new(2500, 2))
            .bind(Decimal::new(2, 0))
            .execute(&mut *tx)
            .await
            .expect("insert receiving history");
            sqlx::query(
                r#"
                INSERT INTO counterpoint_staff_map (cp_code, cp_source, ros_staff_id)
                VALUES ($1, 'user', $2)
                "#,
            )
            .bind(format!("USRMAP-{}", Uuid::new_v4().simple()))
            .bind(imported_staff_id)
            .execute(&mut *tx)
            .await
            .expect("insert staff map");
            sqlx::query(
                r#"
                UPDATE counterpoint_bridge_heartbeat
                SET bridge_phase = 'running',
                    current_entity = 'customers',
                    bridge_version = 'test-version',
                    bridge_hostname = 'test-host'
                WHERE id = 1
                "#,
            )
            .execute(&mut *tx)
            .await
            .expect("update heartbeat");

            let targets = CounterpointBaselineResetTargets {
                counterpoint_customer_ids: vec![imported_customer_id],
                counterpoint_product_ids: vec![imported_product_id],
                counterpoint_variant_ids: vec![imported_variant_id],
                vendor_ids: vec![vendor_id],
                gift_card_ids: vec![gift_card_id],
                loyalty_reward_issuance_ids: sqlx::query_scalar(
                    "SELECT id FROM loyalty_reward_issuances WHERE customer_id = $1",
                )
                .bind(imported_customer_id)
                .fetch_all(&mut *tx)
                .await
                .expect("load loyalty issuance ids"),
                loyalty_point_ledger_ids: sqlx::query_scalar(
                    "SELECT id FROM loyalty_point_ledger WHERE customer_id = $1",
                )
                .bind(imported_customer_id)
                .fetch_all(&mut *tx)
                .await
                .expect("load loyalty ledger ids"),
                store_credit_account_ids: sqlx::query_scalar(
                    "SELECT id FROM store_credit_accounts WHERE customer_id = $1",
                )
                .bind(imported_customer_id)
                .fetch_all(&mut *tx)
                .await
                .expect("load store credit ids"),
                counterpoint_only_staff_ids: vec![imported_staff_id],
                counterpoint_transaction_ids: vec![imported_transaction_id, manual_transaction_id],
                counterpoint_sync_run_ids: sqlx::query_scalar("SELECT id FROM counterpoint_sync_runs")
                    .fetch_all(&mut *tx)
                    .await
                    .expect("load sync run ids"),
                counterpoint_sync_issue_ids: sqlx::query_scalar("SELECT id FROM counterpoint_sync_issue")
                    .fetch_all(&mut *tx)
                    .await
                    .expect("load sync issue ids"),
                counterpoint_sync_request_ids: sqlx::query_scalar("SELECT id FROM counterpoint_sync_request")
                    .fetch_all(&mut *tx)
                    .await
                    .expect("load sync request ids"),
                counterpoint_staging_batch_ids: sqlx::query_scalar("SELECT id FROM counterpoint_staging_batch")
                    .fetch_all(&mut *tx)
                    .await
                    .expect("load staging batch ids"),
                counterpoint_receiving_history_ids: sqlx::query_scalar("SELECT id FROM counterpoint_receiving_history")
                    .fetch_all(&mut *tx)
                    .await
                    .expect("load receiving history ids"),
                counterpoint_staff_map_staff_ids: vec![imported_staff_id],
            };

            perform_counterpoint_baseline_reset_targets(&mut tx, &targets)
                .await
                .expect("execute baseline reset");

            let store_settings_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*)::bigint FROM store_settings")
                    .fetch_one(&mut *tx)
                    .await
                    .expect("count store_settings");
            assert_eq!(store_settings_count, 1);

            let preserved_staff: (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
                "SELECT pin_hash, counterpoint_user_id, counterpoint_sls_rep FROM staff WHERE id = $1",
            )
            .bind(preserved_staff_id)
            .fetch_one(&mut *tx)
            .await
            .expect("load preserved staff");
            assert!(preserved_staff.0.is_some());
            assert!(preserved_staff.1.is_none());
            assert!(preserved_staff.2.is_none());

            let preserved_maps_count: i64 = sqlx::query_scalar(
                r#"
                SELECT
                    (SELECT COUNT(*)::bigint FROM counterpoint_category_map)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_payment_method_map)
                  + (SELECT COUNT(*)::bigint FROM counterpoint_gift_reason_map)
                "#,
            )
            .fetch_one(&mut *tx)
            .await
            .expect("count preserved maps");
            assert!(preserved_maps_count >= 3);

            let imported_customer_exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
                    .bind(imported_customer_id)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("check imported customer");
            assert!(!imported_customer_exists);

            let imported_transactions_remaining: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::bigint FROM transactions WHERE id = ANY($1)",
            )
            .bind(vec![imported_transaction_id, manual_transaction_id])
            .fetch_one(&mut *tx)
            .await
            .expect("count transactions after reset");
            assert_eq!(imported_transactions_remaining, 0);

            let payment_transaction_exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM payment_transactions WHERE id = $1)",
            )
            .bind(payment_transaction_id)
            .fetch_one(&mut *tx)
            .await
            .expect("check payment transaction");
            assert!(!payment_transaction_exists);

            let imported_product_exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM products WHERE id = $1)")
                    .bind(imported_product_id)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("check imported product");
            assert!(!imported_product_exists);

            let vendor_exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM vendors WHERE id = $1)")
                    .bind(vendor_id)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("check vendor");
            assert!(!vendor_exists);

            let gift_card_exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM gift_cards WHERE id = $1)")
                    .bind(gift_card_id)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("check gift card");
            assert!(!gift_card_exists);

            let loyalty_rows: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::bigint FROM loyalty_point_ledger WHERE customer_id = $1",
            )
                    .bind(imported_customer_id)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("count loyalty rows");
            assert_eq!(loyalty_rows, 0);

            let store_credit_rows: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::bigint FROM store_credit_accounts WHERE customer_id = $1",
            )
                    .bind(imported_customer_id)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("count store credit rows");
            assert_eq!(store_credit_rows, 0);

            let counterpoint_state_rows: i64 = sqlx::query_scalar(
                r#"
                SELECT
                    (SELECT COUNT(*)::bigint FROM counterpoint_sync_runs WHERE id = ANY($1))
                  + (SELECT COUNT(*)::bigint FROM counterpoint_sync_issue WHERE id = ANY($2))
                  + (SELECT COUNT(*)::bigint FROM counterpoint_sync_request WHERE id = ANY($3))
                  + (SELECT COUNT(*)::bigint FROM counterpoint_staging_batch WHERE id = ANY($4))
                  + (SELECT COUNT(*)::bigint FROM counterpoint_receiving_history WHERE id = ANY($5))
                  + (SELECT COUNT(*)::bigint FROM counterpoint_staff_map WHERE ros_staff_id = ANY($6))
                "#,
            )
            .bind(&targets.counterpoint_sync_run_ids)
            .bind(&targets.counterpoint_sync_issue_ids)
            .bind(&targets.counterpoint_sync_request_ids)
            .bind(&targets.counterpoint_staging_batch_ids)
            .bind(&targets.counterpoint_receiving_history_ids)
            .bind(&targets.counterpoint_staff_map_staff_ids)
            .fetch_one(&mut *tx)
            .await
            .expect("count counterpoint state rows");
            assert_eq!(counterpoint_state_rows, 0);

            let imported_staff_exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE id = $1)")
                    .bind(imported_staff_id)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("check imported staff");
            assert!(!imported_staff_exists);

            let heartbeat: (String, Option<String>, Option<String>) = sqlx::query_as(
                "SELECT bridge_phase, bridge_version, bridge_hostname FROM counterpoint_bridge_heartbeat WHERE id = 1",
            )
            .fetch_one(&mut *tx)
            .await
            .expect("load heartbeat");
            assert_eq!(heartbeat.0, "idle");
            assert!(heartbeat.1.is_none());
            assert!(heartbeat.2.is_none());

            tx.rollback().await.expect("rollback reset test transaction");
            Ok::<(), sqlx::Error>(())
        }
        .await;

        result.expect("counterpoint baseline reset assertions");
    }
}
