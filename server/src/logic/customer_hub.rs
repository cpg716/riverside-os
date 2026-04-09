//! Aggregates for Customer Relationship Hub (stats, timeline sources, measurements).

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct HubStats {
    pub lifetime_spend_usd: Decimal,
    pub balance_due_usd: Decimal,
    pub wedding_party_count: i64,
    pub last_activity_at: Option<DateTime<Utc>>,
}

pub async fn fetch_hub_stats(pool: &PgPool, customer_id: Uuid) -> Result<HubStats, sqlx::Error> {
    let lifetime_spend_usd: Decimal = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(total_price), 0)::DECIMAL(14, 2)
        FROM orders
        WHERE customer_id = $1
          AND status != 'cancelled'::order_status
        "#,
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await?;

    let balance_due_usd: Decimal = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(balance_due), 0)::DECIMAL(14, 2)
        FROM orders
        WHERE customer_id = $1
          AND status = 'open'::order_status
          AND balance_due > 0
        "#,
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await?;

    let wedding_party_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(DISTINCT wm.wedding_party_id)::BIGINT
        FROM wedding_members wm
        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        WHERE wm.customer_id = $1
          AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
        "#,
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await?;

    let last_activity_at: Option<DateTime<Utc>> = sqlx::query_scalar(
        r#"
        SELECT MAX(ts) FROM (
            SELECT MAX(booked_at) AS ts FROM orders WHERE customer_id = $1
            UNION ALL
            SELECT MAX(created_at) FROM payment_transactions WHERE payer_id = $1
            UNION ALL
            SELECT MAX(created_at) FROM measurements WHERE customer_id = $1
            UNION ALL
            SELECT MAX(measured_at) FROM customer_measurements WHERE customer_id = $1
            UNION ALL
            SELECT MAX(created_at) FROM customer_timeline_notes WHERE customer_id = $1
            UNION ALL
            SELECT MAX(l.created_at)
            FROM wedding_activity_log l
            WHERE EXISTS (
                SELECT 1 FROM wedding_members wm
                WHERE wm.wedding_party_id = l.wedding_party_id
                  AND wm.customer_id = $1
                  AND (
                    l.wedding_member_id IS NULL
                    OR l.wedding_member_id = wm.id
                  )
            )
        ) x
        "#,
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await?;

    Ok(HubStats {
        lifetime_spend_usd,
        balance_due_usd,
        wedding_party_count,
        last_activity_at,
    })
}

pub fn days_since_last_visit(last: Option<DateTime<Utc>>) -> Option<i64> {
    last.map(|t| (Utc::now() - t).num_days())
}
