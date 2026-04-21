//! Catalog CSV import: group rows by product identity, upsert variants by SKU.
//! Optional `mapping["supplier"]` resolves to `vendors` (match or create) and sets `products.primary_vendor_id`.
//! Optional `mapping["supplier_code"]` updates `vendors.vendor_code`.
//! This importer is catalog-only: it does not mutate live `stock_on_hand`.

use std::collections::HashMap;
use std::str::FromStr;

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::postgres::PgConnection;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum ImporterError {
    #[error("Invalid import payload: {0}")]
    InvalidPayload(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Deserialize)]
pub struct ImportPayload {
    /// When set, used for rows with no resolvable category in the CSV (or when no category column is mapped).
    #[serde(default)]
    pub category_id: Option<Uuid>,
    pub rows: Vec<HashMap<String, String>>,
    pub mapping: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct ImportSummary {
    pub products_created: i32,
    pub products_updated: i32,
    pub variants_synced: i32,
    pub rows_skipped: i32,
}

fn mapping_col(mapping: &HashMap<String, String>, key: &str, default: &str) -> String {
    mapping
        .get(key)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(default)
        .to_string()
}

fn cell(row: &HashMap<String, String>, col: &str) -> Option<String> {
    row.get(col)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_key(s: &str) -> String {
    s.to_lowercase()
        .replace(|c: char| !c.is_ascii_alphanumeric(), "")
}

fn cell_by_candidates(row: &HashMap<String, String>, candidates: &[&str]) -> Option<String> {
    for c in candidates {
        if let Some(v) = cell(row, c) {
            return Some(v);
        }
    }
    let normalized_candidates: Vec<String> = candidates.iter().map(|c| normalize_key(c)).collect();
    for (k, v) in row {
        let nk = normalize_key(k);
        if normalized_candidates.iter().any(|c| c == &nk) {
            let t = v.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn fuzzy_cell(row: &HashMap<String, String>, predicates: &[&str]) -> Option<String> {
    for (k, v) in row {
        let nk = normalize_key(k);
        if predicates.iter().any(|p| nk.contains(&normalize_key(p))) {
            let t = v.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
struct CategoryLookup {
    /// `name.trim().to_lowercase()` -> id
    by_lower: HashMap<String, Uuid>,
    /// `normalize_key(name)` -> id
    by_norm: HashMap<String, Uuid>,
}

impl CategoryLookup {
    fn from_rows(rows: Vec<(Uuid, String)>) -> Self {
        let mut by_lower = HashMap::new();
        let mut by_norm = HashMap::new();
        for (id, name) in rows {
            let t = name.trim();
            if t.is_empty() {
                continue;
            }
            by_lower.insert(t.to_lowercase(), id);
            by_norm.insert(normalize_key(t), id);
        }
        Self { by_lower, by_norm }
    }

    fn resolve_name(&self, raw: &str) -> Option<Uuid> {
        let t = raw.trim();
        if t.is_empty() {
            return None;
        }
        if let Some(id) = self.by_lower.get(&t.to_lowercase()) {
            return Some(*id);
        }
        if let Some(id) = self.by_norm.get(&normalize_key(t)) {
            return Some(*id);
        }
        // "Formalwear > Vests" → try last segment
        let segments: Vec<&str> = t
            .split(['>', '/'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if segments.len() > 1 {
            if let Some(last) = segments.last() {
                if let Some(id) = self.by_lower.get(&last.to_lowercase()) {
                    return Some(*id);
                }
                if let Some(id) = self.by_norm.get(&normalize_key(last)) {
                    return Some(*id);
                }
            }
        }
        None
    }

    fn ingest_name(&mut self, name: &str, id: Uuid) {
        let t = name.trim();
        if t.is_empty() {
            return;
        }
        self.by_lower.insert(t.to_lowercase(), id);
        self.by_norm.insert(normalize_key(t), id);
    }
}

#[derive(Debug, Clone)]
struct VendorLookup {
    by_lower: HashMap<String, Uuid>,
    by_norm: HashMap<String, Uuid>,
}

impl VendorLookup {
    fn from_rows(rows: Vec<(Uuid, String)>) -> Self {
        let mut by_lower = HashMap::new();
        let mut by_norm = HashMap::new();
        for (id, name) in rows {
            let t = name.trim();
            if t.is_empty() {
                continue;
            }
            by_lower.insert(t.to_lowercase(), id);
            by_norm.insert(normalize_key(t), id);
        }
        Self { by_lower, by_norm }
    }

    fn resolve_name(&self, raw: &str) -> Option<Uuid> {
        let t = raw.trim();
        if t.is_empty() {
            return None;
        }
        if let Some(id) = self.by_lower.get(&t.to_lowercase()) {
            return Some(*id);
        }
        self.by_norm.get(&normalize_key(t)).copied()
    }

    fn ingest_name(&mut self, name: &str, id: Uuid) {
        let t = name.trim();
        if t.is_empty() {
            return;
        }
        self.by_lower.insert(t.to_lowercase(), id);
        self.by_norm.insert(normalize_key(t), id);
    }
}

fn row_supplier_code_cell(
    row: &HashMap<String, String>,
    supplier_code_col: &str,
) -> Option<String> {
    if supplier_code_col.is_empty() {
        return None;
    }
    cell(row, supplier_code_col)
        .or_else(|| cell_by_candidates(row, &[supplier_code_col]))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

async fn persist_vendor_code(
    conn: &mut PgConnection,
    vendor_id: Uuid,
    code: &Option<String>,
) -> Result<(), sqlx::Error> {
    if let Some(c) = code.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        sqlx::query("UPDATE vendors SET vendor_code = $1 WHERE id = $2")
            .bind(c)
            .bind(vendor_id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Resolves a CSV supplier label to a `vendors` row (match by case-insensitive name or insert).
/// When `supplier_code_col` is set and the row has a value, sets `vendors.vendor_code` for that vendor.
async fn resolve_or_create_vendor(
    conn: &mut PgConnection,
    lookup: &mut VendorLookup,
    row: &HashMap<String, String>,
    supplier_csv_col: &str,
    supplier_code_col: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    if supplier_csv_col.is_empty() {
        return Ok(None);
    }
    let code_cell = row_supplier_code_cell(row, supplier_code_col);
    let from_cell =
        cell(row, supplier_csv_col).or_else(|| cell_by_candidates(row, &[supplier_csv_col]));
    let Some(raw) = from_cell else {
        return Ok(None);
    };
    let t = raw.trim();
    if t.is_empty() {
        return Ok(None);
    }
    let id = if let Some(id) = lookup.resolve_name(t) {
        id
    } else {
        let existing: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM vendors WHERE lower(trim(name)) = lower(trim($1)) LIMIT 1",
        )
        .bind(t)
        .fetch_optional(&mut *conn)
        .await?;
        if let Some(id) = existing {
            lookup.ingest_name(t, id);
            id
        } else {
            let name = t.to_string();
            let new_id: Option<Uuid> = sqlx::query_scalar(
                r#"
                INSERT INTO vendors (name, is_active)
                VALUES ($1, true)
                ON CONFLICT (name) DO NOTHING
                RETURNING id
                "#,
            )
            .bind(&name)
            .fetch_optional(&mut *conn)
            .await?;
            let id = if let Some(id) = new_id {
                id
            } else {
                sqlx::query_scalar("SELECT id FROM vendors WHERE name = $1")
                    .bind(&name)
                    .fetch_one(&mut *conn)
                    .await?
            };
            lookup.ingest_name(&name, id);
            id
        }
    };
    persist_vendor_code(conn, id, &code_cell).await?;
    Ok(Some(id))
}

/// Resolves `mapping["category"]` CSV cell to a Riverside category id, inserting a new
/// `categories` row when the label is not found (exact `name`, `is_clothing_footwear = true` for NYS retail defaults).
async fn resolve_or_create_category(
    conn: &mut PgConnection,
    lookup: &mut CategoryLookup,
    row: &HashMap<String, String>,
    category_csv_col: &str,
    fallback: Option<Uuid>,
) -> Result<Option<Uuid>, sqlx::Error> {
    let from_cell = if !category_csv_col.is_empty() {
        cell(row, category_csv_col).or_else(|| cell_by_candidates(row, &[category_csv_col]))
    } else {
        None
    };
    match from_cell {
        None => Ok(fallback),
        Some(raw) => {
            let t = raw.trim();
            if t.is_empty() {
                return Ok(fallback);
            }
            if let Some(id) = lookup.resolve_name(t) {
                return Ok(Some(id));
            }
            let name = t.to_string();
            let new_id: Option<Uuid> = sqlx::query_scalar(
                r#"
                INSERT INTO categories (name, is_clothing_footwear)
                VALUES ($1, true)
                ON CONFLICT (name) DO NOTHING
                RETURNING id
                "#,
            )
            .bind(&name)
            .fetch_optional(&mut *conn)
            .await?;
            let id = if let Some(id) = new_id {
                id
            } else {
                sqlx::query_scalar::<_, Uuid>("SELECT id FROM categories WHERE name = $1")
                    .bind(&name)
                    .fetch_one(&mut *conn)
                    .await?
            };
            lookup.ingest_name(&name, id);
            Ok(Some(id))
        }
    }
}

fn parse_money(raw: &str) -> Decimal {
    let t = raw.trim().replace(['$', ',', ' '], "");
    if t.is_empty() {
        return Decimal::ZERO;
    }
    Decimal::from_str(&t).unwrap_or(Decimal::ZERO)
}

fn variant_axes_from_row(row: &HashMap<String, String>) -> (Value, String) {
    let mut map = Map::new();
    let mut label_parts: Vec<String> = Vec::new();
    for slot in ["one", "two", "three"] {
        let n_key = format!("variant_option_{slot}_name");
        let v_key = format!("variant_option_{slot}_value");
        if let (Some(n), Some(v)) = (cell(row, &n_key), cell(row, &v_key)) {
            map.insert(n.clone(), Value::String(v.clone()));
            label_parts.push(v);
        }
    }
    let label = if label_parts.is_empty() {
        String::new()
    } else {
        label_parts.join(" / ")
    };
    (Value::Object(map), label)
}

/// Run a catalog import in one transaction.
pub async fn execute_import(
    pool: &sqlx::PgPool,
    payload: ImportPayload,
) -> Result<ImportSummary, ImporterError> {
    if payload.rows.is_empty() {
        return Err(ImporterError::InvalidPayload(
            "at least one CSV row is required".to_string(),
        ));
    }

    let mut tx = pool.begin().await?;

    if let Some(fid) = payload.category_id {
        let category_ok: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM categories WHERE id = $1)")
                .bind(fid)
                .fetch_one(&mut *tx)
                .await?;
        if !category_ok {
            return Err(ImporterError::InvalidPayload(
                "category_id does not exist".to_string(),
            ));
        }
    }

    let category_csv_col = mapping_col(&payload.mapping, "category", "");
    if category_csv_col.is_empty() && payload.category_id.is_none() {
        return Err(ImporterError::InvalidPayload(
            "Map a CSV column to category (mapping key \"category\") and/or send category_id as fallback for empty cells. New category labels from the file are created automatically when missing."
                .to_string(),
        ));
    }

    let cat_rows: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id, name FROM categories ORDER BY name ASC")
            .fetch_all(&mut *tx)
            .await?;
    let mut lookup = CategoryLookup::from_rows(cat_rows);

    let sku_key = mapping_col(&payload.mapping, "sku", "sku");
    let barcode_key = mapping_col(&payload.mapping, "barcode", "barcode");
    let identity_key = mapping_col(&payload.mapping, "product_identity", "handle");
    let name_key = mapping_col(&payload.mapping, "product_name", "name");
    let brand_key = mapping_col(&payload.mapping, "brand", "brand_name");
    let retail_key = mapping_col(&payload.mapping, "retail_price", "retail_price");
    let cost_key = mapping_col(&payload.mapping, "unit_cost", "supply_price");
    let supplier_csv_col = mapping_col(&payload.mapping, "supplier", "");
    let supplier_code_csv_col = mapping_col(&payload.mapping, "supplier_code", "");
    let stock_mapping_present = payload
        .mapping
        .get("stock_on_hand")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if stock_mapping_present {
        return Err(ImporterError::InvalidPayload(
            "Catalog CSV import no longer accepts stock_on_hand mapping. Use Counterpoint sync for pre-launch inventory quantities, then Receiving or Physical Inventory for live stock changes."
                .to_string(),
        ));
    }
    let mut vendor_lookup = if supplier_csv_col.is_empty() {
        None
    } else {
        let vrows: Vec<(Uuid, String)> =
            sqlx::query_as("SELECT id, name FROM vendors ORDER BY name ASC")
                .fetch_all(&mut *tx)
                .await?;
        Some(VendorLookup::from_rows(vrows))
    };

    let mut identity_to_product: HashMap<String, Uuid> = HashMap::new();
    let mut products_created: i32 = 0;
    let mut products_updated: i32 = 0;
    let mut variants_synced: i32 = 0;
    let mut rows_skipped: i32 = 0;

    for row in &payload.rows {
        let identity_val = match cell(row, &identity_key)
            .or_else(|| {
                cell_by_candidates(
                    row,
                    &[
                        "handle",
                        "product_handle",
                        "style_handle",
                        "tags",
                        "item_no",
                    ],
                )
            })
            .or_else(|| {
                cell_by_candidates(
                    row,
                    &[&sku_key, &barcode_key, "sku", "barcode", "upc", "ean"],
                )
            }) {
            Some(s) => s,
            None => {
                rows_skipped += 1;
                continue;
            }
        };

        let sku = match cell(row, &sku_key)
            .or_else(|| cell(row, &barcode_key))
            .or_else(|| {
                cell_by_candidates(
                    row,
                    &[
                        "barcode",
                        "upc",
                        "ean",
                        "scan_code",
                        "sku",
                        "system_sku",
                        "item_sku",
                    ],
                )
            })
            .or_else(|| fuzzy_cell(row, &["sku", "barcode", "upc", "ean"]))
        {
            Some(s) => s,
            None => {
                rows_skipped += 1;
                continue;
            }
        };

        let Some(row_category_id) = resolve_or_create_category(
            tx.as_mut(),
            &mut lookup,
            row,
            &category_csv_col,
            payload.category_id,
        )
        .await?
        else {
            rows_skipped += 1;
            continue;
        };

        let row_vendor_id = if let Some(ref mut vl) = vendor_lookup {
            resolve_or_create_vendor(
                tx.as_mut(),
                vl,
                row,
                &supplier_csv_col,
                &supplier_code_csv_col,
            )
            .await?
        } else {
            None
        };

        let product_id = if let Some(&id) = identity_to_product.get(&identity_val) {
            sqlx::query(
                "UPDATE products SET category_id = $1, primary_vendor_id = COALESCE($2, primary_vendor_id) WHERE id = $3",
            )
            .bind(row_category_id)
            .bind(row_vendor_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            id
        } else {
            let existed: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM products WHERE catalog_handle = $1)",
            )
            .bind(&identity_val)
            .fetch_one(&mut *tx)
            .await?;

            let product_name = cell(row, &name_key).unwrap_or_else(|| identity_val.clone());
            let brand = cell(row, &brand_key);
            let base_retail = cell(row, &retail_key)
                .map(|s| parse_money(&s))
                .unwrap_or(Decimal::ZERO);
            let base_cost = cell(row, &cost_key)
                .map(|s| parse_money(&s))
                .unwrap_or(Decimal::ZERO);

            let id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO products (
                    catalog_handle, name, brand, category_id,
                    base_retail_price, base_cost, spiff_amount, variation_axes, images,
                    primary_vendor_id
                )
                VALUES ($1, $2, $3, $4, $5, $6, 0, '{}', '{}', $7)
                ON CONFLICT (catalog_handle) DO UPDATE SET
                    name = EXCLUDED.name,
                    brand = EXCLUDED.brand,
                    category_id = EXCLUDED.category_id,
                    base_retail_price = EXCLUDED.base_retail_price,
                    base_cost = EXCLUDED.base_cost,
                    primary_vendor_id = COALESCE(EXCLUDED.primary_vendor_id, products.primary_vendor_id)
                RETURNING id
                "#,
            )
            .bind(&identity_val)
            .bind(&product_name)
            .bind(&brand)
            .bind(row_category_id)
            .bind(base_retail)
            .bind(base_cost)
            .bind(row_vendor_id)
            .fetch_one(&mut *tx)
            .await?;

            identity_to_product.insert(identity_val.clone(), id);
            if existed {
                products_updated += 1;
            } else {
                products_created += 1;
            }
            id
        };

        let (variation_values, variation_label) = variant_axes_from_row(row);

        let label_opt = (!variation_label.is_empty()).then_some(variation_label.as_str());

        let retail_override = cell(row, &retail_key).map(|s| parse_money(&s));
        let cost_override = cell(row, &cost_key).map(|s| parse_money(&s));
        sqlx::query(
            r#"
            INSERT INTO product_variants (
                product_id, sku, variation_values, variation_label,
                retail_price_override, cost_override, stock_on_hand
            )
            VALUES ($1, $2, $3::jsonb, $4, $5, $6, 0)
            ON CONFLICT (sku) DO UPDATE SET
                product_id = EXCLUDED.product_id,
                variation_values = EXCLUDED.variation_values,
                variation_label = EXCLUDED.variation_label,
                retail_price_override = EXCLUDED.retail_price_override,
                cost_override = EXCLUDED.cost_override
            "#,
        )
        .bind(product_id)
        .bind(&sku)
        .bind(variation_values)
        .bind(label_opt)
        .bind(retail_override)
        .bind(cost_override)
        .execute(&mut *tx)
        .await?;

        variants_synced += 1;
    }

    tx.commit().await?;

    Ok(ImportSummary {
        products_created,
        products_updated,
        variants_synced,
        rows_skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::{execute_import, ImportPayload};
    use rust_decimal::Decimal;
    use sqlx::PgPool;
    use std::collections::HashMap;
    use uuid::Uuid;

    #[tokio::test]
    async fn execute_import_preserves_live_stock_and_starts_new_variants_at_zero() {
        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for DB-backed tests");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect test database");

        let category_id = Uuid::new_v4();
        let existing_product_id = Uuid::new_v4();
        let new_product_id = Uuid::new_v4();
        let existing_sku = format!("IMPORT-EXISTING-{}", Uuid::new_v4().simple());
        let new_sku = format!("IMPORT-NEW-{}", Uuid::new_v4().simple());
        let existing_handle = format!("existing-handle-{}", Uuid::new_v4().simple());
        let new_handle = format!("new-handle-{}", Uuid::new_v4().simple());

        sqlx::query(
            "INSERT INTO categories (id, name, is_clothing_footwear) VALUES ($1, $2, true)",
        )
        .bind(category_id)
        .bind(format!("Import Test Category {}", Uuid::new_v4().simple()))
        .execute(&pool)
        .await
        .expect("insert category");

        sqlx::query(
            r#"
            INSERT INTO products (id, catalog_handle, name, category_id, base_retail_price, base_cost, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, true), ($7, $8, $9, $4, $10, $11, true)
            "#,
        )
        .bind(existing_product_id)
        .bind(&existing_handle)
        .bind("Existing Import Product")
        .bind(category_id)
        .bind(Decimal::new(10000, 2))
        .bind(Decimal::new(4000, 2))
        .bind(new_product_id)
        .bind(&new_handle)
        .bind("Unused New Product Seed")
        .bind(Decimal::new(12000, 2))
        .bind(Decimal::new(5000, 2))
        .execute(&pool)
        .await
        .expect("insert products");

        sqlx::query(
            r#"
            INSERT INTO product_variants (
                product_id, sku, variation_values, stock_on_hand, retail_price_override, cost_override
            )
            VALUES ($1, $2, '{}'::jsonb, 7, $3, $4)
            "#,
        )
        .bind(existing_product_id)
        .bind(&existing_sku)
        .bind(Decimal::new(11000, 2))
        .bind(Decimal::new(4500, 2))
        .execute(&pool)
        .await
        .expect("insert existing variant");

        let mut mapping = HashMap::new();
        mapping.insert("product_identity".to_string(), "handle".to_string());
        mapping.insert("sku".to_string(), "sku".to_string());
        mapping.insert("product_name".to_string(), "name".to_string());
        mapping.insert("retail_price".to_string(), "retail_price".to_string());
        mapping.insert("unit_cost".to_string(), "supply_price".to_string());
        mapping.insert("brand".to_string(), "brand_name".to_string());
        mapping.insert("category".to_string(), "product_category".to_string());

        let mut existing_row = HashMap::new();
        existing_row.insert("handle".to_string(), existing_handle.clone());
        existing_row.insert("sku".to_string(), existing_sku.clone());
        existing_row.insert(
            "name".to_string(),
            "Existing Import Product Updated".to_string(),
        );
        existing_row.insert("retail_price".to_string(), "129.99".to_string());
        existing_row.insert("supply_price".to_string(), "55.00".to_string());
        existing_row.insert("brand_name".to_string(), "Riverside".to_string());
        existing_row.insert(
            "product_category".to_string(),
            "Import Existing".to_string(),
        );
        existing_row.insert("stock_on_hand".to_string(), "999".to_string());

        let mut new_row = HashMap::new();
        new_row.insert(
            "handle".to_string(),
            format!("brand-new-{}", Uuid::new_v4().simple()),
        );
        new_row.insert("sku".to_string(), new_sku.clone());
        new_row.insert("name".to_string(), "Brand New Import Product".to_string());
        new_row.insert("retail_price".to_string(), "149.99".to_string());
        new_row.insert("supply_price".to_string(), "60.00".to_string());
        new_row.insert("brand_name".to_string(), "Riverside".to_string());
        new_row.insert("product_category".to_string(), "Import New".to_string());
        new_row.insert("stock_on_hand".to_string(), "42".to_string());

        let summary = execute_import(
            &pool,
            ImportPayload {
                category_id: None,
                rows: vec![existing_row, new_row],
                mapping,
            },
        )
        .await
        .expect("execute import");

        assert_eq!(summary.variants_synced, 2);

        let existing_stock: i32 =
            sqlx::query_scalar("SELECT stock_on_hand FROM product_variants WHERE sku = $1")
                .bind(&existing_sku)
                .fetch_one(&pool)
                .await
                .expect("fetch existing stock");
        assert_eq!(existing_stock, 7);

        let new_stock: i32 =
            sqlx::query_scalar("SELECT stock_on_hand FROM product_variants WHERE sku = $1")
                .bind(&new_sku)
                .fetch_one(&pool)
                .await
                .expect("fetch new stock");
        assert_eq!(new_stock, 0);
    }
}
