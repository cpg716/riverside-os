//! Proposed daily journal lines for QBO staging (mapping-first, review before push).
//!
//! Refunds: negative `payment_transactions` aggregate as **credits** to tender accounts (cash out).
//! Fulfillment-day revenue/COGS/tax use **effective** line qty (sold minus `transaction_return_lines`).
//! Returns recorded on `activity_date` add contra-revenue, tax, and (when restocked) COGS reversal
//! so refund-day journals stay balanced. See `docs/QBO_JOURNAL_TEST_MATRIX.md`.

use chrono::{NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::PgPool;
use std::collections::HashMap;
use uuid::Uuid;

use crate::logic::custom_orders::normalize_custom_item_type_key;

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
        Some("loyalty_giveaway") | Some("donated_giveaway")
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
    if let Some((aid, aname)) = qbo_map_name(pool, "MISC_FALLBACK", "default").await? {
        return Ok(Some((aid, format!("MISC: {aname} ({source_type})"))));
    }
    Ok(None)
}

/// Build a proposed journal for fulfilled-recognition day (UTC calendar date).
/// MVP: takeaway-style recognition only — fulfilled transactions with `fulfilled_at` on `activity_date`.
/// Deposits, partial pickups, and loyalty gift cards are flagged in `warnings`.
pub async fn propose_daily_journal(
    pool: &PgPool,
    activity_date: NaiveDate,
) -> Result<JournalProposal, sqlx::Error> {
    let mut warnings: Vec<String> = vec![
        "MVP journal: uses fulfilled transactions on this UTC date only. Deposit release posts from checkout `applied_deposit_amount` metadata; verify `liability_deposit` + revenue mappings before sync.".to_string(),
        "Gift card: purchased-card redemptions debit `liability_gift_card` / default; loyalty and donated cards debit `expense_loyalty` / default when checkout stores canonical gift card metadata. Unmapped cases fall back to tender mapping.".to_string(),
        "Revenue/COGS/tax for fulfilled transactions use effective qty (sold minus returns). Returns booked today add contra lines; re-run past dates after returns to restate fulfillment-day nets.".to_string(),
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
          AND oi.fulfilled_at IS NOT NULL
          AND (oi.fulfilled_at AT TIME ZONE 'UTC')::date = $1::date
          AND (p.pos_line_kind IS DISTINCT FROM 'rms_charge_payment')
          AND (p.pos_line_kind IS DISTINCT FROM 'pos_gift_card_load')
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

    #[derive(sqlx::FromRow)]
    struct TenderAgg {
        payment_method: String,
        sub_type: Option<String>,
        tender_family: Option<String>,
        rms_charge_collection: Option<bool>,
        total: Option<Decimal>,
        total_merchant_fee: Option<Decimal>,
    }

    let tender_rows: Vec<TenderAgg> = sqlx::query_as(
        r#"
        SELECT
            payment_method,
            NULLIF(TRIM(COALESCE(metadata->>'sub_type', '')), '') AS sub_type,
            NULLIF(TRIM(COALESCE(metadata->>'tender_family', '')), '') AS tender_family,
            BOOL_OR(COALESCE((metadata->>'rms_charge_collection')::boolean, FALSE)) AS rms_charge_collection,
            SUM(amount)::numeric(14, 2) AS total,
            SUM(merchant_fee)::numeric(14, 2) AS total_merchant_fee
        FROM payment_transactions
        WHERE (created_at AT TIME ZONE 'UTC')::date = $1::date
        GROUP BY
            payment_method,
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
        WHERE (booked_at AT TIME ZONE 'UTC')::date = $1::date
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
            SUM((it.unit_cost * it.quantity_delta)::numeric(14, 2)) AS total_value
        FROM inventory_transactions it
        INNER JOIN product_variants pv ON pv.id = it.variant_id
        INNER JOIN products p ON p.id = pv.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE (it.created_at AT TIME ZONE 'UTC')::date = $1::date
          AND it.tx_type::text IN ('adjustment', 'damaged', 'return_to_vendor', 'physical_inventory')
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
        if is_gift_card && !is_paid_liability_gc && !is_loyalty_gc {
            warnings.push(
                "Gift card payment missing/unknown card classification; expected purchased, loyalty, or donated card metadata. Falling back to tender mapping."
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
            } else if is_rms_financing {
                "RMS Charge financing (refund / reversal)".to_string()
            } else if is_rms_collection {
                format!("Tenders (RMS payment collection outflow) — {sid}")
            } else {
                format!("Tenders (refund/outflow) — {sid}")
            }
        } else if is_loyalty_gc && liability_gc.is_some() {
            "Gift card redemption (loyalty expense)".to_string()
        } else if is_paid_liability_gc && liability_gc.is_some() {
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
                "sub_type": t.sub_type,
                "tender_family": t.tender_family,
                "rms_charge_collection": t.rms_charge_collection,
                "amount": amt
            })],
        });

        // 2b. Stripe Fee Recon: If this is a Stripe transaction with reconciled fees,
        // post the fee as an expense and credit the clearing account (leaving the net in clearing).
        let fees = t.total_merchant_fee.unwrap_or(Decimal::ZERO);
        if sid.to_lowercase().contains("stripe") && !fees.is_zero() {
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

    // For fulfilled transactions, release previously held customer deposits into recognized revenue.
    let deposit_release_rows: Vec<DepositReleaseAgg> = sqlx::query_as(
        r#"
        WITH fulfilled_transactions AS (
            SELECT o.id
            FROM transactions o
            WHERE o.status::text NOT IN ('cancelled')
              AND o.fulfilled_at IS NOT NULL
              AND (o.fulfilled_at AT TIME ZONE 'UTC')::date = $1::date
        ),
        order_deposit AS (
            SELECT
                pa.target_transaction_id AS transaction_id,
                COALESCE(SUM((pa.metadata->>'applied_deposit_amount')::numeric(14,2)), 0::numeric) AS deposit_total
            FROM payment_allocations pa
            INNER JOIN fulfilled_transactions fo ON fo.id = pa.target_transaction_id
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
        "#,
    )
    .bind(activity_date)
    .fetch_all(pool)
    .await?;

    // Day-level verification: total releasable allocations should closely match deposit signals.
    let (deposit_total_day, release_total_day): (Option<Decimal>, Option<Decimal>) = sqlx::query_as(
        r#"
        WITH fulfilled_transactions AS (
            SELECT o.id
            FROM transactions o
            WHERE o.status::text NOT IN ('cancelled')
              AND o.fulfilled_at IS NOT NULL
              AND (o.fulfilled_at AT TIME ZONE 'UTC')::date = $1::date
        ),
        order_deposit AS (
            SELECT
                pa.target_transaction_id AS transaction_id,
                COALESCE(SUM((pa.metadata->>'applied_deposit_amount')::numeric(14,2)), 0::numeric) AS deposit_total
            FROM payment_allocations pa
            INNER JOIN fulfilled_transactions fo ON fo.id = pa.target_transaction_id
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
        WITH fulfilled_transactions AS (
            SELECT o.id
            FROM transactions o
            WHERE o.status::text NOT IN ('cancelled')
              AND o.fulfilled_at IS NOT NULL
              AND (o.fulfilled_at AT TIME ZONE 'UTC')::date = $1::date
        ),
        order_deposit AS (
            SELECT
                pa.target_transaction_id AS transaction_id,
                COALESCE(SUM((pa.metadata->>'applied_deposit_amount')::numeric(14,2)), 0::numeric) AS deposit_total
            FROM payment_allocations pa
            INNER JOIN fulfilled_transactions fo ON fo.id = pa.target_transaction_id
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
        let custom_mapping_key =
            row.custom_item_type.as_deref().and_then(normalize_custom_item_type_key);
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
                    .or(
                        qbo_map_with_misc_fallback(
                            pool,
                            "category_revenue",
                            &cat_label,
                            Some("REVENUE_CLOTHING"),
                        )
                        .await?,
                    )
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
                    memo: format!(
                        "Revenue — {}",
                        source_label
                    ),
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
                    memo: format!(
                        "Revenue from deposit release — {}",
                        source_label
                    ),
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
                    .or(
                        qbo_map_with_misc_fallback(
                            pool,
                            "category_inventory",
                            &cat_label,
                            Some("INV_ASSET"),
                        )
                        .await?,
                    )
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
                    .or(
                        qbo_map_with_misc_fallback(
                            pool,
                            "category_cogs",
                            &cat_label,
                            Some("COGS_DEFAULT"),
                        )
                        .await?,
                    )
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
                    memo: format!(
                        "COGS — {}",
                        source_label
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
                        source_label
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

    // 4.5. New Deposits: payments today for transactions NOT fulfilled today (liability increase).
    let deposit_inflow: Decimal = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(pt.amount), 0)::numeric(14,2)
        FROM payment_transactions pt
        INNER JOIN transactions o ON o.id = pt.transaction_id
        WHERE (pt.created_at AT TIME ZONE 'UTC')::date = $1::date
          AND (o.fulfilled_at IS NULL OR (o.fulfilled_at AT TIME ZONE 'UTC')::date > $1::date)
          AND o.status::text NOT IN ('cancelled')
        "#,
    )
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
        {TL_EFFECTIVE_JOIN}
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

    let rms_payment_reversal_net: Decimal = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(ABS(amount)) FILTER (
            WHERE amount < 0::numeric
              AND COALESCE((metadata->>'rms_charge_collection')::boolean, FALSE) = TRUE
        ), 0)::numeric(14, 2)
        FROM payment_transactions
        WHERE (created_at AT TIME ZONE 'UTC')::date = $1::date
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
        assert!(!gift_card_uses_loyalty_expense(Some("paid_liability")));
        assert!(!gift_card_uses_loyalty_expense(None));
    }
}
