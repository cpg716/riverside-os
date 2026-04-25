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

/// Ensure every in-scope snapshot variant has a review/count row before review or publish.
/// Uncounted in-scope variants are materialized with counted_qty = 0 so they are visible
/// during reconciliation instead of being silently skipped.
pub async fn materialize_review_scope_rows(pool: &PgPool, session_id: Uuid) -> Result<i64> {
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
    .execute(pool)
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
    if scope == "category" && !category_ids.is_empty() {
        let stock_expr = "pv.stock_on_hand - (CASE WHEN $3 THEN pv.reserved_stock ELSE 0 END) - (CASE WHEN $4 THEN pv.on_layaway ELSE 0 END)";
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
        let stock_expr = "pv.stock_on_hand - (CASE WHEN $2 THEN pv.reserved_stock ELSE 0 END) - (CASE WHEN $3 THEN pv.on_layaway ELSE 0 END)";
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
    let _ = materialize_review_scope_rows(pool, session_id).await?;
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
            pis.variant_id,
            pv.sku,
            p.name         AS product_name,
            pv.variation_label,
            pis.stock_at_start,
            COALESCE(pic.counted_qty, 0) AS counted_qty,
            pic.adjusted_qty,
            COALESCE(pic.review_status, 'pending') AS review_status,
            pic.review_note
        FROM physical_inventory_snapshots pis
        JOIN product_variants pv ON pv.id = pis.variant_id
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN physical_inventory_counts pic
            ON pic.session_id = pis.session_id AND pic.variant_id = pis.variant_id
        WHERE pis.session_id = $1
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
            FROM transaction_lines oi
            JOIN transactions o ON o.id = oi.transaction_id
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
