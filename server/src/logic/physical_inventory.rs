#![allow(clippy::items_after_test_module)]

//! Physical Inventory business logic: session management, stock snapshots, review calculation, and publish.

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct PhysicalInventorySession {
    pub id: Uuid,
    pub session_number: String,
    pub status: String,
    pub scope: String,
    pub category_ids: Vec<Uuid>,
    pub baseline_type: String,
    pub started_at: DateTime<Utc>,
    pub last_saved_at: DateTime<Utc>,
    pub published_at: Option<DateTime<Utc>>,
    pub notes: Option<String>,
    pub exclude_reserved: bool,
    pub exclude_layaway: bool,
}

#[derive(Debug, Serialize)]
pub struct SessionSummary {
    pub session: PhysicalInventorySession,
    pub total_counted: i64,
    pub total_variants_in_scope: i64,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CountRow {
    pub id: Uuid,
    pub session_id: Uuid,
    pub variant_id: Uuid,
    pub sku: String,
    pub product_name: String,
    pub variation_label: Option<String>,
    pub counted_qty: i32,
    pub adjusted_qty: Option<i32>,
    pub review_status: String,
    pub review_note: Option<String>,
    pub last_scanned_at: DateTime<Utc>,
    pub scan_source: String,
}

/// Row returned during the Review phase: all data needed to present the reconciliation view.
#[derive(Debug, Serialize)]
pub struct ReviewRow {
    pub count_id: Uuid,
    pub variant_id: Uuid,
    pub sku: String,
    pub product_name: String,
    pub variation_label: Option<String>,
    pub stock_at_start: i32,
    pub counted_qty: i32,
    pub adjusted_qty: Option<i32>,
    /// effective_qty is adjusted_qty if set, else counted_qty
    pub effective_qty: i32,
    /// Units sold after session started_at for this variant
    pub sales_since_start: i32,
    /// Units sold after the most recent count/correction timestamp for this variant
    pub sales_after_count: i32,
    /// Final stock = max(0, effective_qty - sales_after_count)
    pub final_stock: i32,
    /// Delta to apply to live stock at publish time
    pub delta: i32,
    pub unit_cost: Decimal,
    pub accounting_impact: Decimal,
    pub review_status: String,
    pub review_note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    pub scope: String,
    pub baseline_type: Option<String>,
    pub category_ids: Option<Vec<Uuid>>,
    pub notes: Option<String>,
    pub exclude_reserved: Option<bool>,
    pub exclude_layaway: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct AddCountRequest {
    pub variant_id: Uuid,
    pub quantity: i32,
    pub source: String,
    pub staff_id: Option<Uuid>,
    pub client_scan_id: Option<Uuid>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct DiscoveredItem {
    pub id: Uuid,
    pub session_id: Uuid,
    pub scanned_code: String,
    pub scan_source: String,
    pub first_scanned_by: Option<Uuid>,
    pub last_scanned_by: Option<Uuid>,
    pub first_scanned_at: DateTime<Utc>,
    pub last_scanned_at: DateTime<Utc>,
    pub scan_count: i32,
    pub status: String,
    pub resolved_variant_id: Option<Uuid>,
    pub resolved_sku: Option<String>,
    pub resolved_product_name: Option<String>,
    pub resolution_note: Option<String>,
    pub resolved_by: Option<Uuid>,
    pub resolved_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct RecordDiscoveredItemRequest {
    pub scanned_code: String,
    pub source: String,
}

#[derive(Debug, Deserialize)]
pub struct ResolveDiscoveredItemRequest {
    pub status: String,
    pub resolved_variant_id: Option<Uuid>,
    pub resolution_note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PhysicalInventoryReport {
    pub session: PhysicalInventorySession,
    pub approvals: Vec<serde_json::Value>,
    pub variance_rows: Vec<serde_json::Value>,
    pub scan_rows: Vec<serde_json::Value>,
    pub discovered_rows: Vec<serde_json::Value>,
    pub accounting_rows: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct PublishResult {
    pub variants_reconciled: i64,
    pub total_shrinkage: i32,
    pub total_surplus: i32,
    pub accounting_impact: Decimal,
}

/// Ensure every in-scope snapshot variant has a review/count row before review or publish.
/// Uncounted in-scope variants are materialized with counted_qty = 0 so they are visible
/// during reconciliation instead of being silently skipped.
pub async fn materialize_review_scope_rows(pool: &PgPool, session_id: Uuid) -> Result<i64> {
    let mut tx = pool.begin().await?;
    let inserted = materialize_review_scope_rows_tx(&mut tx, session_id).await?;
    tx.commit().await?;

    Ok(inserted)
}

async fn materialize_review_scope_rows_tx(
    tx: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
) -> Result<i64> {
    let inserted = sqlx::query(
        r#"
        INSERT INTO physical_inventory_counts (session_id, variant_id, counted_qty, scan_source)
        SELECT pis.session_id, pis.variant_id, 0, 'manual'
        FROM physical_inventory_snapshots pis
        LEFT JOIN physical_inventory_counts pic
          ON pic.session_id = pis.session_id
         AND pic.variant_id = pis.variant_id
        WHERE pis.session_id = $1
          AND pic.id IS NULL
        ON CONFLICT (session_id, variant_id) DO NOTHING
    "#,
    )
    .bind(session_id)
    .execute(&mut **tx)
    .await
    .context("Failed to materialize review scope rows")?
    .rows_affected() as i64;

    Ok(inserted)
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/// Returns the current active (open or reviewing) session, if any.
pub async fn get_active_session(pool: &PgPool) -> Result<Option<PhysicalInventorySession>> {
    let session = sqlx::query_as::<_, PhysicalInventorySession>(
        r#"
        SELECT id, session_number, status, scope, category_ids,
               baseline_type, started_at, last_saved_at, published_at, notes,
               exclude_reserved, exclude_layaway
        FROM physical_inventory_sessions
        WHERE status IN ('open', 'reviewing')
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await
    .context("Failed to query active session")?;
    Ok(session)
}

pub async fn get_session_by_id(
    pool: &PgPool,
    session_id: Uuid,
) -> Result<PhysicalInventorySession> {
    sqlx::query_as::<_, PhysicalInventorySession>(
        r#"
        SELECT id, session_number, status, scope, category_ids,
               baseline_type, started_at, last_saved_at, published_at, notes,
               exclude_reserved, exclude_layaway
        FROM physical_inventory_sessions
        WHERE id = $1
        "#,
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| anyhow!("Session not found"))
}

/// Generates the next session number: INV-YYYY-NNN
async fn next_session_number(pool: &PgPool) -> Result<String> {
    let year = chrono::Utc::now().format("%Y").to_string();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM physical_inventory_sessions WHERE session_number LIKE $1",
    )
    .bind(format!("INV-{year}-%"))
    .fetch_one(pool)
    .await
    .context("Failed to count sessions")?;
    Ok(format!("INV-{year}-{:03}", count + 1))
}

fn normalize_baseline_type(value: Option<String>) -> Result<String> {
    let baseline_type = value.unwrap_or_else(|| "normal".to_string());
    let normalized = baseline_type.trim().to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "normal" | "first_inventory" | "baseline_correction"
    ) {
        return Ok(normalized);
    }
    Err(anyhow!(
        "baseline_type must be 'normal', 'first_inventory', or 'baseline_correction'"
    ))
}

/// Creates a new session and snapshots current stock for all in-scope variants.
/// Returns an error if an active session already exists.
pub async fn create_session(
    pool: &PgPool,
    req: CreateSessionRequest,
    started_by: Option<Uuid>,
) -> Result<PhysicalInventorySession> {
    // Enforce single active session
    if let Some(active) = get_active_session(pool).await? {
        return Err(anyhow!(
            "An active inventory session already exists: {}. Close or publish it before starting a new one.",
            active.session_number
        ));
    }

    if req.scope != "full" && req.scope != "category" {
        return Err(anyhow!("scope must be 'full' or 'category'"));
    }
    let category_ids = req.category_ids.unwrap_or_default();
    if req.scope == "category" && category_ids.is_empty() {
        return Err(anyhow!("category_ids required when scope is 'category'"));
    }
    let baseline_type = normalize_baseline_type(req.baseline_type.clone())?;

    let session_number = next_session_number(pool).await?;

    let mut tx = pool.begin().await.context("Failed to begin transaction")?;

    // Insert session
    let session = sqlx::query_as::<_, PhysicalInventorySession>(
        r#"
        INSERT INTO physical_inventory_sessions
            (session_number, status, scope, category_ids, baseline_type, started_by, notes, exclude_reserved, exclude_layaway)
        VALUES ($1, 'open', $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, session_number, status, scope, category_ids,
                  baseline_type, started_at, last_saved_at, published_at, notes,
                  exclude_reserved, exclude_layaway
        "#,
    )
    .bind(&session_number)
    .bind(&req.scope)
    .bind(&category_ids)
    .bind(&baseline_type)
    .bind(started_by)
    .bind(req.notes.as_deref())
    .bind(req.exclude_reserved.unwrap_or(false))
    .bind(req.exclude_layaway.unwrap_or(false))
    .fetch_one(&mut *tx)
    .await
    .context("Failed to insert session")?;

    // Snapshot current stock for all in-scope variants
    snapshot_stock(
        &mut tx,
        session.id,
        &req.scope,
        &category_ids,
        session.exclude_reserved,
        session.exclude_layaway,
    )
    .await?;

    // Initial audit event
    sqlx::query(
        r#"
        INSERT INTO physical_inventory_audit (session_id, event_type, performed_by, note)
        VALUES ($1, 'session_open', $2, $3)
        "#,
    )
    .bind(session.id)
    .bind(started_by)
    .bind(format!(
        "Session {} started. Scope: {}, baseline_type: {}",
        session_number, req.scope, baseline_type
    ))
    .execute(&mut *tx)
    .await?;

    tx.commit()
        .await
        .context("Failed to commit session creation")?;
    Ok(session)
}

/// Snapshot all in-scope variants' stock_on_hand into physical_inventory_snapshots.
async fn snapshot_stock(
    tx: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    scope: &str,
    category_ids: &[Uuid],
    exclude_reserved: bool,
    exclude_layaway: bool,
) -> Result<()> {
    if scope == "category" && !category_ids.is_empty() {
        let stock_expr = "pv.stock_on_hand - (CASE WHEN $3 THEN pv.reserved_stock ELSE 0 END) - (CASE WHEN $4 THEN pv.on_layaway ELSE 0 END)";
        let sql = format!(
            r#"
            INSERT INTO physical_inventory_snapshots (session_id, variant_id, stock_at_start)
            SELECT $1, pv.id, ({stock_expr})
            FROM product_variants pv
            JOIN products p ON p.id = pv.product_id
            WHERE p.is_active = true
              AND p.pos_line_kind IS NULL
              AND p.category_id = ANY($2)
            ON CONFLICT (session_id, variant_id) DO NOTHING
            "#
        );
        sqlx::query(&sql)
            .bind(session_id)
            .bind(category_ids)
            .bind(exclude_reserved)
            .bind(exclude_layaway)
            .execute(&mut **tx)
            .await
            .context("Failed to snapshot scoped stock")?;
    } else {
        let stock_expr = "pv.stock_on_hand - (CASE WHEN $2 THEN pv.reserved_stock ELSE 0 END) - (CASE WHEN $3 THEN pv.on_layaway ELSE 0 END)";
        let sql = format!(
            r#"
            INSERT INTO physical_inventory_snapshots (session_id, variant_id, stock_at_start)
            SELECT $1, pv.id, ({stock_expr})
            FROM product_variants pv
            JOIN products p ON p.id = pv.product_id
            WHERE p.is_active = true
              AND p.pos_line_kind IS NULL
            ON CONFLICT (session_id, variant_id) DO NOTHING
            "#
        );
        sqlx::query(&sql)
            .bind(session_id)
            .bind(exclude_reserved)
            .bind(exclude_layaway)
            .execute(&mut **tx)
            .await
            .context("Failed to snapshot full stock")?;
    }
    Ok(())
}

/// Close session for the day (sets last_saved_at, stays open).
pub async fn save_session(pool: &PgPool, session_id: Uuid, staff_id: Option<Uuid>) -> Result<()> {
    sqlx::query(
        "UPDATE physical_inventory_sessions SET last_saved_at = NOW() WHERE id = $1 AND status = 'open'",
    )
    .bind(session_id)
    .execute(pool)
    .await?;

    sqlx::query(
        "INSERT INTO physical_inventory_audit (session_id, event_type, performed_by, note) VALUES ($1, 'session_close', $2, 'Session saved for the day')",
    )
    .bind(session_id)
    .bind(staff_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Move session from 'open' → 'reviewing'. No stock changes yet.
pub async fn move_to_review(pool: &PgPool, session_id: Uuid, staff_id: Option<Uuid>) -> Result<()> {
    let rows = sqlx::query(
        "UPDATE physical_inventory_sessions SET status = 'reviewing', last_saved_at = NOW() WHERE id = $1 AND status = 'open'",
    )
    .bind(session_id)
    .execute(pool)
    .await?;

    if rows.rows_affected() == 0 {
        return Err(anyhow!("Session not found or not in 'open' status"));
    }

    let _ = materialize_review_scope_rows(pool, session_id).await?;

    sqlx::query(
        "INSERT INTO physical_inventory_audit (session_id, event_type, performed_by, note) VALUES ($1, 'session_move_review', $2, 'Session moved to review phase')",
    )
    .bind(session_id)
    .bind(staff_id)
    .execute(pool)
    .await?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Counting
// ─────────────────────────────────────────────────────────────────────────────

/// Add or increment a count for a variant within a session.
/// Returns the new counted_qty.
pub async fn upsert_count(
    pool: &PgPool,
    session_id: Uuid,
    req: AddCountRequest,
    started_at: DateTime<Utc>,
) -> Result<i32> {
    let qty = req.quantity.max(0);
    let mut tx = pool.begin().await?;

    let stream_claimed = if qty > 0 {
        match (req.staff_id, req.client_scan_id) {
            (Some(staff_id), Some(client_scan_id)) => {
                let inserted: Option<Uuid> = sqlx::query_scalar(
                    r#"
                    INSERT INTO inventory_count_scan_stream
                        (session_id, staff_id, variant_id, quantity, device_id, client_scan_id)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (session_id, client_scan_id)
                    WHERE client_scan_id IS NOT NULL
                    DO NOTHING
                    RETURNING id
                    "#,
                )
                .bind(session_id)
                .bind(staff_id)
                .bind(req.variant_id)
                .bind(qty)
                .bind(&req.source)
                .bind(client_scan_id)
                .fetch_optional(&mut *tx)
                .await
                .context("Failed to claim physical inventory scan replay id")?;

                if inserted.is_none() {
                    let counted_qty: i32 = sqlx::query_scalar(
                        r#"
                        SELECT counted_qty
                        FROM physical_inventory_counts
                        WHERE session_id = $1 AND variant_id = $2
                        "#,
                    )
                    .bind(session_id)
                    .bind(req.variant_id)
                    .fetch_optional(&mut *tx)
                    .await?
                    .unwrap_or(0);
                    tx.commit().await?;
                    return Ok(counted_qty);
                }
                true
            }
            _ => false,
        }
    } else {
        false
    };

    // Upsert: if row exists, add qty; otherwise insert fresh
    let new_qty: i32 = sqlx::query_scalar(
        r#"
        INSERT INTO physical_inventory_counts (session_id, variant_id, counted_qty, scan_source, counted_by)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (session_id, variant_id)
        DO UPDATE SET
            counted_qty     = physical_inventory_counts.counted_qty + EXCLUDED.counted_qty,
            last_scanned_at = NOW(),
            scan_source     = EXCLUDED.scan_source,
            counted_by      = EXCLUDED.counted_by
        RETURNING counted_qty
        "#,
    )
    .bind(session_id)
    .bind(req.variant_id)
    .bind(qty)
    .bind(&req.source)
    .bind(req.staff_id)
    .fetch_one(&mut *tx)
    .await
    .context("Failed to upsert count")?;

    // Audit
    sqlx::query(
        r#"
        INSERT INTO physical_inventory_audit
            (session_id, variant_id, event_type, new_qty, performed_by, note)
        VALUES ($1, $2, 'scan', $3, $4, $5)
        "#,
    )
    .bind(session_id)
    .bind(req.variant_id)
    .bind(new_qty)
    .bind(req.staff_id)
    .bind(format!("Scanned via {}", req.source))
    .execute(&mut *tx)
    .await?;

    if qty > 0 && !stream_claimed {
        if let Some(staff_id) = req.staff_id {
            sqlx::query(
                r#"
                INSERT INTO inventory_count_scan_stream
                    (session_id, staff_id, variant_id, quantity, device_id)
                VALUES ($1, $2, $3, $4, $5)
                "#,
            )
            .bind(session_id)
            .bind(staff_id)
            .bind(req.variant_id)
            .bind(qty)
            .bind(&req.source)
            .execute(&mut *tx)
            .await?;
        }
    }

    let _ = started_at; // used contextually
    tx.commit().await?;
    Ok(new_qty)
}

pub async fn list_discovered_items(pool: &PgPool, session_id: Uuid) -> Result<Vec<DiscoveredItem>> {
    sqlx::query_as::<_, DiscoveredItem>(
        r#"
        SELECT pidi.id, pidi.session_id, pidi.scanned_code, pidi.scan_source,
               pidi.first_scanned_by, pidi.last_scanned_by,
               pidi.first_scanned_at, pidi.last_scanned_at,
               pidi.scan_count, pidi.status, pidi.resolved_variant_id,
               pv.sku AS resolved_sku,
               p.name AS resolved_product_name,
               pidi.resolution_note, pidi.resolved_by, pidi.resolved_at
        FROM physical_inventory_discovered_items pidi
        LEFT JOIN product_variants pv ON pv.id = pidi.resolved_variant_id
        LEFT JOIN products p ON p.id = pv.product_id
        WHERE pidi.session_id = $1
        ORDER BY
            CASE pidi.status WHEN 'pending' THEN 0 WHEN 'resolved' THEN 1 ELSE 2 END,
            pidi.last_scanned_at DESC
        "#,
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .context("Failed to load discovered physical inventory scans")
}

pub async fn count_non_sale_movements(pool: &PgPool, session_id: Uuid) -> Result<i64> {
    sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM inventory_transactions it
        JOIN physical_inventory_snapshots pis
          ON pis.session_id = $1
         AND pis.variant_id = it.variant_id
        JOIN physical_inventory_sessions s ON s.id = pis.session_id
        WHERE it.created_at >= s.started_at
          AND it.tx_type::text NOT IN ('sale', 'physical_inventory')
        "#,
    )
    .bind(session_id)
    .fetch_one(pool)
    .await
    .context("Failed to check non-sale inventory movements during count")
}

pub async fn record_discovered_item(
    pool: &PgPool,
    session_id: Uuid,
    req: RecordDiscoveredItemRequest,
    staff_id: Option<Uuid>,
) -> Result<DiscoveredItem> {
    let scanned_code = req.scanned_code.trim();
    if scanned_code.is_empty() {
        return Err(anyhow!("scanned_code required"));
    }
    if !matches!(req.source.as_str(), "laser" | "camera" | "manual") {
        return Err(anyhow!(
            "scan source must be 'laser', 'camera', or 'manual'"
        ));
    }

    let status: String =
        sqlx::query_scalar("SELECT status FROM physical_inventory_sessions WHERE id = $1")
            .bind(session_id)
            .fetch_one(pool)
            .await
            .context("Session not found")?;
    if status != "open" {
        return Err(anyhow!(
            "Session is not open for discovered scan capture (status: {status})"
        ));
    }

    let item = sqlx::query_as::<_, DiscoveredItem>(
        r#"
        WITH upserted AS (
            INSERT INTO physical_inventory_discovered_items
                (session_id, scanned_code, scan_source, first_scanned_by, last_scanned_by)
            VALUES ($1, $2, $3, $4, $4)
            ON CONFLICT (session_id, scanned_code)
            DO UPDATE SET
                scan_count = physical_inventory_discovered_items.scan_count + 1,
                scan_source = EXCLUDED.scan_source,
                last_scanned_by = EXCLUDED.last_scanned_by,
                last_scanned_at = NOW(),
                status = CASE
                    WHEN physical_inventory_discovered_items.status = 'pending' THEN 'pending'
                    ELSE physical_inventory_discovered_items.status
                END
            RETURNING *
        )
        SELECT u.id, u.session_id, u.scanned_code, u.scan_source,
               u.first_scanned_by, u.last_scanned_by,
               u.first_scanned_at, u.last_scanned_at,
               u.scan_count, u.status, u.resolved_variant_id,
               pv.sku AS resolved_sku,
               p.name AS resolved_product_name,
               u.resolution_note, u.resolved_by, u.resolved_at
        FROM upserted u
        LEFT JOIN product_variants pv ON pv.id = u.resolved_variant_id
        LEFT JOIN products p ON p.id = pv.product_id
        "#,
    )
    .bind(session_id)
    .bind(scanned_code)
    .bind(&req.source)
    .bind(staff_id)
    .fetch_one(pool)
    .await
    .context("Failed to record discovered physical inventory scan")?;

    sqlx::query(
        r#"
        INSERT INTO physical_inventory_audit
            (session_id, event_type, performed_by, note)
        VALUES ($1, 'discovered_scan', $2, $3)
        "#,
    )
    .bind(session_id)
    .bind(staff_id)
    .bind(format!("Discovered scan captured: {scanned_code}"))
    .execute(pool)
    .await?;

    Ok(item)
}

pub async fn resolve_discovered_item(
    pool: &PgPool,
    session_id: Uuid,
    item_id: Uuid,
    req: ResolveDiscoveredItemRequest,
    staff_id: Option<Uuid>,
) -> Result<DiscoveredItem> {
    let status = req.status.trim().to_ascii_lowercase();
    if !matches!(status.as_str(), "resolved" | "ignored" | "pending") {
        return Err(anyhow!(
            "discovered item status must be 'pending', 'resolved', or 'ignored'"
        ));
    }
    if status == "resolved" && req.resolved_variant_id.is_none() {
        return Err(anyhow!(
            "resolved_variant_id required when status is 'resolved'"
        ));
    }

    let item = sqlx::query_as::<_, DiscoveredItem>(
        r#"
        WITH updated AS (
            UPDATE physical_inventory_discovered_items
            SET status = $1,
                resolved_variant_id = CASE WHEN $1 = 'resolved' THEN $2 ELSE resolved_variant_id END,
                resolution_note = $3,
                resolved_by = CASE WHEN $1 IN ('resolved', 'ignored') THEN $4 ELSE NULL END,
                resolved_at = CASE WHEN $1 IN ('resolved', 'ignored') THEN NOW() ELSE NULL END
            WHERE id = $5 AND session_id = $6
            RETURNING *
        )
        SELECT u.id, u.session_id, u.scanned_code, u.scan_source,
               u.first_scanned_by, u.last_scanned_by,
               u.first_scanned_at, u.last_scanned_at,
               u.scan_count, u.status, u.resolved_variant_id,
               pv.sku AS resolved_sku,
               p.name AS resolved_product_name,
               u.resolution_note, u.resolved_by, u.resolved_at
        FROM updated u
        LEFT JOIN product_variants pv ON pv.id = u.resolved_variant_id
        LEFT JOIN products p ON p.id = pv.product_id
        "#,
    )
    .bind(&status)
    .bind(req.resolved_variant_id)
    .bind(req.resolution_note.as_deref())
    .bind(staff_id)
    .bind(item_id)
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| anyhow!("Discovered item not found"))?;

    sqlx::query(
        r#"
        INSERT INTO physical_inventory_audit
            (session_id, event_type, performed_by, note)
        VALUES ($1, 'discovered_resolve', $2, $3)
        "#,
    )
    .bind(session_id)
    .bind(staff_id)
    .bind(format!(
        "Discovered scan {} marked {}",
        item.scanned_code, item.status
    ))
    .execute(pool)
    .await?;

    Ok(item)
}

/// Apply a manual review adjustment to a count row.
pub async fn apply_review_adjustment(
    pool: &PgPool,
    session_id: Uuid,
    count_id: Uuid,
    adjusted_qty: i32,
    note: Option<String>,
    staff_id: Option<Uuid>,
) -> Result<()> {
    let old: Option<(i32, i32)> = sqlx::query_as(
        "SELECT counted_qty, COALESCE(adjusted_qty, counted_qty) FROM physical_inventory_counts WHERE id = $1 AND session_id = $2",
    )
    .bind(count_id)
    .bind(session_id)
    .fetch_optional(pool)
    .await?;

    let (counted, old_eff) = old.ok_or_else(|| anyhow!("Count row not found"))?;

    sqlx::query(
        r#"
        UPDATE physical_inventory_counts
        SET adjusted_qty = $1, review_status = 'adjusted', review_note = $2, last_scanned_at = NOW()
        WHERE id = $3 AND session_id = $4
        "#,
    )
    .bind(adjusted_qty)
    .bind(note.as_deref())
    .bind(count_id)
    .bind(session_id)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO physical_inventory_audit
            (session_id, event_type, old_qty, new_qty, performed_by, note)
        SELECT $1, 'review_adjust', $2, $3, $4, $5
        FROM physical_inventory_counts WHERE id = $6
        "#,
    )
    .bind(session_id)
    .bind(old_eff)
    .bind(adjusted_qty)
    .bind(staff_id)
    .bind(note.unwrap_or_else(|| format!("Manual adjustment (counted was {counted})")))
    .bind(count_id)
    .execute(pool)
    .await?;

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Review Data
// ─────────────────────────────────────────────────────────────────────────────

/// Build the full review dataset: counted + snapshot + sales deduction.
pub async fn build_review(pool: &PgPool, session_id: Uuid) -> Result<Vec<ReviewRow>> {
    let mut tx = pool.begin().await?;
    let review = build_review_tx(&mut tx, session_id, false).await?;
    tx.commit().await?;
    Ok(review)
}

async fn build_review_tx(
    tx: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    preserve_live_deltas: bool,
) -> Result<Vec<ReviewRow>> {
    let _ = materialize_review_scope_rows_tx(tx, session_id).await?;
    let started_at: DateTime<Utc> =
        sqlx::query_scalar("SELECT started_at FROM physical_inventory_sessions WHERE id = $1")
            .bind(session_id)
            .fetch_one(&mut **tx)
            .await
            .context("Session not found")?;

    // Pull counts joined to products and snapshots
    #[derive(sqlx::FromRow)]
    struct RawReview {
        count_id: Uuid,
        variant_id: Uuid,
        sku: String,
        product_name: String,
        variation_label: Option<String>,
        stock_at_start: i32,
        counted_qty: i32,
        adjusted_qty: Option<i32>,
        review_status: String,
        review_note: Option<String>,
        current_stock_on_hand: i32,
        unit_cost: Decimal,
        sales_since_start: i64,
        sales_after_count: i64,
    }

    let rows = sqlx::query_as::<_, RawReview>(
        r#"
        WITH base AS (
            SELECT
                pic.id         AS count_id,
                pis.variant_id,
                pv.sku,
                p.name         AS product_name,
                pv.variation_label,
                pis.stock_at_start,
                COALESCE(pic.counted_qty, 0) AS counted_qty,
                pic.adjusted_qty,
                COALESCE(pic.review_status, 'pending') AS review_status,
                pic.review_note,
                pic.last_scanned_at,
                CASE
                    WHEN COALESCE(pic.counted_qty, 0) > 0 OR pic.adjusted_qty IS NOT NULL
                    THEN COALESCE(pic.last_scanned_at, $2)
                    ELSE $2
                END AS count_cutoff,
                pv.stock_on_hand AS current_stock_on_hand,
                COALESCE(pv.cost_override, p.base_cost, 0)::numeric AS unit_cost
            FROM physical_inventory_snapshots pis
            JOIN product_variants pv ON pv.id = pis.variant_id
            JOIN products p ON p.id = pv.product_id
            LEFT JOIN physical_inventory_counts pic
                ON pic.session_id = pis.session_id AND pic.variant_id = pis.variant_id
            WHERE pis.session_id = $1
        ),
        recent_sales AS (
            SELECT oi.variant_id, oi.quantity, o.booked_at
            FROM transaction_lines oi
            JOIN transactions o ON o.id = oi.transaction_id
            WHERE o.status::text NOT IN ('cancelled')
              AND o.booked_at >= $2
        )
        SELECT
            b.count_id,
            b.variant_id,
            b.sku,
            b.product_name,
            b.variation_label,
            b.stock_at_start,
            b.counted_qty,
            b.adjusted_qty,
            b.review_status,
            b.review_note,
            b.current_stock_on_hand,
            b.unit_cost,
            COALESCE(SUM(rs.quantity), 0)::bigint AS sales_since_start,
            COALESCE(SUM(rs.quantity) FILTER (WHERE rs.booked_at >= b.count_cutoff), 0)::bigint AS sales_after_count
        FROM base b
        LEFT JOIN recent_sales rs ON rs.variant_id = b.variant_id
        GROUP BY
            b.count_id,
            b.variant_id,
            b.sku,
            b.product_name,
            b.variation_label,
            b.stock_at_start,
            b.counted_qty,
            b.adjusted_qty,
            b.review_status,
            b.review_note,
            b.current_stock_on_hand,
            b.unit_cost,
            b.count_cutoff
        ORDER BY b.product_name, b.sku
        "#,
    )
    .bind(session_id)
    .bind(started_at)
    .fetch_all(&mut **tx)
    .await
    .context("Failed to fetch review rows")?;

    let mut result = Vec::with_capacity(rows.len());

    for row in rows {
        let effective_qty = row.adjusted_qty.unwrap_or(row.counted_qty);
        let sales_since_start = row.sales_since_start as i32;
        let sales_after_count = row.sales_after_count as i32;
        let final_stock = (effective_qty - sales_after_count).max(0);
        let delta = if preserve_live_deltas {
            final_stock - row.current_stock_on_hand
        } else {
            let expected_live_stock = (row.stock_at_start - sales_since_start).max(0);
            final_stock - expected_live_stock
        };
        let accounting_impact = row.unit_cost * Decimal::from(delta);

        result.push(ReviewRow {
            count_id: row.count_id,
            variant_id: row.variant_id,
            sku: row.sku,
            product_name: row.product_name,
            variation_label: row.variation_label,
            stock_at_start: row.stock_at_start,
            counted_qty: row.counted_qty,
            adjusted_qty: row.adjusted_qty,
            effective_qty,
            sales_since_start,
            sales_after_count,
            final_stock,
            delta,
            unit_cost: row.unit_cost,
            accounting_impact,
            review_status: row.review_status,
            review_note: row.review_note,
        });
    }

    Ok(result)
}

// ─────────────────────────────────────────────────────────────────────────────
// Publish
// ─────────────────────────────────────────────────────────────────────────────

/// Atomically applies all counted quantities to product_variants.stock_on_hand,
/// records inventory_transactions for each change, and marks the session published.
pub async fn publish_session(
    pool: &PgPool,
    session_id: Uuid,
    published_by: Option<Uuid>,
    approved_by: Uuid,
    approval_note: Option<String>,
) -> Result<PublishResult> {
    let mut tx = pool.begin().await?;

    // Verify session is in reviewing state
    let (status, baseline_type): (String, String) = sqlx::query_as(
        "SELECT status, baseline_type FROM physical_inventory_sessions WHERE id = $1 FOR UPDATE",
    )
    .bind(session_id)
    .fetch_one(&mut *tx)
    .await
    .context("Session not found")?;

    if status != "reviewing" {
        return Err(anyhow!(
            "Session must be in 'reviewing' status to publish (currently '{status}')"
        ));
    }

    let pending_discovered: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM physical_inventory_discovered_items WHERE session_id = $1 AND status = 'pending'",
    )
    .bind(session_id)
    .fetch_one(&mut *tx)
    .await
    .context("Failed to check discovered scans before publish")?;
    if pending_discovered > 0 {
        return Err(anyhow!(
            "Resolve or ignore {pending_discovered} discovered scan(s) before publishing"
        ));
    }

    let non_sale_movements: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM inventory_transactions it
        JOIN physical_inventory_snapshots pis
          ON pis.session_id = $1
         AND pis.variant_id = it.variant_id
        JOIN physical_inventory_sessions s ON s.id = pis.session_id
        WHERE it.created_at >= s.started_at
          AND it.tx_type::text NOT IN ('sale', 'physical_inventory')
        "#,
    )
    .bind(session_id)
    .fetch_one(&mut *tx)
    .await
    .context("Failed to check non-sale inventory movements before publish")?;
    if non_sale_movements > 0 {
        return Err(anyhow!(
            "Resolve non-sale inventory movement first: {non_sale_movements} in-scope movement(s) happened during this count"
        ));
    }

    sqlx::query(
        r#"
        SELECT pv.id
        FROM product_variants pv
        INNER JOIN physical_inventory_snapshots pis ON pis.variant_id = pv.id
        WHERE pis.session_id = $1
        ORDER BY pv.id
        FOR UPDATE OF pv
        "#,
    )
    .bind(session_id)
    .execute(&mut *tx)
    .await
    .context("Failed to lock physical inventory variants")?;

    // Build review rows after session and variant locks are held so absolute stock writes
    // cannot overwrite newer inventory mutations.
    let review = build_review_tx(&mut tx, session_id, true).await?;
    if review.is_empty() {
        return Err(anyhow!("No counted items to publish"));
    }

    let zero_cost_movements = review
        .iter()
        .filter(|row| row.delta != 0 && row.unit_cost <= Decimal::ZERO)
        .count();
    if zero_cost_movements > 0 {
        return Err(anyhow!(
            "Set unit cost before publishing: {zero_cost_movements} movement row(s) have zero cost"
        ));
    }

    let mut reconciled: i64 = 0;
    let mut total_shrinkage: i32 = 0;
    let mut total_surplus: i32 = 0;
    let mut accounting_impact = Decimal::ZERO;

    for row in &review {
        reconciled += 1;
        if row.delta == 0 {
            continue;
        }

        // Update stock_on_hand to the reconciled final value
        sqlx::query("UPDATE product_variants SET stock_on_hand = $1 WHERE id = $2")
            .bind(row.final_stock)
            .bind(row.variant_id)
            .execute(&mut *tx)
            .await
            .context("Failed to update stock_on_hand")?;

        // Record in inventory_transactions using the existing table structure
        sqlx::query(
            r#"
            INSERT INTO inventory_transactions
                (variant_id, tx_type, quantity_delta, unit_cost, reference_table, reference_id, notes, created_by)
            VALUES ($1, 'physical_inventory', $2, $3, 'physical_inventory_sessions', $4, $5, $6)
            "#,
        )
        .bind(row.variant_id)
        .bind(row.delta)
        .bind(row.unit_cost)
        .bind(session_id)
        .bind(format!(
            "Physical inventory publish: counted={}, sales_since_start={}, sales_after_count={}, final={}",
            row.effective_qty, row.sales_since_start, row.sales_after_count, row.final_stock
        ))
        .bind(published_by)
        .execute(&mut *tx)
        .await?;

        let impact_type = if row.delta < 0 {
            "shrinkage"
        } else {
            "surplus"
        };
        sqlx::query(
            r#"
            INSERT INTO physical_inventory_accounting_impacts
                (session_id, variant_id, quantity_delta, unit_cost, extended_cost, impact_type)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (session_id, variant_id)
            DO UPDATE SET
                quantity_delta = EXCLUDED.quantity_delta,
                unit_cost = EXCLUDED.unit_cost,
                extended_cost = EXCLUDED.extended_cost,
                impact_type = EXCLUDED.impact_type,
                created_at = NOW()
            "#,
        )
        .bind(session_id)
        .bind(row.variant_id)
        .bind(row.delta)
        .bind(row.unit_cost)
        .bind(row.accounting_impact)
        .bind(impact_type)
        .execute(&mut *tx)
        .await?;

        accounting_impact += row.accounting_impact;

        let old_live_stock = row.final_stock - row.delta;

        // Per-row audit entry
        sqlx::query(
            r#"
            INSERT INTO physical_inventory_audit
                (session_id, variant_id, event_type, old_qty, new_qty, performed_by, note)
            VALUES ($1, $2, 'publish', $3, $4, $5, $6)
            "#,
        )
        .bind(session_id)
        .bind(row.variant_id)
        .bind(old_live_stock)
        .bind(row.final_stock)
        .bind(published_by)
        .bind(if let Some(note) = &row.review_note {
            note.clone()
        } else {
            format!("snapshot={}, live_delta={}", row.stock_at_start, row.delta)
        })
        .execute(&mut *tx)
        .await?;

        if row.delta < 0 {
            total_shrinkage += row.delta.abs();
        } else if row.delta > 0 {
            total_surplus += row.delta;
        }
    }

    // Mark session published
    sqlx::query(
        r#"
        UPDATE physical_inventory_sessions
        SET status = 'published', published_at = NOW(), published_by = $1
        WHERE id = $2
        "#,
    )
    .bind(published_by)
    .bind(session_id)
    .execute(&mut *tx)
    .await?;

    // Final audit row for the session
    sqlx::query(
        r#"
        INSERT INTO physical_inventory_audit
            (session_id, event_type, performed_by, note)
        VALUES ($1, 'publish', $2, $3)
        "#,
    )
    .bind(session_id)
    .bind(published_by)
    .bind(format!(
        "Published: {reconciled} variants reconciled, {total_shrinkage} shrinkage units, {total_surplus} surplus units"
    ))
    .execute(&mut *tx)
    .await?;

    let approval_kind = if baseline_type == "normal" {
        "publish"
    } else {
        "baseline"
    };

    sqlx::query(
        r#"
        INSERT INTO physical_inventory_approvals
            (session_id, approval_kind, approved_by, approval_note, variance_summary)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(session_id)
    .bind(approval_kind)
    .bind(approved_by)
    .bind(approval_note.as_deref())
    .bind(serde_json::json!({
        "baseline_type": baseline_type,
        "variants_reconciled": reconciled,
        "total_shrinkage": total_shrinkage,
        "total_surplus": total_surplus,
        "accounting_impact": accounting_impact.to_string(),
    }))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(PublishResult {
        variants_reconciled: reconciled,
        total_shrinkage,
        total_surplus,
        accounting_impact,
    })
}

/// Cancel (soft-delete) an open or reviewing session.
pub async fn cancel_session(pool: &PgPool, session_id: Uuid, staff_id: Option<Uuid>) -> Result<()> {
    let rows = sqlx::query(
        "UPDATE physical_inventory_sessions SET status = 'cancelled' WHERE id = $1 AND status IN ('open', 'reviewing')",
    )
    .bind(session_id)
    .execute(pool)
    .await?;

    if rows.rows_affected() == 0 {
        return Err(anyhow!("Session not found or already published/cancelled"));
    }

    sqlx::query(
        "INSERT INTO physical_inventory_audit (session_id, event_type, performed_by, note) VALUES ($1, 'cancel', $2, 'Session cancelled')",
    )
    .bind(session_id)
    .bind(staff_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn build_workspace_report(
    pool: &PgPool,
    session_id: Uuid,
) -> Result<PhysicalInventoryReport> {
    let session = get_session_by_id(pool, session_id).await?;

    let approvals = sqlx::query(
        r#"
        SELECT pia.approval_kind,
               pia.approved_at,
               pia.approval_note,
               pia.variance_summary,
               s.full_name AS approved_by
        FROM physical_inventory_approvals pia
        JOIN staff s ON s.id = pia.approved_by
        WHERE pia.session_id = $1
        ORDER BY pia.approved_at DESC
        "#,
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| {
        let approved_at: DateTime<Utc> = row.get("approved_at");
        let variance_summary: serde_json::Value = row.get("variance_summary");
        serde_json::json!({
            "approval_kind": row.get::<String, _>("approval_kind"),
            "approved_at": approved_at,
            "approved_by": row.get::<String, _>("approved_by"),
            "approval_note": row.get::<Option<String>, _>("approval_note"),
            "variance_summary": variance_summary,
        })
    })
    .collect();

    let variance_rows = sqlx::query(
        r#"
        SELECT pv.sku,
               p.name AS product_name,
               pv.variation_label,
               pis.stock_at_start,
               pic.counted_qty,
               pic.adjusted_qty,
               COALESCE(pic.adjusted_qty, pic.counted_qty, 0) AS effective_qty,
               COALESCE(piai.quantity_delta, COALESCE(pic.adjusted_qty, pic.counted_qty, 0) - pis.stock_at_start) AS quantity_delta,
               pic.review_status,
               pic.review_note,
               COALESCE(piai.unit_cost, COALESCE(pv.cost_override, p.base_cost, 0))::numeric AS unit_cost,
               COALESCE(piai.extended_cost, (COALESCE(pic.adjusted_qty, pic.counted_qty, 0) - pis.stock_at_start) * COALESCE(pv.cost_override, p.base_cost, 0))::numeric AS extended_cost
        FROM physical_inventory_snapshots pis
        JOIN product_variants pv ON pv.id = pis.variant_id
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN physical_inventory_counts pic
          ON pic.session_id = pis.session_id AND pic.variant_id = pis.variant_id
        LEFT JOIN physical_inventory_accounting_impacts piai
          ON piai.session_id = pis.session_id AND piai.variant_id = pis.variant_id
        WHERE pis.session_id = $1
        ORDER BY ABS(COALESCE(piai.quantity_delta, COALESCE(pic.adjusted_qty, pic.counted_qty, 0) - pis.stock_at_start)) DESC,
                 p.name,
                 pv.sku
        LIMIT 1000
        "#,
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| {
        let unit_cost: Decimal = row.get("unit_cost");
        let extended_cost: Decimal = row.get("extended_cost");
        serde_json::json!({
            "sku": row.get::<String, _>("sku"),
            "product_name": row.get::<String, _>("product_name"),
            "variation_label": row.get::<Option<String>, _>("variation_label"),
            "stock_at_start": row.get::<i32, _>("stock_at_start"),
            "counted_qty": row.get::<Option<i32>, _>("counted_qty").unwrap_or(0),
            "adjusted_qty": row.get::<Option<i32>, _>("adjusted_qty"),
            "effective_qty": row.get::<Option<i32>, _>("effective_qty").unwrap_or(0),
            "quantity_delta": row.get::<Option<i32>, _>("quantity_delta").unwrap_or(0),
            "review_status": row.get::<Option<String>, _>("review_status").unwrap_or_else(|| "pending".to_string()),
            "review_note": row.get::<Option<String>, _>("review_note"),
            "unit_cost": unit_cost,
            "extended_cost": extended_cost,
        })
    })
    .collect();

    let scan_rows = sqlx::query(
        r#"
        SELECT ics.scanned_at,
               ics.quantity,
               ics.device_id,
               s.full_name AS staff_name,
               pv.sku,
               p.name AS product_name,
               pv.variation_label
        FROM inventory_count_scan_stream ics
        JOIN staff s ON s.id = ics.staff_id
        JOIN product_variants pv ON pv.id = ics.variant_id
        JOIN products p ON p.id = pv.product_id
        WHERE ics.session_id = $1
        ORDER BY ics.scanned_at DESC
        LIMIT 1000
        "#,
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| {
        let scanned_at: DateTime<Utc> = row.get("scanned_at");
        serde_json::json!({
            "scanned_at": scanned_at,
            "quantity": row.get::<i32, _>("quantity"),
            "device": row.get::<Option<String>, _>("device_id").unwrap_or_else(|| "scanner".to_string()),
            "staff_name": row.get::<String, _>("staff_name"),
            "sku": row.get::<String, _>("sku"),
            "product_name": row.get::<String, _>("product_name"),
            "variation_label": row.get::<Option<String>, _>("variation_label"),
        })
    })
    .collect();

    let discovered_rows = list_discovered_items(pool, session_id)
        .await?
        .into_iter()
        .map(|item| serde_json::json!(item))
        .collect();

    let accounting_rows = sqlx::query(
        r#"
        SELECT piai.created_at,
               piai.quantity_delta,
               piai.unit_cost,
               piai.extended_cost,
               piai.impact_type,
               pv.sku,
               p.name AS product_name,
               pv.variation_label
        FROM physical_inventory_accounting_impacts piai
        JOIN product_variants pv ON pv.id = piai.variant_id
        JOIN products p ON p.id = pv.product_id
        WHERE piai.session_id = $1
        ORDER BY ABS(piai.extended_cost) DESC, p.name, pv.sku
        LIMIT 1000
        "#,
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| {
        let created_at: DateTime<Utc> = row.get("created_at");
        let unit_cost: Decimal = row.get("unit_cost");
        let extended_cost: Decimal = row.get("extended_cost");
        serde_json::json!({
            "created_at": created_at,
            "quantity_delta": row.get::<i32, _>("quantity_delta"),
            "unit_cost": unit_cost,
            "extended_cost": extended_cost,
            "impact_type": row.get::<String, _>("impact_type"),
            "sku": row.get::<String, _>("sku"),
            "product_name": row.get::<String, _>("product_name"),
            "variation_label": row.get::<Option<String>, _>("variation_label"),
        })
    })
    .collect();

    Ok(PhysicalInventoryReport {
        session,
        approvals,
        variance_rows,
        scan_rows,
        discovered_rows,
        accounting_rows,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan Resolution (vendor_upc support)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ScanResolveResult {
    pub variant_id: Uuid,
    pub sku: String,
    pub product_name: String,
    pub variation_label: Option<String>,
    pub stock_on_hand: i32,
    pub match_field: String, // "vendor_upc" | "barcode" | "sku"
}

/// Resolve a scanned code to a variant. When vendor_id is provided and that
/// vendor has use_vendor_upc = true, vendor_upc is checked before barcode/sku.
pub async fn resolve_scan_code(
    pool: &PgPool,
    code: &str,
    vendor_id: Option<Uuid>,
) -> Result<Option<ScanResolveResult>> {
    let code = code.trim();
    if code.is_empty() {
        return Ok(None);
    }

    // Check if vendor uses vendor UPC priority
    let use_vendor_upc = if let Some(vid) = vendor_id {
        sqlx::query_scalar::<_, bool>(
            "SELECT COALESCE(use_vendor_upc, false) FROM vendors WHERE id = $1",
        )
        .bind(vid)
        .fetch_optional(pool)
        .await?
        .unwrap_or(false)
    } else {
        false
    };

    // 1. Vendor UPC (if flag enabled)
    if use_vendor_upc {
        if let Some(row) = try_resolve(pool, code, "vendor_upc").await? {
            return Ok(Some(row));
        }
    }

    // 2. Standard barcode
    if let Some(row) = try_resolve(pool, code, "barcode").await? {
        return Ok(Some(row));
    }

    // 3. SKU
    if let Some(row) = try_resolve(pool, code, "sku").await? {
        return Ok(Some(row));
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::{build_review, materialize_review_scope_rows};
    use chrono::{Duration, Utc};
    use rust_decimal::Decimal;
    use sqlx::PgPool;
    use uuid::Uuid;

    #[tokio::test]
    async fn build_review_surfaces_uncounted_in_scope_variants() {
        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for DB-backed tests");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect test database");

        let session_id = Uuid::new_v4();
        let product_one_id = Uuid::new_v4();
        let product_two_id = Uuid::new_v4();
        let variant_one_id = Uuid::new_v4();
        let variant_two_id = Uuid::new_v4();
        let started_at = Utc::now() - Duration::hours(1);

        sqlx::query(
            r#"
            INSERT INTO products (id, name, base_retail_price, base_cost, is_active)
            VALUES ($1, $2, $3, $4, true), ($5, $6, $7, $8, true)
            "#,
        )
        .bind(product_one_id)
        .bind("PI Counted Variant")
        .bind(Decimal::new(10000, 2))
        .bind(Decimal::new(4000, 2))
        .bind(product_two_id)
        .bind("PI Missing Variant")
        .bind(Decimal::new(12000, 2))
        .bind(Decimal::new(5000, 2))
        .execute(&pool)
        .await
        .expect("insert products");

        sqlx::query(
            r#"
            INSERT INTO product_variants (id, product_id, sku, variation_values, stock_on_hand)
            VALUES
              ($1, $2, $3, '{}'::jsonb, $4),
              ($5, $6, $7, '{}'::jsonb, $8)
            "#,
        )
        .bind(variant_one_id)
        .bind(product_one_id)
        .bind(format!("PI-COUNTED-{}", Uuid::new_v4().simple()))
        .bind(5_i32)
        .bind(variant_two_id)
        .bind(product_two_id)
        .bind(format!("PI-MISSING-{}", Uuid::new_v4().simple()))
        .bind(3_i32)
        .execute(&pool)
        .await
        .expect("insert variants");

        sqlx::query(
            r#"
            INSERT INTO physical_inventory_sessions (
              id, session_number, status, scope, category_ids, started_at, last_saved_at
            )
            VALUES ($1, $2, 'published', 'full', '{}', $3, $3)
            "#,
        )
        .bind(session_id)
        .bind(format!("TEST-PI-{}", Uuid::new_v4().simple()))
        .bind(started_at)
        .execute(&pool)
        .await
        .expect("insert session");

        sqlx::query(
            r#"
            INSERT INTO physical_inventory_snapshots (session_id, variant_id, stock_at_start)
            VALUES ($1, $2, 5), ($1, $3, 3)
            "#,
        )
        .bind(session_id)
        .bind(variant_one_id)
        .bind(variant_two_id)
        .execute(&pool)
        .await
        .expect("insert snapshots");

        sqlx::query(
            r#"
            INSERT INTO physical_inventory_counts (session_id, variant_id, counted_qty, scan_source)
            VALUES ($1, $2, 5, 'manual')
            "#,
        )
        .bind(session_id)
        .bind(variant_one_id)
        .execute(&pool)
        .await
        .expect("insert counted row");

        let inserted = materialize_review_scope_rows(&pool, session_id)
            .await
            .expect("materialize missing scope rows");
        assert_eq!(inserted, 1);

        let review = build_review(&pool, session_id)
            .await
            .expect("build review for full scope");
        assert_eq!(review.len(), 2);

        let counted = review
            .iter()
            .find(|row| row.variant_id == variant_one_id)
            .expect("counted variant in review");
        assert_eq!(counted.counted_qty, 5);
        assert_eq!(counted.final_stock, 5);
        assert_eq!(counted.delta, 0);

        let missing = review
            .iter()
            .find(|row| row.variant_id == variant_two_id)
            .expect("missing variant in review");
        assert_eq!(missing.counted_qty, 0);
        assert_eq!(missing.adjusted_qty, None);
        assert_eq!(missing.final_stock, 0);
        assert_eq!(missing.delta, -3);

        let materialized_count_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM physical_inventory_counts WHERE session_id = $1",
        )
        .bind(session_id)
        .fetch_one(&pool)
        .await
        .expect("count materialized rows");
        assert_eq!(materialized_count_rows, 2);

        sqlx::query("DELETE FROM physical_inventory_sessions WHERE id = $1")
            .bind(session_id)
            .execute(&pool)
            .await
            .expect("delete session");
        sqlx::query("DELETE FROM product_variants WHERE id = ANY($1)")
            .bind(vec![variant_one_id, variant_two_id])
            .execute(&pool)
            .await
            .expect("delete variants");
        sqlx::query("DELETE FROM products WHERE id = ANY($1)")
            .bind(vec![product_one_id, product_two_id])
            .execute(&pool)
            .await
            .expect("delete products");
    }
}

async fn try_resolve(pool: &PgPool, code: &str, field: &str) -> Result<Option<ScanResolveResult>> {
    let col = match field {
        "vendor_upc" => "pv.vendor_upc",
        "barcode" => "pv.barcode",
        "sku" => "pv.sku",
        _ => return Ok(None),
    };
    let sql = format!(
        r#"
        SELECT pv.id AS variant_id, pv.sku, p.name AS product_name,
               pv.variation_label, pv.stock_on_hand, '{field}' AS match_field
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        WHERE p.is_active = true
          AND p.pos_line_kind IS NULL
          AND {col} IS NOT NULL
          AND lower(btrim({col})) = lower(btrim($1))
        LIMIT 1
        "#
    );
    let result = sqlx::query_as::<_, ScanResolveResult>(&sql)
        .bind(code)
        .fetch_optional(pool)
        .await?;
    Ok(result)
}
