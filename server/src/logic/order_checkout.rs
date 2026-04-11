//! POS checkout: split resolution, validation, and transactional persistence.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Error as SqlxError, PgPool};
use std::collections::{HashMap, HashSet};
use thiserror::Error;
use uuid::Uuid;

use crate::auth::pins::log_staff_access;
use crate::logic::checkout_validate;
use crate::logic::customer_open_deposit;
use crate::logic::gift_card_ops;
use crate::logic::order_fulfillment::persist_fulfillment;
use crate::logic::order_recalc;
use crate::logic::pos_rms_charge;
use crate::logic::pricing_limits;
use crate::logic::sales_commission;
use crate::logic::store_credit;
use crate::logic::tasks;
use crate::logic::tax::{erie_local_tax_usd, nys_state_tax_usd};
use crate::logic::weather;
use crate::logic::weddings as wedding_logic;
use crate::models::{
    DbFulfillmentType, DbOrderFulfillmentMethod, DbOrderStatus, DbTransactionCategory,
};
use crate::services::inventory;
use sqlx::types::Json;

#[derive(Debug, Error)]
pub enum CheckoutError {
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Deserialize)]
pub struct CheckoutItem {
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub fulfillment: DbFulfillmentType,
    pub quantity: i32,
    pub unit_price: Decimal,
    pub original_unit_price: Option<Decimal>,
    pub price_override_reason: Option<String>,
    pub unit_cost: Decimal,
    pub state_tax: Decimal,
    pub local_tax: Decimal,
    #[serde(default)]
    pub salesperson_id: Option<Uuid>,
    #[serde(default)]
    pub discount_event_id: Option<Uuid>,
    /// Purchased-card code for `pos_gift_card_load` internal lines (credit on fully paid checkout).
    #[serde(default)]
    pub gift_card_load_code: Option<String>,
    #[serde(default)]
    pub custom_item_type: Option<String>,
    #[serde(default)]
    pub is_rush: bool,
    pub need_by_date: Option<chrono::NaiveDate>,
    #[serde(default)]
    pub needs_gift_wrap: bool,
}

#[derive(Debug, Deserialize)]
pub struct WeddingDisbursement {
    pub wedding_member_id: Uuid,
    pub amount: Decimal,
}

#[derive(Debug, Deserialize)]
pub struct CheckoutRequest {
    pub session_id: Uuid,
    pub operator_staff_id: Uuid,
    #[serde(default)]
    pub primary_salesperson_id: Option<Uuid>,
    pub customer_id: Option<Uuid>,
    pub wedding_member_id: Option<Uuid>,
    pub payment_method: String,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    pub items: Vec<CheckoutItem>,
    #[serde(default)]
    pub actor_name: Option<String>,
    #[serde(default)]
    pub payment_splits: Option<Vec<CheckoutPaymentSplit>>,
    #[serde(default)]
    pub wedding_disbursements: Option<Vec<WeddingDisbursement>>,
    #[serde(default)]
    pub checkout_client_id: Option<Uuid>,
    /// Consumed at checkout (single use); amount included in `total_price` validation.
    #[serde(default)]
    pub shipping_rate_quote_id: Option<Uuid>,
    /// If set, the checkout is (at least partially) a payment against this existing order.
    #[serde(default)]
    pub target_order_id: Option<Uuid>,
    #[serde(default)]
    pub is_rush: bool,
    #[serde(default)]
    pub need_by_date: Option<chrono::NaiveDate>,
}

#[derive(Debug, Deserialize)]
pub struct CheckoutPaymentSplit {
    pub payment_method: String,
    pub amount: Decimal,
    #[serde(default)]
    pub sub_type: Option<String>,
    #[serde(default)]
    pub applied_deposit_amount: Option<Decimal>,
    #[serde(default)]
    pub gift_card_code: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CheckoutResponse {
    pub order_id: Uuid,
    pub status: String,
    pub loyalty_points_earned: i32,
    pub loyalty_points_balance: Option<i32>,
}

#[derive(Debug)]
pub struct ResolvedPaymentSplit {
    pub method: String,
    pub amount: Decimal,
    pub gift_card_code: Option<String>,
    pub metadata: serde_json::Value,
}

fn takeaway_line_total_decimal(items: &[CheckoutItem]) -> Decimal {
    let mut s = Decimal::ZERO;
    for i in items {
        if i.fulfillment != DbFulfillmentType::Takeaway {
            continue;
        }
        s += (i.unit_price + i.state_tax + i.local_tax) * Decimal::from(i.quantity);
    }
    s.round_dp(2)
}

fn tender_sum_excluding_deposit_like(splits: &[ResolvedPaymentSplit]) -> Decimal {
    let mut s = Decimal::ZERO;
    for sp in splits {
        let m = sp.method.trim().to_ascii_lowercase();
        if m == "deposit_ledger" || m == "open_deposit" {
            continue;
        }
        s += sp.amount;
    }
    s.round_dp(2)
}

#[derive(Debug)]
pub enum CheckoutDone {
    Idempotent {
        order_id: Uuid,
    },
    Completed {
        order_id: Uuid,
        operator_staff_id: Uuid,
        customer_id: Option<Uuid>,
        price_override_audit: Vec<Value>,
        amount_paid: Decimal,
        total_price: Decimal,
    },
}

async fn staff_id_active(pool: &PgPool, id: Uuid) -> Result<bool, CheckoutError> {
    let ok: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE id = $1 AND is_active = TRUE)")
            .bind(id)
            .fetch_one(pool)
            .await?;
    Ok(ok)
}

/// One bundle cart line becomes multiple component lines (inventory, tax, commission) using
/// retail-weighted apportionment of the bundle unit price.
async fn expand_bundle_checkout_items(
    pool: &PgPool,
    global_employee_markup: Decimal,
    items: Vec<CheckoutItem>,
) -> Result<Vec<CheckoutItem>, CheckoutError> {
    let mut out = Vec::new();
    for item in items {
        let is_bundle: bool =
            sqlx::query_scalar("SELECT COALESCE(is_bundle, false) FROM products WHERE id = $1")
                .bind(item.product_id)
                .fetch_optional(pool)
                .await?
                .unwrap_or(false);

        if !is_bundle {
            out.push(item);
            continue;
        }

        if item.discount_event_id.is_some() {
            return Err(CheckoutError::InvalidPayload(
                "Discount events cannot be applied to bundle package lines".to_string(),
            ));
        }

        let rows: Vec<(Uuid, i32)> = sqlx::query_as(
            r#"
            SELECT component_variant_id, quantity
            FROM product_bundle_components
            WHERE bundle_product_id = $1
            "#,
        )
        .bind(item.product_id)
        .fetch_all(pool)
        .await?;

        if rows.is_empty() {
            return Err(CheckoutError::InvalidPayload(
                "Bundle product has no components configured".to_string(),
            ));
        }

        #[derive(Clone)]
        struct Comp {
            product_id: Uuid,
            variant_id: Uuid,
            comp_qty: i32,
            retail: Decimal,
            unit_cost: Decimal,
            tax_category: crate::logic::tax::TaxCategory,
        }

        let mut comps: Vec<Comp> = Vec::new();
        let mut w_sum = Decimal::ZERO;
        for (comp_variant_id, comp_qty) in rows {
            if comp_qty <= 0 {
                return Err(CheckoutError::InvalidPayload(
                    "Invalid bundle component quantity".to_string(),
                ));
            }
            let pid: Uuid =
                sqlx::query_scalar("SELECT product_id FROM product_variants WHERE id = $1")
                    .bind(comp_variant_id)
                    .fetch_optional(pool)
                    .await?
                    .ok_or_else(|| {
                        CheckoutError::InvalidPayload(format!(
                            "Bundle component variant {comp_variant_id} not found"
                        ))
                    })?;

            let resolved =
                inventory::fetch_variant_by_ids(pool, comp_variant_id, pid, global_employee_markup)
                    .await
                    .map_err(|e| match e {
                        inventory::InventoryError::SkuNotFound(s) => {
                            CheckoutError::InvalidPayload(format!("bundle component: {s}"))
                        }
                        inventory::InventoryError::AmbiguousProduct(m) => {
                            CheckoutError::InvalidPayload(m)
                        }
                        inventory::InventoryError::Unauthorized(m) => {
                            CheckoutError::InvalidPayload(m)
                        }
                        inventory::InventoryError::Database(d) => CheckoutError::Database(d),
                    })?;

            let w = resolved.standard_retail_price * Decimal::from(comp_qty);
            w_sum += w;
            comps.push(Comp {
                product_id: pid,
                variant_id: comp_variant_id,
                comp_qty,
                retail: resolved.standard_retail_price,
                unit_cost: resolved.unit_cost,
                tax_category: resolved.tax_category,
            });
        }

        if w_sum <= Decimal::ZERO {
            return Err(CheckoutError::InvalidPayload(
                "Bundle has zero retail weight; check component prices".to_string(),
            ));
        }

        let target_total = (item.unit_price * Decimal::from(item.quantity)).round_dp(2);
        let n = comps.len();
        let mut extensions: Vec<Decimal> = Vec::with_capacity(n);
        for (i, c) in comps.iter().enumerate() {
            let raw = target_total * c.retail * Decimal::from(c.comp_qty) / w_sum;
            if i + 1 == n {
                let allocated: Decimal = extensions.iter().copied().sum();
                extensions.push((target_total - allocated).max(Decimal::ZERO).round_dp(2));
            } else {
                extensions.push(raw.round_dp(2));
            }
        }

        let parent_has_override = item
            .price_override_reason
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);

        for (c, ext) in comps.into_iter().zip(extensions) {
            let line_qty = c.comp_qty * item.quantity;
            if line_qty <= 0 {
                continue;
            }
            let unit_price = (ext / Decimal::from(line_qty)).round_dp(2);
            let state_tax = nys_state_tax_usd(c.tax_category, unit_price, unit_price);
            let local_tax = erie_local_tax_usd(c.tax_category, unit_price, unit_price);

            let (price_override_reason, original_unit_price) = if parent_has_override {
                (
                    item.price_override_reason.clone(),
                    Some(c.retail).or(item.original_unit_price),
                )
            } else {
                (
                    Some("Bundle package (apportioned)".to_string()),
                    Some(c.retail),
                )
            };

            out.push(CheckoutItem {
                product_id: c.product_id,
                variant_id: c.variant_id,
                fulfillment: item.fulfillment,
                quantity: line_qty,
                unit_price,
                original_unit_price,
                price_override_reason,
                unit_cost: c.unit_cost,
                state_tax,
                local_tax,
                salesperson_id: item.salesperson_id,
                discount_event_id: None,
                gift_card_load_code: None,
                custom_item_type: item.custom_item_type.clone(),
                is_rush: item.is_rush,
                need_by_date: item.need_by_date,
                needs_gift_wrap: item.needs_gift_wrap,
            });
        }
    }
    Ok(out)
}

/// Builds normalized split rows and a human-readable label for wedding activity / receipts.
fn resolve_payment_splits(
    payload: &CheckoutRequest,
) -> Result<(Vec<ResolvedPaymentSplit>, String), CheckoutError> {
    #[derive(Debug)]
    struct ParsedSplit {
        method: String,
        amount: Decimal,
        sub_type: Option<String>,
        applied_deposit_amount: Decimal,
        gift_card_code: Option<String>,
    }

    let amount_paid = payload.amount_paid.round_dp(2);

    if let Some(ref splits) = payload.payment_splits {
        if !splits.is_empty() {
            let mut out: Vec<ResolvedPaymentSplit> = Vec::new();
            let mut parsed: Vec<ParsedSplit> = Vec::new();
            let mut sum = Decimal::ZERO;
            let mut deposit_sum = Decimal::ZERO;
            for line in splits {
                let m = line.payment_method.trim();
                if m.is_empty() || m.len() > 50 {
                    return Err(CheckoutError::InvalidPayload(
                        "each split needs payment_method (max 50 characters)".to_string(),
                    ));
                }
                if m.eq_ignore_ascii_case("gift_card") {
                    let st = line
                        .sub_type
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| {
                            CheckoutError::InvalidPayload(
                                "gift_card split requires sub_type (`paid_liability`, `loyalty_giveaway`, or `donated_giveaway`)".to_string(),
                            )
                        })?;
                    if st != "paid_liability"
                        && st != "loyalty_giveaway"
                        && st != "donated_giveaway"
                    {
                        return Err(CheckoutError::InvalidPayload(
                            "gift_card sub_type must be `paid_liability`, `loyalty_giveaway`, or `donated_giveaway`".to_string(),
                        ));
                    }
                } else if line
                    .sub_type
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .is_some()
                {
                    return Err(CheckoutError::InvalidPayload(
                        "sub_type is only allowed for gift_card payment_method".to_string(),
                    ));
                }
                let a = line.amount.round_dp(2);
                if a <= Decimal::ZERO {
                    return Err(CheckoutError::InvalidPayload(
                        "split amounts must be positive".to_string(),
                    ));
                }
                sum += a;
                let sub_type = line
                    .sub_type
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_ascii_lowercase());
                let applied_deposit_amount = line
                    .applied_deposit_amount
                    .unwrap_or(Decimal::ZERO)
                    .round_dp(2);
                if applied_deposit_amount < Decimal::ZERO {
                    return Err(CheckoutError::InvalidPayload(
                        "applied_deposit_amount cannot be negative".to_string(),
                    ));
                }
                if applied_deposit_amount > a {
                    return Err(CheckoutError::InvalidPayload(
                        "applied_deposit_amount cannot exceed split amount".to_string(),
                    ));
                }
                deposit_sum += applied_deposit_amount;
                let gift_card_code = line
                    .gift_card_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                parsed.push(ParsedSplit {
                    method: m.to_string(),
                    amount: a,
                    sub_type,
                    applied_deposit_amount,
                    gift_card_code,
                });
            }
            if sum.round_dp(2) != amount_paid {
                return Err(CheckoutError::InvalidPayload(
                    "payment_splits must sum to amount_paid".to_string(),
                ));
            }
            if deposit_sum > amount_paid {
                return Err(CheckoutError::InvalidPayload(
                    "sum(applied_deposit_amount) cannot exceed amount_paid".to_string(),
                ));
            }
            for p in parsed {
                let metadata = json!({
                    "sub_type": p.sub_type,
                    "applied_deposit_amount": p.applied_deposit_amount,
                    "gift_card_code": p.gift_card_code,
                });
                out.push(ResolvedPaymentSplit {
                    method: p.method,
                    amount: p.amount,
                    gift_card_code: p.gift_card_code,
                    metadata,
                });
            }
            let label = if out.len() == 1 {
                out[0].method.clone()
            } else {
                out.iter()
                    .map(|s| format!("{} ${}", s.method, s.amount))
                    .collect::<Vec<_>>()
                    .join(" + ")
            };
            return Ok((out, label));
        }
    }

    let m = payload.payment_method.trim();
    if m.is_empty() || m.len() > 50 {
        return Err(CheckoutError::InvalidPayload(
            "payment_method is required (max 50 characters)".to_string(),
        ));
    }
    Ok((
        vec![ResolvedPaymentSplit {
            method: m.to_string(),
            amount: amount_paid,
            gift_card_code: None,
            metadata: json!({}),
        }],
        m.to_string(),
    ))
}

pub async fn execute_checkout(
    pool: &PgPool,
    http: &reqwest::Client,
    global_employee_markup: Decimal,
    mut payload: CheckoutRequest,
) -> Result<CheckoutDone, CheckoutError> {
    if payload.items.is_empty() {
        return Err(CheckoutError::InvalidPayload(
            "Cart cannot be empty".to_string(),
        ));
    }

    let customer_id_orig = payload.customer_id;
    if let Some(cid) = payload.customer_id {
        payload.customer_id =
            Some(crate::logic::customer_couple::resolve_effective_customer_id(pool, cid).await?);
    }

    for item in &payload.items {
        if item.quantity <= 0 {
            return Err(CheckoutError::InvalidPayload(format!(
                "Invalid quantity for variant {}",
                item.variant_id
            )));
        }
    }

    if !staff_id_active(pool, payload.operator_staff_id).await? {
        return Err(CheckoutError::InvalidPayload(
            "operator_staff_id is invalid or inactive".to_string(),
        ));
    }
    if let Some(pid) = payload.primary_salesperson_id {
        if !staff_id_active(pool, pid).await? {
            return Err(CheckoutError::InvalidPayload(
                "primary_salesperson_id is invalid or inactive".to_string(),
            ));
        }
    }
    for item in &payload.items {
        if let Some(sid) = item.salesperson_id {
            if !staff_id_active(pool, sid).await? {
                return Err(CheckoutError::InvalidPayload(format!(
                    "salesperson_id invalid for variant {}",
                    item.variant_id
                )));
            }
        }
    }

    payload.items = expand_bundle_checkout_items(
        pool,
        global_employee_markup,
        std::mem::take(&mut payload.items),
    )
    .await?;

    // Cart JSON / local persistence can hold a stale product_id after catalog moves; resolve by variant.
    for item in &mut payload.items {
        let resolved =
            inventory::resolve_variant_by_id(pool, item.variant_id, global_employee_markup)
                .await
                .map_err(|e| match e {
                    inventory::InventoryError::SkuNotFound(s) => {
                        CheckoutError::InvalidPayload(format!("checkout line: {s}"))
                    }
                    inventory::InventoryError::AmbiguousProduct(m) => {
                        CheckoutError::InvalidPayload(m)
                    }
                    inventory::InventoryError::Unauthorized(m) => CheckoutError::InvalidPayload(m),
                    inventory::InventoryError::Database(d) => CheckoutError::Database(d),
                })?;
        if item.product_id != resolved.product_id {
            tracing::warn!(
                variant_id = %item.variant_id,
                cart_product_id = %item.product_id,
                catalog_product_id = %resolved.product_id,
                "checkout: normalized line product_id to match active variant catalog"
            );
            item.product_id = resolved.product_id;
        }
    }

    let mut is_rms_payment_collection = false;
    {
        let mut rms_line_count = 0usize;
        for item in &payload.items {
            let resolved = inventory::fetch_variant_by_ids(
                pool,
                item.variant_id,
                item.product_id,
                global_employee_markup,
            )
            .await
            .map_err(|e| match e {
                inventory::InventoryError::SkuNotFound(s) => {
                    CheckoutError::InvalidPayload(format!("checkout line: {s}"))
                }
                inventory::InventoryError::AmbiguousProduct(m) => CheckoutError::InvalidPayload(m),
                inventory::InventoryError::Unauthorized(m) => CheckoutError::InvalidPayload(m),
                inventory::InventoryError::Database(d) => CheckoutError::Database(d),
            })?;
            if resolved.pos_line_kind.as_deref() == Some("rms_charge_payment") {
                rms_line_count += 1;
            }
        }
        if rms_line_count > 0 {
            if payload.items.len() != 1 || payload.items[0].quantity != 1 {
                return Err(CheckoutError::InvalidPayload(
                    "RMS CHARGE PAYMENT cannot be combined with other items and must be quantity 1"
                        .to_string(),
                ));
            }
            let r0 = inventory::fetch_variant_by_ids(
                pool,
                payload.items[0].variant_id,
                payload.items[0].product_id,
                global_employee_markup,
            )
            .await
            .map_err(|e| match e {
                inventory::InventoryError::SkuNotFound(s) => {
                    CheckoutError::InvalidPayload(format!("checkout line: {s}"))
                }
                inventory::InventoryError::AmbiguousProduct(m) => CheckoutError::InvalidPayload(m),
                inventory::InventoryError::Unauthorized(m) => CheckoutError::InvalidPayload(m),
                inventory::InventoryError::Database(d) => CheckoutError::Database(d),
            })?;
            if r0.pos_line_kind.as_deref() != Some("rms_charge_payment") {
                return Err(CheckoutError::InvalidPayload(
                    "Invalid RMS payment line".to_string(),
                ));
            }
            is_rms_payment_collection = true;
        }
    }

    let mut has_pos_gift_card_load = false;
    let mut gc_load_codes: HashSet<String> = HashSet::new();
    for item in &payload.items {
        let resolved = inventory::fetch_variant_by_ids(
            pool,
            item.variant_id,
            item.product_id,
            global_employee_markup,
        )
        .await
        .map_err(|e| match e {
            inventory::InventoryError::SkuNotFound(s) => {
                CheckoutError::InvalidPayload(format!("checkout line: {s}"))
            }
            inventory::InventoryError::AmbiguousProduct(m) => CheckoutError::InvalidPayload(m),
            inventory::InventoryError::Unauthorized(m) => CheckoutError::InvalidPayload(m),
            inventory::InventoryError::Database(d) => CheckoutError::Database(d),
        })?;
        let kind = resolved.pos_line_kind.as_deref();
        let has_code = item
            .gift_card_load_code
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some();
        if has_code && kind != Some("pos_gift_card_load") {
            return Err(CheckoutError::InvalidPayload(
                "gift_card_load_code is only allowed on POS gift card load lines".to_string(),
            ));
        }
        if kind == Some("pos_gift_card_load") {
            has_pos_gift_card_load = true;
            let code = item
                .gift_card_load_code
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    CheckoutError::InvalidPayload(
                        "POS gift card load lines require gift_card_load_code".to_string(),
                    )
                })?;
            if item.quantity != 1 {
                return Err(CheckoutError::InvalidPayload(
                    "POS gift card load must have quantity 1".to_string(),
                ));
            }
            let norm = code.to_ascii_uppercase();
            if !gc_load_codes.insert(norm) {
                return Err(CheckoutError::InvalidPayload(
                    "Duplicate gift card load code in the same checkout".to_string(),
                ));
            }
        }
    }

    if is_rms_payment_collection {
        if payload.customer_id.is_none() {
            return Err(CheckoutError::InvalidPayload(
                "RMS CHARGE PAYMENT requires a linked customer".to_string(),
            ));
        }
        if payload.wedding_member_id.is_some() {
            return Err(CheckoutError::InvalidPayload(
                "RMS CHARGE PAYMENT cannot be used with wedding member checkout".to_string(),
            ));
        }
        if payload
            .wedding_disbursements
            .as_ref()
            .map(|d| !d.is_empty())
            .unwrap_or(false)
        {
            return Err(CheckoutError::InvalidPayload(
                "RMS CHARGE PAYMENT does not support wedding disbursements".to_string(),
            ));
        }
    }

    let max_disc_pct =
        pricing_limits::max_discount_percent_for_staff(pool, payload.operator_staff_id).await?;

    for item in &payload.items {
        let has_ov = item
            .price_override_reason
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !has_ov {
            continue;
        }
        let resolved = inventory::fetch_variant_by_ids(
            pool,
            item.variant_id,
            item.product_id,
            global_employee_markup,
        )
        .await
        .map_err(|e| match e {
            inventory::InventoryError::SkuNotFound(s) => {
                CheckoutError::InvalidPayload(format!("checkout line: {s}"))
            }
            inventory::InventoryError::AmbiguousProduct(m) => CheckoutError::InvalidPayload(m),
            inventory::InventoryError::Unauthorized(m) => CheckoutError::InvalidPayload(m),
            inventory::InventoryError::Database(d) => CheckoutError::Database(d),
        })?;
        let retail = resolved.standard_retail_price;
        if retail <= Decimal::ZERO {
            continue;
        }
        if item.unit_price >= retail {
            continue;
        }
        let pct_off = ((retail - item.unit_price) / retail) * Decimal::from(100);
        let tol = Decimal::new(5, 1);
        if pct_off > max_disc_pct + tol {
            return Err(CheckoutError::InvalidPayload(format!(
                "Line discount {:.2}% exceeds role maximum {:.2}% for this register operator",
                pct_off.round_dp(2),
                max_disc_pct
            )));
        }
    }

    let mut discount_event_labels: HashMap<usize, String> = HashMap::new();
    for (idx, item) in payload.items.iter().enumerate() {
        let Some(eid) = item.discount_event_id else {
            continue;
        };
        let resolved = inventory::fetch_variant_by_ids(
            pool,
            item.variant_id,
            item.product_id,
            global_employee_markup,
        )
        .await
        .map_err(|e| match e {
            inventory::InventoryError::SkuNotFound(s) => {
                CheckoutError::InvalidPayload(format!("checkout line: {s}"))
            }
            inventory::InventoryError::AmbiguousProduct(m) => CheckoutError::InvalidPayload(m),
            inventory::InventoryError::Unauthorized(m) => CheckoutError::InvalidPayload(m),
            inventory::InventoryError::Database(d) => CheckoutError::Database(d),
        })?;
        if resolved.pos_line_kind.as_deref() == Some("rms_charge_payment") {
            return Err(CheckoutError::InvalidPayload(
                "Discount events cannot apply to RMS CHARGE PAYMENT".to_string(),
            ));
        }
        if resolved.pos_line_kind.as_deref() == Some("pos_gift_card_load") {
            return Err(CheckoutError::InvalidPayload(
                "Discount events cannot apply to POS GIFT CARD LOAD".to_string(),
            ));
        }
        let row: Option<(Decimal, String, bool)> = sqlx::query_as(
            r#"
            SELECT de.percent_off, de.receipt_label, de.is_active
            FROM discount_events de
            WHERE de.id = $1
              AND de.starts_at <= now()
              AND de.ends_at >= now()
              AND (
                (
                  de.scope_type = 'variants'
                  AND EXISTS (
                    SELECT 1 FROM discount_event_variants dv
                    WHERE dv.event_id = de.id AND dv.variant_id = $2
                  )
                )
                OR (
                  de.scope_type = 'category'
                  AND de.scope_category_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM products p
                    WHERE p.id = $3 AND p.category_id = de.scope_category_id
                  )
                )
                OR (
                  de.scope_type = 'vendor'
                  AND de.scope_vendor_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM products p
                    WHERE p.id = $3 AND p.primary_vendor_id = de.scope_vendor_id
                  )
                )
              )
            "#,
        )
        .bind(eid)
        .bind(item.variant_id)
        .bind(item.product_id)
        .fetch_optional(pool)
        .await?;
        let Some((pct_off, receipt_label, is_active)) = row else {
            return Err(CheckoutError::InvalidPayload(
                "discount_event_id is not valid for this variant, dates, or is inactive"
                    .to_string(),
            ));
        };
        if !is_active {
            return Err(CheckoutError::InvalidPayload(
                "discount event is not active".to_string(),
            ));
        }
        let retail = resolved.standard_retail_price;
        let expected_unit =
            (retail * (Decimal::from(100) - pct_off) / Decimal::from(100)).round_dp(2);
        if !checkout_validate::money_close_decimal(item.unit_price, expected_unit) {
            return Err(CheckoutError::InvalidPayload(format!(
                "unit price for variant {} does not match discount event {:.2}% off retail",
                item.variant_id, pct_off
            )));
        }
        discount_event_labels.insert(idx, receipt_label);
    }

    let (payment_splits, payment_activity_label) = resolve_payment_splits(&payload)?;

    let has_rms_charge = payment_splits
        .iter()
        .any(|s| pos_rms_charge::is_rms_method(&s.method));

    for s in &payment_splits {
        if s.method.trim().eq_ignore_ascii_case("store_credit") && payload.customer_id.is_none() {
            return Err(CheckoutError::InvalidPayload(
                "store_credit payment requires customer_id on checkout".to_string(),
            ));
        }
        if s.method.trim().eq_ignore_ascii_case("open_deposit") && payload.customer_id.is_none() {
            return Err(CheckoutError::InvalidPayload(
                "open_deposit payment requires customer_id on checkout".to_string(),
            ));
        }
    }

    if is_rms_payment_collection {
        for s in &payment_splits {
            let m = s.method.trim().to_ascii_lowercase();
            if m != "cash" && m != "check" {
                return Err(CheckoutError::InvalidPayload(
                    "RMS CHARGE PAYMENT accepts cash or check only".to_string(),
                ));
            }
        }
    }

    let lines_snap: Vec<checkout_validate::CheckoutLineSnapshot> = payload
        .items
        .iter()
        .map(|i| {
            let has_ov = i
                .price_override_reason
                .as_ref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
                || i.discount_event_id.is_some();
            checkout_validate::CheckoutLineSnapshot {
                product_id: i.product_id,
                variant_id: i.variant_id,
                quantity: i.quantity,
                unit_price: i.unit_price,
                unit_cost: i.unit_cost,
                state_tax: i.state_tax,
                local_tax: i.local_tax,
                has_price_override: has_ov,
            }
        })
        .collect();

    let sum_lines = checkout_validate::validate_checkout_lines_and_sum(
        pool,
        global_employee_markup,
        &lines_snap,
    )
    .await
    .map_err(|e| match e {
        checkout_validate::CheckoutValidateError::Invalid(m) => CheckoutError::InvalidPayload(m),
        checkout_validate::CheckoutValidateError::Inventory(inv) => match inv {
            crate::services::inventory::InventoryError::SkuNotFound(s) => {
                CheckoutError::InvalidPayload(format!("checkout line: {s}"))
            }
            crate::services::inventory::InventoryError::AmbiguousProduct(m) => {
                CheckoutError::InvalidPayload(m)
            }
            crate::services::inventory::InventoryError::Unauthorized(m) => {
                CheckoutError::InvalidPayload(m)
            }
            crate::services::inventory::InventoryError::Database(d) => CheckoutError::Database(d),
        },
    })?;

    for d in payload.wedding_disbursements.as_deref().unwrap_or(&[]) {
        if d.amount < Decimal::ZERO {
            return Err(CheckoutError::InvalidPayload(
                "wedding disbursement amounts must be non-negative".to_string(),
            ));
        }
    }

    let mut sum_expected = sum_lines;

    let shipping_quote_id = payload.shipping_rate_quote_id;
    let shipping_peek_amt: Option<Decimal> = if let Some(qid) = shipping_quote_id {
        let row: Option<Decimal> = sqlx::query_scalar(
            r#"
            SELECT amount_usd FROM store_shipping_rate_quote
            WHERE id = $1 AND expires_at > NOW()
            "#,
        )
        .bind(qid)
        .fetch_optional(pool)
        .await?;
        Some(row.ok_or_else(|| {
            CheckoutError::InvalidPayload(
                "invalid or expired shipping quote — refresh shipping rates".to_string(),
            )
        })?)
    } else {
        None
    };

    if let Some(sa) = shipping_peek_amt {
        sum_expected += sa;
    }

    let tol = Decimal::new(2, 2);
    if (payload.total_price - sum_expected).abs() > tol {
        return Err(CheckoutError::InvalidPayload(
            "total_price does not match server-calculated sum of cart lines and shipping (party disbursements are paid separately and are not included in total_price)"
                .to_string(),
        ));
    }

    let d_total: Decimal = payload
        .wedding_disbursements
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|d| d.amount)
        .sum::<Decimal>()
        .round_dp(2);

    if d_total > payload.amount_paid + tol {
        return Err(CheckoutError::InvalidPayload(
            "party disbursements cannot exceed amount collected".to_string(),
        ));
    }

    let amount_toward_order = (payload.amount_paid - d_total).round_dp(2);
    if amount_toward_order < Decimal::ZERO {
        return Err(CheckoutError::InvalidPayload(
            "amount collected is less than party disbursements".to_string(),
        ));
    }

    if amount_toward_order > payload.total_price + tol {
        return Err(CheckoutError::InvalidPayload(
            "amount applied to this order exceeds total_price — reduce tenders or adjust party disbursements"
                .to_string(),
        ));
    }

    let balance_due = (payload.total_price - amount_toward_order).round_dp(2);
    if balance_due < Decimal::ZERO {
        return Err(CheckoutError::InvalidPayload(
            "order balance due cannot be negative".to_string(),
        ));
    }

    let takeaway_total = takeaway_line_total_decimal(&payload.items);
    let tender_ex_deposit = tender_sum_excluding_deposit_like(&payment_splits);
    if takeaway_total > Decimal::ZERO && tender_ex_deposit + tol < takeaway_total {
        return Err(CheckoutError::InvalidPayload(
            "Takeaway merchandise and tax must be paid in full with cash-equivalent tenders (deposit ledger and open deposit cannot satisfy takeaway-only amounts)."
                .to_string(),
        ));
    }

    if takeaway_total > Decimal::ZERO && amount_toward_order + tol < takeaway_total {
        return Err(CheckoutError::InvalidPayload(
            "Takeaway merchandise and tax must be fully covered before leaving a balance on special-order lines."
                .to_string(),
        ));
    }

    let is_layaway = payload
        .items
        .iter()
        .any(|i| i.fulfillment == DbFulfillmentType::Layaway);
    if is_layaway {
        if payload.customer_id.is_none() {
            return Err(CheckoutError::InvalidPayload(
                "Layaway requires a linked customer".to_string(),
            ));
        }
        let min_deposit = (payload.total_price * Decimal::new(25, 2)).round_dp(2);
        if amount_toward_order < min_deposit {
            let can_override = pricing_limits::is_admin_or_manager(pool, payload.operator_staff_id)
                .await
                .map_err(CheckoutError::Database)?;
            if !can_override {
                return Err(CheckoutError::InvalidPayload(format!(
                    "Layaway requires a 25% minimum deposit (${min_deposit:.2}). Amount collected (${amount_toward_order:.2}) is insufficient."
                )));
            }
        }
    }

    let is_fully_paid = balance_due.is_zero();
    if has_pos_gift_card_load && !is_fully_paid {
        return Err(CheckoutError::InvalidPayload(
            "POS gift card load requires the sale to be fully paid. Finish payment or remove load lines."
                .to_string(),
        ));
    }
    let all_takeaway = payload
        .items
        .iter()
        .all(|i| i.fulfillment == DbFulfillmentType::Takeaway);

    let ship_order = shipping_quote_id.is_some();

    let order_status = if is_fully_paid && all_takeaway && !ship_order {
        DbOrderStatus::Fulfilled
    } else {
        DbOrderStatus::Open
    };

    let set_fulfilled_at = order_status == DbOrderStatus::Fulfilled;

    let mut price_override_audit: Vec<Value> = Vec::new();

    let mut tx = pool.begin().await?;

    if let Some(cid) = payload.checkout_client_id {
        let existing: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM orders WHERE checkout_client_id = $1")
                .bind(cid)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(oid) = existing {
            tx.commit().await?;
            tracing::info!(order_id = %oid, "checkout idempotent replay");
            return Ok(CheckoutDone::Idempotent { order_id: oid });
        }
    }

    let session_ok: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM register_sessions
            WHERE id = $1 AND is_open = true
        )
        "#,
    )
    .bind(payload.session_id)
    .fetch_one(&mut *tx)
    .await?;

    if !session_ok {
        return Err(CheckoutError::InvalidPayload(
            "Register session is not open or invalid".to_string(),
        ));
    }

    let (order_fulfillment_method, order_ship_to, order_shipping_amt, pos_shippo_rate_object_id): (
        DbOrderFulfillmentMethod,
        Option<Json<serde_json::Value>>,
        Option<Decimal>,
        Option<String>,
    ) = if let Some(qid) = shipping_quote_id {
        let row: Option<(Decimal, serde_json::Value, Option<String>)> = sqlx::query_as(
            r#"
            DELETE FROM store_shipping_rate_quote
            WHERE id = $1 AND expires_at > NOW()
            RETURNING amount_usd, metadata, shippo_rate_object_id
            "#,
        )
        .bind(qid)
        .fetch_optional(&mut *tx)
        .await?;
        let (amt, meta, shippo_rate_object_id) = row.ok_or_else(|| {
            CheckoutError::InvalidPayload(
                "shipping quote is no longer valid — refresh rates and try again".to_string(),
            )
        })?;
        let peek = shipping_peek_amt.ok_or_else(|| {
            CheckoutError::InvalidPayload("shipping quote state error".to_string())
        })?;
        if amt != peek {
            return Err(CheckoutError::InvalidPayload(
                "shipping quote amount mismatch — refresh rates".to_string(),
            ));
        }
        let st = meta.get("ship_to").cloned().ok_or_else(|| {
            CheckoutError::InvalidPayload("shipping quote missing address snapshot".to_string())
        })?;
        (
            DbOrderFulfillmentMethod::Ship,
            Some(Json(st)),
            Some(amt),
            shippo_rate_object_id,
        )
    } else {
        (DbOrderFulfillmentMethod::Pickup, None, None, None)
    };

    let today = chrono::Utc::now().date_naive();
    let weather_json = weather::fetch_weather_range(http, pool, today, today)
        .await
        .into_iter()
        .next()
        .and_then(|w| serde_json::to_value(w).ok());

    let ship_to_snapshot_for_registry = order_ship_to
        .as_ref()
        .map(|j| j.0.clone())
        .unwrap_or_else(|| json!({}));

    let is_employee_purchase_order: bool = if let Some(cid) = customer_id_orig {
        sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(SELECT 1 FROM staff WHERE employee_customer_id = $1)"#,
        )
        .bind(cid)
        .fetch_one(&mut *tx)
        .await?
    } else {
        false
    };

    let order_insert = sqlx::query_scalar::<_, Uuid>(
        r#"
        INSERT INTO orders (
            customer_id, wedding_member_id, operator_id, primary_salesperson_id,
            total_price, amount_paid, balance_due, status, booked_at, fulfilled_at,
            weather_snapshot, checkout_client_id,
            fulfillment_method, ship_to, shipping_amount_usd,
            is_employee_purchase, is_rush, need_by_date
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            CURRENT_TIMESTAMP,
            CASE WHEN $9 THEN CURRENT_TIMESTAMP ELSE NULL END,
            $10, $11,
            $12, $13, $14,
            $15, $16, $17
        )
        RETURNING id
        "#,
    )
    .bind(payload.customer_id)
    .bind(payload.wedding_member_id)
    .bind(payload.operator_staff_id)
    .bind(payload.primary_salesperson_id)
    .bind(payload.total_price)
    .bind(payload.amount_paid)
    .bind(balance_due)
    .bind(order_status)
    .bind(set_fulfilled_at)
    .bind(weather_json)
    .bind(payload.checkout_client_id)
    .bind(order_fulfillment_method)
    .bind(order_ship_to)
    .bind(order_shipping_amt)
    .bind(is_employee_purchase_order)
    .bind(payload.is_rush)
    .bind(payload.need_by_date)
    .fetch_one(&mut *tx)
    .await;

    let order_id: Uuid = match order_insert {
        Ok(id) => id,
        Err(SqlxError::Database(db_err))
            if db_err.constraint() == Some("orders_checkout_client_id_uidx") =>
        {
            let Some(cid) = payload.checkout_client_id else {
                return Err(CheckoutError::Database(SqlxError::Database(db_err)));
            };
            tx.rollback().await?;
            let oid: Uuid =
                sqlx::query_scalar("SELECT id FROM orders WHERE checkout_client_id = $1")
                    .bind(cid)
                    .fetch_one(pool)
                    .await?;
            tracing::info!(order_id = %oid, "checkout idempotent replay after checkout_client_id race");
            return Ok(CheckoutDone::Idempotent { order_id: oid });
        }
        Err(e) => return Err(e.into()),
    };

    if order_fulfillment_method == DbOrderFulfillmentMethod::Ship {
        crate::logic::shipment::insert_from_pos_order_tx(
            &mut tx,
            order_id,
            payload.customer_id,
            payload.operator_staff_id,
            ship_to_snapshot_for_registry,
            order_shipping_amt,
            pos_shippo_rate_object_id,
        )
        .await?;
    }

    // Order-level default: lines with no explicit `salesperson_id` inherit `primary_salesperson_id`
    // for `order_items.salesperson_id` and per-line commission snapshots.
    let primary_for_lines = payload.primary_salesperson_id;

    // Takeaway stock to deduct once per variant (multiple cart lines can reference the same variant).
    let mut layaway_stock_by_variant: HashMap<Uuid, i32> = HashMap::new();
    let mut takeaway_stock_by_variant: HashMap<Uuid, i32> = HashMap::new();

    for (idx, item) in payload.items.into_iter().enumerate() {
        let fulfillment = persist_fulfillment(payload.wedding_member_id, item.fulfillment)
            .map_err(|m| CheckoutError::InvalidPayload(m.to_string()))?;
        let line_fulfilled = fulfillment == DbFulfillmentType::Takeaway;
        let override_reason = item
            .price_override_reason
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty());
        let mut override_meta = override_reason.map(|reason| {
            json!({
                "price_override_reason": reason,
                "original_unit_price": item.original_unit_price,
                "overridden_unit_price": item.unit_price,
            })
        });
        if let Some(label) = discount_event_labels.get(&idx) {
            let mut base = override_meta.unwrap_or_else(|| json!({}));
            if let serde_json::Value::Object(ref mut m) = base {
                m.insert(
                    "discount_event_id".to_string(),
                    json!(item
                        .discount_event_id
                        .map(|u| u.to_string())
                        .unwrap_or_default()),
                );
                m.insert("discount_event_label".to_string(), json!(label.clone()));
                if let Some(orig) = item.original_unit_price {
                    m.entry("original_unit_price".to_string())
                        .or_insert(json!(orig));
                }
                m.entry("overridden_unit_price".to_string())
                    .or_insert(json!(item.unit_price));
            }
            override_meta = Some(base);
        }
        if let Some(gc) = item
            .gift_card_load_code
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let mut base = override_meta.unwrap_or_else(|| json!({}));
            if let serde_json::Value::Object(ref mut m) = base {
                m.insert("gift_card_load_code".to_string(), json!(gc));
            }
            override_meta = Some(base);
        }

        if let Some(reason) = override_reason {
            price_override_audit.push(json!({
                "variant_id": item.variant_id,
                "reason": reason,
                "original_unit_price": item.original_unit_price,
                "overridden_unit_price": item.unit_price,
                "quantity": item.quantity,
            }));
        }

        let line_salesperson_id = item.salesperson_id.or(primary_for_lines);

        let commission = sales_commission::commission_for_line(
            &mut tx,
            item.unit_price,
            item.quantity,
            line_salesperson_id,
            item.product_id,
            is_employee_purchase_order,
        )
        .await?;

        let order_item_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO order_items (
                order_id, product_id, variant_id, fulfillment, quantity,
                unit_price, unit_cost, state_tax, local_tax, size_specs, is_fulfilled,
                salesperson_id, calculated_commission,
                custom_item_type, is_rush, need_by_date, needs_gift_wrap
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            RETURNING id
            "#,
        )
        .bind(order_id)
        .bind(item.product_id)
        .bind(item.variant_id)
        .bind(fulfillment)
        .bind(item.quantity)
        .bind(item.unit_price)
        .bind(item.unit_cost)
        .bind(item.state_tax)
        .bind(item.local_tax)
        .bind(override_meta)
        .bind(line_fulfilled)
        .bind(line_salesperson_id)
        .bind(commission)
        .bind(item.custom_item_type)
        .bind(item.is_rush)
        .bind(item.need_by_date)
        .bind(item.needs_gift_wrap)
        .fetch_one(&mut *tx)
        .await?;

        if let Some(eid) = item.discount_event_id {
            let pct: Decimal =
                sqlx::query_scalar("SELECT percent_off FROM discount_events WHERE id = $1")
                    .bind(eid)
                    .fetch_optional(&mut *tx)
                    .await?
                    .ok_or_else(|| {
                        CheckoutError::InvalidPayload("discount event not found".to_string())
                    })?;
            let line_subtotal = (item.unit_price * Decimal::from(item.quantity)).round_dp(2);
            sqlx::query(
                r#"
                INSERT INTO discount_event_usage (
                    event_id, order_id, order_item_id, variant_id, quantity,
                    line_subtotal, discount_percent
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                "#,
            )
            .bind(eid)
            .bind(order_id)
            .bind(order_item_id)
            .bind(item.variant_id)
            .bind(item.quantity)
            .bind(line_subtotal)
            .bind(pct)
            .execute(&mut *tx)
            .await?;
        }

        let pos_kind: Option<String> = sqlx::query_scalar(
            r#"
            SELECT p.pos_line_kind
            FROM product_variants v
            INNER JOIN products p ON p.id = v.product_id
            WHERE v.id = $1
            "#,
        )
        .bind(item.variant_id)
        .fetch_one(&mut *tx)
        .await?;

        if is_fully_paid && pos_kind.as_deref() == Some("pos_gift_card_load") {
            let code = item
                .gift_card_load_code
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    CheckoutError::InvalidPayload(
                        "POS gift card load requires gift_card_load_code".to_string(),
                    )
                })?;
            let line_total = (item.unit_price * Decimal::from(item.quantity)).round_dp(2);
            gift_card_ops::pos_load_purchased_in_tx(
                &mut tx,
                code,
                line_total,
                payload.customer_id,
                Some(payload.session_id),
                Some(order_id),
            )
            .await
            .map_err(|e| match e {
                gift_card_ops::GiftCardOpError::BadRequest(m) => CheckoutError::InvalidPayload(m),
                gift_card_ops::GiftCardOpError::Db(d) => CheckoutError::Database(d),
            })?;
        }

        // Only decrement stock_on_hand for Takeaway (floor stock) lines.
        // Special / wedding lines are pending fulfillment: no checkout-time deduction;
        // inventory is adjusted when product is received / at pickup per ops flow.
        let skip_stock = matches!(
            pos_kind.as_deref(),
            Some("rms_charge_payment") | Some("pos_gift_card_load")
        );

        if fulfillment == DbFulfillmentType::Takeaway && !skip_stock {
            takeaway_stock_by_variant
                .entry(item.variant_id)
                .and_modify(|q| *q += item.quantity)
                .or_insert(item.quantity);
        } else if fulfillment == DbFulfillmentType::Layaway && !skip_stock {
            layaway_stock_by_variant
                .entry(item.variant_id)
                .and_modify(|q| *q += item.quantity)
                .or_insert(item.quantity);
        }
    }

    for (variant_id, qty) in layaway_stock_by_variant {
        sqlx::query(
            r#"
            UPDATE product_variants
            SET on_layaway = on_layaway + $1
            WHERE id = $2
            "#,
        )
        .bind(qty)
        .bind(variant_id)
        .execute(&mut *tx)
        .await?;
    }

    for (variant_id, qty) in takeaway_stock_by_variant {
        if qty <= 0 {
            continue;
        }
        // Allow stock_on_hand to go negative: shortage must not block retail checkout.
        // (Special / wedding lines never reach this map — they skip deduction until pickup/fulfill.)
        let affected = sqlx::query(
            r#"
            UPDATE product_variants
            SET stock_on_hand = stock_on_hand - $1
            WHERE id = $2
            "#,
        )
        .bind(qty)
        .bind(variant_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();

        if affected == 0 {
            tracing::warn!(
                variant_id = %variant_id,
                qty,
                "checkout: takeaway stock decrement skipped (no product_variants row — sale still completes)"
            );
        }
    }

    let order_short_ref = pos_rms_charge::order_compact_ref(order_id);
    let mut customer_display_rms: Option<String> = None;
    let mut rms_notifications: Vec<pos_rms_charge::RmsChargeNotify> = Vec::new();

    let payment_tx_category = if is_rms_payment_collection {
        DbTransactionCategory::RmsAccountPayment
    } else {
        DbTransactionCategory::RetailSale
    };

    if payload.amount_paid > Decimal::ZERO {
        if has_rms_charge || is_rms_payment_collection {
            if let Some(cid) = payload.customer_id {
                let nm: Option<String> = sqlx::query_scalar(
                    r#"
                    SELECT TRIM(CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, '')))
                    FROM customers
                    WHERE id = $1
                    "#,
                )
                .bind(cid)
                .fetch_optional(&mut *tx)
                .await?;
                customer_display_rms = nm.and_then(|s| {
                    let t = s.trim().to_string();
                    if t.is_empty() {
                        None
                    } else {
                        Some(t)
                    }
                });
            }
        }

        let mut main_tx_ids = Vec::new();

        for split in &payment_splits {
            if split.amount <= Decimal::ZERO {
                continue;
            }
            let method = split.method.trim();

            // 1. Store credit redemption
            if method.eq_ignore_ascii_case("store_credit") {
                let cid = payload.customer_id.ok_or_else(|| {
                    CheckoutError::InvalidPayload("customer_id required".to_string())
                })?;
                store_credit::apply_checkout_redemption(&mut tx, cid, split.amount, order_id)
                    .await
                    .map_err(|e| match e {
                        store_credit::StoreCreditError::InsufficientBalance => {
                            CheckoutError::InvalidPayload(
                                "Store credit balance is insufficient for this split".to_string(),
                            )
                        }
                        store_credit::StoreCreditError::NotFound => CheckoutError::InvalidPayload(
                            "Store credit account not found".to_string(),
                        ),
                        store_credit::StoreCreditError::ReasonRequired => {
                            CheckoutError::InvalidPayload(
                                "Store credit configuration error".to_string(),
                            )
                        }
                        store_credit::StoreCreditError::Database(d) => CheckoutError::Database(d),
                    })?;
            }

            if method.eq_ignore_ascii_case("open_deposit") {
                let cid = payload.customer_id.ok_or_else(|| {
                    CheckoutError::InvalidPayload("customer_id required".to_string())
                })?;
                customer_open_deposit::apply_checkout_redemption(
                    &mut tx,
                    cid,
                    split.amount,
                    order_id,
                )
                .await
                .map_err(|e| match e {
                    customer_open_deposit::CustomerOpenDepositError::InsufficientBalance => {
                        CheckoutError::InvalidPayload(
                            "Open deposit balance is insufficient for this split".to_string(),
                        )
                    }
                    customer_open_deposit::CustomerOpenDepositError::NotFound => {
                        CheckoutError::InvalidPayload("Open deposit account not found".to_string())
                    }
                    customer_open_deposit::CustomerOpenDepositError::Database(d) => {
                        CheckoutError::Database(d)
                    }
                })?;
            }

            // 2. Handle Gift Card redemption if applicable
            if let Some(card_code) = &split.gift_card_code {
                if method.to_ascii_lowercase().contains("gift_card") {
                    let card: Option<(Uuid, Decimal, String)> = sqlx::query_as(
                        r#"
                        SELECT id, current_balance, card_status::text
                        FROM gift_cards
                        WHERE code = $1
                          AND card_status = 'active'::gift_card_status
                          AND (expires_at IS NULL OR expires_at > now())
                        FOR UPDATE
                        "#,
                    )
                    .bind(card_code)
                    .fetch_optional(&mut *tx)
                    .await?;

                    if let Some((cid, bal, _status)) = card {
                        if bal < split.amount {
                            return Err(CheckoutError::InvalidPayload(format!(
                                "Gift card {card_code} has insufficient balance (${bal})"
                            )));
                        }
                        let new_balance = bal - split.amount;
                        let new_status_str = if new_balance == Decimal::ZERO {
                            "depleted"
                        } else {
                            "active"
                        };

                        sqlx::query(
                            "UPDATE gift_cards SET current_balance = $1, card_status = $2::gift_card_status WHERE id = $3"
                        )
                        .bind(new_balance)
                        .bind(new_status_str)
                        .bind(cid)
                        .execute(&mut *tx)
                        .await?;

                        sqlx::query(
                            r#"
                            INSERT INTO gift_card_events
                                (gift_card_id, event_kind, amount, balance_after, order_id, session_id)
                            VALUES ($1, 'redeemed', $2, $3, $4, $5)
                            "#,
                        )
                        .bind(cid)
                        .bind(-split.amount)
                        .bind(new_balance)
                        .bind(order_id)
                        .bind(payload.session_id)
                        .execute(&mut *tx)
                        .await?;
                    } else {
                        return Err(CheckoutError::InvalidPayload(format!(
                            "Gift card {card_code} is not found, expired, or inactive"
                        )));
                    }
                }
            }

            // 3. Create the movement record (payment_transactions)
            let transaction_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO payment_transactions (
                    session_id, wedding_member_id, category, payment_method, amount, metadata
                )
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id
                "#,
            )
            .bind(payload.session_id)
            .bind(payload.wedding_member_id)
            .bind(payment_tx_category)
            .bind(method)
            .bind(split.amount)
            .bind(&split.metadata)
            .fetch_one(&mut *tx)
            .await?;

            if pos_rms_charge::is_rms_method(method) {
                pos_rms_charge::insert_rms_record(
                    &mut *tx,
                    "charge",
                    order_id,
                    payload.session_id,
                    payload.customer_id,
                    method,
                    split.amount,
                    payload.operator_staff_id,
                    transaction_id,
                    customer_display_rms.as_deref(),
                    &order_short_ref,
                )
                .await?;
                rms_notifications.push(pos_rms_charge::RmsChargeNotify {
                    payment_transaction_id: transaction_id,
                    amount: split.amount,
                    method: method.to_string(),
                });
            } else if is_rms_payment_collection {
                pos_rms_charge::insert_rms_record(
                    &mut *tx,
                    "payment",
                    order_id,
                    payload.session_id,
                    payload.customer_id,
                    method,
                    split.amount,
                    payload.operator_staff_id,
                    transaction_id,
                    customer_display_rms.as_deref(),
                    &order_short_ref,
                )
                .await?;
            }

            main_tx_ids.push(transaction_id);

            // 3. Allocate to the Payer's order
            sqlx::query(
                r#"
                INSERT INTO payment_allocations (
                    transaction_id, target_order_id, amount_allocated, metadata
                )
                VALUES ($1, $2, $3, $4)
                "#,
            )
            .bind(transaction_id)
            .bind(order_id)
            .bind(split.amount)
            .bind(&split.metadata)
            .execute(&mut *tx)
            .await?;
        }

        // --- WEDDING DISBURSEMENT LOGIC ---
        if let Some(disbursements) = &payload.wedding_disbursements {
            if !disbursements.is_empty() {
                let payer_tx_id = main_tx_ids.first().copied().unwrap_or_else(Uuid::nil);

                for d in disbursements {
                    if d.amount <= Decimal::ZERO {
                        continue;
                    }

                    let bene_order: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
                        r#"
                        SELECT o.id, wm.wedding_party_id
                        FROM orders o
                        JOIN wedding_members wm ON wm.id = o.wedding_member_id
                        WHERE wm.id = $1
                          AND o.status IN ('open', 'pending_measurement')
                        ORDER BY o.booked_at DESC
                        LIMIT 1
                        "#,
                    )
                    .bind(d.wedding_member_id)
                    .fetch_optional(&mut *tx)
                    .await?;

                    if let Some((bene_order_id, party_id)) = bene_order {
                        sqlx::query(
                            r#"
                            INSERT INTO payment_allocations (
                                transaction_id, target_order_id, amount_allocated, metadata
                            )
                            VALUES ($1, $2, $3, $4)
                            "#,
                        )
                        .bind(payer_tx_id)
                        .bind(bene_order_id)
                        .bind(d.amount)
                        .bind(json!({
                            "kind": "wedding_group_disbursement",
                            "payer_member_id": payload.wedding_member_id
                        }))
                        .execute(&mut *tx)
                        .await?;

                        order_recalc::recalc_order_totals(&mut tx, bene_order_id)
                            .await
                            .map_err(CheckoutError::Database)?;

                        if let Some(pid) = party_id {
                            let actor = payload.actor_name.as_deref().unwrap_or("Riverside POS");
                            let desc = format!(
                                "Received disbursement payment of ${} from party group.",
                                d.amount
                            );
                            wedding_logic::insert_wedding_activity(
                                &mut *tx,
                                pid,
                                Some(d.wedding_member_id),
                                actor,
                                "PAYMENT",
                                &desc,
                                json!({
                                    "source_payer_id": payload.wedding_member_id,
                                    "target_order_id": bene_order_id,
                                    "amount": d.amount
                                }),
                            )
                            .await?;
                        }
                    } else {
                        let bene: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
                            r#"
                            SELECT wm.customer_id, wm.wedding_party_id
                            FROM wedding_members wm
                            WHERE wm.id = $1
                            "#,
                        )
                        .bind(d.wedding_member_id)
                        .fetch_optional(&mut *tx)
                        .await?;

                        if let Some((bene_customer_id, bene_party_id)) = bene {
                            let payer_name: Option<String> = if let Some(pc) = payload.customer_id {
                                sqlx::query_scalar(
                                    r#"
                                    SELECT TRIM(CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, '')))
                                    FROM customers
                                    WHERE id = $1
                                    "#,
                                )
                                .bind(pc)
                                .fetch_optional(&mut *tx)
                                .await?
                            } else {
                                None
                            };
                            let payer_trim = payer_name
                                .as_deref()
                                .map(str::trim)
                                .filter(|s| !s.is_empty());
                            customer_open_deposit::credit_party_split(
                                &mut tx,
                                bene_customer_id,
                                d.amount,
                                payload.customer_id,
                                payer_trim,
                                bene_party_id,
                                order_id,
                            )
                            .await
                            .map_err(|e| {
                                match e {
                                customer_open_deposit::CustomerOpenDepositError::Database(d) => {
                                    CheckoutError::Database(d)
                                }
                                customer_open_deposit::CustomerOpenDepositError::InsufficientBalance
                                | customer_open_deposit::CustomerOpenDepositError::NotFound => {
                                    CheckoutError::InvalidPayload(
                                        "open deposit credit could not be posted".to_string(),
                                    )
                                }
                            }
                            })?;
                        } else {
                            tracing::warn!(
                                wedding_member_id = %d.wedding_member_id,
                                "Wedding disbursement skipped: member not found"
                            );
                        }
                    }
                }
            }
        }

        if let Some(member_id) = payload.wedding_member_id {
            sqlx::query(
                r#"
                UPDATE wedding_members
                SET
                    order_id = COALESCE(order_id, $1),
                    status = CASE
                        WHEN $2 <= 0 THEN 'paid'
                        ELSE 'ordered'
                    END,
                    suit_ordered = TRUE,
                    ordered_date = COALESCE(ordered_date, CURRENT_DATE)
                WHERE id = $3
                "#,
            )
            .bind(order_id)
            .bind(balance_due)
            .bind(member_id)
            .execute(&mut *tx)
            .await?;

            let party_id: Option<Uuid> =
                sqlx::query_scalar("SELECT wedding_party_id FROM wedding_members WHERE id = $1")
                    .bind(member_id)
                    .fetch_optional(&mut *tx)
                    .await?;

            if let Some(party_id) = party_id {
                let actor = payload
                    .actor_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Riverside POS");
                let desc = format!(
                    "Payment recorded: ${} {} ({})",
                    payload.amount_paid,
                    payment_activity_label,
                    if balance_due <= Decimal::ZERO {
                        "paid in full"
                    } else {
                        "partial"
                    }
                );
                wedding_logic::insert_wedding_activity(
                    &mut *tx,
                    party_id,
                    Some(member_id),
                    actor,
                    "PAYMENT",
                    &desc,
                    json!({
                        "order_id": order_id,
                        "amount_paid": payload.amount_paid,
                        "payment_method": payment_activity_label,
                        "balance_due": balance_due,
                    }),
                )
                .await?;
            }
        }
    }

    if let Some(target_id) = payload.target_order_id {
        sqlx::query("UPDATE orders SET amount_paid = amount_paid + $1 WHERE id = $2")
            .bind(payload.total_price)
            .bind(target_id)
            .execute(&mut *tx)
            .await
            .map_err(CheckoutError::Database)?;

        order_recalc::recalc_order_totals(&mut tx, target_id)
            .await
            .map_err(CheckoutError::Database)?;
    }

    order_recalc::recalc_order_totals(&mut tx, order_id)
        .await
        .map_err(CheckoutError::Database)?;

    let operator_staff_id = payload.operator_staff_id;
    let customer_id = payload.customer_id;
    let amount_paid = payload.amount_paid;
    let total_price = payload.total_price;
    let session_id_for_log = payload.session_id;

    tx.commit().await?;

    if !rms_notifications.is_empty() {
        if let Err(e) = pos_rms_charge::notify_sales_support_after_checkout(
            pool,
            order_id,
            session_id_for_log,
            customer_id,
            customer_display_rms.as_deref(),
            &order_short_ref,
            operator_staff_id,
            &rms_notifications,
        )
        .await
        {
            tracing::error!(
                error = %e,
                order_id = %order_id,
                "RMS sales_support notification fan-out failed after checkout"
            );
        }
    }

    if is_rms_payment_collection && amount_paid > Decimal::ZERO {
        if let Some(cid) = customer_id {
            if let Err(e) = tasks::create_adhoc_rms_payment_followup_tasks(
                pool,
                order_id,
                cid,
                customer_display_rms.as_deref(),
                &order_short_ref,
                amount_paid,
                payment_activity_label.as_str(),
                operator_staff_id,
            )
            .await
            {
                tracing::error!(
                    error = %e,
                    order_id = %order_id,
                    "RMS payment ad-hoc task creation failed"
                );
            }
        }
    }

    let _ = log_staff_access(
        pool,
        operator_staff_id,
        "sale_checkout",
        json!({
            "order_id": order_id,
            "register_session_id": session_id_for_log,
        }),
    )
    .await;

    Ok(CheckoutDone::Completed {
        order_id,
        operator_staff_id,
        customer_id,
        price_override_audit,
        amount_paid,
        total_price,
    })
}
