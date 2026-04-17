//! Morning Compass aggregates + wedding activity log (audit trail).

use crate::logic::staff_schedule;
use crate::logic::wedding_party_display::SQL_PARTY_TRACKING_LABEL_WP;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct CompassStats {
    pub needs_measure: i64,
    pub needs_order: i64,
    pub overdue_pickups: i64,
    pub rush_orders: i64,
}

/// Same shape as API `ActionRow` for dashboard lists.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct CompassActionRow {
    pub wedding_party_id: Uuid,
    pub wedding_member_id: Uuid,
    pub party_name: String,
    pub customer_name: String,
    pub role: String,
    pub status: String,
    pub event_date: chrono::NaiveDate,
}

#[derive(Debug, Clone, Serialize)]
pub struct MorningCompassBundle {
    pub stats: CompassStats,
    pub needs_measure: Vec<CompassActionRow>,
    pub needs_order: Vec<CompassActionRow>,
    pub overdue_pickups: Vec<CompassActionRow>,
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

/// High-level counts for Morning Compass cards (90-day window for measure; active parties only).
pub async fn get_morning_compass_stats(pool: &PgPool) -> Result<CompassStats, sqlx::Error> {
    sqlx::query_as::<_, CompassStats>(
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

async fn list_needs_measure(pool: &PgPool) -> Result<Vec<CompassActionRow>, sqlx::Error> {
    sqlx::query_as::<_, CompassActionRow>(&format!(
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
        "#
    ))
    .fetch_all(pool)
    .await
}

async fn list_needs_order(pool: &PgPool) -> Result<Vec<CompassActionRow>, sqlx::Error> {
    sqlx::query_as::<_, CompassActionRow>(&format!(
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
        "#
    ))
    .fetch_all(pool)
    .await
}

async fn list_overdue_pickups(pool: &PgPool) -> Result<Vec<CompassActionRow>, sqlx::Error> {
    sqlx::query_as::<_, CompassActionRow>(&format!(
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
        "#
    ))
    .fetch_all(pool)
    .await
}

async fn list_rush_orders(pool: &PgPool) -> Result<Vec<RushOrderActionRow>, sqlx::Error> {
    sqlx::query_as::<_, RushOrderActionRow>(
        r#"
        SELECT 
            o.id AS transaction_id,
            COALESCE(NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), 'Customer') AS customer_name,
            total_price::text AS total_price,
            booked_at,
            need_by_date,
            is_rush
        FROM transactions o
        LEFT JOIN customers c ON c.id = o.customer_id
        WHERE (o.is_rush = TRUE OR (o.need_by_date IS NOT NULL AND o.need_by_date <= (CURRENT_DATE + INTERVAL '3 days')))
          AND o.status <> 'fulfilled'
          AND o.status <> 'cancelled'
        ORDER BY o.need_by_date ASC, o.booked_at DESC
        LIMIT 20
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn get_morning_compass_bundle(
    pool: &PgPool,
) -> Result<MorningCompassBundle, sqlx::Error> {
    let stats = get_morning_compass_stats(pool).await?;
    let (needs_measure, needs_order, overdue_pickups, rush_orders) = tokio::try_join!(
        list_needs_measure(pool),
        list_needs_order(pool),
        list_overdue_pickups(pool),
        list_rush_orders(pool),
    )?;
    let today_floor_staff = staff_schedule::list_working_floor_staff_for_local_today(pool)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(
                error = %e,
                "morning compass: today_floor_staff omitted (apply migration 57 if staff schedule is expected)"
            );
            Vec::new()
        });
    Ok(MorningCompassBundle {
        stats,
        needs_measure,
        needs_order,
        overdue_pickups,
        rush_orders,
        today_floor_staff,
    })
}

pub async fn insert_wedding_activity<'e, E>(
    executor: E,
    wedding_party_id: Uuid,
    wedding_member_id: Option<Uuid>,
    actor_name: &str,
    action_type: &str,
    description: &str,
    metadata: serde_json::Value,
) -> Result<(), sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let actor = actor_name.trim();
    let actor = if actor.is_empty() {
        "Riverside POS"
    } else {
        actor
    };
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
    .bind(actor)
    .bind(action_type)
    .bind(description)
    .bind(metadata)
    .execute(executor)
    .await?;
    Ok(())
}
