//! Inventory / SKU resolution: barcode → cart-ready row with tax and employee pricing.

use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

use crate::logic::pricing::employee_sale_unit_price_usd;
use crate::logic::tax::{erie_local_tax_usd, nys_state_tax_usd, TaxCategory};

/// Inventory / SKU resolution failures (map to HTTP 404 vs 5xx at the API boundary).
#[derive(Debug, Error)]
pub enum InventoryError {
    #[error("Product '{0}' not found or is inactive")]
    SkuNotFound(String),
    #[error("{0}")]
    AmbiguousProduct(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Fully calculated line ready for POS cart state (standard retail + taxes + employee price).
#[derive(Debug, Serialize)]
pub struct ResolvedSkuItem {
    pub product_id: Uuid,
    pub variant_id: Uuid,
    /// NYS §3.3 classification used for tax.
    pub tax_category: TaxCategory,
    pub sku: String,
    pub name: String,
    pub variation_label: Option<String>,
    /// Physical units in the store (On Hand).
    pub stock_on_hand: i32,
    /// Units in store promised to open special/custom orders (Reserved).
    pub reserved_stock: i32,
    /// Units available for walk-in sale: stock_on_hand - reserved_stock.
    pub available_stock: i32,

    pub standard_retail_price: Decimal,
    pub employee_price: Decimal,
    pub unit_cost: Decimal,
    /// Product `category_id` (for promotion scope checks on the client).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_id: Option<Uuid>,
    /// Product `primary_vendor_id` (for vendor-scoped promotions on the client).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_vendor_id: Option<Uuid>,
    pub spiff_amount: Decimal,

    /// Per-unit state tax on `standard_retail_price` (§3.3 rate selection uses that net price).
    pub state_tax: Decimal,
    /// Per-unit local tax on `standard_retail_price`.
    pub local_tax: Decimal,
    /// `rms_charge_payment` when this SKU is the R2S payment collection line; drives checkout rules.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos_line_kind: Option<String>,
}

/// Raw row from `product_variants` ⟕ `products`.
#[derive(Debug, sqlx::FromRow)]
struct SkuJoinRow {
    variant_id: Uuid,
    product_id: Uuid,
    sku: String,
    variation_label: Option<String>,
    stock_on_hand: i32,
    reserved_stock: i32,
    retail_price_override: Option<Decimal>,
    cost_override: Option<Decimal>,

    product_name: String,
    resolved_category_name: Option<String>,
    resolved_is_clothing_footwear: bool,
    base_retail_price: Decimal,
    base_cost: Decimal,
    spiff_amount: Decimal,
    pos_line_kind: Option<String>,
    category_id: Option<Uuid>,
    primary_vendor_id: Option<Uuid>,
    employee_markup_percent: Option<Decimal>,
    employee_extra_amount: Decimal,
}

const SKU_JOIN_FROM: &str = r#"
        SELECT
            v.id AS variant_id,
            v.product_id,
            v.sku,
            v.variation_label,
            v.stock_on_hand,
            v.reserved_stock,
            v.retail_price_override,
            v.cost_override,
            p.name AS product_name,
            rc.resolved_category_name,
            COALESCE(rc.resolved_is_clothing_footwear, false) AS resolved_is_clothing_footwear,
            p.base_retail_price,
            p.base_cost,
            p.spiff_amount,
            p.pos_line_kind,
            p.category_id,
            p.primary_vendor_id,
            p.employee_markup_percent,
            COALESCE(p.employee_extra_amount, 0::numeric) AS employee_extra_amount
        FROM product_variants v
        JOIN products p ON v.product_id = p.id
        LEFT JOIN LATERAL (
            WITH RECURSIVE cat_path AS (
                SELECT c.id, c.name, c.is_clothing_footwear, c.parent_id, 0 AS depth
                FROM categories c
                WHERE c.id = p.category_id
                UNION ALL
                SELECT parent.id, parent.name, parent.is_clothing_footwear, parent.parent_id, cat_path.depth + 1
                FROM categories parent
                JOIN cat_path ON cat_path.parent_id = parent.id
                WHERE cat_path.depth < 16
            )
            SELECT
                cp.name AS resolved_category_name,
                cp.is_clothing_footwear AS resolved_is_clothing_footwear
            FROM cat_path cp
            WHERE cp.is_clothing_footwear = true
            ORDER BY cp.depth
            LIMIT 1
        ) rc ON true
"#;

fn ilike_contains_pattern(raw: &str) -> String {
    let mut esc = String::new();
    for c in raw.chars() {
        match c {
            '\\' | '%' | '_' => {
                esc.push('\\');
                esc.push(c);
            }
            _ => esc.push(c),
        }
    }
    format!("%{esc}%")
}

async fn fetch_variants_where(
    pool: &PgPool,
    condition: &str,
    bind: &str,
    limit: i64,
) -> Result<Vec<SkuJoinRow>, sqlx::Error> {
    let sql = format!(
        "{} WHERE p.is_active = true AND ({}) LIMIT {}",
        SKU_JOIN_FROM.trim(),
        condition,
        limit
    );
    sqlx::query_as::<_, SkuJoinRow>(&sql)
        .bind(bind)
        .fetch_all(pool)
        .await
}

fn join_row_to_resolved(
    row: SkuJoinRow,
    global_employee_markup_percent: Decimal,
) -> ResolvedSkuItem {
    let effective_retail = crate::logic::template_variant_pricing::effective_retail_usd(
        row.base_retail_price,
        row.retail_price_override,
    );
    let effective_cost = crate::logic::template_variant_pricing::effective_cost_usd(
        row.base_cost,
        row.cost_override,
    );

    let logic_tax_cat: TaxCategory = if row.resolved_is_clothing_footwear {
        let category_name = row
            .resolved_category_name
            .unwrap_or_default()
            .to_lowercase();
        if category_name.contains("shoe") || category_name.contains("footwear") {
            TaxCategory::Footwear
        } else {
            TaxCategory::Clothing
        }
    } else {
        TaxCategory::Other
    };

    let is_rms_payment = row.pos_line_kind.as_deref() == Some("rms_charge_payment");
    let is_pos_gc_load = row.pos_line_kind.as_deref() == Some("pos_gift_card_load");
    let is_alteration_service = row.pos_line_kind.as_deref() == Some("alteration_service");
    let (state_tax, local_tax) = if is_rms_payment || is_pos_gc_load || is_alteration_service {
        (Decimal::ZERO, Decimal::ZERO)
    } else {
        (
            nys_state_tax_usd(logic_tax_cat, effective_retail, effective_retail),
            erie_local_tax_usd(logic_tax_cat, effective_retail, effective_retail),
        )
    };

    let markup_pct = row
        .employee_markup_percent
        .unwrap_or(global_employee_markup_percent);
    let extra_amt = row.employee_extra_amount.max(Decimal::ZERO);
    let employee_price = employee_sale_unit_price_usd(effective_cost, markup_pct, extra_amt);

    ResolvedSkuItem {
        product_id: row.product_id,
        variant_id: row.variant_id,
        tax_category: logic_tax_cat,
        sku: row.sku,
        name: row.product_name,
        variation_label: row.variation_label,
        stock_on_hand: row.stock_on_hand,
        reserved_stock: row.reserved_stock,
        available_stock: (row.stock_on_hand - row.reserved_stock).max(0),
        standard_retail_price: effective_retail,
        employee_price,
        unit_cost: effective_cost,
        category_id: row.category_id,
        primary_vendor_id: row.primary_vendor_id,
        spiff_amount: row.spiff_amount,
        state_tax,
        local_tax,
        pos_line_kind: row.pos_line_kind.clone(),
    }
}

/// Resolve POS entry by **SKU** (case-insensitive), **barcode** (when set on variant),
/// **catalog handle**, or **product name** (substring, min 3 chars). Name matches must be unique.
pub async fn resolve_sku(
    pool: &PgPool,
    raw: &str,
    global_employee_markup_percent: Decimal,
) -> Result<ResolvedSkuItem, InventoryError> {
    let needle = raw.trim();
    if needle.is_empty() {
        return Err(InventoryError::SkuNotFound(raw.to_string()));
    }

    let try_unique = |rows: Vec<SkuJoinRow>, label: &str| -> Result<SkuJoinRow, InventoryError> {
        match rows.len() {
            0 => Err(InventoryError::SkuNotFound(needle.to_string())),
            1 => rows
                .into_iter()
                .next()
                .ok_or_else(|| InventoryError::SkuNotFound(needle.to_string())),
            _ => Err(InventoryError::AmbiguousProduct(format!(
                "Multiple products match {label}; use SKU or a more specific name"
            ))),
        }
    };

    // 1) SKU (case-insensitive, trimmed)
    let by_sku = fetch_variants_where(pool, "lower(btrim(v.sku)) = lower(btrim($1))", needle, 2)
        .await
        .map_err(InventoryError::Database)?;
    if !by_sku.is_empty() {
        let row = try_unique(by_sku, "SKU")?;
        return Ok(join_row_to_resolved(row, global_employee_markup_percent));
    }

    // 2) Barcode / UPC on variant (optional column)
    let by_bc = fetch_variants_where(
        pool,
        "v.barcode IS NOT NULL AND btrim(v.barcode) <> '' AND lower(btrim(v.barcode)) = lower(btrim($1))",
        needle,
        2,
    )
    .await
    .map_err(InventoryError::Database)?;
    if !by_bc.is_empty() {
        let row = try_unique(by_bc, "barcode")?;
        return Ok(join_row_to_resolved(row, global_employee_markup_percent));
    }

    // 3) Product catalog handle
    let by_handle = fetch_variants_where(
        pool,
        "p.catalog_handle IS NOT NULL AND btrim(p.catalog_handle::text) <> '' \
         AND lower(btrim(p.catalog_handle::text)) = lower(btrim($1))",
        needle,
        2,
    )
    .await
    .map_err(InventoryError::Database)?;
    if !by_handle.is_empty() {
        let row = try_unique(by_handle, "catalog handle")?;
        return Ok(join_row_to_resolved(row, global_employee_markup_percent));
    }

    // 4) Product name (title) — substring, must be unique
    if needle.chars().count() < 3 {
        return Err(InventoryError::SkuNotFound(needle.to_string()));
    }
    let pat = ilike_contains_pattern(needle);
    let by_name = fetch_variants_where(pool, "p.name ILIKE $1 ESCAPE '\\'", &pat, 3)
        .await
        .map_err(InventoryError::Database)?;
    match by_name.len() {
        0 => Err(InventoryError::SkuNotFound(needle.to_string())),
        1 => {
            let row = by_name
                .into_iter()
                .next()
                .ok_or_else(|| InventoryError::SkuNotFound(needle.to_string()))?;
            Ok(join_row_to_resolved(row, global_employee_markup_percent))
        }
        _ => Err(InventoryError::AmbiguousProduct(
            "Several products match that name; refine search or enter SKU / barcode".to_string(),
        )),
    }
}

/// Load a single active variant for checkout validation.
/// The cart may send a stale `product_id`; resolution is by `variant_id` only (catalog wins).
pub async fn fetch_variant_by_ids(
    pool: &PgPool,
    variant_id: Uuid,
    _product_id: Uuid,
    global_employee_markup_percent: Decimal,
) -> Result<ResolvedSkuItem, InventoryError> {
    resolve_variant_by_id(pool, variant_id, global_employee_markup_percent).await
}

/// Resolve an active variant by id. Safe to run on a [`sqlx::Transaction`] after row locks.
pub async fn resolve_variant_by_id<'e, E>(
    executor: E,
    variant_id: Uuid,
    global_employee_markup_percent: Decimal,
) -> Result<ResolvedSkuItem, InventoryError>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let sql = format!(
        "{} WHERE p.is_active = true AND v.id = $1 LIMIT 1",
        SKU_JOIN_FROM.trim()
    );
    let row: Option<SkuJoinRow> = sqlx::query_as(&sql)
        .bind(variant_id)
        .fetch_optional(executor)
        .await
        .map_err(InventoryError::Database)?;
    let Some(row) = row else {
        return Err(InventoryError::SkuNotFound(variant_id.to_string()));
    };
    Ok(join_row_to_resolved(row, global_employee_markup_percent))
}
