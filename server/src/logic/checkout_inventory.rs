use super::transaction_checkout::{CheckoutError, CheckoutItem};
use crate::logic::tax::{erie_local_tax_usd, nys_state_tax_usd};
use crate::services::inventory;
use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

pub fn takeaway_line_total_decimal(items: &[CheckoutItem]) -> Decimal {
    let mut s = Decimal::ZERO;
    for i in items {
        if i.fulfillment != crate::models::DbFulfillmentType::Takeaway {
            continue;
        }
        s += (i.unit_price + i.state_tax + i.local_tax) * Decimal::from(i.quantity);
    }
    s.round_dp(2)
}

/// One bundle cart line becomes multiple component lines (inventory, tax, commission) using
/// retail-weighted apportionment of the bundle unit price.
pub async fn expand_bundle_checkout_items(
    pool: &PgPool,
    global_employee_markup: Decimal,
    items: Vec<CheckoutItem>,
) -> Result<Vec<CheckoutItem>, CheckoutError> {
    let mut out = Vec::new();
    for item in items {
        let is_bundle: bool =
            sqlx::query_scalar("SELECT COALESCE(is_bundle, false) FROM products WHERE id = $1")
                .bind(item.product_id)
                .fetch_optional(pool)
                .await?
                .unwrap_or(false);

        if !is_bundle {
            out.push(item);
            continue;
        }

        if item.discount_event_id.is_some() {
            return Err(CheckoutError::InvalidPayload(
                "Discount events cannot be applied to bundle package lines".to_string(),
            ));
        }

        let rows: Vec<(Uuid, i32)> = sqlx::query_as(
            r#"
            SELECT component_variant_id, quantity
            FROM product_bundle_components
            WHERE bundle_product_id = $1
            "#,
        )
        .bind(item.product_id)
        .fetch_all(pool)
        .await?;

        if rows.is_empty() {
            return Err(CheckoutError::InvalidPayload(
                "Bundle product has no components configured".to_string(),
            ));
        }

        #[derive(Clone)]
        struct Comp {
            product_id: Uuid,
            variant_id: Uuid,
            comp_qty: i32,
            retail: Decimal,
            unit_cost: Decimal,
            tax_category: crate::logic::tax::TaxCategory,
        }

        let mut comps: Vec<Comp> = Vec::new();
        let mut w_sum = Decimal::ZERO;
        for (comp_variant_id, comp_qty) in rows {
            if comp_qty <= 0 {
                return Err(CheckoutError::InvalidPayload(
                    "Invalid bundle component quantity".to_string(),
                ));
            }
            let pid: Uuid =
                sqlx::query_scalar("SELECT product_id FROM product_variants WHERE id = $1")
                    .bind(comp_variant_id)
                    .fetch_optional(pool)
                    .await?
                    .ok_or_else(|| {
                        CheckoutError::InvalidPayload(format!(
                            "Bundle component variant {comp_variant_id} not found"
                        ))
                    })?;

            let resolved =
                inventory::fetch_variant_by_ids(pool, comp_variant_id, pid, global_employee_markup)
                    .await
                    .map_err(|e| match e {
                        inventory::InventoryError::SkuNotFound(s) => {
                            CheckoutError::InvalidPayload(format!("bundle component: {s}"))
                        }
                        inventory::InventoryError::AmbiguousProduct(m) => {
                            CheckoutError::InvalidPayload(m)
                        }
                        inventory::InventoryError::Unauthorized(m) => {
                            CheckoutError::InvalidPayload(m)
                        }
                        inventory::InventoryError::Database(d) => CheckoutError::Database(d),
                    })?;

            let w = resolved.standard_retail_price * Decimal::from(comp_qty);
            w_sum += w;
            comps.push(Comp {
                product_id: pid,
                variant_id: comp_variant_id,
                comp_qty,
                retail: resolved.standard_retail_price,
                unit_cost: resolved.unit_cost,
                tax_category: resolved.tax_category,
            });
        }

        if w_sum <= Decimal::ZERO {
            return Err(CheckoutError::InvalidPayload(
                "Bundle has zero retail weight; check component prices".to_string(),
            ));
        }

        let target_total = (item.unit_price * Decimal::from(item.quantity)).round_dp(2);
        let n = comps.len();
        let mut extensions: Vec<Decimal> = Vec::with_capacity(n);
        for (i, c) in comps.iter().enumerate() {
            let raw = target_total * c.retail * Decimal::from(c.comp_qty) / w_sum;
            if i + 1 == n {
                let allocated: Decimal = extensions.iter().copied().sum();
                extensions.push((target_total - allocated).max(Decimal::ZERO).round_dp(2));
            } else {
                extensions.push(raw.round_dp(2));
            }
        }

        let parent_has_override = item
            .price_override_reason
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);

        for (c, ext) in comps.into_iter().zip(extensions) {
            let line_qty = c.comp_qty * item.quantity;
            if line_qty <= 0 {
                continue;
            }
            let unit_price = (ext / Decimal::from(line_qty)).round_dp(2);
            let state_tax = nys_state_tax_usd(c.tax_category, unit_price, unit_price);
            let local_tax = erie_local_tax_usd(c.tax_category, unit_price, unit_price);

            let (price_override_reason, original_unit_price) = if parent_has_override {
                (
                    item.price_override_reason.clone(),
                    Some(c.retail).or(item.original_unit_price),
                )
            } else {
                (
                    Some("Bundle package (apportioned)".to_string()),
                    Some(c.retail),
                )
            };

            out.push(CheckoutItem {
                product_id: c.product_id,
                variant_id: c.variant_id,
                fulfillment: item.fulfillment,
                quantity: line_qty,
                unit_price,
                original_unit_price,
                price_override_reason,
                unit_cost: c.unit_cost,
                state_tax,
                local_tax,
                salesperson_id: item.salesperson_id,
                discount_event_id: None,
                gift_card_load_code: None,
                custom_item_type: item.custom_item_type.clone(),
                is_rush: item.is_rush,
                need_by_date: item.need_by_date,
                needs_gift_wrap: item.needs_gift_wrap,
            });
        }
    }
    Ok(out)
}
