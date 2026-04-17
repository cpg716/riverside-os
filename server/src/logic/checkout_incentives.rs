use super::transaction_checkout::{CheckoutError, CheckoutItem};
use crate::logic::checkout_validate;
use crate::services::inventory;
use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::{PgConnection, PgPool};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct ComboSpiffReward {
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub reward_amount: Decimal,
    pub label: String,
}

/// Scans a salesperson's set of items for satisfied bundle rules (e.g. Suit + Tie + Shirt).
/// Returns a list of rewards to be inserted as 0.00 lines.
pub async fn evaluate_combo_incentives(
    conn: &mut PgConnection,
    items: &[&CheckoutItem],
) -> Result<Vec<ComboSpiffReward>, CheckoutError> {
    let mut rewards = Vec::new();
    if items.is_empty() {
        return Ok(rewards);
    }

    // 1) Fetch all active combo rules
    let rules: Vec<serde_json::Value> = sqlx::query_scalar(
        r#"
        SELECT json_build_object(
            'id', r.id,
            'label', r.label,
            'reward_amount', r.reward_amount,
            'items', (
                SELECT json_agg(json_build_object(
                    'match_type', ri.match_type,
                    'match_id', ri.match_id,
                    'qty_required', ri.qty_required
                ))
                FROM commission_combo_rule_items ri
                WHERE ri.rule_id = r.id
            )
        )
        FROM commission_combo_rules r
        WHERE r.is_active = TRUE
        "#,
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(CheckoutError::Database)?;

    // 2) Map item counts for current salesperson
    let mut cat_counts: HashMap<Uuid, i32> = HashMap::new();
    let mut prod_counts: HashMap<Uuid, i32> = HashMap::new();

    for item in items {
        *prod_counts.entry(item.product_id).or_default() += item.quantity;
        if let Some(cid) =
            sqlx::query_scalar::<_, Uuid>("SELECT category_id FROM products WHERE id = $1")
                .bind(item.product_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(CheckoutError::Database)?
        {
            *cat_counts.entry(cid).or_default() += item.quantity;
        }
    }

    // 3) Evaluate rules
    for rule_json in rules {
        let rule_id = Uuid::parse_str(rule_json["id"].as_str().unwrap_or("")).unwrap_or_default();
        let reward_val = rule_json["reward_amount"].as_f64().unwrap_or(0.0);
        let reward_amount = Decimal::from_f64_retain(reward_val).unwrap_or(Decimal::ZERO);
        let label = rule_json["label"].as_str().unwrap_or("SPIFF").to_string();
        let requirements = rule_json["items"].as_array();

        if let Some(reqs) = requirements {
            loop {
                let mut satisfied = true;
                for req in reqs {
                    let m_type = req["match_type"].as_str().unwrap_or("");
                    let m_id =
                        Uuid::parse_str(req["match_id"].as_str().unwrap_or("")).unwrap_or_default();
                    let qty_req = req["qty_required"].as_i64().unwrap_or(1) as i32;

                    let available = if m_type == "product" {
                        prod_counts.get(&m_id).copied().unwrap_or(0)
                    } else {
                        cat_counts.get(&m_id).copied().unwrap_or(0)
                    };

                    if available < qty_req {
                        satisfied = false;
                        break;
                    }
                }

                if satisfied {
                    for req in reqs {
                        let m_type = req["match_type"].as_str().unwrap_or("");
                        let m_id = Uuid::parse_str(req["match_id"].as_str().unwrap_or(""))
                            .unwrap_or_default();
                        let qty_req = req["qty_required"].as_i64().unwrap_or(1) as i32;

                        if m_type == "product" {
                            prod_counts.entry(m_id).and_modify(|q| *q -= qty_req);
                        } else {
                            cat_counts.entry(m_id).and_modify(|q| *q -= qty_req);
                        }
                    }

                    rewards.push(ComboSpiffReward {
                        product_id: rule_id,
                        variant_id: rule_id,
                        reward_amount,
                        label: label.clone(),
                    });
                } else {
                    break;
                }
            }
        }
    }

    Ok(rewards)
}

pub async fn validate_discount_events(
    pool: &PgPool,
    items: &[CheckoutItem],
    global_employee_markup: Decimal,
) -> Result<HashMap<usize, String>, CheckoutError> {
    let mut labels = HashMap::new();
    for (idx, item) in items.iter().enumerate() {
        let Some(eid) = item.discount_event_id else {
            continue;
        };
        let resolved = inventory::fetch_variant_by_ids(
            pool,
            item.variant_id,
            item.product_id,
            global_employee_markup,
        )
        .await
        .map_err(|e| match e {
            inventory::InventoryError::SkuNotFound(s) => {
                CheckoutError::InvalidPayload(format!("checkout line: {s}"))
            }
            inventory::InventoryError::AmbiguousProduct(m) => CheckoutError::InvalidPayload(m),
            inventory::InventoryError::Unauthorized(m) => CheckoutError::InvalidPayload(m),
            inventory::InventoryError::Database(d) => CheckoutError::Database(d),
        })?;
        if resolved.pos_line_kind.as_deref() == Some("rms_charge_payment") {
            return Err(CheckoutError::InvalidPayload(
                "Discount events cannot apply to RMS CHARGE PAYMENT".to_string(),
            ));
        }
        if resolved.pos_line_kind.as_deref() == Some("pos_gift_card_load") {
            return Err(CheckoutError::InvalidPayload(
                "Discount events cannot apply to POS GIFT CARD LOAD".to_string(),
            ));
        }
        let row: Option<(Decimal, String, bool)> = sqlx::query_as(
            r#"
            SELECT de.percent_off, de.receipt_label, de.is_active
            FROM discount_events de
            WHERE de.id = $1
              AND de.starts_at <= now()
              AND de.ends_at >= now()
              AND (
                (
                  de.scope_type = 'variants'
                  AND EXISTS (
                    SELECT 1 FROM discount_event_variants dv
                    WHERE dv.event_id = de.id AND dv.variant_id = $2
                  )
                )
                OR (
                  de.scope_type = 'category'
                  AND de.scope_category_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM products p
                    WHERE p.id = $3 AND p.category_id = de.scope_category_id
                  )
                )
                OR (
                  de.scope_type = 'vendor'
                  AND de.scope_vendor_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM products p
                    WHERE p.id = $3 AND p.primary_vendor_id = de.scope_vendor_id
                  )
                )
              )
            "#,
        )
        .bind(eid)
        .bind(item.variant_id)
        .bind(item.product_id)
        .fetch_optional(pool)
        .await?;
        let Some((pct_off, receipt_label, is_active)) = row else {
            return Err(CheckoutError::InvalidPayload(
                "discount_event_id is not valid for this variant, dates, or is inactive"
                    .to_string(),
            ));
        };
        if !is_active {
            return Err(CheckoutError::InvalidPayload(
                "discount event is not active".to_string(),
            ));
        }
        let retail = resolved.standard_retail_price;
        let expected_unit =
            (retail * (Decimal::from(100) - pct_off) / Decimal::from(100)).round_dp(2);
        if !checkout_validate::money_close_decimal(item.unit_price, expected_unit) {
            return Err(CheckoutError::InvalidPayload(format!(
                "unit price for variant {} does not match discount event {:.2}% off retail",
                item.variant_id, pct_off
            )));
        }
        labels.insert(idx, receipt_label);
    }
    Ok(labels)
}
pub async fn validate_role_discount_limits(
    pool: &PgPool,
    items: &[CheckoutItem],
    max_disc_pct: Decimal,
    global_employee_markup: Decimal,
) -> Result<(), CheckoutError> {
    for item in items {
        let has_ov = item
            .price_override_reason
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !has_ov {
            continue;
        }
        let resolved = inventory::fetch_variant_by_ids(
            pool,
            item.variant_id,
            item.product_id,
            global_employee_markup,
        )
        .await
        .map_err(|e| match e {
            inventory::InventoryError::SkuNotFound(s) => {
                CheckoutError::InvalidPayload(format!("checkout line: {s}"))
            }
            inventory::InventoryError::AmbiguousProduct(m) => CheckoutError::InvalidPayload(m),
            inventory::InventoryError::Unauthorized(m) => CheckoutError::InvalidPayload(m),
            inventory::InventoryError::Database(d) => CheckoutError::Database(d),
        })?;
        let retail = resolved.standard_retail_price;
        if retail <= Decimal::ZERO {
            continue;
        }
        if item.unit_price >= retail {
            continue;
        }
        let pct_off = ((retail - item.unit_price) / retail) * Decimal::from(100);
        let tol = Decimal::new(5, 1);
        if pct_off > max_disc_pct + tol {
            return Err(CheckoutError::InvalidPayload(format!(
                "Line discount {:.2}% exceeds role maximum {:.2}% for this register operator",
                pct_off.round_dp(2),
                max_disc_pct
            )));
        }
    }
    Ok(())
}
