//! Reporting / pivot shell: sales perspectives, commission split-date view, NYS tax audit, staff HUD.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{DateTime, Duration, NaiveDate, NaiveTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::Value;
use sqlx::types::Json as SqlxJson;
use sqlx::FromRow;
use sqlx::PgPool;
use std::collections::HashMap;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    INSIGHTS_COMMISSION_FINALIZE, INSIGHTS_VIEW, REGISTER_REPORTS, STAFF_MANAGE_COMMISSION,
};
use crate::auth::pins::log_staff_access;
use crate::logic::commission_events::ManualCommissionAdjustment;
use crate::logic::commission_payout::finalize_realized_commissions;
use crate::logic::insights_config::StoreInsightsConfig;
use crate::logic::inventory_velocity;
use crate::logic::margin_pivot as margin_reporting;
use crate::logic::metabase_staff_jwt::mint_metabase_staff_jwt;
use crate::logic::register_day_activity;
use crate::logic::report_basis::{
    order_date_filter_sql, order_recognition_tax_filter_sql, parse_report_basis, ReportBasis,
    ORDER_RECOGNITION_TS_SQL,
};
use crate::logic::tax::CLOTHING_FOOTWEAR_EXEMPTION_THRESHOLD_USD;
use crate::middleware::{require_authenticated_staff_headers, require_staff_with_permission};
use crate::models::DbStaffRole;

#[derive(Debug, Error)]
pub enum InsightsError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Invalid query: {0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct RosieReportingRunResponse {
    pub spec_id: String,
    pub route: &'static str,
    pub required_permission: &'static str,
    pub params: Value,
    pub data: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RosieReportingRunRequest {
    pub spec_id: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RosieDateRangeParams {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RosieSalesPivotParams {
    #[serde(default = "default_group_by")]
    pub group_by: String,
    #[serde(default = "default_basis")]
    pub basis: String,
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RosieBestSellersParams {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    #[serde(default = "default_insights_report_basis")]
    pub basis: String,
    #[serde(default = "default_velocity_limit")]
    pub limit: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RosieDeadStockParams {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    #[serde(default = "default_insights_report_basis")]
    pub basis: String,
    #[serde(default = "default_velocity_limit")]
    pub limit: i64,
    #[serde(default)]
    pub max_units_sold: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RosieStaffPerformanceParams {
    pub basis: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RosieRegisterSessionsParams {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    #[serde(default = "default_register_sessions_limit")]
    pub limit: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RosieRegisterOverrideMixParams {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    #[serde(default = "default_insights_report_basis")]
    pub basis: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RosieRegisterDayActivityParams {
    pub preset: Option<String>,
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    pub register_session_id: Option<Uuid>,
    #[serde(default = "default_insights_report_basis")]
    pub basis: String,
}

impl IntoResponse for InsightsError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            InsightsError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            InsightsError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            InsightsError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            InsightsError::Database(e) => {
                tracing::error!(error = %e, "Database error in insights");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

#[derive(Debug, Deserialize)]
pub struct DateRangeQuery {
    /// Inclusive start (UTC date). Defaults to 90 days ago.
    pub from: Option<NaiveDate>,
    /// Exclusive end (UTC date). Defaults to tomorrow UTC.
    pub to: Option<NaiveDate>,
}

fn naive_day_start_utc(d: NaiveDate) -> DateTime<Utc> {
    match d.and_hms_opt(0, 0, 0) {
        Some(naive_dt) => DateTime::from_naive_utc_and_offset(naive_dt, Utc),
        None => Utc::now(),
    }
}

fn range_bounds(q: &DateRangeQuery) -> (DateTime<Utc>, DateTime<Utc>) {
    let end =
        q.to.map(|d| naive_day_start_utc(d) + Duration::days(1))
            .unwrap_or_else(|| Utc::now() + Duration::days(1));
    let start = q
        .from
        .map(naive_day_start_utc)
        .unwrap_or_else(|| end - Duration::days(90));
    (start, end)
}

fn default_insights_report_basis() -> String {
    "booked".to_string()
}

/// Cost / margin reporting: **Admin role only** (not `insights.view` alone).
async fn require_admin_for_margin_analytics(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), InsightsError> {
    let staff = require_authenticated_staff_headers(state, headers)
        .await
        .map_err(|(st, _)| {
            if st == StatusCode::UNAUTHORIZED {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            } else {
                InsightsError::Forbidden("staff authentication failed".to_string())
            }
        })?;
    if staff.role != DbStaffRole::Admin {
        return Err(InsightsError::Forbidden(
            "Admin role required for margin reporting".to_string(),
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct DateRangeWithBasisQuery {
    #[serde(flatten)]
    pub range: DateRangeQuery,
    #[serde(default = "default_insights_report_basis")]
    pub basis: String,
}

fn default_velocity_limit() -> i64 {
    100
}

#[derive(Debug, Deserialize)]
pub struct BestSellersQuery {
    #[serde(flatten)]
    pub range: DateRangeQuery,
    #[serde(default = "default_insights_report_basis")]
    pub basis: String,
    #[serde(default = "default_velocity_limit")]
    pub limit: i64,
}

#[derive(Debug, Deserialize)]
pub struct DeadStockQuery {
    #[serde(flatten)]
    pub range: DateRangeQuery,
    #[serde(default = "default_insights_report_basis")]
    pub basis: String,
    #[serde(default = "default_velocity_limit")]
    pub limit: i64,
    /// Variants qualify when **on-hand** and units sold in the window are at most this (default 0).
    #[serde(default)]
    pub max_units_sold: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct BestSellersResponse {
    pub reporting_basis: String,
    pub from: NaiveDate,
    /// Half-open range end (UTC): rows use `[from, to)`.
    pub to: NaiveDate,
    pub limit: i64,
    pub rows: Vec<inventory_velocity::BestSellerRow>,
}

#[derive(Debug, Serialize)]
pub struct DeadStockResponse {
    pub reporting_basis: String,
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub limit: i64,
    pub max_units_sold: i64,
    pub rows: Vec<inventory_velocity::DeadStockRow>,
}

#[derive(Debug, Deserialize)]
pub struct SalesPivotQuery {
    #[serde(default = "default_group_by")]
    pub group_by: String,
    /// `booked` / `sale` → `orders.booked_at`; `completed` / `pickup` → recognition (pickup `fulfilled_at`; ship = shipment events).
    #[serde(default = "default_basis")]
    pub basis: String,
    #[serde(flatten)]
    pub range: DateRangeQuery,
}

fn default_group_by() -> String {
    "brand".to_string()
}

fn default_basis() -> String {
    "sale".to_string()
}

const SALES_PIVOT_EXCLUDED_LINE_KINDS_SQL: &str = r#"
        AND COALESCE(oi.is_internal, false) = FALSE
        AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
        AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
"#;

#[derive(Debug, Serialize, FromRow)]
pub struct SalesPivotRow {
    pub bucket: String,
    pub gross_revenue: Decimal,
    pub tax_collected: Decimal,
    pub order_count: i64,
    pub line_units: i64,
    /// Nullable correlated subquery; `Option<SqlxJson<…>>` decodes SQL NULL (not `Option<Value>` + `#[sqlx(json)]`).
    pub weather_snapshot: Option<SqlxJson<serde_json::Value>>,
    pub closing_comments: Option<String>,
    /// Set when `group_by=customer`; `NULL` for other dimensions.
    pub customer_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct SalesPivotResponse {
    pub rows: Vec<SalesPivotRow>,
    /// `true` when results were capped at 200 rows — not all buckets are shown.
    pub truncated: bool,
}

/// Public read: revenue, tax, units, and order counts only (no cost or margin).
///
/// Used by `GET /api/insights/sales-pivot`.
pub async fn run_sales_pivot(
    pool: &PgPool,
    q: &SalesPivotQuery,
) -> Result<SalesPivotResponse, InsightsError> {
    let (start, end) = range_bounds(&q.range);
    let basis = parse_report_basis(&q.basis).map_err(InsightsError::BadRequest)?;
    let completed = basis.is_completed();

    let gb = q.group_by.to_lowercase();
    let returns_join = r#"
            LEFT JOIN (
                SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
                FROM transaction_return_lines
                GROUP BY transaction_line_id
            ) orl ON orl.transaction_line_id = oi.id
    "#;
    let effective_qty_sql = "GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)";
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
                COALESCE(SUM((oi.unit_price * {effective_qty_sql})::numeric), 0)::numeric(14, 2) AS gross_revenue,
                COALESCE(SUM(((oi.state_tax + oi.local_tax) * {effective_qty_sql})::numeric), 0)::numeric(14, 2) AS tax_collected,
                COUNT(DISTINCT o.id)::bigint AS order_count,
                COALESCE(SUM(({effective_qty_sql})::bigint), 0)::bigint AS line_units,
                NULL::jsonb AS weather_snapshot,
                NULL::text AS closing_comments,
                o.customer_id AS customer_id
            FROM transaction_lines oi
            INNER JOIN transactions o ON o.id = oi.transaction_id
            INNER JOIN products p ON p.id = oi.product_id
            LEFT JOIN customers cust ON cust.id = o.customer_id
            LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN staff st ON st.id = oi.salesperson_id
            {returns_join}
            WHERE {date_filter}
              {SALES_PIVOT_EXCLUDED_LINE_KINDS_SQL}
            GROUP BY o.customer_id
            ORDER BY gross_revenue DESC NULLS LAST
            LIMIT 201
            "#,
        );
        let mut rows = sqlx::query_as::<_, SalesPivotRow>(&sql)
            .bind(start)
            .bind(end)
            .fetch_all(pool)
            .await?;
        let truncated = rows.len() > 200;
        rows.truncate(200);
        return Ok(SalesPivotResponse { rows, truncated });
    }

    let date_filter = if completed {
        order_date_filter_sql(ReportBasis::Completed)
    } else {
        order_date_filter_sql(ReportBasis::Booked)
    };

    // Fetch 201 rows; if we get 201 results were capped — inform the client.
    let sql = if gb == "date" {
        // CTE so weather/closing subqueries correlate to `agg.sale_day` only — not ungrouped `o.booked_at`
        // (PostgreSQL rejects scalar subqueries in the SELECT list that reference outer row vars under GROUP BY).
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
                    COALESCE(SUM((oi.unit_price * {effective_qty_sql})::numeric), 0)::numeric(14, 2) AS gross_revenue,
                    COALESCE(SUM(((oi.state_tax + oi.local_tax) * {effective_qty_sql})::numeric), 0)::numeric(14, 2) AS tax_collected,
                    COUNT(DISTINCT o.id)::bigint AS order_count,
                    COALESCE(SUM(({effective_qty_sql})::bigint), 0)::bigint AS line_units,
                    {date_key} AS sale_day,
                    NULL::uuid AS customer_id
                FROM transaction_lines oi
                INNER JOIN transactions o ON o.id = oi.transaction_id
                INNER JOIN products p ON p.id = oi.product_id
                LEFT JOIN categories c ON c.id = p.category_id
                LEFT JOIN staff st ON st.id = oi.salesperson_id
                {returns_join}
                WHERE {date_filter}
                  {SALES_PIVOT_EXCLUDED_LINE_KINDS_SQL}
                GROUP BY {date_key}
            )
            SELECT
                bucket,
                gross_revenue,
                tax_collected,
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
                return Err(InsightsError::BadRequest(
                    "group_by must be 'brand', 'salesperson', 'category', 'customer', or 'date'"
                        .to_string(),
                ));
            }
        };
        format!(
            r#"
            SELECT
                {dim_sql} AS bucket,
                COALESCE(SUM((oi.unit_price * {effective_qty_sql})::numeric), 0)::numeric(14, 2) AS gross_revenue,
                COALESCE(SUM(((oi.state_tax + oi.local_tax) * {effective_qty_sql})::numeric), 0)::numeric(14, 2) AS tax_collected,
                COUNT(DISTINCT o.id)::bigint AS order_count,
                COALESCE(SUM(({effective_qty_sql})::bigint), 0)::bigint AS line_units,
                NULL::jsonb AS weather_snapshot,
                NULL::text AS closing_comments,
                NULL::uuid AS customer_id
            FROM transaction_lines oi
            INNER JOIN transactions o ON o.id = oi.transaction_id
            INNER JOIN products p ON p.id = oi.product_id
            LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN staff st ON st.id = oi.salesperson_id
            {returns_join}
            WHERE {date_filter}
              {SALES_PIVOT_EXCLUDED_LINE_KINDS_SQL}
            GROUP BY {dim_sql}
            ORDER BY gross_revenue DESC NULLS LAST
            LIMIT 201
            "#,
        )
    };

    let mut rows = sqlx::query_as::<_, SalesPivotRow>(&sql)
        .bind(start)
        .bind(end)
        .fetch_all(pool)
        .await?;

    let truncated = rows.len() > 200;
    rows.truncate(200);

    Ok(SalesPivotResponse { rows, truncated })
}

async fn sales_pivot(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<SalesPivotQuery>,
) -> Result<Json<SalesPivotResponse>, InsightsError> {
    require_staff_with_permission(&state, &headers, INSIGHTS_VIEW)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;

    let res = run_sales_pivot(&state.db, &q).await?;
    Ok(Json(res))
}

async fn margin_pivot(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<SalesPivotQuery>,
) -> Result<Json<margin_reporting::MarginPivotResponse>, InsightsError> {
    require_admin_for_margin_analytics(&state, &headers).await?;
    let (start, end) = range_bounds(&q.range);
    let basis = parse_report_basis(&q.basis).map_err(InsightsError::BadRequest)?;
    let res = margin_reporting::run_margin_pivot(&state.db, &q.group_by, basis, start, end)
        .await
        .map_err(|e| match e {
            margin_reporting::MarginPivotError::BadRequest(m) => InsightsError::BadRequest(m),
            margin_reporting::MarginPivotError::Database(d) => InsightsError::Database(d),
        })?;
    Ok(Json(res))
}

#[derive(Debug, Serialize, FromRow)]
pub struct CommissionLedgerRow {
    pub staff_id: Option<Uuid>,
    pub staff_name: String,
    /// Open lines attributed to sales booked in range (pipeline — not recognition).
    pub unpaid_commission: Decimal,
    /// Line fulfilled with **recognition** instant in range; not yet marked paid out.
    pub realized_pending_payout: Decimal,
    /// Same recognition window, already finalized paid out.
    pub paid_out_commission: Decimal,
}

async fn commission_ledger(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DateRangeQuery>,
) -> Result<Json<Vec<CommissionLedgerRow>>, InsightsError> {
    require_staff_with_permission(&state, &headers, INSIGHTS_VIEW)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;

    let (start, end) = range_bounds(&q);
    let rows = sqlx::query_as::<_, CommissionLedgerRow>(
        r#"
        WITH pipeline AS (
          SELECT
            st.id AS staff_id,
            COALESCE(st.full_name, 'Unassigned') AS staff_name,
            COALESCE(
              SUM(oi.calculated_commission) FILTER (
                WHERE NOT oi.is_fulfilled
                  AND o.booked_at >= $1
                  AND o.booked_at < $2
              ), 0
            )::numeric(14, 2) AS unpaid_commission,
            0::numeric(14, 2) AS realized_pending_payout,
            0::numeric(14, 2) AS paid_out_commission
          FROM transaction_lines oi
          INNER JOIN transactions o ON o.id = oi.transaction_id
          LEFT JOIN staff st ON st.id = oi.salesperson_id
          WHERE o.status::text NOT IN ('cancelled')
          GROUP BY st.id, COALESCE(st.full_name, 'Unassigned')
        ),
        earned AS (
          SELECT
            st.id AS staff_id,
            COALESCE(st.full_name, 'Unassigned') AS staff_name,
            0::numeric(14, 2) AS unpaid_commission,
            COALESCE(SUM(ce.total_commission_amount), 0)::numeric(14, 2) AS realized_pending_payout,
            0::numeric(14, 2) AS paid_out_commission
          FROM commission_events ce
          LEFT JOIN staff st ON st.id = ce.staff_id
          WHERE ce.event_at >= $1 AND ce.event_at < $2
          GROUP BY st.id, COALESCE(st.full_name, 'Unassigned')
        )
        SELECT
          staff_id,
          staff_name,
          SUM(unpaid_commission)::numeric(14, 2) AS unpaid_commission,
          SUM(realized_pending_payout)::numeric(14, 2) AS realized_pending_payout,
          SUM(paid_out_commission)::numeric(14, 2) AS paid_out_commission
        FROM (
          SELECT * FROM pipeline
          UNION ALL
          SELECT * FROM earned
        ) x
        GROUP BY staff_id, staff_name
        HAVING SUM(unpaid_commission) <> 0 OR SUM(realized_pending_payout) <> 0
        ORDER BY realized_pending_payout DESC, unpaid_commission DESC
        "#,
    )
    .bind(start)
    .bind(end)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

#[derive(Debug, Serialize, FromRow)]
pub struct CommissionLineRow {
    pub event_id: Option<Uuid>,
    pub event_type: String,
    pub transaction_line_id: Option<Uuid>,
    pub transaction_id: Option<Uuid>,
    pub order_short_id: String,
    pub booked_at: DateTime<Utc>,
    pub product_name: String,
    pub unit_price: Decimal,
    pub quantity: Decimal,
    pub line_gross: Decimal,
    pub calculated_commission: Decimal,
    pub is_fulfilled: bool,
    pub fulfilled_at: Option<DateTime<Utc>>,
    pub is_finalized: bool,
}

#[derive(Debug, Deserialize)]
pub struct CommissionLinesQuery {
    pub staff_id: Option<Uuid>,
    #[serde(flatten)]
    pub range: DateRangeQuery,
}

async fn commission_lines(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<CommissionLinesQuery>,
) -> Result<Json<Vec<CommissionLineRow>>, InsightsError> {
    require_staff_with_permission(&state, &headers, INSIGHTS_VIEW)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;

    let (start, end) = range_bounds(&q.range);
    let rows = sqlx::query_as::<_, CommissionLineRow>(
        r#"
        WITH event_rows AS (
          SELECT
            ce.id AS event_id,
            ce.event_type,
            ce.transaction_line_id,
            ce.transaction_id,
            COALESCE(o.short_id, 'TXN-' || left(o.id::text, 8), 'ADJ-' || left(ce.id::text, 8)) AS order_short_id,
            ce.event_at AS booked_at,
            COALESCE(p.name, ce.snapshot_json->>'product_name', 'Manual adjustment') AS product_name,
            0::numeric(14, 2) AS unit_price,
            1::numeric(14, 2) AS quantity,
            ce.commissionable_amount AS line_gross,
            ce.total_commission_amount AS calculated_commission,
            TRUE AS is_fulfilled,
            ce.event_at AS fulfilled_at,
            FALSE AS is_finalized
          FROM commission_events ce
          LEFT JOIN transaction_lines oi ON oi.id = ce.transaction_line_id
          LEFT JOIN transactions o ON o.id = ce.transaction_id
          LEFT JOIN products p ON p.id = oi.product_id
          WHERE (
              (ce.staff_id = $1)
              OR ($1 IS NULL AND ce.staff_id IS NULL)
          )
            AND ce.event_at >= $2
            AND ce.event_at < $3
        ),
        pipeline_rows AS (
          SELECT
            NULL::uuid AS event_id,
            'booked_not_fulfilled'::text AS event_type,
            oi.id AS transaction_line_id,
            o.id AS transaction_id,
            COALESCE(o.short_id, 'TXN-' || left(o.id::text, 8)) AS order_short_id,
            o.booked_at,
            p.name AS product_name,
            oi.unit_price,
            oi.quantity::numeric(14, 2) AS quantity,
            (oi.unit_price * oi.quantity)::numeric(14, 2) AS line_gross,
            oi.calculated_commission::numeric(14, 2) AS calculated_commission,
            oi.is_fulfilled,
            oi.fulfilled_at,
            oi.commission_payout_finalized_at IS NOT NULL AS is_finalized
          FROM transaction_lines oi
          INNER JOIN transactions o ON o.id = oi.transaction_id
          INNER JOIN products p ON p.id = oi.product_id
          WHERE o.status::text NOT IN ('cancelled')
            AND oi.is_fulfilled = FALSE
            AND (
            (oi.salesperson_id = $1)
            OR ($1 IS NULL AND oi.salesperson_id IS NULL)
            )
            AND o.booked_at >= $2
            AND o.booked_at < $3
        )
        SELECT * FROM event_rows
        UNION ALL
        SELECT * FROM pipeline_rows
        ORDER BY booked_at DESC
        "#,
    )
    .bind(q.staff_id)
    .bind(start)
    .bind(end)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct CommissionFinalizeRequest {
    #[serde(default)]
    pub staff_ids: Vec<Uuid>,
    #[serde(default)]
    pub include_unassigned: bool,
    #[serde(flatten)]
    pub range: DateRangeQuery,
}

#[derive(Debug, Deserialize)]
pub struct CommissionAdjustmentRequest {
    pub staff_id: Uuid,
    pub reporting_date: NaiveDate,
    pub amount: Decimal,
    pub note: String,
}

async fn commission_adjustment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CommissionAdjustmentRequest>,
) -> Result<Json<serde_json::Value>, InsightsError> {
    let admin = require_staff_with_permission(&state, &headers, STAFF_MANAGE_COMMISSION)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("staff.manage_commission permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;

    if body.amount == Decimal::ZERO {
        return Err(InsightsError::BadRequest(
            "adjustment amount must be non-zero".to_string(),
        ));
    }
    let note = body.note.trim();
    if note.len() < 3 {
        return Err(InsightsError::BadRequest(
            "adjustment note is required".to_string(),
        ));
    }

    let mut tx = state.db.begin().await?;
    let event_id = crate::logic::commission_events::insert_manual_adjustment(
        &mut tx,
        ManualCommissionAdjustment {
            staff_id: body.staff_id,
            reporting_date: body.reporting_date,
            amount: body.amount,
            note: note.to_string(),
            created_by_staff_id: admin.id,
        },
    )
    .await?;
    tx.commit().await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "commission_manual_adjustment",
        json!({
            "event_id": event_id,
            "staff_id": body.staff_id,
            "reporting_date": body.reporting_date,
            "amount": body.amount,
            "note": note,
        }),
    )
    .await;

    Ok(Json(json!({ "event_id": event_id })))
}

async fn commission_finalize(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CommissionFinalizeRequest>,
) -> Result<Json<serde_json::Value>, InsightsError> {
    let admin = require_staff_with_permission(&state, &headers, INSIGHTS_COMMISSION_FINALIZE)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden(
                    "insights.commission_finalize permission required".to_string(),
                )
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;

    if body.staff_ids.is_empty() && !body.include_unassigned {
        return Err(InsightsError::BadRequest(
            "select at least one staff member or include unassigned lines".to_string(),
        ));
    }
    let (start, end) = range_bounds(&body.range);
    let n = match finalize_realized_commissions(
        &state.db,
        start,
        end,
        &body.staff_ids,
        body.include_unassigned,
    )
    .await
    {
        Ok(n) => n,
        Err(e) => {
            let pool = state.db.clone();
            let msg = e.to_string();
            tokio::spawn(async move {
                if let Err(err) =
                    crate::logic::notifications::emit_commission_finalize_failed(&pool, &msg).await
                {
                    tracing::error!(error = %err, "emit_commission_finalize_failed");
                }
            });
            return Err(InsightsError::Database(e));
        }
    };

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "commission_finalize",
        json!({
            "lines_finalized": n,
            "period_utc": { "start": start, "end": end },
            "from": body.range.from,
            "to": body.range.to,
            "staff_ids": body.staff_ids,
            "include_unassigned": body.include_unassigned,
        }),
    )
    .await;

    Ok(Json(json!({ "lines_finalized": n })))
}

#[derive(Debug, Serialize)]
pub struct NysTaxAuditResponse {
    pub threshold_usd: String,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub total_lines: i64,
    pub clothing_footwear_lines: i64,
    /// Lines with category clothing/footwear where stored taxes imply §718-C local-only (state $0, local > 0).
    pub local_only_exempt_lines: i64,
    pub local_only_exempt_net_revenue: Decimal,
    pub local_only_exempt_state_tax: Decimal,
    pub local_only_exempt_local_tax: Decimal,
    /// Clothing/footwear at net ≥ threshold (state component expected to apply).
    pub clothing_at_or_over_threshold_lines: i64,
    pub clothing_at_or_over_threshold_net: Decimal,
    /// All other lines (non-clothing or full combined rate path in practice).
    pub standard_path_lines: i64,
    pub standard_path_net: Decimal,
    pub total_state_tax: Decimal,
    pub total_local_tax: Decimal,
}

async fn nys_tax_audit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DateRangeQuery>,
) -> Result<Json<NysTaxAuditResponse>, InsightsError> {
    require_staff_with_permission(&state, &headers, INSIGHTS_VIEW)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;

    let (start, end) = range_bounds(&q);
    let order_filter = order_recognition_tax_filter_sql();

    #[derive(FromRow)]
    struct Agg {
        total_lines: i64,
        clothing_footwear_lines: i64,
        local_only_exempt_lines: i64,
        local_only_exempt_net_revenue: Decimal,
        local_only_exempt_state_tax: Decimal,
        local_only_exempt_local_tax: Decimal,
        clothing_at_or_over_threshold_lines: i64,
        clothing_at_or_over_threshold_net: Decimal,
        standard_path_lines: i64,
        standard_path_net: Decimal,
        total_state_tax: Decimal,
        total_local_tax: Decimal,
    }

    let row = sqlx::query_as::<_, Agg>(&format!(
        r#"
        SELECT
            COUNT(*)::bigint AS total_lines,
            COUNT(*) FILTER (WHERE COALESCE(c.is_clothing_footwear, false))::bigint
                AS clothing_footwear_lines,
            COUNT(*) FILTER (
                WHERE COALESCE(c.is_clothing_footwear, false)
                  AND oi.state_tax = 0
                  AND oi.local_tax > 0
            )::bigint AS local_only_exempt_lines,
            COALESCE(
                SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric) FILTER (
                    WHERE COALESCE(c.is_clothing_footwear, false)
                      AND oi.state_tax = 0
                      AND oi.local_tax > 0
                ),
                0
            )::numeric(14, 2) AS local_only_exempt_net_revenue,
            COALESCE(
                SUM((oi.state_tax * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric) FILTER (
                    WHERE COALESCE(c.is_clothing_footwear, false)
                      AND oi.state_tax = 0
                      AND oi.local_tax > 0
                ),
                0
            )::numeric(14, 2) AS local_only_exempt_state_tax,
            COALESCE(
                SUM((oi.local_tax * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric) FILTER (
                    WHERE COALESCE(c.is_clothing_footwear, false)
                      AND oi.state_tax = 0
                      AND oi.local_tax > 0
                ),
                0
            )::numeric(14, 2) AS local_only_exempt_local_tax,
            COUNT(*) FILTER (
                WHERE COALESCE(c.is_clothing_footwear, false)
                  AND (oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric >= $3
            )::bigint AS clothing_at_or_over_threshold_lines,
            COALESCE(
                SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric) FILTER (
                    WHERE COALESCE(c.is_clothing_footwear, false)
                      AND (oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric >= $3
                ),
                0
            )::numeric(14, 2) AS clothing_at_or_over_threshold_net,
            COUNT(*) FILTER (
                WHERE NOT COALESCE(c.is_clothing_footwear, false)
                   OR (
                        COALESCE(c.is_clothing_footwear, false)
                        AND NOT (oi.state_tax = 0 AND oi.local_tax > 0)
                      )
            )::bigint AS standard_path_lines,
            COALESCE(
                SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric) FILTER (
                    WHERE NOT COALESCE(c.is_clothing_footwear, false)
                       OR (
                            COALESCE(c.is_clothing_footwear, false)
                            AND NOT (oi.state_tax = 0 AND oi.local_tax > 0)
                          )
                ),
                0
            )::numeric(14, 2) AS standard_path_net,
            COALESCE(SUM((oi.state_tax * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric), 0)::numeric(14, 2) AS total_state_tax,
            COALESCE(SUM((oi.local_tax * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric), 0)::numeric(14, 2) AS total_local_tax
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        INNER JOIN products p ON p.id = oi.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN (
            SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
            FROM transaction_return_lines
            GROUP BY transaction_line_id
        ) orl ON orl.transaction_line_id = oi.id
        WHERE {order_filter}
        "#
    ))
    .bind(start)
    .bind(end)
    .bind(CLOTHING_FOOTWEAR_EXEMPTION_THRESHOLD_USD)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(NysTaxAuditResponse {
        threshold_usd: CLOTHING_FOOTWEAR_EXEMPTION_THRESHOLD_USD.to_string(),
        from: start,
        to: end,
        total_lines: row.total_lines,
        clothing_footwear_lines: row.clothing_footwear_lines,
        local_only_exempt_lines: row.local_only_exempt_lines,
        local_only_exempt_net_revenue: row.local_only_exempt_net_revenue,
        local_only_exempt_state_tax: row.local_only_exempt_state_tax,
        local_only_exempt_local_tax: row.local_only_exempt_local_tax,
        clothing_at_or_over_threshold_lines: row.clothing_at_or_over_threshold_lines,
        clothing_at_or_over_threshold_net: row.clothing_at_or_over_threshold_net,
        standard_path_lines: row.standard_path_lines,
        standard_path_net: row.standard_path_net,
        total_state_tax: row.total_state_tax,
        total_local_tax: row.total_local_tax,
    }))
}

#[derive(Debug, Deserialize)]
pub struct StaffPerformanceQuery {
    /// `booked` vs `completed` for 7-day revenue momentum (default booked).
    #[serde(default)]
    pub basis: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StaffPerformanceRow {
    pub staff_id: Option<Uuid>,
    pub staff_name: String,
    pub high_value_line_units: i64,
    pub high_value_net_revenue: Decimal,
    /// Last 7 calendar days (UTC), gross line revenue — **booked** vs **completed (recognition)** per `basis`.
    pub revenue_momentum: Vec<Decimal>,
}

async fn staff_performance(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<StaffPerformanceQuery>,
) -> Result<Json<Vec<StaffPerformanceRow>>, InsightsError> {
    require_staff_with_permission(&state, &headers, INSIGHTS_VIEW)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;

    let basis = parse_report_basis(q.basis.as_deref().unwrap_or("booked"))
        .map_err(InsightsError::BadRequest)?;
    let completed = basis.is_completed();

    let high_value_line = Decimal::new(500, 0);

    #[derive(FromRow)]
    struct StaffAgg {
        staff_id: Option<Uuid>,
        staff_name: Option<String>,
        high_value_line_units: i64,
        high_value_net_revenue: Decimal,
    }

    let staff_rows = sqlx::query_as::<_, StaffAgg>(
        r#"
        SELECT
            st.id AS staff_id,
            st.full_name AS staff_name,
            COALESCE(
                SUM(oi.quantity::bigint) FILTER (
                    WHERE (oi.unit_price * oi.quantity)::numeric > $1
                ),
                0
            )::bigint AS high_value_line_units,
            COALESCE(
                SUM((oi.unit_price * oi.quantity)::numeric) FILTER (
                    WHERE (oi.unit_price * oi.quantity)::numeric > $1
                ),
                0
            )::numeric(14, 2) AS high_value_net_revenue
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        LEFT JOIN staff st ON st.id = oi.salesperson_id
        WHERE o.status::text NOT IN ('cancelled')
        GROUP BY st.id, st.full_name
        HAVING COALESCE(
            SUM((oi.unit_price * oi.quantity)::numeric) FILTER (
                WHERE (oi.unit_price * oi.quantity)::numeric > $1
            ),
            0
        ) > 0
        ORDER BY high_value_net_revenue DESC
        LIMIT 50
        "#,
    )
    .bind(high_value_line)
    .fetch_all(&state.db)
    .await?;

    // Single batch query for 7-day revenue momentum across ALL staff — no N+1 loop.
    let today = Utc::now().date_naive();
    let momentum_start: DateTime<Utc> = DateTime::from_naive_utc_and_offset(
        (today - chrono::Duration::days(6)).and_time(NaiveTime::MIN),
        Utc,
    );
    let momentum_end: DateTime<Utc> = DateTime::from_naive_utc_and_offset(
        today.succ_opt().unwrap_or(today).and_time(NaiveTime::MIN),
        Utc,
    );

    #[derive(FromRow)]
    struct MomentumRow {
        staff_id: Option<Uuid>,
        sale_day: NaiveDate,
        revenue: Decimal,
    }

    let date_key_sql = if completed {
        "(o.fulfilled_at AT TIME ZONE 'UTC')::date"
    } else {
        "(o.booked_at AT TIME ZONE 'UTC')::date"
    };
    let momentum_order_filter = order_date_filter_sql(basis);
    let momentum_sql = format!(
        r#"
        SELECT
            oi.salesperson_id AS staff_id,
            {date_key_sql} AS sale_day,
            COALESCE(SUM((oi.unit_price * oi.quantity)::numeric), 0)::numeric(14,2) AS revenue
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        WHERE {momentum_order_filter}
        GROUP BY oi.salesperson_id, {date_key_sql}
        "#
    );
    let momentum_rows = sqlx::query_as::<_, MomentumRow>(&momentum_sql)
        .bind(momentum_start)
        .bind(momentum_end)
        .fetch_all(&state.db)
        .await?;

    // Build O(1) lookup map keyed by (staff_id, date).
    let mut momentum_map: HashMap<(Option<Uuid>, NaiveDate), Decimal> = HashMap::new();
    for r in momentum_rows {
        momentum_map.insert((r.staff_id, r.sale_day), r.revenue);
    }

    let start_day = today - chrono::Duration::days(6);
    let out: Vec<StaffPerformanceRow> = staff_rows
        .into_iter()
        .map(|s| {
            let name = s.staff_name.unwrap_or_else(|| "Unassigned".to_string());
            let revenue_momentum: Vec<Decimal> = (0..7)
                .map(|i| {
                    let d = start_day + chrono::Duration::days(i);
                    momentum_map
                        .get(&(s.staff_id, d))
                        .copied()
                        .unwrap_or(Decimal::ZERO)
                })
                .collect();
            StaffPerformanceRow {
                staff_id: s.staff_id,
                staff_name: name,
                high_value_line_units: s.high_value_line_units,
                high_value_net_revenue: s.high_value_net_revenue,
                revenue_momentum,
            }
        })
        .collect();

    Ok(Json(out))
}

#[derive(Debug, Serialize, FromRow)]
pub struct RmsChargeReportRow {
    pub id: Uuid,
    pub record_kind: String,
    pub created_at: DateTime<Utc>,
    pub transaction_id: Uuid,
    pub register_session_id: Uuid,
    pub customer_id: Option<Uuid>,
    pub payment_method: String,
    pub amount: Decimal,
    pub operator_staff_id: Option<Uuid>,
    pub payment_transaction_id: Option<Uuid>,
    pub customer_display: Option<String>,
    pub order_short_ref: Option<String>,
    pub order_booked_at: Option<DateTime<Utc>>,
    pub order_total_price: Option<Decimal>,
    pub order_amount_paid: Option<Decimal>,
    pub customer_name_live: Option<String>,
}

async fn rms_charges_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DateRangeQuery>,
) -> Result<Json<Vec<RmsChargeReportRow>>, InsightsError> {
    require_staff_with_permission(&state, &headers, INSIGHTS_VIEW)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;

    let (start, end) = range_bounds(&q);
    let rows = sqlx::query_as::<_, RmsChargeReportRow>(
        r#"
        SELECT
            r.id,
            r.record_kind,
            r.created_at,
            r.transaction_id,
            r.register_session_id,
            r.customer_id,
            r.payment_method,
            r.amount,
            r.operator_staff_id,
            r.payment_transaction_id,
            r.customer_display,
            r.order_short_ref,
            o.booked_at AS order_booked_at,
            o.total_price AS order_total_price,
            o.amount_paid AS order_amount_paid,
            NULLIF(TRIM(BOTH FROM CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), '') AS customer_name_live
        FROM pos_rms_charge_record r
        LEFT JOIN transactions o ON o.id = r.transaction_id
        LEFT JOIN customers c ON c.id = r.customer_id
        WHERE r.created_at >= $1 AND r.created_at < $2
        ORDER BY r.created_at DESC
        LIMIT 500
        "#,
    )
    .bind(start)
    .bind(end)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

#[derive(Debug, Serialize, FromRow)]
pub struct RegisterSessionHistoryRow {
    pub id: Uuid,
    pub register_lane: i16,
    pub register_ordinal: i64,
    pub opened_at: DateTime<Utc>,
    pub closed_at: Option<DateTime<Utc>>,
    pub cashier_name: String,
    pub opening_float: Decimal,
    pub expected_cash: Option<Decimal>,
    pub actual_cash: Option<Decimal>,
    pub discrepancy: Option<Decimal>,
    pub total_sales: Decimal,
}

#[derive(Debug, Deserialize)]
pub struct RegisterDayActivityQuery {
    pub preset: Option<String>,
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    pub register_session_id: Option<Uuid>,
    /// `booked` (date of sale) or `completed` (pickup / fulfillment day). Aliases: `sale`, `pickup`.
    #[serde(default = "default_insights_report_basis")]
    pub basis: String,
}

async fn register_day_activity_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<RegisterDayActivityQuery>,
) -> Result<Json<register_day_activity::RegisterDaySummary>, InsightsError> {
    require_authenticated_staff_headers(&state, &headers)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::UNAUTHORIZED {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            } else {
                InsightsError::Forbidden("staff authentication failed".to_string())
            }
        })?;

    if let Some(sid) = q.register_session_id {
        let ok: Option<bool> = sqlx::query_scalar(
            r#"SELECT (lifecycle_status = 'open') FROM register_sessions WHERE id = $1"#,
        )
        .bind(sid)
        .fetch_optional(&state.db)
        .await?;
        if !ok.unwrap_or(false) {
            return Err(InsightsError::Forbidden(
                "register session is not open".to_string(),
            ));
        }
    } else {
        require_staff_with_permission(&state, &headers, REGISTER_REPORTS)
            .await
            .map_err(|(s, _)| {
                if s == StatusCode::FORBIDDEN {
                    InsightsError::Forbidden("register.reports permission required".to_string())
                } else {
                    InsightsError::Unauthorized(
                        "staff credentials required (x-riverside-staff-code and PIN if set)"
                            .to_string(),
                    )
                }
            })?;
    }

    let basis = parse_report_basis(&q.basis).map_err(InsightsError::BadRequest)?;

    let summary = register_day_activity::fetch_register_day_summary(
        &state.db,
        q.preset,
        q.from,
        q.to,
        q.register_session_id,
        basis,
    )
    .await
    .map_err(|e| match e {
        register_day_activity::RegisterDayActivityError::InvalidRange(m) => {
            InsightsError::BadRequest(m)
        }
        register_day_activity::RegisterDayActivityError::Serde(e) => {
            InsightsError::BadRequest(e.to_string())
        }
        register_day_activity::RegisterDayActivityError::Db(d) => InsightsError::Database(d),
    })?;

    Ok(Json(summary))
}

#[derive(Debug, Deserialize)]
pub struct RegisterSessionsQuery {
    /// Inclusive start (store-local calendar date, receipt timezone) for `closed_at`.
    pub from: Option<NaiveDate>,
    /// Inclusive end (store-local) for `closed_at`.
    pub to: Option<NaiveDate>,
    #[serde(default = "default_register_sessions_limit")]
    pub limit: i64,
}

fn default_register_sessions_limit() -> i64 {
    200
}

async fn register_session_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<RegisterSessionsQuery>,
) -> Result<Json<Vec<RegisterSessionHistoryRow>>, InsightsError> {
    require_staff_with_permission(&state, &headers, INSIGHTS_VIEW)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;

    let (start, end) =
        register_day_activity::utc_window_store_local_closed_at(&state.db, q.from, q.to)
            .await
            .map_err(|e| match e {
                register_day_activity::RegisterDayActivityError::InvalidRange(m) => {
                    InsightsError::BadRequest(m)
                }
                register_day_activity::RegisterDayActivityError::Serde(e) => {
                    InsightsError::BadRequest(e.to_string())
                }
                register_day_activity::RegisterDayActivityError::Db(d) => {
                    InsightsError::Database(d)
                }
            })?;
    let lim = q.limit.clamp(1, 500);
    let rows = sqlx::query_as::<_, RegisterSessionHistoryRow>(
        r#"
        SELECT
            rs.id,
            rs.register_lane,
            rs.session_ordinal AS register_ordinal,
            rs.opened_at,
            rs.closed_at,
            s.full_name AS cashier_name,
            rs.opening_float,
            rs.expected_cash,
            rs.actual_cash,
            rs.discrepancy,
            (
                SELECT COALESCE(SUM(o.total_price), 0)::numeric(14,2)
                FROM transactions o
                WHERE EXISTS (
                    SELECT 1
                    FROM payment_allocations pa
                    INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                    INNER JOIN register_sessions rs_group ON rs_group.id = pt.session_id
                    WHERE pa.target_transaction_id = o.id
                      AND rs_group.till_close_group_id = rs.till_close_group_id
                      AND pa.amount_allocated > 0
                )
            ) AS total_sales
        FROM register_sessions rs
        JOIN staff s ON s.id = rs.opened_by
        WHERE rs.closed_at IS NOT NULL
          AND rs.register_lane = 1
          AND rs.closed_at >= $1
          AND rs.closed_at < $2
        ORDER BY rs.closed_at DESC
        LIMIT $3
        "#,
    )
    .bind(start)
    .bind(end)
    .bind(lim)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

#[derive(Debug, Serialize, FromRow)]
pub struct RegisterOverrideMixRow {
    pub reason: String,
    pub line_count: i64,
}

async fn register_override_mix(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DateRangeWithBasisQuery>,
) -> Result<Json<Vec<RegisterOverrideMixRow>>, InsightsError> {
    require_staff_with_permission(&state, &headers, INSIGHTS_VIEW)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;

    let (start, end) = range_bounds(&q.range);
    let basis = parse_report_basis(&q.basis).map_err(InsightsError::BadRequest)?;
    let order_filter = order_date_filter_sql(basis);
    let rows = sqlx::query_as::<_, RegisterOverrideMixRow>(&format!(
        r#"
        SELECT
            COALESCE(NULLIF(TRIM(oi.size_specs->>'price_override_reason'), ''), '(unset)') AS reason,
            COUNT(*)::bigint AS line_count
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        WHERE {order_filter}
          AND oi.size_specs ? 'price_override_reason'
        GROUP BY 1
        ORDER BY line_count DESC
        LIMIT 40
        "#
    ))
    .bind(start)
    .bind(end)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

async fn insights_auth_insights_view(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), InsightsError> {
    require_staff_with_permission(state, headers, INSIGHTS_VIEW)
        .await
        .map(|_| ())
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })
}

fn parse_rosie_params<T>(spec_id: &str, params: Value) -> Result<(T, Value), InsightsError>
where
    T: for<'de> Deserialize<'de> + Serialize,
{
    let parsed: T = serde_json::from_value(params).map_err(|e| {
        InsightsError::BadRequest(format!("invalid reporting params for {spec_id}: {e}"))
    })?;
    let normalized = serde_json::to_value(&parsed).map_err(|e| {
        InsightsError::BadRequest(format!(
            "failed to normalize reporting params for {spec_id}: {e}"
        ))
    })?;
    Ok((parsed, normalized))
}

pub async fn rosie_reporting_run(
    state: &AppState,
    headers: &HeaderMap,
    request: RosieReportingRunRequest,
) -> Result<RosieReportingRunResponse, InsightsError> {
    match request.spec_id.as_str() {
        "sales_pivot" => {
            let (params, normalized) =
                parse_rosie_params::<RosieSalesPivotParams>("sales_pivot", request.params)?;
            let query = SalesPivotQuery {
                group_by: params.group_by,
                basis: params.basis,
                range: DateRangeQuery {
                    from: params.from,
                    to: params.to,
                },
            };
            let Json(data) =
                sales_pivot(State(state.clone()), headers.clone(), Query(query)).await?;
            Ok(RosieReportingRunResponse {
                spec_id: "sales_pivot".to_string(),
                route: "/api/insights/sales-pivot",
                required_permission: INSIGHTS_VIEW,
                params: normalized,
                data: serde_json::to_value(data)
                    .map_err(|e| InsightsError::BadRequest(e.to_string()))?,
            })
        }
        "best_sellers" => {
            let (params, normalized) =
                parse_rosie_params::<RosieBestSellersParams>("best_sellers", request.params)?;
            let query = BestSellersQuery {
                range: DateRangeQuery {
                    from: params.from,
                    to: params.to,
                },
                basis: params.basis,
                limit: params.limit,
            };
            let Json(data) =
                best_sellers(State(state.clone()), headers.clone(), Query(query)).await?;
            Ok(RosieReportingRunResponse {
                spec_id: "best_sellers".to_string(),
                route: "/api/insights/best-sellers",
                required_permission: INSIGHTS_VIEW,
                params: normalized,
                data: serde_json::to_value(data)
                    .map_err(|e| InsightsError::BadRequest(e.to_string()))?,
            })
        }
        "dead_stock" => {
            let (params, normalized) =
                parse_rosie_params::<RosieDeadStockParams>("dead_stock", request.params)?;
            let query = DeadStockQuery {
                range: DateRangeQuery {
                    from: params.from,
                    to: params.to,
                },
                basis: params.basis,
                limit: params.limit,
                max_units_sold: params.max_units_sold,
            };
            let Json(data) =
                dead_stock(State(state.clone()), headers.clone(), Query(query)).await?;
            Ok(RosieReportingRunResponse {
                spec_id: "dead_stock".to_string(),
                route: "/api/insights/dead-stock",
                required_permission: INSIGHTS_VIEW,
                params: normalized,
                data: serde_json::to_value(data)
                    .map_err(|e| InsightsError::BadRequest(e.to_string()))?,
            })
        }
        "wedding_health" => {
            let (_params, normalized) = parse_rosie_params::<serde_json::Map<String, Value>>(
                "wedding_health",
                request.params,
            )?;
            let Json(data) = wedding_health_summary(State(state.clone()), headers.clone()).await?;
            Ok(RosieReportingRunResponse {
                spec_id: "wedding_health".to_string(),
                route: "/api/insights/wedding-health",
                required_permission: INSIGHTS_VIEW,
                params: normalized,
                data: serde_json::to_value(data)
                    .map_err(|e| InsightsError::BadRequest(e.to_string()))?,
            })
        }
        "commission_ledger" => {
            let (params, normalized) =
                parse_rosie_params::<RosieDateRangeParams>("commission_ledger", request.params)?;
            let query = DateRangeQuery {
                from: params.from,
                to: params.to,
            };
            let Json(data) =
                commission_ledger(State(state.clone()), headers.clone(), Query(query)).await?;
            Ok(RosieReportingRunResponse {
                spec_id: "commission_ledger".to_string(),
                route: "/api/insights/commission-ledger",
                required_permission: INSIGHTS_VIEW,
                params: normalized,
                data: serde_json::to_value(data)
                    .map_err(|e| InsightsError::BadRequest(e.to_string()))?,
            })
        }
        "staff_performance" => {
            let (params, normalized) = parse_rosie_params::<RosieStaffPerformanceParams>(
                "staff_performance",
                request.params,
            )?;
            let query = StaffPerformanceQuery {
                basis: params.basis,
            };
            let Json(data) =
                staff_performance(State(state.clone()), headers.clone(), Query(query)).await?;
            Ok(RosieReportingRunResponse {
                spec_id: "staff_performance".to_string(),
                route: "/api/insights/staff-performance",
                required_permission: INSIGHTS_VIEW,
                params: normalized,
                data: serde_json::to_value(data)
                    .map_err(|e| InsightsError::BadRequest(e.to_string()))?,
            })
        }
        "register_sessions" => {
            let (params, normalized) = parse_rosie_params::<RosieRegisterSessionsParams>(
                "register_sessions",
                request.params,
            )?;
            let query = RegisterSessionsQuery {
                from: params.from,
                to: params.to,
                limit: params.limit,
            };
            let Json(data) =
                register_session_history(State(state.clone()), headers.clone(), Query(query))
                    .await?;
            Ok(RosieReportingRunResponse {
                spec_id: "register_sessions".to_string(),
                route: "/api/insights/register-sessions",
                required_permission: INSIGHTS_VIEW,
                params: normalized,
                data: serde_json::to_value(data)
                    .map_err(|e| InsightsError::BadRequest(e.to_string()))?,
            })
        }
        "register_override_mix" => {
            let (params, normalized) = parse_rosie_params::<RosieRegisterOverrideMixParams>(
                "register_override_mix",
                request.params,
            )?;
            let query = DateRangeWithBasisQuery {
                range: DateRangeQuery {
                    from: params.from,
                    to: params.to,
                },
                basis: params.basis,
            };
            let Json(data) =
                register_override_mix(State(state.clone()), headers.clone(), Query(query)).await?;
            Ok(RosieReportingRunResponse {
                spec_id: "register_override_mix".to_string(),
                route: "/api/insights/register-override-mix",
                required_permission: INSIGHTS_VIEW,
                params: normalized,
                data: serde_json::to_value(data)
                    .map_err(|e| InsightsError::BadRequest(e.to_string()))?,
            })
        }
        "register_day_activity" => {
            let (params, normalized) = parse_rosie_params::<RosieRegisterDayActivityParams>(
                "register_day_activity",
                request.params,
            )?;
            let query = RegisterDayActivityQuery {
                preset: params.preset,
                from: params.from,
                to: params.to,
                register_session_id: params.register_session_id,
                basis: params.basis,
            };
            let Json(data) =
                register_day_activity_summary(State(state.clone()), headers.clone(), Query(query))
                    .await?;
            Ok(RosieReportingRunResponse {
                spec_id: "register_day_activity".to_string(),
                route: "/api/insights/register-day-activity",
                required_permission: REGISTER_REPORTS,
                params: normalized,
                data: serde_json::to_value(data)
                    .map_err(|e| InsightsError::BadRequest(e.to_string()))?,
            })
        }
        other => Err(InsightsError::BadRequest(format!(
            "unsupported reporting spec_id: {other}"
        ))),
    }
}

async fn best_sellers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<BestSellersQuery>,
) -> Result<Json<BestSellersResponse>, InsightsError> {
    insights_auth_insights_view(&state, &headers).await?;
    let (start, end) = range_bounds(&q.range);
    let basis = parse_report_basis(&q.basis).map_err(InsightsError::BadRequest)?;
    let lim = q.limit.clamp(1, 500);
    let rows = inventory_velocity::fetch_best_sellers(&state.db, start, end, basis, lim).await?;

    Ok(Json(BestSellersResponse {
        reporting_basis: basis.as_str().to_string(),
        from: start.date_naive(),
        to: end.date_naive(),
        limit: lim,
        rows,
    }))
}

async fn dead_stock(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DeadStockQuery>,
) -> Result<Json<DeadStockResponse>, InsightsError> {
    insights_auth_insights_view(&state, &headers).await?;
    let (start, end) = range_bounds(&q.range);
    let basis = parse_report_basis(&q.basis).map_err(InsightsError::BadRequest)?;
    let lim = q.limit.clamp(1, 500);
    let max_u = q.max_units_sold.unwrap_or(0).clamp(0, 1_000_000);
    let rows =
        inventory_velocity::fetch_dead_stock(&state.db, start, end, basis, max_u, lim).await?;

    Ok(Json(DeadStockResponse {
        reporting_basis: basis.as_str().to_string(),
        from: start.date_naive(),
        to: end.date_naive(),
        limit: lim,
        max_units_sold: max_u,
        rows,
    }))
}

#[derive(Debug, Serialize)]
pub struct WeddingHealthSummary {
    pub parties_event_next_30_days: i64,
    pub wedding_members_without_order: i64,
    /// Wedding members linked to a non-cancelled order with balance due (collections risk).
    pub wedding_members_with_open_balance: i64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct AppointmentNoShowReportRow {
    pub appointment_date: NaiveDate,
    pub appointment_type: String,
    pub salesperson: String,
    pub appointment_count: i64,
    pub completed_count: i64,
    pub cancellation_count: i64,
    pub no_show_count: i64,
    pub wedding_linked_count: i64,
    pub walk_in_count: i64,
}

async fn appointments_no_show_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DateRangeQuery>,
) -> Result<Json<Vec<AppointmentNoShowReportRow>>, InsightsError> {
    insights_auth_insights_view(&state, &headers).await?;
    let (start, end) = range_bounds(&q);
    let rows = sqlx::query_as::<_, AppointmentNoShowReportRow>(
        r#"
        SELECT
            starts_at::date AS appointment_date,
            COALESCE(NULLIF(TRIM(appointment_type), ''), 'Unspecified') AS appointment_type,
            COALESCE(NULLIF(TRIM(salesperson), ''), 'Unassigned') AS salesperson,
            COUNT(*)::bigint AS appointment_count,
            COUNT(*) FILTER (
                WHERE lower(replace(replace(COALESCE(status, ''), ' ', '_'), '-', '_')) IN ('complete', 'completed', 'checked_in', 'showed', 'done')
            )::bigint AS completed_count,
            COUNT(*) FILTER (
                WHERE lower(replace(replace(COALESCE(status, ''), ' ', '_'), '-', '_')) IN ('cancelled', 'canceled')
            )::bigint AS cancellation_count,
            COUNT(*) FILTER (
                WHERE lower(replace(replace(COALESCE(status, ''), ' ', '_'), '-', '_')) IN ('no_show', 'noshow')
            )::bigint AS no_show_count,
            COUNT(*) FILTER (
                WHERE wedding_party_id IS NOT NULL OR wedding_member_id IS NOT NULL
            )::bigint AS wedding_linked_count,
            COUNT(*) FILTER (
                WHERE wedding_party_id IS NULL AND wedding_member_id IS NULL
            )::bigint AS walk_in_count
        FROM wedding_appointments
        WHERE starts_at >= $1 AND starts_at < $2
        GROUP BY appointment_date, appointment_type, salesperson
        ORDER BY appointment_date DESC, appointment_type ASC, salesperson ASC
        LIMIT 500
        "#,
    )
    .bind(start)
    .bind(end)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Serialize, FromRow)]
pub struct WeddingEventReadinessReportRow {
    pub event_date: NaiveDate,
    pub wedding_party_id: Uuid,
    pub wedding_party_name: String,
    pub salesperson: String,
    pub member_count: i64,
    pub missing_measurements_count: i64,
    pub unpaid_balance_count: i64,
    pub unpaid_balance_total: Decimal,
    pub unfulfilled_item_count: i64,
    pub pending_alteration_count: i64,
    pub shipment_or_pickup_risk_count: i64,
}

async fn wedding_event_readiness_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DateRangeQuery>,
) -> Result<Json<Vec<WeddingEventReadinessReportRow>>, InsightsError> {
    insights_auth_insights_view(&state, &headers).await?;
    let (start, end) = range_bounds(&q);
    let rows = sqlx::query_as::<_, WeddingEventReadinessReportRow>(
        r#"
        WITH member_rollup AS (
            SELECT
                wm.wedding_party_id,
                COUNT(*)::bigint AS member_count,
                COUNT(*) FILTER (WHERE COALESCE(wm.measured, false) = false)::bigint AS missing_measurements_count
            FROM wedding_members wm
            GROUP BY wm.wedding_party_id
        ),
        transaction_rollup AS (
            SELECT
                wm.wedding_party_id,
                COUNT(DISTINCT wm.id) FILTER (WHERE COALESCE(t.balance_due, 0) > 0)::bigint AS unpaid_balance_count,
                COALESCE(SUM(CASE WHEN COALESCE(t.balance_due, 0) > 0 THEN t.balance_due ELSE 0 END), 0)::numeric(14,2) AS unpaid_balance_total
            FROM wedding_members wm
            LEFT JOIN transactions t ON t.wedding_member_id = wm.id AND t.status::text <> 'cancelled'
            GROUP BY wm.wedding_party_id
        ),
        line_rollup AS (
            SELECT
                wm.wedding_party_id,
                COUNT(DISTINCT tl.id) FILTER (WHERE tl.fulfilled_at IS NULL)::bigint AS unfulfilled_item_count
            FROM wedding_members wm
            JOIN transactions t ON t.wedding_member_id = wm.id AND t.status::text <> 'cancelled'
            JOIN transaction_lines tl ON tl.transaction_id = t.id
            GROUP BY wm.wedding_party_id
        ),
        alteration_rollup AS (
            SELECT
                wm.wedding_party_id,
                COUNT(DISTINCT ao.id) FILTER (WHERE ao.status::text <> 'picked_up')::bigint AS pending_alteration_count
            FROM wedding_members wm
            LEFT JOIN transactions t ON t.wedding_member_id = wm.id AND t.status::text <> 'cancelled'
            LEFT JOIN alteration_orders ao ON ao.wedding_member_id = wm.id OR ao.transaction_id = t.id
            GROUP BY wm.wedding_party_id
        ),
        shipment_rollup AS (
            SELECT
                wm.wedding_party_id,
                COUNT(DISTINCT s.id) FILTER (WHERE s.status::text NOT IN ('delivered', 'cancelled'))::bigint AS open_shipment_count
            FROM wedding_members wm
            JOIN transactions t ON t.wedding_member_id = wm.id AND t.status::text <> 'cancelled'
            LEFT JOIN transaction_lines tl ON tl.transaction_id = t.id
            JOIN shipment s ON s.transaction_id = t.id OR s.fulfillment_order_id = tl.fulfillment_order_id
            GROUP BY wm.wedding_party_id
        )
        SELECT
            wp.event_date,
            wp.id AS wedding_party_id,
            COALESCE(NULLIF(TRIM(wp.party_name), ''), NULLIF(TRIM(wp.groom_name), ''), 'Unnamed wedding') AS wedding_party_name,
            COALESCE(NULLIF(TRIM(wp.salesperson), ''), 'Unassigned') AS salesperson,
            COALESCE(mr.member_count, 0)::bigint AS member_count,
            COALESCE(mr.missing_measurements_count, 0)::bigint AS missing_measurements_count,
            COALESCE(tr.unpaid_balance_count, 0)::bigint AS unpaid_balance_count,
            COALESCE(tr.unpaid_balance_total, 0)::numeric(14,2) AS unpaid_balance_total,
            COALESCE(lr.unfulfilled_item_count, 0)::bigint AS unfulfilled_item_count,
            COALESCE(ar.pending_alteration_count, 0)::bigint AS pending_alteration_count,
            (
                COALESCE(lr.unfulfilled_item_count, 0)
                + COALESCE(sr.open_shipment_count, 0)
            )::bigint AS shipment_or_pickup_risk_count
        FROM wedding_parties wp
        LEFT JOIN member_rollup mr ON mr.wedding_party_id = wp.id
        LEFT JOIN transaction_rollup tr ON tr.wedding_party_id = wp.id
        LEFT JOIN line_rollup lr ON lr.wedding_party_id = wp.id
        LEFT JOIN alteration_rollup ar ON ar.wedding_party_id = wp.id
        LEFT JOIN shipment_rollup sr ON sr.wedding_party_id = wp.id
        WHERE wp.event_date >= $1::date
          AND wp.event_date < $2::date
          AND COALESCE(wp.is_deleted, false) = false
        ORDER BY wp.event_date ASC, wedding_party_name ASC
        LIMIT 500
        "#,
    )
    .bind(start.date_naive())
    .bind(end.date_naive())
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Serialize, FromRow)]
pub struct StaffScheduleCoverageSalesReportRow {
    pub report_date: NaiveDate,
    pub scheduled_staff_count: i64,
    pub sales_volume: Decimal,
    pub transaction_count: i64,
    pub appointment_count: i64,
    pub pickup_count: i64,
    pub register_payment_count: i64,
}

async fn staff_schedule_coverage_sales_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DateRangeQuery>,
) -> Result<Json<Vec<StaffScheduleCoverageSalesReportRow>>, InsightsError> {
    insights_auth_insights_view(&state, &headers).await?;
    let (start, end) = range_bounds(&q);
    let rows = sqlx::query_as::<_, StaffScheduleCoverageSalesReportRow>(
        r#"
        WITH days AS (
            SELECT generate_series($1::date, ($2::date - INTERVAL '1 day')::date, INTERVAL '1 day')::date AS report_date
        ),
        published_schedule AS (
            SELECT
                (sws.week_start + (swd.weekday::int * INTERVAL '1 day'))::date AS report_date,
                COUNT(DISTINCT sws.staff_id)::bigint AS scheduled_staff_count
            FROM staff_weekly_schedule sws
            JOIN staff_weekly_schedule_day swd
              ON swd.staff_id = sws.staff_id
             AND swd.week_start = sws.week_start
            JOIN staff st ON st.id = sws.staff_id
            WHERE sws.status = 'published'
              AND swd.works = true
              AND st.is_active = true
              AND (sws.week_start + (swd.weekday::int * INTERVAL '1 day'))::date >= $1::date
              AND (sws.week_start + (swd.weekday::int * INTERVAL '1 day'))::date < $2::date
            GROUP BY 1
        ),
        sales AS (
            SELECT
                booked_at::date AS report_date,
                COUNT(*)::bigint AS transaction_count,
                COALESCE(SUM(total_price), 0)::numeric(14,2) AS sales_volume
            FROM transactions
            WHERE booked_at >= $3 AND booked_at < $4
              AND status::text <> 'cancelled'
            GROUP BY 1
        ),
        appointments AS (
            SELECT starts_at::date AS report_date, COUNT(*)::bigint AS appointment_count
            FROM wedding_appointments
            WHERE starts_at >= $3 AND starts_at < $4
            GROUP BY 1
        ),
        pickups AS (
            SELECT fulfilled_at::date AS report_date, COUNT(*)::bigint AS pickup_count
            FROM transaction_lines
            WHERE fulfilled_at >= $3 AND fulfilled_at < $4
            GROUP BY 1
        ),
        register_activity AS (
            SELECT created_at::date AS report_date, COUNT(*)::bigint AS register_payment_count
            FROM payment_transactions
            WHERE created_at >= $3 AND created_at < $4
              AND status = 'success'
            GROUP BY 1
        )
        SELECT
            d.report_date,
            COALESCE(ps.scheduled_staff_count, 0)::bigint AS scheduled_staff_count,
            COALESCE(s.sales_volume, 0)::numeric(14,2) AS sales_volume,
            COALESCE(s.transaction_count, 0)::bigint AS transaction_count,
            COALESCE(a.appointment_count, 0)::bigint AS appointment_count,
            COALESCE(p.pickup_count, 0)::bigint AS pickup_count,
            COALESCE(ra.register_payment_count, 0)::bigint AS register_payment_count
        FROM days d
        LEFT JOIN published_schedule ps ON ps.report_date = d.report_date
        LEFT JOIN sales s ON s.report_date = d.report_date
        LEFT JOIN appointments a ON a.report_date = d.report_date
        LEFT JOIN pickups p ON p.report_date = d.report_date
        LEFT JOIN register_activity ra ON ra.report_date = d.report_date
        ORDER BY d.report_date DESC
        LIMIT 500
        "#,
    )
    .bind(start.date_naive())
    .bind(end.date_naive())
    .bind(start)
    .bind(end)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Serialize, FromRow)]
pub struct CustomerFollowUpReportRow {
    pub customer_id: Uuid,
    pub customer_name: String,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub open_balance_total: Decimal,
    pub pending_pickup_count: i64,
    pub recent_transaction_count: i64,
    pub upcoming_wedding_date: Option<NaiveDate>,
    pub stale_rms_charge_count: i64,
    pub last_transaction_at: Option<DateTime<Utc>>,
    pub follow_up_reason: String,
}

async fn customer_follow_up_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DateRangeQuery>,
) -> Result<Json<Vec<CustomerFollowUpReportRow>>, InsightsError> {
    insights_auth_insights_view(&state, &headers).await?;
    let (start, end) = range_bounds(&q);
    let rows = sqlx::query_as::<_, CustomerFollowUpReportRow>(
        r#"
        WITH tx AS (
            SELECT
                customer_id,
                COALESCE(SUM(balance_due) FILTER (WHERE balance_due > 0), 0)::numeric(14,2) AS open_balance_total,
                COUNT(*) FILTER (WHERE booked_at >= $1 AND booked_at < $2)::bigint AS recent_transaction_count,
                MAX(booked_at) AS last_transaction_at
            FROM transactions
            WHERE customer_id IS NOT NULL
              AND status::text <> 'cancelled'
            GROUP BY customer_id
        ),
        pending_pickups AS (
            SELECT t.customer_id, COUNT(DISTINCT tl.id)::bigint AS pending_pickup_count
            FROM transactions t
            JOIN transaction_lines tl ON tl.transaction_id = t.id
            WHERE t.customer_id IS NOT NULL
              AND t.status::text <> 'cancelled'
              AND tl.fulfilled_at IS NULL
            GROUP BY t.customer_id
        ),
        upcoming_weddings AS (
            SELECT wm.customer_id, MIN(wp.event_date) AS upcoming_wedding_date
            FROM wedding_members wm
            JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
            WHERE wp.event_date >= CURRENT_DATE
              AND COALESCE(wp.is_deleted, false) = false
            GROUP BY wm.customer_id
        ),
        stale_rms AS (
            SELECT customer_id, COUNT(*)::bigint AS stale_rms_charge_count
            FROM pos_rms_charge_record
            WHERE customer_id IS NOT NULL
              AND record_kind = 'charge'
              AND created_at < now() - INTERVAL '14 days'
            GROUP BY customer_id
        )
        SELECT
            c.id AS customer_id,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), c.company_name, c.customer_code, 'Unnamed customer') AS customer_name,
            c.phone,
            c.email,
            COALESCE(tx.open_balance_total, 0)::numeric(14,2) AS open_balance_total,
            COALESCE(pp.pending_pickup_count, 0)::bigint AS pending_pickup_count,
            COALESCE(tx.recent_transaction_count, 0)::bigint AS recent_transaction_count,
            uw.upcoming_wedding_date,
            COALESCE(sr.stale_rms_charge_count, 0)::bigint AS stale_rms_charge_count,
            tx.last_transaction_at,
            CONCAT_WS(
                ', ',
                CASE WHEN COALESCE(tx.open_balance_total, 0) > 0 THEN 'Open balance' END,
                CASE WHEN COALESCE(pp.pending_pickup_count, 0) > 0 THEN 'Pending pickup' END,
                CASE WHEN uw.upcoming_wedding_date IS NOT NULL THEN 'Upcoming wedding' END,
                CASE WHEN COALESCE(sr.stale_rms_charge_count, 0) > 0 THEN 'Stale RMS charge' END,
                CASE WHEN tx.last_transaction_at IS NULL OR tx.last_transaction_at < now() - INTERVAL '90 days' THEN 'No recent transaction' END
            ) AS follow_up_reason
        FROM customers c
        LEFT JOIN tx ON tx.customer_id = c.id
        LEFT JOIN pending_pickups pp ON pp.customer_id = c.id
        LEFT JOIN upcoming_weddings uw ON uw.customer_id = c.id
        LEFT JOIN stale_rms sr ON sr.customer_id = c.id
        WHERE COALESCE(c.is_active, true) = true
          AND (
            COALESCE(tx.open_balance_total, 0) > 0
            OR COALESCE(pp.pending_pickup_count, 0) > 0
            OR uw.upcoming_wedding_date IS NOT NULL
            OR COALESCE(sr.stale_rms_charge_count, 0) > 0
            OR tx.last_transaction_at < now() - INTERVAL '90 days'
          )
        ORDER BY
            COALESCE(tx.open_balance_total, 0) DESC,
            uw.upcoming_wedding_date ASC NULLS LAST,
            tx.last_transaction_at ASC NULLS LAST
        LIMIT 500
        "#,
    )
    .bind(start)
    .bind(end)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Serialize, FromRow)]
pub struct ExceptionRiskReportRow {
    pub risk_type: String,
    pub risk_count: i64,
    pub oldest_at: Option<DateTime<Utc>>,
    pub total_amount: Option<Decimal>,
    pub owner_area: String,
    pub recommended_action: String,
}

async fn exception_risk_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DateRangeQuery>,
) -> Result<Json<Vec<ExceptionRiskReportRow>>, InsightsError> {
    insights_auth_insights_view(&state, &headers).await?;
    let (start, end) = range_bounds(&q);
    let rows = sqlx::query_as::<_, ExceptionRiskReportRow>(
        r#"
        SELECT
            risk_type,
            risk_count,
            oldest_at,
            total_amount,
            owner_area,
            recommended_action
        FROM (
            SELECT
                'Negative stock'::text AS risk_type,
                COUNT(*)::bigint AS risk_count,
                NULL::timestamptz AS oldest_at,
                NULL::numeric(14,2) AS total_amount,
                'Inventory'::text AS owner_area,
                'Review inventory counts and recent receiving or adjustment history.'::text AS recommended_action
            FROM product_variants
            WHERE stock_on_hand < 0

            UNION ALL

            SELECT
                'Stale fulfillment orders'::text,
                COUNT(*)::bigint,
                MIN(created_at),
                NULL::numeric(14,2),
                'Fulfillment',
                'Review open fulfillment orders older than 14 days.'
            FROM fulfillment_orders
            WHERE status::text NOT IN ('picked_up', 'shipped', 'cancelled')
              AND created_at < now() - INTERVAL '14 days'

            UNION ALL

            SELECT
                'Overdue alterations'::text,
                COUNT(*)::bigint,
                MIN(due_at),
                NULL::numeric(14,2),
                'Alterations',
                'Review alteration orders past due and not picked up.'
            FROM alteration_orders
            WHERE status::text <> 'picked_up'
              AND due_at IS NOT NULL
              AND due_at < now()

            UNION ALL

            SELECT
                'High discounts'::text,
                COUNT(*)::bigint,
                MIN(created_at),
                NULL::numeric(14,2),
                'Register',
                'Review discount events over 40 percent in the selected range.'
            FROM discount_event_usage
            WHERE created_at >= $1 AND created_at < $2
              AND discount_percent >= 40

            UNION ALL

            SELECT
                'Failed payments'::text,
                COUNT(*)::bigint,
                MIN(created_at),
                COALESCE(SUM(amount), 0)::numeric(14,2),
                'Payments',
                'Review failed payment attempts and customer follow-up.'
            FROM payment_transactions
            WHERE created_at >= $1 AND created_at < $2
              AND status <> 'success'

            UNION ALL

            SELECT
                'Open register sessions'::text,
                COUNT(*)::bigint,
                MIN(opened_at),
                COALESCE(SUM(expected_cash), 0)::numeric(14,2),
                'Register',
                'Close or reconcile open register sessions.'
            FROM register_sessions
            WHERE COALESCE(lifecycle_status, CASE WHEN is_open THEN 'open' ELSE 'closed' END) = 'open'

            UNION ALL

            SELECT
                'Unclosed tasks'::text,
                COUNT(*)::bigint,
                MIN(materialized_at),
                NULL::numeric(14,2),
                'Operations',
                'Review open tasks with due dates before today.'
            FROM task_instance
            WHERE status = 'open'
              AND due_date IS NOT NULL
              AND due_date < CURRENT_DATE
        ) risks
        WHERE risk_count > 0
        ORDER BY risk_count DESC, risk_type ASC
        "#,
    )
    .bind(start)
    .bind(end)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct WeddingSavedViewCreateBody {
    pub name: String,
    #[serde(default)]
    pub filters: serde_json::Value,
}

#[derive(Debug, Serialize, FromRow)]
pub struct WeddingSavedViewRow {
    pub id: Uuid,
    pub name: String,
    #[sqlx(json)]
    pub filters: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

async fn list_wedding_saved_views(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<WeddingSavedViewRow>>, InsightsError> {
    let staff = require_staff_with_permission(&state, &headers, INSIGHTS_VIEW)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;
    let rows = sqlx::query_as::<_, WeddingSavedViewRow>(
        r#"
        SELECT id, name, filters, created_at, updated_at
        FROM wedding_insight_saved_views
        WHERE staff_id = $1
        ORDER BY name ASC
        LIMIT 100
        "#,
    )
    .bind(staff.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn create_wedding_saved_view(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<WeddingSavedViewCreateBody>,
) -> Result<Json<WeddingSavedViewRow>, InsightsError> {
    let staff = require_staff_with_permission(&state, &headers, INSIGHTS_VIEW)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(InsightsError::BadRequest("name is required".to_string()));
    }
    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO wedding_insight_saved_views (staff_id, name, filters)
        VALUES ($1, $2, $3)
        RETURNING id
        "#,
    )
    .bind(staff.id)
    .bind(name)
    .bind(SqlxJson(body.filters))
    .fetch_one(&state.db)
    .await?;

    let row = sqlx::query_as::<_, WeddingSavedViewRow>(
        r#"
        SELECT id, name, filters, created_at, updated_at
        FROM wedding_insight_saved_views
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(row))
}

async fn delete_wedding_saved_view(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, InsightsError> {
    let staff = require_staff_with_permission(&state, &headers, INSIGHTS_VIEW)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;
    let r = sqlx::query("DELETE FROM wedding_insight_saved_views WHERE id = $1 AND staff_id = $2")
        .bind(id)
        .bind(staff.id)
        .execute(&state.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(InsightsError::BadRequest(
            "saved view not found or not owned by this staff member".to_string(),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn wedding_health_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<WeddingHealthSummary>, InsightsError> {
    insights_auth_insights_view(&state, &headers).await?;
    let parties_event_next_30_days: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM wedding_parties
        WHERE event_date >= CURRENT_DATE
          AND event_date <= CURRENT_DATE + INTERVAL '30 days'
        "#,
    )
    .fetch_one(&state.db)
    .await?;

    let wedding_members_without_order: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM wedding_members
        WHERE transaction_id IS NULL
        "#,
    )
    .fetch_one(&state.db)
    .await?;

    let wedding_members_with_open_balance: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM wedding_members wm
        INNER JOIN transactions o ON o.id = wm.transaction_id
        WHERE o.status <> 'cancelled'::order_status
          AND o.balance_due > 0
        "#,
    )
    .fetch_one(&state.db)
    .await?;

    Ok(Json(WeddingHealthSummary {
        parties_event_next_30_days,
        wedding_members_without_order,
        wedding_members_with_open_balance,
    }))
}

#[derive(FromRow)]
struct StaffMetabaseCreds {
    email: Option<String>,
    cashier_code: String,
}

#[derive(Debug, Deserialize)]
pub struct MetabaseLaunchBody {
    #[serde(default = "default_metabase_return_to")]
    pub return_to: String,
}

#[derive(Debug, Deserialize)]
pub struct MetabaseLaunchQuery {
    #[serde(default = "default_metabase_return_to")]
    pub return_to: String,
}

/// After JWT SSO, Metabase redirects here. Must not be `"/"` when ROS serves Metabase under
/// `/metabase/*`: a path-only `"/"` resolves to the site origin root and loads the whole SPA inside
/// the Insights iframe (CSP / framing errors).
fn default_metabase_return_to() -> String {
    "/metabase/".to_string()
}

async fn metabase_launch_resolve(
    state: &AppState,
    headers: &HeaderMap,
    return_to: &str,
) -> Result<Json<serde_json::Value>, InsightsError> {
    let staff = require_staff_with_permission(state, headers, INSIGHTS_VIEW)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;

    let cfg_raw: serde_json::Value =
        sqlx::query_scalar("SELECT insights_config FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;
    let cfg = StoreInsightsConfig::from_json_value(cfg_raw);

    // --- SHARED AUTH LOGIC (Metabase OSS Workaround) ---
    // If JWT is not enabled or available, we try the "Silent Shared Auth" via background login.
    let admin_email = std::env::var("RIVERSIDE_METABASE_ADMIN_EMAIL").unwrap_or_default();
    let staff_email = std::env::var("RIVERSIDE_METABASE_STAFF_EMAIL").unwrap_or_default();

    if !cfg.metabase_jwt_sso_enabled && !admin_email.is_empty() && !staff_email.is_empty() {
        let (email, pass) = if staff.role == DbStaffRole::Admin {
            (
                admin_email,
                std::env::var("RIVERSIDE_METABASE_ADMIN_PASSWORD").unwrap_or_default(),
            )
        } else {
            (
                staff_email,
                std::env::var("RIVERSIDE_METABASE_STAFF_PASSWORD").unwrap_or_default(),
            )
        };

        if !pass.is_empty() {
            let upstream = std::env::var("RIVERSIDE_METABASE_UPSTREAM")
                .unwrap_or_else(|_| "http://127.0.0.1:3001".to_string());
            let login_url = format!("{}/api/session", upstream.trim_end_matches('/'));

            let login_res = state
                .http_client
                .post(&login_url)
                .json(&serde_json::json!({ "username": email, "password": pass }))
                .send()
                .await;

            if let Ok(res) = login_res {
                if res.status().is_success() {
                    if let Ok(data) = res.json::<serde_json::Value>().await {
                        if let Some(session_id) = data.get("id").and_then(|id| id.as_str()) {
                            // We return the session ID. The frontend shell or proxy will ensure it's used.
                            // To make it seamless, we return a special launch source that the proxy recognizes.
                            let rt = urlencoding::encode(return_to);
                            let iframe_src = format!(
                                "/metabase/?metabase_session_id={session_id}&return_to={rt}"
                            );
                            return Ok(Json(json!({
                                "iframe_src": iframe_src,
                                "session_id": session_id,
                                "launch_mode": "shared-auth"
                            })));
                        }
                    }
                }
            }
        }
    }

    let secret = std::env::var("RIVERSIDE_METABASE_JWT_SECRET").unwrap_or_default();
    let secret_trim = secret.trim();
    let secret_ok = !secret_trim.is_empty() && secret_trim.len() >= 16;

    let fallback = json!({
        "iframe_src": "/metabase/",
        "launch_mode": "metabase-login"
    });

    if !cfg.metabase_jwt_sso_enabled || !secret_ok {
        return Ok(Json(fallback));
    }

    let creds: StaffMetabaseCreds =
        sqlx::query_as("SELECT email, cashier_code FROM staff WHERE id = $1")
            .bind(staff.id)
            .fetch_one(&state.db)
            .await?;

    let token = mint_metabase_staff_jwt(
        secret_trim,
        staff.id,
        &staff.full_name,
        staff.role,
        creds.email.as_deref(),
        &creds.cashier_code,
        &cfg.jwt_email_domain,
    )
    .map_err(InsightsError::BadRequest)?;

    let enc = urlencoding::encode(&token);
    let rt = urlencoding::encode(return_to);
    let iframe_src = format!("/metabase/auth/sso?jwt={enc}&return_to={rt}");
    Ok(Json(json!({
        "iframe_src": iframe_src,
        "launch_mode": "jwt-sso"
    })))
}

async fn get_metabase_launch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<MetabaseLaunchQuery>,
) -> Result<Json<serde_json::Value>, InsightsError> {
    metabase_launch_resolve(&state, &headers, &q.return_to).await
}

async fn post_metabase_launch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<MetabaseLaunchBody>,
) -> Result<Json<serde_json::Value>, InsightsError> {
    metabase_launch_resolve(&state, &headers, &body.return_to).await
}

#[derive(Debug, Serialize, FromRow)]
pub struct LoyaltyVelocityRow {
    pub event_date: NaiveDate,
    pub points_earned: i64,
    pub points_burned: i64,
    pub net_velocity: i64,
}

async fn loyalty_velocity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DateRangeQuery>,
) -> Result<Json<Vec<LoyaltyVelocityRow>>, InsightsError> {
    require_staff_with_permission(&state, &headers, INSIGHTS_VIEW)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;

    let (start, end) = range_bounds(&q);

    let rows = sqlx::query_as::<_, LoyaltyVelocityRow>(
        r#"
        SELECT event_date, points_earned, points_burned, net_velocity
        FROM view_loyalty_daily_velocity
        WHERE event_date >= $1::date AND event_date < $2::date
        ORDER BY event_date ASC
        "#,
    )
    .bind(start.date_naive())
    .bind(end.date_naive())
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

#[derive(Debug, Serialize)]
pub struct MerchantActivityResponse {
    pub total_processed: Decimal,
    pub total_fees: Decimal,
    pub net_amount: Decimal,
    pub transactions: Vec<MerchantTransaction>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct MerchantTransaction {
    pub id: Uuid,
    pub occurred_at: DateTime<Utc>,
    pub amount: Decimal,
    pub merchant_fee: Decimal,
    pub net_amount: Decimal,
    pub payment_method: String,
    pub card_brand: Option<String>,
    pub card_last4: Option<String>,
    pub stripe_intent_id: Option<String>,
    pub status: String,
}

async fn get_merchant_activity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DateRangeQuery>,
) -> Result<Json<MerchantActivityResponse>, InsightsError> {
    require_staff_with_permission(&state, &headers, INSIGHTS_VIEW)
        .await
        .map_err(|e| match e.0 {
            StatusCode::UNAUTHORIZED => InsightsError::Unauthorized(e.1.to_string()),
            _ => InsightsError::Forbidden(e.1.to_string()),
        })?;

    let (start, end) = range_bounds(&q);

    let txs: Vec<MerchantTransaction> = sqlx::query_as(
        r#"
        SELECT id, created_at AS occurred_at, amount, merchant_fee, net_amount, payment_method, 
               card_brand, card_last4, stripe_intent_id, status::text
        FROM payment_transactions
        WHERE created_at >= $1 AND created_at < $2
          AND stripe_intent_id IS NOT NULL
        ORDER BY created_at DESC
        "#,
    )
    .bind(start)
    .bind(end)
    .fetch_all(&state.db)
    .await?;

    let mut total_processed = Decimal::ZERO;
    let mut total_fees = Decimal::ZERO;
    let mut net_amount = Decimal::ZERO;

    for t in &txs {
        total_processed += t.amount;
        total_fees += t.merchant_fee;
        net_amount += t.net_amount;
    }

    Ok(Json(MerchantActivityResponse {
        total_processed,
        total_fees,
        net_amount,
        transactions: txs,
    }))
}

#[derive(Debug, Serialize, FromRow)]
pub struct CommissionTraceEvent {
    pub event_id: Uuid,
    pub transaction_id: Option<Uuid>,
    pub transaction_line_id: Option<Uuid>,
    pub salesperson_name: String,
    pub role: Option<DbStaffRole>,
    pub line_gross: Decimal,
    pub base_rate: Decimal,
    pub applied_rate: Decimal,
    pub flat_spiff: Decimal,
    pub adjustment_amount: Decimal,
    pub total_commission: Decimal,
    pub source: String,
    pub explanation: String,
    pub snapshot_json: Value,
}

async fn commission_trace(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(event_id): Path<Uuid>,
) -> Result<Json<CommissionTraceEvent>, InsightsError> {
    require_staff_with_permission(&state, &headers, INSIGHTS_VIEW)
        .await
        .map_err(|(s, _)| {
            if s == StatusCode::FORBIDDEN {
                InsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                InsightsError::Unauthorized(
                    "staff credentials required (x-riverside-staff-code and PIN if set)"
                        .to_string(),
                )
            }
        })?;

    let trace = sqlx::query_as::<_, CommissionTraceEvent>(
        r#"
        SELECT
            ce.id AS event_id,
            ce.transaction_id,
            ce.transaction_line_id,
            COALESCE(st.full_name, 'Unassigned') AS salesperson_name,
            st.role,
            ce.commissionable_amount AS line_gross,
            ce.base_rate_used AS base_rate,
            ce.base_rate_used AS applied_rate,
            ce.incentive_amount AS flat_spiff,
            ce.adjustment_amount,
            ce.total_commission_amount AS total_commission,
            COALESCE(ce.snapshot_json->>'source', ce.event_type) AS source,
            CASE ce.event_type
              WHEN 'sale_commission' THEN 'Staff Profile base rate was snapshotted for this recognized sale line. Fixed SPIFFs, if any, are shown as incentive amount.'
              WHEN 'combo_incentive' THEN 'Fixed combo incentive event generated for a qualifying bundle.'
              WHEN 'return_adjustment' THEN 'Negative commission adjustment recorded in the return period.'
              WHEN 'manual_adjustment' THEN COALESCE(ce.note, 'Manual commission adjustment.')
              ELSE COALESCE(ce.note, 'Commission event snapshot.')
            END AS explanation,
            ce.snapshot_json
        FROM commission_events ce
        LEFT JOIN staff st ON st.id = ce.staff_id
        WHERE ce.id = $1
        "#,
    )
    .bind(event_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| InsightsError::BadRequest("commission event not found".to_string()))?;
    Ok(Json(trace))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/metabase-launch",
            get(get_metabase_launch).post(post_metabase_launch),
        )
        .route("/wedding-health", get(wedding_health_summary))
        .route(
            "/wedding-saved-views",
            get(list_wedding_saved_views).post(create_wedding_saved_view),
        )
        .route(
            "/wedding-saved-views/{id}",
            delete(delete_wedding_saved_view),
        )
        .route("/sales-pivot", get(sales_pivot))
        .route("/margin-pivot", get(margin_pivot))
        .route("/commission-ledger", get(commission_ledger))
        .route("/commission-adjustments", post(commission_adjustment))
        .route("/commission-finalize", post(commission_finalize))
        .route("/commission-lines", get(commission_lines))
        .route("/commission-trace/{line_id}", get(commission_trace))
        .route("/rms-charges", get(rms_charges_report))
        .route("/register-day-activity", get(register_day_activity_summary))
        .route("/register-sessions", get(register_session_history))
        .route("/register-override-mix", get(register_override_mix))
        .route("/nys-tax-audit", get(nys_tax_audit))
        .route("/staff-performance", get(staff_performance))
        .route("/appointments-no-show", get(appointments_no_show_report))
        .route(
            "/wedding-event-readiness",
            get(wedding_event_readiness_report),
        )
        .route(
            "/staff-schedule-coverage-sales",
            get(staff_schedule_coverage_sales_report),
        )
        .route("/customer-follow-up", get(customer_follow_up_report))
        .route("/exception-risk", get(exception_risk_report))
        .route("/best-sellers", get(best_sellers))
        .route("/dead-stock", get(dead_stock))
        .route("/loyalty-velocity", get(loyalty_velocity))
        .route("/merchant-activity", get(get_merchant_activity))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::store_account_rate::StoreAccountRateState;
    use crate::api::{AppState, PaymentIntentMinuteWindow};
    use crate::auth::permissions::{INSIGHTS_VIEW, REGISTER_REPORTS};
    use crate::auth::pins::hash_pin;
    use crate::logic::corecard::{CoreCardConfig, CoreCardTokenCache};
    use crate::logic::podium::PodiumTokenCache;
    use crate::logic::wedding_push::WeddingEventBus;
    use crate::observability::ServerLogRing;
    use axum::http::{HeaderMap, HeaderValue};
    use rust_decimal::Decimal;
    use sqlx::PgPool;
    use std::sync::Arc;
    use std::time::Instant;
    use tokio::sync::Mutex;

    async fn connect_test_db() -> PgPool {
        let _ =
            dotenvy::from_filename(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env"));
        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for DB-backed tests");
        PgPool::connect(&database_url)
            .await
            .expect("connect test database")
    }

    async fn next_staff_code(pool: &PgPool) -> String {
        for _ in 0..128 {
            let candidate = format!("{:04}", (Uuid::new_v4().as_u128() % 10_000) as u16);
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE cashier_code = $1)")
                    .bind(&candidate)
                    .fetch_one(pool)
                    .await
                    .expect("check cashier_code uniqueness");
            if !exists {
                return candidate;
            }
        }
        panic!("could not allocate unique 4-digit cashier code for test staff");
    }

    async fn insert_staff_with_permissions(
        pool: &PgPool,
        role: &str,
        permissions: &[&str],
    ) -> (Uuid, String) {
        let id = Uuid::new_v4();
        let code = next_staff_code(pool).await;
        let pin_hash = hash_pin(&code).expect("hash test staff pin");
        sqlx::query(
            r#"
            INSERT INTO staff (
                id, full_name, cashier_code, pin_hash, role, is_active, avatar_key
            )
            VALUES ($1, $2, $3, $4, $5::staff_role, TRUE, 'ros_default')
            "#,
        )
        .bind(id)
        .bind(format!("ROSIE Reporting Test {}", id.simple()))
        .bind(&code)
        .bind(pin_hash)
        .bind(role)
        .execute(pool)
        .await
        .expect("insert test staff");

        for permission in permissions {
            sqlx::query(
                r#"
                INSERT INTO staff_permission (staff_id, permission_key, allowed)
                VALUES ($1, $2, TRUE)
                ON CONFLICT (staff_id, permission_key)
                DO UPDATE SET allowed = EXCLUDED.allowed
                "#,
            )
            .bind(id)
            .bind(permission)
            .execute(pool)
            .await
            .expect("insert test permission");
        }

        (id, code)
    }

    fn build_test_state(pool: PgPool) -> AppState {
        AppState {
            db: pool,
            global_employee_markup: Decimal::new(15, 0),
            stripe_client: stripe::Client::new("sk_test_rosie_reporting"),
            http_client: reqwest::Client::new(),
            podium_token_cache: Arc::new(Mutex::new(PodiumTokenCache::default())),
            database_url: "postgres://test".to_string(),
            counterpoint_sync_token: None,
            wedding_events: WeddingEventBus::new(),
            payment_intent_minute: Arc::new(Mutex::new(PaymentIntentMinuteWindow {
                window_start: Instant::now(),
                count: 0,
            })),
            payment_intent_max_per_minute: 0,
            store_customer_jwt_secret: Arc::<[u8]>::from(b"rosie-reporting-test".as_slice()),
            store_account_rate: Arc::new(Mutex::new(StoreAccountRateState::default())),
            store_account_unauth_post_per_minute_ip: 0,
            store_account_authed_per_minute: 0,
            meilisearch: None,
            corecard_config: CoreCardConfig::from_env(),
            corecard_token_cache: Arc::new(Mutex::new(CoreCardTokenCache::default())),
            rosie_speech_state: Arc::new(Mutex::new(None)),
            server_log_ring: ServerLogRing::new(32, 512),
        }
    }

    fn auth_headers(code: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-riverside-staff-code",
            HeaderValue::from_str(code).expect("staff code header"),
        );
        headers.insert(
            "x-riverside-staff-pin",
            HeaderValue::from_str(code).expect("staff pin header"),
        );
        headers
    }

    #[tokio::test]
    async fn rosie_reporting_run_executes_allowlisted_report() {
        let pool = connect_test_db().await;
        let (_staff_id, code) =
            insert_staff_with_permissions(&pool, "salesperson", &[INSIGHTS_VIEW]).await;
        let state = build_test_state(pool);

        let result = rosie_reporting_run(
            &state,
            &auth_headers(&code),
            RosieReportingRunRequest {
                spec_id: "wedding_health".to_string(),
                params: serde_json::json!({}),
            },
        )
        .await
        .expect("allowlisted report should execute");

        assert_eq!(result.spec_id, "wedding_health");
        assert_eq!(result.route, "/api/insights/wedding-health");
        assert!(result.data.is_object());
    }

    #[tokio::test]
    async fn rosie_reporting_run_rejects_invalid_spec_id() {
        let pool = connect_test_db().await;
        let (_staff_id, code) =
            insert_staff_with_permissions(&pool, "salesperson", &[INSIGHTS_VIEW]).await;
        let state = build_test_state(pool);

        let err = rosie_reporting_run(
            &state,
            &auth_headers(&code),
            RosieReportingRunRequest {
                spec_id: "margin_pivot".to_string(),
                params: serde_json::json!({}),
            },
        )
        .await
        .expect_err("non-allowlisted spec should be rejected");

        match err {
            InsightsError::BadRequest(message) => {
                assert!(message.contains("unsupported reporting spec_id"));
            }
            other => panic!("expected bad request, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rosie_reporting_run_rejects_unknown_params() {
        let pool = connect_test_db().await;
        let (_staff_id, code) =
            insert_staff_with_permissions(&pool, "salesperson", &[INSIGHTS_VIEW]).await;
        let state = build_test_state(pool);

        let err = rosie_reporting_run(
            &state,
            &auth_headers(&code),
            RosieReportingRunRequest {
                spec_id: "sales_pivot".to_string(),
                params: serde_json::json!({
                    "group_by": "brand",
                    "basis": "booked",
                    "rogue": true
                }),
            },
        )
        .await
        .expect_err("unknown keys should be rejected");

        match err {
            InsightsError::BadRequest(message) => {
                assert!(message.contains("invalid reporting params for sales_pivot"));
                assert!(message.contains("rogue"));
            }
            other => panic!("expected bad request, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rosie_reporting_run_enforces_underlying_permissions() {
        let pool = connect_test_db().await;
        let (_staff_id, code) =
            insert_staff_with_permissions(&pool, "salesperson", &[INSIGHTS_VIEW]).await;
        let state = build_test_state(pool);

        let err = rosie_reporting_run(
            &state,
            &auth_headers(&code),
            RosieReportingRunRequest {
                spec_id: "register_day_activity".to_string(),
                params: serde_json::json!({
                    "from": Utc::now().date_naive(),
                    "to": Utc::now().date_naive(),
                    "basis": "booked"
                }),
            },
        )
        .await
        .expect_err("register reports permission should be required");

        match err {
            InsightsError::Forbidden(message) => {
                assert!(message.contains(REGISTER_REPORTS));
            }
            other => panic!("expected forbidden, got {other:?}"),
        }
    }
}
