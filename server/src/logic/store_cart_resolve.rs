//! Merge + price storefront cart lines (public catalog / web-published variants).

use rust_decimal::Decimal;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashMap;
use uuid::Uuid;

use crate::logic::store_catalog;

#[derive(Debug, Clone)]
pub struct LineQty {
    pub variant_id: Uuid,
    pub qty: i32,
}

pub fn merge_cart_input(lines: Vec<LineQty>) -> Result<Vec<(Uuid, i32)>, &'static str> {
    if lines.len() > 100 {
        return Err("too many lines");
    }
    let mut merged: HashMap<Uuid, i32> = HashMap::new();
    for l in lines {
        let q = l.qty.clamp(1, 999);
        *merged.entry(l.variant_id).or_insert(0) += q;
    }
    if merged.values().any(|q| *q > 9999) {
        return Err("quantity out of range");
    }
    let mut pairs: Vec<(Uuid, i32)> = merged.into_iter().collect();
    pairs.sort_by_key(|(k, _)| *k);
    Ok(pairs)
}

pub async fn priced_cart_value(pool: &PgPool, pairs: &[(Uuid, i32)]) -> Result<Value, sqlx::Error> {
    if pairs.is_empty() {
        let missing: Vec<Uuid> = vec![];
        return Ok(json!({
            "lines": [],
            "subtotal": "0",
            "missing_variant_ids": missing,
        }));
    }
    let ids: Vec<Uuid> = pairs.iter().map(|(k, _)| *k).collect();
    let map = store_catalog::map_web_variants_by_id(pool, &ids).await?;
    let mut out_lines = Vec::new();
    let mut subtotal = Decimal::ZERO;
    let mut missing = Vec::new();

    for (vid, qty) in pairs {
        match map.get(vid) {
            Some(row) => {
                let unit = row.unit_price;
                let line_total = unit * Decimal::from(*qty);
                subtotal += line_total;
                out_lines.push(json!({
                    "variant_id": vid,
                    "qty": qty,
                    "product_slug": row.product_slug,
                    "product_name": row.product_name,
                    "sku": row.sku,
                    "variation_label": row.variation_label,
                    "unit_price": unit.to_string(),
                    "line_total": line_total.to_string(),
                    "available_stock": row.available_stock,
                    "primary_image": row.primary_image,
                }));
            }
            None => missing.push(*vid),
        }
    }

    Ok(json!({
        "lines": out_lines,
        "subtotal": subtotal.to_string(),
        "missing_variant_ids": missing,
    }))
}
