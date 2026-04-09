//! Mark fulfilled commission lines as paid out for a date window on the **recognition** clock
//! (pickup / takeaway: `fulfilled_at`; ship: shipment label / in_transit / delivered events — see `report_basis`).

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

/// Sets `commission_payout_finalized_at = now()` for matching lines. Returns rows updated.
pub async fn finalize_realized_commissions(
    pool: &PgPool,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    staff_ids: &[Uuid],
    include_unassigned: bool,
) -> Result<u64, sqlx::Error> {
    if staff_ids.is_empty() && !include_unassigned {
        return Ok(0);
    }

    let rec = crate::logic::report_basis::ORDER_RECOGNITION_TS_SQL.trim();
    let sql = format!(
        r#"
        UPDATE order_items oi
        SET commission_payout_finalized_at = NOW()
        FROM orders o
        WHERE oi.order_id = o.id
          AND o.status::text NOT IN ('cancelled')
          AND oi.is_fulfilled = TRUE
          AND ({rec}) IS NOT NULL
          AND ({rec}) >= $1
          AND ({rec}) < $2
          AND oi.commission_payout_finalized_at IS NULL
          AND oi.calculated_commission > 0
          AND (
            (CARDINALITY($3::uuid[]) > 0 AND oi.salesperson_id = ANY($3::uuid[]))
            OR ($4 AND oi.salesperson_id IS NULL)
          )
        "#,
    );

    let res = sqlx::query(&sql)
        .bind(start)
        .bind(end)
        .bind(staff_ids)
        .bind(include_unassigned)
        .execute(pool)
        .await?;

    Ok(res.rows_affected())
}
