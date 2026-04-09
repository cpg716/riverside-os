//! Pre-tax **gross margin** pivot: `SUM(unit_price * qty)` − `SUM(unit_cost * qty)` on `order_items`,
//! using the same **booked** vs **completed (recognition)** axis as sales pivot.
//!
//! `unit_cost` is the value **frozen at checkout** on each line.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::types::Json as SqlxJson;
use sqlx::{FromRow, PgPool};
use thiserror::Error;
use uuid::Uuid;

use super::report_basis::{order_date_filter_sql, ReportBasis, ORDER_RECOGNITION_TS_SQL};

#[derive(Debug, Error)]
pub enum MarginPivotError {
    #[error("{0}")]
    BadRequest(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Serialize, FromRow)]
pub struct MarginPivotRow {
    pub bucket: String,
    pub gross_revenue: Decimal,
    pub tax_collected: Decimal,
    pub cost_of_goods: Decimal,
    pub gross_margin: Decimal,
    /// Pre-tax gross margin as % of pre-tax line revenue (0–100 scale).
    pub margin_percent: Decimal,
    pub order_count: i64,
    pub line_units: i64,
    pub weather_snapshot: Option<SqlxJson<serde_json::Value>>,
    pub closing_comments: Option<String>,
    pub customer_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct MarginPivotResponse {
    pub rows: Vec<MarginPivotRow>,
    pub truncated: bool,
}

pub async fn run_margin_pivot(
    pool: &PgPool,
    group_by: &str,
    basis: ReportBasis,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<MarginPivotResponse, MarginPivotError> {
    let completed = basis.is_completed();
    let gb = group_by.to_lowercase();

    if gb == "customer" {
        let date_filter = if completed {
            order_date_filter_sql(ReportBasis::Completed)
        } else {
            order_date_filter_sql(ReportBasis::Booked)
        };
        let sql = format!(
            r#"
            SELECT
                CASE
                    WHEN o.customer_id IS NULL THEN '— No customer —'
                    ELSE
                        COALESCE(
                            NULLIF(
                                TRIM(
                                    COALESCE(MAX(cust.first_name), '')
                                    || ' '
                                    || COALESCE(MAX(cust.last_name), '')
                                ),
                                ''
                            ),
                            '(No name)'
                        )
                        || ' · '
                        || COALESCE(MAX(cust.customer_code), '')
                END AS bucket,
                COALESCE(SUM((oi.unit_price * oi.quantity)::numeric), 0)::numeric(14, 2) AS gross_revenue,
                COALESCE(SUM((oi.state_tax + oi.local_tax)::numeric), 0)::numeric(14, 2) AS tax_collected,
                COALESCE(SUM((oi.unit_cost * oi.quantity)::numeric), 0)::numeric(14, 2) AS cost_of_goods,
                (COALESCE(SUM((oi.unit_price * oi.quantity)::numeric), 0)
                  - COALESCE(SUM((oi.unit_cost * oi.quantity)::numeric), 0))::numeric(14, 2) AS gross_margin,
                CASE
                    WHEN COALESCE(SUM((oi.unit_price * oi.quantity)::numeric), 0) > 0 THEN
                        ((COALESCE(SUM((oi.unit_price * oi.quantity)::numeric), 0)
                          - COALESCE(SUM((oi.unit_cost * oi.quantity)::numeric), 0))
                         / NULLIF(COALESCE(SUM((oi.unit_price * oi.quantity)::numeric), 0), 0) * 100)
                        ::numeric(14, 2)
                    ELSE 0::numeric(14, 2)
                END AS margin_percent,
                COUNT(DISTINCT o.id)::bigint AS order_count,
                COALESCE(SUM(oi.quantity::bigint), 0)::bigint AS line_units,
                NULL::jsonb AS weather_snapshot,
                NULL::text AS closing_comments,
                o.customer_id AS customer_id
            FROM order_items oi
            INNER JOIN orders o ON o.id = oi.order_id
            INNER JOIN products p ON p.id = oi.product_id
            LEFT JOIN customers cust ON cust.id = o.customer_id
            LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN staff st ON st.id = oi.salesperson_id
            WHERE {date_filter}
            GROUP BY o.customer_id
            ORDER BY gross_revenue DESC NULLS LAST
            LIMIT 201
            "#,
        );
        let mut rows = sqlx::query_as::<_, MarginPivotRow>(&sql)
            .bind(start)
            .bind(end)
            .fetch_all(pool)
            .await?;
        let truncated = rows.len() > 200;
        rows.truncate(200);
        return Ok(MarginPivotResponse { rows, truncated });
    }

    let date_filter = if completed {
        order_date_filter_sql(ReportBasis::Completed)
    } else {
        order_date_filter_sql(ReportBasis::Booked)
    };

    let sql = if gb == "date" {
        let date_key = if completed {
            format!(
                "(({ts}) AT TIME ZONE 'UTC')::date",
                ts = ORDER_RECOGNITION_TS_SQL.trim()
            )
        } else {
            "(o.booked_at AT TIME ZONE 'UTC')::date".to_string()
        };
        format!(
            r#"
            WITH agg AS (
                SELECT
                    {date_key}::text AS bucket,
                    COALESCE(SUM((oi.unit_price * oi.quantity)::numeric), 0)::numeric(14, 2) AS gross_revenue,
                    COALESCE(SUM((oi.state_tax + oi.local_tax)::numeric), 0)::numeric(14, 2) AS tax_collected,
                    COALESCE(SUM((oi.unit_cost * oi.quantity)::numeric), 0)::numeric(14, 2) AS cost_of_goods,
                    COUNT(DISTINCT o.id)::bigint AS order_count,
                    COALESCE(SUM(oi.quantity::bigint), 0)::bigint AS line_units,
                    {date_key} AS sale_day,
                    NULL::uuid AS customer_id
                FROM order_items oi
                INNER JOIN orders o ON o.id = oi.order_id
                INNER JOIN products p ON p.id = oi.product_id
                LEFT JOIN categories c ON c.id = p.category_id
                LEFT JOIN staff st ON st.id = oi.salesperson_id
                WHERE {date_filter}
                GROUP BY {date_key}
            )
            SELECT
                bucket,
                gross_revenue,
                tax_collected,
                cost_of_goods,
                (gross_revenue - cost_of_goods)::numeric(14, 2) AS gross_margin,
                CASE
                    WHEN gross_revenue > 0 THEN
                        ((gross_revenue - cost_of_goods) / gross_revenue * 100)::numeric(14, 2)
                    ELSE 0::numeric(14, 2)
                END AS margin_percent,
                order_count,
                line_units,
                (
 SELECT weather_snapshot FROM register_sessions rs
 WHERE (rs.opened_at AT TIME ZONE 'UTC')::date = agg.sale_day
 ORDER BY rs.closed_at DESC NULLS LAST LIMIT 1
 ) AS weather_snapshot,
                (
 SELECT closing_comments FROM register_sessions rs
 WHERE (rs.opened_at AT TIME ZONE 'UTC')::date = agg.sale_day
 ORDER BY rs.closed_at DESC NULLS LAST LIMIT 1
 ) AS closing_comments,
                customer_id
            FROM agg
            ORDER BY bucket DESC
            LIMIT 201
            "#,
        )
    } else {
        let dim_sql: &str = match gb.as_str() {
            "brand" => "COALESCE(NULLIF(TRIM(p.brand), ''), '— No brand —')",
            "salesperson" => "COALESCE(st.full_name, 'Unassigned')",
            "category" => "COALESCE(c.name, 'Uncategorized')",
            _ => {
                return Err(MarginPivotError::BadRequest(
                    "group_by must be 'brand', 'salesperson', 'category', 'customer', or 'date'"
                        .to_string(),
                ));
            }
        };
        format!(
            r#"
            SELECT
                {dim_sql} AS bucket,
                COALESCE(SUM((oi.unit_price * oi.quantity)::numeric), 0)::numeric(14, 2) AS gross_revenue,
                COALESCE(SUM((oi.state_tax + oi.local_tax)::numeric), 0)::numeric(14, 2) AS tax_collected,
                COALESCE(SUM((oi.unit_cost * oi.quantity)::numeric), 0)::numeric(14, 2) AS cost_of_goods,
                (COALESCE(SUM((oi.unit_price * oi.quantity)::numeric), 0)
                  - COALESCE(SUM((oi.unit_cost * oi.quantity)::numeric), 0))::numeric(14, 2) AS gross_margin,
                CASE
                    WHEN COALESCE(SUM((oi.unit_price * oi.quantity)::numeric), 0) > 0 THEN
                        ((COALESCE(SUM((oi.unit_price * oi.quantity)::numeric), 0)
                          - COALESCE(SUM((oi.unit_cost * oi.quantity)::numeric), 0))
                         / NULLIF(COALESCE(SUM((oi.unit_price * oi.quantity)::numeric), 0), 0) * 100)
                        ::numeric(14, 2)
                    ELSE 0::numeric(14, 2)
                END AS margin_percent,
                COUNT(DISTINCT o.id)::bigint AS order_count,
                COALESCE(SUM(oi.quantity::bigint), 0)::bigint AS line_units,
                NULL::jsonb AS weather_snapshot,
                NULL::text AS closing_comments,
                NULL::uuid AS customer_id
            FROM order_items oi
            INNER JOIN orders o ON o.id = oi.order_id
            INNER JOIN products p ON p.id = oi.product_id
            LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN staff st ON st.id = oi.salesperson_id
            WHERE {date_filter}
            GROUP BY {dim_sql}
            ORDER BY gross_revenue DESC NULLS LAST
            LIMIT 201
            "#,
        )
    };

    let mut rows = sqlx::query_as::<_, MarginPivotRow>(&sql)
        .bind(start)
        .bind(end)
        .fetch_all(pool)
        .await?;
    let truncated = rows.len() > 200;
    rows.truncate(200);

    Ok(MarginPivotResponse { rows, truncated })
}
