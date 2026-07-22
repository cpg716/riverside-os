//! Inventory / SKU resolution: barcode → cart-ready row with tax and employee pricing.

use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::{PgConnection, PgPool};
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
    /// Authoritative match path used by exact-scan mutation callers. Product-name
    /// matches are intentionally distinguishable from SKU/barcode identifiers.
    pub resolution_kind: SkuResolutionKind,
    /// Physical units in the store (On Hand).
    pub stock_on_hand: i32,
    /// Units in store promised to open special/custom orders (Reserved).
    pub reserved_stock: i32,
    /// Units available for walk-in sale: stock_on_hand - reserved_stock - on_layaway.
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

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkuResolutionKind {
    VariantId,
    Sku,
    Barcode,
    BarcodeAlias,
    CatalogHandle,
    VendorUpc,
    ProductName,
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
    on_layaway: i32,
    retail_price_override: Option<Decimal>,
    cost_override: Option<Decimal>,

    product_name: String,
    resolved_category_name: Option<String>,
    resolved_is_clothing_footwear: bool,
    base_retail_price: Decimal,
    base_cost: Decimal,
    spiff_amount: Decimal,
    pos_line_kind: Option<String>,
    tax_category_override: Option<TaxCategory>,
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
            v.on_layaway,
            v.retail_price_override,
            v.cost_override,
            p.name AS product_name,
            rc.resolved_category_name,
            COALESCE(rc.resolved_is_clothing_footwear, false) AS resolved_is_clothing_footwear,
            p.base_retail_price,
            p.base_cost,
            p.spiff_amount,
            p.pos_line_kind,
            p.tax_category_override,
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
    resolution_kind: SkuResolutionKind,
) -> ResolvedSkuItem {
    let effective_retail = crate::logic::template_variant_pricing::effective_retail_usd(
        row.base_retail_price,
        row.retail_price_override,
    );
    let effective_cost = crate::logic::template_variant_pricing::effective_cost_usd(
        row.base_cost,
        row.cost_override,
    );

    let logic_tax_cat: TaxCategory = if let Some(override_category) = row.tax_category_override {
        override_category
    } else if row.resolved_is_clothing_footwear {
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
        resolution_kind,
        stock_on_hand: row.stock_on_hand,
        reserved_stock: row.reserved_stock,
        available_stock: available_stock_units(
            row.stock_on_hand,
            row.reserved_stock,
            row.on_layaway,
        ),
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

pub fn available_stock_units(stock_on_hand: i32, reserved_stock: i32, on_layaway: i32) -> i32 {
    (stock_on_hand - reserved_stock - on_layaway).max(0)
}

#[cfg(test)]
mod tests {
    use super::{
        available_stock_units, resolve_receiving_identifier_on_connection, InventoryError,
        SkuResolutionKind,
    };
    use rust_decimal::Decimal;
    use sqlx::PgPool;
    use uuid::Uuid;

    #[test]
    fn available_stock_subtracts_reserved_and_layaway() {
        assert_eq!(available_stock_units(10, 3, 2), 5);
    }

    #[test]
    fn available_stock_never_reports_negative_sellable_units() {
        assert_eq!(available_stock_units(2, 3, 4), 0);
    }

    #[test]
    fn exact_scan_resolution_kind_is_machine_readable() {
        assert_eq!(
            serde_json::to_value(SkuResolutionKind::BarcodeAlias).expect("serialize resolution"),
            serde_json::json!("barcode_alias")
        );
        assert_eq!(
            serde_json::to_value(SkuResolutionKind::ProductName).expect("serialize resolution"),
            serde_json::json!("product_name")
        );
        assert_eq!(
            serde_json::to_value(SkuResolutionKind::VendorUpc).expect("serialize resolution"),
            serde_json::json!("vendor_upc")
        );
    }

    #[tokio::test]
    #[ignore = "requires an isolated migrated test database"]
    async fn receiving_identifier_rejects_cross_namespace_and_duplicate_vendor_upcs() {
        let database_url = std::env::var("TEST_DATABASE_URL")
            .expect("TEST_DATABASE_URL must name an isolated migrated test database");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect receiving resolver test database");
        let mut tx = pool.begin().await.expect("begin receiving resolver test");
        let suffix = Uuid::new_v4().simple().to_string();
        let collision_code = format!("receive-collision-{suffix}");
        let duplicate_vendor_upc = format!("receive-vendor-dup-{suffix}");
        let catalog_code = format!("receive-catalog-{suffix}");
        let vendor_id = Uuid::new_v4();
        let other_vendor_id = Uuid::new_v4();
        let purchase_order_id = Uuid::new_v4();
        let product_ids = [
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        ];
        let variant_ids = [
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        ];

        sqlx::query(
            r#"
            INSERT INTO vendors (id, name, is_active, use_vendor_upc)
            VALUES ($1, $2, TRUE, TRUE), ($3, $4, TRUE, FALSE)
            "#,
        )
        .bind(vendor_id)
        .bind(format!("Receiving Resolver Vendor {suffix}"))
        .bind(other_vendor_id)
        .bind(format!("Receiving Resolver Other Vendor {suffix}"))
        .execute(&mut *tx)
        .await
        .expect("insert receiving resolver vendors");

        sqlx::query(
            r#"
            INSERT INTO purchase_orders (id, po_number, vendor_id, status, po_kind)
            VALUES ($1, $2, $3, 'draft', 'standard')
            "#,
        )
        .bind(purchase_order_id)
        .bind(format!("PO-RECEIVE-RESOLVER-{suffix}"))
        .bind(vendor_id)
        .execute(&mut *tx)
        .await
        .expect("insert receiving resolver purchase order");

        for (index, product_id) in product_ids.iter().enumerate() {
            let primary_vendor_id = if index == 2 || index == 3 {
                other_vendor_id
            } else {
                vendor_id
            };
            let pos_line_kind = (index == 4).then_some("rms_charge_payment");
            sqlx::query(
                r#"
                INSERT INTO products (
                    id, name, base_retail_price, base_cost, primary_vendor_id, is_active,
                    pos_line_kind, catalog_handle
                )
                VALUES ($1, $2, 100.00, 40.00, $3, TRUE, $4, $5)
                "#,
            )
            .bind(product_id)
            .bind(format!("Receiving Resolver Product {index} {suffix}"))
            .bind(primary_vendor_id)
            .bind(pos_line_kind)
            .bind((index == 0).then_some(catalog_code.as_str()))
            .execute(&mut *tx)
            .await
            .expect("insert receiving resolver product");
        }

        sqlx::query(
            "INSERT INTO product_secondary_vendors (product_id, vendor_id) VALUES ($1, $2)",
        )
        .bind(product_ids[2])
        .bind(vendor_id)
        .execute(&mut *tx)
        .await
        .expect("link receiving resolver secondary vendor");

        for (index, (variant_id, product_id, sku, vendor_upc)) in [
            (
                variant_ids[0],
                product_ids[0],
                collision_code.clone(),
                duplicate_vendor_upc.clone(),
            ),
            (
                variant_ids[1],
                product_ids[1],
                format!("receive-sku-b-{suffix}"),
                collision_code.clone(),
            ),
            (
                variant_ids[2],
                product_ids[2],
                format!("receive-secondary-{suffix}"),
                duplicate_vendor_upc.clone(),
            ),
            (
                variant_ids[3],
                product_ids[3],
                format!("receive-outside-{suffix}"),
                format!("receive-outside-upc-{suffix}"),
            ),
            (
                variant_ids[4],
                product_ids[4],
                format!("receive-service-{suffix}"),
                format!("receive-service-upc-{suffix}"),
            ),
            (
                variant_ids[5],
                product_ids[0],
                format!("receive-catalog-sibling-{suffix}"),
                format!("receive-catalog-sibling-upc-{suffix}"),
            ),
        ]
        .into_iter()
        .enumerate()
        {
            sqlx::query(
                r#"
                INSERT INTO product_variants (
                    id, product_id, sku, vendor_upc, variation_values, variation_label
                )
                VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)
                "#,
            )
            .bind(variant_id)
            .bind(product_id)
            .bind(sku)
            .bind(vendor_upc)
            .bind(format!("Test {index}"))
            .execute(&mut *tx)
            .await
            .expect("insert receiving resolver variation");
        }

        sqlx::query(
            r#"
            INSERT INTO purchase_order_lines (
                purchase_order_id, variant_id, quantity_ordered, unit_cost
            )
            VALUES ($1, $2, 1, 40.00)
            "#,
        )
        .bind(purchase_order_id)
        .bind(variant_ids[0])
        .execute(&mut *tx)
        .await
        .expect("insert contextual catalog PO line");

        let contextual_catalog = resolve_receiving_identifier_on_connection(
            &mut *tx,
            &catalog_code,
            vendor_id,
            purchase_order_id,
            Decimal::ZERO,
        )
        .await
        .expect("one current PO variation disambiguates a shared product catalog number");
        assert_eq!(contextual_catalog.variant_id, variant_ids[0]);

        sqlx::query(
            "DELETE FROM purchase_order_lines WHERE purchase_order_id = $1 AND variant_id = $2",
        )
        .bind(purchase_order_id)
        .bind(variant_ids[0])
        .execute(&mut *tx)
        .await
        .expect("remove contextual catalog PO line");
        assert!(matches!(
            resolve_receiving_identifier_on_connection(
                &mut *tx,
                &catalog_code,
                vendor_id,
                purchase_order_id,
                Decimal::ZERO,
            )
            .await,
            Err(InventoryError::AmbiguousProduct(_))
        ));

        assert!(matches!(
            resolve_receiving_identifier_on_connection(
                &mut *tx,
                &collision_code,
                vendor_id,
                purchase_order_id,
                Decimal::ZERO,
            )
            .await,
            Err(InventoryError::AmbiguousProduct(_))
        ));
        assert!(matches!(
            resolve_receiving_identifier_on_connection(
                &mut *tx,
                &duplicate_vendor_upc,
                vendor_id,
                purchase_order_id,
                Decimal::ZERO,
            )
            .await,
            Err(InventoryError::AmbiguousProduct(_))
        ));

        let secondary = resolve_receiving_identifier_on_connection(
            &mut *tx,
            &format!("receive-secondary-{suffix}"),
            vendor_id,
            purchase_order_id,
            Decimal::ZERO,
        )
        .await
        .expect("secondary-vendor variation remains eligible");
        assert_eq!(secondary.variant_id, variant_ids[2]);
        for rejected_code in [
            format!("receive-outside-{suffix}"),
            format!("receive-service-{suffix}"),
        ] {
            assert!(matches!(
                resolve_receiving_identifier_on_connection(
                    &mut *tx,
                    &rejected_code,
                    vendor_id,
                    purchase_order_id,
                    Decimal::ZERO,
                )
                .await,
                Err(InventoryError::SkuNotFound(_))
            ));
        }

        sqlx::query("UPDATE vendors SET use_vendor_upc = FALSE WHERE id = $1")
            .bind(vendor_id)
            .execute(&mut *tx)
            .await
            .expect("disable receiving vendor UPC");
        let sku_match = resolve_receiving_identifier_on_connection(
            &mut *tx,
            &collision_code,
            vendor_id,
            purchase_order_id,
            Decimal::ZERO,
        )
        .await
        .expect("SKU remains exact when vendor UPC is disabled");
        assert_eq!(sku_match.variant_id, variant_ids[0]);

        tx.rollback()
            .await
            .expect("rollback receiving resolver test");
    }
}

/// Resolve POS entry by **SKU** (case-insensitive), **barcode** (when set on variant),
/// active barcode alias, **catalog handle**, or **product name** (substring, min 3 chars).
/// Exact identifiers must resolve to one variation across every identifier namespace;
/// name matches must also be unique.
pub async fn resolve_sku(
    pool: &PgPool,
    raw: &str,
    global_employee_markup_percent: Decimal,
) -> Result<ResolvedSkuItem, InventoryError> {
    let needle = raw.trim();
    if needle.is_empty() {
        return Err(InventoryError::SkuNotFound(raw.to_string()));
    }

    let exact_matches: Vec<(Uuid, i32)> = sqlx::query_as(
        r#"
        WITH identifier_matches AS (
            SELECT v.id AS variant_id, 1 AS priority
            FROM product_variants v
            INNER JOIN products p ON p.id = v.product_id
            WHERE p.is_active = TRUE
              AND LOWER(BTRIM(v.sku)) = LOWER(BTRIM($1))

            UNION ALL

            SELECT v.id AS variant_id, 2 AS priority
            FROM product_variants v
            INNER JOIN products p ON p.id = v.product_id
            WHERE p.is_active = TRUE
              AND NULLIF(BTRIM(v.barcode), '') IS NOT NULL
              AND LOWER(BTRIM(v.barcode)) = LOWER(BTRIM($1))

            UNION ALL

            SELECT v.id AS variant_id, 3 AS priority
            FROM product_variant_barcode_aliases alias
            INNER JOIN product_variants v ON v.id = alias.variant_id
            INNER JOIN products p ON p.id = v.product_id
            WHERE p.is_active = TRUE
              AND alias.status = 'active'
              AND alias.normalized_alias = LOWER(BTRIM($1))

            UNION ALL

            SELECT v.id AS variant_id, 4 AS priority
            FROM product_variants v
            INNER JOIN products p ON p.id = v.product_id
            WHERE p.is_active = TRUE
              AND NULLIF(BTRIM(p.catalog_handle::text), '') IS NOT NULL
              AND LOWER(BTRIM(p.catalog_handle::text)) = LOWER(BTRIM($1))
        )
        SELECT variant_id, MIN(priority)::int AS resolution_priority
        FROM identifier_matches
        GROUP BY variant_id
        ORDER BY MIN(priority), variant_id
        LIMIT 3
        "#,
    )
    .bind(needle)
    .fetch_all(pool)
    .await
    .map_err(InventoryError::Database)?;

    if exact_matches.len() > 1 {
        return Err(InventoryError::AmbiguousProduct(
            "That identifier matches multiple active variations. Use the item picker and choose the intended variation."
                .to_string(),
        ));
    }
    if let Some((variant_id, priority)) = exact_matches.into_iter().next() {
        let resolution_kind = match priority {
            1 => SkuResolutionKind::Sku,
            2 => SkuResolutionKind::Barcode,
            3 => SkuResolutionKind::BarcodeAlias,
            4 => SkuResolutionKind::CatalogHandle,
            _ => {
                return Err(InventoryError::AmbiguousProduct(
                    "The item identifier could not be classified safely.".to_string(),
                ))
            }
        };
        let mut resolved =
            resolve_variant_by_id(pool, variant_id, global_employee_markup_percent).await?;
        resolved.resolution_kind = resolution_kind;
        return Ok(resolved);
    }

    // Product name (title) — substring, must be unique and never treated as a scan identifier.
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
            Ok(join_row_to_resolved(
                row,
                global_employee_markup_percent,
                SkuResolutionKind::ProductName,
            ))
        }
        _ => Err(InventoryError::AmbiguousProduct(
            "Several products match that name; refine search or enter SKU / barcode".to_string(),
        )),
    }
}

/// Resolve one exact receiving identifier across every enabled namespace.
/// Vendor UPC participates only when the selected vendor explicitly enables it;
/// a code shared by different active variations is always rejected as ambiguous.
pub async fn resolve_receiving_identifier(
    pool: &PgPool,
    raw: &str,
    vendor_id: Uuid,
    purchase_order_id: Uuid,
    global_employee_markup_percent: Decimal,
) -> Result<ResolvedSkuItem, InventoryError> {
    let mut connection = pool.acquire().await.map_err(InventoryError::Database)?;
    resolve_receiving_identifier_on_connection(
        &mut connection,
        raw,
        vendor_id,
        purchase_order_id,
        global_employee_markup_percent,
    )
    .await
}

async fn resolve_receiving_identifier_on_connection(
    connection: &mut PgConnection,
    raw: &str,
    vendor_id: Uuid,
    purchase_order_id: Uuid,
    global_employee_markup_percent: Decimal,
) -> Result<ResolvedSkuItem, InventoryError> {
    let needle = raw.trim();
    if needle.is_empty() {
        return Err(InventoryError::SkuNotFound(raw.to_string()));
    }

    let exact_matches: Vec<(Uuid, i32)> = sqlx::query_as(
        r#"
        WITH receiving_context AS MATERIALIZED (
            SELECT
                po.id,
                COALESCE(vendor.use_vendor_upc, FALSE) AS use_vendor_upc
            FROM purchase_orders po
            INNER JOIN vendors vendor ON vendor.id = po.vendor_id
            WHERE po.id = $3
              AND po.vendor_id = $2
              AND vendor.is_active = TRUE
              AND po.status IN ('draft', 'submitted', 'partially_received')
        ),
        po_catalog_matches AS MATERIALIZED (
            SELECT DISTINCT v.id AS variant_id
            FROM receiving_context context
            INNER JOIN purchase_order_lines line ON line.purchase_order_id = context.id
            INNER JOIN product_variants v ON v.id = line.variant_id
            INNER JOIN products p ON p.id = v.product_id
            WHERE p.is_active = TRUE
              AND p.pos_line_kind IS NULL
              AND p.catalog_handle IS NOT NULL
              AND BTRIM(p.catalog_handle) <> ''
              AND LOWER(BTRIM(p.catalog_handle)) = LOWER(BTRIM($1))
        ),
        identifier_candidates AS NOT MATERIALIZED (
            SELECT v.id AS variant_id, 1 AS priority
            FROM product_variants v
            INNER JOIN products p ON p.id = v.product_id
            WHERE p.is_active = TRUE
              AND p.pos_line_kind IS NULL
              AND LOWER(BTRIM(v.sku)) = LOWER(BTRIM($1))
              AND EXISTS (SELECT 1 FROM receiving_context)

            UNION ALL

            SELECT v.id AS variant_id, 2 AS priority
            FROM product_variants v
            INNER JOIN products p ON p.id = v.product_id
            WHERE p.is_active = TRUE
              AND p.pos_line_kind IS NULL
              AND v.barcode IS NOT NULL
              AND BTRIM(v.barcode) <> ''
              AND LOWER(BTRIM(v.barcode)) = LOWER(BTRIM($1))
              AND EXISTS (SELECT 1 FROM receiving_context)

            UNION ALL

            SELECT v.id AS variant_id, 3 AS priority
            FROM product_variant_barcode_aliases alias
            INNER JOIN product_variants v ON v.id = alias.variant_id
            INNER JOIN products p ON p.id = v.product_id
            WHERE alias.status = 'active'
              AND alias.normalized_alias = LOWER(BTRIM($1))
              AND p.is_active = TRUE
              AND p.pos_line_kind IS NULL
              AND EXISTS (SELECT 1 FROM receiving_context)

            UNION ALL

            SELECT match.variant_id, 4 AS priority
            FROM po_catalog_matches match

            UNION ALL

            SELECT v.id AS variant_id, 4 AS priority
            FROM products p
            INNER JOIN product_variants v ON v.product_id = p.id
            WHERE p.is_active = TRUE
              AND p.pos_line_kind IS NULL
              AND p.catalog_handle IS NOT NULL
              AND BTRIM(p.catalog_handle) <> ''
              AND LOWER(BTRIM(p.catalog_handle)) = LOWER(BTRIM($1))
              AND EXISTS (SELECT 1 FROM receiving_context)
              AND NOT EXISTS (SELECT 1 FROM po_catalog_matches)

            UNION ALL

            SELECT v.id AS variant_id, 5 AS priority
            FROM product_variants v
            INNER JOIN products p ON p.id = v.product_id
            WHERE p.is_active = TRUE
              AND p.pos_line_kind IS NULL
              AND v.vendor_upc IS NOT NULL
              AND BTRIM(v.vendor_upc) <> ''
              AND LOWER(BTRIM(v.vendor_upc)) = LOWER(BTRIM($1))
              AND EXISTS (
                  SELECT 1
                  FROM receiving_context context
                  WHERE context.use_vendor_upc = TRUE
              )
        ),
        identifier_matches AS (
            SELECT candidate.variant_id, candidate.priority
            FROM identifier_candidates candidate
            INNER JOIN product_variants v ON v.id = candidate.variant_id
            INNER JOIN products p ON p.id = v.product_id
            WHERE p.is_active = TRUE
              AND p.pos_line_kind IS NULL
              AND (
                  p.primary_vendor_id = $2
                  OR EXISTS (
                      SELECT 1
                      FROM product_secondary_vendors secondary
                      WHERE secondary.product_id = p.id
                        AND secondary.vendor_id = $2
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM purchase_order_lines line
                      INNER JOIN receiving_context context
                          ON context.id = line.purchase_order_id
                      WHERE line.variant_id = candidate.variant_id
                  )
              )
        )
        SELECT variant_id, MIN(priority)::int AS resolution_priority
        FROM identifier_matches
        GROUP BY variant_id
        ORDER BY MIN(priority), variant_id
        LIMIT 3
        "#,
    )
    .bind(needle)
    .bind(vendor_id)
    .bind(purchase_order_id)
    .fetch_all(&mut *connection)
    .await
    .map_err(InventoryError::Database)?;

    if exact_matches.len() > 1 {
        return Err(InventoryError::AmbiguousProduct(
            "That identifier matches multiple active variations across SKU, Product UPC/barcode, barcode alias, catalog number, or enabled vendor UPC. Use the item picker and choose the intended variation."
                .to_string(),
        ));
    }

    let Some((variant_id, priority)) = exact_matches.into_iter().next() else {
        return Err(InventoryError::SkuNotFound(needle.to_string()));
    };
    let resolution_kind = match priority {
        1 => SkuResolutionKind::Sku,
        2 => SkuResolutionKind::Barcode,
        3 => SkuResolutionKind::BarcodeAlias,
        4 => SkuResolutionKind::CatalogHandle,
        5 => SkuResolutionKind::VendorUpc,
        _ => {
            return Err(InventoryError::AmbiguousProduct(
                "The receiving identifier could not be classified safely.".to_string(),
            ))
        }
    };
    let mut resolved =
        resolve_variant_by_id(&mut *connection, variant_id, global_employee_markup_percent).await?;
    resolved.resolution_kind = resolution_kind;
    Ok(resolved)
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
    Ok(join_row_to_resolved(
        row,
        global_employee_markup_percent,
        SkuResolutionKind::VariantId,
    ))
}
