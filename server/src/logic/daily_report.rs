//! Daily Financial Report generation.
//!
//! Produces a comprehensive business-day financial summary covering sales, tenders,
//! inventory, tax, deposits, returns, gift cards, alterations, freight, and QBO status.
//! Output: structured JSON payload + rendered HTML email body.

use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::logic::register_day_activity::{self, RegisterDayActivityError};
use crate::logic::report_basis::ORDER_RECOGNITION_TS_SQL;

// ── Configuration ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyReportConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub recipient_emails: Vec<String>,
    #[serde(default = "default_subject_template")]
    pub subject_template: String,
    #[serde(default)]
    pub include_qbo_status: bool,
    #[serde(default = "default_true")]
    pub include_inventory_activity: bool,
    #[serde(default = "default_true")]
    pub auto_send_after_close: bool,
}

fn default_subject_template() -> String {
    "Riverside OS — Daily Financial Report — {date}".to_string()
}

fn default_true() -> bool {
    true
}

impl Default for DailyReportConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            recipient_emails: vec![],
            subject_template: default_subject_template(),
            include_qbo_status: true,
            include_inventory_activity: true,
            auto_send_after_close: true,
        }
    }
}

pub async fn load_config(pool: &PgPool) -> Result<DailyReportConfig, sqlx::Error> {
    let raw: serde_json::Value =
        sqlx::query_scalar("SELECT daily_report_config FROM store_settings WHERE id = 1")
            .fetch_one(pool)
            .await?;
    Ok(serde_json::from_value(raw).unwrap_or_default())
}

pub async fn save_config(pool: &PgPool, config: &DailyReportConfig) -> Result<(), sqlx::Error> {
    let val = serde_json::to_value(config)
        .map_err(|e| sqlx::Error::Protocol(format!("serialize daily_report_config: {e}")))?;
    sqlx::query("UPDATE store_settings SET daily_report_config = $1 WHERE id = 1")
        .bind(&val)
        .execute(pool)
        .await?;
    Ok(())
}

// ── Report Data ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DailyReport {
    pub report_date: NaiveDate,
    pub business_timezone: String,
    pub generated_at: String,

    // Canonical booked Daily Sales
    pub booked_sales: BookedSalesSummary,

    // Recognized revenue detail
    pub gross_sales: Decimal,
    pub net_sales: Decimal,
    pub transaction_count: i64,
    pub avg_transaction: Decimal,
    pub items_sold: i64,

    // Month-to-date booked net comparison
    pub month_to_date: MonthToDateComparison,

    // Store-day weather context
    pub weather: Option<ReportWeather>,

    // Returns
    pub return_count: i64,
    pub return_total: Decimal,

    // Tax
    pub tax_collected: Decimal,
    pub tax_state: Decimal,
    pub tax_local: Decimal,

    // Tenders
    pub tenders: Vec<TenderSummary>,
    pub total_tendered: Decimal,

    // Gift Cards
    pub gift_cards_sold: Decimal,
    pub gift_cards_sold_count: i64,
    pub gift_cards_redeemed: Decimal,

    // Deposits
    pub deposits_received: Decimal,
    pub deposits_released: Decimal,

    // Alterations
    pub alterations_income: Decimal,

    // Inventory
    pub units_received: i64,
    pub receiving_cost: Decimal,
    pub freight_cost: Decimal,

    // Discounts
    pub discount_total: Decimal,

    // Categories
    pub category_breakdown: Vec<CategorySummary>,

    // QBO
    pub qbo_journal_status: Option<String>,
    pub qbo_journal_balanced: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TenderSummary {
    pub method: String,
    pub total: Decimal,
    pub count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CategorySummary {
    pub name: String,
    pub net_sales: Decimal,
    pub cogs: Decimal,
    pub margin_pct: Decimal,
    pub units: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BookedSalesSummary {
    pub net_sales: Decimal,
    pub sales_count: i64,
    pub avg_sale: Decimal,
    pub tax_total: Decimal,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MonthToDateComparison {
    pub current_start: NaiveDate,
    pub current_end: NaiveDate,
    pub current_net_sales: Decimal,
    pub prior_year_start: NaiveDate,
    pub prior_year_end: NaiveDate,
    pub prior_year_net_sales: Decimal,
    pub change_amount: Decimal,
    pub change_percent: Option<Decimal>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReportWeather {
    pub condition: String,
    pub temp_high_f: f32,
    pub temp_low_f: f32,
    pub precipitation_inches: f32,
    pub source: String,
    pub captured_at: String,
    pub finalized: bool,
}

fn month_to_date_windows(date: NaiveDate) -> (NaiveDate, NaiveDate, NaiveDate, NaiveDate) {
    let current_start = NaiveDate::from_ymd_opt(date.year(), date.month(), 1)
        .expect("a valid date always has a valid first day of month");
    let prior_year = date.year() - 1;
    let prior_year_start = NaiveDate::from_ymd_opt(prior_year, date.month(), 1)
        .expect("a valid month always has a valid first day in the prior year");
    let prior_year_end = NaiveDate::from_ymd_opt(prior_year, date.month(), date.day())
        .unwrap_or_else(|| {
            let next_month_start = if date.month() == 12 {
                NaiveDate::from_ymd_opt(prior_year + 1, 1, 1)
            } else {
                NaiveDate::from_ymd_opt(prior_year, date.month() + 1, 1)
            }
            .expect("a valid month always has a valid following month");
            next_month_start - Duration::days(1)
        });

    (current_start, date, prior_year_start, prior_year_end)
}

fn build_month_to_date_comparison(
    current_start: NaiveDate,
    current_end: NaiveDate,
    current_net_sales: Decimal,
    prior_year_start: NaiveDate,
    prior_year_end: NaiveDate,
    prior_year_net_sales: Decimal,
) -> MonthToDateComparison {
    let change_amount = current_net_sales - prior_year_net_sales;
    let change_percent = if prior_year_net_sales.is_zero() {
        None
    } else {
        Some(((change_amount / prior_year_net_sales) * Decimal::from(100)).round_dp(1))
    };

    MonthToDateComparison {
        current_start,
        current_end,
        current_net_sales,
        prior_year_start,
        prior_year_end,
        prior_year_net_sales,
        change_amount,
        change_percent,
    }
}

fn is_visual_crossing_weather_source(source: &str) -> bool {
    source == "visual_crossing_final" || source.starts_with("visual_crossing:")
}

fn map_register_day_error(error: RegisterDayActivityError) -> sqlx::Error {
    match error {
        RegisterDayActivityError::Db(error) => error,
        other => sqlx::Error::Protocol(format!("booked Daily Sales summary: {other}")),
    }
}

async fn fetch_booked_sales_summary(
    pool: &PgPool,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<BookedSalesSummary, sqlx::Error> {
    let totals = register_day_activity::fetch_booked_sales_totals(pool, start, end)
        .await
        .map_err(map_register_day_error)?;

    Ok(BookedSalesSummary {
        net_sales: totals.net_sales,
        sales_count: totals.sales_count,
        avg_sale: totals.avg_sale,
        tax_total: totals.tax_total,
    })
}

// ── Generation ───────────────────────────────────────────────────────────────

pub async fn generate_report(
    pool: &PgPool,
    activity_date: NaiveDate,
) -> Result<DailyReport, sqlx::Error> {
    let order_recognition_ts = ORDER_RECOGNITION_TS_SQL.trim();
    let line_recognition_ts = format!("(COALESCE(({order_recognition_ts}), oi.fulfilled_at))");

    let business_timezone: String =
        sqlx::query_scalar("SELECT reporting.effective_store_timezone()")
            .fetch_one(pool)
            .await?;

    // ── Canonical booked Daily Sales ─────────────────────────────────────────
    let booked_sales = fetch_booked_sales_summary(pool, activity_date, activity_date).await?;

    // ── Sales summary ────────────────────────────────────────────────────────
    #[derive(sqlx::FromRow)]
    struct SalesSummary {
        gross_sales: Option<Decimal>,
        net_sales: Option<Decimal>,
        transaction_count: i64,
        items_sold: i64,
        discount_total: Option<Decimal>,
    }

    let sales: SalesSummary = sqlx::query_as(&format!(
        r#"
        WITH eligible_lines AS (
            SELECT
                o.id AS transaction_id,
                oi.unit_price,
                COALESCE(oi.discount_amount, 0) AS discount_amount,
                GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0)::numeric AS effective_qty,
                CASE
                    WHEN oi.size_specs ? 'original_unit_price'
                     AND NULLIF(TRIM(oi.size_specs->>'original_unit_price'), '') IS NOT NULL
                     AND TRIM(oi.size_specs->>'original_unit_price') ~ '^[0-9]+(\.[0-9]+)?$'
                    THEN (TRIM(oi.size_specs->>'original_unit_price'))::numeric
                    ELSE NULL
                END AS original_unit_price
            FROM transaction_lines oi
            INNER JOIN transactions o ON o.id = oi.transaction_id
            INNER JOIN products p ON p.id = oi.product_id
            LEFT JOIN product_variants pv ON pv.id = oi.variant_id
            LEFT JOIN (
                SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
                FROM transaction_return_lines GROUP BY transaction_line_id
            ) orl ON orl.transaction_line_id = oi.id
            WHERE o.is_forfeited = false
              AND o.status::text NOT IN ('cancelled')
              AND {line_recognition_ts} IS NOT NULL
              AND ({line_recognition_ts} AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
              AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
              AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
AND (p.pos_line_kind IS DISTINCT FROM 'staff_account_payment')
              AND UPPER(TRIM(COALESCE(pv.sku, ''))) NOT IN ('SHIPPING', 'ROS-SHIPPING-FEE')
        )
        SELECT
            COALESCE(SUM(
                (
                    (unit_price - discount_amount)
                    + discount_amount
                    + GREATEST(COALESCE(original_unit_price, unit_price) - unit_price, 0)
                ) * effective_qty
            ), 0)::numeric(14,2) AS gross_sales,
            COALESCE(SUM(((unit_price - discount_amount) * effective_qty)::numeric(14,2)), 0)::numeric(14,2) AS net_sales,
            COUNT(DISTINCT transaction_id)::bigint AS transaction_count,
            COALESCE(SUM(effective_qty), 0)::bigint AS items_sold,
            COALESCE(SUM((
                discount_amount
                + GREATEST(COALESCE(original_unit_price, unit_price) - unit_price, 0)
            ) * effective_qty), 0)::numeric(14,2) AS discount_total
        FROM eligible_lines
        "#
    ))
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    let gross = sales.gross_sales.unwrap_or(Decimal::ZERO);
    let net = sales.net_sales.unwrap_or(Decimal::ZERO);
    let avg_tx = if sales.transaction_count > 0 {
        (net / Decimal::from(sales.transaction_count)).round_dp(2)
    } else {
        Decimal::ZERO
    };

    // ── Month-to-date booked net comparison ─────────────────────────────────
    let (mtd_start, mtd_end, prior_mtd_start, prior_mtd_end) = month_to_date_windows(activity_date);
    let current_mtd = fetch_booked_sales_summary(pool, mtd_start, mtd_end).await?;
    let prior_mtd = fetch_booked_sales_summary(pool, prior_mtd_start, prior_mtd_end).await?;

    let month_to_date = build_month_to_date_comparison(
        mtd_start,
        mtd_end,
        current_mtd.net_sales,
        prior_mtd_start,
        prior_mtd_end,
        prior_mtd.net_sales,
    );

    // ── Tax ──────────────────────────────────────────────────────────────────
    #[derive(sqlx::FromRow)]
    struct TaxSummary {
        tax_state: Option<Decimal>,
        tax_local: Option<Decimal>,
    }

    let tax: TaxSummary = sqlx::query_as(&format!(
        r#"
        SELECT
            COALESCE(SUM((oi.state_tax * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14,2)), 0)::numeric(14,2) AS tax_state,
            COALESCE(SUM((oi.local_tax * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14,2)), 0)::numeric(14,2) AS tax_local
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        INNER JOIN products p ON p.id = oi.product_id
        LEFT JOIN product_variants pv ON pv.id = oi.variant_id
        LEFT JOIN (
            SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
            FROM transaction_return_lines GROUP BY transaction_line_id
        ) orl ON orl.transaction_line_id = oi.id
        WHERE o.is_forfeited = false
          AND o.status::text NOT IN ('cancelled')
          AND {line_recognition_ts} IS NOT NULL
          AND ({line_recognition_ts} AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
          AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
          AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
AND (p.pos_line_kind IS DISTINCT FROM 'staff_account_payment')
          AND UPPER(TRIM(COALESCE(pv.sku, ''))) NOT IN ('SHIPPING', 'ROS-SHIPPING-FEE')
        "#
    ))
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    let ts = tax.tax_state.unwrap_or(Decimal::ZERO);
    let tl = tax.tax_local.unwrap_or(Decimal::ZERO);

    // ── Returns ──────────────────────────────────────────────────────────────
    #[derive(sqlx::FromRow)]
    struct ReturnSummary {
        return_count: i64,
        return_total: Option<Decimal>,
    }

    let returns: ReturnSummary = sqlx::query_as(
        r#"
        SELECT
            COUNT(DISTINCT orl.id)::bigint AS return_count,
            COALESCE(SUM(COALESCE(
                orl.refund_total,
                (oi.unit_price + oi.state_tax + oi.local_tax) * orl.quantity_returned
            )), 0)::numeric(14,2) AS return_total
        FROM transaction_return_lines orl
        INNER JOIN transaction_lines oi ON oi.id = orl.transaction_line_id
        INNER JOIN transactions o ON o.id = oi.transaction_id
        WHERE o.status::text NOT IN ('cancelled')
          AND (orl.created_at AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
        "#,
    )
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    // ── Tenders ──────────────────────────────────────────────────────────────
    #[derive(sqlx::FromRow)]
    struct TenderRow {
        method: String,
        total: Option<Decimal>,
        count: i64,
    }

    let mut tender_rows: Vec<TenderRow> = sqlx::query_as(
        r#"
        SELECT
            CASE
                WHEN LOWER(TRIM(payment_method)) IN (
                    'card', 'cc', 'credit', 'credit_card', 'debit',
                    'card_terminal', 'card_reader', 'card_manual', 'card_not_present',
                    'card_saved', 'card_credit', 'offline_cc', 'card_terminal_manual'
                )
                THEN 'Credit/Debit Card'
                WHEN LOWER(TRIM(payment_method)) = 'cash' THEN 'Cash'
                WHEN LOWER(TRIM(payment_method)) = 'gift_card' THEN 'Gift Card'
                WHEN LOWER(TRIM(payment_method)) = 'store_credit' THEN 'Store Credit'
                WHEN LOWER(TRIM(payment_method)) = 'open_deposit' THEN 'Deposit Applied'
                WHEN LOWER(TRIM(payment_method)) IN ('check', 'cheque') THEN 'Check'
                WHEN LOWER(TRIM(payment_method)) = 'exchange_credit' THEN 'Exchange Credit'
                WHEN LOWER(TRIM(payment_method)) = 'staff_account_charge' THEN 'Staff Account'
                WHEN LOWER(TRIM(payment_method)) = 'donation' THEN 'Donation'
                WHEN LOWER(TRIM(payment_method)) IN ('on_account_rms90', 'rms90')
                     OR LOWER(COALESCE(metadata->>'program_code', '')) = 'rms90'
                THEN 'RMS Charge · 90 Day'
                WHEN LOWER(TRIM(payment_method)) IN ('on_account_rms', 'rms')
                     OR LOWER(COALESCE(metadata->>'tender_family', '')) = 'rms_charge'
                THEN 'RMS Charge · Standard'
                ELSE INITCAP(REPLACE(TRIM(payment_method), '_', ' '))
            END AS method,
            SUM(amount)::numeric(14,2) AS total,
            COUNT(*)::bigint AS count
        FROM payment_transactions
        WHERE COALESCE(effective_date, (created_at AT TIME ZONE reporting.effective_store_timezone())::date) = $1::date
        GROUP BY 1
        ORDER BY total DESC NULLS LAST
        "#,
    )
    .bind(activity_date)
    .fetch_all(pool)
    .await?;

    const SUPPORTED_TENDERS: &[&str] = &[
        "Credit/Debit Card",
        "Cash",
        "Check",
        "Gift Card",
        "Store Credit",
        "Deposit Applied",
        "Exchange Credit",
        "RMS Charge · Standard",
        "RMS Charge · 90 Day",
        "Staff Account",
        "Donation",
    ];
    for method in SUPPORTED_TENDERS {
        if !tender_rows.iter().any(|row| row.method.as_str() == *method) {
            tender_rows.push(TenderRow {
                method: (*method).to_string(),
                total: Some(Decimal::ZERO),
                count: 0,
            });
        }
    }
    tender_rows.sort_by_key(|row| {
        SUPPORTED_TENDERS
            .iter()
            .position(|method| *method == row.method.as_str())
            .unwrap_or(usize::MAX)
    });

    let total_tendered: Decimal = tender_rows
        .iter()
        .map(|r| r.total.unwrap_or(Decimal::ZERO))
        .sum();

    // ── Gift Cards ───────────────────────────────────────────────────────────
    #[derive(sqlx::FromRow)]
    struct GcLoad {
        total: Option<Decimal>,
        count: i64,
    }

    let gc_load: GcLoad = sqlx::query_as(
        r#"
        SELECT
            COALESCE(SUM((oi.unit_price * oi.quantity)::numeric(14,2)), 0)::numeric(14,2) AS total,
            COUNT(*)::bigint AS count
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        INNER JOIN products p ON p.id = oi.product_id
        WHERE o.status::text <> 'cancelled'
          AND p.pos_line_kind = 'pos_gift_card_load'
          AND COALESCE(o.business_date, (o.booked_at AT TIME ZONE reporting.effective_store_timezone())::date) = $1::date
        "#,
    )
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    let gc_redeemed: Decimal = tender_rows
        .iter()
        .filter(|r| r.method == "Gift Card")
        .map(|r| r.total.unwrap_or(Decimal::ZERO))
        .sum();

    // ── Deposits ─────────────────────────────────────────────────────────────
    let deposits_received: Decimal = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM((pa.metadata->>'applied_deposit_amount')::numeric(14,2)), 0)::numeric(14,2)
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        WHERE COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) = $1::date
          AND pa.amount_allocated > 0
          AND NULLIF(TRIM(pa.metadata->>'applied_deposit_amount'), '') IS NOT NULL
        "#,
    )
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    let deposits_released: Decimal = sqlx::query_scalar(&format!(
        r#"
        SELECT COALESCE(SUM((pa.metadata->>'applied_deposit_amount')::numeric(14,2)), 0)::numeric(14,2)
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        INNER JOIN transactions o ON o.id = pa.target_transaction_id
        WHERE COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) < $1::date
          AND ({order_recognition_ts}) IS NOT NULL
          AND (({order_recognition_ts}) AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
          AND o.status::text NOT IN ('cancelled')
        "#
    ))
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    // ── Alterations ──────────────────────────────────────────────────────────
    let alterations_income: Decimal = sqlx::query_scalar(&format!(
        r#"
        SELECT COALESCE(SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14,2)), 0)::numeric(14,2)
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        INNER JOIN products p ON p.id = oi.product_id
        LEFT JOIN (
            SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
            FROM transaction_return_lines GROUP BY transaction_line_id
        ) orl ON orl.transaction_line_id = oi.id
        WHERE o.status::text NOT IN ('cancelled')
          AND {line_recognition_ts} IS NOT NULL
          AND ({line_recognition_ts} AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
          AND (
              p.pos_line_kind IN ('alteration_service', 'alteration_fee')
              OR oi.custom_item_type IN ('alteration_service', 'alteration_fee')
          )
          AND oi.unit_price > 0
        "#
    ))
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    // ── Inventory Receiving ──────────────────────────────────────────────────
    #[derive(sqlx::FromRow)]
    struct InvRecv {
        units: i64,
        cost: Option<Decimal>,
        freight: Option<Decimal>,
    }

    let inv_recv: InvRecv = sqlx::query_as(
        r#"
        SELECT
            COALESCE(SUM(it.quantity_delta), 0)::bigint AS units,
            COALESCE(SUM((it.unit_cost * it.quantity_delta)::numeric(14,2)), 0)::numeric(14,2) AS cost,
            COALESCE(SUM(re.freight_total), 0)::numeric(14,2) AS freight
        FROM receiving_events re
        LEFT JOIN inventory_transactions it
            ON it.reference_table = 'receiving_events'
           AND it.reference_id = re.id
        WHERE (re.received_at AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
        "#,
    )
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    // ── Category Breakdown ───────────────────────────────────────────────────
    #[derive(sqlx::FromRow)]
    struct CatRow {
        name: Option<String>,
        net_sales: Option<Decimal>,
        cogs: Option<Decimal>,
        units: i64,
    }

    let cat_rows: Vec<CatRow> = sqlx::query_as(&format!(
        r#"
        SELECT
            COALESCE(c.name, 'Uncategorized') AS name,
            SUM(((oi.unit_price - COALESCE(oi.discount_amount, 0)) * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14,2))::numeric(14,2) AS net_sales,
            SUM((oi.unit_cost * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14,2))::numeric(14,2) AS cogs,
            SUM(GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::bigint AS units
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        INNER JOIN products p ON p.id = oi.product_id
        LEFT JOIN product_variants pv ON pv.id = oi.variant_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN (
            SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
            FROM transaction_return_lines GROUP BY transaction_line_id
        ) orl ON orl.transaction_line_id = oi.id
        WHERE o.is_forfeited = false
          AND o.status::text NOT IN ('cancelled')
          AND {line_recognition_ts} IS NOT NULL
          AND ({line_recognition_ts} AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
          AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
          AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
AND (p.pos_line_kind IS DISTINCT FROM 'staff_account_payment')
          AND UPPER(TRIM(COALESCE(pv.sku, ''))) NOT IN ('SHIPPING', 'ROS-SHIPPING-FEE')
        GROUP BY c.name
        ORDER BY net_sales DESC NULLS LAST
        "#
    ))
    .bind(activity_date)
    .fetch_all(pool)
    .await?;

    // ── QBO Status ───────────────────────────────────────────────────────────
    #[derive(sqlx::FromRow)]
    struct QboRow {
        status: String,
        balanced: Option<bool>,
    }

    let qbo: Option<QboRow> = sqlx::query_as(
        r#"
        SELECT
            status,
            (payload->'totals'->>'balanced')::boolean AS balanced
        FROM qbo_sync_logs
        WHERE sync_date = $1
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(activity_date)
    .fetch_optional(pool)
    .await?;

    // ── Store-day weather ────────────────────────────────────────────────────
    #[derive(sqlx::FromRow)]
    struct StoredWeatherRow {
        snapshot: sqlx::types::Json<crate::logic::weather::DailyWeatherContext>,
        source: String,
        captured_at: DateTime<Utc>,
        finalized_at: Option<DateTime<Utc>>,
    }

    let stored_weather: Option<StoredWeatherRow> = sqlx::query_as(
        r#"
        SELECT snapshot, source, captured_at, finalized_at
        FROM store_daily_weather
        WHERE weather_date = $1::date
        "#,
    )
    .bind(activity_date)
    .fetch_optional(pool)
    .await?;

    let weather = stored_weather.and_then(|row| {
        if !is_visual_crossing_weather_source(&row.source) {
            return None;
        }
        let snapshot = row.snapshot.0;
        Some(ReportWeather {
            condition: snapshot.condition,
            temp_high_f: snapshot.temp_high,
            temp_low_f: snapshot.temp_low,
            precipitation_inches: snapshot.precipitation_inches,
            source: row.source,
            captured_at: row.captured_at.to_rfc3339(),
            finalized: row.finalized_at.is_some(),
        })
    });

    let report = DailyReport {
        report_date: activity_date,
        business_timezone: business_timezone.clone(),
        generated_at: Utc::now().to_rfc3339(),
        booked_sales,
        gross_sales: gross,
        net_sales: net,
        transaction_count: sales.transaction_count,
        avg_transaction: avg_tx,
        items_sold: sales.items_sold,
        month_to_date,
        weather,
        return_count: returns.return_count,
        return_total: returns.return_total.unwrap_or(Decimal::ZERO),
        tax_collected: ts + tl,
        tax_state: ts,
        tax_local: tl,
        tenders: tender_rows
            .iter()
            .map(|r| TenderSummary {
                method: r.method.clone(),
                total: r.total.unwrap_or(Decimal::ZERO),
                count: r.count,
            })
            .collect(),
        total_tendered,
        gift_cards_sold: gc_load.total.unwrap_or(Decimal::ZERO),
        gift_cards_sold_count: gc_load.count,
        gift_cards_redeemed: gc_redeemed,
        deposits_received,
        deposits_released,
        alterations_income,
        units_received: inv_recv.units,
        receiving_cost: inv_recv.cost.unwrap_or(Decimal::ZERO),
        freight_cost: inv_recv.freight.unwrap_or(Decimal::ZERO),
        discount_total: sales.discount_total.unwrap_or(Decimal::ZERO),
        category_breakdown: cat_rows
            .iter()
            .map(|r| {
                let n = r.net_sales.unwrap_or(Decimal::ZERO);
                let c = r.cogs.unwrap_or(Decimal::ZERO);
                let margin = if n > Decimal::ZERO {
                    (((n - c) / n) * Decimal::from(100)).round_dp(1)
                } else {
                    Decimal::ZERO
                };
                CategorySummary {
                    name: r
                        .name
                        .clone()
                        .unwrap_or_else(|| "Uncategorized".to_string()),
                    net_sales: n,
                    cogs: c,
                    margin_pct: margin,
                    units: r.units,
                }
            })
            .collect(),
        qbo_journal_status: qbo.as_ref().map(|q| q.status.clone()),
        qbo_journal_balanced: qbo.as_ref().and_then(|q| q.balanced),
    };

    Ok(report)
}

// ── HTML Rendering ───────────────────────────────────────────────────────────

fn money(v: Decimal) -> String {
    format!("${:.2}", v)
}

fn pct(v: Decimal) -> String {
    format!("{:.1}%", v)
}

fn signed_money(v: Decimal) -> String {
    if v > Decimal::ZERO {
        format!("+${:.2}", v)
    } else if v < Decimal::ZERO {
        format!("-${:.2}", -v)
    } else {
        "$0.00".to_string()
    }
}

fn signed_pct(v: Decimal) -> String {
    if v > Decimal::ZERO {
        format!("+{:.1}%", v)
    } else {
        format!("{:.1}%", v)
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub fn render_html(report: &DailyReport, store_name: &str) -> String {
    let tender_rows: String = report
        .tenders
        .iter()
        .map(|t| {
            format!(
                r#"<tr><td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;font-size:13px">{}</td>
                <td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:right;font-family:monospace">{}</td>
                <td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:center;color:#6b7280">{}</td></tr>"#,
                t.method,
                money(t.total),
                t.count
            )
        })
        .collect();

    let cat_rows: String = report
        .category_breakdown
        .iter()
        .map(|c| {
            format!(
                r#"<tr><td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;font-size:13px;font-weight:600">{}</td>
                <td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:right;font-family:monospace">{}</td>
                <td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:right;font-family:monospace">{}</td>
                <td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:right;font-weight:600;color:{}">{}</td>
                <td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:center">{}</td></tr>"#,
                c.name,
                money(c.net_sales),
                money(c.cogs),
                if c.margin_pct >= Decimal::from(50) { "#059669" } else if c.margin_pct >= Decimal::from(30) { "#d97706" } else { "#dc2626" },
                pct(c.margin_pct),
                c.units
            )
        })
        .collect();

    let qbo_badge = match (&report.qbo_journal_status, report.qbo_journal_balanced) {
        (Some(s), Some(true)) if s == "synced" => {
            r#"<span style="background:#d1fae5;color:#065f46;padding:4px 12px;border-radius:12px;font-size:11px;font-weight:700">✓ Synced to QuickBooks</span>"#
        }
        (Some(s), Some(true)) if s == "approved" => {
            r#"<span style="background:#dbeafe;color:#1e40af;padding:4px 12px;border-radius:12px;font-size:11px;font-weight:700">Approved — Pending Sync</span>"#
        }
        (Some(s), _) if s == "pending" => {
            r#"<span style="background:#fef3c7;color:#92400e;padding:4px 12px;border-radius:12px;font-size:11px;font-weight:700">⏳ Pending Review</span>"#
        }
        (Some(s), _) if s == "failed" => {
            r#"<span style="background:#fee2e2;color:#991b1b;padding:4px 12px;border-radius:12px;font-size:11px;font-weight:700">✗ Posting Failed</span>"#
        }
        _ => {
            r#"<span style="background:#f3f4f6;color:#6b7280;padding:4px 12px;border-radius:12px;font-size:11px;font-weight:700">Not Staged</span>"#
        }
    };

    let inventory_section = if report.units_received > 0 || report.freight_cost > Decimal::ZERO {
        format!(
            r#"
            <div style="margin-bottom:24px">
                <h3 style="font-size:14px;font-weight:700;color:#111827;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">Inventory Receiving</h3>
                <table style="width:100%;border-collapse:collapse">
                    <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Units Received</td><td style="padding:6px 0;text-align:right;font-size:13px;font-weight:700">{}</td></tr>
                    <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Merchandise Cost</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700">{}</td></tr>
                    <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Freight / Shipping</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700;color:#d97706">{}</td></tr>
                </table>
            </div>"#,
            report.units_received,
            money(report.receiving_cost),
            money(report.freight_cost)
        )
    } else {
        String::new()
    };

    let mtd_change_positive = report.month_to_date.change_amount >= Decimal::ZERO;
    let mtd_change_color = if mtd_change_positive {
        "#15803d"
    } else {
        "#b91c1c"
    };
    let mtd_change_background = if mtd_change_positive {
        "#f0fdf4"
    } else {
        "#fef2f2"
    };
    let mtd_change_amount = signed_money(report.month_to_date.change_amount);
    let mtd_change_percent = report
        .month_to_date
        .change_percent
        .map(signed_pct)
        .unwrap_or_else(|| "N/A".to_string());
    let mtd_percent_color = if report.month_to_date.change_percent.is_none() {
        "#475569"
    } else {
        mtd_change_color
    };
    let mtd_change_summary = format!("{mtd_change_amount} ({mtd_change_percent})");
    let booked_total_with_tax = report.booked_sales.net_sales + report.booked_sales.tax_total;

    let weather_section = match &report.weather {
        Some(weather) => {
            let status = if weather.finalized {
                "Final Visual Crossing historical observation"
            } else {
                "Visual Crossing snapshot captured at Register close"
            };
            format!(
                r#"<div style="margin-bottom:24px">
                    <h3 style="font-size:14px;font-weight:700;color:#111827;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">Business Day Weather</h3>
                    <table style="width:100%;border-collapse:collapse">
                        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Conditions</td><td style="padding:6px 0;text-align:right;font-size:13px;font-weight:700">{}</td></tr>
                        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">High / Low</td><td style="padding:6px 0;text-align:right;font-size:13px;font-weight:700">{:.0}°F / {:.0}°F</td></tr>
                        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Precipitation</td><td style="padding:6px 0;text-align:right;font-size:13px;font-weight:700">{:.2} in</td></tr>
                    </table>
                    <p style="margin:8px 0 0;font-size:10px;color:#64748b">{} · Captured {}</p>
                </div>"#,
                escape_html(&weather.condition),
                weather.temp_high_f,
                weather.temp_low_f,
                weather.precipitation_inches,
                status,
                escape_html(&weather.captured_at),
            )
        }
        None => r#"<div style="margin-bottom:24px">
                <h3 style="font-size:14px;font-weight:700;color:#111827;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">Business Day Weather</h3>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;font-size:12px;color:#475569">
                    Actual weather data was unavailable for this business date. Simulated weather is not included in financial reports.
                </div>
            </div>"#
            .to_string(),
    };

    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:680px;margin:0 auto;padding:24px">

<!-- Header -->
<div style="background:linear-gradient(135deg,#1e293b,#334155);border-radius:16px 16px 0 0;padding:32px 32px 24px;text-align:center">
    <h1 style="margin:0 0 4px;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.02em">{store_name}</h1>
    <p style="margin:0 0 16px;font-size:13px;color:#94a3b8">Daily Financial Report</p>
    <div style="background:rgba(255,255,255,0.12);border-radius:12px;display:inline-block;padding:8px 24px">
        <span style="font-size:18px;font-weight:800;color:#ffffff">{date}</span>
        <span style="font-size:11px;color:#cbd5e1;margin-left:8px">{tz}</span>
    </div>
</div>

<!-- Key Metrics -->
<div style="background:#ffffff;padding:28px 32px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb">
    <div style="margin-bottom:20px;border:1px solid #bfdbfe;background:#eff6ff;border-radius:10px;padding:12px 14px;color:#1e3a8a;font-size:12px;line-height:1.5">
        Headline cards and month-to-date comparisons use <strong>booked Daily Sales</strong>, matching the ROS Today’s Sales and Register report. Recognized Revenue uses fulfillment / recognition date. Payment Methods and Total Tendered use the actual payment processing date. These sections are separate ledgers and are not expected to equal each other.
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:16px;margin-bottom:24px">
        <div style="flex:1;min-width:140px;background:#f0fdf4;border-radius:12px;padding:16px;text-align:center">
            <p style="margin:0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#16a34a">Booked Net Sales</p>
            <p style="margin:4px 0 0;font-size:24px;font-weight:800;color:#15803d;font-family:monospace">{booked_net_sales}</p>
        </div>
        <div style="flex:1;min-width:140px;background:#eff6ff;border-radius:12px;padding:16px;text-align:center">
            <p style="margin:0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#2563eb">Booked Sales</p>
            <p style="margin:4px 0 0;font-size:24px;font-weight:800;color:#1d4ed8">{booked_sales_count}</p>
        </div>
        <div style="flex:1;min-width:140px;background:#faf5ff;border-radius:12px;padding:16px;text-align:center">
            <p style="margin:0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#7c3aed">Avg Booked Sale</p>
            <p style="margin:4px 0 0;font-size:24px;font-weight:800;color:#6d28d9;font-family:monospace">{booked_avg_sale}</p>
        </div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:16px;margin-bottom:24px">
        <div style="flex:1;min-width:140px;background:#fff7ed;border-radius:12px;padding:16px;text-align:center">
            <p style="margin:0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#c2410c">MTD Booked Net</p>
            <p style="margin:4px 0 0;font-size:24px;font-weight:800;color:#9a3412;font-family:monospace">{mtd_net_sales}</p>
        </div>
        <div style="flex:1;min-width:140px;background:#eff6ff;border-radius:12px;padding:16px;text-align:center">
            <p style="margin:0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#2563eb">Last Year MTD</p>
            <p style="margin:4px 0 0;font-size:24px;font-weight:800;color:#1d4ed8;font-family:monospace">{mtd_prior_net_sales}</p>
        </div>
        <div style="flex:1;min-width:140px;background:{mtd_change_background};border-radius:12px;padding:16px;text-align:center">
            <p style="margin:0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:{mtd_change_color}">MTD vs Last Year</p>
            <p style="margin:4px 0 0;font-size:20px;font-weight:800;color:{mtd_change_color};font-family:monospace">{mtd_change_summary}</p>
        </div>
    </div>

    <!-- Booked Sales Detail -->
    <div style="margin-bottom:24px">
        <h3 style="font-size:14px;font-weight:700;color:#111827;margin:0 0 4px;text-transform:uppercase;letter-spacing:0.05em">Booked Sales Summary</h3>
        <p style="margin:0 0 12px;font-size:11px;color:#64748b">Canonical booking-event totals matching ROS Daily Sales for this business date.</p>
        <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Booked Net Sales</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700">{booked_net_sales}</td></tr>
            <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Booked Tax</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700">{booked_tax_total}</td></tr>
            <tr style="border-top:2px solid #111827"><td style="padding:8px 0;font-size:14px;font-weight:800;color:#111827">Booked Total With Tax</td><td style="padding:8px 0;text-align:right;font-size:14px;font-family:monospace;font-weight:800;color:#15803d">{booked_total_with_tax}</td></tr>
            <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Booked Sales</td><td style="padding:6px 0;text-align:right;font-size:13px;font-weight:700">{booked_sales_count}</td></tr>
            <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Average Booked Sale</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700">{booked_avg_sale}</td></tr>
        </table>
    </div>

    <!-- Recognized Revenue Detail -->
    <div style="margin-bottom:24px">
        <h3 style="font-size:14px;font-weight:700;color:#111827;margin:0 0 4px;text-transform:uppercase;letter-spacing:0.05em">Recognized Revenue Detail</h3>
        <p style="margin:0 0 12px;font-size:11px;color:#64748b">Fulfilled revenue shown separately from booked Daily Sales.</p>
        <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Recognized Gross Sales</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700">{gross_sales}</td></tr>
            <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Discounts</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;color:#dc2626">-{discount}</td></tr>
            <tr style="border-top:2px solid #111827"><td style="padding:8px 0;font-size:14px;font-weight:800;color:#111827">Recognized Net Sales</td><td style="padding:8px 0;text-align:right;font-size:14px;font-family:monospace;font-weight:800;color:#15803d">{net_sales}</td></tr>
            <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Items Sold</td><td style="padding:6px 0;text-align:right;font-size:13px;font-weight:700">{items_sold}</td></tr>
        </table>
    </div>

    <!-- Month-to-Date Comparison -->
    <div style="margin-bottom:24px">
        <h3 style="font-size:14px;font-weight:700;color:#111827;margin:0 0 4px;text-transform:uppercase;letter-spacing:0.05em">Month-to-Date Net Comparison</h3>
        <p style="margin:0 0 12px;font-size:11px;color:#64748b">Pre-tax booked net sales using the same canonical booking-event basis as ROS Daily Sales.</p>
        <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Current MTD ({mtd_current_start} through {mtd_current_end})</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700">{mtd_net_sales}</td></tr>
            <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Same period last year ({mtd_prior_start} through {mtd_prior_end})</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700">{mtd_prior_net_sales}</td></tr>
            <tr style="border-top:1px solid #e5e7eb"><td style="padding:6px 0;font-size:13px;font-weight:700">Dollar Change</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:800;color:{mtd_change_color}">{mtd_change_amount}</td></tr>
            <tr><td style="padding:6px 0;font-size:13px;font-weight:700">Percentage Change</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:800;color:{mtd_percent_color}">{mtd_change_percent}</td></tr>
        </table>
    </div>

    <!-- Weather -->
    {weather_section}

    <!-- Tax -->
    <div style="margin-bottom:24px">
        <h3 style="font-size:14px;font-weight:700;color:#111827;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">Recognized Tax</h3>
        <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">State Tax</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace">{tax_state}</td></tr>
            <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Local Tax</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace">{tax_local}</td></tr>
            <tr style="border-top:1px solid #e5e7eb"><td style="padding:6px 0;font-size:13px;font-weight:700">Total Tax</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700">{tax_total}</td></tr>
        </table>
    </div>

    <!-- Returns -->
    {returns_section}

    <!-- Tenders -->
    <div style="margin-bottom:24px">
        <h3 style="font-size:14px;font-weight:700;color:#111827;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">Payment Methods — Processing Date</h3>
        <table style="width:100%;border-collapse:collapse">
            <thead><tr style="background:#f9fafb">
                <th style="padding:8px 16px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;font-weight:700">Method</th>
                <th style="padding:8px 16px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;font-weight:700">Amount</th>
                <th style="padding:8px 16px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;font-weight:700">Count</th>
            </tr></thead>
            <tbody>{tender_rows}</tbody>
            <tfoot><tr style="border-top:2px solid #111827">
                <td style="padding:10px 16px;font-size:13px;font-weight:800">Total Tendered</td>
                <td style="padding:10px 16px;text-align:right;font-size:14px;font-family:monospace;font-weight:800">{total_tendered}</td>
                <td></td>
            </tr></tfoot>
        </table>
    </div>

    <!-- Gift Cards & Deposits -->
    {gc_section}
    {deposit_section}
    {alterations_section}

    <!-- Inventory -->
    {inventory_section}

    <!-- Category Breakdown -->
    {cat_section}

    <!-- QBO -->
    <div style="margin-bottom:16px;text-align:center">
        <h3 style="font-size:14px;font-weight:700;color:#111827;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">QuickBooks Status</h3>
        {qbo_badge}
    </div>
</div>

<!-- Footer -->
<div style="background:#1e293b;border-radius:0 0 16px 16px;padding:20px 32px;text-align:center">
    <p style="margin:0;font-size:11px;color:#94a3b8">Generated by Riverside OS · {generated_at}</p>
    <p style="margin:4px 0 0;font-size:10px;color:#64748b">This is an automated daily financial report. Do not reply to this email.</p>
</div>

</div>
</body>
</html>"#,
        store_name = store_name,
        date = report.report_date,
        tz = report.business_timezone,
        booked_net_sales = money(report.booked_sales.net_sales),
        booked_sales_count = report.booked_sales.sales_count,
        booked_avg_sale = money(report.booked_sales.avg_sale),
        booked_tax_total = money(report.booked_sales.tax_total),
        booked_total_with_tax = money(booked_total_with_tax),
        net_sales = money(report.net_sales),
        mtd_net_sales = money(report.month_to_date.current_net_sales),
        mtd_prior_net_sales = money(report.month_to_date.prior_year_net_sales),
        mtd_change_summary = mtd_change_summary,
        mtd_change_color = mtd_change_color,
        mtd_change_background = mtd_change_background,
        mtd_change_amount = mtd_change_amount,
        mtd_change_percent = mtd_change_percent,
        mtd_percent_color = mtd_percent_color,
        mtd_current_start = report.month_to_date.current_start,
        mtd_current_end = report.month_to_date.current_end,
        mtd_prior_start = report.month_to_date.prior_year_start,
        mtd_prior_end = report.month_to_date.prior_year_end,
        gross_sales = money(report.gross_sales),
        discount = money(report.discount_total),
        items_sold = report.items_sold,
        tax_state = money(report.tax_state),
        tax_local = money(report.tax_local),
        tax_total = money(report.tax_collected),
        returns_section = if report.return_count > 0 {
            format!(
                r#"<div style="margin-bottom:24px">
                    <h3 style="font-size:14px;font-weight:700;color:#111827;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">Returns</h3>
                    <table style="width:100%;border-collapse:collapse">
                        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Return Lines</td><td style="padding:6px 0;text-align:right;font-size:13px;font-weight:700">{}</td></tr>
                        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Return Value</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700;color:#dc2626">{}</td></tr>
                    </table>
                </div>"#,
                report.return_count,
                money(report.return_total)
            )
        } else {
            String::new()
        },
        tender_rows = tender_rows,
        total_tendered = money(report.total_tendered),
        gc_section = if report.gift_cards_sold > Decimal::ZERO
            || report.gift_cards_redeemed > Decimal::ZERO
        {
            format!(
                r#"<div style="margin-bottom:24px">
                    <h3 style="font-size:14px;font-weight:700;color:#111827;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">Gift Cards</h3>
                    <table style="width:100%;border-collapse:collapse">
                        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Sold ({} cards)</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700">{}</td></tr>
                        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Redeemed</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700">{}</td></tr>
                    </table>
                </div>"#,
                report.gift_cards_sold_count,
                money(report.gift_cards_sold),
                money(report.gift_cards_redeemed)
            )
        } else {
            String::new()
        },
        deposit_section = if report.deposits_received > Decimal::ZERO
            || report.deposits_released > Decimal::ZERO
        {
            format!(
                r#"<div style="margin-bottom:24px">
                    <h3 style="font-size:14px;font-weight:700;color:#111827;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">Deposits</h3>
                    <table style="width:100%;border-collapse:collapse">
                        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Received Today</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700">{}</td></tr>
                        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Released (Fulfilled)</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700">{}</td></tr>
                    </table>
                </div>"#,
                money(report.deposits_received),
                money(report.deposits_released)
            )
        } else {
            String::new()
        },
        alterations_section = if report.alterations_income > Decimal::ZERO {
            format!(
                r#"<div style="margin-bottom:24px">
                    <h3 style="font-size:14px;font-weight:700;color:#111827;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">Alterations</h3>
                    <table style="width:100%;border-collapse:collapse">
                        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280">Service Income</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:monospace;font-weight:700">{}</td></tr>
                    </table>
                </div>"#,
                money(report.alterations_income)
            )
        } else {
            String::new()
        },
        weather_section = weather_section,
        inventory_section = inventory_section,
        cat_section = if !report.category_breakdown.is_empty() {
            format!(
                r#"<div style="margin-bottom:24px">
                    <h3 style="font-size:14px;font-weight:700;color:#111827;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">Recognized Sales by Category</h3>
                    <table style="width:100%;border-collapse:collapse">
                        <thead><tr style="background:#f9fafb">
                            <th style="padding:8px 16px;text-align:left;font-size:10px;text-transform:uppercase;color:#6b7280;font-weight:700">Category</th>
                            <th style="padding:8px 16px;text-align:right;font-size:10px;text-transform:uppercase;color:#6b7280;font-weight:700">Recognized Net</th>
                            <th style="padding:8px 16px;text-align:right;font-size:10px;text-transform:uppercase;color:#6b7280;font-weight:700">COGS</th>
                            <th style="padding:8px 16px;text-align:right;font-size:10px;text-transform:uppercase;color:#6b7280;font-weight:700">Margin</th>
                            <th style="padding:8px 16px;text-align:center;font-size:10px;text-transform:uppercase;color:#6b7280;font-weight:700">Units</th>
                        </tr></thead>
                        <tbody>{cat_rows}</tbody>
                    </table>
                </div>"#,
                cat_rows = cat_rows
            )
        } else {
            String::new()
        },
        qbo_badge = qbo_badge,
        generated_at = report.generated_at,
    )
}

// ── Storage ──────────────────────────────────────────────────────────────────

pub async fn store_report(
    pool: &PgPool,
    report: &DailyReport,
    html: &str,
    staff_id: Option<Uuid>,
    is_test: bool,
) -> Result<Uuid, sqlx::Error> {
    let payload = serde_json::to_value(report)
        .map_err(|e| sqlx::Error::Protocol(format!("serialize report: {e}")))?;
    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO daily_financial_reports (report_date, generated_by, report_payload, html_content, is_test)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (report_date) WHERE is_test = false
        DO UPDATE SET
            generated_at = CURRENT_TIMESTAMP,
            generated_by = EXCLUDED.generated_by,
            report_payload = EXCLUDED.report_payload,
            html_content = EXCLUDED.html_content,
            updated_at = CURRENT_TIMESTAMP
        WHERE daily_financial_reports.sent_at IS NULL
           OR daily_financial_reports.send_error IS NOT NULL
        RETURNING id
        "#,
    )
    .bind(report.report_date)
    .bind(staff_id)
    .bind(&payload)
    .bind(html)
    .bind(is_test)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn record_delivery_result(
    pool: &PgPool,
    report_id: Uuid,
    recipients: &[String],
    error: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE daily_financial_reports
        SET sent_at = CASE
                WHEN sent_at IS NOT NULL THEN sent_at
                WHEN $3::text IS NULL THEN CURRENT_TIMESTAMP
                ELSE NULL
            END,
            sent_to = ARRAY(
                SELECT DISTINCT recipient
                FROM unnest(COALESCE(sent_to, ARRAY[]::text[]) || $2::text[]) AS recipient
                ORDER BY recipient
            ),
            send_error = $3,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        "#,
    )
    .bind(report_id)
    .bind(recipients)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn date(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).expect("valid test date")
    }

    fn sample_report(weather: Option<ReportWeather>) -> DailyReport {
        DailyReport {
            report_date: date(2026, 8, 7),
            business_timezone: "America/New_York".to_string(),
            generated_at: "2026-08-08T00:00:00Z".to_string(),
            booked_sales: BookedSalesSummary {
                net_sales: dec!(9427.95),
                sales_count: 31,
                avg_sale: dec!(304.13),
                tax_total: dec!(727.65),
            },
            gross_sales: dec!(1500.00),
            net_sales: dec!(1200.00),
            transaction_count: 6,
            avg_transaction: dec!(200.00),
            items_sold: 10,
            month_to_date: build_month_to_date_comparison(
                date(2026, 8, 1),
                date(2026, 8, 7),
                dec!(12000.00),
                date(2025, 8, 1),
                date(2025, 8, 7),
                dec!(10000.00),
            ),
            weather,
            return_count: 0,
            return_total: Decimal::ZERO,
            tax_collected: dec!(105.00),
            tax_state: dec!(60.00),
            tax_local: dec!(45.00),
            tenders: vec![],
            total_tendered: dec!(1305.00),
            gift_cards_sold: Decimal::ZERO,
            gift_cards_sold_count: 0,
            gift_cards_redeemed: Decimal::ZERO,
            deposits_received: Decimal::ZERO,
            deposits_released: Decimal::ZERO,
            alterations_income: Decimal::ZERO,
            units_received: 0,
            receiving_cost: Decimal::ZERO,
            freight_cost: Decimal::ZERO,
            discount_total: dec!(300.00),
            category_breakdown: vec![],
            qbo_journal_status: None,
            qbo_journal_balanced: None,
        }
    }

    #[tokio::test]
    async fn daily_report_query_executes_against_migrated_database() {
        let Ok(database_url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let pool = sqlx::PgPool::connect(&database_url)
            .await
            .expect("connect migrated test database");
        let report = generate_report(&pool, date(2026, 8, 8))
            .await
            .expect("daily financial report SQL should execute");
        let html = render_html(&report, "Riverside Men's Shop");

        assert!(html.contains("Booked Net Sales"));
        assert!(html.contains("Month-to-Date Net Comparison"));
        assert!(html.contains("Business Day Weather"));
    }

    #[test]
    fn month_to_date_windows_compare_the_same_calendar_days() {
        assert_eq!(
            month_to_date_windows(date(2026, 8, 7)),
            (
                date(2026, 8, 1),
                date(2026, 8, 7),
                date(2025, 8, 1),
                date(2025, 8, 7),
            )
        );
        assert_eq!(
            month_to_date_windows(date(2024, 2, 29)),
            (
                date(2024, 2, 1),
                date(2024, 2, 29),
                date(2023, 2, 1),
                date(2023, 2, 28),
            )
        );
    }

    #[test]
    fn month_to_date_change_uses_net_values_and_handles_no_baseline() {
        let comparison = build_month_to_date_comparison(
            date(2026, 8, 1),
            date(2026, 8, 7),
            dec!(1200.00),
            date(2025, 8, 1),
            date(2025, 8, 7),
            dec!(1000.00),
        );
        assert_eq!(comparison.change_amount, dec!(200.00));
        assert_eq!(comparison.change_percent, Some(dec!(20.0)));

        let no_baseline = build_month_to_date_comparison(
            date(2026, 8, 1),
            date(2026, 8, 7),
            dec!(1200.00),
            date(2025, 8, 1),
            date(2025, 8, 7),
            Decimal::ZERO,
        );
        assert_eq!(no_baseline.change_percent, None);
    }

    #[test]
    fn financial_report_accepts_only_explicit_visual_crossing_sources() {
        assert!(is_visual_crossing_weather_source(
            "visual_crossing:register_close"
        ));
        assert!(is_visual_crossing_weather_source("visual_crossing_final"));
        assert!(!is_visual_crossing_weather_source("mock:register_close"));
        assert!(!is_visual_crossing_weather_source("register_close"));
    }

    #[test]
    fn rendered_report_includes_mtd_cards_comparison_and_actual_weather() {
        let html = render_html(
            &sample_report(Some(ReportWeather {
                condition: "Rain & <wind>".to_string(),
                temp_high_f: 81.0,
                temp_low_f: 65.0,
                precipitation_inches: 0.42,
                source: "visual_crossing:register_close".to_string(),
                captured_at: "2026-08-08T00:00:00Z".to_string(),
                finalized: false,
            })),
            "Riverside Men's Shop",
        );

        assert!(html.contains("Booked Net Sales"));
        assert!(html.contains("$9427.95"));
        assert!(html.contains("Booked Total With Tax"));
        assert!(html.contains("$10155.60"));
        assert!(html.contains("MTD Booked Net"));
        assert!(html.contains("Last Year MTD"));
        assert!(html.contains("MTD vs Last Year"));
        assert!(html.contains("Month-to-Date Net Comparison"));
        assert!(html.contains("2025-08-01 through 2025-08-07"));
        assert!(html.contains("+$2000.00 (+20.0%)"));
        assert!(html.contains("Business Day Weather"));
        assert!(html.contains("Rain &amp; &lt;wind&gt;"));
        assert!(html.contains("0.42 in"));
    }

    #[test]
    fn rendered_report_does_not_present_simulated_weather_as_actual() {
        let html = render_html(&sample_report(None), "Riverside Men's Shop");
        assert!(html.contains("Actual weather data was unavailable"));
        assert!(html.contains("Simulated weather is not included"));
    }
}
