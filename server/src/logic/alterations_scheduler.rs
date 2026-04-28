//! Smart Alterations Scheduler: capacity-aware garment work slot finding.
//! Standardized workweek: Monday to Sunday.

use chrono::{Datelike, Duration, NaiveDate, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::logic::staff_schedule;

/// Daily unit limits (30-minute blocks)
pub const MAX_JACKET_UNITS_PER_DAY: i32 = 28;
pub const MAX_PANT_UNITS_PER_DAY: i32 = 24;

#[derive(Debug, Serialize)]
pub struct CapacitySummary {
    pub date: NaiveDate,
    pub jacket_units_used: i32,
    pub pant_units_used: i32,
    pub jacket_units_available: i32,
    pub pant_units_available: i32,
    pub is_manual_only: bool,
    pub has_staff: bool,
}

/// Calculate units used/available for a given date range.
pub async fn get_capacity_for_range(
    pool: &PgPool,
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> Result<Vec<CapacitySummary>, sqlx::Error> {
    let mut out = Vec::new();
    let mut curr = start_date;

    // 1. Get total units used per day in the range
    let used_units: Vec<(NaiveDate, i32, i32)> = sqlx::query_as(
        r#"
        SELECT 
            (ao.fitting_at AT TIME ZONE 'UTC')::date as d,
            COALESCE(SUM(ao.total_units_jacket), 0)::int as j,
            COALESCE(SUM(ao.total_units_pant), 0)::int as p
        FROM alteration_orders ao
        WHERE ao.fitting_at >= $1 AND ao.fitting_at < $2
        GROUP BY d
        "#,
    )
    .bind(start_date.and_hms_opt(0, 0, 0).unwrap().and_utc())
    .bind(
        (end_date + Duration::days(1))
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc(),
    )
    .fetch_all(pool)
    .await?;

    let used_map: std::collections::HashMap<NaiveDate, (i32, i32)> = used_units
        .into_iter()
        .map(|(d, j, p)| (d, (j, p)))
        .collect();

    while curr <= end_date {
        let (used_j, used_p) = used_map.get(&curr).cloned().unwrap_or((0, 0));

        // 2. Check staff availability
        let working_staff = staff_schedule::list_working_floor_staff_for_date(pool, curr).await?;
        let has_alterations_staff = working_staff
            .iter()
            .any(|s| s.role == crate::models::DbStaffRole::Alterations);

        let is_thursday = curr.weekday() == chrono::Weekday::Thu;

        // If no staff, capacity is 0
        let (max_j, max_p) = if has_alterations_staff {
            (MAX_JACKET_UNITS_PER_DAY, MAX_PANT_UNITS_PER_DAY)
        } else {
            (0, 0)
        };

        out.push(CapacitySummary {
            date: curr,
            jacket_units_used: used_j,
            pant_units_used: used_p,
            jacket_units_available: (max_j - used_j).max(0),
            pant_units_available: (max_p - used_p).max(0),
            is_manual_only: is_thursday,
            has_staff: has_alterations_staff,
        });

        curr += Duration::days(1);
    }

    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct SuggestedSlot {
    pub date: NaiveDate,
    pub score: i32, // Higher score = better slot (e.g. earlier, or balancing load)
}

/// Find best fitting dates for a piece of work.
pub async fn find_suggested_slots(
    pool: &PgPool,
    jacket_units: i32,
    pant_units: i32,
    due_date: NaiveDate,
    search_limit: i32,
) -> Result<Vec<SuggestedSlot>, sqlx::Error> {
    let start_date = Utc::now().naive_utc().date();
    // Finish at least 1 day before due date
    let latest_finish_date = due_date - Duration::days(1);

    if latest_finish_date < start_date {
        return Ok(Vec::new());
    }

    let capacity = get_capacity_for_range(pool, start_date, latest_finish_date).await?;

    let mut suggestions = Vec::new();
    for cap in capacity {
        if cap.is_manual_only {
            continue;
        }
        if !cap.has_staff {
            continue;
        }

        if cap.jacket_units_available >= jacket_units && cap.pant_units_available >= pant_units {
            // Simple scoring: earlier is better
            let days_from_now = (cap.date - start_date).num_days() as i32;
            let score = 100 - days_from_now;

            suggestions.push(SuggestedSlot {
                date: cap.date,
                score,
            });

            if suggestions.len() >= search_limit as usize {
                break;
            }
        }
    }

    suggestions.sort_by_key(|s| -s.score);
    Ok(suggestions)
}

/// Recalculate denormalized units for an alteration order.
pub async fn update_order_unit_totals(pool: &PgPool, order_id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE alteration_orders
        SET 
            total_units_jacket = (
                SELECT COALESCE(SUM(units), 0)
                FROM alteration_order_items
                WHERE alteration_order_id = $1 AND capacity_bucket = 'jacket'
            ),
            total_units_pant = (
                SELECT COALESCE(SUM(units), 0)
                FROM alteration_order_items
                WHERE alteration_order_id = $1 AND capacity_bucket = 'pant'
            ),
            updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(order_id)
    .execute(pool)
    .await?;

    Ok(())
}
