//! Proposed daily journal lines for QBO staging (mapping-first, review before push).
//!
//! Refunds: negative `payment_transactions` aggregate as **credits** to tender accounts (cash out).
//! Fulfillment-day revenue/COGS/tax use **effective** line qty (sold minus `transaction_return_lines`).
//! Returns recorded on `activity_date` add contra-revenue, tax, and (when restocked) COGS reversal
//! so refund-day journals stay balanced. See `docs/QBO_JOURNAL_TEST_MATRIX.md`.

use chrono::{NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashMap;
use uuid::Uuid;

use crate::logic::custom_orders::normalize_custom_item_type_key;
use crate::logic::report_basis::ORDER_RECOGNITION_TS_SQL;

fn is_rms_financing_tender(payment_method: &str, tender_family: Option<&str>) -> bool {
    payment_method.eq_ignore_ascii_case("on_account_rms")
        || payment_method.eq_ignore_ascii_case("on_account_rms90")
        || tender_family
            .map(|value| value.trim().eq_ignore_ascii_case("rms_charge"))
            .unwrap_or(false)
}

fn rms_payment_collection_flag(value: Option<bool>) -> bool {
    value.unwrap_or(false)
}

fn gift_card_uses_loyalty_expense(sub_type: Option<&str>) -> bool {
    matches!(
        sub_type.map(str::trim),
        Some("loyalty_giveaway") | Some("donated_giveaway") | Some("promo_gift_card")
    )
}

fn gift_card_uses_liability_relief(sub_type: Option<&str>) -> bool {
    matches!(sub_type.map(str::trim), Some("paid_liability"))
}

#[derive(Debug, Serialize, Clone)]
pub struct JournalLine {
    pub qbo_account_id: String,
    pub qbo_account_name: String,
    pub debit: Decimal,
    pub credit: Decimal,
    pub memo: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub detail: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct JournalProposal {
    pub activity_date: NaiveDate,
    pub business_timezone: String,
    pub generated_at: chrono::DateTime<Utc>,
    pub lines: Vec<JournalLine>,
    pub warnings: Vec<String>,
    pub totals: ProposalTotals,
}

#[derive(Debug, Serialize)]
pub struct ProposalTotals {
    pub debits: Decimal,
    pub credits: Decimal,
    pub balanced: bool,
}

async fn qbo_map_name(
    pool: &PgPool,
    source_type: &str,
    source_id: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let row: Option<(String, String)> = sqlx::query_as(
        r#"
        SELECT qbo_account_id, qbo_account_name
        FROM qbo_mappings
        WHERE source_type = $1 AND source_id = $2
        "#,
    )
    .bind(source_type)
    .bind(source_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// `transaction_lines` plus returned qty per line (matches `order_recalc` effective qty).
const TL_EFFECTIVE_JOIN: &str = r#"
        FROM transaction_lines oi
        INNER JOIN transactions o ON o.id = oi.transaction_id
        INNER JOIN products p ON p.id = oi.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN (
            SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
            FROM transaction_return_lines
            GROUP BY transaction_line_id
        ) orl ON orl.transaction_line_id = oi.id
    "#;

async fn ledger_fallback(
    pool: &PgPool,
    internal_key: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT m.qbo_account_id, c.name
        FROM ledger_mappings m
        LEFT JOIN qbo_accounts_cache c ON c.id = m.qbo_account_id
        WHERE m.internal_key = $1 AND m.qbo_account_id IS NOT NULL
        "#,
    )
    .bind(internal_key)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id, nm)| (id.clone(), nm.unwrap_or(id))))
}

pub async fn qbo_map_with_misc_fallback(
    pool: &PgPool,
    source_type: &str,
    source_id: &str,
    internal_fallback: Option<&str>,
) -> Result<Option<(String, String)>, sqlx::Error> {
    // 1. Specific mapping
    if let Some(m) = qbo_map_name(pool, source_type, source_id).await? {
        return Ok(Some(m));
    }
    // 2. Ledger fallback (if applicable)
    if let Some(key) = internal_fallback {
        if let Some(m) = ledger_fallback(pool, key).await? {
            return Ok(Some(m));
        }
    }
    // 3. MISC fallback
    if let Some((aid, aname)) = qbo_map_name(pool, "MISC_FALLBACK", "default").await? {
        return Ok(Some((aid, format!("MISC: {aname} ({source_type})"))));
    }
    Ok(None)
}

pub async fn sweep_expired_gift_cards(
    pool: &PgPool,
    activity_date: NaiveDate,
) -> Result<(), sqlx::Error> {
    let business_timezone: String =
        sqlx::query_scalar("SELECT reporting.effective_store_timezone()")
            .fetch_one(pool)
            .await?;

    let mut tx = pool.begin().await?;

    // Find all active, positive-balance liability gift cards that expired on or before activity_date.
    let expired_cards: Vec<(Uuid, Decimal, String)> = sqlx::query_as(
        r#"
        SELECT id, current_balance, code
        FROM gift_cards
        WHERE is_liability = TRUE
          AND current_balance > 0
          AND card_status = 'active'::gift_card_status
          AND (expires_at AT TIME ZONE $2)::date <= $1::date
        FOR UPDATE
        "#,
    )
    .bind(activity_date)
    .bind(&business_timezone)
    .fetch_all(&mut *tx)
    .await?;

    for (card_id, balance, code) in expired_cards {
        // Log event backdated to end of expiration date
        sqlx::query(
            r#"
            INSERT INTO gift_card_events (
                gift_card_id, event_kind, amount, balance_after, notes, created_at
            )
            VALUES ($1, 'expiration_breakage', $2, 0.00, $3, ($4::date + time '23:59:59') AT TIME ZONE $5)
            "#,
        )
        .bind(card_id)
        .bind(-balance)
        .bind(format!("Gift card #{code} expired with remaining balance of ${balance}. Swept to breakage."))
        .bind(activity_date)
        .bind(&business_timezone)
        .execute(&mut *tx)
        .await?;

        // Update card
        sqlx::query(
            r#"
            UPDATE gift_cards
            SET current_balance = 0.00,
                card_status = 'depleted'::gift_card_status,
                notes = COALESCE(notes || CHR(10) || $2, $2)
            WHERE id = $1
            "#,
        )
        .bind(card_id)
        .bind(format!("Expired and swept to breakage on {activity_date}."))
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Build a proposed journal for recognized fulfillment day (store-local business date).
/// Pickup / in-store takeaway use fulfillment timestamps; shipped orders use the shared
/// shipment recognition instant from `report_basis`.
/// Deposits, partial pickups, and loyalty gift cards are flagged in `warnings`.
pub async fn propose_daily_journal(
    pool: &PgPool,
    activity_date: NaiveDate,
) -> Result<JournalProposal, sqlx::Error> {
    let order_recognition_ts = ORDER_RECOGNITION_TS_SQL.trim();
    let line_recognition_ts = format!("(COALESCE(({order_recognition_ts}), oi.fulfilled_at))");
    let business_timezone: String =
        sqlx::query_scalar("SELECT reporting.effective_store_timezone()")
            .fetch_one(pool)
            .await?;
    let mut warnings: Vec<String> = vec![
        format!("Journal uses recognized fulfillment activity on store-local business date {activity_date} ({business_timezone}); shipped orders recognize at label purchase / in-transit / delivered events. Deposit release posts from checkout `applied_deposit_amount` metadata; verify `liability_deposit` + revenue mappings before sync."),
        "Gift card: purchased-card sales credit `liability_gift_card` / default, purchased-card redemptions debit that liability, and loyalty/donated redemptions debit `expense_loyalty` / default when checkout stores canonical gift card metadata. Unmapped cases fall back to tender mapping.".to_string(),
        "Store credit and open deposit redemptions post as liability relief when mapped; they are not cash/card tender revenue.".to_string(),
        "Customer-charged shipping posts as fulfillment-day shipping income when `income_shipping` / default or `REVENUE_SHIPPING` is mapped.".to_string(),
        "Revenue/COGS/tax for recognized transactions use effective qty (sold minus returns). Returns booked today add contra lines; re-run past dates after returns to restate recognition-day nets.".to_string(),
    ];

    #[derive(sqlx::FromRow)]
    struct CatAgg {
        category_id: Option<Uuid>,
        category_name: Option<String>,
        custom_item_type: Option<String>,
        net_sales: Option<Decimal>,
        cogs_ext: Option<Decimal>,
        tax_state: Option<Decimal>,
        tax_local: Option<Decimal>,
    }

    let cat_rows: Vec<CatAgg> = sqlx::query_as(&format!(
        r#"
        SELECT
            p.category_id,
            c.name AS category_name,
            CASE
                WHEN oi.fulfillment::text = 'custom'
                THEN NULLIF(TRIM(COALESCE(oi.custom_item_type, '')), '')
                ELSE NULL
            END AS custom_item_type,
            SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14, 2)) AS net_sales,
            SUM((oi.unit_cost * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14, 2)) AS cogs_ext,
            SUM((oi.state_tax * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14, 2)) AS tax_state,
            SUM((oi.local_tax * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14, 2)) AS tax_local
        {TL_EFFECTIVE_JOIN}
        WHERE o.is_forfeited = false
          AND {line_recognition_ts} IS NOT NULL
          AND ({line_recognition_ts} AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
          AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
          AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
          AND (p.pos_line_kind IS DISTINCT FROM 'alteration_service')
        GROUP BY
            p.category_id,
            c.name,
            CASE
                WHEN oi.fulfillment::text = 'custom'
                THEN NULLIF(TRIM(COALESCE(oi.custom_item_type, '')), '')
                ELSE NULL
            END
        "#
    ))
    .bind(activity_date)
    .fetch_all(pool)
    .await?;

    let (imported_counterpoint_transactions, imported_counterpoint_zero_tax_lines): (i64, i64) =
        sqlx::query_as(&format!(
            r#"
            SELECT
                COUNT(DISTINCT o.id)::bigint AS imported_counterpoint_transactions,
                COUNT(oi.id) FILTER (
                    WHERE COALESCE(oi.state_tax, 0) = 0
                      AND COALESCE(oi.local_tax, 0) = 0
                )::bigint AS imported_counterpoint_zero_tax_lines
            {TL_EFFECTIVE_JOIN}
            WHERE o.is_forfeited = false
              AND o.is_counterpoint_import = true
              AND (o.counterpoint_ticket_ref IS NOT NULL OR o.counterpoint_doc_ref IS NOT NULL)
              AND {line_recognition_ts} IS NOT NULL
              AND ({line_recognition_ts} AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
              AND GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0) > 0
              AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
              AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
              AND (p.pos_line_kind IS DISTINCT FROM 'alteration_service')
            "#
        ))
        .bind(activity_date)
        .fetch_one(pool)
        .await?;

    if imported_counterpoint_transactions > 0 {
        warnings.push(format!(
            "Counterpoint-imported activity is included in this proposal ({imported_counterpoint_transactions} transaction(s)). Historical gross totals are preserved, but imported line tax is non-authoritative; {imported_counterpoint_zero_tax_lines} imported line(s) show zero tax."
        ));
    }

    #[derive(sqlx::FromRow)]
    struct TenderAgg {
        payment_method: String,
        source_payment_methods: Option<String>,
        sub_type: Option<String>,
        tender_family: Option<String>,
        rms_charge_collection: Option<bool>,
        total: Option<Decimal>,
        total_merchant_fee: Option<Decimal>,
    }

    let tender_rows: Vec<TenderAgg> = sqlx::query_as(
        r#"
        SELECT
            CASE
                WHEN LOWER(COALESCE(payment_provider, '')) = 'helcim'
                 AND LOWER(payment_method) IN ('card', 'card_terminal', 'card_manual', 'card_saved', 'card_credit')
                THEN 'helcim_card'
                ELSE payment_method
            END AS payment_method,
            STRING_AGG(DISTINCT payment_method, ', ' ORDER BY payment_method) AS source_payment_methods,
            NULLIF(TRIM(COALESCE(metadata->>'sub_type', '')), '') AS sub_type,
            NULLIF(TRIM(COALESCE(metadata->>'tender_family', '')), '') AS tender_family,
            BOOL_OR(COALESCE((metadata->>'rms_charge_collection')::boolean, FALSE)) AS rms_charge_collection,
            SUM(amount)::numeric(14, 2) AS total,
            SUM(merchant_fee)::numeric(14, 2) AS total_merchant_fee
        FROM payment_transactions
        WHERE COALESCE(effective_date, (created_at AT TIME ZONE reporting.effective_store_timezone())::date) = $1::date
        GROUP BY
            CASE
                WHEN LOWER(COALESCE(payment_provider, '')) = 'helcim'
                 AND LOWER(payment_method) IN ('card', 'card_terminal', 'card_manual', 'card_saved', 'card_credit')
                THEN 'helcim_card'
                ELSE payment_method
            END,
            NULLIF(TRIM(COALESCE(metadata->>'sub_type', '')), ''),
            NULLIF(TRIM(COALESCE(metadata->>'tender_family', '')), '')
        "#,
    )
    .bind(activity_date)
    .fetch_all(pool)
    .await?;

    let rounding_total: Decimal = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(rounding_adjustment), 0)::numeric(14, 2)
        FROM transactions
        WHERE COALESCE(business_date, (booked_at AT TIME ZONE reporting.effective_store_timezone())::date) = $1::date
        "#,
    )
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    let mut lines: Vec<JournalLine> = Vec::new();

    if !rounding_total.is_zero() {
        if let Some((aid, aname)) = ledger_fallback(pool, "CASH_ROUNDING").await? {
            let abs_amt = rounding_total.abs().round_dp(2);
            // rounding_adjustment is (RoundedCash - ExactPrice)
            // If RoundedCash > ExactPrice, adjustment is positive (Income/Credit)
            // If RoundedCash < ExactPrice, adjustment is negative (Expense/Debit)
            let (debit, credit) = if rounding_total > Decimal::ZERO {
                (Decimal::ZERO, abs_amt)
            } else {
                (abs_amt, Decimal::ZERO)
            };

            lines.push(JournalLine {
                qbo_account_id: aid,
                qbo_account_name: aname,
                debit,
                credit,
                memo: "Swedish Rounding Adjustments (Cash)".to_string(),
                detail: vec![
                    serde_json::json!({ "kind": "cash_rounding", "amount": rounding_total }),
                ],
            });
        }
    }

    #[derive(sqlx::FromRow)]
    struct GiftCardLoadAgg {
        total: Option<Decimal>,
        load_count: i64,
    }
    let gift_card_load: GiftCardLoadAgg = sqlx::query_as(
        r#"
        SELECT
            COALESCE(SUM((oi.unit_price * oi.quantity)::numeric(14, 2)), 0)::numeric(14, 2) AS total,
            COUNT(*)::bigint AS load_count
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

    let gift_card_load_total = gift_card_load.total.unwrap_or(Decimal::ZERO).round_dp(2);
    if gift_card_load_total > Decimal::ZERO {
        if let Some((aid, aname)) =
            qbo_map_with_misc_fallback(pool, "liability_gift_card", "default", None).await?
        {
            lines.push(JournalLine {
                qbo_account_id: aid,
                qbo_account_name: aname,
                debit: Decimal::ZERO,
                credit: gift_card_load_total,
                memo: "Purchased gift card liability issued".to_string(),
                detail: vec![serde_json::json!({
                    "kind": "purchased_gift_card_load",
                    "load_count": gift_card_load.load_count,
                    "amount": gift_card_load_total
                })],
            });
        } else {
            warnings.push(
                "Purchased gift card loads were excluded from merchandise revenue but no `liability_gift_card` / default mapping exists for the liability credit."
                    .to_string(),
            );
        }
    }

    #[derive(sqlx::FromRow)]
    struct ShippingIncomeAgg {
        total: Option<Decimal>,
        transaction_count: i64,
    }

    let shipping_income: ShippingIncomeAgg = sqlx::query_as(&format!(
        r#"
        SELECT
            COALESCE(SUM(recognized_shipping.shipping_amount_usd), 0)::numeric(14, 2) AS total,
            COUNT(*)::bigint AS transaction_count
        FROM (
            SELECT DISTINCT
                o.id,
                COALESCE(o.shipping_amount_usd, 0)::numeric(14, 2) AS shipping_amount_usd
            FROM transactions o
            WHERE o.is_forfeited = false
              AND o.status::text <> 'cancelled'
              AND COALESCE(o.shipping_amount_usd, 0) <> 0
              AND ({order_recognition_ts}) IS NOT NULL
              AND (({order_recognition_ts}) AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
        ) recognized_shipping
        "#
    ))
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    let shipping_income_total = shipping_income.total.unwrap_or(Decimal::ZERO).round_dp(2);
    if !shipping_income_total.is_zero() {
        if let Some((aid, aname)) =
            qbo_map_with_misc_fallback(pool, "income_shipping", "default", Some("REVENUE_SHIPPING"))
                .await?
        {
            let abs_amount = shipping_income_total.abs();
            let (debit, credit) = if shipping_income_total > Decimal::ZERO {
                (Decimal::ZERO, abs_amount)
            } else {
                (abs_amount, Decimal::ZERO)
            };
            lines.push(JournalLine {
                qbo_account_id: aid,
                qbo_account_name: aname,
                debit,
                credit,
                memo: "Customer-charged shipping income".to_string(),
                detail: vec![serde_json::json!({
                    "kind": "shipping_income",
                    "transaction_count": shipping_income.transaction_count,
                    "amount": shipping_income_total
                })],
            });
        } else {
            warnings.push(format!(
                "Customer-charged shipping of ${shipping_income_total} detected, but no `income_shipping` / default, `REVENUE_SHIPPING`, or MISC mapping exists; shipping income omitted."
            ));
        }
    }

    // ── Gift Card Breakage (liability expiration) ──────────────────────────
    #[derive(sqlx::FromRow)]
    struct ExpiredGCAgg {
        total_breakage: Option<Decimal>,
        expired_count: i64,
    }

    let expired_gc: ExpiredGCAgg = sqlx::query_as(
        r#"
        SELECT
            SUM(-amount)::numeric(14, 2) AS total_breakage,
            COUNT(*)::bigint AS expired_count
        FROM gift_card_events
        WHERE event_kind = 'expiration_breakage'
          AND (created_at AT TIME ZONE $2)::date = $1::date
        "#,
    )
    .bind(activity_date)
    .bind(&business_timezone)
    .fetch_one(pool)
    .await?;

    let breakage_total = expired_gc.total_breakage.unwrap_or(Decimal::ZERO).round_dp(2);
    if breakage_total > Decimal::ZERO {
        let breakage_account = qbo_map_with_misc_fallback(
            pool,
            "income_gift_card_breakage",
            "default",
            Some("REVENUE_GIFT_CARD_BREAKAGE"),
        )
        .await?;

        let liability_account = qbo_map_with_misc_fallback(
            pool,
            "liability_gift_card",
            "default",
            None,
        )
        .await?;

        if let (Some((br_id, br_name)), Some((liab_id, liab_name))) = (breakage_account, liability_account) {
            lines.push(JournalLine {
                qbo_account_id: liab_id,
                qbo_account_name: liab_name,
                debit: breakage_total,
                credit: Decimal::ZERO,
                memo: format!("Gift card liability relief from expiration (breakage) - {activity_date}"),
                detail: vec![serde_json::json!({
                    "kind": "gift_card_breakage_liability_relief",
                    "expired_count": expired_gc.expired_count,
                    "amount": breakage_total
                })],
            });

            lines.push(JournalLine {
                qbo_account_id: br_id,
                qbo_account_name: br_name,
                debit: Decimal::ZERO,
                credit: breakage_total,
                memo: format!("Gift card breakage revenue recognized - {activity_date}"),
                detail: vec![serde_json::json!({
                    "kind": "gift_card_breakage_revenue",
                    "expired_count": expired_gc.expired_count,
                    "amount": breakage_total
                })],
            });
        } else {
            warnings.push(format!(
                "Gift card breakage of ${breakage_total} detected but `income_gift_card_breakage` or `liability_gift_card` mapping is missing; breakage omitted."
            ));
        }
    }

    #[derive(sqlx::FromRow)]
    struct SuitSwapEv {
        old_unit_cost: Decimal,
        new_unit_cost: Decimal,
        effective_quantity: i32,
        inventory_adjusted: bool,
        old_sku: String,
        new_sku: String,
    }
    let suit_swaps: Vec<SuitSwapEv> = sqlx::query_as(
        r#"
        SELECT
            e.old_unit_cost,
            e.new_unit_cost,
            e.effective_quantity,
            e.inventory_adjusted,
            ov.sku AS old_sku,
            nv.sku AS new_sku
        FROM suit_component_swap_events e
        INNER JOIN product_variants ov ON ov.id = e.old_variant_id
        INNER JOIN product_variants nv ON nv.id = e.new_variant_id
        WHERE (e.created_at AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
        "#,
    )
    .bind(activity_date)
    .fetch_all(pool)
    .await?;

    if !suit_swaps.is_empty() {
        warnings.push(format!(
            "Suit/component swaps: {} event(s) on this store-local business date — value-delta lines below use `INV_ASSET` + `COGS_DEFAULT` ledger_mappings when mappable.",
            suit_swaps.len()
        ));
        for s in &suit_swaps {
            if !s.inventory_adjusted {
                continue;
            }
            let delta = ((s.new_unit_cost - s.old_unit_cost) * Decimal::from(s.effective_quantity))
                .round_dp(2);
            if delta.is_zero() {
                continue;
            }
            let cat_label = "_uncategorized".to_string();
            let inv = qbo_map_with_misc_fallback(
                pool,
                "category_inventory",
                &cat_label,
                Some("INV_ASSET"),
            )
            .await?;
            let off =
                qbo_map_with_misc_fallback(pool, "category_cogs", &cat_label, Some("COGS_DEFAULT"))
                    .await?;
            let (Some((inv_id, inv_name)), Some((off_id, off_name))) = (inv, off) else {
                warnings.push(format!(
                    "Suit swap {0}→{1} net cost delta {2} — set `INV_ASSET` and `COGS_DEFAULT` in ledger_mappings to stage offset lines.",
                    s.old_sku, s.new_sku, delta
                ));
                continue;
            };
            let abs = delta.abs().round_dp(2);
            let (d_inv, c_inv, d_off, c_off) = if delta > Decimal::ZERO {
                (abs, Decimal::ZERO, Decimal::ZERO, abs)
            } else {
                (Decimal::ZERO, abs, abs, Decimal::ZERO)
            };
            lines.push(JournalLine {
                qbo_account_id: inv_id.clone(),
                qbo_account_name: inv_name.clone(),
                debit: d_inv,
                credit: c_inv,
                memo: format!("Suit swap inventory {0} → {1}", s.old_sku, s.new_sku),
                detail: vec![
                    serde_json::json!({"kind": "suit_swap_inventory", "delta": delta.to_string()}),
                ],
            });
            lines.push(JournalLine {
                qbo_account_id: off_id,
                qbo_account_name: off_name,
                debit: d_off,
                credit: c_off,
                memo: format!("Suit swap offset {0} → {1}", s.old_sku, s.new_sku),
                detail: vec![
                    serde_json::json!({"kind": "suit_swap_offset", "delta": delta.to_string()}),
                ],
            });
        }
    }

    #[derive(sqlx::FromRow)]
    struct InvTxAgg {
        category_id: Option<Uuid>,
        category_name: Option<String>,
        tx_type: String,
        total_value: Option<Decimal>,
    }

    let inv_tx_rows: Vec<InvTxAgg> = sqlx::query_as(
        r#"
        SELECT
            p.category_id,
            c.name AS category_name,
            it.tx_type::text,
            SUM(((COALESCE(it.unit_cost, 0) + COALESCE(it.landed_cost_component, 0)) * it.quantity_delta)::numeric(14, 2)) AS total_value
        FROM inventory_transactions it
        INNER JOIN product_variants pv ON pv.id = it.variant_id
        INNER JOIN products p ON p.id = pv.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE (it.created_at AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
          AND it.tx_type::text IN ('po_receipt', 'adjustment', 'damaged', 'return_to_vendor', 'physical_inventory')
        GROUP BY p.category_id, c.name, it.tx_type::text
        "#,
    )
    .bind(activity_date)
    .fetch_all(pool)
    .await?;

    for itx in &inv_tx_rows {
        let val = itx.total_value.unwrap_or(Decimal::ZERO);
        if val.is_zero() {
            continue;
        }
        let cat_label = itx
            .category_id
            .map(|u| u.to_string())
            .unwrap_or_else(|| "_uncategorized".to_string());

        let (fallback_key, debit_internal, memo_prefix) = match itx.tx_type.as_str() {
            "po_receipt" => (
                Some("INV_RECEIVING_CLEARING"),
                "INV_RECEIVING_CLEARING",
                "Receiving",
            ),
            "damaged" => (Some("INV_SHRINKAGE"), "INV_SHRINKAGE", "Inventory Damage"),
            "return_to_vendor" => (
                Some("INV_RTV_CLEARING"),
                "INV_RTV_CLEARING",
                "Return to Vendor",
            ),
            _ => {
                // Adjustment or Physical Inventory
                if val < Decimal::ZERO {
                    (
                        Some("INV_SHRINKAGE"),
                        "INV_SHRINKAGE",
                        "Inventory Adjustment (Shrinkage)",
                    )
                } else {
                    // This is "found" inventory. Usually debit asset, credit a fallback income/cogs-reversal.
                    (None, "REVENUE_FALLBACK", "Inventory Adjustment (Found)")
                }
            }
        };

        let inv_asset =
            qbo_map_with_misc_fallback(pool, "category_inventory", &cat_label, Some("INV_ASSET"))
                .await?;
        let offset = if let Some(fb) = fallback_key {
            ledger_fallback(pool, fb).await?
        } else {
            ledger_fallback(pool, debit_internal).await?
        };

        if let (Some((inv_id, inv_name)), Some((off_id, off_name))) = (inv_asset, offset) {
            let abs_val = val.abs().round_dp(2);
            let (d_acc, c_acc, d_inv, c_inv) = if val < Decimal::ZERO {
                // Shrinking/Leaving: Credit Inventory, Debit Expense/Clearing
                (abs_val, Decimal::ZERO, Decimal::ZERO, abs_val)
            } else {
                // Found/Entering: Debit Inventory, Credit Income
                (Decimal::ZERO, abs_val, abs_val, Decimal::ZERO)
            };

            lines.push(JournalLine {
                qbo_account_id: inv_id,
                qbo_account_name: inv_name,
                debit: d_inv,
                credit: c_inv,
                memo: format!(
                    "{}: {}",
                    memo_prefix,
                    itx.category_name.as_deref().unwrap_or("Uncategorized")
                ),
                detail: vec![
                    serde_json::json!({"kind": itx.tx_type, "category_id": itx.category_id}),
                ],
            });
            lines.push(JournalLine {
                qbo_account_id: off_id,
                qbo_account_name: off_name,
                debit: d_acc,
                credit: c_acc,
                memo: format!(
                    "{} Offset: {}",
                    memo_prefix,
                    itx.category_name.as_deref().unwrap_or("Uncategorized")
                ),
                detail: vec![],
            });
        } else {
            warnings.push(format!(
                "Inventory {} transaction for category `{}` skipped — set mappings for INV_ASSET and {}.",
                itx.tx_type, cat_label, fallback_key.unwrap_or("REVENUE_FALLBACK")
            ));
        }
    }

    // ── Inbound Freight (shipping cost) ─────────────────────────────────────
    // Freight is NOT part of COGS — it posts to its own expense account
    // (COGS_FREIGHT ledger mapping) with an offset to INV_RECEIVING_CLEARING.
    #[derive(sqlx::FromRow)]
    struct FreightAgg {
        total_freight: Option<Decimal>,
    }
    let freight_agg: FreightAgg = sqlx::query_as(
        r#"
        SELECT COALESCE(SUM(re.freight_total), 0)::numeric(14,2) AS total_freight
        FROM receiving_events re
        WHERE (re.received_at AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
          AND re.freight_total > 0
        "#,
    )
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    let freight_total = freight_agg
        .total_freight
        .unwrap_or(Decimal::ZERO)
        .round_dp(2);
    if !freight_total.is_zero() {
        let freight_account = ledger_fallback(pool, "COGS_FREIGHT").await?;
        let clearing_account = ledger_fallback(pool, "INV_RECEIVING_CLEARING").await?;

        if let (Some((fr_id, fr_name)), Some((cl_id, cl_name))) =
            (freight_account, clearing_account)
        {
            lines.push(JournalLine {
                qbo_account_id: fr_id,
                qbo_account_name: fr_name,
                debit: freight_total,
                credit: Decimal::ZERO,
                memo: format!("Inbound freight / shipping cost for {activity_date}"),
                detail: vec![json!({"kind": "freight", "total": freight_total.to_string()})],
            });
            lines.push(JournalLine {
                qbo_account_id: cl_id,
                qbo_account_name: cl_name,
                debit: Decimal::ZERO,
                credit: freight_total,
                memo: format!("Freight clearing offset for {activity_date}"),
                detail: vec![],
            });
        } else {
            warnings.push(format!(
                "Inbound freight of ${freight_total} detected but `COGS_FREIGHT` or `INV_RECEIVING_CLEARING` ledger mapping is missing; freight omitted from journal."
            ));
        }
    }

    for t in &tender_rows {
        let amt = t.total.unwrap_or(Decimal::ZERO);
        if amt.is_zero() {
            continue;
        }
        let sid = t.payment_method.trim();
        let is_gift_card = sid.eq_ignore_ascii_case("gift_card");
        let is_paid_liability_gc =
            is_gift_card && gift_card_uses_liability_relief(t.sub_type.as_deref());
        let is_loyalty_gc = is_gift_card && gift_card_uses_loyalty_expense(t.sub_type.as_deref());
        let is_rms_financing = is_rms_financing_tender(sid, t.tender_family.as_deref());
        let is_rms_collection = rms_payment_collection_flag(t.rms_charge_collection);
        let is_store_credit = sid.eq_ignore_ascii_case("store_credit");
        let is_open_deposit = sid.eq_ignore_ascii_case("open_deposit");
        if is_gift_card && !is_paid_liability_gc && !is_loyalty_gc {
            warnings.push(
                "Gift card payment missing/unknown card classification; expected purchased, loyalty, donated, or promo card metadata. Falling back to tender mapping."
                    .to_string(),
            );
        }
        let liability_mapped = if is_open_deposit {
            qbo_map_name(pool, "liability_deposit", "default").await?
        } else if is_store_credit {
            qbo_map_name(pool, "liability_store_credit", "default").await?
        } else if is_loyalty_gc {
            qbo_map_with_misc_fallback(pool, "expense_loyalty", "default", None).await?
        } else if is_paid_liability_gc {
            qbo_map_with_misc_fallback(pool, "liability_gift_card", "default", None).await?
        } else {
            None
        };
        let mapped = if let Some(m) = liability_mapped.clone() {
            Some(m)
        } else if is_open_deposit || is_store_credit {
            None
        } else if is_rms_financing {
            qbo_map_with_misc_fallback(
                pool,
                "MISC_PAYMENT",
                "default",
                Some("RMS_CHARGE_FINANCING_CLEARING"),
            )
            .await?
        } else {
            qbo_map_with_misc_fallback(pool, "tender", sid, None).await?
        };
        let (aid, aname) = match mapped {
            Some(m) => {
                if is_loyalty_gc && liability_mapped.is_none() {
                    warnings.push(
                        "Gift card loyalty/promo redemption uses tender fallback — set `expense_loyalty` / default for expense recognition.".to_string(),
                    );
                } else if is_paid_liability_gc && liability_mapped.is_none() {
                    warnings.push(
                        "Gift card tender uses `tender`/`gift_card` account — set `liability_gift_card` / default for liability relief.".to_string(),
                    );
                }
                m
            }
            None => {
                if is_open_deposit {
                    warnings.push(
                        "Open deposit redemption detected but no `liability_deposit` / default mapping exists; liability relief omitted."
                            .to_string(),
                    );
                } else if is_store_credit {
                    warnings.push(
                        "Store credit redemption detected but no `liability_store_credit` / default mapping exists; liability relief omitted."
                            .to_string(),
                    );
                } else {
                    warnings.push(format!(
                        "No QBO tender mapping for `{sid}`; skipped in journal."
                    ));
                }
                continue;
            }
        };
        let abs_amt = amt.abs();
        let (debit, credit) = if amt > Decimal::ZERO {
            (abs_amt, Decimal::ZERO)
        } else {
            (Decimal::ZERO, abs_amt)
        };
        let memo = if amt < Decimal::ZERO {
            if is_open_deposit {
                "Open deposit redemption reversal (liability)".to_string()
            } else if is_store_credit {
                "Store credit redemption reversal (liability)".to_string()
            } else if is_loyalty_gc && liability_mapped.is_some() {
                "Gift card (refund / reversal) — loyalty/promo expense".to_string()
            } else if is_paid_liability_gc && liability_mapped.is_some() {
                "Gift card (refund / reversal) — liability".to_string()
            } else if is_rms_financing {
                "RMS Charge financing (refund / reversal)".to_string()
            } else if is_rms_collection {
                format!("Tenders (RMS payment collection outflow) — {sid}")
            } else {
                format!("Tenders (refund/outflow) — {sid}")
            }
        } else if is_open_deposit {
            "Open deposit redemption (liability)".to_string()
        } else if is_store_credit {
            "Store credit redemption (liability)".to_string()
        } else if is_loyalty_gc && liability_mapped.is_some() {
            "Gift card redemption (loyalty/promo expense)".to_string()
        } else if is_paid_liability_gc && liability_mapped.is_some() {
            "Gift card redemption (liability)".to_string()
        } else if is_rms_financing {
            "RMS Charge financing".to_string()
        } else if is_rms_collection {
            format!("Tenders (RMS payment collection) — {sid}")
        } else {
            format!("Tenders — {sid}")
        };
        lines.push(JournalLine {
            qbo_account_id: aid.clone(),
            qbo_account_name: aname.clone(),
            debit,
            credit,
            memo: memo.clone(),
            detail: vec![serde_json::json!({
                "payment_method": sid,
                "source_payment_methods": t.source_payment_methods,
                "sub_type": t.sub_type,
                "tender_family": t.tender_family,
                "rms_charge_collection": t.rms_charge_collection,
                "liability_relief": (is_open_deposit || is_store_credit || is_paid_liability_gc) && liability_mapped.is_some(),
                "amount": amt
            })],
        });

        // 2b. Merchant Fee Recon: If this is a card transaction with reconciled fees,
        // post the fee as an expense and credit the clearing account (leaving the net in clearing).
        let fees = t.total_merchant_fee.unwrap_or(Decimal::ZERO);
        if sid.to_lowercase().contains("card") && !fees.is_zero() {
            if let Some((fee_aid, fee_aname)) = qbo_map_with_misc_fallback(
                pool,
                "expense_merchant_fee",
                "default",
                Some("EXP_MERCHANT_FEE"),
            )
            .await?
            {
                let abs_fees = fees.abs().round_dp(2);
                let (d_fee, c_fee) = if fees > Decimal::ZERO {
                    (abs_fees, Decimal::ZERO)
                } else {
                    (Decimal::ZERO, abs_fees)
                };

                // Debit Fee Expense
                lines.push(JournalLine {
                    qbo_account_id: fee_aid,
                    qbo_account_name: fee_aname,
                    debit: d_fee,
                    credit: c_fee,
                    memo: format!("Merchant Fees — {sid}"),
                    detail: vec![serde_json::json!({ "kind": "merchant_fee", "method": sid, "amount": fees })],
                });

                // Credit Clearing Account (reducing the gross debit to net)
                lines.push(JournalLine {
                    qbo_account_id: aid,
                    qbo_account_name: aname,
                    debit: c_fee,
                    credit: d_fee,
                    memo: format!("Merchant Fee Offset — {sid}"),
                    detail: vec![],
                });
            } else {
                warnings.push(format!("Merchant fees detected for {sid} (${fees}) but no `expense_merchant_fee` mapping found. Clearing account will remain at GROSS."));
            }
        }
    }

    #[derive(sqlx::FromRow)]
    struct ReturnDayAgg {
        category_id: Option<Uuid>,
        category_name: Option<String>,
        net_product: Option<Decimal>,
        tax_state: Option<Decimal>,
        tax_local: Option<Decimal>,
        cogs_restock: Option<Decimal>,
    }

    let return_day_rows: Vec<ReturnDayAgg> = sqlx::query_as(
        r#"
        SELECT
            p.category_id,
            c.name AS category_name,
            SUM((oi.unit_price * orl.quantity_returned::numeric)::numeric(14, 2)) AS net_product,
            SUM((oi.state_tax * orl.quantity_returned::numeric)::numeric(14, 2)) AS tax_state,
            SUM((oi.local_tax * orl.quantity_returned::numeric)::numeric(14, 2)) AS tax_local,
            SUM(
                CASE WHEN orl.restocked
                    THEN (oi.unit_cost * orl.quantity_returned::numeric)::numeric(14, 2)
                    ELSE 0::numeric
                END
            ) AS cogs_restock
        FROM transaction_return_lines orl
        INNER JOIN transaction_lines oi ON oi.id = orl.transaction_line_id
        INNER JOIN transactions o ON o.id = oi.transaction_id
        INNER JOIN products p ON p.id = oi.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE o.status::text NOT IN ('cancelled')
          AND (orl.created_at AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
        GROUP BY p.category_id, c.name
        "#,
    )
    .bind(activity_date)
    .fetch_all(pool)
    .await?;

    let restock_cogs_total: Decimal = return_day_rows
        .iter()
        .map(|r| r.cogs_restock.unwrap_or(Decimal::ZERO))
        .sum();
    if restock_cogs_total > Decimal::ZERO && ledger_fallback(pool, "INV_ASSET").await?.is_none() {
        warnings.push(
            "Return-day restocks present but `INV_ASSET` has no ledger_mapping — restock inventory lines may be omitted until mapped."
                .to_string(),
        );
    }

    for rr in &return_day_rows {
        let np = rr.net_product.unwrap_or(Decimal::ZERO);
        let ts = rr.tax_state.unwrap_or(Decimal::ZERO);
        let tl = rr.tax_local.unwrap_or(Decimal::ZERO);
        let cr = rr.cogs_restock.unwrap_or(Decimal::ZERO);
        if np.is_zero() && ts.is_zero() && tl.is_zero() && cr.is_zero() {
            continue;
        }
        let cat_label = rr
            .category_id
            .map(|u| u.to_string())
            .unwrap_or_else(|| "_uncategorized".to_string());

        if np > Decimal::ZERO {
            if let Some(mapped) = qbo_map_with_misc_fallback(
                pool,
                "category_revenue",
                &cat_label,
                Some("REVENUE_CLOTHING"),
            )
            .await?
            {
                let (aid, aname) = mapped;
                lines.push(JournalLine {
                    qbo_account_id: aid,
                    qbo_account_name: aname,
                    debit: np,
                    credit: Decimal::ZERO,
                    memo: format!(
                        "Sales returns (product) — {}",
                        rr.category_name.as_deref().unwrap_or("Uncategorized")
                    ),
                    detail: vec![serde_json::json!({ "category_id": rr.category_id })],
                });
            } else {
                warnings.push(format!(
                    "Return-day product contra for category `{cat_label}` skipped — no revenue or MISC mapping."
                ));
            }
        }

        let tax_ret = (ts + tl).round_dp(2);
        if tax_ret > Decimal::ZERO {
            if let Some((tid, tnm)) =
                qbo_map_with_misc_fallback(pool, "tax", "SALES_TAX", None).await?
            {
                lines.push(JournalLine {
                    qbo_account_id: tid,
                    qbo_account_name: tnm,
                    debit: tax_ret,
                    credit: Decimal::ZERO,
                    memo: "Sales tax on returns (liability reduction)".to_string(),
                    detail: vec![serde_json::json!({ "state": ts, "local": tl })],
                });
            } else {
                warnings.push(
                    "Returns include tax but no `tax` / SALES_TAX mapping; tax contra omitted."
                        .to_string(),
                );
            }
        }

        if cr > Decimal::ZERO {
            let inv = qbo_map_with_misc_fallback(
                pool,
                "category_inventory",
                &cat_label,
                Some("INV_ASSET"),
            )
            .await?;
            let cogs_a =
                qbo_map_with_misc_fallback(pool, "category_cogs", &cat_label, Some("COGS_DEFAULT"))
                    .await?;
            if let (Some((cogs_id, cogs_nm)), Some((inv_id, inv_nm))) = (cogs_a, inv) {
                lines.push(JournalLine {
                    qbo_account_id: inv_id.clone(),
                    qbo_account_name: inv_nm.clone(),
                    debit: cr,
                    credit: Decimal::ZERO,
                    memo: format!(
                        "Inventory from restocked returns — {}",
                        rr.category_name.as_deref().unwrap_or("Uncategorized")
                    ),
                    detail: vec![],
                });
                lines.push(JournalLine {
                    qbo_account_id: cogs_id,
                    qbo_account_name: cogs_nm,
                    debit: Decimal::ZERO,
                    credit: cr,
                    memo: format!(
                        "COGS reversal (restock) — {}",
                        rr.category_name.as_deref().unwrap_or("Uncategorized")
                    ),
                    detail: vec![],
                });
            } else {
                warnings.push(format!(
                    "Restocked return COGS reversal omitted for category `{cat_label}` — missing COGS/inventory mapping."
                ));
            }
        }
    }

    #[derive(sqlx::FromRow)]
    struct DepositReleaseAgg {
        category_id: Option<Uuid>,
        category_name: Option<String>,
        release_amount: Option<Decimal>,
    }

    // For recognized transactions, release previously held customer deposits into recognized revenue.
    let deposit_release_rows: Vec<DepositReleaseAgg> = sqlx::query_as(&format!(
        r#"
        WITH fulfilled_transactions AS (
            SELECT o.id
            FROM transactions o
            WHERE o.status::text NOT IN ('cancelled')
              AND ({order_recognition_ts}) IS NOT NULL
              AND (({order_recognition_ts}) AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
        ),
        order_deposit AS (
            SELECT
                pa.target_transaction_id AS transaction_id,
                COALESCE(SUM((pa.metadata->>'applied_deposit_amount')::numeric(14,2)), 0::numeric) AS deposit_total
            FROM payment_allocations pa
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            INNER JOIN fulfilled_transactions fo ON fo.id = pa.target_transaction_id
            WHERE COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) < $1::date
            GROUP BY pa.target_transaction_id
        ),
        category_net AS (
            SELECT
                oi.transaction_id,
                p.category_id,
                c.name AS category_name,
                SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14,2)) AS cat_net
            FROM transaction_lines oi
            INNER JOIN products p ON p.id = oi.product_id
                AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
                AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
                AND (p.pos_line_kind IS DISTINCT FROM 'alteration_service')
            LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN (
                SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
                FROM transaction_return_lines
                GROUP BY transaction_line_id
            ) orl ON orl.transaction_line_id = oi.id
            INNER JOIN fulfilled_transactions fo ON fo.id = oi.transaction_id
            GROUP BY oi.transaction_id, p.category_id, c.name
        ),
        order_net AS (
            SELECT transaction_id, SUM(cat_net)::numeric(14,2) AS order_net
            FROM category_net
            GROUP BY transaction_id
        )
        SELECT
            cn.category_id,
            cn.category_name,
            SUM(
                CASE
                    WHEN onet.order_net > 0
                        THEN ROUND(od.deposit_total * (cn.cat_net / onet.order_net), 2)
                    ELSE 0::numeric
                END
            )::numeric(14,2) AS release_amount
        FROM category_net cn
        INNER JOIN order_net onet ON onet.transaction_id = cn.transaction_id
        INNER JOIN order_deposit od ON od.transaction_id = cn.transaction_id
        WHERE od.deposit_total > 0
        GROUP BY cn.category_id, cn.category_name
        "#
    ))
    .bind(activity_date)
    .fetch_all(pool)
    .await?;

    // Day-level verification: total releasable allocations should closely match deposit signals.
    let (deposit_total_day, release_total_day): (Option<Decimal>, Option<Decimal>) = sqlx::query_as(&format!(
        r#"
        WITH fulfilled_transactions AS (
            SELECT o.id
            FROM transactions o
            WHERE o.status::text NOT IN ('cancelled')
              AND ({order_recognition_ts}) IS NOT NULL
              AND (({order_recognition_ts}) AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
        ),
        order_deposit AS (
            SELECT
                pa.target_transaction_id AS transaction_id,
                COALESCE(SUM((pa.metadata->>'applied_deposit_amount')::numeric(14,2)), 0::numeric) AS deposit_total
            FROM payment_allocations pa
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            INNER JOIN fulfilled_transactions fo ON fo.id = pa.target_transaction_id
            WHERE COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) < $1::date
            GROUP BY pa.target_transaction_id
        ),
        category_net AS (
            SELECT
                oi.transaction_id,
                SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14,2)) AS cat_net
            FROM transaction_lines oi
            INNER JOIN products p ON p.id = oi.product_id
                AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
                AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
                AND (p.pos_line_kind IS DISTINCT FROM 'alteration_service')
            LEFT JOIN (
                SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
                FROM transaction_return_lines
                GROUP BY transaction_line_id
            ) orl ON orl.transaction_line_id = oi.id
            INNER JOIN fulfilled_transactions fo ON fo.id = oi.transaction_id
            GROUP BY oi.transaction_id, oi.product_id
        ),
        order_net AS (
            SELECT transaction_id, SUM(cat_net)::numeric(14,2) AS order_net
            FROM category_net
            GROUP BY transaction_id
        ),
        alloc AS (
            SELECT
                cn.transaction_id,
                CASE
                    WHEN onet.order_net > 0
                        THEN ROUND(od.deposit_total * (cn.cat_net / onet.order_net), 2)
                    ELSE 0::numeric
                END AS alloc_amt
            FROM category_net cn
            INNER JOIN order_net onet ON onet.transaction_id = cn.transaction_id
            INNER JOIN order_deposit od ON od.transaction_id = cn.transaction_id
        )
        SELECT
            (SELECT COALESCE(SUM(deposit_total), 0::numeric) FROM order_deposit) AS deposit_total_day,
            (SELECT COALESCE(SUM(alloc_amt), 0::numeric) FROM alloc) AS release_total_day
        "#
    ))
    .bind(activity_date)
    .fetch_one(pool)
    .await?;
    let day_drift = (deposit_total_day.unwrap_or(Decimal::ZERO)
        - release_total_day.unwrap_or(Decimal::ZERO))
    .abs();
    if day_drift > Decimal::new(1, 2) {
        warnings.push(format!(
            "Deposit release day-level drift is ${day_drift:.2}; some deposit signals may not map to releasable category net on this date."
        ));
    }

    // Proportionality verification: detect per-order rounding drift from category splits.
    let drift_rows: Vec<(Uuid, Decimal)> = sqlx::query_as(&format!(
        r#"
        WITH fulfilled_transactions AS (
            SELECT o.id
            FROM transactions o
            WHERE o.status::text NOT IN ('cancelled')
              AND ({order_recognition_ts}) IS NOT NULL
              AND (({order_recognition_ts}) AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
        ),
        order_deposit AS (
            SELECT
                pa.target_transaction_id AS transaction_id,
                COALESCE(SUM((pa.metadata->>'applied_deposit_amount')::numeric(14,2)), 0::numeric) AS deposit_total
            FROM payment_allocations pa
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            INNER JOIN fulfilled_transactions fo ON fo.id = pa.target_transaction_id
            WHERE COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) < $1::date
            GROUP BY pa.target_transaction_id
        ),
        category_net AS (
            SELECT
                oi.transaction_id,
                SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14,2)) AS cat_net
            FROM transaction_lines oi
            INNER JOIN products p ON p.id = oi.product_id
                AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
                AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
                AND (p.pos_line_kind IS DISTINCT FROM 'alteration_service')
            LEFT JOIN (
                SELECT transaction_line_id, SUM(quantity_returned)::int AS returned
                FROM transaction_return_lines
                GROUP BY transaction_line_id
            ) orl ON orl.transaction_line_id = oi.id
            INNER JOIN fulfilled_transactions fo ON fo.id = oi.transaction_id
            GROUP BY oi.transaction_id, oi.product_id
        ),
        order_net AS (
            SELECT transaction_id, SUM(cat_net)::numeric(14,2) AS order_net
            FROM category_net
            GROUP BY transaction_id
        ),
        alloc AS (
            SELECT
                cn.transaction_id,
                CASE
                    WHEN onet.order_net > 0
                        THEN ROUND(od.deposit_total * (cn.cat_net / onet.order_net), 2)
                    ELSE 0::numeric
                END AS alloc_amt,
                od.deposit_total
            FROM category_net cn
            INNER JOIN order_net onet ON onet.transaction_id = cn.transaction_id
            INNER JOIN order_deposit od ON od.transaction_id = cn.transaction_id
        )
        SELECT
            transaction_id,
            ABS(MAX(deposit_total) - SUM(alloc_amt))::numeric(14,2) AS drift
        FROM alloc
        GROUP BY transaction_id
        HAVING ABS(MAX(deposit_total) - SUM(alloc_amt)) > 0.01
        "#
    ))
    .bind(activity_date)
    .fetch_all(pool)
    .await?;
    if !drift_rows.is_empty() {
        let max_drift = drift_rows
            .iter()
            .map(|(_, d)| *d)
            .max()
            .unwrap_or(Decimal::ZERO);
        warnings.push(format!(
            "Deposit release proportionality drift detected on {} transactions (max ${:.2}); review category splits for rounding.",
            drift_rows.len(),
            max_drift
        ));
    }

    let mut deposit_release_by_category: HashMap<String, Decimal> = HashMap::new();
    let mut warned_missing_deposit_liability_mapping = false;
    for row in &deposit_release_rows {
        let release_amount = row.release_amount.unwrap_or(Decimal::ZERO);
        if release_amount <= Decimal::ZERO {
            continue;
        }
        let cat_label = row
            .category_id
            .map(|u| u.to_string())
            .unwrap_or_else(|| "_uncategorized".to_string());
        *deposit_release_by_category
            .entry(cat_label)
            .or_insert(Decimal::ZERO) += release_amount;

        if let Some((lid, lnm)) =
            qbo_map_with_misc_fallback(pool, "liability_deposit", "default", None).await?
        {
            lines.push(JournalLine {
                qbo_account_id: lid,
                qbo_account_name: lnm,
                debit: release_amount,
                credit: Decimal::ZERO,
                memo: format!(
                    "Deposit release — {}",
                    row.category_name.as_deref().unwrap_or("Uncategorized")
                ),
                detail: vec![serde_json::json!({
                    "category_id": row.category_id,
                    "release_amount": release_amount
                })],
            });
        } else if !warned_missing_deposit_liability_mapping {
            warnings.push(
                "Deposit release detected but no `liability_deposit` / default or MISC mapping; release debit omitted.".to_string(),
            );
            warned_missing_deposit_liability_mapping = true;
        }
    }

    for row in &cat_rows {
        let net = row.net_sales.unwrap_or(Decimal::ZERO);
        let cogs = row.cogs_ext.unwrap_or(Decimal::ZERO);
        let ts = row.tax_state.unwrap_or(Decimal::ZERO);
        let tl = row.tax_local.unwrap_or(Decimal::ZERO);
        let cat_label = row
            .category_id
            .map(|u| u.to_string())
            .unwrap_or_else(|| "_uncategorized".to_string());
        let custom_mapping_key = row
            .custom_item_type
            .as_deref()
            .and_then(normalize_custom_item_type_key);
        let source_label = row
            .custom_item_type
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| row.category_name.as_deref().unwrap_or("Uncategorized"));

        let release_credit = deposit_release_by_category
            .get(&cat_label)
            .cloned()
            .unwrap_or(Decimal::ZERO);
        let immediate_revenue = if net > release_credit {
            net - release_credit
        } else {
            if release_credit > net {
                warnings.push(format!(
                    "Deposit release exceeds net sales for category `{cat_label}`; clamped immediate revenue to zero."
                ));
            }
            Decimal::ZERO
        };

        if net < Decimal::ZERO {
            warnings.push(format!(
                "Category `{cat_label}` has negative net sales ({net:.2}) after returns — check data."
            ));
        }

        if net > Decimal::ZERO {
            let mapped = if let Some(custom_key) = custom_mapping_key {
                qbo_map_with_misc_fallback(pool, "custom_revenue", custom_key, None)
                    .await?
                    .or(qbo_map_with_misc_fallback(
                        pool,
                        "category_revenue",
                        &cat_label,
                        Some("REVENUE_CLOTHING"),
                    )
                    .await?)
            } else {
                qbo_map_with_misc_fallback(
                    pool,
                    "category_revenue",
                    &cat_label,
                    Some("REVENUE_CLOTHING"),
                )
                .await?
            };
            let (aid, aname) = if let Some(m) = mapped {
                m
            } else {
                warnings.push(format!(
                    "No revenue or MISC mapping for category `{cat_label}`; revenue omitted."
                ));
                continue;
            };
            if immediate_revenue > Decimal::ZERO {
                lines.push(JournalLine {
                    qbo_account_id: aid.clone(),
                    qbo_account_name: aname.clone(),
                    debit: Decimal::ZERO,
                    credit: immediate_revenue,
                    memo: format!("Revenue — {source_label}"),
                    detail: vec![serde_json::json!({
                        "category_id": row.category_id,
                        "custom_item_type": row.custom_item_type.clone(),
                        "net_sales": net,
                        "deposit_release_component": release_credit
                    })],
                });
            }
            if release_credit > Decimal::ZERO {
                lines.push(JournalLine {
                    qbo_account_id: aid,
                    qbo_account_name: aname,
                    debit: Decimal::ZERO,
                    credit: release_credit,
                    memo: format!("Revenue from deposit release — {source_label}"),
                    detail: vec![serde_json::json!({
                        "category_id": row.category_id,
                        "custom_item_type": row.custom_item_type.clone(),
                        "release_amount": release_credit
                    })],
                });
            }
        }

        if cogs > Decimal::ZERO {
            let inv = if let Some(custom_key) = custom_mapping_key {
                qbo_map_with_misc_fallback(pool, "custom_inventory", custom_key, None)
                    .await?
                    .or(qbo_map_with_misc_fallback(
                        pool,
                        "category_inventory",
                        &cat_label,
                        Some("INV_ASSET"),
                    )
                    .await?)
            } else {
                qbo_map_with_misc_fallback(
                    pool,
                    "category_inventory",
                    &cat_label,
                    Some("INV_ASSET"),
                )
                .await?
            };
            let cogs_a = if let Some(custom_key) = custom_mapping_key {
                qbo_map_with_misc_fallback(pool, "custom_cogs", custom_key, None)
                    .await?
                    .or(qbo_map_with_misc_fallback(
                        pool,
                        "category_cogs",
                        &cat_label,
                        Some("COGS_DEFAULT"),
                    )
                    .await?)
            } else {
                qbo_map_with_misc_fallback(pool, "category_cogs", &cat_label, Some("COGS_DEFAULT"))
                    .await?
            };

            if let (Some((cogs_id, cogs_nm)), Some((inv_id, inv_nm))) = (cogs_a, inv) {
                lines.push(JournalLine {
                    qbo_account_id: cogs_id.clone(),
                    qbo_account_name: cogs_nm.clone(),
                    debit: cogs,
                    credit: Decimal::ZERO,
                    memo: format!("COGS — {source_label}"),
                    detail: vec![],
                });
                lines.push(JournalLine {
                    qbo_account_id: inv_id,
                    qbo_account_name: inv_nm,
                    debit: Decimal::ZERO,
                    credit: cogs,
                    memo: format!("Inventory relief — {source_label}"),
                    detail: vec![],
                });
            } else {
                warnings.push(format!(
                    "Missing COGS/inventory mapping for category `{cat_label}`; COGS omitted."
                ));
            }
        }

        let tax_total = ts + tl;
        if tax_total > Decimal::ZERO {
            if let Some((tid, tnm)) =
                qbo_map_with_misc_fallback(pool, "tax", "SALES_TAX", None).await?
            {
                lines.push(JournalLine {
                    qbo_account_id: tid,
                    qbo_account_name: tnm,
                    debit: Decimal::ZERO,
                    credit: tax_total,
                    memo: "Sales tax collected".to_string(),
                    detail: vec![serde_json::json!({ "state": ts, "local": tl })],
                });
            } else {
                warnings.push(
                    "Sales tax collected but no `tax` / SALES_TAX or MISC mapping; add qbo_mappings row."
                        .to_string(),
                );
            }
        }
    }

    // 4.5. New Deposits: deposit allocations today for transactions NOT fulfilled today
    // (liability increase). Use allocation metadata instead of merchandise lines so
    // existing-order payments collected in a mixed POS sale remain liability movement,
    // not current merchandise revenue.
    let deposit_inflow: Decimal = sqlx::query_scalar(&format!(
        r#"
        SELECT COALESCE(SUM((pa.metadata->>'applied_deposit_amount')::numeric(14,2)), 0)::numeric(14,2)
        FROM payment_allocations pa
        INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
        INNER JOIN transactions o ON o.id = pa.target_transaction_id
        WHERE COALESCE(pt.effective_date, (pt.created_at AT TIME ZONE reporting.effective_store_timezone())::date) = $1::date
          AND pa.amount_allocated > 0::numeric
          AND NULLIF(TRIM(pa.metadata->>'applied_deposit_amount'), '') IS NOT NULL
          AND (({order_recognition_ts}) IS NULL OR (({order_recognition_ts}) AT TIME ZONE reporting.effective_store_timezone())::date > $1::date)
          AND o.status::text NOT IN ('cancelled')
        "#
    ))
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    if !deposit_inflow.is_zero() {
        if let Some((lid, lnm)) =
            qbo_map_with_misc_fallback(pool, "liability_deposit", "default", None).await?
        {
            let abs_in = deposit_inflow.abs();
            let (debit, credit) = if deposit_inflow > Decimal::ZERO {
                (Decimal::ZERO, abs_in)
            } else {
                (abs_in, Decimal::ZERO)
            };
            lines.push(JournalLine {
                qbo_account_id: lid,
                qbo_account_name: lnm,
                debit,
                credit,
                memo: if deposit_inflow > Decimal::ZERO {
                    "New deposits received (liability increase)".to_string()
                } else {
                    "Deposit refund / reversal (liability decrease)".to_string()
                },
                detail: vec![serde_json::json!({
                    "kind": "new_deposit_inflow",
                    "amount": deposit_inflow
                })],
            });
        } else {
            warnings.push(format!(
                "New deposits of ${deposit_inflow} detected but no `liability_deposit` mapping; inflow credit omitted."
            ));
        }
    }

    // 5. Forfeitures: recognize retained deposits for layaways cancelled as forfeited.
    #[derive(sqlx::FromRow)]
    struct ForfeitAgg {
        total_forfeited: Option<Decimal>,
    }
    let forfeit_row: ForfeitAgg = sqlx::query_as(
        r#"
        SELECT SUM(amount_paid)::numeric(14,2) AS total_forfeited
        FROM transactions
        WHERE is_forfeited = TRUE
          AND (forfeited_at AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
        "#,
    )
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    if let Some(f_amt) = forfeit_row.total_forfeited {
        if f_amt > Decimal::ZERO {
            let lib =
                qbo_map_with_misc_fallback(pool, "liability_deposit", "default", None).await?;
            let inc = qbo_map_with_misc_fallback(pool, "income_forfeited_deposit", "default", None)
                .await?;

            if let (Some((lib_id, lib_nm)), Some((inc_id, inc_nm))) = (lib, inc) {
                lines.push(JournalLine {
                    qbo_account_id: lib_id,
                    qbo_account_name: lib_nm,
                    debit: f_amt,
                    credit: Decimal::ZERO,
                    memo: "Forfeited deposit liability relief".to_string(),
                    detail: vec![
                        serde_json::json!({"kind": "forfeiture_liability_relief", "amount": f_amt}),
                    ],
                });
                lines.push(JournalLine {
                    qbo_account_id: inc_id,
                    qbo_account_name: inc_nm,
                    debit: Decimal::ZERO,
                    credit: f_amt,
                    memo: "Income from forfeited deposits".to_string(),
                    detail: vec![
                        serde_json::json!({"kind": "forfeited_deposit_income", "amount": f_amt}),
                    ],
                });
            } else {
                warnings.push(format!(
                    "Forfeited deposits of ${f_amt} detected, but missing `liability_deposit` or `income_forfeited_deposit` mappings."
                ));
            }
        }
    }

    let alteration_service_net: Decimal = sqlx::query_scalar(&format!(
        r#"
        SELECT COALESCE(SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14, 2)), 0)::numeric(14, 2)
        {TL_EFFECTIVE_JOIN}
        WHERE o.status::text NOT IN ('cancelled')
          AND {line_recognition_ts} IS NOT NULL
          AND ({line_recognition_ts} AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
          AND p.pos_line_kind = 'alteration_service'
          AND oi.unit_price > 0::numeric
        "#
    ))
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    if alteration_service_net > Decimal::ZERO {
        if let Some((aid, aname)) = qbo_map_with_misc_fallback(
            pool,
            "income_alterations",
            "default",
            Some("REVENUE_ALTERATIONS"),
        )
        .await?
        {
            lines.push(JournalLine {
                qbo_account_id: aid,
                qbo_account_name: aname,
                debit: Decimal::ZERO,
                credit: alteration_service_net,
                memo: "Alterations Income".to_string(),
                detail: vec![serde_json::json!({"kind": "alteration_service_income"})],
            });
        } else {
            warnings.push(
                "Charged alteration service lines detected but no `income_alterations` / default, `REVENUE_ALTERATIONS`, or MISC mapping; revenue omitted."
                    .to_string(),
            );
        }
    }

    let rms_payment_net: Decimal = sqlx::query_scalar(&format!(
        r#"
        SELECT COALESCE(SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14, 2)), 0)::numeric(14, 2)
        {TL_EFFECTIVE_JOIN}
        WHERE o.status::text NOT IN ('cancelled')
          AND {line_recognition_ts} IS NOT NULL
          AND ({line_recognition_ts} AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
          AND p.pos_line_kind = 'rms_charge_payment'
        "#
    ))
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    if rms_payment_net > Decimal::ZERO {
        if let Some((aid, aname)) = qbo_map_with_misc_fallback(
            pool,
            "MISC_PAYMENT",
            "default",
            Some("RMS_R2S_PAYMENT_CLEARING"),
        )
        .await?
        {
            lines.push(JournalLine {
                qbo_account_id: aid,
                qbo_account_name: aname,
                debit: Decimal::ZERO,
                credit: rms_payment_net,
                memo: "R2S payment collections (pass-through)".to_string(),
                detail: vec![serde_json::json!({"kind": "rms_r2s_payment_clearing"})],
            });
        } else {
            warnings.push(
                "R2S RMS payment lines detected but mapping missing; verify RMS_R2S_PAYMENT_CLEARING or MISC fallback."
                    .to_string(),
            );
        }
    }

    let rms_payment_reversal_net: Decimal = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(ABS(amount)) FILTER (
            WHERE amount < 0::numeric
              AND COALESCE((metadata->>'rms_charge_collection')::boolean, FALSE) = TRUE
        ), 0)::numeric(14, 2)
        FROM payment_transactions
        WHERE COALESCE(effective_date, (created_at AT TIME ZONE reporting.effective_store_timezone())::date) = $1::date
        "#,
    )
    .bind(activity_date)
    .fetch_one(pool)
    .await?;

    if rms_payment_reversal_net > Decimal::ZERO {
        if let Some((aid, aname)) = qbo_map_with_misc_fallback(
            pool,
            "MISC_PAYMENT",
            "default",
            Some("RMS_R2S_PAYMENT_CLEARING"),
        )
        .await?
        {
            lines.push(JournalLine {
                qbo_account_id: aid,
                qbo_account_name: aname,
                debit: rms_payment_reversal_net,
                credit: Decimal::ZERO,
                memo: "R2S payment collection reversals".to_string(),
                detail: vec![serde_json::json!({"kind": "rms_r2s_payment_reversal_clearing"})],
            });
        } else {
            warnings.push(
                "R2S RMS payment reversals detected but mapping missing; verify RMS_R2S_PAYMENT_CLEARING or MISC fallback."
                    .to_string(),
            );
        }
    }

    let mut refund_liability_created = Decimal::ZERO;
    for rr in &return_day_rows {
        refund_liability_created += rr.net_product.unwrap_or(Decimal::ZERO)
            + rr.tax_state.unwrap_or(Decimal::ZERO)
            + rr.tax_local.unwrap_or(Decimal::ZERO);
    }

    let mut refund_liability_relieved = Decimal::ZERO;
    for t in &tender_rows {
        let amt = t.total.unwrap_or(Decimal::ZERO);
        if amt < Decimal::ZERO && !rms_payment_collection_flag(t.rms_charge_collection) {
            refund_liability_relieved += amt.abs();
        }
    }

    let refund_liability_delta = (refund_liability_created - refund_liability_relieved).round_dp(2);

    if !refund_liability_delta.is_zero() {
        if let Some((aid, aname)) = qbo_map_with_misc_fallback(
            pool,
            "liability_refund_queue",
            "default",
            Some("REFUND_LIABILITY_CLEARING"),
        )
        .await?
        {
            let abs_delta = refund_liability_delta.abs();
            let (debit, credit) = if refund_liability_delta > Decimal::ZERO {
                (Decimal::ZERO, abs_delta)
            } else {
                (abs_delta, Decimal::ZERO)
            };
            lines.push(JournalLine {
                qbo_account_id: aid,
                qbo_account_name: aname,
                debit,
                credit,
                memo: if refund_liability_delta > Decimal::ZERO {
                    "Refund liability queued (from returns)".to_string()
                } else {
                    "Refund liability relieved (payouts)".to_string()
                },
                detail: vec![serde_json::json!({
                    "kind": "refund_liability_clearing",
                    "created": refund_liability_created,
                    "relieved": refund_liability_relieved,
                    "net_delta": refund_liability_delta
                })],
            });
        } else {
            warnings.push(
                "Asynchronous refunds require a `liability_refund_queue` / default or REFUND_LIABILITY_CLEARING mapping to balance disjoint return/payout days. Refund clearing omitted."
                    .to_string(),
            );
        }
    }

    let debits: Decimal = lines.iter().map(|l| l.debit).sum();
    let credits: Decimal = lines.iter().map(|l| l.credit).sum();
    let diff = debits - credits;
    let balanced = diff.is_zero();

    if !balanced {
        tracing::warn!(
            "QBO Journal not balanced for {} by {:.2} (DR: {:.2} - CR: {:.2}). Lines: {:?}",
            activity_date,
            diff,
            debits,
            credits,
            lines
        );
        warnings.push(format!(
            "Journal not balanced by {diff:.2} (DR: {debits:.2}, CR: {credits:.2}). Review tender vs revenue/tax mappings before sync."
        ));
    }

    Ok(JournalProposal {
        activity_date,
        business_timezone,
        generated_at: Utc::now(),
        lines,
        warnings,
        totals: ProposalTotals {
            debits,
            credits,
            balanced,
        },
    })
}

pub async fn ensure_pending_daily_journal(
    pool: &PgPool,
    activity_date: NaiveDate,
) -> Result<Uuid, sqlx::Error> {
    let existing_rows: Vec<(Uuid, String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT id, status, journal_entry_id
        FROM qbo_sync_logs
        WHERE sync_date = $1
        ORDER BY created_at DESC
        "#,
    )
    .bind(activity_date)
    .fetch_all(pool)
    .await?;

    let pending_id = existing_rows
        .iter()
        .find(|(_, status, _)| status == "pending")
        .map(|(id, _, _)| *id);

    let locked_rows: Vec<(Uuid, String, Option<String>)> = existing_rows
        .iter()
        .filter(|(_, status, _)| status == "approved" || status == "synced")
        .cloned()
        .collect();

    if let Err(e) = sweep_expired_gift_cards(pool, activity_date).await {
        tracing::error!(error = %e, ?activity_date, "Failed to sweep expired gift cards before daily journal generation");
    }

    let proposal = propose_daily_journal(pool, activity_date).await?;
    let payload = serde_json::to_value(&proposal)
        .map_err(|e| sqlx::Error::Protocol(format!("serialize QBO proposal: {e}")))?;
    let payload = with_staging_metadata(payload, activity_date, &locked_rows);

    if let Some(existing_id) = pending_id {
        return sqlx::query_scalar::<_, Uuid>(
            r#"
            UPDATE qbo_sync_logs
            SET payload = $2,
                error_message = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status = 'pending'
            RETURNING id
            "#,
        )
        .bind(existing_id)
        .bind(payload)
        .fetch_one(pool)
        .await;
    }

    sqlx::query_scalar::<_, Uuid>(
        r#"
        INSERT INTO qbo_sync_logs (sync_date, status, payload)
        VALUES ($1, 'pending', $2)
        RETURNING id
        "#,
    )
    .bind(activity_date)
    .bind(payload)
    .fetch_one(pool)
    .await
}

fn with_staging_metadata(
    mut payload: Value,
    activity_date: NaiveDate,
    locked_rows: &[(Uuid, String, Option<String>)],
) -> Value {
    let revision_of: Vec<Value> = locked_rows
        .iter()
        .map(|(id, status, journal_entry_id)| {
            json!({
                "staging_id": id,
                "status": status,
                "journal_entry_id": journal_entry_id,
            })
        })
        .collect();
    let entry_type = if revision_of.is_empty() {
        "daily_general_journal"
    } else {
        "daily_general_journal_revision"
    };
    let note = if revision_of.is_empty() {
        format!(
            "Daily General Journal Entry for Riverside OS business date {activity_date}. Review before pushing to QuickBooks."
        )
    } else {
        format!(
            "Revision package for Riverside OS business date {activity_date}. Review changed activity before pushing to QuickBooks."
        )
    };

    if let Some(obj) = payload.as_object_mut() {
        obj.insert("staging_kind".to_string(), json!("daily_general_journal"));
        obj.insert(
            "qbo_stage".to_string(),
            json!({
                "entry_type": entry_type,
                "business_date": activity_date,
                "review_status": "pending_review",
                "revision_of": revision_of,
                "note": note,
            }),
        );
    }

    payload
}

/// Returns true if the given business date has any Counterpoint-imported transactions.
/// Auto-propose skips these days so QBO journals are not created from non-authoritative tax data.
pub async fn has_counterpoint_imports_for_date(
    pool: &PgPool,
    activity_date: NaiveDate,
) -> Result<bool, sqlx::Error> {
    let line_recognition_ts = crate::logic::report_basis::ORDER_RECOGNITION_TS_SQL;
    let count: i64 = sqlx::query_scalar(&format!(
        r#"
        SELECT COUNT(DISTINCT o.id)::bigint
        FROM transactions o
        WHERE o.is_forfeited = false
          AND o.is_counterpoint_import = true
          AND (o.counterpoint_ticket_ref IS NOT NULL OR o.counterpoint_doc_ref IS NOT NULL)
          AND {line_recognition_ts} IS NOT NULL
          AND ({line_recognition_ts} AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
        "#,
    ))
    .bind(activity_date)
    .fetch_one(pool)
    .await?;
    Ok(count > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rms_financing_tender_detects_unified_rms_charge_metadata() {
        assert!(is_rms_financing_tender("on_account_rms", None));
        assert!(is_rms_financing_tender("cash", Some("rms_charge")));
        assert!(!is_rms_financing_tender("cash", None));
    }

    #[test]
    fn rms_payment_collection_flag_defaults_false() {
        assert!(rms_payment_collection_flag(Some(true)));
        assert!(!rms_payment_collection_flag(Some(false)));
        assert!(!rms_payment_collection_flag(None));
    }

    #[test]
    fn gift_card_sub_types_map_to_expected_accounting_path() {
        assert!(gift_card_uses_liability_relief(Some("paid_liability")));
        assert!(!gift_card_uses_liability_relief(Some("loyalty_giveaway")));
        assert!(gift_card_uses_loyalty_expense(Some("loyalty_giveaway")));
        assert!(gift_card_uses_loyalty_expense(Some("donated_giveaway")));
        assert!(gift_card_uses_loyalty_expense(Some("promo_gift_card")));
        assert!(!gift_card_uses_loyalty_expense(Some("paid_liability")));
        assert!(!gift_card_uses_loyalty_expense(None));
    }

    #[tokio::test]
    async fn test_gift_card_breakage_sweep() {
        let Some(database_url) = std::env::var("DATABASE_URL").ok() else {
            return;
        };
        let pool = PgPool::connect(&database_url).await.expect("connect pool");

        let code = format!("GC-EXPIRE-{}", uuid::Uuid::new_v4().simple());
        let card_id = uuid::Uuid::new_v4();

        // First clean up any existing card with this code
        sqlx::query("DELETE FROM gift_cards WHERE code = $1").bind(&code).execute(&pool).await.ok();

        // Insert card in pool (so it persists outside transaction so sweep can see it and commit)
        sqlx::query(
            r#"
            INSERT INTO gift_cards
                (id, code, card_kind, card_status, current_balance, original_value, is_liability, expires_at)
            VALUES ($1, $2, 'purchased', 'active', $3, $3, TRUE, NOW() - INTERVAL '5 days')
            "#,
        )
        .bind(card_id)
        .bind(&code)
        .bind(Decimal::new(15000, 2))
        .execute(&pool)
        .await
        .expect("insert expired gift card in pool");

        let today = chrono::Utc::now().date_naive();
        sweep_expired_gift_cards(&pool, today).await.expect("sweep");

        // Check if card is depleted
        let (bal, status): (Decimal, String) = sqlx::query_as(
            "SELECT current_balance, card_status::text FROM gift_cards WHERE id = $1",
        )
        .bind(card_id)
        .fetch_one(&pool)
        .await
        .expect("load card");

        assert_eq!(bal, Decimal::ZERO);
        assert_eq!(status, "depleted");

        // Check if event was created
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM gift_card_events WHERE gift_card_id = $1 AND event_kind = 'expiration_breakage'",
        )
        .bind(card_id)
        .fetch_one(&pool)
        .await
        .expect("load event count");

        assert_eq!(count, 1);

        // Clean up
        sqlx::query("DELETE FROM gift_cards WHERE id = $1").bind(card_id).execute(&pool).await.ok();
    }
}
