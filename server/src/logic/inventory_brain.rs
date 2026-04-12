use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecommendationType {
    Reorder,
    Clearance,
    Bundle,
    PriceReview,
}

#[derive(Debug, Serialize, FromRow)]
pub struct InventoryRecommendation {
    pub variant_id: Uuid,
    pub product_id: Uuid,
    pub sku: String,
    pub product_name: String,
    pub recommendation_type: RecommendationType,
    pub confidence: f64,
    pub velocity_45: f64,
    pub stock_on_hand: i32,
    pub suggested_action: String,
    pub reason: String,
}

pub async fn query_inventory_recommendations(
    pool: &PgPool,
) -> Result<Vec<InventoryRecommendation>, sqlx::Error> {
    let now = Utc::now();
    let start_45 = now - chrono::Duration::days(45);
    
    // 1. Fetch Velocity Data and Stock levels
    let rows = sqlx::query!(
        r#"
        WITH velocity AS (
            SELECT 
                oi.variant_id,
                SUM(oi.quantity)::float / 45.0 as daily_velocity
            FROM order_items oi
            INNER JOIN orders o ON o.id = oi.order_id
            WHERE o.status != 'cancelled'
              AND o.booked_at >= $1
            GROUP BY oi.variant_id
        )
        SELECT 
            pv.id as variant_id,
            p.id as product_id,
            pv.sku,
            p.name as product_name,
            pv.stock_on_hand,
            COALESCE(v.daily_velocity, 0.0) as velocity_daily
        FROM product_variants pv
        INNER JOIN products p ON p.id = pv.product_id
        LEFT JOIN velocity v ON v.variant_id = pv.id
        WHERE p.is_active = TRUE
        "#,
        start_45
    )
    .fetch_all(pool)
    .await?;

    let mut recs = Vec::new();

    for r in rows {
        let mut recommendation = None;
        let v_daily = r.velocity_daily.unwrap_or(0.0);
        let stock = r.stock_on_hand.unwrap_or(0);

        // Rule A: Reorder (Stock out in < 14 days)
        if v_daily > 0.0 {
            let days_left = stock as f64 / v_daily;
            if days_left < 14.0 {
                recommendation = Some(InventoryRecommendation {
                    variant_id: r.variant_id,
                    product_id: r.product_id,
                    sku: r.sku.clone(),
                    product_name: r.product_name.clone(),
                    recommendation_type: RecommendationType::Reorder,
                    confidence: 0.9,
                    velocity_45: v_daily * 45.0,
                    stock_on_hand: stock,
                    suggested_action: format!("Reorder {} units", (v_daily * 30.0).ceil() as i32),
                    reason: format!("Projected stock-out in {days_left:.1} days"),
                });
            }
        }

        // Rule B: Clearance (Dead stock)
        if recommendation.is_none() && v_daily == 0.0 && stock > 10 {
             recommendation = Some(InventoryRecommendation {
                variant_id: r.variant_id,
                product_id: r.product_id,
                sku: r.sku.clone(),
                product_name: r.product_name.clone(),
                recommendation_type: RecommendationType::Clearance,
                confidence: 0.7,
                velocity_45: 0.0,
                stock_on_hand: stock,
                suggested_action: "Flash Sale / 20% Markdown".to_string(),
                reason: "Zero sales in last 45 days despite high stock".to_string(),
            });
        }

        if let Some(res) = recommendation {
            recs.push(res);
        }
    }

    // Sort by confidence or urgency
    recs.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());

    Ok(recs)
}

// Support for Recommended Bundles (Phase 3.5)
pub async fn query_recommended_bundles(
    _pool: &PgPool,
) -> Result<Vec<String>, sqlx::Error> {
    Ok(vec![])
}
