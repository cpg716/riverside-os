use chrono::{DateTime, Utc, NaiveDate};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;
use rust_decimal::Decimal;
use crate::models::DbOrderStatus;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FulfillmentUrgency {
    Rush,
    DueSoon,
    Standard,
    Blocked,
    Ready,
}

#[derive(Debug, Serialize, FromRow)]
pub struct FulfillmentQueueItem {
    pub transaction_id: Uuid,
    pub order_short_id: String,
    pub booked_at: DateTime<Utc>,
    pub status: DbOrderStatus,
    pub customer_id: Option<Uuid>,
    pub customer_name: Option<String>,
    pub item_count: i64,
    pub fulfilled_item_count: i64,
    pub urgency: FulfillmentUrgency,
    pub next_deadline: Option<NaiveDate>,
    pub balance_due: Decimal,
    pub wedding_party_name: Option<String>,
}

pub async fn query_fulfillment_queue(
    pool: &sqlx::PgPool,
) -> Result<Vec<FulfillmentQueueItem>, sqlx::Error> {
    // We target orders that are 'open' or 'pending_measurement'
    // and have at least one unfulfilled item (except for 'Ready' status).
    
    let rows = sqlx::query!(
        r#"
        WITH order_stats AS (
            SELECT 
                o.id AS transaction_id,
                o.booked_at,
                o.status,
                o.balance_due,
                o.customer_id,
                o.wedding_id,
                (c.first_name || ' ' || c.last_name) as customer_name,
                wp.party_name AS wedding_party_name,
                COUNT(oi.id) AS total_items,
                COUNT(oi.id) FILTER (WHERE oi.is_fulfilled) AS fulfilled_items,
                BOOL_OR(oi.is_rush) AS was_rush,
                MIN(oi.need_by_date) AS earliest_deadline
            FROM transactions o
            LEFT JOIN customers c ON c.id = o.customer_id
            LEFT JOIN transaction_lines oi ON oi.transaction_id = o.id
            LEFT JOIN wedding_parties wp ON wp.id = o.wedding_id
            WHERE o.status IN ('open', 'pending_measurement')
            GROUP BY o.id, c.id, wp.id
        )
        SELECT 
            transaction_id,
            booked_at,
            status AS "status: DbOrderStatus",
            customer_id,
            customer_name,
            wedding_party_name,
            total_items AS item_count,
            fulfilled_items AS fulfilled_item_count,
            was_rush,
            earliest_deadline,
            balance_due
        FROM order_stats
        ORDER BY was_rush DESC, earliest_deadline ASC NULLS LAST, booked_at ASC
        "#
    )
    .fetch_all(pool)
    .await?;

    let now = Utc::now().naive_utc().date();
    let four_days_from_now = now + chrono::Duration::days(4);

    let items = rows.into_iter().map(|r| {
        let mut urgency = FulfillmentUrgency::Standard;
        
        let total_items = r.item_count.unwrap_or(0);
        let fulfilled_items = r.fulfilled_item_count.unwrap_or(0);
        let booked_at = r.booked_at.unwrap_or_else(Utc::now);

        if total_items == fulfilled_items && total_items > 0 {
             urgency = FulfillmentUrgency::Ready;
        } else if r.was_rush.unwrap_or(false) {
            urgency = FulfillmentUrgency::Rush;
        } else if let Some(deadline) = r.earliest_deadline {
            if deadline <= four_days_from_now {
                urgency = FulfillmentUrgency::DueSoon;
            }
        } else if booked_at < Utc::now() - chrono::Duration::days(14) {
            urgency = FulfillmentUrgency::Blocked;
        }

        FulfillmentQueueItem {
            transaction_id: r.transaction_id,
            order_short_id: r.transaction_id.to_string()[..8].to_string(), 
            booked_at,
            status: r.status.unwrap_or(DbOrderStatus::Open),
            customer_id: r.customer_id,
            customer_name: r.customer_name,
            item_count: total_items,
            fulfilled_item_count: fulfilled_items,
            urgency,
            next_deadline: r.earliest_deadline,
            balance_due: r.balance_due,
            wedding_party_name: r.wedding_party_name,
        }
    }).collect();

    Ok(items)
}
