//! Physical Inventory business logic: session management, stock snapshots, review calculation, and publish.

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};
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
    /// Final stock = max(0, effective_qty - sales_since_start)
    pub final_stock: i32,
    /// Delta from snapshot: final_stock - stock_at_start
    pub delta: i32,
    pub review_status: String,
    pub review_note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    pub scope: String,
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
}

#[derive(Debug, Serialize)]
pub struct PublishResult {
    pub variants_reconciled: i64,
    pub total_shrinkage: i32,
    pub total_surplus: i32,
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/// Returns the current active (open or reviewing) session, if any.
pub async fn get_active_session(pool: &PgPool) -> Result<Option<PhysicalInventorySession>> {
    let session = sqlx::query_as::<_, PhysicalInventorySession>(
        r#"
        SELECT id, session_number, status, scope, category_ids,
               started_at, last_saved_at, published_at, notes,
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

    let session_number = next_session_number(pool).await?;

    let mut tx = pool.begin().await.context("Failed to begin transaction")?;

    // Insert session
    let session = sqlx::query_as::<_, PhysicalInventorySession>(
        r#"
        INSERT INTO physical_inventory_sessions
            (session_number, status, scope, category_ids, started_by, notes, exclude_reserved, exclude_layaway)
        VALUES ($1, 'open', $2, $3, $4, $5, $6, $7)
        RETURNING id, session_number, status, scope, category_ids,
                  started_at, last_saved_at, published_at, notes,
                  exclude_reserved, exclude_layaway
        "#,
    )
    .bind(&session_number)
    .bind(&req.scope)
    .bind(&category_ids)
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
        "Session {} started. Scope: {}",
        session_number, req.scope
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
    let stock_expr = "pv.stock_on_hand - (CASE WHEN $3 THEN pv.reserved_stock ELSE 0 END) - (CASE WHEN $4 THEN pv.on_layaway ELSE 0 END)".to_string();

    if scope == "category" && !category_ids.is_empty() {
        let sql = format!(
            r#"
            INSERT INTO physical_inventory_snapshots (session_id, variant_id, stock_at_start)
            SELECT $1, pv.id, ({stock_expr})
            FROM product_variants pv
            JOIN products p ON p.id = pv.product_id
            WHERE p.is_active = true
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
        let sql = format!(
            r#"
            INSERT INTO physical_inventory_snapshots (session_id, variant_id, stock_at_start)
            SELECT $1, pv.id, ({stock_expr})
            FROM product_variants pv
            JOIN products p ON p.id = pv.product_id
            WHERE p.is_active = true
            ON CONFLICT (session_id, variant_id) DO NOTHING
            "#
        );
        sqlx::query(&sql)
            .bind(session_id)
            .bind(exclude_reserved) // note: $2 in full scope query
            .bind(exclude_layaway) // note: $3 in full scope query
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
    .fetch_one(pool)
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
    .execute(pool)
    .await?;

    let _ = started_at; // used contextually
    Ok(new_qty)
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
        SET adjusted_qty = $1, review_status = 'adjusted', review_note = $2
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
    let started_at: DateTime<Utc> =
        sqlx::query_scalar("SELECT started_at FROM physical_inventory_sessions WHERE id = $1")
            .bind(session_id)
            .fetch_one(pool)
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
    }

    let rows = sqlx::query_as::<_, RawReview>(
        r#"
        SELECT
            pic.id         AS count_id,
            pic.variant_id,
            pv.sku,
            p.name         AS product_name,
            pv.variation_label,
            COALESCE(pis.stock_at_start, 0) AS stock_at_start,
            pic.counted_qty,
            pic.adjusted_qty,
            pic.review_status,
            pic.review_note
        FROM physical_inventory_counts pic
        JOIN product_variants pv ON pv.id = pic.variant_id
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN physical_inventory_snapshots pis
            ON pis.session_id = pic.session_id AND pis.variant_id = pic.variant_id
        WHERE pic.session_id = $1
        ORDER BY p.name, pv.sku
        "#,
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .context("Failed to fetch review rows")?;

    let mut result = Vec::with_capacity(rows.len());

    for row in rows {
        // Sales of this variant since the session started
        let sales_since_start: i64 = sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(oi.quantity), 0)
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            WHERE oi.variant_id = $1
              AND o.status::text NOT IN ('cancelled')
              AND o.booked_at >= $2
            "#,
        )
        .bind(row.variant_id)
        .bind(started_at)
        .fetch_one(pool)
        .await
        .unwrap_or(0);

        let effective_qty = row.adjusted_qty.unwrap_or(row.counted_qty);
        let sales = sales_since_start as i32;
        let final_stock = (effective_qty - sales).max(0);
        let delta = final_stock - row.stock_at_start;

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
            sales_since_start: sales,
            final_stock,
            delta,
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
) -> Result<PublishResult> {
    // Build review rows — this includes the sales deduction logic
    let review = build_review(pool, session_id).await?;
    if review.is_empty() {
        return Err(anyhow!("No counted items to publish"));
    }

    let mut tx = pool.begin().await?;

    // Verify session is in reviewing state
    let status: String = sqlx::query_scalar(
        "SELECT status FROM physical_inventory_sessions WHERE id = $1 FOR UPDATE",
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

    let mut reconciled: i64 = 0;
    let mut total_shrinkage: i32 = 0;
    let mut total_surplus: i32 = 0;

    for row in &review {
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
                (variant_id, tx_type, quantity_delta, reference_table, reference_id, notes)
            VALUES ($1, 'physical_inventory', $2, 'physical_inventory_sessions', $3, $4)
            "#,
        )
        .bind(row.variant_id)
        .bind(row.delta)
        .bind(session_id)
        .bind(format!(
            "Physical inventory publish: counted={}, sales_deducted={}, final={}",
            row.effective_qty, row.sales_since_start, row.final_stock
        ))
        .execute(&mut *tx)
        .await?;

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
        .bind(row.stock_at_start)
        .bind(row.final_stock)
        .bind(published_by)
        .bind(if let Some(note) = &row.review_note {
            note.clone()
        } else {
            format!("delta={}", row.delta)
        })
        .execute(&mut *tx)
        .await?;

        reconciled += 1;
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

    tx.commit().await?;

    Ok(PublishResult {
        variants_reconciled: reconciled,
        total_shrinkage,
        total_surplus,
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
