use crate::logic::pricing::round_money_usd;
use crate::models::DbStaffRole;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct CommissionTrace {
    pub transaction_id: Uuid,
    pub transaction_line_id: Uuid,
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
    transaction_line_id: Uuid,
) -> Result<CommissionTrace, String> {
    // 1. Fetch the order item and salesperson info
    let row = sqlx::query(
        r#"
        SELECT 
            oi.transaction_id,
            oi.unit_price,
            oi.quantity,
            oi.salesperson_id,
            oi.variant_id,
            p.id as product_id,
            p.category_id,
            s.full_name as salesperson_name,
            s.role as salesperson_role,
            s.base_commission_rate as staff_base_rate,
            p.name as product_name
        FROM transaction_lines oi
        JOIN product_variants pv ON oi.variant_id = pv.id
        JOIN products p ON pv.product_id = p.id
        LEFT JOIN staff s ON oi.salesperson_id = s.id
        WHERE oi.id = $1
        "#,
    )
    .bind(transaction_line_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Order item not found".to_string())?;

    use sqlx::Row;
    let salesperson_role: DbStaffRole = row.get("salesperson_role");

    let _sid = row
        .get::<Option<Uuid>, _>("salesperson_id")
        .ok_or_else(|| "No salesperson attributed to this line".to_string())?;
    let base_rate = row
        .get::<Option<Decimal>, _>("staff_base_rate")
        .unwrap_or(Decimal::ZERO);
    let gross = row.get::<Decimal, _>("unit_price") * Decimal::from(row.get::<i32, _>("quantity"));

    // 2. Replication of logic in sales_commission.rs with TRACE capturing
    // Use specialty rule lookup first (Specificity: Variant > Product > Category)
    let rule = sqlx::query(
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
    )
    .bind(row.get::<Uuid, _>("variant_id"))
    .bind(row.get::<Uuid, _>("product_id"))
    .bind(row.get::<Option<Uuid>, _>("category_id"))
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut applied_rate = base_rate;
    let mut flat_spiff = Decimal::ZERO;
    let mut source = "Staff Base Rate".to_string();
    let mut explanation = format!(
        "Calculated using default staff commission ({}%) for {:?}.",
        base_rate * Decimal::from(100),
        salesperson_role
    );

    if let Some(r) = rule {
        let match_type = r.get::<String, _>("match_type");
        applied_rate = r
            .get::<Option<Decimal>, _>("override_rate")
            .unwrap_or(base_rate);
        flat_spiff = r
            .get::<Option<Decimal>, _>("fixed_spiff_amount")
            .unwrap_or(Decimal::ZERO)
            * Decimal::from(row.get::<i32, _>("quantity"));
        source = format!("{} Rule", match_type[..1].to_uppercase() + &match_type[1..]);
        explanation = format!(
            "Specific {} rule match. Rule ID: {}. Captured rate: {}% + ${} fixed SPIFF per unit.",
            match_type,
            r.get::<Uuid, _>("id"),
            applied_rate * Decimal::from(100),
            r.get::<Option<Decimal>, _>("fixed_spiff_amount")
                .unwrap_or(Decimal::ZERO)
        );
    } else {
        // Fallback to legacy
        if let Some(cid) = row.get::<Option<Uuid>, _>("category_id") {
            let legacy_rate: Option<Decimal> = sqlx::query_scalar(
                "SELECT commission_rate FROM category_commission_overrides WHERE category_id = $1",
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
        transaction_id: row
            .get::<Option<Uuid>, _>("transaction_id")
            .unwrap_or(Uuid::nil()),
        transaction_line_id,
        salesperson_name: row.get::<String, _>("salesperson_name"),
        role: salesperson_role,
        line_gross: gross,
        base_rate,
        applied_rate,
        flat_spiff,
        total_commission: total,
        source,
        explanation,
    })
}
