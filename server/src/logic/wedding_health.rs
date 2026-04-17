use chrono::Utc;
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    Healthy,  // Green
    Concern,  // Amber
    Critical, // Red
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WeddingHealthScore {
    pub wedding_id: Uuid,
    pub overall_score: f64, // 0.0 to 1.0
    pub status: HealthStatus,
    pub payment_progress: f64,
    pub measurement_progress: f64,
    pub days_until_event: i64,
    pub member_count: i64,
    pub measured_count: i64,
    pub reason: String,
}

pub async fn calculate_wedding_health(
    pool: &sqlx::PgPool,
    wedding_id: Uuid,
) -> Result<WeddingHealthScore, sqlx::Error> {
    // 1. Fetch event date
    let event_date = sqlx::query_scalar!(
        "SELECT event_date FROM wedding_parties WHERE id = $1",
        wedding_id
    )
    .fetch_one(pool)
    .await?;

    // 2. Fetch Aggregates
    let stats = sqlx::query!(
        r#"
        SELECT 
            COUNT(DISTINCT c.id) as total_members,
            COUNT(DISTINCT m.customer_id) as measured_members,
            COALESCE(SUM(o.total_price), 0) as total_value,
            COALESCE(SUM(o.amount_paid), 0) as total_paid
        FROM customers c
        LEFT JOIN measurements m ON m.customer_id = c.id
        LEFT JOIN transactions o ON o.customer_id = c.id AND o.status != 'cancelled'
        WHERE c.wedding_id = $1
        "#,
        wedding_id
    )
    .fetch_one(pool)
    .await?;

    let days_until = (event_date - Utc::now().naive_utc().date()).num_days();

    // Measurement Progress
    let total_members = stats.total_members.unwrap_or(0);
    let measured_members = stats.measured_members.unwrap_or(0);
    let measurement_progress = if total_members > 0 {
        measured_members as f64 / total_members as f64
    } else {
        1.0
    };

    // Payment Progress
    let total_value = stats
        .total_value
        .unwrap_or_default()
        .to_f64()
        .unwrap_or(0.0);
    let total_paid = stats.total_paid.unwrap_or_default().to_f64().unwrap_or(0.0);
    let payment_progress = if total_value > 0.0 {
        total_paid / total_value
    } else {
        1.0
    };

    // Overall Score Calculation (Weighted)
    // 40% Measurements, 40% Payments, 20% Baseline
    let mut score = (measurement_progress * 0.4) + (payment_progress * 0.4) + 0.2;

    // Time-based Penalty
    let mut status = HealthStatus::Healthy;
    let mut reason = "On track. Standard follow-up rules apply.".to_string();

    if days_until < 0 {
        reason = "Wedding date has passed.".to_string();
    } else if days_until < 14 {
        if score < 0.9 {
            status = HealthStatus::Critical;
            reason = format!(
                "Critical Risk: Event in {days_until} days with {}% completion.",
                (score * 100.0) as i32
            );
        } else if score < 0.98 {
            status = HealthStatus::Concern;
            reason = format!("Warning: Event in {days_until} days. Finalize remaining fittings.");
        }
    } else if days_until < 30 {
        if score < 0.7 {
            status = HealthStatus::Critical;
            reason =
                "High Risk: Significant missing measurements/payments < 30 days out.".to_string();
        } else if score < 0.85 {
            status = HealthStatus::Concern;
            reason = "Concern: Approaching 30-day window with incomplete party data.".to_string();
        }
    } else if score < 0.5 {
        status = HealthStatus::Concern;
        reason = "Initial Warning: Low engagement for upcoming event.".to_string();
    }

    // Cap score
    score = score.clamp(0.0, 1.0);

    Ok(WeddingHealthScore {
        wedding_id,
        overall_score: score,
        status,
        payment_progress,
        measurement_progress,
        days_until_event: days_until,
        member_count: total_members,
        measured_count: measured_members,
        reason,
    })
}
