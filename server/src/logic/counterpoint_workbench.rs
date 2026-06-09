//! Inventory Migration Workbench — step-gated migration state, SKU gap detection,
//! Counterpoint CSV reference import, multi-source merge preview, and AI-assisted cleanup.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

// ────────────────────────────────────────────────────────────────────────────
// Step definitions
// ────────────────────────────────────────────────────────────────────────────

const STEPS_IN_ORDER: &[&str] = &[
    "data_sources",
    "categories",
    "vendors",
    "catalog",
    "sku_gaps",
    "verification",
];

fn step_column(step: &str) -> Option<&'static str> {
    match step {
        "data_sources" => Some("step_data_sources_status"),
        "categories" => Some("step_categories_status"),
        "vendors" => Some("step_vendors_status"),
        "catalog" => Some("step_catalog_status"),
        "sku_gaps" => Some("step_sku_gaps_status"),
        "verification" => Some("step_verification_status"),
        _ => None,
    }
}

fn step_approved_at_column(step: &str) -> Option<&'static str> {
    match step {
        "data_sources" => Some("step_data_sources_approved_at"),
        "categories" => Some("step_categories_approved_at"),
        "vendors" => Some("step_vendors_approved_at"),
        "catalog" => Some("step_catalog_approved_at"),
        "sku_gaps" => Some("step_sku_gaps_approved_at"),
        "verification" => Some("step_verification_approved_at"),
        _ => None,
    }
}

fn step_approved_by_column(step: &str) -> Option<&'static str> {
    match step {
        "data_sources" => Some("step_data_sources_approved_by"),
        "categories" => Some("step_categories_approved_by"),
        "vendors" => Some("step_vendors_approved_by"),
        "catalog" => Some("step_catalog_approved_by"),
        "sku_gaps" => Some("step_sku_gaps_approved_by"),
        "verification" => Some("step_verification_approved_by"),
        _ => None,
    }
}

fn next_step(current: &str) -> Option<&'static str> {
    let pos = STEPS_IN_ORDER.iter().position(|s| *s == current)?;
    STEPS_IN_ORDER.get(pos + 1).copied()
}

// ────────────────────────────────────────────────────────────────────────────
// Workbench state
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct WorkbenchStateRow {
    pub step_data_sources_status: String,
    pub step_data_sources_approved_at: Option<DateTime<Utc>>,
    pub step_categories_status: String,
    pub step_categories_approved_at: Option<DateTime<Utc>>,
    pub step_vendors_status: String,
    pub step_vendors_approved_at: Option<DateTime<Utc>>,
    pub step_catalog_status: String,
    pub step_catalog_approved_at: Option<DateTime<Utc>>,
    pub step_sku_gaps_status: String,
    pub step_sku_gaps_approved_at: Option<DateTime<Utc>>,
    pub step_verification_status: String,
    pub step_verification_approved_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct StepDetail {
    pub status: String,
    pub approved_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct WorkbenchStateResponse {
    pub current_step: Option<String>,
    pub steps: std::collections::BTreeMap<String, StepDetail>,
    pub inventory_summary: Option<InventorySummary>,
    pub can_reset: bool,
}

#[derive(Debug, Serialize)]
pub struct InventorySummary {
    pub products: i64,
    pub variants: i64,
    pub categories: i64,
    pub vendors: i64,
    pub variants_missing_barcode: i64,
    pub quarantine_count: i64,
}

pub async fn get_workbench_state(pool: &PgPool) -> Result<WorkbenchStateResponse, sqlx::Error> {
    // Ensure singleton row exists
    sqlx::query(
        "INSERT INTO counterpoint_workbench_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING",
    )
    .execute(pool)
    .await?;

    let row: WorkbenchStateRow = sqlx::query_as(
        r#"
        SELECT
            step_data_sources_status, step_data_sources_approved_at,
            step_categories_status, step_categories_approved_at,
            step_vendors_status, step_vendors_approved_at,
            step_catalog_status, step_catalog_approved_at,
            step_sku_gaps_status, step_sku_gaps_approved_at,
            step_verification_status, step_verification_approved_at,
            updated_at
        FROM counterpoint_workbench_state WHERE id = 1
        "#,
    )
    .fetch_one(pool)
    .await?;

    let steps_vec = vec![
        (
            "data_sources",
            &row.step_data_sources_status,
            row.step_data_sources_approved_at,
        ),
        (
            "categories",
            &row.step_categories_status,
            row.step_categories_approved_at,
        ),
        (
            "vendors",
            &row.step_vendors_status,
            row.step_vendors_approved_at,
        ),
        (
            "catalog",
            &row.step_catalog_status,
            row.step_catalog_approved_at,
        ),
        (
            "sku_gaps",
            &row.step_sku_gaps_status,
            row.step_sku_gaps_approved_at,
        ),
        (
            "verification",
            &row.step_verification_status,
            row.step_verification_approved_at,
        ),
    ];

    let mut steps = std::collections::BTreeMap::new();
    let mut current_step: Option<String> = None;
    for (name, status, approved_at) in &steps_vec {
        if current_step.is_none() && *status != "complete" {
            current_step = Some(name.to_string());
        }
        steps.insert(
            name.to_string(),
            StepDetail {
                status: status.to_string(),
                approved_at: *approved_at,
            },
        );
    }

    let inventory_summary = fetch_inventory_summary(pool).await.ok();

    Ok(WorkbenchStateResponse {
        current_step,
        steps,
        inventory_summary,
        can_reset: true,
    })
}

async fn fetch_inventory_summary(pool: &PgPool) -> Result<InventorySummary, sqlx::Error> {
    let (products, variants): (i64, i64) = sqlx::query_as(
        r#"
        SELECT
            (SELECT COUNT(*)::bigint FROM products WHERE data_source = 'counterpoint'),
            (SELECT COUNT(*)::bigint FROM product_variants WHERE counterpoint_item_key IS NOT NULL)
        "#,
    )
    .fetch_one(pool)
    .await?;

    let categories: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM counterpoint_category_map WHERE ros_category_id IS NOT NULL",
    )
    .fetch_one(pool)
    .await?;

    let vendors: i64 =
        sqlx::query_scalar("SELECT COUNT(*)::bigint FROM vendors WHERE vendor_code IS NOT NULL")
            .fetch_one(pool)
            .await?;

    let variants_missing_barcode: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint FROM product_variants
        WHERE counterpoint_item_key IS NOT NULL
          AND (barcode IS NULL OR trim(barcode) = '')
          AND sku ~ '^[Ii]-[0-9]'
        "#,
    )
    .fetch_one(pool)
    .await?;

    let quarantine_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM (
            SELECT DISTINCT
                ingest_type,
                COALESCE(
                    NULLIF(BTRIM(normalized_sku), ''),
                    NULLIF(BTRIM(counterpoint_item_key), ''),
                    NULLIF(BTRIM(family_key), ''),
                    NULLIF(BTRIM(source_row->>'sku'), ''),
                    NULLIF(BTRIM(source_row->>'item_no'), ''),
                    NULLIF(BTRIM(source_row->>'counterpoint_item_key'), ''),
                    md5(source_row::text)
                ) AS quarantine_identity
            FROM counterpoint_ingest_quarantine
            WHERE severity IN ('QUARANTINE','BLOCKING')
              AND ingest_type IN ('catalog','inventory')
        ) deduped_quarantine
        "#,
    )
    .fetch_one(pool)
    .await?;

    Ok(InventorySummary {
        products,
        variants,
        categories,
        vendors,
        variants_missing_barcode,
        quarantine_count,
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Step approval
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ApproveStepPayload {
    pub step: String,
}

#[derive(Debug, Serialize)]
pub struct ApproveStepResult {
    pub approved: bool,
    pub step: String,
    pub next_step_unlocked: Option<String>,
}

pub async fn approve_step(
    pool: &PgPool,
    step: &str,
    staff_id: Uuid,
) -> Result<ApproveStepResult, WorkbenchError> {
    let status_col =
        step_column(step).ok_or_else(|| WorkbenchError::InvalidStep(step.to_string()))?;
    let approved_at_col = step_approved_at_column(step)
        .ok_or_else(|| WorkbenchError::InvalidStep(step.to_string()))?;
    let approved_by_col = step_approved_by_column(step)
        .ok_or_else(|| WorkbenchError::InvalidStep(step.to_string()))?;

    // Check current status
    let current: String = sqlx::query_scalar(&format!(
        "SELECT {status_col} FROM counterpoint_workbench_state WHERE id = 1"
    ))
    .fetch_one(pool)
    .await
    .map_err(WorkbenchError::Database)?;

    if current == "locked" {
        return Err(WorkbenchError::StepLocked(step.to_string()));
    }
    if current == "complete" {
        return Err(WorkbenchError::AlreadyApproved(step.to_string()));
    }

    // Mark complete
    let sql = format!(
        "UPDATE counterpoint_workbench_state SET {status_col} = 'complete', {approved_at_col} = NOW(), {approved_by_col} = $1, updated_at = NOW() WHERE id = 1"
    );
    sqlx::query(&sql)
        .bind(staff_id)
        .execute(pool)
        .await
        .map_err(WorkbenchError::Database)?;

    // Unlock next step
    let next_unlocked = if let Some(next) = next_step(step) {
        let next_col =
            step_column(next).ok_or_else(|| WorkbenchError::InvalidStep(next.to_string()))?;
        let next_current: String = sqlx::query_scalar(&format!(
            "SELECT {next_col} FROM counterpoint_workbench_state WHERE id = 1"
        ))
        .fetch_one(pool)
        .await
        .map_err(WorkbenchError::Database)?;

        if next_current == "locked" {
            sqlx::query(&format!(
                "UPDATE counterpoint_workbench_state SET {next_col} = 'pending', updated_at = NOW() WHERE id = 1"
            ))
            .execute(pool)
            .await
            .map_err(WorkbenchError::Database)?;
            Some(next.to_string())
        } else {
            None
        }
    } else {
        None
    };

    Ok(ApproveStepResult {
        approved: true,
        step: step.to_string(),
        next_step_unlocked: next_unlocked,
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Reset workbench (return all steps to initial state)
// ────────────────────────────────────────────────────────────────────────────

pub async fn reset_workbench(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE counterpoint_workbench_state SET
            step_data_sources_status = 'pending',
            step_data_sources_approved_at = NULL,
            step_data_sources_approved_by = NULL,
            step_categories_status = 'locked',
            step_categories_approved_at = NULL,
            step_categories_approved_by = NULL,
            step_vendors_status = 'locked',
            step_vendors_approved_at = NULL,
            step_vendors_approved_by = NULL,
            step_catalog_status = 'locked',
            step_catalog_approved_at = NULL,
            step_catalog_approved_by = NULL,
            step_sku_gaps_status = 'locked',
            step_sku_gaps_approved_at = NULL,
            step_sku_gaps_approved_by = NULL,
            step_verification_status = 'locked',
            step_verification_approved_at = NULL,
            step_verification_approved_by = NULL,
            updated_at = NOW()
        WHERE id = 1
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// SKU gap detection
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SkuGapRow {
    pub variant_id: Uuid,
    pub product_id: Uuid,
    pub product_name: String,
    pub current_sku: String,
    pub barcode: Option<String>,
    pub counterpoint_item_key: Option<String>,
    pub category_name: Option<String>,
    pub stock_on_hand: i32,
    pub retail_price: Option<rust_decimal::Decimal>,
}

#[derive(Debug, Serialize)]
pub struct SkuGapReport {
    pub total_gaps: i64,
    pub rows: Vec<SkuGapRow>,
}

pub async fn get_sku_gaps(pool: &PgPool) -> Result<SkuGapReport, sqlx::Error> {
    let rows: Vec<SkuGapRow> = sqlx::query_as(
        r#"
        SELECT
            pv.id AS variant_id,
            p.id AS product_id,
            p.name AS product_name,
            pv.sku AS current_sku,
            pv.barcode,
            pv.counterpoint_item_key,
            c.name AS category_name,
            pv.stock_on_hand,
            pv.retail_price_override AS retail_price
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE pv.counterpoint_item_key IS NOT NULL
          AND (pv.barcode IS NULL OR trim(pv.barcode) = '')
          AND pv.sku ~ '^[Ii]-[0-9]'
        ORDER BY p.name, pv.sku
        LIMIT 2000
        "#,
    )
    .fetch_all(pool)
    .await?;

    let total_gaps: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint FROM product_variants
        WHERE counterpoint_item_key IS NOT NULL
          AND (barcode IS NULL OR trim(barcode) = '')
          AND sku ~ '^[Ii]-[0-9]'
        "#,
    )
    .fetch_one(pool)
    .await?;

    Ok(SkuGapReport { total_gaps, rows })
}

// ────────────────────────────────────────────────────────────────────────────
// SKU assignment
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SkuAssignment {
    pub variant_id: Uuid,
    pub new_sku: String,
    #[serde(default)]
    pub new_barcode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SkuAssignmentPayload {
    pub assignments: Vec<SkuAssignment>,
}

#[derive(Debug, Serialize)]
pub struct SkuAssignmentResult {
    pub updated: i32,
    pub skipped: i32,
    pub errors: Vec<String>,
}

pub async fn assign_skus(
    pool: &PgPool,
    payload: SkuAssignmentPayload,
) -> Result<SkuAssignmentResult, WorkbenchError> {
    let mut updated = 0i32;
    let mut skipped = 0i32;
    let mut errors = Vec::new();

    let mut tx = pool.begin().await.map_err(WorkbenchError::Database)?;

    for assignment in &payload.assignments {
        let new_sku = assignment.new_sku.trim();
        if new_sku.is_empty() {
            skipped += 1;
            errors.push(format!(
                "Variant {} — empty SKU, skipped",
                assignment.variant_id
            ));
            continue;
        }

        // Check for SKU conflict
        let conflict: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM product_variants WHERE sku = $1 AND id != $2)",
        )
        .bind(new_sku)
        .bind(assignment.variant_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(WorkbenchError::Database)?;

        if conflict {
            skipped += 1;
            errors.push(format!(
                "Variant {} — SKU '{}' already in use",
                assignment.variant_id, new_sku
            ));
            continue;
        }

        let barcode = assignment
            .new_barcode
            .as_deref()
            .map(|b| b.trim())
            .filter(|b| !b.is_empty());

        let r = sqlx::query(
            "UPDATE product_variants SET sku = $1, barcode = COALESCE($2, barcode) WHERE id = $3",
        )
        .bind(new_sku)
        .bind(barcode)
        .bind(assignment.variant_id)
        .execute(&mut *tx)
        .await
        .map_err(WorkbenchError::Database)?;

        if r.rows_affected() > 0 {
            updated += 1;
        } else {
            skipped += 1;
            errors.push(format!("Variant {} — not found", assignment.variant_id));
        }
    }

    tx.commit().await.map_err(WorkbenchError::Database)?;

    Ok(SkuAssignmentResult {
        updated,
        skipped,
        errors,
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Next available B-SKU suggestion
// ────────────────────────────────────────────────────────────────────────────

pub async fn suggest_next_b_sku(pool: &PgPool, count: i32) -> Result<Vec<String>, sqlx::Error> {
    // Find the highest existing B-XXXXXX number
    let max_num: Option<i64> = sqlx::query_scalar(
        r#"
        SELECT MAX(CAST(substring(sku FROM 3) AS bigint))::bigint
        FROM product_variants
        WHERE sku ~ '^[Bb]-[0-9]+$'
        "#,
    )
    .fetch_one(pool)
    .await?;

    let start = max_num.unwrap_or(0) + 1;
    let suggestions: Vec<String> = (0..count as i64)
        .map(|i| format!("B-{:06}", start + i))
        .collect();

    Ok(suggestions)
}

// ────────────────────────────────────────────────────────────────────────────
// Counterpoint CSV reference import
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
pub struct CpCsvReferenceRow {
    pub item_no: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub long_description: Option<String>,
    #[serde(default)]
    pub category_code: Option<String>,
    #[serde(default)]
    pub barcode: Option<String>,
    #[serde(default)]
    pub retail_price: Option<rust_decimal::Decimal>,
    #[serde(default)]
    pub unit_cost: Option<rust_decimal::Decimal>,
    #[serde(default)]
    pub qty_on_hand: Option<i32>,
    #[serde(default)]
    pub vendor_no: Option<String>,
    #[serde(default)]
    pub is_grid: Option<bool>,
    pub source_row_number: i32,
    #[serde(default)]
    pub raw_row: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct CpCsvReferenceImportPayload {
    pub source_file_name: String,
    pub source_file_hash: String,
    #[serde(default)]
    pub replace: bool,
    pub rows: Vec<CpCsvReferenceRow>,
}

#[derive(Debug, Serialize)]
pub struct CpCsvReferenceImportSummary {
    pub batch_id: Uuid,
    pub inserted_rows: usize,
    pub replaced_existing: bool,
}

pub async fn import_cp_csv_reference(
    pool: &PgPool,
    payload: CpCsvReferenceImportPayload,
) -> Result<CpCsvReferenceImportSummary, WorkbenchError> {
    if payload.rows.is_empty() {
        return Err(WorkbenchError::InvalidPayload(
            "rows cannot be empty".into(),
        ));
    }
    let source_file_name = payload.source_file_name.trim();
    if source_file_name.is_empty() {
        return Err(WorkbenchError::InvalidPayload(
            "source_file_name cannot be blank".into(),
        ));
    }

    let mut tx = pool.begin().await.map_err(WorkbenchError::Database)?;

    if payload.replace {
        sqlx::query("DELETE FROM counterpoint_csv_reference_batches")
            .execute(&mut *tx)
            .await
            .map_err(WorkbenchError::Database)?;
    }

    let batch_id: Uuid = if !payload.replace {
        let existing: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM counterpoint_csv_reference_batches WHERE source_file_hash = $1 AND status = 'active'"
        )
        .bind(payload.source_file_hash.trim())
        .fetch_optional(&mut *tx)
        .await
        .map_err(WorkbenchError::Database)?;

        if let Some(id) = existing {
            sqlx::query(
                "UPDATE counterpoint_csv_reference_batches SET row_count = row_count + $1 WHERE id = $2"
            )
            .bind(payload.rows.len() as i32)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(WorkbenchError::Database)?;
            id
        } else {
            sqlx::query_scalar(
                r#"
                INSERT INTO counterpoint_csv_reference_batches (source_file_name, source_file_hash, row_count, status)
                VALUES ($1, $2, $3, 'active')
                RETURNING id
                "#,
            )
            .bind(source_file_name)
            .bind(payload.source_file_hash.trim())
            .bind(payload.rows.len() as i32)
            .fetch_one(&mut *tx)
            .await
            .map_err(WorkbenchError::Database)?
        }
    } else {
        sqlx::query_scalar(
            r#"
            INSERT INTO counterpoint_csv_reference_batches (source_file_name, source_file_hash, row_count, status)
            VALUES ($1, $2, $3, 'active')
            RETURNING id
            "#,
        )
        .bind(source_file_name)
        .bind(payload.source_file_hash.trim())
        .bind(payload.rows.len() as i32)
        .fetch_one(&mut *tx)
        .await
        .map_err(WorkbenchError::Database)?
    };

    let mut inserted = 0usize;
    for chunk in payload.rows.chunks(3_000) {
        let mut builder = sqlx::QueryBuilder::<sqlx::Postgres>::new(
            r#"
            INSERT INTO counterpoint_csv_reference_rows (
                batch_id, source_row_number, item_no, description, long_description,
                category_code, barcode, retail_price, unit_cost, qty_on_hand,
                vendor_no, is_grid, raw_row
            )
            "#,
        );
        let empty_obj = serde_json::json!({});
        builder.push_values(chunk, |mut b, row| {
            b.push_bind(batch_id)
                .push_bind(row.source_row_number)
                .push_bind(row.item_no.trim())
                .push_bind(row.description.as_deref().map(str::trim))
                .push_bind(row.long_description.as_deref().map(str::trim))
                .push_bind(row.category_code.as_deref().map(str::trim))
                .push_bind(row.barcode.as_deref().map(str::trim))
                .push_bind(row.retail_price)
                .push_bind(row.unit_cost)
                .push_bind(row.qty_on_hand)
                .push_bind(row.vendor_no.as_deref().map(str::trim))
                .push_bind(row.is_grid.unwrap_or(false))
                .push_bind(row.raw_row.as_ref().unwrap_or(&empty_obj));
        });
        inserted += builder
            .build()
            .execute(&mut *tx)
            .await
            .map_err(WorkbenchError::Database)?
            .rows_affected() as usize;
    }

    tx.commit().await.map_err(WorkbenchError::Database)?;

    Ok(CpCsvReferenceImportSummary {
        batch_id,
        inserted_rows: inserted,
        replaced_existing: payload.replace,
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Multi-source merge preview
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct MergeConflictRow {
    pub item_no: String,
    pub field: String,
    pub ros_value: Option<String>,
    pub lightspeed_value: Option<String>,
    pub cp_csv_value: Option<String>,
    pub suggested_value: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MergePreviewSummary {
    pub total_ros_products: i64,
    pub total_lightspeed_rows: i64,
    pub total_cp_csv_rows: i64,
    pub name_conflicts: i64,
    pub category_conflicts: i64,
    pub price_conflicts: i64,
    pub conflicts: Vec<MergeConflictRow>,
}

pub async fn get_merge_preview(
    pool: &PgPool,
    limit: i32,
) -> Result<MergePreviewSummary, sqlx::Error> {
    let total_ros: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM products WHERE data_source = 'counterpoint'",
    )
    .fetch_one(pool)
    .await?;

    let total_ls: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint FROM lightspeed_normalization_reference_rows r
        JOIN lightspeed_normalization_batches b ON b.id = r.batch_id
        WHERE b.status = 'active'
        "#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    let total_cp_csv: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint FROM counterpoint_csv_reference_rows r
        JOIN counterpoint_csv_reference_batches b ON b.id = r.batch_id
        WHERE b.status = 'active'
        "#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    // Find name conflicts: ROS product name vs Lightspeed name vs CP CSV description
    let name_conflicts: Vec<MergeConflictRow> = sqlx::query_as::<_, (String, String, Option<String>, Option<String>)>(
        r#"
        WITH ros_items AS (
            SELECT p.id AS product_id, p.catalog_handle AS item_no, p.name AS ros_name
            FROM products p WHERE p.data_source = 'counterpoint' AND p.catalog_handle IS NOT NULL
        ),
        ls_items AS (
            SELECT p.id AS product_id, MAX(r.product_name) AS product_name
            FROM lightspeed_normalization_reference_rows r
            JOIN lightspeed_normalization_batches b ON b.id = r.batch_id
            JOIN products p ON p.data_source = 'counterpoint' AND p.catalog_handle IS NOT NULL AND (
                -- Strategy A: Tag Match (Lightspeed Tag = Counterpoint Item # I-XXXXX)
                lower(trim(r.tags)) = lower(trim(p.catalog_handle))
                OR r.tags LIKE '%' || p.catalog_handle || '%'
                -- Strategy B: SKU Match (Lightspeed SKU = Counterpoint Variant B-SKU Barcode)
                OR EXISTS (
                    SELECT 1 FROM product_variants pv
                    JOIN product_variant_barcode_aliases alias ON alias.variant_id = pv.id
                    WHERE pv.product_id = p.id
                      AND alias.alias_type = 'counterpoint_b_sku'
                      AND alias.status = 'active'
                      AND alias.normalized_alias = lower(trim(r.sku))
                )
            )
            WHERE b.status = 'active'
            GROUP BY p.id
        ),
        cp_csv_items AS (
            SELECT r.item_no, r.description
            FROM counterpoint_csv_reference_rows r
            JOIN counterpoint_csv_reference_batches b ON b.id = r.batch_id
            WHERE b.status = 'active'
        )
        SELECT
            ros.item_no,
            ros.ros_name,
            ls.product_name AS ls_name,
            csv.description AS csv_name
        FROM ros_items ros
        LEFT JOIN ls_items ls ON ls.product_id = ros.product_id
        LEFT JOIN cp_csv_items csv ON lower(trim(csv.item_no)) = lower(trim(ros.item_no))
        WHERE (ls.product_name IS NOT NULL AND lower(trim(ls.product_name)) != lower(trim(ros.ros_name)))
           OR (csv.description IS NOT NULL AND lower(trim(csv.description)) != lower(trim(ros.ros_name)))
        ORDER BY ros.item_no
        LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(item_no, ros_name, ls_name, csv_name)| MergeConflictRow {
        item_no,
        field: "name".to_string(),
        ros_value: Some(ros_name),
        lightspeed_value: ls_name,
        cp_csv_value: csv_name,
        suggested_value: None, // AI fills this in later
    })
    .collect();

    let name_conflict_count = name_conflicts.len() as i64;

    // Category conflicts: CP CSV category_code vs ROS category name
    let category_conflicts: Vec<MergeConflictRow> =
        sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
            r#"
        WITH ros_items AS (
            SELECT p.catalog_handle AS item_no,
                   c.name AS ros_category
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.data_source = 'counterpoint' AND p.catalog_handle IS NOT NULL
        ),
        cp_csv_items AS (
            SELECT r.item_no, r.category_code
            FROM counterpoint_csv_reference_rows r
            JOIN counterpoint_csv_reference_batches b ON b.id = r.batch_id
            WHERE b.status = 'active' AND r.category_code IS NOT NULL
        )
        SELECT
            ros.item_no,
            ros.ros_category,
            csv.category_code AS csv_category
        FROM ros_items ros
        INNER JOIN cp_csv_items csv ON lower(trim(csv.item_no)) = lower(trim(ros.item_no))
        WHERE ros.ros_category IS NULL
           OR lower(trim(coalesce(ros.ros_category, ''))) != lower(trim(csv.category_code))
        ORDER BY ros.item_no
        LIMIT $1
        "#,
        )
        .bind(limit)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(item_no, ros_cat, csv_cat)| MergeConflictRow {
            item_no,
            field: "category".to_string(),
            ros_value: ros_cat,
            lightspeed_value: None,
            cp_csv_value: csv_cat,
            suggested_value: None,
        })
        .collect();

    let category_conflict_count = category_conflicts.len() as i64;

    // Price conflicts: CP CSV retail_price vs ROS variant price
    let price_conflicts: Vec<MergeConflictRow> =
        sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
            r#"
        WITH ros_items AS (
            SELECT p.catalog_handle AS item_no,
                   pv.price::text AS ros_price
            FROM products p
            JOIN product_variants pv ON pv.product_id = p.id AND pv.is_default = true
            WHERE p.data_source = 'counterpoint' AND p.catalog_handle IS NOT NULL
        ),
        cp_csv_items AS (
            SELECT r.item_no, r.retail_price::text AS csv_price
            FROM counterpoint_csv_reference_rows r
            JOIN counterpoint_csv_reference_batches b ON b.id = r.batch_id
            WHERE b.status = 'active' AND r.retail_price IS NOT NULL
        )
        SELECT
            ros.item_no,
            ros.ros_price,
            csv.csv_price
        FROM ros_items ros
        INNER JOIN cp_csv_items csv ON lower(trim(csv.item_no)) = lower(trim(ros.item_no))
        WHERE ros.ros_price IS DISTINCT FROM csv.csv_price
        ORDER BY ros.item_no
        LIMIT $1
        "#,
        )
        .bind(limit)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(item_no, ros_price, csv_price)| MergeConflictRow {
            item_no,
            field: "price".to_string(),
            ros_value: ros_price,
            lightspeed_value: None,
            cp_csv_value: csv_price,
            suggested_value: None,
        })
        .collect();

    let price_conflict_count = price_conflicts.len() as i64;

    let mut all_conflicts = name_conflicts;
    all_conflicts.extend(category_conflicts);
    all_conflicts.extend(price_conflicts);

    Ok(MergePreviewSummary {
        total_ros_products: total_ros,
        total_lightspeed_rows: total_ls,
        total_cp_csv_rows: total_cp_csv,
        name_conflicts: name_conflict_count,
        category_conflicts: category_conflict_count,
        price_conflicts: price_conflict_count,
        conflicts: all_conflicts,
    })
}

// ────────────────────────────────────────────────────────────────────────────
// AI-assisted cleanup (sends to Gemma via RIVERSIDE_LLAMA_UPSTREAM)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct AiReviewRequest {
    pub scope: String, // "names" | "categories" | "variations"
    #[serde(default = "default_ai_limit")]
    pub limit: i32,
}

fn default_ai_limit() -> i32 {
    30
}

#[derive(Debug, Serialize)]
pub struct AiReviewItem {
    pub item_no: String,
    pub current_name: String,
    pub description: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AiReviewResponse {
    pub scope: String,
    pub items_sent: usize,
    pub ai_available: bool,
    pub suggestions: serde_json::Value,
    pub error: Option<String>,
}

pub async fn fetch_ai_review_items(
    pool: &PgPool,
    scope: &str,
    limit: i32,
) -> Result<Vec<AiReviewItem>, sqlx::Error> {
    match scope {
        "names" => {
            // Items with identifier-like names (I-XXXXX, B-XXXXX, pure numbers)
            let rows: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
                r#"
                SELECT
                    p.catalog_handle AS item_no,
                    p.name AS current_name,
                    COALESCE(
                        p.description,
                        NULLIF(
                            TRIM(
                                CONCAT(
                                    (SELECT COALESCE(r.description, r.long_description, '') FROM counterpoint_csv_reference_rows r WHERE r.item_no = p.catalog_handle LIMIT 1),
                                    (SELECT CASE WHEN r.category_code IS NOT NULL THEN CONCAT(' [CP Cat: ', r.category_code, ']') ELSE '' END FROM counterpoint_csv_reference_rows r WHERE r.item_no = p.catalog_handle LIMIT 1),
                                    (SELECT CASE WHEN r.product_name IS NOT NULL THEN CONCAT(' | LS Ref: ', r.product_name) ELSE '' END FROM lightspeed_normalization_reference_rows r INNER JOIN product_variants v ON v.product_id = p.id WHERE r.normalized_sku = lower(trim(both from v.sku)) LIMIT 1),
                                    (SELECT CASE WHEN r.product_category IS NOT NULL THEN CONCAT(' [LS Cat: ', r.product_category, ']') ELSE '' END FROM lightspeed_normalization_reference_rows r INNER JOIN product_variants v ON v.product_id = p.id WHERE r.normalized_sku = lower(trim(both from v.sku)) LIMIT 1)
                                )
                            ),
                            ''
                        )
                    ) AS description,
                    c.name AS category
                FROM products p
                LEFT JOIN categories c ON c.id = p.category_id
                WHERE p.data_source = 'counterpoint'
                  AND p.catalog_handle IS NOT NULL
                  AND (
                      p.name ~ '^[IiBb]-[0-9]'
                      OR p.name ~ '^\d{4,}$'
                      OR lower(p.name) LIKE 'unnamed counterpoint%'
                  )
                ORDER BY p.name
                LIMIT $1
                "#,
            )
            .bind(limit)
            .fetch_all(pool)
            .await?;

            Ok(rows
                .into_iter()
                .map(
                    |(item_no, current_name, description, category)| AiReviewItem {
                        item_no,
                        current_name,
                        description,
                        category,
                    },
                )
                .collect())
        }
        "categories" => {
            // Items without a category mapping
            let rows: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
                r#"
                SELECT
                    p.catalog_handle AS item_no,
                    p.name AS current_name,
                    COALESCE(
                        p.description,
                        NULLIF(
                            TRIM(
                                CONCAT(
                                    (SELECT COALESCE(r.description, r.long_description, '') FROM counterpoint_csv_reference_rows r WHERE r.item_no = p.catalog_handle LIMIT 1),
                                    (SELECT CASE WHEN r.category_code IS NOT NULL THEN CONCAT(' [CP Cat: ', r.category_code, ']') ELSE '' END FROM counterpoint_csv_reference_rows r WHERE r.item_no = p.catalog_handle LIMIT 1),
                                    (SELECT CASE WHEN r.product_name IS NOT NULL THEN CONCAT(' | LS Ref: ', r.product_name) ELSE '' END FROM lightspeed_normalization_reference_rows r INNER JOIN product_variants v ON v.product_id = p.id WHERE r.normalized_sku = lower(trim(both from v.sku)) LIMIT 1),
                                    (SELECT CASE WHEN r.product_category IS NOT NULL THEN CONCAT(' [LS Cat: ', r.product_category, ']') ELSE '' END FROM lightspeed_normalization_reference_rows r INNER JOIN product_variants v ON v.product_id = p.id WHERE r.normalized_sku = lower(trim(both from v.sku)) LIMIT 1)
                                )
                            ),
                            ''
                        )
                    ) AS description,
                    NULL::text AS category
                FROM products p
                WHERE p.data_source = 'counterpoint'
                  AND p.catalog_handle IS NOT NULL
                  AND p.category_id IS NULL
                ORDER BY p.name
                LIMIT $1
                "#,
            )
            .bind(limit)
            .fetch_all(pool)
            .await?;

            Ok(rows
                .into_iter()
                .map(|(item_no, current_name, description, _)| AiReviewItem {
                    item_no,
                    current_name,
                    description,
                    category: None,
                })
                .collect())
        }
        _ => Ok(Vec::new()),
    }
}

pub fn build_ai_prompt(scope: &str, items: &[AiReviewItem], category_list: &[String]) -> String {
    match scope {
        "names" => {
            let items_json = serde_json::to_string_pretty(items).unwrap_or_default();
            format!(
                r#"You are a retail inventory specialist for a formal menswear and bridal shop.

Given these Counterpoint product entries, suggest clean, human-readable product names.
Current names that look like part numbers (I-12345, B-67890) need real descriptive names.
Use the description and category as context.

Items:
{items_json}

Return ONLY a JSON array: [{{"item_no": "...", "suggested_name": "...", "confidence": 0.0-1.0, "reasoning": "..."}}]"#
            )
        }
        "categories" => {
            let cats = category_list.join(", ");
            let items_json = serde_json::to_string_pretty(items).unwrap_or_default();
            format!(
                r#"You are a retail inventory specialist for a formal menswear and bridal shop.

Given these products and the available ROS categories, suggest the best category for each.

Available categories: [{cats}]
Products:
{items_json}

Return ONLY a JSON array: [{{"item_no": "...", "suggested_category": "...", "confidence": 0.0-1.0}}]"#
            )
        }
        _ => String::new(),
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Batch apply AI suggestions (product name / category)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ApplySuggestionItem {
    pub item_no: String,
    #[serde(default)]
    pub new_name: Option<String>,
    #[serde(default)]
    pub new_category: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ApplySuggestionsPayload {
    pub suggestions: Vec<ApplySuggestionItem>,
}

#[derive(Debug, Serialize)]
pub struct ApplySuggestionsResult {
    pub names_updated: i32,
    pub categories_updated: i32,
    pub skipped: i32,
    pub errors: Vec<String>,
}

pub async fn apply_suggestions(
    pool: &PgPool,
    payload: ApplySuggestionsPayload,
) -> Result<ApplySuggestionsResult, WorkbenchError> {
    let mut names_updated = 0i32;
    let mut categories_updated = 0i32;
    let mut skipped = 0i32;
    let mut errors = Vec::new();

    let mut tx = pool.begin().await.map_err(WorkbenchError::Database)?;

    for item in &payload.suggestions {
        let item_no = item.item_no.trim();
        if item_no.is_empty() {
            skipped += 1;
            continue;
        }

        // Find product by catalog_handle
        let product_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM products WHERE catalog_handle = $1 AND data_source = 'counterpoint' LIMIT 1",
        )
        .bind(item_no)
        .fetch_optional(&mut *tx)
        .await
        .map_err(WorkbenchError::Database)?;

        let Some(pid) = product_id else {
            skipped += 1;
            errors.push(format!("{item_no}: product not found"));
            continue;
        };

        // Update name
        if let Some(new_name) = &item.new_name {
            let name = new_name.trim();
            if !name.is_empty() {
                sqlx::query("UPDATE products SET name = $1 WHERE id = $2")
                    .bind(name)
                    .bind(pid)
                    .execute(&mut *tx)
                    .await
                    .map_err(WorkbenchError::Database)?;
                names_updated += 1;
            }
        }

        // Update category by name
        if let Some(new_cat) = &item.new_category {
            let cat_name = new_cat.trim();
            if !cat_name.is_empty() {
                let cat_id: Option<Uuid> = sqlx::query_scalar(
                    "SELECT id FROM categories WHERE lower(name) = lower($1) LIMIT 1",
                )
                .bind(cat_name)
                .fetch_optional(&mut *tx)
                .await
                .map_err(WorkbenchError::Database)?;

                if let Some(cid) = cat_id {
                    sqlx::query("UPDATE products SET category_id = $1 WHERE id = $2")
                        .bind(cid)
                        .bind(pid)
                        .execute(&mut *tx)
                        .await
                        .map_err(WorkbenchError::Database)?;
                    categories_updated += 1;
                } else {
                    errors.push(format!("{item_no}: category '{cat_name}' not found in ROS"));
                }
            }
        }
    }

    tx.commit().await.map_err(WorkbenchError::Database)?;

    Ok(ApplySuggestionsResult {
        names_updated,
        categories_updated,
        skipped,
        errors,
    })
}

// ────────────────────────────────────────────────────────────────────────────
// CP CSV health summary (for data-sources step)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct CpCsvHealthSummary {
    pub has_active_batch: bool,
    pub row_count: i64,
    pub source_file_name: Option<String>,
    pub imported_at: Option<DateTime<Utc>>,
}

pub async fn get_cp_csv_health(pool: &PgPool) -> Result<CpCsvHealthSummary, sqlx::Error> {
    let row: Option<(String, i32, DateTime<Utc>)> = sqlx::query_as(
        r#"
        SELECT source_file_name, row_count, imported_at
        FROM counterpoint_csv_reference_batches
        WHERE status = 'active'
        ORDER BY imported_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await?;

    match row {
        Some((name, count, imported_at)) => Ok(CpCsvHealthSummary {
            has_active_batch: true,
            row_count: count as i64,
            source_file_name: Some(name),
            imported_at: Some(imported_at),
        }),
        None => Ok(CpCsvHealthSummary {
            has_active_batch: false,
            row_count: 0,
            source_file_name: None,
            imported_at: None,
        }),
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Data sources health (aggregated for step 1)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct DataSourcesHealth {
    pub bridge_products: i64,
    pub lightspeed_rows: i64,
    pub lightspeed_file: Option<String>,
    pub cp_csv_rows: i64,
    pub cp_csv_file: Option<String>,
}

pub async fn get_data_sources_health(pool: &PgPool) -> Result<DataSourcesHealth, sqlx::Error> {
    let bridge_products: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM products WHERE data_source = 'counterpoint'",
    )
    .fetch_one(pool)
    .await?;

    // Lightspeed
    let ls: Option<(String, i64)> = sqlx::query_as(
        r#"
        SELECT b.source_file_name, COUNT(r.id)::bigint
        FROM lightspeed_normalization_batches b
        JOIN lightspeed_normalization_reference_rows r ON r.batch_id = b.id
        WHERE b.status = 'active'
        GROUP BY b.source_file_name
        ORDER BY MAX(b.imported_at) DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await?;

    // CP CSV
    let cp: Option<(String, i64)> = sqlx::query_as(
        r#"
        SELECT b.source_file_name, COUNT(r.id)::bigint
        FROM counterpoint_csv_reference_batches b
        JOIN counterpoint_csv_reference_rows r ON r.batch_id = b.id
        WHERE b.status = 'active'
        GROUP BY b.source_file_name
        ORDER BY MAX(b.imported_at) DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await?;

    Ok(DataSourcesHealth {
        bridge_products,
        lightspeed_rows: ls.as_ref().map_or(0, |r| r.1),
        lightspeed_file: ls.map(|r| r.0),
        cp_csv_rows: cp.as_ref().map_or(0, |r| r.1),
        cp_csv_file: cp.map(|r| r.0),
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum WorkbenchError {
    #[error("invalid step: {0}")]
    InvalidStep(String),
    #[error("step '{0}' is locked — complete the previous step first")]
    StepLocked(String),
    #[error("step '{0}' is already approved")]
    AlreadyApproved(String),
    #[error("invalid payload: {0}")]
    InvalidPayload(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}
