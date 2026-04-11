//! Register / daily sales activity: store-local day bounds, aggregates, and activity timeline.

use chrono::{Datelike, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActivityItemDetail {
    pub name: String,
    pub sku: String,
    pub quantity: i32,
    pub price: String,
    pub product_id: Uuid,
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
    pub order_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wedding_party_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_summary: Option<String>,

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
    pub stripe_fees_total: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_amount: Option<String>,
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
    /// `booked` = date of sale (`booked_at`); `completed` = pickup day (`fulfilled_at`, fulfilled orders only).
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
    pub new_wedding_parties_count: i64,
    /// Sum of all `merchant_fee` in `payment_transactions` for the range/session.
    pub stripe_fees_total: String,
    /// subtotal + tax - fees (or similar net definition).
    pub net_sales: String,
    pub activities: Vec<RegisterActivityItem>,
}

fn default_reporting_basis() -> String {
    "booked".to_string()
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
        .unwrap();
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
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
) -> Result<(chrono::DateTime<Utc>, chrono::DateTime<Utc>), RegisterDayActivityError> {
    let tz_name = receipt_timezone(pool).await?;
    let tz = effective_tz(Some(tz_name));
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

async fn try_load_eod_snapshot(
    pool: &PgPool,
    store_local_date: NaiveDate,
) -> Result<Option<RegisterDaySummary>, sqlx::Error> {
    let v: Option<serde_json::Value> = sqlx::query_scalar(
        r#"SELECT summary_json FROM store_register_eod_snapshot WHERE store_local_date = $1"#,
    )
    .bind(store_local_date)
    .fetch_optional(pool)
    .await?;
    let Some(raw) = v else {
        return Ok(None);
    };
    match serde_json::from_value::<RegisterDaySummary>(raw) {
        Ok(mut s) => {
            s.from_eod_snapshot = true;
            s.is_historical = true;
            s.includes_today = false;
            s.from_local = store_local_date;
            s.to_local = store_local_date;
            s.reporting_basis = "booked".to_string();
            Ok(Some(s))
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                store_local_date = %store_local_date,
                "store_register_eod_snapshot JSON invalid; recomputing day summary live"
            );
            Ok(None)
        }
    }
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
                let wd = today.weekday().num_days_from_monday() as i64;
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

const ORDER_SESSION_FILTER: &str = r#"
          AND (
            $3::uuid IS NULL
            OR EXISTS (
              SELECT 1
              FROM payment_allocations pa
              INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
              WHERE pa.target_order_id = o.id
                AND pt.session_id = $3
                AND pa.amount_allocated > 0
            )
          )"#;

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

    if matches!(basis, ReportBasis::Booked)
        && register_session_id.is_none()
        && from_l == to_l
        && to_l < today
    {
        if let Some(mut snap) = try_load_eod_snapshot(pool, from_l).await? {
            snap.preset = preset_out.clone();
            return Ok(snap);
        }
    }

    let order_in_range = crate::logic::report_basis::order_date_filter_sql(basis);

    let agg_sql = format!(
        r#"
        SELECT
            COUNT(DISTINCT o.id)::bigint AS sale_count,
            COALESCE(SUM(ln.line_subtotal), 0::numeric) AS subtotal_no_tax,
            COALESCE(SUM(ln.line_tax), 0::numeric) AS tax_total,
            COUNT(DISTINCT o.id) FILTER (WHERE o.sale_channel = 'web')::bigint AS web_count
        FROM orders o
        INNER JOIN (
            SELECT 
                order_id, 
                SUM((quantity::numeric) * oi.unit_price)::numeric(14,2) AS line_subtotal,
                SUM(oi.state_tax + oi.local_tax)::numeric(14,2) AS line_tax
            FROM order_items oi
            GROUP BY order_id
        ) ln ON ln.order_id = o.id
        WHERE {order_in_range}
        {ORDER_SESSION_FILTER}
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
            FROM orders o
            WHERE o.status::text = 'fulfilled'
              AND o.fulfilled_at IS NOT NULL
              AND o.fulfilled_at >= $1
              AND o.fulfilled_at < $2
            {ORDER_SESSION_FILTER}
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
        FROM orders o
        INNER JOIN order_items oi ON oi.order_id = o.id
        WHERE {order_in_range}
          AND oi.fulfillment::text IN ('special_order', 'custom')
        {ORDER_SESSION_FILTER}
        "#
    );
    let special_row: (i64,) = sqlx::query_as(&special_sql)
        .bind(start_utc)
        .bind(end_utc)
        .bind(register_session_id)
        .fetch_one(pool)
        .await?;
    let special_order_sale_count = special_row.0;

    // --- Merchant Fees (Stripe) aggregation ---
    let fee_sql = format!(
        r#"
        SELECT COALESCE(SUM(pt.merchant_fee), 0)::numeric(14,2)
        FROM payment_transactions pt
        WHERE pt.occurred_at >= $1 AND pt.occurred_at < $2
          AND pt.status = 'success'
          AND ($3::uuid IS NULL OR pt.session_id = $3)
        "#
    );
    let stripe_fees_total: (Decimal,) = sqlx::query_as(&fee_sql)
        .bind(start_utc)
        .bind(end_utc)
        .bind(register_session_id)
        .fetch_one(pool)
        .await?;
    let stripe_fees = stripe_fees_total.0;

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

    // --- Activity feed (merge in Rust) ---
    #[derive(sqlx::FromRow)]
    struct SaleAct {
        order_id: Uuid,
        booked_at: chrono::DateTime<Utc>,
        total_price: Decimal,
        tax_total: Decimal,
        party_name: Option<String>,
        customer_first: Option<String>,
        customer_last: Option<String>,
        has_special: bool,
        is_takeaway: bool,
        channel: String,
        pay: Option<String>,
        items_json: Option<serde_json::Value>,
        stripe_fees: Option<Decimal>,
        net_amount: Option<Decimal>,
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
            o.id AS order_id,
            {sale_ts} AS booked_at,
            o.total_price,
            COALESCE(SUM(oi.state_tax + oi.local_tax), 0)::numeric(14,2) AS tax_total,
            wp.party_name,
            c.first_name AS customer_first,
            c.last_name AS customer_last,
            BOOL_OR(oi.fulfillment::text IN ('special_order', 'custom')) AS has_special,
            BOOL_AND(oi.fulfillment::text = 'takeaway') AS is_takeaway,
            o.sale_channel::text AS channel,
            (
                SELECT STRING_AGG(DISTINCT pt.payment_method, ', ' ORDER BY pt.payment_method)
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                WHERE pa.target_order_id = o.id
            ) AS pay,
            (
                SELECT SUM(pt.merchant_fee)
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                WHERE pa.target_order_id = o.id
            ) AS stripe_fees,
            (
                SELECT SUM(pt.net_amount)
                FROM payment_allocations pa
                INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                WHERE pa.target_order_id = o.id
            ) AS net_amount,
            (
                SELECT jsonb_agg(jsonb_build_object(
                    'name', px.name,
                    'sku', pvx.sku,
                    'quantity', oix.quantity,
                    'price', oix.unit_price::text,
                    'product_id', px.id
                ))
                FROM order_items oix
                INNER JOIN products px ON px.id = oix.product_id
                INNER JOIN product_variants pvx ON pvx.id = oix.variant_id
                WHERE oix.order_id = o.id
            ) AS items_json
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN wedding_members wm ON wm.id = o.wedding_member_id
        LEFT JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE {order_in_range}
        {ORDER_SESSION_FILTER}
        GROUP BY o.id, {sale_ts}, o.total_price, wp.party_name, c.first_name, c.last_name, o.sale_channel::text
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

    #[derive(sqlx::FromRow)]
    struct PickupAct {
        order_id: Uuid,
        fulfilled_at: chrono::DateTime<Utc>,
        total_price: Decimal,
        party_name: Option<String>,
        customer_first: Option<String>,
        customer_last: Option<String>,
    }

    let pickups: Vec<PickupAct> = if matches!(basis, ReportBasis::Booked) {
        sqlx::query_as(
            r#"
            SELECT DISTINCT ON (o.id)
                o.id AS order_id,
                o.fulfilled_at AS fulfilled_at,
                o.total_price,
                wp.party_name,
                c.first_name AS customer_first,
                c.last_name AS customer_last
            FROM orders o
            LEFT JOIN customers c ON c.id = o.customer_id
            LEFT JOIN wedding_members wm ON wm.id = o.wedding_member_id
            LEFT JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
            WHERE o.status::text = 'fulfilled'
              AND o.fulfilled_at IS NOT NULL
              AND o.fulfilled_at >= $1
              AND o.fulfilled_at < $2
              AND (
                $3::uuid IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM payment_allocations pa
                  INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
                  WHERE pa.target_order_id = o.id
                    AND pt.session_id = $3
                    AND pa.amount_allocated > 0
                )
              )
            ORDER BY o.id, o.fulfilled_at DESC
            LIMIT 80
            "#,
        )
        .bind(start_utc)
        .bind(end_utc)
        .bind(register_session_id)
        .fetch_all(pool)
        .await?
    } else {
        Vec::new()
    };

    #[derive(sqlx::FromRow)]
    struct WedAct {
        id: Uuid,
        created_at: chrono::DateTime<Utc>,
        party_name: String,
    }

    let weddings: Vec<WedAct> = sqlx::query_as(
        r#"
        SELECT id, created_at, party_name
        FROM wedding_parties
        WHERE (created_at AT TIME ZONE $1)::date >= $2::date
          AND (created_at AT TIME ZONE $1)::date <= $3::date
        ORDER BY created_at DESC
        LIMIT 60
        "#,
    )
    .bind(&tz_name)
    .bind(from_l)
    .bind(to_l)
    .fetch_all(pool)
    .await?;

    #[derive(sqlx::FromRow)]
    struct ApptAct {
        id: Uuid,
        starts_at: chrono::DateTime<Utc>,
        notes: Option<String>,
        party_name: Option<String>,
    }

    let appts: Vec<ApptAct> = sqlx::query_as(
        r#"
        SELECT wa.id, wa.starts_at, wa.notes, wp.party_name
        FROM wedding_appointments wa
        LEFT JOIN wedding_members wm ON wm.id = wa.wedding_member_id
        LEFT JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        WHERE (wa.starts_at AT TIME ZONE $1)::date >= $2::date
          AND (wa.starts_at AT TIME ZONE $1)::date <= $3::date
        ORDER BY wa.starts_at DESC
        LIMIT 80
        "#,
    )
    .bind(&tz_name)
    .bind(from_l)
    .bind(to_l)
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
        let title = match basis {
            ReportBasis::Completed => {
                if s.channel.trim() == "web" {
                    "Online order — recognized".to_string()
                } else if s.has_special {
                    "Completed — included order".to_string()
                } else {
                    "Completed (recognized)".to_string()
                }
            }
            ReportBasis::Booked => {
                if s.channel.trim() == "web" {
                    "Online order".to_string()
                } else if s.has_special {
                    "Sale — includes order".to_string()
                } else {
                    "Sale".to_string()
                }
            }
        };
        let sale_kind = if matches!(basis, ReportBasis::Completed) {
            "completed"
        } else {
            "sale"
        };
        let items: Option<Vec<ActivityItemDetail>> = s
            .items_json
            .and_then(|v| serde_json::from_value::<Vec<ActivityItemDetail>>(v).ok());

        activities.push(RegisterActivityItem {
            id: format!("{sale_kind}:{}", s.order_id),
            kind: sale_kind.to_string(),
            occurred_at: s.booked_at,
            title,
            subtitle: customer_label(
                s.party_name.as_deref(),
                s.customer_first.as_deref(),
                s.customer_last.as_deref(),
            ),
            order_id: Some(s.order_id),
            wedding_party_id: None,
            amount_label: Some(format!("${}", money_label(s.total_price))),
            payment_summary: s.pay,
            sales_total: Some(money_label(s.total_price)),
            tax_total: Some(money_label(s.tax_total)),
            is_takeaway: Some(s.is_takeaway),
            channel: Some(s.channel),
            wedding_party_name: s.party_name,
            items,
            stripe_fees_total: s.stripe_fees.map(|v| money_label(v)),
            net_amount: s.net_amount.map(|v| money_label(v)),
        });
    }

    for p in pickups {
        activities.push(RegisterActivityItem {
            id: format!("pickup:{}", p.order_id),
            kind: "pickup".to_string(),
            occurred_at: p.fulfilled_at,
            title: "Pickup / fulfilled".to_string(),
            subtitle: customer_label(
                p.party_name.as_deref(),
                p.customer_first.as_deref(),
                p.customer_last.as_deref(),
            ),
            order_id: Some(p.order_id),
            wedding_party_id: None,
            amount_label: Some(format!("${}", money_label(p.total_price))),
            payment_summary: None,
            sales_total: Some(money_label(p.total_price)),
            tax_total: None,
            is_takeaway: Some(false),
            channel: None,
            items: None,
            stripe_fees_total: None,
            net_amount: None,
            wedding_party_name: None,
        });
    }

    for w in weddings {
        activities.push(RegisterActivityItem {
            id: format!("wedding:{}", w.id),
            kind: "wedding_party".to_string(),
            occurred_at: w.created_at,
            title: "New wedding party".to_string(),
            subtitle: Some(w.party_name.clone()),
            order_id: None,
            wedding_party_id: Some(w.id),
            amount_label: None,
            payment_summary: None,
            sales_total: None,
            tax_total: None,
            is_takeaway: None,
            channel: None,
            items: None,
            stripe_fees_total: None,
            net_amount: None,
            wedding_party_name: None,
        });
    }

    for a in appts {
        activities.push(RegisterActivityItem {
            id: format!("appt:{}", a.id),
            kind: "appointment".to_string(),
            occurred_at: a.starts_at,
            title: "Appointment".to_string(),
            subtitle: a
                .party_name
                .filter(|s| !s.trim().is_empty())
                .or_else(|| a.notes.clone().filter(|s| !s.trim().is_empty())),
            order_id: None,
            wedding_party_id: None,
            amount_label: None,
            payment_summary: None,
            sales_total: None,
            tax_total: None,
            is_takeaway: None,
            channel: None,
            items: None,
            stripe_fees_total: None,
            net_amount: None,
            wedding_party_name: None,
        });
    }

    activities.sort_by(|x, y| y.occurred_at.cmp(&x.occurred_at));
    activities.truncate(200);

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
        new_wedding_parties_count,
        stripe_fees_total: money_label(stripe_fees),
        net_sales: money_label(subtotal + tax_total - stripe_fees),
        activities,
    })
}
