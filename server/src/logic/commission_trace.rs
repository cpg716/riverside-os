use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;
use crate::logic::pricing::round_money_usd;
use crate::models::DbStaffRole;

#[derive(Debug, Serialize, Deserialize)]
pub struct CommissionTrace {
    pub order_id: Uuid,
    pub order_item_id: Uuid,
    pub salesperson_name: String,
    pub role: DbStaffRole,
    pub line_gross: Decimal,
    pub base_rate: Decimal,
    pub applied_rate: Decimal,
    pub flat_spiff: Decimal,
    pub total_commission: Decimal,
    pub source: String, // "Variant Rule", "Product Rule", "Category Rule", "Legacy Override", "Staff Base"
    pub explanation: String,
}

pub async fn query_commission_trace(
    pool: &PgPool,
    order_item_id: Uuid,
) -> Result<CommissionTrace, String> {
    // 1. Fetch the order item and salesperson info
    let row = sqlx::query!(
        r#"
        SELECT 
            oi.order_id,
            oi.unit_price,
            oi.quantity,
            oi.salesperson_id,
            oi.variant_id,
            p.id as product_id,
            p.category_id,
            s.full_name as salesperson_name,
            s.role as "salesperson_role: DbStaffRole",
            s.base_commission_rate as staff_base_rate,
            p.name as product_name
        FROM order_items oi
        JOIN product_variants pv ON oi.variant_id = pv.id
        JOIN products p ON pv.product_id = p.id
        LEFT JOIN staff s ON oi.salesperson_id = s.id
        WHERE oi.id = $1
        "#,
        order_item_id
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Order item not found".to_string())?;

    let _sid = row.salesperson_id.ok_or_else(|| "No salesperson attributed to this line".to_string())?;
    let base_rate = row.staff_base_rate.unwrap_or(Decimal::ZERO);
    let gross = row.unit_price * Decimal::from(row.quantity);

    // 2. Replication of logic in sales_commission.rs with TRACE capturing
    // Use specialty rule lookup first (Specificity: Variant > Product > Category)
    let rule = sqlx::query!(
        r#"
        SELECT id, override_rate, fixed_spiff_amount, match_type
        FROM commission_rules
        WHERE is_active = TRUE
          AND (start_date IS NULL OR start_date <= now())
          AND (end_date IS NULL OR end_date >= now())
          AND (
            (match_type = 'variant' AND match_id = $1)
            OR (match_type = 'product' AND match_id = $2)
            OR (match_type = 'category' AND match_id = $3)
          )
        ORDER BY 
          CASE match_type 
            WHEN 'variant' THEN 1 
            WHEN 'product' THEN 2 
            WHEN 'category' THEN 3 
          END ASC
        LIMIT 1
        "#,
        row.variant_id,
        row.product_id,
        row.category_id
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut applied_rate = base_rate;
    let mut flat_spiff = Decimal::ZERO;
    let mut source = "Staff Base Rate".to_string();
    let mut explanation = format!("Calculated using default staff commission ({}%) for {:?}.", base_rate * Decimal::from(100), row.salesperson_role);

    if let Some(r) = rule {
        applied_rate = r.override_rate.unwrap_or(base_rate);
        flat_spiff = r.fixed_spiff_amount.unwrap_or(Decimal::ZERO) * Decimal::from(row.quantity);
        source = format!("{} Rule", r.match_type[..1].to_uppercase() + &r.match_type[1..]);
        explanation = format!("Specific {} rule match. Rule ID: {}. Captured rate: {}% + ${} fixed SPIFF per unit.", 
            r.match_type, r.id, applied_rate * Decimal::from(100), r.fixed_spiff_amount.unwrap_or(Decimal::ZERO));
    } else {
        // Fallback to legacy
        if let Some(cid) = row.category_id {
            let legacy_rate: Option<Decimal> = sqlx::query_scalar(
                "SELECT commission_rate FROM category_commission_overrides WHERE category_id = $1"
            )
            .bind(cid)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;

            if let Some(lr) = legacy_rate {
                applied_rate = lr;
                source = "Legacy Category Override".to_string();
                explanation = "Applied legacy category-level commission rate override.".to_string();
            }
        }
    }

    let total = round_money_usd(gross * applied_rate + flat_spiff);

    Ok(CommissionTrace {
        order_id: row.order_id.unwrap_or(Uuid::nil()),
        order_item_id,
        salesperson_name: row.salesperson_name.clone(),
        role: row.salesperson_role,
        line_gross: gross,
        base_rate,
        applied_rate,
        flat_spiff,
        total_commission: total,
        source,
        explanation,
    })
}
