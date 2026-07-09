//! Register / daily sales activity: store-local day bounds, aggregates, and activity timeline.

use chrono::{Datelike, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

use crate::logic::receipt_shared;
use crate::logic::report_basis::ReportBasis;

#[derive(Debug, Error)]
pub enum RegisterDayActivityError {
    #[error("{0}")]
    InvalidRange(String),
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

fn money_label(d: Decimal) -> String {
    format!("{}", d.round_dp(2))
}

fn payment_summary_label(payments: &[RegisterActivityPayment]) -> Option<String> {
    if payments.is_empty() {
        return None;
    }
    Some(
        payments
            .iter()
            .map(|payment| format!("{} ${}", payment.method, payment.amount_label))
            .collect::<Vec<_>>()
            .join(", "),
    )
}

fn parse_activity_payments(value: Option<serde_json::Value>) -> Vec<RegisterActivityPayment> {
    value
        .and_then(|v| serde_json::from_value::<Vec<RegisterActivityPaymentRaw>>(v).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|raw| {
            let amount = raw.amount.trim().parse::<Decimal>().ok()?;
            Some(RegisterActivityPayment {
                method: receipt_shared::tender_display_label(&raw.method),
                amount_label: money_label(amount),
            })
        })
        .collect()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActivityItemDetail {
    pub name: String,
    pub sku: String,
    pub quantity: i32,
    pub price: String,
    pub reg_price: Option<String>,
    pub product_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fulfillment: Option<String>,
    #[serde(default)]
    pub is_internal: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_kind: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RegisterActivityPayment {
    pub method: String,
    pub amount_label: String,
}

#[derive(Debug, Deserialize)]
struct RegisterActivityPaymentRaw {
    method: String,
    amount: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RegisterActivityItem {
    pub id: String,
    pub kind: String,
    pub occurred_at: chrono::DateTime<Utc>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_allocation_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wedding_party_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payments: Option<Vec<RegisterActivityPayment>>,

    // High-density UI fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sales_total: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tax_total: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_takeaway: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wedding_party_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<ActivityItemDetail>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merchant_fees_total: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_amount: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_first_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_last_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_phone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deposits_paid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance_due: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fulfillment_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_total: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_at: Option<chrono::DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RegisterDaySummary {
    pub timezone: String,
    pub from_local: NaiveDate,
    pub to_local: NaiveDate,
    pub preset: Option<String>,
    /// True when the selected range ends before the current store-local calendar day.
    pub is_historical: bool,
    /// True when range includes the current store-local day (live / in-progress).
    pub includes_today: bool,
    /// Stats/timeline were loaded from the Z-close snapshot for this calendar day (single-day historical, store-wide).
    #[serde(default)]
    pub from_eod_snapshot: bool,
    /// `booked` = date of sale (`booked_at`); `completed` = recognition date (takeaway sale time, pickup fulfillment time, or shipping recognition).
    #[serde(default = "default_reporting_basis")]
    pub reporting_basis: String,
    pub sales_count: i64,
    pub sales_subtotal_no_tax: String,
    pub sales_tax_total: String,
    pub avg_sale_no_tax: String,
    pub online_order_count: i64,
    pub pickup_count: i64,
    pub special_order_sale_count: i64,
    pub appointment_count: i64,
    pub new_appointment_count: i64,
    pub new_wedding_parties_count: i64,
    pub new_invoice_count: i64,
    /// Sum of all `merchant_fee` in `payment_transactions` for the range/session.
    pub merchant_fees_total: String,
    /// Merchandise sales excluding tax. Taxes remain in `sales_tax_total`.
    pub net_sales: String,
    /// Total payments received in cash ($0.00 format)
    pub cash_collected: String,
    /// Total payments received towards unfulfilled orders or as partial payments.
    pub deposits_collected: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub weather_days: Vec<RegisterDayWeatherSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weather_summary: Option<String>,
    pub activities: Vec<RegisterActivityItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pickups_today: Vec<RegisterActivityItem>,
}

fn default_reporting_basis() -> String {
    "booked".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RegisterDayWeatherSummary {
    pub date: NaiveDate,
    pub condition: String,
    pub temp_high: String,
    pub temp_low: String,
    pub precipitation_inches: String,
    pub source: String,
}

#[derive(sqlx::FromRow)]
struct WeatherRow {
    weather_date: NaiveDate,
    condition: Option<String>,
    temp_high: Option<String>,
    temp_low: Option<String>,
    precipitation_inches: Option<String>,
    source: Option<String>,
}

fn weather_summary_label(weather_days: &[RegisterDayWeatherSummary]) -> Option<String> {
    weather_days.first().map(|day| {
        format!(
            "{}: {} (high {}°, low {}°, precip {} in)",
            day.date, day.condition, day.temp_high, day.temp_low, day.precipitation_inches
        )
    })
}

async fn fetch_register_day_weather(
    pool: &PgPool,
    from_l: NaiveDate,
    to_l: NaiveDate,
    tz_name: &str,
) -> Result<Vec<RegisterDayWeatherSummary>, RegisterDayActivityError> {
    let weather_rows: Vec<WeatherRow> = sqlx::query_as(
        r#"
        WITH days AS (
            SELECT generate_series($1::date, $2::date, '1 day'::interval)::date AS weather_date
        )
        SELECT
            days.weather_date,
            COALESCE(
                register_weather.snapshot->0->>'condition',
                transaction_weather.snapshot->0->>'condition'
            ) AS condition,
            COALESCE(
                register_weather.snapshot->0->>'temp_high',
                transaction_weather.snapshot->0->>'temp_high'
            ) AS temp_high,
            COALESCE(
                register_weather.snapshot->0->>'temp_low',
                transaction_weather.snapshot->0->>'temp_low'
            ) AS temp_low,
            COALESCE(
                register_weather.snapshot->0->>'precipitation_inches',
                transaction_weather.snapshot->0->>'precipitation_inches'
            ) AS precipitation_inches,
            CASE
                WHEN register_weather.snapshot IS NOT NULL THEN 'Register close'
                WHEN transaction_weather.snapshot IS NOT NULL THEN 'Checkout'
                ELSE NULL
            END AS source
        FROM days
        LEFT JOIN LATERAL (
            SELECT rs.weather_snapshot AS snapshot
            FROM register_sessions rs
            WHERE rs.weather_snapshot IS NOT NULL
              AND jsonb_typeof(rs.weather_snapshot) = 'array'
              AND (rs.closed_at AT TIME ZONE $3)::date = days.weather_date
            ORDER BY rs.closed_at DESC NULLS LAST
            LIMIT 1
        ) register_weather ON true
        LEFT JOIN LATERAL (
            SELECT t.weather_snapshot AS snapshot
            FROM transactions t
            WHERE t.weather_snapshot IS NOT NULL
              AND jsonb_typeof(t.weather_snapshot) = 'array'
              AND COALESCE(t.business_date, (t.booked_at AT TIME ZONE $3)::date) = days.weather_date
            ORDER BY t.booked_at DESC
            LIMIT 1
        ) transaction_weather ON register_weather.snapshot IS NULL
        ORDER BY days.weather_date DESC
        "#,
    )
    .bind(from_l)
    .bind(to_l)
    .bind(tz_name)
    .fetch_all(pool)
    .await?;

    Ok(weather_rows
        .into_iter()
        .filter_map(|row| {
            let condition = row.condition?.trim().to_string();
            if condition.is_empty() {
                return None;
            }
            Some(RegisterDayWeatherSummary {
                date: row.weather_date,
                condition,
                temp_high: row.temp_high.unwrap_or_else(|| "0".to_string()),
                temp_low: row.temp_low.unwrap_or_else(|| "0".to_string()),
                precipitation_inches: row.precipitation_inches.unwrap_or_else(|| "0".to_string()),
                source: row.source.unwrap_or_else(|| "Weather snapshot".to_string()),
            })
        })
        .collect())
}

fn effective_tz(raw: Option<String>) -> Tz {
    let s = raw.unwrap_or_default();
    let t = s.trim();
    if t.is_empty() {
        return chrono_tz::America::New_York;
    }
    t.parse::<Tz>().unwrap_or(chrono_tz::America::New_York)
}

async fn receipt_timezone(pool: &PgPool) -> Result<String, sqlx::Error> {
    let tz_raw: Option<String> = sqlx::query_scalar(
        r#"SELECT receipt_config->>'timezone' FROM store_settings WHERE id = 1"#,
    )
    .fetch_optional(pool)
    .await?
    .flatten();
    let tz = effective_tz(tz_raw);
    Ok(tz.name().to_string())
}

fn local_day_bounds(
    tz: Tz,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<(chrono::DateTime<Utc>, chrono::DateTime<Utc>), String> {
    if to < from {
        return Err("invalid range (to before from)".to_string());
    }
    let start_local = from
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| "invalid from date".to_string())?;
    let start = tz
        .from_local_datetime(&start_local)
        .single()
        .ok_or_else(|| "ambiguous local start".to_string())?
        .with_timezone(&Utc);

    let to_next = to
        .succ_opt()
        .ok_or_else(|| "invalid to date".to_string())?
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| "invalid to date".to_string())?;
    let end = tz
        .from_local_datetime(&to_next)
        .single()
        .ok_or_else(|| "ambiguous local end".to_string())?
        .with_timezone(&Utc);
    Ok((start, end))
}

fn store_today_naive(tz: Tz) -> NaiveDate {
    Utc::now().with_timezone(&tz).date_naive()
}

/// Store-local calendar date for an instant (receipt timezone).
pub async fn store_local_date_for_utc(
    pool: &PgPool,
    t: chrono::DateTime<Utc>,
) -> Result<NaiveDate, sqlx::Error> {
    let tz_name = receipt_timezone(pool).await?;
    let tz = effective_tz(Some(tz_name));
    Ok(t.with_timezone(&tz).date_naive())
}

/// Inclusive `from` / `to` store-local dates → UTC `[start, end)` for filtering `register_sessions.closed_at`.
/// Defaults: `to` = store today, `from` = `to` − 90 days when omitted.
pub async fn utc_window_store_local_closed_at(
    pool: &PgPool,
    preset: Option<String>,
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
) -> Result<(chrono::DateTime<Utc>, chrono::DateTime<Utc>), RegisterDayActivityError> {
    let tz_name = receipt_timezone(pool).await?;
    let tz = effective_tz(Some(tz_name));
    let preset_ref = preset
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "recent");
    if preset_ref.is_some() {
        let (from_l, to_l, _) = resolve_register_day_range(tz, preset_ref, from, to)
            .map_err(RegisterDayActivityError::InvalidRange)?;
        return local_day_bounds(tz, from_l, to_l).map_err(RegisterDayActivityError::InvalidRange);
    }
    let today = store_today_naive(tz);
    let to_l = to.unwrap_or(today);
    let from_default = to_l
        .checked_sub_signed(Duration::days(90))
        .ok_or_else(|| RegisterDayActivityError::InvalidRange("from date underflow".into()))?;
    let from_l = from.unwrap_or(from_default);
    if to_l < from_l {
        return Err(RegisterDayActivityError::InvalidRange(
            "invalid range (to before from)".into(),
        ));
    }
    local_day_bounds(tz, from_l, to_l).map_err(RegisterDayActivityError::InvalidRange)
}

/// Upsert frozen register day summary (Z-close). Replaces prior row for the same `store_local_date`.
pub async fn save_eod_snapshot(
    pool: &PgPool,
    store_local_date: NaiveDate,
    till_close_group_id: Uuid,
    primary_register_session_id: Uuid,
    summary: &RegisterDaySummary,
) -> Result<(), RegisterDayActivityError> {
    let summary_json = serde_json::to_value(summary).map_err(RegisterDayActivityError::Serde)?;
    sqlx::query(
        r#"
        INSERT INTO store_register_eod_snapshot (
            store_local_date, timezone, till_close_group_id, primary_register_session_id, summary_json
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (store_local_date) DO UPDATE SET
            timezone = EXCLUDED.timezone,
            till_close_group_id = EXCLUDED.till_close_group_id,
            primary_register_session_id = EXCLUDED.primary_register_session_id,
            summary_json = EXCLUDED.summary_json,
            captured_at = now()
        "#,
    )
    .bind(store_local_date)
    .bind(&summary.timezone)
    .bind(till_close_group_id)
    .bind(primary_register_session_id)
    .bind(summary_json)
    .execute(pool)
    .await?;
    Ok(())
}

/// Resolve `preset` or `from`/`to` into inclusive local dates.
pub fn resolve_register_day_range(
    tz: Tz,
    preset: Option<&str>,
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
) -> Result<(NaiveDate, NaiveDate, Option<String>), String> {
    let today = store_today_naive(tz);
    let p = preset.map(str::trim).filter(|s| !s.is_empty());

    if let Some(pr) = p {
        let (a, b) = match pr {
            "today" => (today, today),
            "yesterday" => {
                let y = today.pred_opt().ok_or_else(|| "yesterday".to_string())?;
                (y, y)
            }
            "this_week" => {
                let wd = today.weekday().num_days_from_sunday() as i64;
                let start = today - Duration::days(wd);
                let end = start + Duration::days(6);
                (start, end)
            }
            "this_month" => {
                let start = NaiveDate::from_ymd_opt(today.year(), today.month(), 1)
                    .ok_or_else(|| "month start".to_string())?;
                let (ny, nm) = if today.month() == 12 {
                    (today.year() + 1, 1)
                } else {
                    (today.year(), today.month() + 1)
                };
                let next_m =
                    NaiveDate::from_ymd_opt(ny, nm, 1).ok_or_else(|| "next month".to_string())?;
                let end = next_m.pred_opt().ok_or_else(|| "month end".to_string())?;
                (start, end)
            }
            "this_year" => {
                let start = NaiveDate::from_ymd_opt(today.year(), 1, 1)
                    .ok_or_else(|| "year start".to_string())?;
                let end = NaiveDate::from_ymd_opt(today.year(), 12, 31)
                    .ok_or_else(|| "year end".to_string())?;
                (start, end)
            }
            "custom" => {
                let f = from.ok_or_else(|| "custom range requires from".to_string())?;
                let t = to.ok_or_else(|| "custom range requires to".to_string())?;
                (f, t)
            }
            _ => return Err(format!("unknown preset {pr}")),
        };
        return Ok((a, b, Some(pr.to_string())));
    }

    let f = from.unwrap_or(today);
    let t = to.unwrap_or(today);
    Ok((f, t, None))
}

const ORDER_BOOKED_SESSION_FILTER: &str = r#"
          AND (
            $3::uuid IS NULL
            OR o.register_session_id = $3
            OR EXISTS (
              SELECT 1
              FROM payment_allocations pa
              INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
              WHERE pa.target_transaction_id = o.id
                AND pt.session_id = $3
                AND pa.amount_allocated > 0
            )
          )"#;

const ORDER_COMPLETED_SESSION_FILTER: &str = r#"
          AND (
            $3::uuid IS NULL
            OR o.register_session_id = $3
            OR EXISTS (
              SELECT 1
              FROM payment_allocations pa
              INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
              WHERE pa.target_transaction_id = o.id
                AND pt.session_id = $3
                AND pa.amount_allocated > 0
            )
            OR EXISTS (
              SELECT 1
              FROM transaction_lines tl_session
              INNER JOIN transaction_line_lifecycle_events le_session
                ON le_session.transaction_line_id = tl_session.id
              LEFT JOIN register_sessions rs_session ON rs_session.id = $3
              WHERE tl_session.transaction_id = o.id
                AND le_session.source_workflow = 'pickup'
                AND le_session.new_status::text = 'picked_up'
                AND (
                  le_session.metadata->>'register_session_id' = $3::text
                  OR (
                    o.register_session_id IS NULL
                    AND COALESCE(NULLIF(le_session.metadata->>'register_session_id', ''), '') = ''
                    AND le_session.created_at >= rs_session.opened_at
                    AND le_session.created_at < COALESCE(rs_session.closed_at, CURRENT_TIMESTAMP)
                  )
                )
            )
          )"#;

fn order_session_filter_sql(basis: ReportBasis) -> &'static str {
    match basis {
        ReportBasis::Booked => ORDER_BOOKED_SESSION_FILTER,
        ReportBasis::Completed => ORDER_COMPLETED_SESSION_FILTER,
    }
}

pub async fn fetch_register_day_summary(
    pool: &PgPool,
    preset: Option<String>,
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    register_session_id: Option<Uuid>,
    basis: ReportBasis,
) -> Result<RegisterDaySummary, RegisterDayActivityError> {
    let tz_name = receipt_timezone(pool).await?;
    let tz = effective_tz(Some(tz_name.clone()));

    let preset_ref = preset.as_deref();
    let (from_l, to_l, preset_out) = resolve_register_day_range(tz, preset_ref, from, to)
        .map_err(RegisterDayActivityError::InvalidRange)?;

    let (start_utc, end_utc) =
        local_day_bounds(tz, from_l, to_l).map_err(RegisterDayActivityError::InvalidRange)?;

    let today = store_today_naive(tz);
    let is_historical = to_l < today;
    let includes_today = from_l <= today && to_l >= today;

    // Daily Sales must answer the selected day/range from canonical transaction
    // evidence. Older EOD snapshots can predate reporting fixes, so they are not
    // used as the source for manager-selected historical activity.

    let order_in_range = crate::logic::report_basis::order_date_filter_sql(basis);
    let order_session_filter = order_session_filter_sql(basis);
    let agg_sql = format!(
        r#"
        SELECT
            COUNT(DISTINCT o.id)::bigint AS sale_count,
            COALESCE(SUM(ln.line_subtotal), 0::numeric) AS subtotal_no_tax,
            COALESCE(SUM(ln.line_tax), 0::numeric) AS tax_total,
            COUNT(DISTINCT o.id) FILTER (WHERE o.sale_channel = 'web')::bigint AS web_count
        FROM transactions o
        INNER JOIN (
            SELECT
                transaction_id,
                SUM(
                    GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)::numeric
                    * oi.unit_price
                )::numeric(14,2) AS line_subtotal,
                SUM(
                    GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)::numeric
                    * (oi.state_tax + oi.local_tax)
                )::numeric(14,2) AS line_tax
            FROM transaction_lines oi
            LEFT JOIN products p ON p.id = oi.product_id
            LEFT JOIN (
                SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
                FROM transaction_return_lines
                GROUP BY transaction_line_id
            ) orl ON orl.transaction_line_id = oi.id
            WHERE COALESCE(oi.is_internal, false) = FALSE
              AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
              AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
            GROUP BY transaction_id
        ) ln ON ln.transaction_id = o.id
        WHERE {order_in_range}
        {order_session_filter}
        "#,
    );

    let row: (i64, Option<Decimal>, Option<Decimal>, i64) = sqlx::query_as(&agg_sql)
        .bind(start_utc)
        .bind(end_utc)
        .bind(register_session_id)
        .fetch_one(pool)
        .await?;

    let sales_count = row.0;
    let subtotal = row.1.unwrap_or(Decimal::ZERO);
    let tax_total = row.2.unwrap_or(Decimal::ZERO);
    let online_order_count = row.3;

    // Booked mode: pickups completed in range (fulfillment date). Completed mode: same as sale_count (orders completed in range).
    let pickup_count = if matches!(basis, ReportBasis::Booked) {
        let pickup_sql = format!(
            r#"
            SELECT COUNT(DISTINCT o.id)::bigint
            FROM transactions o
            WHERE o.status::text = 'fulfilled'
              AND o.fulfilled_at IS NOT NULL
              AND o.fulfilled_at >= $1
              AND o.fulfilled_at < $2
            AND EXISTS (
                  SELECT 1
                  FROM transaction_lines tl_pickup
                  WHERE tl_pickup.transaction_id = o.id
              )
            {order_session_filter}
            "#
        );
        let pickup_row: (i64,) = sqlx::query_as(&pickup_sql)
            .bind(start_utc)
            .bind(end_utc)
            .bind(register_session_id)
            .fetch_one(pool)
            .await?;
        pickup_row.0
    } else {
        sales_count
    };

    let avg = if sales_count > 0 {
        subtotal / Decimal::from(sales_count)
    } else {
        Decimal::ZERO
    };

    let special_sql = format!(
        r#"
        SELECT COUNT(DISTINCT o.id)::bigint
        FROM transactions o
        INNER JOIN transaction_lines oi ON oi.transaction_id = o.id
        WHERE {order_in_range}
          AND oi.fulfillment::text IN ('special_order', 'custom')
        {order_session_filter}
        "#
    );
    let special_row: (i64,) = sqlx::query_as(&special_sql)
        .bind(start_utc)
        .bind(end_utc)
        .bind(register_session_id)
        .fetch_one(pool)
        .await?;
    let special_order_sale_count = special_row.0;

    // --- Merchant Fees aggregation ---
    let fee_sql = r#"
        SELECT COALESCE(SUM(pt.merchant_fee), 0)::numeric(14,2)
        FROM payment_transactions pt
        WHERE COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) >= ($1 AT TIME ZONE reporting.effective_store_timezone())::date
          AND COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) < ($2 AT TIME ZONE reporting.effective_store_timezone())::date
          AND pt.status = 'success'
          AND ($3::uuid IS NULL OR pt.session_id = $3)
        "#
    .to_string();
    let merchant_fees_total: (Decimal,) = sqlx::query_as(&fee_sql)
        .bind(start_utc)
        .bind(end_utc)
        .bind(register_session_id)
        .fetch_one(pool)
        .await?;
    let merchant_fees = merchant_fees_total.0;

    let appt_row: (i64,) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint
        FROM wedding_appointments wa
        WHERE (wa.starts_at AT TIME ZONE $1)::date >= $2::date
          AND (wa.starts_at AT TIME ZONE $1)::date <= $3::date
        "#,
    )
    .bind(&tz_name)
    .bind(from_l)
    .bind(to_l)
    .fetch_one(pool)
    .await?;
    let appointment_count = appt_row.0;

    let new_appt_row: (i64,) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint
        FROM wedding_appointments wa
        WHERE (wa.created_at AT TIME ZONE $1)::date >= $2::date
          AND (wa.created_at AT TIME ZONE $1)::date <= $3::date
        "#,
    )
    .bind(&tz_name)
    .bind(from_l)
    .bind(to_l)
    .fetch_one(pool)
    .await?;
    let new_appointment_count = new_appt_row.0;

    let new_invoice_row: (i64,) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint
        FROM purchase_orders po
        WHERE po.po_kind = 'direct_invoice'
          AND (po.ordered_at AT TIME ZONE $1)::date >= $2::date
          AND (po.ordered_at AT TIME ZONE $1)::date <= $3::date
        "#,
    )
    .bind(&tz_name)
    .bind(from_l)
    .bind(to_l)
    .fetch_one(pool)
    .await?;
    let new_invoice_count = new_invoice_row.0;

    let wed_row: (i64,) = sqlx::query_as(
        r#"
        SELECT COUNT(*)::bigint
        FROM wedding_parties wp
        WHERE (wp.created_at AT TIME ZONE $1)::date >= $2::date
          AND (wp.created_at AT TIME ZONE $1)::date <= $3::date
        "#,
    )
    .bind(&tz_name)
    .bind(from_l)
    .bind(to_l)
    .fetch_one(pool)
    .await?;
    let new_wedding_parties_count = wed_row.0;

    let weather_days = fetch_register_day_weather(pool, from_l, to_l, &tz_name).await?;
    let weather_summary = weather_summary_label(&weather_days);

    // --- Cash and Deposits Dashboard Metrics ---
    let cash_row: (Option<Decimal>,) = sqlx::query_as(
        r#"
        SELECT SUM(amount)::numeric(14,2)
        FROM payment_transactions
        WHERE COALESCE(effective_date, (created_at AT TIME ZONE reporting.effective_store_timezone())::date) >= ($1 AT TIME ZONE reporting.effective_store_timezone())::date
          AND COALESCE(effective_date, (created_at AT TIME ZONE reporting.effective_store_timezone())::date) < ($2 AT TIME ZONE reporting.effective_store_timezone())::date
          AND status = 'success'
          AND payment_method = 'cash'
          AND ($3::uuid IS NULL OR session_id = $3)
        "#,
    )
    .bind(start_utc)
    .bind(end_utc)
    .bind(register_session_id)
    .fetch_one(pool)
    .await?;
    let cash_collected = cash_row.0.unwrap_or(Decimal::ZERO);

    // Definition of 'Deposit' for dashboard: Payments allocated to orders booked today that aren't takeaway,
    // OR any payment received today where the order was already existing (pre-payment/balance payment).
    let deposit_row: (Option<Decimal>,) = sqlx::query_as(
        r#"
        SELECT SUM(pa.amount_allocated)::numeric(14,2)
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        INNER JOIN transactions o ON o.id = pa.target_transaction_id
        WHERE COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) >= ($1 AT TIME ZONE reporting.effective_store_timezone())::date
          AND COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) < ($2 AT TIME ZONE reporting.effective_store_timezone())::date
          AND pt.status = 'success'
          AND ($3::uuid IS NULL OR pt.session_id = $3)
          AND (
            -- Case 1: Order booked today and HAS at least one item that is NOT immediately fulfilled takeaway
            (COALESCE(o.business_date, (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date) >= ($1 AT TIME ZONE reporting.effective_store_timezone())::date
             AND COALESCE(o.business_date, (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date) < ($2 AT TIME ZONE reporting.effective_store_timezone())::date
             AND EXISTS (
                SELECT 1 FROM transaction_lines oi WHERE oi.transaction_id = o.id AND oi.fulfillment::text <> 'takeaway'
            ))
            OR
            -- Case 2: Partial payment on any order (total > paid)
            (o.total_price > (SELECT SUM(pa2.amount_allocated) FROM payment_allocations pa2 WHERE pa2.target_transaction_id = o.id))
            OR
            -- Case 3: Order was booked BEFORE today (balance payment on old liability)
            (COALESCE(o.business_date, (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date) < ($1 AT TIME ZONE reporting.effective_store_timezone())::date)
          )
        "#,
    )
    .bind(start_utc)
    .bind(end_utc)
    .bind(register_session_id)
    .fetch_one(pool)
    .await?;
    let deposits_collected = deposit_row.0.unwrap_or(Decimal::ZERO);

    // --- Activity feed (merge in Rust) ---
    #[derive(sqlx::FromRow)]
    struct SaleAct {
        transaction_id: Uuid,
        short_id: Option<String>,
        booked_at: chrono::DateTime<Utc>,
        created_at: chrono::DateTime<Utc>,
        counterpoint_doc_ref: Option<String>,
        total_price: Decimal,
        sales_total_booked: Decimal,
        tax_total: Decimal,
        wedding_party_id: Option<Uuid>,
        party_name: Option<String>,
        customer_id: Option<Uuid>,
        customer_first: Option<String>,
        customer_last: Option<String>,
        customer_code: Option<String>,
        customer_phone: Option<String>,
        customer_email: Option<String>,
        is_takeaway: bool,
        channel: String,
        pay: Option<String>,
        payments_json: Option<serde_json::Value>,
        items_json: Option<serde_json::Value>,
        merchant_fees: Option<Decimal>,
        net_amount: Option<Decimal>,
        amount_paid_in_window: Option<Decimal>,
        fulfillment_type: Option<String>,
        balance_due: Decimal,
        has_rms_charge_payment_line: bool,
        has_alteration_service_line: bool,
    }

    #[derive(sqlx::FromRow)]
    struct PaymentAct {
        payment_id: Uuid,
        payment_allocation_id: Uuid,
        target_transaction_id: Option<Uuid>,
        created_at: chrono::DateTime<Utc>,
        amount: Decimal,
        payment_method: String,
        customer_id: Option<Uuid>,
        customer_first: Option<String>,
        customer_last: Option<String>,
        customer_code: Option<String>,
        customer_phone: Option<String>,
        customer_email: Option<String>,
        merchant_fee: Option<Decimal>,
        net_amount: Option<Decimal>,
        target_display_id: Option<String>,
    }

    let sale_ts = match basis {
        ReportBasis::Booked => "o.booked_at".to_string(),
        ReportBasis::Completed => crate::logic::report_basis::ORDER_RECOGNITION_TS_SQL
            .trim()
            .to_string(),
    };
    let sale_order_by = match basis {
        ReportBasis::Booked => "o.booked_at DESC".to_string(),
        ReportBasis::Completed => format!(
            "{ts} DESC",
            ts = crate::logic::report_basis::ORDER_RECOGNITION_TS_SQL.trim()
        ),
    };
    let sales_sql = format!(
        r#"
        SELECT
            o.id AS transaction_id,
            COALESCE(NULLIF(TRIM(o.display_id), ''), o.counterpoint_doc_ref, o.counterpoint_ticket_ref, o.id::text) AS short_id,
            {sale_ts} AS booked_at,
            o.created_at,
            o.counterpoint_doc_ref,
            o.total_price,
            COALESCE(SUM(
                GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)::numeric
                * (oi.state_tax + oi.local_tax)
            ), 0)::numeric(14,2) AS tax_total,
            wp.id AS wedding_party_id,
            wp.party_name,
            c.id AS customer_id,
            c.first_name AS customer_first,
            c.last_name AS customer_last,
            c.customer_code,
            c.phone AS customer_phone,
            c.email AS customer_email,
            COALESCE(BOOL_AND(oi.fulfillment::text = 'takeaway'), false) AS is_takeaway,
            o.sale_channel::text AS channel,
            (
                SELECT STRING_AGG(DISTINCT pt.payment_method, ', ' ORDER BY pt.payment_method)
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                WHERE pa.target_transaction_id = o.id
                  AND pt.status = 'success'
            ) AS pay,
            (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'method', payment_parts.payment_method,
                        'amount', payment_parts.amount::text
                    )
                    ORDER BY payment_parts.payment_method
                )
                FROM (
                    SELECT
                        pt.payment_method,
                        SUM(COALESCE(pa.amount_allocated, pt.amount))::numeric(14,2) AS amount
                    FROM payment_allocations pa
                    INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                    WHERE pa.target_transaction_id = o.id
                      AND pt.status = 'success'
                    GROUP BY pt.payment_method
                ) payment_parts
            ) AS payments_json,
            (
                SELECT SUM(pt.merchant_fee)
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                WHERE pa.target_transaction_id = o.id
            ) AS merchant_fees,
            (
                SELECT SUM(pt.net_amount)
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                WHERE pa.target_transaction_id = o.id
            ) AS net_amount,
            (
                SELECT SUM(pa.amount_allocated)
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                WHERE pa.target_transaction_id = o.id
                  AND COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) >= ($1 AT TIME ZONE reporting.effective_store_timezone())::date
                  AND COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) < ($2 AT TIME ZONE reporting.effective_store_timezone())::date
                  AND pt.status = 'success'
            ) AS amount_paid_in_window,
            COALESCE(SUM(
                GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)::numeric
                * (oi.unit_price + oi.state_tax + oi.local_tax)
            ), 0)::numeric(14,2) AS sales_total_booked,
            (
                SELECT STRING_AGG(DISTINCT oi2.fulfillment::text, ', ')
                FROM transaction_lines oi2
                WHERE oi2.transaction_id = o.id
            ) AS fulfillment_type,
            o.balance_due,
            EXISTS (
                SELECT 1
                FROM transaction_lines tl_rms
                INNER JOIN products p_rms ON p_rms.id = tl_rms.product_id
                WHERE tl_rms.transaction_id = o.id
                  AND (
                    p_rms.pos_line_kind = 'rms_charge_payment'
                    OR tl_rms.custom_item_type = 'rms_charge_payment'
                  )
            ) AS has_rms_charge_payment_line,
            EXISTS (
                SELECT 1
                FROM transaction_lines tl_alt
                INNER JOIN products p_alt ON p_alt.id = tl_alt.product_id
                WHERE tl_alt.transaction_id = o.id
                  AND (
                    p_alt.pos_line_kind = 'alteration_service'
                    OR tl_alt.custom_item_type = 'alteration_service'
                  )
            ) AS has_alteration_service_line,
            (
                SELECT jsonb_agg(jsonb_build_object(
                    'name', px.name,
                    'sku', pvx.sku,
                    'quantity', oix.quantity,
                    'price', oix.unit_price::text,
                    'reg_price', COALESCE(pvx.retail_price_override, px.base_retail_price)::text,
                    'product_id', px.id,
                    'fulfillment', oix.fulfillment::text,
                    'is_internal', COALESCE(oix.is_internal, false),
                    'line_kind', COALESCE(NULLIF(TRIM(px.pos_line_kind), ''), NULLIF(TRIM(oix.custom_item_type), ''))
                ))
                FROM transaction_lines oix
                INNER JOIN products px ON px.id = oix.product_id
                INNER JOIN product_variants pvx ON pvx.id = oix.variant_id
                WHERE oix.transaction_id = o.id
            ) AS items_json
        FROM transactions o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN wedding_members wm ON wm.id = o.wedding_member_id
        LEFT JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        LEFT JOIN transaction_lines oi ON oi.transaction_id = o.id
        LEFT JOIN (
            SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
            FROM transaction_return_lines
            GROUP BY transaction_line_id
        ) orl ON orl.transaction_line_id = oi.id
        WHERE {order_in_range}
          AND EXISTS (
              SELECT 1
              FROM transaction_lines tl_activity
              WHERE tl_activity.transaction_id = o.id
          )
        {order_session_filter}
        GROUP BY o.id, {sale_ts}, o.created_at, o.counterpoint_doc_ref, o.total_price, o.balance_due, wp.id, wp.party_name, c.id, c.first_name, c.last_name, c.customer_code, c.phone, c.email, o.sale_channel::text
        ORDER BY {sale_order_by}
        LIMIT 120
        "#
    );
    let sales: Vec<SaleAct> = sqlx::query_as(&sales_sql)
        .bind(start_utc)
        .bind(end_utc)
        .bind(register_session_id)
        .fetch_all(pool)
        .await?;

    let pickups_today_sql = format!(
        r#"
        SELECT
            o.id AS transaction_id,
            COALESCE(NULLIF(TRIM(o.display_id), ''), o.counterpoint_doc_ref, o.counterpoint_ticket_ref, o.id::text) AS short_id,
            MAX(tl.fulfilled_at) AS booked_at,
            o.created_at,
            o.counterpoint_doc_ref,
            o.total_price,
            COALESCE(SUM(
                GREATEST(tl.quantity - COALESCE(orl.returned, 0), 0)::numeric
                * (tl.state_tax + tl.local_tax)
            ), 0)::numeric(14,2) AS tax_total,
            wp.id AS wedding_party_id,
            wp.party_name,
            c.id AS customer_id,
            c.first_name AS customer_first,
            c.last_name AS customer_last,
            c.customer_code,
            c.phone AS customer_phone,
            c.email AS customer_email,
            false AS is_takeaway,
            o.sale_channel::text AS channel,
            NULL::text AS pay,
            NULL::jsonb AS payments_json,
            NULL::numeric AS merchant_fees,
            NULL::numeric AS net_amount,
            NULL::numeric AS amount_paid_in_window,
            COALESCE(SUM(
                GREATEST(tl.quantity - COALESCE(orl.returned, 0), 0)::numeric
                * (tl.unit_price + tl.state_tax + tl.local_tax)
            ), 0)::numeric(14,2) AS sales_total_booked,
            'pickup'::text AS fulfillment_type,
            o.balance_due,
            false AS has_rms_charge_payment_line,
            false AS has_alteration_service_line,
            (
                SELECT jsonb_agg(jsonb_build_object(
                    'name', px.name,
                    'sku', pvx.sku,
                    'quantity', tlx.quantity,
                    'price', tlx.unit_price::text,
                    'reg_price', COALESCE(pvx.retail_price_override, px.base_retail_price)::text,
                    'product_id', px.id,
                    'fulfillment', 'pickup',
                    'is_internal', COALESCE(tlx.is_internal, false),
                    'line_kind', COALESCE(NULLIF(TRIM(px.pos_line_kind), ''), NULLIF(TRIM(tlx.custom_item_type), ''))
                ) ORDER BY tlx.fulfilled_at, tlx.id)
                FROM transaction_lines tlx
                INNER JOIN products px ON px.id = tlx.product_id
                INNER JOIN product_variants pvx ON pvx.id = tlx.variant_id
                WHERE tlx.transaction_id = o.id
                  AND COALESCE(tlx.is_internal, false) = false
                  AND tlx.fulfillment::text <> 'takeaway'
                  AND tlx.fulfilled_at >= $1
                  AND tlx.fulfilled_at < $2
            ) AS items_json
        FROM transactions o
        INNER JOIN transaction_lines tl ON tl.transaction_id = o.id
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN wedding_members wm ON wm.id = o.wedding_member_id
        LEFT JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        LEFT JOIN (
            SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
            FROM transaction_return_lines
            GROUP BY transaction_line_id
        ) orl ON orl.transaction_line_id = tl.id
        WHERE o.status::text <> 'cancelled'
          AND COALESCE(tl.is_internal, false) = false
          AND tl.fulfillment::text <> 'takeaway'
          AND tl.fulfilled_at >= $1
          AND tl.fulfilled_at < $2
          AND ($3::uuid IS NULL OR o.register_session_id = $3)
        GROUP BY o.id, o.created_at, o.counterpoint_doc_ref, o.total_price, o.balance_due, wp.id, wp.party_name, c.id, c.first_name, c.last_name, c.customer_code, c.phone, c.email, o.sale_channel::text
        ORDER BY MAX(tl.fulfilled_at) DESC
        LIMIT 80
        "#,
    );
    let pickups_today: Vec<SaleAct> = sqlx::query_as(&pickups_today_sql)
        .bind(start_utc)
        .bind(end_utc)
        .bind(register_session_id)
        .fetch_all(pool)
        .await?;

    let payments: Vec<PaymentAct> = sqlx::query_as(
        r#"
        SELECT
            pt.id AS payment_id,
            pa.id AS payment_allocation_id,
            pa.target_transaction_id,
            pt.created_at,
            pa.amount_allocated AS amount,
            pt.payment_method,
            c.id AS customer_id,
            c.first_name AS customer_first,
            c.last_name AS customer_last,
            c.customer_code,
            c.phone AS customer_phone,
            c.email AS customer_email,
            pt.merchant_fee,
            pt.net_amount,
            COALESCE(NULLIF(TRIM(o.display_id), ''), o.counterpoint_doc_ref, o.counterpoint_ticket_ref, o.id::text) AS target_display_id
        FROM payment_transactions pt
        INNER JOIN payment_allocations pa ON pa.transaction_id = pt.id
        INNER JOIN transactions o ON o.id = pa.target_transaction_id
        LEFT JOIN customers c ON c.id = COALESCE(pt.payer_id, o.customer_id)
        WHERE COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) >= ($1 AT TIME ZONE reporting.effective_store_timezone())::date
          AND COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) < ($2 AT TIME ZONE reporting.effective_store_timezone())::date
          AND pt.status = 'success'
          AND ($3::uuid IS NULL OR pt.session_id = $3)
          AND NOT (
              COALESCE(o.business_date, (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date) >= ($1 AT TIME ZONE reporting.effective_store_timezone())::date
              AND COALESCE(o.business_date, (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date) < ($2 AT TIME ZONE reporting.effective_store_timezone())::date
              AND EXISTS (
                  SELECT 1
                  FROM transaction_lines tl_same_day_sale
                  WHERE tl_same_day_sale.transaction_id = o.id
              )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM payment_allocations pa_same_day_sale
              INNER JOIN transactions o_same_day_sale ON o_same_day_sale.id = pa_same_day_sale.target_transaction_id
              WHERE pa_same_day_sale.transaction_id = pt.id
                AND pa_same_day_sale.id <> pa.id
                AND o_same_day_sale.status::text <> 'cancelled'
                AND COALESCE(o_same_day_sale.business_date, (o_same_day_sale.booked_at AT TIME ZONE reporting.effective_store_timezone())::date) >= ($1 AT TIME ZONE reporting.effective_store_timezone())::date
                AND COALESCE(o_same_day_sale.business_date, (o_same_day_sale.booked_at AT TIME ZONE reporting.effective_store_timezone())::date) < ($2 AT TIME ZONE reporting.effective_store_timezone())::date
                AND EXISTS (
                    SELECT 1
                    FROM transaction_lines tl_same_day_sale
                    WHERE tl_same_day_sale.transaction_id = o_same_day_sale.id
                )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM transactions checkout_o
              WHERE checkout_o.id::text = pt.metadata->>'checkout_transaction_id'
                AND checkout_o.status::text <> 'cancelled'
                AND COALESCE(checkout_o.business_date, (checkout_o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date) >= ($1 AT TIME ZONE reporting.effective_store_timezone())::date
                AND COALESCE(checkout_o.business_date, (checkout_o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date) < ($2 AT TIME ZONE reporting.effective_store_timezone())::date
                AND EXISTS (
                    SELECT 1
                    FROM transaction_lines checkout_line
                    WHERE checkout_line.transaction_id = checkout_o.id
                )
          )
        ORDER BY pt.created_at DESC
        LIMIT 120
        "#,
    )
    .bind(start_utc)
    .bind(end_utc)
    .bind(register_session_id)
    .fetch_all(pool)
    .await?;

    let mut activities: Vec<RegisterActivityItem> = Vec::new();

    fn customer_label(
        party: Option<&str>,
        first: Option<&str>,
        last: Option<&str>,
    ) -> Option<String> {
        let party_t = party.map(str::trim).filter(|s| !s.is_empty());
        if let Some(p) = party_t {
            return Some(p.to_string());
        }
        let f = first.map(str::trim).filter(|s| !s.is_empty());
        let l = last.map(str::trim).filter(|s| !s.is_empty());
        match (f, l) {
            (Some(a), Some(b)) => Some(format!("{a} {b}")),
            (Some(a), None) => Some(a.to_string()),
            (None, Some(b)) => Some(b.to_string()),
            (None, None) => None,
        }
    }

    for s in sales {
        let is_rms_payment_activity = s.has_rms_charge_payment_line;
        let is_pickup_activity =
            matches!(basis, ReportBasis::Completed) && !s.is_takeaway && !is_rms_payment_activity;
        let title = if is_rms_payment_activity {
            "RMS Charge Payment".to_string()
        } else if s.has_alteration_service_line && s.is_takeaway {
            "Alteration Sale".to_string()
        } else {
            match basis {
                ReportBasis::Completed => {
                    if s.is_takeaway {
                        "POS Retail Sale (Completed)".to_string()
                    } else {
                        "Order Pickup".to_string()
                    }
                }
                ReportBasis::Booked => {
                    if s.is_takeaway {
                        "POS Retail Sale".to_string()
                    } else {
                        "Order Booked (Sale)".to_string()
                    }
                }
            }
        };
        let sale_kind = if is_rms_payment_activity {
            "payment"
        } else if is_pickup_activity {
            "pickup"
        } else if matches!(basis, ReportBasis::Completed) {
            "completed"
        } else {
            "sale"
        };
        let items: Option<Vec<ActivityItemDetail>> = s
            .items_json
            .and_then(|v| serde_json::from_value::<Vec<ActivityItemDetail>>(v).ok());
        let payments = parse_activity_payments(s.payments_json);
        let payment_summary = payment_summary_label(&payments).or_else(|| s.pay.clone());
        let payments = if payments.is_empty() {
            None
        } else {
            Some(payments)
        };

        let customer_full = match (
            s.customer_first
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty()),
            s.customer_last
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty()),
        ) {
            (Some(f), Some(l)) => Some(format!("{f} {l}")),
            (Some(f), None) => Some(f.to_string()),
            (None, Some(l)) => Some(l.to_string()),
            _ => {
                if let Some(p) = s
                    .party_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    Some(p.to_string())
                } else {
                    s.customer_code.clone()
                }
            }
        };

        let deposits = s
            .amount_paid_in_window
            .filter(|&a| a > Decimal::ZERO)
            .map(money_label);
        let balance = Some(money_label(s.balance_due.max(Decimal::ZERO)));

        let is_counterpoint_import = s
            .counterpoint_doc_ref
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();

        activities.push(RegisterActivityItem {
            id: format!("{sale_kind}:{}", s.transaction_id),
            kind: sale_kind.to_string(),
            occurred_at: s.booked_at,
            title: if is_counterpoint_import {
                "Imported Order".to_string()
            } else {
                title
            },
            subtitle: customer_label(
                s.party_name.as_deref(),
                s.customer_first.as_deref(),
                s.customer_last.as_deref(),
            ),
            transaction_id: Some(s.transaction_id),
            payment_id: None,
            payment_allocation_id: None,
            wedding_party_id: s.wedding_party_id,
            amount_label: Some(format!("${}", money_label(s.sales_total_booked))),
            payment_summary,
            payments,
            sales_total: Some(money_label(s.sales_total_booked)),
            tax_total: Some(money_label(s.tax_total)),
            is_takeaway: Some(s.is_takeaway),
            channel: Some(s.channel),
            wedding_party_name: s.party_name,
            items,
            merchant_fees_total: s.merchant_fees.map(money_label),
            net_amount: s.net_amount.map(money_label),
            customer_id: s.customer_id,
            customer_first_name: s.customer_first,
            customer_last_name: s.customer_last,
            customer_name: customer_full,
            customer_code: s.customer_code,
            customer_phone: s.customer_phone,
            customer_email: s.customer_email,
            deposits_paid: deposits,
            balance_due: balance,
            fulfillment_type: if is_pickup_activity {
                Some("pickup".to_string())
            } else {
                s.fulfillment_type
            },
            transaction_total: s.amount_paid_in_window.map(money_label),
            short_id: s.short_id,
            imported_at: if is_counterpoint_import {
                Some(s.created_at)
            } else {
                None
            },
        });
    }

    for p in payments {
        let customer_full = match (
            p.customer_first
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty()),
            p.customer_last
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty()),
        ) {
            (Some(f), Some(l)) => Some(format!("{f} {l}")),
            (Some(f), None) => Some(f.to_string()),
            (None, Some(l)) => Some(l.to_string()),
            _ => p.customer_code.clone(),
        };
        let payment_label = receipt_shared::tender_display_label(&p.payment_method);
        let payment_amount = money_label(p.amount);

        activities.push(RegisterActivityItem {
            id: format!("payment:{}", p.payment_id),
            kind: "payment".to_string(),
            occurred_at: p.created_at,
            title: "Payment Recorded".to_string(),
            subtitle: p
                .target_display_id
                .as_deref()
                .map(|display_id| format!("Applied to {display_id}")),
            transaction_id: p.target_transaction_id,
            payment_id: Some(p.payment_id),
            payment_allocation_id: Some(p.payment_allocation_id),
            wedding_party_id: None,
            amount_label: Some(format!("${}", money_label(p.amount))),
            payment_summary: Some(format!("{payment_label} ${payment_amount}")),
            payments: Some(vec![RegisterActivityPayment {
                method: payment_label,
                amount_label: payment_amount,
            }]),
            sales_total: None,
            tax_total: None,
            is_takeaway: None,
            channel: None,
            wedding_party_name: None,
            items: None,
            merchant_fees_total: p.merchant_fee.map(money_label),
            net_amount: p.net_amount.map(money_label),
            customer_id: p.customer_id,
            customer_first_name: p.customer_first,
            customer_last_name: p.customer_last,
            customer_name: customer_full,
            customer_code: p.customer_code,
            customer_phone: p.customer_phone,
            customer_email: p.customer_email,
            deposits_paid: Some(money_label(p.amount)),
            balance_due: None,
            fulfillment_type: Some("payment".to_string()),
            transaction_total: Some(money_label(p.amount)),
            short_id: p.target_display_id,
            imported_at: None,
        });
    }

    activities.sort_by(|x, y| y.occurred_at.cmp(&x.occurred_at));
    activities.truncate(200);

    let pickups_today = pickups_today
        .into_iter()
        .map(|p| {
            let customer_full = match (
                p.customer_first
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
                p.customer_last
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
            ) {
                (Some(f), Some(l)) => Some(format!("{f} {l}")),
                (Some(f), None) => Some(f.to_string()),
                (None, Some(l)) => Some(l.to_string()),
                _ => p.customer_code.clone(),
            };
            RegisterActivityItem {
                id: format!("pickup-today:{}", p.transaction_id),
                kind: "pickup".to_string(),
                occurred_at: p.booked_at,
                title: "Pickup Today".to_string(),
                subtitle: customer_label(
                    p.party_name.as_deref(),
                    p.customer_first.as_deref(),
                    p.customer_last.as_deref(),
                ),
                transaction_id: Some(p.transaction_id),
                payment_id: None,
                payment_allocation_id: None,
                wedding_party_id: p.wedding_party_id,
                amount_label: Some(format!("${}", money_label(p.sales_total_booked))),
                payment_summary: None,
                payments: None,
                sales_total: Some(money_label(p.sales_total_booked)),
                tax_total: Some(money_label(p.tax_total)),
                is_takeaway: Some(false),
                channel: Some(p.channel),
                wedding_party_name: p.party_name,
                items: p
                    .items_json
                    .and_then(|v| serde_json::from_value::<Vec<ActivityItemDetail>>(v).ok()),
                merchant_fees_total: None,
                net_amount: None,
                customer_id: p.customer_id,
                customer_first_name: p.customer_first,
                customer_last_name: p.customer_last,
                customer_name: customer_full,
                customer_code: p.customer_code,
                customer_phone: p.customer_phone,
                customer_email: p.customer_email,
                deposits_paid: None,
                balance_due: Some(money_label(p.balance_due.max(Decimal::ZERO))),
                fulfillment_type: Some("pickup".to_string()),
                transaction_total: None,
                short_id: p.short_id,
                imported_at: None,
            }
        })
        .collect();

    Ok(RegisterDaySummary {
        timezone: tz_name,
        from_local: from_l,
        to_local: to_l,
        preset: preset_out,
        is_historical,
        includes_today,
        from_eod_snapshot: false,
        reporting_basis: basis.as_str().to_string(),
        sales_count,
        sales_subtotal_no_tax: money_label(subtotal),
        sales_tax_total: money_label(tax_total),
        avg_sale_no_tax: money_label(avg),
        online_order_count,
        pickup_count,
        special_order_sale_count,
        appointment_count,
        new_appointment_count,
        new_wedding_parties_count,
        new_invoice_count,
        merchant_fees_total: money_label(merchant_fees),
        net_sales: money_label(subtotal),
        cash_collected: money_label(cash_collected),
        deposits_collected: money_label(deposits_collected),
        weather_days,
        weather_summary,
        activities,
        pickups_today,
    })
}
