//! Registry Priority Feed aggregates + wedding activity log (audit trail).

use crate::logic::staff_schedule;
use crate::logic::wedding_party_display::SQL_PARTY_TRACKING_LABEL_WP;
use serde::Serialize;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct RegistryPriorityStats {
    pub needs_measure: i64,
    pub needs_order: i64,
    pub overdue_pickups: i64,
    pub rush_orders: i64,
}

/// Same shape as API `RegistryActionRow` for dashboard lists.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct RegistryActionRow {
    pub wedding_party_id: Uuid,
    pub wedding_member_id: Uuid,
    pub party_name: String,
    pub customer_name: String,
    pub role: String,
    pub status: String,
    pub event_date: chrono::NaiveDate,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegistryPriorityFeedBundle {
    pub stats: RegistryPriorityStats,
    pub needs_measure: Vec<RegistryActionRow>,
    pub needs_order: Vec<RegistryActionRow>,
    pub overdue_pickups: Vec<RegistryActionRow>,
    pub rush_orders: Vec<RushOrderActionRow>,
    /// Salesperson / sales_support roster members scheduled to work **today** (store-local date); uses `staff_effective_working_day`. Empty if schema not migrated or on error.
    #[serde(default)]
    pub today_floor_staff: Vec<staff_schedule::FloorStaffTodayRow>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct RushOrderActionRow {
    pub transaction_id: Uuid,
    pub customer_name: String,
    pub total_price: String,
    pub booked_at: chrono::DateTime<chrono::Utc>,
    pub need_by_date: Option<chrono::NaiveDate>,
    pub is_rush: bool,
}

/// High-level counts for Registry Priority Feed cards (90-day window for measure; active parties only).
pub async fn get_registry_priority_stats(
    pool: &PgPool,
) -> Result<RegistryPriorityStats, sqlx::Error> {
    sqlx::query_as::<_, RegistryPriorityStats>(
        r#"
        SELECT
            COUNT(*) FILTER (
                WHERE wp.event_date <= (CURRENT_DATE + INTERVAL '90 days')
                  AND wm.measured IS NOT TRUE
                  AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
            ) AS needs_measure,
            COUNT(*) FILTER (
                WHERE wm.measured = TRUE
                  AND wm.suit_ordered IS NOT TRUE
                  AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
            ) AS needs_order,
            COUNT(*) FILTER (
                WHERE wp.event_date < CURRENT_DATE
                  AND (wm.pickup_status IS NULL OR wm.pickup_status <> 'complete')
                  AND (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
            ) AS overdue_pickups,
            COUNT(*) FILTER (
                WHERE o.is_rush = TRUE OR (o.need_by_date IS NOT NULL AND o.need_by_date <= (CURRENT_DATE + INTERVAL '3 days'))
            ) AS rush_orders
        FROM wedding_members wm
        JOIN wedding_parties wp ON wm.wedding_party_id = wp.id
        FULL OUTER JOIN transactions o ON o.customer_id = wp.id -- Just for the count, though orders can be standalone
        "#,
    )
    .fetch_one(pool)
    .await
}

async fn list_needs_measure(pool: &PgPool) -> Result<Vec<RegistryActionRow>, sqlx::Error> {
    sqlx::query_as::<_, RegistryActionRow>(&format!(
        r#"
        SELECT
            wp.id AS wedding_party_id,
            wm.id AS wedding_member_id,
            {SQL_PARTY_TRACKING_LABEL_WP} AS party_name,
            COALESCE(NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), 'Unknown') AS customer_name,
            wm.role,
            wm.status,
            wp.event_date
        FROM wedding_members wm
        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        JOIN customers c ON c.id = wm.customer_id
        WHERE (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
          AND wp.event_date <= (CURRENT_DATE + INTERVAL '90 days')
          AND wm.measured IS NOT TRUE
        ORDER BY wp.event_date ASC, customer_name ASC
        "#,
    ))
    .fetch_all(pool)
    .await
}

async fn list_needs_order(pool: &PgPool) -> Result<Vec<RegistryActionRow>, sqlx::Error> {
    sqlx::query_as::<_, RegistryActionRow>(&format!(
        r#"
        SELECT
            wp.id AS wedding_party_id,
            wm.id AS wedding_member_id,
            {SQL_PARTY_TRACKING_LABEL_WP} AS party_name,
            COALESCE(NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), 'Unknown') AS customer_name,
            wm.role,
            wm.status,
            wp.event_date
        FROM wedding_members wm
        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        JOIN customers c ON c.id = wm.customer_id
        WHERE (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
          AND wm.measured = TRUE
          AND wm.suit_ordered IS NOT TRUE
        ORDER BY wp.event_date ASC, customer_name ASC
        "#,
    ))
    .fetch_all(pool)
    .await
}

async fn list_overdue_pickups(pool: &PgPool) -> Result<Vec<RegistryActionRow>, sqlx::Error> {
    sqlx::query_as::<_, RegistryActionRow>(&format!(
        r#"
        SELECT
            wp.id AS wedding_party_id,
            wm.id AS wedding_member_id,
            {SQL_PARTY_TRACKING_LABEL_WP} AS party_name,
            COALESCE(NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), 'Unknown') AS customer_name,
            wm.role,
            wm.status,
            wp.event_date
        FROM wedding_members wm
        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        JOIN customers c ON c.id = wm.customer_id
        WHERE (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
          AND wp.event_date < CURRENT_DATE
          AND (wm.pickup_status IS NULL OR wm.pickup_status <> 'complete')
        ORDER BY wp.event_date ASC, customer_name ASC
        "#,
    ))
    .fetch_all(pool)
    .await
}

async fn list_rush_orders(pool: &PgPool) -> Result<Vec<RushOrderActionRow>, sqlx::Error> {
    sqlx::query_as::<_, RushOrderActionRow>(
        r#"
        SELECT
            t.id AS transaction_id,
            COALESCE(
                NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''),
                NULLIF(TRIM(t.counterpoint_customer_code), ''),
                'Unknown'
            ) AS customer_name,
            t.total_price::text,
            t.booked_at,
            t.need_by_date,
            t.is_rush
        FROM transactions t
        LEFT JOIN customers c ON c.id = t.customer_id
        WHERE is_rush = TRUE OR (need_by_date IS NOT NULL AND need_by_date <= (CURRENT_DATE + INTERVAL '5 days'))
        ORDER BY t.is_rush DESC, t.need_by_date ASC
        LIMIT 20
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn get_registry_priority_feed_bundle(
    pool: &PgPool,
) -> Result<RegistryPriorityFeedBundle, sqlx::Error> {
    let stats = get_registry_priority_stats(pool).await?;
    let needs_measure = list_needs_measure(pool).await?;
    let needs_order = list_needs_order(pool).await?;
    let overdue_pickups = list_overdue_pickups(pool).await?;
    let rush_orders = list_rush_orders(pool).await?;

    let today_floor_staff = match staff_schedule::get_today_floor_roster(pool).await {
        Ok(v) => v,
        Err(_) => vec![],
    };

    Ok(RegistryPriorityFeedBundle {
        stats,
        needs_measure,
        needs_order,
        overdue_pickups,
        rush_orders,
        today_floor_staff,
    })
}

/// Records a wedding-related activity in the centralized logout.
pub async fn insert_wedding_activity<'a, E>(
    executor: E,
    wedding_party_id: Uuid,
    wedding_member_id: Option<Uuid>,
    actor_name: &str,
    action_type: &str,
    description: &str,
    metadata: Value,
) -> Result<(), sqlx::Error>
where
    E: sqlx::Executor<'a, Database = sqlx::Postgres>,
{
    sqlx::query(
        r#"
        INSERT INTO wedding_activity_log (
            wedding_party_id, wedding_member_id, actor_name, action_type, description, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(wedding_party_id)
    .bind(wedding_member_id)
    .bind(actor_name)
    .bind(action_type)
    .bind(description)
    .bind(metadata)
    .execute(executor)
    .await?;
    Ok(())
}
