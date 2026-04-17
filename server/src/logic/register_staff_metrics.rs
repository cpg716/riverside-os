//! Floor dashboard: attributed line sales tied to payments on the store calendar day.

use chrono_tz::Tz;
use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, serde::Serialize)]
pub struct RegisterStaffMetrics {
    pub line_count: i64,
    pub attributed_gross: String,
    pub store_date: String,
    pub timezone: String,
}

fn effective_timezone(raw: Option<String>) -> String {
    let s = raw.unwrap_or_default();
    let t = s.trim();
    if t.is_empty() {
        return "America/New_York".to_string();
    }
    if t.parse::<Tz>().is_ok() {
        t.to_string()
    } else {
        "America/New_York".to_string()
    }
}

pub async fn staff_attributed_sales_store_day(
    pool: &PgPool,
    staff_id: Uuid,
) -> Result<RegisterStaffMetrics, sqlx::Error> {
    let tz_raw: Option<String> = sqlx::query_scalar(
        r#"
        SELECT receipt_config->>'timezone'
        FROM store_settings
        WHERE id = 1
        "#,
    )
    .fetch_optional(pool)
    .await?
    .flatten();

    let tz = effective_timezone(tz_raw);

    let store_date: String = sqlx::query_scalar(
        r#"
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE $1)::date::text
        "#,
    )
    .bind(&tz)
    .fetch_one(pool)
    .await?;

    let row: (i64, Option<Decimal>) = sqlx::query_as(
        r#"
        WITH paid_orders_today AS (
            SELECT DISTINCT pa.target_transaction_id AS transaction_id
            FROM payment_transactions pt
            INNER JOIN payment_allocations pa ON pa.transaction_id = pt.id
            WHERE (pt.created_at AT TIME ZONE $2)::date
                = (CURRENT_TIMESTAMP AT TIME ZONE $2)::date
        )
        SELECT
            COUNT(*)::bigint,
            COALESCE(SUM(oi.quantity::numeric * oi.unit_price), 0)::numeric(14, 2)
        FROM transaction_lines oi
        INNER JOIN paid_orders_today po ON po.transaction_id = oi.transaction_id
        WHERE oi.salesperson_id = $1
        "#,
    )
    .bind(staff_id)
    .bind(&tz)
    .fetch_one(pool)
    .await?;

    let gross = row.1.unwrap_or(Decimal::ZERO);
    Ok(RegisterStaffMetrics {
        line_count: row.0,
        attributed_gross: gross.to_string(),
        store_date,
        timezone: tz,
    })
}
