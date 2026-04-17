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
    pub loyalty_points: i32,
}

pub async fn fetch_hub_stats(pool: &PgPool, customer_id: Uuid) -> Result<HubStats, sqlx::Error> {
    // If the customer is in a couple, we sum the history for BOTH.
    // However, if the user requested "Only 1 account keeps history as counted",
    // it usually means we report from the primary's perspective.
    // If we're loading the secondary's profile, we still show the combined data.

    let couple_id: Option<Uuid> =
        sqlx::query_scalar("SELECT couple_id FROM customers WHERE id = $1")
            .bind(customer_id)
            .fetch_one(pool)
            .await?;

    let lifetime_spend_usd: Decimal = if let Some(cid) = couple_id {
        sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(total_price), 0)::DECIMAL(14, 2)
            FROM transactions
            WHERE customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
              AND status != 'cancelled'::order_status
              AND booked_at >= '2018-01-01'
            "#,
        )
        .bind(cid)
        .fetch_one(pool)
        .await?
    } else {
        sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(total_price), 0)::DECIMAL(14, 2)
            FROM transactions
            WHERE customer_id = $1
              AND status != 'cancelled'::order_status
              AND booked_at >= '2018-01-01'
            "#,
        )
        .bind(customer_id)
        .fetch_one(pool)
        .await?
    };

    let balance_due_usd: Decimal = if let Some(cid) = couple_id {
        sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(balance_due), 0)::DECIMAL(14, 2)
            FROM transactions
            WHERE customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
              AND status = 'open'::order_status
              AND balance_due > 0
            "#,
        )
        .bind(cid)
        .fetch_one(pool)
        .await?
    } else {
        sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(balance_due), 0)::DECIMAL(14, 2)
            FROM transactions
            WHERE customer_id = $1
              AND status = 'open'::order_status
              AND balance_due > 0
            "#,
        )
        .bind(customer_id)
        .fetch_one(pool)
        .await?
    };

    let wedding_party_count: i64 = if let Some(cid) = couple_id {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(DISTINCT wm.wedding_party_id)::BIGINT
            FROM wedding_members wm
            JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
            WHERE wm.customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
              AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
            "#,
        )
        .bind(cid)
        .fetch_one(pool)
        .await?
    } else {
        sqlx::query_scalar(
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
        .await?
    };

    let last_activity_at: Option<DateTime<Utc>> = if let Some(cid) = couple_id {
        sqlx::query_scalar(
            r#"
            SELECT MAX(ts) FROM (
                SELECT MAX(booked_at) AS ts FROM transactions WHERE customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
                UNION ALL
                SELECT MAX(created_at) FROM payment_transactions WHERE payer_id IN (SELECT id FROM customers WHERE couple_id = $1)
                UNION ALL
                SELECT MAX(created_at) FROM measurements WHERE customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
                UNION ALL
                SELECT MAX(measured_at) FROM customer_measurements WHERE customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
                UNION ALL
                SELECT MAX(created_at) FROM customer_timeline_notes WHERE customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
                UNION ALL
                SELECT MAX(l.created_at)
                FROM wedding_activity_log l
                WHERE EXISTS (
                    SELECT 1 FROM wedding_members wm
                    WHERE wm.wedding_party_id = l.wedding_party_id
                      AND wm.customer_id IN (SELECT id FROM customers WHERE couple_id = $1)
                      AND (
                        l.wedding_member_id IS NULL
                        OR l.wedding_member_id = wm.id
                      )
                )
            ) x
            "#,
        )
        .bind(cid)
        .fetch_one(pool)
        .await?
    } else {
        sqlx::query_scalar(
            r#"
            SELECT MAX(ts) FROM (
                SELECT MAX(booked_at) AS ts FROM transactions WHERE customer_id = $1
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
        .await?
    };

    let loyalty_points: i32 = if let Some(cid) = couple_id {
        sqlx::query_scalar(
            "SELECT COALESCE(SUM(loyalty_points), 0)::INT FROM customers WHERE couple_id = $1",
        )
        .bind(cid)
        .fetch_one(pool)
        .await?
    } else {
        sqlx::query_scalar("SELECT loyalty_points FROM customers WHERE id = $1")
            .bind(customer_id)
            .fetch_one(pool)
            .await?
    };

    Ok(HubStats {
        lifetime_spend_usd,
        balance_due_usd,
        wedding_party_count,
        last_activity_at,
        loyalty_points,
    })
}

pub fn days_since_last_visit(last: Option<DateTime<Utc>>) -> Option<i64> {
    last.map(|t| (Utc::now() - t).num_days())
}
