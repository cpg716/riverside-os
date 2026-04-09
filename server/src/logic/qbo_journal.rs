//! Proposed daily journal lines for QBO staging (mapping-first, review before push).
//!
//! Refunds: negative `payment_transactions` aggregate as **credits** to tender accounts (cash out).
//! Fulfillment-day revenue/COGS/tax use **effective** line qty (sold minus `order_return_lines`).
//! Returns recorded on `activity_date` add contra-revenue, tax, and (when restocked) COGS reversal
//! so refund-day journals stay balanced. See `docs/QBO_JOURNAL_TEST_MATRIX.md`.

use chrono::{NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::PgPool;
use std::collections::HashMap;
use uuid::Uuid;

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

/// `order_items` plus returned qty per line (matches `order_recalc` effective qty).
const OI_EFFECTIVE_JOIN: &str = r#"
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        INNER JOIN products p ON p.id = oi.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN (
            SELECT order_item_id, SUM(quantity_returned)::int AS returned
            FROM order_return_lines
            GROUP BY order_item_id
        ) orl ON orl.order_item_id = oi.id
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

async fn qbo_map_with_misc_fallback(
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
    if let Some(m) = qbo_map_name(pool, "MISC_FALLBACK", "default").await? {
        let (aid, aname) = m;
        return Ok(Some((aid, format!("MISC: {} ({})", aname, source_type))));
    }
    Ok(None)
}

/// Build a proposed journal for fulfilled-recognition day (UTC calendar date).
/// MVP: takeaway-style recognition only — fulfilled orders with `fulfilled_at` on `activity_date`.
/// Deposits, partial pickups, and loyalty gift cards are flagged in `warnings`.
pub async fn propose_daily_journal(
    pool: &PgPool,
    activity_date: NaiveDate,
) -> Result<JournalProposal, sqlx::Error> {
    let mut warnings: Vec<String> = vec![
        "MVP journal: uses fulfilled orders on this UTC date only. Deposit release posts from checkout `applied_deposit_amount` metadata; verify `liability_deposit` + revenue mappings before sync.".to_string(),
        "Gift card: paid-card redemptions debit `liability_gift_card` / default; loyalty/giveaway redemptions debit `expense_loyalty` / default when checkout `sub_type` metadata is present. Unmapped cases fall back to tender mapping.".to_string(),
        "Revenue/COGS/tax for fulfilled orders use effective qty (sold minus returns). Returns booked today add contra lines; re-run past dates after returns to restate fulfillment-day nets.".to_string(),
    ];

    #[derive(sqlx::FromRow)]
    struct CatAgg {
        category_id: Option<Uuid>,
        category_name: Option<String>,
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
            SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14, 2)) AS net_sales,
            SUM((oi.unit_cost * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14, 2)) AS cogs_ext,
            SUM((oi.state_tax * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14, 2)) AS tax_state,
            SUM((oi.local_tax * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14, 2)) AS tax_local
        {OI_EFFECTIVE_JOIN}
        WHERE o.status::text NOT IN ('cancelled')
          AND o.fulfilled_at IS NOT NULL
          AND (o.fulfilled_at AT TIME ZONE 'UTC')::date = $1::date
          AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
          AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
        GROUP BY p.category_id, c.name
        "#
    ))
    .bind(activity_date)
    .fetch_all(pool)
    .await?;

    #[derive(sqlx::FromRow)]
    struct TenderAgg {
        payment_method: String,
        sub_type: Option<String>,
        total: Option<Decimal>,
    }

    let tender_rows: Vec<TenderAgg> = sqlx::query_as(
        r#"
        SELECT
            payment_method,
            NULLIF(TRIM(COALESCE(metadata->>'sub_type', '')), '') AS sub_type,
            SUM(amount)::numeric(14, 2) AS total
        FROM payment_transactions
        WHERE (created_at AT TIME ZONE 'UTC')::date = $1::date
        GROUP BY payment_method, NULLIF(TRIM(COALESCE(metadata->>'sub_type', '')), '')
        "#,
    )
    .bind(activity_date)
    .fetch_all(pool)
    .await?;

    let mut lines: Vec<JournalLine> = Vec::new();

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
        WHERE (e.created_at AT TIME ZONE 'UTC')::date = $1::date
        "#,
    )
    .bind(activity_date)
    .fetch_all(pool)
    .await?;

    if !suit_swaps.is_empty() {
        warnings.push(format!(
            "Suit/component swaps: {} event(s) on this UTC date — value-delta lines below use `INV_ASSET` + `COGS_DEFAULT` ledger_mappings when mappable.",
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
                    "Suit swap {}→{} net cost delta {} — set `INV_ASSET` and `COGS_DEFAULT` in ledger_mappings to stage offset lines.",
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
                memo: format!("Suit swap inventory {} → {}", s.old_sku, s.new_sku),
                detail: vec![
                    serde_json::json!({"kind": "suit_swap_inventory", "delta": delta.to_string()}),
                ],
            });
            lines.push(JournalLine {
                qbo_account_id: off_id,
                qbo_account_name: off_name,
                debit: d_off,
                credit: c_off,
                memo: format!("Suit swap offset {} → {}", s.old_sku, s.new_sku),
                detail: vec![
                    serde_json::json!({"kind": "suit_swap_offset", "delta": delta.to_string()}),
                ],
            });
        }
    }

    for t in &tender_rows {
        let amt = t.total.unwrap_or(Decimal::ZERO);
        if amt.is_zero() {
            continue;
        }
        let sid = t.payment_method.trim();
        let sub_type = t.sub_type.as_deref().unwrap_or("").trim();
        let is_gift_card = sid.eq_ignore_ascii_case("gift_card");
        let is_paid_liability_gc = is_gift_card && sub_type.eq_ignore_ascii_case("paid_liability");
        let is_loyalty_gc = is_gift_card && sub_type.eq_ignore_ascii_case("loyalty_giveaway");
        if is_gift_card && !is_paid_liability_gc && !is_loyalty_gc {
            warnings.push(
                "Gift card payment missing/unknown `sub_type`; expected `paid_liability` or `loyalty_giveaway`. Falling back to tender mapping."
                    .to_string(),
            );
        }
        let liability_gc = if is_loyalty_gc {
            qbo_map_with_misc_fallback(pool, "expense_loyalty", "default", None).await?
        } else if is_paid_liability_gc {
            qbo_map_with_misc_fallback(pool, "liability_gift_card", "default", None).await?
        } else {
            None
        };
        let mapped = if let Some(m) = liability_gc.clone() {
            Some(m)
        } else {
            qbo_map_with_misc_fallback(pool, "tender", sid, None).await?
        };
        let (aid, aname) = match mapped {
            Some(m) => {
                if is_loyalty_gc && liability_gc.is_none() {
                    warnings.push(
                        "Gift card loyalty redemption uses tender fallback — set `expense_loyalty` / default for expense recognition.".to_string(),
                    );
                } else if is_paid_liability_gc && liability_gc.is_none() {
                    warnings.push(
                        "Gift card tender uses `tender`/`gift_card` account — set `liability_gift_card` / default for liability relief.".to_string(),
                    );
                }
                m
            }
            None => {
                warnings.push(format!(
                    "No QBO tender mapping for `{sid}`; skipped in journal."
                ));
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
            if is_loyalty_gc && liability_gc.is_some() {
                "Gift card (refund / reversal) — loyalty expense".to_string()
            } else if is_paid_liability_gc && liability_gc.is_some() {
                "Gift card (refund / reversal) — liability".to_string()
            } else {
                format!("Tenders (refund/outflow) — {sid}")
            }
        } else if is_loyalty_gc && liability_gc.is_some() {
            "Gift card redemption (loyalty expense)".to_string()
        } else if is_paid_liability_gc && liability_gc.is_some() {
            "Gift card redemption (liability)".to_string()
        } else {
            format!("Tenders — {sid}")
        };
        lines.push(JournalLine {
            qbo_account_id: aid,
            qbo_account_name: aname,
            debit,
            credit,
            memo,
            detail: vec![serde_json::json!({
                "payment_method": sid,
                "sub_type": t.sub_type,
                "amount": amt
            })],
        });
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
        FROM order_return_lines orl
        INNER JOIN order_items oi ON oi.id = orl.order_item_id
        INNER JOIN orders o ON o.id = oi.order_id
        INNER JOIN products p ON p.id = oi.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE o.status::text NOT IN ('cancelled')
          AND (orl.created_at AT TIME ZONE 'UTC')::date = $1::date
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

    // For fulfilled orders, release previously held customer deposits into recognized revenue.
    let deposit_release_rows: Vec<DepositReleaseAgg> = sqlx::query_as(
        r#"
        WITH fulfilled_orders AS (
            SELECT o.id
            FROM orders o
            WHERE o.status::text NOT IN ('cancelled')
              AND o.fulfilled_at IS NOT NULL
              AND (o.fulfilled_at AT TIME ZONE 'UTC')::date = $1::date
        ),
        order_deposit AS (
            SELECT
                pa.target_order_id AS order_id,
                COALESCE(SUM((pa.metadata->>'applied_deposit_amount')::numeric(14,2)), 0::numeric) AS deposit_total
            FROM payment_allocations pa
            INNER JOIN fulfilled_orders fo ON fo.id = pa.target_order_id
            GROUP BY pa.target_order_id
        ),
        category_net AS (
            SELECT
                oi.order_id,
                p.category_id,
                c.name AS category_name,
                SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14,2)) AS cat_net
            FROM order_items oi
            INNER JOIN products p ON p.id = oi.product_id
                AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
                AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
            LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN (
                SELECT order_item_id, SUM(quantity_returned)::int AS returned
                FROM order_return_lines
                GROUP BY order_item_id
            ) orl ON orl.order_item_id = oi.id
            INNER JOIN fulfilled_orders fo ON fo.id = oi.order_id
            GROUP BY oi.order_id, p.category_id, c.name
        ),
        order_net AS (
            SELECT order_id, SUM(cat_net)::numeric(14,2) AS order_net
            FROM category_net
            GROUP BY order_id
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
        INNER JOIN order_net onet ON onet.order_id = cn.order_id
        INNER JOIN order_deposit od ON od.order_id = cn.order_id
        WHERE od.deposit_total > 0
        GROUP BY cn.category_id, cn.category_name
        "#,
    )
    .bind(activity_date)
    .fetch_all(pool)
    .await?;

    // Day-level verification: total releasable allocations should closely match deposit signals.
    let (deposit_total_day, release_total_day): (Option<Decimal>, Option<Decimal>) = sqlx::query_as(
        r#"
        WITH fulfilled_orders AS (
            SELECT o.id
            FROM orders o
            WHERE o.status::text NOT IN ('cancelled')
              AND o.fulfilled_at IS NOT NULL
              AND (o.fulfilled_at AT TIME ZONE 'UTC')::date = $1::date
        ),
        order_deposit AS (
            SELECT
                pa.target_order_id AS order_id,
                COALESCE(SUM((pa.metadata->>'applied_deposit_amount')::numeric(14,2)), 0::numeric) AS deposit_total
            FROM payment_allocations pa
            INNER JOIN fulfilled_orders fo ON fo.id = pa.target_order_id
            GROUP BY pa.target_order_id
        ),
        category_net AS (
            SELECT
                oi.order_id,
                SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14,2)) AS cat_net
            FROM order_items oi
            INNER JOIN products p ON p.id = oi.product_id
                AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
                AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
            LEFT JOIN (
                SELECT order_item_id, SUM(quantity_returned)::int AS returned
                FROM order_return_lines
                GROUP BY order_item_id
            ) orl ON orl.order_item_id = oi.id
            INNER JOIN fulfilled_orders fo ON fo.id = oi.order_id
            GROUP BY oi.order_id, oi.product_id
        ),
        order_net AS (
            SELECT order_id, SUM(cat_net)::numeric(14,2) AS order_net
            FROM category_net
            GROUP BY order_id
        ),
        alloc AS (
            SELECT
                cn.order_id,
                CASE
                    WHEN onet.order_net > 0
                        THEN ROUND(od.deposit_total * (cn.cat_net / onet.order_net), 2)
                    ELSE 0::numeric
                END AS alloc_amt
            FROM category_net cn
            INNER JOIN order_net onet ON onet.order_id = cn.order_id
            INNER JOIN order_deposit od ON od.order_id = cn.order_id
        )
        SELECT
            (SELECT COALESCE(SUM(deposit_total), 0::numeric) FROM order_deposit) AS deposit_total_day,
            (SELECT COALESCE(SUM(alloc_amt), 0::numeric) FROM alloc) AS release_total_day
        "#,
    )
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
    let drift_rows: Vec<(Uuid, Decimal)> = sqlx::query_as(
        r#"
        WITH fulfilled_orders AS (
            SELECT o.id
            FROM orders o
            WHERE o.status::text NOT IN ('cancelled')
              AND o.fulfilled_at IS NOT NULL
              AND (o.fulfilled_at AT TIME ZONE 'UTC')::date = $1::date
        ),
        order_deposit AS (
            SELECT
                pa.target_order_id AS order_id,
                COALESCE(SUM((pa.metadata->>'applied_deposit_amount')::numeric(14,2)), 0::numeric) AS deposit_total
            FROM payment_allocations pa
            INNER JOIN fulfilled_orders fo ON fo.id = pa.target_order_id
            GROUP BY pa.target_order_id
        ),
        category_net AS (
            SELECT
                oi.order_id,
                SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14,2)) AS cat_net
            FROM order_items oi
            INNER JOIN products p ON p.id = oi.product_id
                AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
                AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
            LEFT JOIN (
                SELECT order_item_id, SUM(quantity_returned)::int AS returned
                FROM order_return_lines
                GROUP BY order_item_id
            ) orl ON orl.order_item_id = oi.id
            INNER JOIN fulfilled_orders fo ON fo.id = oi.order_id
            GROUP BY oi.order_id, oi.product_id
        ),
        order_net AS (
            SELECT order_id, SUM(cat_net)::numeric(14,2) AS order_net
            FROM category_net
            GROUP BY order_id
        ),
        alloc AS (
            SELECT
                cn.order_id,
                CASE
                    WHEN onet.order_net > 0
                        THEN ROUND(od.deposit_total * (cn.cat_net / onet.order_net), 2)
                    ELSE 0::numeric
                END AS alloc_amt,
                od.deposit_total
            FROM category_net cn
            INNER JOIN order_net onet ON onet.order_id = cn.order_id
            INNER JOIN order_deposit od ON od.order_id = cn.order_id
        )
        SELECT
            order_id,
            ABS(MAX(deposit_total) - SUM(alloc_amt))::numeric(14,2) AS drift
        FROM alloc
        GROUP BY order_id
        HAVING ABS(MAX(deposit_total) - SUM(alloc_amt)) > 0.01
        "#,
    )
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
            "Deposit release proportionality drift detected on {} orders (max ${:.2}); review category splits for rounding.",
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
            let mapped = qbo_map_with_misc_fallback(
                pool,
                "category_revenue",
                &cat_label,
                Some("REVENUE_CLOTHING"),
            )
            .await?;
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
                    memo: format!(
                        "Revenue — {}",
                        row.category_name.as_deref().unwrap_or("Uncategorized")
                    ),
                    detail: vec![serde_json::json!({
                        "category_id": row.category_id,
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
                    memo: format!(
                        "Revenue from deposit release — {}",
                        row.category_name.as_deref().unwrap_or("Uncategorized")
                    ),
                    detail: vec![serde_json::json!({
                        "category_id": row.category_id,
                        "release_amount": release_credit
                    })],
                });
            }
        }

        if cogs > Decimal::ZERO {
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
                    qbo_account_id: cogs_id.clone(),
                    qbo_account_name: cogs_nm.clone(),
                    debit: cogs,
                    credit: Decimal::ZERO,
                    memo: format!(
                        "COGS — {}",
                        row.category_name.as_deref().unwrap_or("Uncategorized")
                    ),
                    detail: vec![],
                });
                lines.push(JournalLine {
                    qbo_account_id: inv_id,
                    qbo_account_name: inv_nm,
                    debit: Decimal::ZERO,
                    credit: cogs,
                    memo: format!(
                        "Inventory relief — {}",
                        row.category_name.as_deref().unwrap_or("Uncategorized")
                    ),
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

    // 5. Forfeitures: recognize retained deposits for layaways cancelled as forfeited.
    #[derive(sqlx::FromRow)]
    struct ForfeitAgg {
        total_forfeited: Option<Decimal>,
    }
    let forfeit_row: ForfeitAgg = sqlx::query_as(
        r#"
        SELECT SUM(amount_paid)::numeric(14,2) AS total_forfeited
        FROM orders
        WHERE is_forfeited = TRUE
          AND (forfeited_at AT TIME ZONE 'UTC')::date = $1::date
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

    let rms_payment_net: Decimal = sqlx::query_scalar(&format!(
        r#"
        SELECT COALESCE(SUM((oi.unit_price * GREATEST(oi.quantity - COALESCE(orl.returned, 0), 0))::numeric(14, 2)), 0)::numeric(14, 2)
        {OI_EFFECTIVE_JOIN}
        WHERE o.status::text NOT IN ('cancelled')
          AND o.fulfilled_at IS NOT NULL
          AND (o.fulfilled_at AT TIME ZONE 'UTC')::date = $1::date
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

    let debits: Decimal = lines.iter().map(|l| l.debit).sum();
    let credits: Decimal = lines.iter().map(|l| l.credit).sum();
    let diff = debits - credits;
    let balanced = diff.is_zero();

    if !balanced {
        warnings.push(format!(
            "Journal not balanced by {diff:.2} (DR − CR). Review tender vs revenue/tax mappings before sync."
        ));
    }

    Ok(JournalProposal {
        activity_date,
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
