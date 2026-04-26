//! POS checkout: split resolution, validation, and transactional persistence.

use chrono::Utc;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Error as SqlxError, PgPool};
use std::collections::{HashMap, HashSet};
use thiserror::Error;
use uuid::Uuid;

use crate::auth::pins::log_staff_access;
use crate::logic::checkout_validate;
use crate::logic::corecard;
use crate::logic::custom_orders::{
    canonical_custom_order_details, known_custom_item_type_for_sku, known_custom_subtype_for_sku,
};
use crate::logic::customer_open_deposit;
use crate::logic::gift_card_ops;
use crate::logic::pos_rms_charge;
use crate::logic::pricing_limits;
use crate::logic::sales_commission;
use crate::logic::store_credit;
use crate::logic::tasks;
use crate::logic::tax::{erie_local_tax_usd, nys_state_tax_usd};
use crate::logic::transaction_fulfillment::persist_fulfillment;
use crate::logic::transaction_recalc;
use crate::logic::weather;
use crate::logic::weddings as wedding_logic;
use crate::models::{
    DbFulfillmentType, DbOrderFulfillmentMethod, DbOrderStatus, DbTransactionCategory,
};
use crate::services::inventory;
use sqlx::types::Json;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Error)]
pub enum CheckoutError {
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("{0}")]
    CoreCardHostFailure(String),
}

#[derive(Debug, Deserialize)]
pub struct CheckoutItem {
    #[serde(default)]
    pub client_line_id: Option<String>,
    #[serde(default)]
    pub line_type: Option<String>,
    #[serde(default)]
    pub alteration_intake_id: Option<String>,
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub fulfillment: DbFulfillmentType,
    pub quantity: i32,
    pub unit_price: Decimal,
    #[serde(default)]
    pub original_unit_price: Option<Decimal>,
    #[serde(default)]
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
    pub custom_order_details: Option<Value>,
    #[serde(default)]
    pub is_rush: bool,
    #[serde(default)]
    pub need_by_date: Option<chrono::NaiveDate>,
    #[serde(default)]
    pub needs_gift_wrap: bool,
}

#[derive(Debug, Deserialize)]
pub struct CheckoutAlterationIntake {
    pub intake_id: String,
    pub alteration_line_client_id: String,
    #[serde(default)]
    pub source_client_line_id: Option<String>,
    pub source_type: String,
    #[serde(default)]
    pub item_description: Option<String>,
    pub work_requested: String,
    #[serde(default)]
    pub source_product_id: Option<Uuid>,
    #[serde(default)]
    pub source_variant_id: Option<Uuid>,
    #[serde(default)]
    pub source_sku: Option<String>,
    #[serde(default)]
    pub source_transaction_id: Option<Uuid>,
    #[serde(default)]
    pub source_transaction_line_id: Option<Uuid>,
    #[serde(default)]
    pub charge_amount: Option<Decimal>,
    #[serde(default)]
    pub due_at: Option<chrono::DateTime<Utc>>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WeddingDisbursement {
    pub wedding_member_id: Uuid,
    pub amount: Decimal,
}

#[derive(Debug, Deserialize)]
pub struct CheckoutOrderPayment {
    pub client_line_id: String,
    pub target_transaction_id: Uuid,
    pub target_display_id: String,
    pub customer_id: Uuid,
    pub amount: Decimal,
    pub balance_before: Decimal,
    pub projected_balance_after: Decimal,
}

#[derive(Debug, Deserialize)]
pub struct CheckoutRequest {
    pub session_id: Uuid,
    pub operator_staff_id: Uuid,
    #[serde(default)]
    pub primary_salesperson_id: Option<Uuid>,
    #[serde(default)]
    pub customer_id: Option<Uuid>,
    #[serde(default)]
    pub wedding_member_id: Option<Uuid>,
    pub payment_method: String,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    pub items: Vec<CheckoutItem>,
    #[serde(default)]
    pub alteration_intakes: Vec<CheckoutAlterationIntake>,
    #[serde(default)]
    pub actor_name: Option<String>,
    #[serde(default)]
    pub payment_splits: Option<Vec<CheckoutPaymentSplit>>,
    #[serde(default)]
    pub wedding_disbursements: Option<Vec<WeddingDisbursement>>,
    #[serde(default)]
    pub order_payments: Vec<CheckoutOrderPayment>,
    #[serde(default)]
    pub checkout_client_id: Option<Uuid>,
    /// Consumed at checkout (single use); amount included in `total_price` validation.
    #[serde(default)]
    pub shipping_rate_quote_id: Option<Uuid>,
    /// Customer delivery mode requested by the Register. Shipping is only authoritative
    /// when paired with a valid `shipping_rate_quote_id` so the address/charge snapshot
    /// comes from the POS shipping flow.
    #[serde(default)]
    pub fulfillment_mode: Option<DbOrderFulfillmentMethod>,
    /// Legacy/client hint. Checkout ignores this unless the shipping quote metadata
    /// carries the matching authoritative address snapshot.
    #[serde(default)]
    pub ship_to: Option<Value>,
    #[serde(default)]
    pub stripe_payment_method_id: Option<String>,
    /// Legacy field is not safe for mixed current-sale + existing-order allocations.
    /// Use `order_payments[]`.
    #[serde(default)]
    pub target_transaction_id: Option<Uuid>,
    #[serde(default)]
    pub is_rush: bool,
    #[serde(default)]
    pub need_by_date: Option<chrono::NaiveDate>,
    #[serde(default)]
    pub is_tax_exempt: bool,
    #[serde(default)]
    pub tax_exempt_reason: Option<String>,
    #[serde(default)]
    pub rounding_adjustment: Option<Decimal>,
    #[serde(default)]
    pub final_cash_due: Option<Decimal>,
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
    #[serde(default)]
    pub check_number: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct CheckoutResponse {
    pub transaction_id: Uuid,
    pub transaction_display_id: String,
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
    pub stripe_intent_id: Option<String>,
    pub check_number: Option<String>,
    pub merchant_fee: Decimal,
    pub net_amount: Decimal,
    pub card_brand: Option<String>,
    pub card_last4: Option<String>,
}

fn metadata_required_text(
    metadata: &Value,
    key: &str,
    message: &str,
) -> Result<String, CheckoutError> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| CheckoutError::InvalidPayload(message.to_string()))
}

fn metadata_optional_text(metadata: &Value, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

async fn canonical_custom_item_type_for_variant(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    fulfillment: DbFulfillmentType,
    variant_id: Uuid,
    provided: Option<&str>,
) -> Result<Option<String>, sqlx::Error> {
    if fulfillment != DbFulfillmentType::Custom {
        return Ok(provided
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string));
    }

    let variant_sku: Option<String> =
        sqlx::query_scalar("SELECT sku FROM product_variants WHERE id = $1")
            .bind(variant_id)
            .fetch_optional(&mut **tx)
            .await?;

    if let Some(sku) = variant_sku.as_deref() {
        if let Some(item_type) = known_custom_item_type_for_sku(sku) {
            return Ok(Some(item_type.to_string()));
        }
    }

    Ok(provided
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string))
}

fn corecard_error_to_checkout(error: corecard::CoreCardError) -> CheckoutError {
    if let Some(failure) = error.as_host_failure() {
        CheckoutError::CoreCardHostFailure(failure.message)
    } else {
        match error {
            corecard::CoreCardError::Database(db) => CheckoutError::Database(db),
            other => CheckoutError::CoreCardHostFailure(other.to_string()),
        }
    }
}

fn apply_corecard_result_to_metadata(
    metadata: &mut Value,
    idempotency_key: &str,
    result: &corecard::CoreCardHostMutationResult,
) {
    let mut object = metadata.as_object().cloned().unwrap_or_default();
    object.insert(
        "posting_status".to_string(),
        Value::String(result.posting_status.clone()),
    );
    object.insert(
        "idempotency_key".to_string(),
        Value::String(idempotency_key.to_string()),
    );
    if let Some(value) = &result.external_transaction_id {
        object.insert(
            "external_transaction_id".to_string(),
            Value::String(value.clone()),
        );
    }
    if let Some(value) = &result.external_auth_code {
        object.insert(
            "external_auth_code".to_string(),
            Value::String(value.clone()),
        );
    }
    if let Some(value) = &result.external_transaction_type {
        object.insert(
            "external_transaction_type".to_string(),
            Value::String(value.clone()),
        );
    }
    if let Some(value) = &result.host_reference {
        object.insert("host_reference".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = result.posted_at {
        object.insert("posted_at".to_string(), Value::String(value.to_rfc3339()));
    }
    if let Some(value) = result.reversed_at {
        object.insert("reversed_at".to_string(), Value::String(value.to_rfc3339()));
    }
    if let Some(value) = result.refunded_at {
        object.insert("refunded_at".to_string(), Value::String(value.to_rfc3339()));
    }
    object.insert("host_metadata".to_string(), result.metadata.clone());
    object.insert("response_snapshot".to_string(), result.metadata.clone());
    *metadata = Value::Object(object);
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

#[derive(Debug, Clone)]
struct ResolvedOrderPayment {
    client_line_id: String,
    target_transaction_id: Uuid,
    target_display_id: String,
    customer_id: Uuid,
    amount: Decimal,
    balance_before: Decimal,
    projected_balance_after: Decimal,
}

#[derive(Debug, Clone)]
struct ExistingOrderPaymentTarget {
    target_transaction_id: Uuid,
    display_id: String,
    customer_id: Uuid,
    balance_due: Decimal,
    status: DbOrderStatus,
    line_count: i64,
}

#[derive(Debug, Clone)]
struct PaymentAllocationPlan {
    payment_split_index: usize,
    target_transaction_id: Uuid,
    amount: Decimal,
    metadata: Value,
    check_number: Option<String>,
    is_existing_order_payment: bool,
}

fn merge_metadata(mut base: Value, extra: Value) -> Value {
    let mut object = base.as_object().cloned().unwrap_or_default();
    if let Value::Object(extra_object) = extra {
        for (key, value) in extra_object {
            object.insert(key, value);
        }
    }
    base = Value::Object(object);
    base
}

fn validate_order_payment_shape(
    checkout_customer_id: Option<Uuid>,
    original_checkout_customer_id: Option<Uuid>,
    order_payments: &[CheckoutOrderPayment],
) -> Result<Vec<ResolvedOrderPayment>, CheckoutError> {
    if order_payments.is_empty() {
        return Ok(Vec::new());
    }
    let customer_id = checkout_customer_id.ok_or_else(|| {
        CheckoutError::InvalidPayload(
            "customer_id is required when checkout includes order_payments".to_string(),
        )
    })?;
    let mut client_line_ids = HashSet::new();
    let mut target_ids = HashSet::new();
    let mut out = Vec::with_capacity(order_payments.len());
    let tol = Decimal::new(2, 2);

    for payment in order_payments {
        let client_line_id = payment.client_line_id.trim();
        if client_line_id.is_empty() {
            return Err(CheckoutError::InvalidPayload(
                "order_payments[].client_line_id is required".to_string(),
            ));
        }
        if !client_line_ids.insert(client_line_id.to_string()) {
            return Err(CheckoutError::InvalidPayload(
                "duplicate order payment client_line_id is not supported".to_string(),
            ));
        }
        if !target_ids.insert(payment.target_transaction_id) {
            return Err(CheckoutError::InvalidPayload(
                "duplicate order payment target_transaction_id is not supported".to_string(),
            ));
        }
        if payment.customer_id != customer_id
            && Some(payment.customer_id) != original_checkout_customer_id
        {
            return Err(CheckoutError::InvalidPayload(
                "order payment customer_id must match checkout customer_id".to_string(),
            ));
        }
        let target_display_id = payment.target_display_id.trim();
        if target_display_id.is_empty() {
            return Err(CheckoutError::InvalidPayload(
                "order_payments[].target_display_id is required".to_string(),
            ));
        }
        let amount = payment.amount.round_dp(2);
        if amount <= Decimal::ZERO {
            return Err(CheckoutError::InvalidPayload(
                "order payment amount must be positive".to_string(),
            ));
        }
        let balance_before = payment.balance_before.round_dp(2);
        let projected_balance_after = payment.projected_balance_after.round_dp(2);
        if balance_before <= Decimal::ZERO {
            return Err(CheckoutError::InvalidPayload(
                "order payment balance_before must be positive".to_string(),
            ));
        }
        if projected_balance_after < Decimal::ZERO {
            return Err(CheckoutError::InvalidPayload(
                "order payment projected_balance_after cannot be negative".to_string(),
            ));
        }
        let expected_after = (balance_before - amount).round_dp(2);
        if (expected_after - projected_balance_after).abs() > tol {
            return Err(CheckoutError::InvalidPayload(
                "order payment projected_balance_after must equal balance_before minus amount"
                    .to_string(),
            ));
        }
        out.push(ResolvedOrderPayment {
            client_line_id: client_line_id.to_string(),
            target_transaction_id: payment.target_transaction_id,
            target_display_id: target_display_id.to_string(),
            customer_id,
            amount,
            balance_before,
            projected_balance_after,
        });
    }

    Ok(out)
}

fn validate_order_payment_against_target(
    payment: &ResolvedOrderPayment,
    target: &ExistingOrderPaymentTarget,
) -> Result<(), CheckoutError> {
    let tol = Decimal::new(2, 2);
    if target.target_transaction_id != payment.target_transaction_id {
        return Err(CheckoutError::InvalidPayload(
            "order payment target validation mismatch".to_string(),
        ));
    }
    if target.customer_id != payment.customer_id {
        return Err(CheckoutError::InvalidPayload(
            "order payment target belongs to a different customer".to_string(),
        ));
    }
    if !matches!(
        target.status,
        DbOrderStatus::Open | DbOrderStatus::PendingMeasurement
    ) {
        return Err(CheckoutError::InvalidPayload(
            "order payment target transaction is not open".to_string(),
        ));
    }
    if target.line_count <= 0 {
        return Err(CheckoutError::InvalidPayload(
            "order payment target has no order lines".to_string(),
        ));
    }
    if target.balance_due <= Decimal::ZERO {
        return Err(CheckoutError::InvalidPayload(
            "order payment target has no balance due".to_string(),
        ));
    }
    if payment.amount > target.balance_due + tol {
        return Err(CheckoutError::InvalidPayload(
            "order payment amount cannot exceed current balance_due".to_string(),
        ));
    }
    if (payment.balance_before - target.balance_due).abs() > tol {
        return Err(CheckoutError::InvalidPayload(
            "order payment balance_before no longer matches current balance_due".to_string(),
        ));
    }
    if (target.balance_due - payment.amount - payment.projected_balance_after).abs() > tol {
        return Err(CheckoutError::InvalidPayload(
            "order payment projected balance no longer matches current balance_due".to_string(),
        ));
    }
    if !target.display_id.trim().is_empty() && target.display_id.trim() != payment.target_display_id
    {
        return Err(CheckoutError::InvalidPayload(
            "order payment target_display_id does not match target transaction".to_string(),
        ));
    }

    Ok(())
}

fn build_payment_allocation_plan(
    payment_splits: &[ResolvedPaymentSplit],
    current_transaction_id: Uuid,
    current_transaction_allocation: Decimal,
    order_payments: &[ResolvedOrderPayment],
) -> Result<Vec<PaymentAllocationPlan>, CheckoutError> {
    let mut current_remaining = current_transaction_allocation.round_dp(2);
    let expected_total = (current_remaining
        + order_payments
            .iter()
            .map(|payment| payment.amount)
            .sum::<Decimal>())
    .round_dp(2);
    let mut order_index = 0usize;
    let mut order_remaining = order_payments
        .first()
        .map(|payment| payment.amount.round_dp(2))
        .unwrap_or(Decimal::ZERO);
    let mut plan = Vec::new();

    for (split_index, split) in payment_splits.iter().enumerate() {
        let mut split_remaining = split.amount.round_dp(2);
        if split_remaining <= Decimal::ZERO {
            continue;
        }

        if current_remaining > Decimal::ZERO {
            let amount = split_remaining.min(current_remaining).round_dp(2);
            if amount > Decimal::ZERO {
                plan.push(PaymentAllocationPlan {
                    payment_split_index: split_index,
                    target_transaction_id: current_transaction_id,
                    amount,
                    metadata: split.metadata.clone(),
                    check_number: split.check_number.clone(),
                    is_existing_order_payment: false,
                });
                split_remaining = (split_remaining - amount).round_dp(2);
                current_remaining = (current_remaining - amount).round_dp(2);
            }
        }

        while split_remaining > Decimal::ZERO && order_index < order_payments.len() {
            if order_remaining <= Decimal::ZERO {
                order_index += 1;
                order_remaining = order_payments
                    .get(order_index)
                    .map(|payment| payment.amount.round_dp(2))
                    .unwrap_or(Decimal::ZERO);
                continue;
            }
            let payment = &order_payments[order_index];
            let amount = split_remaining.min(order_remaining).round_dp(2);
            if amount <= Decimal::ZERO {
                break;
            }
            let metadata = merge_metadata(
                split.metadata.clone(),
                json!({
                    "kind": "existing_order_payment",
                    "client_line_id": payment.client_line_id,
                    "target_transaction_id": payment.target_transaction_id,
                    "target_display_id": payment.target_display_id,
                    "customer_id": payment.customer_id,
                    "balance_before": payment.balance_before.to_string(),
                    "projected_balance_after": payment.projected_balance_after.to_string(),
                    "applied_deposit_amount": amount.to_string()
                }),
            );
            plan.push(PaymentAllocationPlan {
                payment_split_index: split_index,
                target_transaction_id: payment.target_transaction_id,
                amount,
                metadata,
                check_number: split.check_number.clone(),
                is_existing_order_payment: true,
            });
            split_remaining = (split_remaining - amount).round_dp(2);
            order_remaining = (order_remaining - amount).round_dp(2);
        }

        if split_remaining > Decimal::ZERO {
            return Err(CheckoutError::InvalidPayload(
                "payment allocation plan has unallocated tender".to_string(),
            ));
        }
    }

    let allocated_total: Decimal = plan.iter().map(|allocation| allocation.amount).sum();
    if current_remaining > Decimal::ZERO
        || order_remaining > Decimal::ZERO
        || allocated_total.round_dp(2) != expected_total
    {
        return Err(CheckoutError::InvalidPayload(
            "payment allocation plan does not cover requested order payments".to_string(),
        ));
    }

    Ok(plan)
}

fn trimmed_non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn checkout_line_type(item: &CheckoutItem) -> &str {
    item.line_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("merchandise")
}

fn is_alteration_service_item(item: &CheckoutItem) -> bool {
    checkout_line_type(item) == "alteration_service"
}

async fn resolve_checkout_tax_category_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    variant_id: Uuid,
) -> Result<crate::logic::tax::TaxCategory, CheckoutError> {
    let (override_category, resolved_category_name): (Option<String>, Option<String>) =
        sqlx::query_as(
            r#"
            SELECT
                p.tax_category_override::text,
                rc.resolved_category_name
            FROM product_variants pv
            JOIN products p ON p.id = pv.product_id
            LEFT JOIN LATERAL (
                WITH RECURSIVE cat_path AS (
                    SELECT c.id, c.name, c.is_clothing_footwear, c.parent_id, 0 AS depth
                    FROM categories c
                    WHERE c.id = p.category_id
                    UNION ALL
                    SELECT parent.id, parent.name, parent.is_clothing_footwear, parent.parent_id, cat_path.depth + 1
                    FROM categories parent
                    JOIN cat_path ON cat_path.parent_id = parent.id
                    WHERE cat_path.depth < 16
                )
                SELECT cp.name AS resolved_category_name
                FROM cat_path cp
                WHERE cp.is_clothing_footwear = true
                ORDER BY cp.depth
                LIMIT 1
            ) rc ON true
            WHERE pv.id = $1
            "#,
        )
        .bind(variant_id)
        .fetch_one(&mut **tx)
        .await?;

    if let Some(category) = override_category
        .as_deref()
        .and_then(crate::logic::tax::TaxCategory::from_db_text)
    {
        return Ok(category);
    }

    if let Some(category_name) = resolved_category_name {
        let lower = category_name.to_lowercase();
        if lower.contains("shoe") || lower.contains("footwear") {
            Ok(crate::logic::tax::TaxCategory::Footwear)
        } else {
            Ok(crate::logic::tax::TaxCategory::Clothing)
        }
    } else {
        Ok(crate::logic::tax::TaxCategory::Other)
    }
}

fn validate_checkout_alteration_intakes(
    customer_id: Option<Uuid>,
    items: &[CheckoutItem],
    intakes: &[CheckoutAlterationIntake],
) -> Result<HashSet<String>, CheckoutError> {
    if intakes.is_empty() {
        if items.iter().any(is_alteration_service_item) {
            return Err(CheckoutError::InvalidPayload(
                "alteration service line requires matching alteration intake".to_string(),
            ));
        }
        return Ok(HashSet::new());
    }

    if customer_id.is_none() {
        return Err(CheckoutError::InvalidPayload(
            "customer_id is required when checkout includes alteration intake".to_string(),
        ));
    }

    let line_ids: HashSet<String> = items
        .iter()
        .filter_map(|item| trimmed_non_empty(item.client_line_id.as_deref()))
        .collect();
    let mut service_lines_by_intake: HashMap<String, (&CheckoutItem, String)> = HashMap::new();
    for item in items.iter().filter(|item| is_alteration_service_item(item)) {
        let client_line_id =
            trimmed_non_empty(item.client_line_id.as_deref()).ok_or_else(|| {
                CheckoutError::InvalidPayload(
                    "alteration service line requires client_line_id".to_string(),
                )
            })?;
        let intake_id =
            trimmed_non_empty(item.alteration_intake_id.as_deref()).ok_or_else(|| {
                CheckoutError::InvalidPayload(
                    "alteration service line requires alteration_intake_id".to_string(),
                )
            })?;
        if item.quantity != 1 {
            return Err(CheckoutError::InvalidPayload(
                "alteration service lines must have quantity 1".to_string(),
            ));
        }
        if item.unit_price < Decimal::ZERO {
            return Err(CheckoutError::InvalidPayload(
                "alteration service line amount cannot be negative".to_string(),
            ));
        }
        if !item.state_tax.is_zero() || !item.local_tax.is_zero() {
            return Err(CheckoutError::InvalidPayload(
                "alteration service lines must be non-taxable".to_string(),
            ));
        }
        service_lines_by_intake.insert(intake_id, (item, client_line_id));
    }
    if service_lines_by_intake.len()
        != items
            .iter()
            .filter(|item| is_alteration_service_item(item))
            .count()
    {
        return Err(CheckoutError::InvalidPayload(
            "alteration service lines must have unique alteration_intake_id values".to_string(),
        ));
    }
    if service_lines_by_intake.len() != intakes.len() {
        return Err(CheckoutError::InvalidPayload(
            "every alteration service line must have a matching alteration intake".to_string(),
        ));
    }
    let mut referenced = HashSet::new();
    let mut intake_ids = HashSet::new();

    for intake in intakes {
        let intake_id = trimmed_non_empty(Some(&intake.intake_id)).ok_or_else(|| {
            CheckoutError::InvalidPayload("alteration intake requires intake_id".to_string())
        })?;
        if !intake_ids.insert(intake_id.clone()) {
            return Err(CheckoutError::InvalidPayload(
                "duplicate alteration intake id in checkout".to_string(),
            ));
        }
        let alteration_line_client_id = trimmed_non_empty(Some(&intake.alteration_line_client_id))
            .ok_or_else(|| {
                CheckoutError::InvalidPayload(
                    "alteration intake requires alteration_line_client_id".to_string(),
                )
            })?;
        let Some((service_line, service_client_line_id)) = service_lines_by_intake.get(&intake_id)
        else {
            return Err(CheckoutError::InvalidPayload(format!(
                "alteration intake {intake_id} has no matching alteration service line"
            )));
        };
        if *service_client_line_id != alteration_line_client_id {
            return Err(CheckoutError::InvalidPayload(
                "alteration intake service line id does not match cart line".to_string(),
            ));
        }
        if !line_ids.contains(&alteration_line_client_id) {
            return Err(CheckoutError::InvalidPayload(format!(
                "alteration intake references unknown alteration_line_client_id {alteration_line_client_id}"
            )));
        }
        if !matches!(
            intake.source_type.trim(),
            "current_cart_item" | "past_transaction_line" | "catalog_item" | "custom_item"
        ) {
            return Err(CheckoutError::InvalidPayload(
                "alteration intake source_type is invalid".to_string(),
            ));
        }
        let charge_amount = intake.charge_amount.unwrap_or(Decimal::ZERO);
        if charge_amount < Decimal::ZERO {
            return Err(CheckoutError::InvalidPayload(
                "alteration charge amount cannot be negative".to_string(),
            ));
        }
        if service_line.unit_price.round_dp(2) != charge_amount.round_dp(2) {
            return Err(CheckoutError::InvalidPayload(
                "alteration service line amount must match intake charge_amount".to_string(),
            ));
        }
        if intake.source_type.trim() == "current_cart_item" {
            let client_line_id = trimmed_non_empty(intake.source_client_line_id.as_deref())
                .ok_or_else(|| {
                    CheckoutError::InvalidPayload(
                        "current-cart alteration intake requires source_client_line_id".to_string(),
                    )
                })?;
            if !line_ids.contains(&client_line_id) {
                return Err(CheckoutError::InvalidPayload(format!(
                    "alteration intake references unknown source_client_line_id {client_line_id}"
                )));
            }
            let source_item = items
                .iter()
                .find(|item| item.client_line_id.as_deref().map(str::trim) == Some(client_line_id.as_str()))
                .ok_or_else(|| {
                    CheckoutError::InvalidPayload(format!(
                        "alteration intake references unknown source_client_line_id {client_line_id}"
                    ))
                })?;
            if is_alteration_service_item(source_item) {
                return Err(CheckoutError::InvalidPayload(
                    "alteration source line cannot be another alteration service line".to_string(),
                ));
            }
            referenced.insert(client_line_id);
        }
        if intake.source_type.trim() == "custom_item"
            && trimmed_non_empty(intake.item_description.as_deref()).is_none()
        {
            return Err(CheckoutError::InvalidPayload(
                "custom alteration intake requires item_description".to_string(),
            ));
        }
        if intake.source_type.trim() == "past_transaction_line"
            && intake.source_transaction_line_id.is_none()
        {
            return Err(CheckoutError::InvalidPayload(
                "past-purchase alteration intake requires source_transaction_line_id".to_string(),
            ));
        }
        if intake.source_type.trim() == "catalog_item"
            && intake
                .source_sku
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .is_none()
            && intake.source_product_id.is_none()
            && intake.source_variant_id.is_none()
        {
            return Err(CheckoutError::InvalidPayload(
                "catalog alteration intake requires SKU or product reference".to_string(),
            ));
        }
        if trimmed_non_empty(Some(&intake.work_requested)).is_none() {
            return Err(CheckoutError::InvalidPayload(
                "alteration intake requires work_requested".to_string(),
            ));
        }
        referenced.insert(alteration_line_client_id);
    }

    for intake_id in service_lines_by_intake.keys() {
        if !intake_ids.contains(intake_id) {
            return Err(CheckoutError::InvalidPayload(
                "orphan alteration service line without matching intake".to_string(),
            ));
        }
    }

    Ok(referenced)
}

#[derive(Debug)]
pub enum CheckoutDone {
    Idempotent {
        transaction_id: Uuid,
        display_id: String,
    },
    Completed {
        transaction_id: Uuid,
        display_id: String,
        operator_staff_id: Uuid,
        customer_id: Option<Uuid>,
        price_override_audit: Vec<Value>,
        alteration_order_ids: Vec<Uuid>,
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
                client_line_id: if out.iter().any(|line: &CheckoutItem| {
                    line.client_line_id.as_deref() == item.client_line_id.as_deref()
                }) {
                    None
                } else {
                    item.client_line_id.clone()
                },
                line_type: item.line_type.clone(),
                alteration_intake_id: item.alteration_intake_id.clone(),
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
                custom_order_details: item.custom_order_details.clone(),
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
    let amount_paid = payload.amount_paid.round_dp(2);

    if let Some(ref splits) = payload.payment_splits {
        if !splits.is_empty() {
            let mut out: Vec<ResolvedPaymentSplit> = Vec::new();
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
                if m.eq_ignore_ascii_case("gift_card") && gift_card_code.is_none() {
                    return Err(CheckoutError::InvalidPayload(
                        "Gift card payment requires the card code.".to_string(),
                    ));
                }
                if !m.eq_ignore_ascii_case("gift_card") && gift_card_code.is_some() {
                    return Err(CheckoutError::InvalidPayload(
                        "gift_card_code is only allowed for gift card payments".to_string(),
                    ));
                }

                let incoming_meta = line.metadata.clone().unwrap_or_else(|| json!({}));
                let mut normalized_meta = if pos_rms_charge::is_rms_method(m) {
                    pos_rms_charge::normalized_rms_metadata(m, &incoming_meta)
                } else {
                    incoming_meta
                };
                if applied_deposit_amount > Decimal::ZERO {
                    let mut object = normalized_meta.as_object().cloned().unwrap_or_default();
                    object.insert(
                        "applied_deposit_amount".to_string(),
                        Value::String(applied_deposit_amount.to_string()),
                    );
                    normalized_meta = Value::Object(object);
                }
                if m.eq_ignore_ascii_case("gift_card") {
                    let mut object = normalized_meta.as_object().cloned().unwrap_or_default();
                    if let Some(sub_type) = line
                        .sub_type
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        object.insert("sub_type".to_string(), Value::String(sub_type.to_string()));
                    }
                    if let Some(code) = gift_card_code.as_deref() {
                        object.insert(
                            "gift_card_code".to_string(),
                            Value::String(code.to_ascii_uppercase()),
                        );
                    }
                    normalized_meta = Value::Object(object);
                }
                let stripe_intent_id = normalized_meta
                    .get("stripe_intent_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let card_brand = normalized_meta
                    .get("card_brand")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let card_last4 = normalized_meta
                    .get("card_last4")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let check_number = line.check_number.clone().or_else(|| {
                    normalized_meta
                        .get("check_number")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                });
                if m.eq_ignore_ascii_case("check")
                    && check_number
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .is_none()
                {
                    return Err(CheckoutError::InvalidPayload(
                        "check payment requires check_number".to_string(),
                    ));
                }

                let fee = if stripe_intent_id.is_some() {
                    estimate_stripe_fee(
                        a,
                        m.to_lowercase().contains("terminal")
                            || m.to_lowercase().contains("present"),
                    )
                } else {
                    Decimal::ZERO
                };

                out.push(ResolvedPaymentSplit {
                    method: m.to_string(),
                    amount: a,
                    gift_card_code: gift_card_code.clone(),
                    metadata: normalized_meta,
                    stripe_intent_id,
                    check_number,
                    merchant_fee: fee,
                    net_amount: a - fee,
                    card_brand,
                    card_last4,
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
    if m.eq_ignore_ascii_case("check") {
        return Err(CheckoutError::InvalidPayload(
            "check payment requires check_number".to_string(),
        ));
    }
    Ok((
        vec![ResolvedPaymentSplit {
            method: m.to_string(),
            amount: amount_paid,
            gift_card_code: None,
            metadata: json!({}),
            stripe_intent_id: None,
            check_number: None,
            merchant_fee: Decimal::ZERO,
            net_amount: amount_paid,
            card_brand: None,
            card_last4: None,
        }],
        m.to_string(),
    ))
}

async fn prepare_live_corecard_postings(
    pool: &PgPool,
    http: &reqwest::Client,
    config: &corecard::CoreCardConfig,
    token_cache: &Arc<Mutex<corecard::CoreCardTokenCache>>,
    payload: &CheckoutRequest,
    payment_splits: &mut [ResolvedPaymentSplit],
    is_rms_payment_collection: bool,
) -> Result<(), CheckoutError> {
    let Some(customer_id) = payload.customer_id else {
        if payment_splits
            .iter()
            .any(|split| pos_rms_charge::is_rms_method(&split.method))
            || is_rms_payment_collection
        {
            return Err(CheckoutError::InvalidPayload(
                "RMS Charge requires an active customer on the sale.".to_string(),
            ));
        }
        return Ok(());
    };

    let checkout_client_id = payload.checkout_client_id.ok_or_else(|| {
        CheckoutError::InvalidPayload(
            "RMS Charge live posting requires checkout_client_id for idempotency.".to_string(),
        )
    })?;

    for (index, split) in payment_splits.iter_mut().enumerate() {
        if !pos_rms_charge::is_rms_method(&split.method) {
            continue;
        }

        let linked_corecredit_customer_id = metadata_required_text(
            &split.metadata,
            "linked_corecredit_customer_id",
            "RMS Charge checkout could not resolve the linked CoreCredit customer.",
        )?;
        let linked_corecredit_account_id = metadata_required_text(
            &split.metadata,
            "linked_corecredit_account_id",
            "RMS Charge checkout could not resolve the linked CoreCredit account.",
        )?;
        let program_code = metadata_required_text(
            &split.metadata,
            "program_code",
            "RMS Charge requires a financing program selection before checkout can continue.",
        )?;
        let linked_corecredit_card_id =
            metadata_optional_text(&split.metadata, "linked_corecredit_card_id");
        let stable_reference = format!("{checkout_client_id}:purchase:{index}");
        let idempotency_key = corecard::build_idempotency_key(
            corecard::CoreCardOperationType::Purchase,
            &stable_reference,
            &linked_corecredit_account_id,
            split.amount,
            Some(&program_code),
        );
        let request = corecard::CoreCardMutationRequest {
            customer_id: Some(customer_id),
            linked_corecredit_customer_id,
            linked_corecredit_account_id,
            linked_corecredit_card_id,
            program_code: Some(program_code.clone()),
            amount: split.amount,
            idempotency_key: idempotency_key.clone(),
            transaction_id: None,
            payment_transaction_id: None,
            pos_rms_charge_record_id: None,
            reason: None,
            reference_hint: Some(format!("ROS-CHECKOUT-{checkout_client_id}")),
            metadata: json!({
                "checkout_client_id": checkout_client_id.to_string(),
                "program_label": metadata_optional_text(&split.metadata, "program_label"),
                "masked_account": metadata_optional_text(&split.metadata, "masked_account"),
            }),
        };
        let result = match corecard::post_purchase(pool, http, config, token_cache, &request).await
        {
            Ok(result) => result,
            Err(error) => {
                let _ = log_staff_access(
                    pool,
                    payload.operator_staff_id,
                    "rms_charge_purchase_post_failed",
                    json!({
                        "checkout_client_id": checkout_client_id,
                        "account_id": request.linked_corecredit_account_id,
                        "program_code": request.program_code,
                        "amount": request.amount,
                        "error": error.to_string(),
                    }),
                )
                .await;
                return Err(corecard_error_to_checkout(error));
            }
        };
        let _ = log_staff_access(
            pool,
            payload.operator_staff_id,
            "rms_charge_purchase_posted",
            json!({
                "checkout_client_id": checkout_client_id,
                "account_id": request.linked_corecredit_account_id,
                "program_code": request.program_code,
                "amount": request.amount,
                "host_reference": result.host_reference,
                "external_transaction_id": result.external_transaction_id,
            }),
        )
        .await;
        apply_corecard_result_to_metadata(&mut split.metadata, &idempotency_key, &result);
    }

    if is_rms_payment_collection {
        let resolve = corecard::resolve_customer_account(
            pool,
            &corecard::PosResolveAccountRequest {
                customer_id: Some(customer_id),
                preferred_account_id: payment_splits.iter().find_map(|split| {
                    metadata_optional_text(&split.metadata, "linked_corecredit_account_id")
                }),
            },
        )
        .await
        .map_err(corecard_error_to_checkout)?;

        let selected_account = resolve.selected_account.ok_or_else(|| {
            let message = resolve
                .blocking_error
                .as_ref()
                .map(|value| value.message.clone())
                .unwrap_or_else(|| {
                    "RMS Charge payment collection requires a single linked account.".to_string()
                });
            CheckoutError::InvalidPayload(message)
        })?;

        let stable_reference = format!("{checkout_client_id}:payment");
        let idempotency_key = corecard::build_idempotency_key(
            corecard::CoreCardOperationType::Payment,
            &stable_reference,
            &selected_account.corecredit_account_id,
            payload.total_price,
            None,
        );
        let request = corecard::CoreCardMutationRequest {
            customer_id: Some(customer_id),
            linked_corecredit_customer_id: selected_account.corecredit_customer_id.clone(),
            linked_corecredit_account_id: selected_account.corecredit_account_id.clone(),
            linked_corecredit_card_id: None,
            program_code: None,
            amount: payload.total_price,
            idempotency_key: idempotency_key.clone(),
            transaction_id: None,
            payment_transaction_id: None,
            pos_rms_charge_record_id: None,
            reason: None,
            reference_hint: Some(format!("ROS-RMS-PAYMENT-{checkout_client_id}")),
            metadata: json!({
                "checkout_client_id": checkout_client_id.to_string(),
                "masked_account": selected_account.masked_account,
                "resolution_status": resolve.resolution_status,
            }),
        };
        let result = match corecard::post_payment(pool, http, config, token_cache, &request).await {
            Ok(result) => result,
            Err(error) => {
                let _ = log_staff_access(
                    pool,
                    payload.operator_staff_id,
                    "rms_charge_payment_post_failed",
                    json!({
                        "checkout_client_id": checkout_client_id,
                        "account_id": request.linked_corecredit_account_id,
                        "amount": request.amount,
                        "error": error.to_string(),
                    }),
                )
                .await;
                return Err(corecard_error_to_checkout(error));
            }
        };
        let _ = log_staff_access(
            pool,
            payload.operator_staff_id,
            "rms_charge_payment_posted",
            json!({
                "checkout_client_id": checkout_client_id,
                "account_id": request.linked_corecredit_account_id,
                "amount": request.amount,
                "host_reference": result.host_reference,
                "external_transaction_id": result.external_transaction_id,
            }),
        )
        .await;
        for split in payment_splits.iter_mut() {
            let mut obj = split.metadata.as_object().cloned().unwrap_or_default();
            obj.insert("rms_charge_collection".to_string(), Value::Bool(true));
            obj.insert(
                "tender_family".to_string(),
                Value::String(pos_rms_charge::RMS_TENDER_FAMILY.to_string()),
            );
            obj.insert(
                "linked_corecredit_customer_id".to_string(),
                Value::String(selected_account.corecredit_customer_id.clone()),
            );
            obj.insert(
                "linked_corecredit_account_id".to_string(),
                Value::String(selected_account.corecredit_account_id.clone()),
            );
            obj.insert(
                "masked_account".to_string(),
                Value::String(selected_account.masked_account.clone()),
            );
            obj.insert(
                "resolution_status".to_string(),
                Value::String(resolve.resolution_status.clone()),
            );
            split.metadata = Value::Object(obj);
            apply_corecard_result_to_metadata(&mut split.metadata, &idempotency_key, &result);
        }
    }

    Ok(())
}

pub async fn execute_checkout(
    pool: &PgPool,
    http: &reqwest::Client,
    corecard_config: &corecard::CoreCardConfig,
    corecard_token_cache: &Arc<Mutex<corecard::CoreCardTokenCache>>,
    global_employee_markup: Decimal,
    mut payload: CheckoutRequest,
) -> Result<CheckoutDone, CheckoutError> {
    let has_wedding_disbursements = payload
        .wedding_disbursements
        .as_ref()
        .is_some_and(|v| !v.is_empty());
    if payload.items.is_empty() && !has_wedding_disbursements {
        if !payload.order_payments.is_empty() {
            return Err(CheckoutError::InvalidPayload(
                "order_payments require a current sale in this phase".to_string(),
            ));
        }
        return Err(CheckoutError::InvalidPayload(
            "Cart cannot be empty (must have items or wedding payouts)".to_string(),
        ));
    }
    if payload.target_transaction_id.is_some() {
        return Err(CheckoutError::InvalidPayload(
            "target_transaction_id checkout is no longer supported; use order_payments[]"
                .to_string(),
        ));
    }

    let customer_id_orig = payload.customer_id;
    if let Some(cid) = payload.customer_id {
        payload.customer_id =
            Some(crate::logic::customer_couple::resolve_effective_customer_id(pool, cid).await?);
    }
    let order_payments = validate_order_payment_shape(
        payload.customer_id,
        customer_id_orig,
        &payload.order_payments,
    )?;

    for item in &payload.items {
        if item.quantity <= 0 {
            return Err(CheckoutError::InvalidPayload(format!(
                "Invalid quantity for variant {}",
                item.variant_id
            )));
        }
    }
    let alteration_client_line_ids = validate_checkout_alteration_intakes(
        payload.customer_id,
        &payload.items,
        &payload.alteration_intakes,
    )?;

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
        if !order_payments.is_empty() {
            return Err(CheckoutError::InvalidPayload(
                "RMS CHARGE PAYMENT does not support existing order payments".to_string(),
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
        if resolved.pos_line_kind.as_deref() == Some("alteration_service") {
            return Err(CheckoutError::InvalidPayload(
                "Discount events cannot apply to ALTERATION SERVICE".to_string(),
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

    let (mut payment_splits, payment_activity_label) = resolve_payment_splits(&payload)?;

    let has_rms_charge = payment_splits
        .iter()
        .any(|s| pos_rms_charge::is_rms_method(&s.method));
    prepare_live_corecard_postings(
        pool,
        http,
        corecard_config,
        corecard_token_cache,
        &payload,
        &mut payment_splits,
        is_rms_payment_collection,
    )
    .await?;
    let transaction_financing_metadata = pos_rms_charge::transaction_metadata_from_splits(
        payment_splits
            .iter()
            .map(|split| (split.method.as_str(), &split.metadata)),
    );

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

    if payload.is_tax_exempt
        && payload
            .tax_exempt_reason
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err(CheckoutError::InvalidPayload(
            "tax_exempt_reason is required for tax-exempt checkout".to_string(),
        ));
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
                || i.discount_event_id.is_some()
                || i.fulfillment == DbFulfillmentType::Custom;
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
        payload.is_tax_exempt,
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
    let requested_ship = payload.fulfillment_mode == Some(DbOrderFulfillmentMethod::Ship);
    if requested_ship && shipping_quote_id.is_none() {
        return Err(CheckoutError::InvalidPayload(
            "Ship current sale requires the Register Shipping action so rates, address, and shipment tracking are recorded."
                .to_string(),
        ));
    }
    if payload.fulfillment_mode == Some(DbOrderFulfillmentMethod::Pickup)
        && shipping_quote_id.is_some()
    {
        return Err(CheckoutError::InvalidPayload(
            "Shipping quote was attached but fulfillment mode is pickup; clear shipping or choose Ship Current Sale."
                .to_string(),
        ));
    }
    if shipping_quote_id.is_some() && payload.ship_to.is_none() {
        tracing::debug!(
            "checkout shipping uses ship_to from rate quote metadata; payload ship_to was empty"
        );
    }
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
    let order_payment_total: Decimal = order_payments
        .iter()
        .map(|payment| payment.amount)
        .sum::<Decimal>()
        .round_dp(2);

    if d_total > payload.amount_paid + tol {
        return Err(CheckoutError::InvalidPayload(
            "party disbursements cannot exceed amount collected".to_string(),
        ));
    }
    if d_total + order_payment_total > payload.amount_paid + tol {
        return Err(CheckoutError::InvalidPayload(
            "party disbursements and order payments cannot exceed amount collected".to_string(),
        ));
    }

    let amount_toward_order = (payload.amount_paid - d_total - order_payment_total).round_dp(2);
    if amount_toward_order < Decimal::ZERO {
        return Err(CheckoutError::InvalidPayload(
            "amount collected is less than party disbursements and order payments".to_string(),
        ));
    }

    if amount_toward_order > payload.total_price + tol {
        return Err(CheckoutError::InvalidPayload(
            "amount applied to this order exceeds total_price — reduce tenders or adjust party disbursements"
                .to_string(),
        ));
    }

    let rounding_adj = payload.rounding_adjustment.unwrap_or(Decimal::ZERO);
    let balance_due = (payload.total_price + rounding_adj - amount_toward_order).round_dp(2);
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

    let _set_fulfilled_at = order_status == DbOrderStatus::Fulfilled;

    let mut price_override_audit: Vec<Value> = Vec::new();

    let mut tx = pool.begin().await?;

    if let Some(cid) = payload.checkout_client_id {
        let existing: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM transactions WHERE checkout_client_id = $1")
                .bind(cid)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(tid) = existing {
            tx.commit().await?;
            tracing::info!(transaction_id = %tid, "checkout idempotent replay");
            let d_id: String =
                sqlx::query_scalar("SELECT display_id FROM transactions WHERE id = $1")
                    .bind(tid)
                    .fetch_one(pool)
                    .await?;
            return Ok(CheckoutDone::Idempotent {
                transaction_id: tid,
                display_id: d_id,
            });
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

    for payment in &order_payments {
        let target: Option<(Uuid, String, Option<Uuid>, Decimal, DbOrderStatus)> = sqlx::query_as(
            r#"
            SELECT
                o.id,
                COALESCE(o.display_id, o.id::text) AS display_id,
                o.customer_id,
                o.balance_due,
                o.status
            FROM transactions o
            WHERE o.id = $1
            FOR UPDATE
            "#,
        )
        .bind(payment.target_transaction_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((target_transaction_id, display_id, customer_id, balance_due, status)) = target
        else {
            return Err(CheckoutError::InvalidPayload(
                "order payment target transaction not found".to_string(),
            ));
        };
        let customer_id = customer_id.ok_or_else(|| {
            CheckoutError::InvalidPayload(
                "order payment target transaction has no customer".to_string(),
            )
        })?;
        let line_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM transaction_lines WHERE transaction_id = $1",
        )
        .bind(target_transaction_id)
        .fetch_one(&mut *tx)
        .await?;
        let target = ExistingOrderPaymentTarget {
            target_transaction_id,
            display_id,
            customer_id,
            balance_due: balance_due.round_dp(2),
            status,
            line_count,
        };
        validate_order_payment_against_target(payment, &target)?;
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

    let txn_insert: Result<(Uuid, String), SqlxError> = sqlx::query_as(
        r#"
        INSERT INTO transactions (
            customer_id, wedding_member_id, operator_id, primary_salesperson_id,
            total_price, amount_paid, balance_due, booked_at,
            weather_snapshot, checkout_client_id,
            fulfillment_method, ship_to, shipping_amount_usd,
            is_employee_purchase, is_rush, need_by_date,
            is_tax_exempt, tax_exempt_reason, register_session_id,
            rounding_adjustment, final_cash_due, metadata
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            CURRENT_TIMESTAMP,
            $8, $9,
            $10, $11, $12,
            $13, $14, $15, $16, $17, $18,
            $19, $20, $21
        )
        RETURNING id, display_id
        "#,
    )
    .bind(payload.customer_id)
    .bind(payload.wedding_member_id)
    .bind(payload.operator_staff_id)
    .bind(payload.primary_salesperson_id)
    .bind(payload.total_price)
    .bind(amount_toward_order)
    .bind(balance_due)
    .bind(weather_json)
    .bind(payload.checkout_client_id)
    .bind(order_fulfillment_method)
    .bind(order_ship_to)
    .bind(order_shipping_amt)
    .bind(is_employee_purchase_order)
    .bind(payload.is_rush)
    .bind(payload.need_by_date)
    .bind(payload.is_tax_exempt)
    .bind(payload.tax_exempt_reason.as_deref())
    .bind(payload.session_id)
    .bind(payload.rounding_adjustment.unwrap_or(Decimal::ZERO))
    .bind(payload.final_cash_due)
    .bind(&transaction_financing_metadata)
    .fetch_one(&mut *tx)
    .await;

    let (transaction_id, transaction_display_id): (Uuid, String) = match txn_insert {
        Ok(id_display) => id_display,
        Err(SqlxError::Database(db_err))
            if db_err.constraint() == Some("transactions_checkout_client_id_uidx") =>
        {
            let Some(cid) = payload.checkout_client_id else {
                return Err(CheckoutError::Database(SqlxError::Database(db_err)));
            };
            tx.rollback().await?;
            let r: (Uuid, String) = sqlx::query_as(
                "SELECT id, display_id FROM transactions WHERE checkout_client_id = $1",
            )
            .bind(cid)
            .fetch_one(pool)
            .await?;
            tracing::info!(transaction_id = %r.0, "checkout idempotent replay after checkout_client_id race");
            return Ok(CheckoutDone::Idempotent {
                transaction_id: r.0,
                display_id: r.1,
            });
        }
        Err(e) => return Err(e.into()),
    };

    if order_fulfillment_method == DbOrderFulfillmentMethod::Ship {
        crate::logic::shipment::insert_from_pos_order_tx(
            &mut tx,
            transaction_id,
            payload.customer_id,
            payload.operator_staff_id,
            ship_to_snapshot_for_registry,
            order_shipping_amt,
            pos_shippo_rate_object_id,
        )
        .await?;
    }

    // Order-level default: lines with no explicit `salesperson_id` inherit `primary_salesperson_id`
    // for `transaction_lines.salesperson_id` and per-line commission snapshots.
    let primary_for_lines = payload.primary_salesperson_id;

    // Takeaway stock to deduct once per variant (multiple cart lines can reference the same variant).
    let mut layaway_stock_by_variant: HashMap<Uuid, i32> = HashMap::new();
    let mut takeaway_stock_by_variant: HashMap<Uuid, i32> = HashMap::new();

    let mut fulfillment_order_id: Option<Uuid> = None;
    let mut fulfillment_order_display_id: Option<String> = None;

    let needs_fulfillment = payload
        .items
        .iter()
        .any(|i| i.fulfillment != DbFulfillmentType::Takeaway);
    if needs_fulfillment {
        let row: (Uuid, String) = sqlx::query_as(
            r#"
                INSERT INTO fulfillment_orders (customer_id, wedding_id, status)
                VALUES ($1, $2, 'open')
                RETURNING id, display_id
                "#,
        )
        .bind(payload.customer_id)
        .bind(payload.wedding_member_id)
        .fetch_one(&mut *tx)
        .await?;
        fulfillment_order_id = Some(row.0);
        fulfillment_order_display_id = Some(row.1);
    }

    let mut fulfillment_line_counter = 0;
    let mut transaction_line_by_client_id: HashMap<String, Uuid> = HashMap::new();

    for (idx, item) in payload.items.iter().enumerate() {
        let fulfillment = persist_fulfillment(payload.wedding_member_id, item.fulfillment)
            .map_err(|m| CheckoutError::InvalidPayload(m.to_string()))?;
        let line_fulfilled = fulfillment == DbFulfillmentType::Takeaway;

        let (target_fulfillment_id, line_display_id, fulfilled_at) = if !line_fulfilled {
            fulfillment_line_counter += 1;
            let parent_id = fulfillment_order_display_id
                .as_ref()
                .cloned()
                .unwrap_or_else(|| "ORD-UNKNOWN".to_string());
            (
                fulfillment_order_id,
                Some(format!("{parent_id}-{fulfillment_line_counter}")),
                None,
            )
        } else {
            (None, None, Some(Utc::now()))
        };

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
        if is_alteration_service_item(item) {
            let mut base = override_meta.unwrap_or_else(|| json!({}));
            if let serde_json::Value::Object(ref mut m) = base {
                m.insert("line_type".to_string(), json!("alteration_service"));
                if let Some(intake_id) = item
                    .alteration_intake_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    m.insert("alteration_intake_id".to_string(), json!(intake_id));
                }
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
            sales_commission::CommissionLineInput {
                unit_price: item.unit_price,
                quantity: item.quantity,
                salesperson_id: line_salesperson_id,
                product_id: item.product_id,
                variant_id: item.variant_id,
                is_employee_sale: is_employee_purchase_order,
            },
        )
        .await?;

        let logic_tax_cat = resolve_checkout_tax_category_tx(&mut tx, item.variant_id).await?;

        let pos_kind = fetch_variant_pos_line_kind(&mut *tx, item.variant_id).await?;
        // Internal POS-only service/payment lines must remain non-taxable.
        let (state_tax, local_tax) = if matches!(
            pos_kind.as_deref(),
            Some("rms_charge_payment") | Some("pos_gift_card_load") | Some("alteration_service")
        ) {
            (Decimal::ZERO, Decimal::ZERO)
        } else if payload.is_tax_exempt {
            let original_state_tax = crate::logic::tax::nys_state_tax_usd(
                logic_tax_cat,
                item.unit_price,
                item.unit_price,
            );
            let original_local_tax = crate::logic::tax::erie_local_tax_usd(
                logic_tax_cat,
                item.unit_price,
                item.unit_price,
            );
            if !original_state_tax.is_zero() || !original_local_tax.is_zero() {
                let mut base = override_meta.unwrap_or_else(|| json!({}));
                if let Value::Object(ref mut map) = base {
                    map.insert(
                        "tax_exempt_reason".to_string(),
                        json!(payload.tax_exempt_reason.as_deref().unwrap_or("")),
                    );
                    map.insert("original_state_tax".to_string(), json!(original_state_tax));
                    map.insert("original_local_tax".to_string(), json!(original_local_tax));
                    map.insert(
                        "tax_category".to_string(),
                        json!(format!("{:?}", logic_tax_cat)),
                    );
                }
                override_meta = Some(base);
            }
            (Decimal::ZERO, Decimal::ZERO)
        } else {
            (
                crate::logic::tax::nys_state_tax_usd(
                    logic_tax_cat,
                    item.unit_price,
                    item.unit_price,
                ),
                crate::logic::tax::erie_local_tax_usd(
                    logic_tax_cat,
                    item.unit_price,
                    item.unit_price,
                ),
            )
        };
        let line_is_internal = pos_kind.as_deref() == Some("rms_charge_payment");

        let custom_item_type = canonical_custom_item_type_for_variant(
            &mut tx,
            fulfillment,
            item.variant_id,
            item.custom_item_type.as_deref(),
        )
        .await?;
        let custom_subtype =
            sqlx::query_scalar::<_, String>("SELECT sku FROM product_variants WHERE id = $1")
                .bind(item.variant_id)
                .fetch_optional(&mut *tx)
                .await?
                .as_deref()
                .and_then(known_custom_subtype_for_sku);
        if let Some(details) =
            canonical_custom_order_details(custom_subtype, item.custom_order_details.as_ref())
        {
            let mut base = override_meta.unwrap_or_else(|| json!({}));
            if let Value::Object(ref mut map) = base {
                map.insert("custom_order_details".to_string(), details);
            }
            override_meta = Some(base);
        }

        let transaction_line_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO transaction_lines (
                    transaction_id, fulfillment_order_id, line_display_id,
                    product_id, variant_id, fulfillment, quantity,
                    unit_price, unit_cost, state_tax, local_tax, size_specs, 
                    is_fulfilled, fulfilled_at,
                    salesperson_id, calculated_commission,
                    custom_item_type, is_rush, need_by_date, needs_gift_wrap, is_internal
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
                RETURNING id
                "#,
            )
            .bind(transaction_id)
            .bind(target_fulfillment_id)
            .bind(line_display_id)
            .bind(item.product_id)
            .bind(item.variant_id)
            .bind(fulfillment)
            .bind(item.quantity)
            .bind(item.unit_price)
            .bind(item.unit_cost)
            .bind(state_tax)
            .bind(local_tax)
            .bind(override_meta)
            .bind(line_fulfilled)
            .bind(fulfilled_at)
            .bind(line_salesperson_id)
            .bind(commission)
            .bind(custom_item_type)
            .bind(item.is_rush)
            .bind(item.need_by_date)
            .bind(item.needs_gift_wrap)
            .bind(line_is_internal)
            .fetch_one(&mut *tx)
            .await?;

        if let Some(client_line_id) = trimmed_non_empty(item.client_line_id.as_deref()) {
            if alteration_client_line_ids.contains(&client_line_id) {
                transaction_line_by_client_id
                    .entry(client_line_id)
                    .or_insert(transaction_line_id);
            }
        }

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
                    event_id, transaction_id, transaction_line_id, variant_id, quantity,
                    line_subtotal, discount_percent
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                "#,
            )
            .bind(eid)
            .bind(transaction_id)
            .bind(transaction_line_id)
            .bind(item.variant_id)
            .bind(item.quantity)
            .bind(line_subtotal)
            .bind(pct)
            .execute(&mut *tx)
            .await?;
        }

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
                Some(transaction_id),
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
            Some("rms_charge_payment") | Some("pos_gift_card_load") | Some("alteration_service")
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

    let mut alteration_order_ids = Vec::new();
    for intake in &payload.alteration_intakes {
        let intake_id = trimmed_non_empty(Some(&intake.intake_id)).ok_or_else(|| {
            CheckoutError::InvalidPayload("alteration intake requires intake_id".to_string())
        })?;
        let alteration_line_client_id = trimmed_non_empty(Some(&intake.alteration_line_client_id))
            .ok_or_else(|| {
                CheckoutError::InvalidPayload(
                    "alteration intake requires alteration_line_client_id".to_string(),
                )
            })?;
        let charge_transaction_line_id = transaction_line_by_client_id
            .get(&alteration_line_client_id)
            .copied()
            .ok_or_else(|| {
                CheckoutError::InvalidPayload(format!(
                    "alteration intake could not link alteration_line_client_id {alteration_line_client_id}"
                ))
            })?;
        let source_client_line_id = trimmed_non_empty(intake.source_client_line_id.as_deref());
        let source_transaction_line_id = if intake.source_type.trim() == "current_cart_item" {
            let source_client_line_id = source_client_line_id.as_ref().ok_or_else(|| {
                CheckoutError::InvalidPayload(
                    "current-cart alteration intake requires source_client_line_id".to_string(),
                )
            })?;
            Some(
                transaction_line_by_client_id
                    .get(source_client_line_id)
                    .copied()
                    .ok_or_else(|| {
                        CheckoutError::InvalidPayload(format!(
                            "alteration intake could not link source_client_line_id {source_client_line_id}"
                        ))
                    })?,
            )
        } else {
            intake.source_transaction_line_id
        };
        let work_requested = trimmed_non_empty(Some(&intake.work_requested)).ok_or_else(|| {
            CheckoutError::InvalidPayload("alteration intake requires work_requested".to_string())
        })?;
        let item_description = trimmed_non_empty(intake.item_description.as_deref());
        let source_sku = trimmed_non_empty(intake.source_sku.as_deref());
        let notes = trimmed_non_empty(intake.notes.as_deref());
        let source_type = intake.source_type.trim();
        let source_transaction_id = if source_type == "current_cart_item" {
            Some(transaction_id)
        } else {
            intake.source_transaction_id
        };
        let charge_amount = intake.charge_amount.unwrap_or(Decimal::ZERO).round_dp(2);
        let source_snapshot = json!({
            "intake_id": intake_id,
            "alteration_line_client_id": alteration_line_client_id,
            "source_client_line_id": source_client_line_id,
            "phase": "pos_register_alteration_service_checkout",
        });

        let alteration_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO alteration_orders (
                customer_id, due_at, notes, transaction_id,
                source_type, item_description, work_requested,
                source_product_id, source_variant_id, source_sku,
                source_transaction_id, source_transaction_line_id,
                charge_amount, charge_transaction_line_id,
                intake_channel, source_snapshot
            )
            VALUES (
                $1, $2, $3, $4,
                $5::alteration_source_type, $6, $7,
                $8, $9, $10,
                $11, $12,
                $13, $14,
                'pos_register'::alteration_intake_channel, $15
            )
            RETURNING id
            "#,
        )
        .bind(payload.customer_id)
        .bind(intake.due_at.as_ref().cloned())
        .bind(notes.as_deref())
        .bind(transaction_id)
        .bind(source_type)
        .bind(item_description.as_deref())
        .bind(work_requested.as_str())
        .bind(intake.source_product_id)
        .bind(intake.source_variant_id)
        .bind(source_sku.as_deref())
        .bind(source_transaction_id)
        .bind(source_transaction_line_id)
        .bind(charge_amount)
        .bind(charge_transaction_line_id)
        .bind(Json(source_snapshot.clone()))
        .fetch_one(&mut *tx)
        .await?;
        alteration_order_ids.push(alteration_id);

        let detail = json!({
            "customer_id": payload.customer_id,
            "due_at": intake.due_at.as_ref().map(|d| d.to_rfc3339()),
            "notes_set": notes.is_some(),
            "linked_transaction_id": transaction_id,
            "source_type": source_type,
            "item_description": item_description,
            "work_requested": work_requested,
            "source_product_id": intake.source_product_id,
            "source_variant_id": intake.source_variant_id,
            "source_sku": source_sku,
            "source_transaction_id": source_transaction_id,
            "source_transaction_line_id": source_transaction_line_id,
            "charge_amount": charge_amount.to_string(),
            "charge_transaction_line_id": charge_transaction_line_id,
            "intake_channel": "pos_register",
            "source_snapshot_set": true,
        });
        sqlx::query(
            r#"
            INSERT INTO alteration_activity (alteration_id, staff_id, action, detail)
            VALUES ($1, $2, 'create', $3)
            "#,
        )
        .bind(alteration_id)
        .bind(payload.operator_staff_id)
        .bind(Json(detail))
        .execute(&mut *tx)
        .await?;
    }

    // 2) Evaluate Combo SPIFF Incentives
    // Group items by salesperson and check for satisfied bundle rules.
    let mut salesperson_items: HashMap<Uuid, Vec<&CheckoutItem>> = HashMap::new();
    for item in &payload.items {
        if is_alteration_service_item(item) {
            continue;
        }
        if let Some(sid) = item.salesperson_id.or(primary_for_lines) {
            salesperson_items.entry(sid).or_default().push(item);
        }
    }

    for (sid, staff_items) in salesperson_items {
        let incentives = evaluate_combo_incentives(&mut tx, &staff_items).await?;
        for inc in incentives {
            sqlx::query(
                r#"
                INSERT INTO transaction_lines (
                    transaction_id, product_id, variant_id, fulfillment, quantity,
                    unit_price, unit_cost, state_tax, local_tax, salesperson_id,
                    calculated_commission, is_fulfilled, is_internal, custom_item_type
                )
                VALUES ($1, $2, $3, $4, $5, 0, 0, 0, 0, $6, $7, $8, TRUE, 'spiff_reward')
                "#,
            )
            .bind(transaction_id)
            .bind(inc.product_id)
            .bind(inc.variant_id)
            .bind(DbFulfillmentType::Takeaway)
            .bind(1)
            .bind(sid)
            .bind(inc.reward_amount)
            .bind(order_status == DbOrderStatus::Fulfilled)
            .execute(&mut *tx)
            .await?;
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

    let order_short_ref = pos_rms_charge::transaction_compact_ref(transaction_id);
    let mut customer_display_rms: Option<String> = None;
    let mut rms_notifications: Vec<pos_rms_charge::RmsChargeNotify> = Vec::new();

    let payment_tx_category = if is_rms_payment_collection {
        DbTransactionCategory::RmsAccountPayment
    } else {
        DbTransactionCategory::RetailSale
    };
    let allocation_plan = build_payment_allocation_plan(
        &payment_splits,
        transaction_id,
        amount_toward_order,
        &order_payments,
    )?;
    let mut order_payment_targets_to_recalc: HashSet<Uuid> = HashSet::new();

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

        for split in &mut payment_splits {
            if split.amount <= Decimal::ZERO {
                continue;
            }
            let method = split.method.trim();

            // 1. Store credit redemption
            if method.eq_ignore_ascii_case("store_credit") {
                let cid = payload.customer_id.ok_or_else(|| {
                    CheckoutError::InvalidPayload("customer_id required".to_string())
                })?;
                store_credit::apply_checkout_redemption(&mut tx, cid, split.amount, transaction_id)
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
                    transaction_id,
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
                    let requested_sub_type = split
                        .metadata
                        .get("sub_type")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty());
                    let redemption = gift_card_ops::prepare_redemption_in_tx(
                        &mut tx,
                        card_code,
                        requested_sub_type,
                        split.amount,
                    )
                    .await
                    .map_err(|error| match error {
                        gift_card_ops::GiftCardOpError::BadRequest(message) => {
                            CheckoutError::InvalidPayload(message)
                        }
                        gift_card_ops::GiftCardOpError::Db(db) => CheckoutError::Database(db),
                    })?;

                    let mut metadata_object =
                        split.metadata.as_object().cloned().unwrap_or_default();
                    metadata_object.insert(
                        "sub_type".to_string(),
                        Value::String(redemption.canonical_sub_type.clone()),
                    );
                    metadata_object.insert(
                        "gift_card_card_kind".to_string(),
                        Value::String(redemption.card_kind.clone()),
                    );
                    metadata_object.insert(
                        "gift_card_code".to_string(),
                        Value::String(card_code.to_ascii_uppercase()),
                    );
                    split.metadata = Value::Object(metadata_object);

                    sqlx::query(
                        "UPDATE gift_cards SET current_balance = $1, card_status = $2::gift_card_status WHERE id = $3"
                    )
                    .bind(redemption.new_balance)
                    .bind(redemption.new_status)
                    .bind(redemption.card_id)
                    .execute(&mut *tx)
                    .await?;

                    sqlx::query(
                        r#"
                        INSERT INTO gift_card_events
                            (gift_card_id, event_kind, amount, balance_after, transaction_id, session_id)
                        VALUES ($1, 'redeemed', $2, $3, $4, $5)
                        "#,
                    )
                    .bind(redemption.card_id)
                    .bind(-split.amount)
                    .bind(redemption.new_balance)
                    .bind(transaction_id)
                    .bind(payload.session_id)
                    .execute(&mut *tx)
                    .await?;
                }
            }

            // 3. Create the movement record (payment_transactions)
            let payment_tx_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO payment_transactions (
                    session_id, wedding_member_id, category, payment_method, amount, metadata,
                    stripe_intent_id, merchant_fee, net_amount, card_brand, card_last4, check_number
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                RETURNING id
                "#,
            )
            .bind(payload.session_id)
            .bind(payload.wedding_member_id)
            .bind(payment_tx_category)
            .bind(method)
            .bind(split.amount)
            .bind(&split.metadata)
            .bind(&split.stripe_intent_id)
            .bind(split.merchant_fee)
            .bind(split.net_amount)
            .bind(&split.card_brand)
            .bind(&split.card_last4)
            .bind(&split.check_number)
            .fetch_one(&mut *tx)
            .await?;

            if pos_rms_charge::is_rms_method(method) {
                let rms_record_id = pos_rms_charge::insert_rms_record(
                    &mut *tx,
                    "charge",
                    transaction_id,
                    payload.session_id,
                    payload.customer_id,
                    method,
                    split.amount,
                    payload.operator_staff_id,
                    payment_tx_id,
                    customer_display_rms.as_deref(),
                    &order_short_ref,
                    Some(&split.metadata),
                )
                .await?;
                if let Some(idempotency_key) =
                    metadata_optional_text(&split.metadata, "idempotency_key")
                {
                    corecard::attach_posting_event_refs(
                        &mut *tx,
                        &idempotency_key,
                        Some(transaction_id),
                        Some(payment_tx_id),
                        Some(rms_record_id),
                    )
                    .await
                    .map_err(corecard_error_to_checkout)?;
                }
                rms_notifications.push(pos_rms_charge::RmsChargeNotify {
                    payment_transaction_id: payment_tx_id,
                    amount: split.amount,
                    method: method.to_string(),
                    metadata: split.metadata.clone(),
                });
            } else if is_rms_payment_collection {
                let rms_record_id = pos_rms_charge::insert_rms_record(
                    &mut *tx,
                    "payment",
                    transaction_id,
                    payload.session_id,
                    payload.customer_id,
                    method,
                    split.amount,
                    payload.operator_staff_id,
                    payment_tx_id,
                    customer_display_rms.as_deref(),
                    &order_short_ref,
                    Some(&split.metadata),
                )
                .await?;
                if let Some(idempotency_key) =
                    metadata_optional_text(&split.metadata, "idempotency_key")
                {
                    corecard::attach_posting_event_refs(
                        &mut *tx,
                        &idempotency_key,
                        Some(transaction_id),
                        Some(payment_tx_id),
                        Some(rms_record_id),
                    )
                    .await
                    .map_err(corecard_error_to_checkout)?;
                }
            }

            main_tx_ids.push(payment_tx_id);

            for allocation in allocation_plan
                .iter()
                .filter(|allocation| allocation.payment_split_index == main_tx_ids.len() - 1)
            {
                sqlx::query(
                    r#"
                    INSERT INTO payment_allocations (
                        transaction_id, target_transaction_id, amount_allocated, metadata, check_number
                    )
                    VALUES ($1, $2, $3, $4, $5)
                    "#,
                )
                .bind(payment_tx_id)
                .bind(allocation.target_transaction_id)
                .bind(allocation.amount)
                .bind(&allocation.metadata)
                .bind(&allocation.check_number)
                .execute(&mut *tx)
                .await?;
                if allocation.is_existing_order_payment {
                    order_payment_targets_to_recalc.insert(allocation.target_transaction_id);
                }
            }
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
                        FROM transactions o
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

                    if let Some((bene_transaction_id, party_id)) = bene_order {
                        sqlx::query(
                            r#"
                            INSERT INTO payment_allocations (
                                transaction_id, target_transaction_id, amount_allocated, metadata
                            )
                            VALUES ($1, $2, $3, $4)
                            "#,
                        )
                        .bind(payer_tx_id)
                        .bind(bene_transaction_id)
                        .bind(d.amount)
                        .bind(json!({
                            "kind": "wedding_group_disbursement",
                            "payer_member_id": payload.wedding_member_id
                        }))
                        .execute(&mut *tx)
                        .await?;

                        transaction_recalc::recalc_transaction_totals(&mut tx, bene_transaction_id)
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
                                    "target_transaction_id": bene_transaction_id,
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
                                transaction_id,
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
                    transaction_id = COALESCE(transaction_id, $1),
                    status = CASE
                        WHEN $2 <= 0 THEN 'paid'
                        ELSE 'ordered'
                    END,
                    suit_ordered = TRUE,
                    ordered_date = COALESCE(ordered_date, CURRENT_DATE)
                WHERE id = $3
                "#,
            )
            .bind(transaction_id)
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
                        "transaction_id": transaction_id,
                        "amount_paid": payload.amount_paid,
                        "payment_method": payment_activity_label,
                        "balance_due": balance_due,
                    }),
                )
                .await?;
            }
        }
    }

    for payment in &order_payments {
        if !order_payment_targets_to_recalc.contains(&payment.target_transaction_id) {
            return Err(CheckoutError::InvalidPayload(
                "order payment was not allocated to its target transaction".to_string(),
            ));
        }
        sqlx::query("UPDATE transactions SET amount_paid = amount_paid + $1 WHERE id = $2")
            .bind(payment.amount)
            .bind(payment.target_transaction_id)
            .execute(&mut *tx)
            .await
            .map_err(CheckoutError::Database)?;

        transaction_recalc::recalc_transaction_totals(&mut tx, payment.target_transaction_id)
            .await?;
    }

    transaction_recalc::recalc_transaction_totals(&mut tx, transaction_id)
        .await
        .map_err(CheckoutError::Database)?;
    crate::logic::commission_events::upsert_fulfilled_transaction_events(
        &mut tx,
        transaction_id,
        &[],
    )
    .await
    .map_err(CheckoutError::Database)?;

    let operator_staff_id = payload.operator_staff_id;
    let customer_id = payload.customer_id;
    let amount_paid = amount_toward_order;
    let total_price = payload.total_price;
    let session_id_for_log = payload.session_id;

    tx.commit().await?;

    if !rms_notifications.is_empty() {
        if let Err(e) = pos_rms_charge::notify_sales_support_after_checkout(
            pool,
            transaction_id,
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
                transaction_id = %transaction_id,
                "RMS sales_support notification fan-out failed after checkout"
            );
        }
    }

    if is_rms_payment_collection && amount_paid > Decimal::ZERO {
        if let Some(cid) = customer_id {
            if let Err(e) = tasks::create_adhoc_rms_payment_followup_tasks(
                pool,
                transaction_id,
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
                    transaction_id = %transaction_id,
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
            "transaction_id": transaction_id,
            "register_session_id": session_id_for_log,
        }),
    )
    .await;

    if has_rms_charge && transaction_financing_metadata != json!({}) {
        let _ = log_staff_access(
            pool,
            operator_staff_id,
            "rms_charge_program_selected",
            json!({
                "transaction_id": transaction_id,
                "register_session_id": session_id_for_log,
                "metadata": transaction_financing_metadata,
            }),
        )
        .await;
    }

    Ok(CheckoutDone::Completed {
        transaction_id,
        display_id: transaction_display_id,
        operator_staff_id,
        customer_id,
        price_override_audit,
        alteration_order_ids,
        amount_paid,
        total_price,
    })
}

#[derive(Debug, Serialize)]
pub struct ComboSpiffReward {
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub reward_amount: Decimal,
    pub label: String,
}

/// Scans a salesperson's set of items for satisfied bundle rules (e.g. Suit + Tie + Shirt).
/// Returns a list of rewards to be inserted as 0.00 lines.
pub async fn evaluate_combo_incentives(
    conn: &mut sqlx::PgConnection,
    items: &[&CheckoutItem],
) -> Result<Vec<ComboSpiffReward>, CheckoutError> {
    let mut rewards = Vec::new();
    if items.is_empty() {
        return Ok(rewards);
    }

    // 1) Fetch all active combo rules
    let rules: Vec<sqlx::types::JsonValue> = sqlx::query_scalar(
        r#"
        SELECT json_build_object(
            'id', r.id,
            'label', r.label,
            'reward_amount', r.reward_amount,
            'items', (
                SELECT json_agg(json_build_object(
                    'match_type', ri.match_type,
                    'match_id', ri.match_id,
                    'qty_required', ri.qty_required
                ))
                FROM commission_combo_rule_items ri
                WHERE ri.rule_id = r.id
            )
        )
        FROM commission_combo_rules r
        WHERE r.is_active = TRUE
        "#,
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(CheckoutError::Database)?;

    // 2) Map item counts for current salesperson
    let mut cat_counts: HashMap<Uuid, i32> = HashMap::new();
    let mut prod_counts: HashMap<Uuid, i32> = HashMap::new();
    // Cache categories to avoid re-querying in inner loops
    let mut item_cat_map: HashMap<Uuid, Uuid> = HashMap::new();

    for item in items {
        *prod_counts.entry(item.product_id).or_default() += item.quantity;
        if let Some(cid) =
            sqlx::query_scalar::<_, Option<Uuid>>("SELECT category_id FROM products WHERE id = $1")
                .bind(item.product_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(CheckoutError::Database)?
                .flatten()
        {
            *cat_counts.entry(cid).or_default() += item.quantity;
            item_cat_map.insert(item.product_id, cid);
        }
    }

    // 3) Evaluate rules (repeatedly to catch multiple combos if per-bundle is allowed)
    for rule_json in rules {
        let reward_val = rule_json["reward_amount"].as_f64().unwrap_or(0.0);
        let reward_amount = Decimal::from_f64_retain(reward_val).unwrap_or(Decimal::ZERO);
        let label = rule_json["label"].as_str().unwrap_or("SPIFF").to_string();
        let requirements = rule_json["items"].as_array();

        if let Some(reqs) = requirements {
            loop {
                let mut satisfied = true;
                for req in reqs {
                    let m_type = req["match_type"].as_str().unwrap_or("");
                    let m_id =
                        Uuid::parse_str(req["match_id"].as_str().unwrap_or("")).unwrap_or_default();
                    let qty_req = req["qty_required"].as_i64().unwrap_or(1) as i32;

                    let available = if m_type == "product" {
                        prod_counts.get(&m_id).copied().unwrap_or(0)
                    } else {
                        cat_counts.get(&m_id).copied().unwrap_or(0)
                    };

                    if available < qty_req {
                        satisfied = false;
                        break;
                    }
                }

                if satisfied {
                    let reward_context = reqs
                        .iter()
                        .find_map(|req| {
                            let m_type = req["match_type"].as_str().unwrap_or("");
                            let m_id = Uuid::parse_str(req["match_id"].as_str().unwrap_or(""))
                                .unwrap_or_default();
                            if m_type == "product" {
                                items
                                    .iter()
                                    .find(|item| item.product_id == m_id)
                                    .map(|item| (item.product_id, item.variant_id))
                            } else {
                                items
                                    .iter()
                                    .find(|item| item_cat_map.get(&item.product_id) == Some(&m_id))
                                    .map(|item| (item.product_id, item.variant_id))
                            }
                        })
                        .or_else(|| items.first().map(|item| (item.product_id, item.variant_id)));

                    // Consume quantities
                    for req in reqs {
                        let m_type = req["match_type"].as_str().unwrap_or("");
                        let m_id = Uuid::parse_str(req["match_id"].as_str().unwrap_or(""))
                            .unwrap_or_default();
                        let qty_req = req["qty_required"].as_i64().unwrap_or(1) as i32;

                        if m_type == "product" {
                            prod_counts.entry(m_id).and_modify(|q| *q -= qty_req);
                        } else {
                            cat_counts.entry(m_id).and_modify(|q| *q -= qty_req);
                        }
                    }

                    if let Some((product_id, variant_id)) = reward_context {
                        rewards.push(ComboSpiffReward {
                            product_id,
                            variant_id,
                            reward_amount,
                            label: label.clone(),
                        });
                    }
                } else {
                    break;
                }
            }
        }
    }

    Ok(rewards)
}

/// Estimates Stripe processing fees to provide immediate net financial reporting.
/// In-person (Terminal) defaults to 2.7% + $0.05. Online / Manual Entry defaults to 2.9% + $0.30.
fn estimate_stripe_fee(amount: Decimal, is_terminal: bool) -> Decimal {
    if is_terminal {
        // 2.7% + 5 cents
        let pct = amount * Decimal::new(27, 3); // 0.027
        let fixed = Decimal::new(5, 2); // 0.05
        (pct + fixed).round_dp(2)
    } else {
        // 2.9% + 30 cents
        let pct = amount * Decimal::new(29, 3); // 0.029
        let fixed = Decimal::new(30, 2); // 0.30
        (pct + fixed).round_dp(2)
    }
}

async fn fetch_variant_pos_line_kind<'e, E>(
    conn: E,
    variant_id: Uuid,
) -> Result<Option<String>, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    sqlx::query_scalar::<_, Option<String>>(
        r#"
        SELECT p.pos_line_kind
        FROM product_variants v
        INNER JOIN products p ON p.id = v.product_id
        WHERE v.id = $1
        "#,
    )
    .bind(variant_id)
    .fetch_optional(conn)
    .await
    .map(|row| row.flatten())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_corecard_result_to_metadata, build_payment_allocation_plan,
        corecard_error_to_checkout, fetch_variant_pos_line_kind,
        validate_checkout_alteration_intakes, validate_order_payment_against_target,
        validate_order_payment_shape, CheckoutAlterationIntake, CheckoutItem, CheckoutOrderPayment,
        ExistingOrderPaymentTarget, ResolvedOrderPayment, ResolvedPaymentSplit,
    };
    use crate::logic::corecard::{CoreCardFailureCode, CoreCardHostMutationResult};
    use crate::models::{DbFulfillmentType, DbOrderStatus};
    use rust_decimal::Decimal;
    use serde_json::json;
    use sqlx::Connection;
    use uuid::Uuid;

    fn checkout_item_with_client_line(client_line_id: Option<&str>) -> CheckoutItem {
        CheckoutItem {
            client_line_id: client_line_id.map(str::to_string),
            line_type: None,
            alteration_intake_id: None,
            product_id: Uuid::new_v4(),
            variant_id: Uuid::new_v4(),
            fulfillment: DbFulfillmentType::Takeaway,
            quantity: 1,
            unit_price: Decimal::new(10000, 2),
            original_unit_price: None,
            price_override_reason: None,
            unit_cost: Decimal::new(4000, 2),
            state_tax: Decimal::ZERO,
            local_tax: Decimal::ZERO,
            salesperson_id: None,
            discount_event_id: None,
            gift_card_load_code: None,
            custom_item_type: None,
            custom_order_details: None,
            is_rush: false,
            need_by_date: None,
            needs_gift_wrap: false,
        }
    }

    fn alteration_service_item(
        client_line_id: &str,
        intake_id: &str,
        amount: Decimal,
    ) -> CheckoutItem {
        CheckoutItem {
            client_line_id: Some(client_line_id.to_string()),
            line_type: Some("alteration_service".to_string()),
            alteration_intake_id: Some(intake_id.to_string()),
            product_id: Uuid::new_v4(),
            variant_id: Uuid::new_v4(),
            fulfillment: DbFulfillmentType::Takeaway,
            quantity: 1,
            unit_price: amount,
            original_unit_price: Some(Decimal::ZERO),
            price_override_reason: Some("alteration_service".to_string()),
            unit_cost: Decimal::ZERO,
            state_tax: Decimal::ZERO,
            local_tax: Decimal::ZERO,
            salesperson_id: None,
            discount_event_id: None,
            gift_card_load_code: None,
            custom_item_type: Some("alteration_service".to_string()),
            custom_order_details: None,
            is_rush: false,
            need_by_date: None,
            needs_gift_wrap: false,
        }
    }

    fn current_cart_alteration(source_client_line_id: &str) -> CheckoutAlterationIntake {
        CheckoutAlterationIntake {
            intake_id: "intake-1".to_string(),
            alteration_line_client_id: "alt-line-1".to_string(),
            source_client_line_id: Some(source_client_line_id.to_string()),
            source_type: "current_cart_item".to_string(),
            item_description: Some("Suit jacket".to_string()),
            work_requested: "Hem sleeves".to_string(),
            source_product_id: Some(Uuid::new_v4()),
            source_variant_id: Some(Uuid::new_v4()),
            source_sku: Some("ALT-SUIT".to_string()),
            source_transaction_id: None,
            source_transaction_line_id: None,
            charge_amount: None,
            due_at: None,
            notes: Some("Customer prefers a shorter break.".to_string()),
        }
    }

    #[test]
    fn transaction_checkout_alteration_validation_allows_empty_normal_checkout() {
        let result = validate_checkout_alteration_intakes(
            None,
            &[checkout_item_with_client_line(None)],
            &[],
        )
        .unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn transaction_checkout_alteration_validation_requires_customer() {
        let err = validate_checkout_alteration_intakes(
            None,
            &[
                checkout_item_with_client_line(Some("cart-1")),
                alteration_service_item("alt-line-1", "intake-1", Decimal::ZERO),
            ],
            &[current_cart_alteration("cart-1")],
        )
        .unwrap_err();
        assert!(err.to_string().contains("customer_id is required"));
    }

    #[test]
    fn transaction_checkout_alteration_validation_rejects_unknown_client_line_id() {
        let err = validate_checkout_alteration_intakes(
            Some(Uuid::new_v4()),
            &[
                checkout_item_with_client_line(Some("cart-1")),
                alteration_service_item("alt-line-1", "intake-1", Decimal::ZERO),
            ],
            &[current_cart_alteration("cart-missing")],
        )
        .unwrap_err();
        assert!(err.to_string().contains("unknown source_client_line_id"));
    }

    #[test]
    fn transaction_checkout_alteration_validation_rejects_invalid_source() {
        let mut intake = current_cart_alteration("cart-1");
        intake.source_type = "legacy_source".to_string();
        let err = validate_checkout_alteration_intakes(
            Some(Uuid::new_v4()),
            &[
                checkout_item_with_client_line(Some("cart-1")),
                alteration_service_item("alt-line-1", "intake-1", Decimal::ZERO),
            ],
            &[intake],
        )
        .unwrap_err();
        assert!(err.to_string().contains("source_type is invalid"));
    }

    #[test]
    fn transaction_checkout_alteration_validation_allows_charged_matching_line() {
        let mut intake = current_cart_alteration("cart-1");
        intake.charge_amount = Some(Decimal::new(1000, 2));
        let result = validate_checkout_alteration_intakes(
            Some(Uuid::new_v4()),
            &[
                checkout_item_with_client_line(Some("cart-1")),
                alteration_service_item("alt-line-1", "intake-1", Decimal::new(1000, 2)),
            ],
            &[intake],
        )
        .unwrap();
        assert!(result.contains("cart-1"));
        assert!(result.contains("alt-line-1"));
    }

    #[test]
    fn transaction_checkout_alteration_validation_rejects_amount_mismatch() {
        let mut intake = current_cart_alteration("cart-1");
        intake.charge_amount = Some(Decimal::new(1800, 2));
        let err = validate_checkout_alteration_intakes(
            Some(Uuid::new_v4()),
            &[
                checkout_item_with_client_line(Some("cart-1")),
                alteration_service_item("alt-line-1", "intake-1", Decimal::new(1000, 2)),
            ],
            &[intake],
        )
        .unwrap_err();
        assert!(err.to_string().contains("must match"));
    }

    #[test]
    fn transaction_checkout_alteration_validation_rejects_orphan_service_line() {
        let err = validate_checkout_alteration_intakes(
            Some(Uuid::new_v4()),
            &[alteration_service_item(
                "alt-line-1",
                "intake-1",
                Decimal::ZERO,
            )],
            &[],
        )
        .unwrap_err();
        assert!(err.to_string().contains("matching alteration intake"));
    }

    #[test]
    fn transaction_checkout_alteration_validation_returns_linked_client_line_ids() {
        let result = validate_checkout_alteration_intakes(
            Some(Uuid::new_v4()),
            &[
                checkout_item_with_client_line(Some("cart-1")),
                alteration_service_item("alt-line-1", "intake-1", Decimal::ZERO),
            ],
            &[current_cart_alteration("cart-1")],
        )
        .unwrap();
        assert!(result.contains("cart-1"));
        assert!(result.contains("alt-line-1"));
    }

    fn order_payment_payload(
        customer_id: Uuid,
        target_transaction_id: Uuid,
        amount: Decimal,
        balance_before: Decimal,
    ) -> CheckoutOrderPayment {
        CheckoutOrderPayment {
            client_line_id: format!("order-pay-{target_transaction_id}"),
            target_transaction_id,
            target_display_id: "TXN-12345".to_string(),
            customer_id,
            amount,
            balance_before,
            projected_balance_after: (balance_before - amount).round_dp(2),
        }
    }

    fn target_snapshot(
        customer_id: Uuid,
        target_transaction_id: Uuid,
        balance_due: Decimal,
    ) -> ExistingOrderPaymentTarget {
        ExistingOrderPaymentTarget {
            target_transaction_id,
            display_id: "TXN-12345".to_string(),
            customer_id,
            balance_due,
            status: DbOrderStatus::Open,
            line_count: 1,
        }
    }

    fn resolved_split(amount: Decimal) -> ResolvedPaymentSplit {
        ResolvedPaymentSplit {
            method: "cash".to_string(),
            amount,
            gift_card_code: None,
            metadata: json!({}),
            stripe_intent_id: None,
            check_number: None,
            merchant_fee: Decimal::ZERO,
            net_amount: amount,
            card_brand: None,
            card_last4: None,
        }
    }

    #[test]
    fn transaction_checkout_order_payment_shape_rejects_order_payment_only_customer_gap() {
        let customer_id = Uuid::new_v4();
        let target_id = Uuid::new_v4();
        let err = validate_order_payment_shape(
            None,
            None,
            &[order_payment_payload(
                customer_id,
                target_id,
                Decimal::new(2500, 2),
                Decimal::new(10000, 2),
            )],
        )
        .unwrap_err();
        assert!(err.to_string().contains("customer_id is required"));
    }

    #[test]
    fn transaction_checkout_order_payment_shape_rejects_duplicate_targets() {
        let customer_id = Uuid::new_v4();
        let target_id = Uuid::new_v4();
        let mut first = order_payment_payload(
            customer_id,
            target_id,
            Decimal::new(2500, 2),
            Decimal::new(10000, 2),
        );
        first.client_line_id = "line-a".to_string();
        let mut second = order_payment_payload(
            customer_id,
            target_id,
            Decimal::new(1500, 2),
            Decimal::new(7500, 2),
        );
        second.client_line_id = "line-b".to_string();

        let err =
            validate_order_payment_shape(Some(customer_id), Some(customer_id), &[first, second])
                .unwrap_err();
        assert!(err
            .to_string()
            .contains("duplicate order payment target_transaction_id"));
    }

    #[test]
    fn transaction_checkout_order_payment_target_rejects_overpayment() {
        let customer_id = Uuid::new_v4();
        let target_id = Uuid::new_v4();
        let payload = validate_order_payment_shape(
            Some(customer_id),
            Some(customer_id),
            &[order_payment_payload(
                customer_id,
                target_id,
                Decimal::new(12500, 2),
                Decimal::new(12500, 2),
            )],
        )
        .unwrap();
        let mut target = target_snapshot(customer_id, target_id, Decimal::new(10000, 2));
        target.display_id = payload[0].target_display_id.clone();
        let err = validate_order_payment_against_target(&payload[0], &target).unwrap_err();
        assert!(err
            .to_string()
            .contains("cannot exceed current balance_due"));
    }

    #[test]
    fn transaction_checkout_order_payment_target_rejects_wrong_customer() {
        let checkout_customer_id = Uuid::new_v4();
        let other_customer_id = Uuid::new_v4();
        let target_id = Uuid::new_v4();
        let payload = validate_order_payment_shape(
            Some(checkout_customer_id),
            Some(checkout_customer_id),
            &[order_payment_payload(
                checkout_customer_id,
                target_id,
                Decimal::new(2500, 2),
                Decimal::new(10000, 2),
            )],
        )
        .unwrap();
        let mut target = target_snapshot(other_customer_id, target_id, Decimal::new(10000, 2));
        target.display_id = payload[0].target_display_id.clone();
        let err = validate_order_payment_against_target(&payload[0], &target).unwrap_err();
        assert!(err.to_string().contains("different customer"));
    }

    #[test]
    fn transaction_checkout_allocation_plan_splits_current_sale_and_existing_order() {
        let current_tx_id = Uuid::new_v4();
        let customer_id = Uuid::new_v4();
        let target_id = Uuid::new_v4();
        let order_payments = vec![ResolvedOrderPayment {
            client_line_id: "order-pay-1".to_string(),
            target_transaction_id: target_id,
            target_display_id: "TXN-12345".to_string(),
            customer_id,
            amount: Decimal::new(4000, 2),
            balance_before: Decimal::new(10000, 2),
            projected_balance_after: Decimal::new(6000, 2),
        }];

        let plan = build_payment_allocation_plan(
            &[resolved_split(Decimal::new(10000, 2))],
            current_tx_id,
            Decimal::new(6000, 2),
            &order_payments,
        )
        .unwrap();

        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].target_transaction_id, current_tx_id);
        assert_eq!(plan[0].amount, Decimal::new(6000, 2));
        assert!(!plan[0].is_existing_order_payment);
        assert_eq!(plan[1].target_transaction_id, target_id);
        assert_eq!(plan[1].amount, Decimal::new(4000, 2));
        assert!(plan[1].is_existing_order_payment);
        assert_eq!(
            plan[1]
                .metadata
                .get("kind")
                .and_then(|value| value.as_str()),
            Some("existing_order_payment")
        );
        assert_eq!(
            plan[1]
                .metadata
                .get("applied_deposit_amount")
                .and_then(|value| value.as_str()),
            Some("40.00")
        );
    }

    #[tokio::test]
    async fn fetch_variant_pos_line_kind_allows_null_product_kind() {
        let Ok(database_url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let mut conn = sqlx::PgConnection::connect(&database_url)
            .await
            .expect("connect test database");
        let mut tx = conn.begin().await.expect("begin transaction");

        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        let sku = format!("E2E-NULL-KIND-{}", Uuid::new_v4().simple());

        sqlx::query(
            r#"
            INSERT INTO products (id, name, base_retail_price, base_cost, pos_line_kind)
            VALUES ($1, $2, $3, $4, NULL)
            "#,
        )
        .bind(product_id)
        .bind("Null POS kind regression product")
        .bind(Decimal::new(10000, 2))
        .bind(Decimal::new(4000, 2))
        .execute(&mut *tx)
        .await
        .expect("insert product");

        sqlx::query(
            r#"
            INSERT INTO product_variants (id, product_id, sku, variation_values)
            VALUES ($1, $2, $3, '{}'::jsonb)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(&sku)
        .execute(&mut *tx)
        .await
        .expect("insert variant");

        let pos_kind = fetch_variant_pos_line_kind(&mut *tx, variant_id)
            .await
            .expect("query should decode null pos_line_kind");

        assert_eq!(pos_kind, None);

        tx.rollback().await.expect("rollback transaction");
    }

    #[test]
    fn apply_corecard_result_to_metadata_persists_host_reference() {
        let mut metadata = json!({
            "tender_family": "rms_charge",
            "program_code": "rms90"
        });
        apply_corecard_result_to_metadata(
            &mut metadata,
            "idem-1",
            &CoreCardHostMutationResult {
                operation_type: "purchase".to_string(),
                posting_status: "posted".to_string(),
                external_transaction_id: Some("host-tx-1".to_string()),
                external_auth_code: Some("AUTH".to_string()),
                external_transaction_type: Some("purchase".to_string()),
                host_reference: Some("REF-1".to_string()),
                posted_at: None,
                reversed_at: None,
                refunded_at: None,
                metadata: json!({ "status": "posted" }),
            },
        );
        assert_eq!(
            metadata
                .get("host_reference")
                .and_then(|value| value.as_str()),
            Some("REF-1")
        );
        assert_eq!(
            metadata
                .get("posting_status")
                .and_then(|value| value.as_str()),
            Some("posted")
        );
    }

    #[test]
    fn corecard_host_failure_maps_to_checkout_block() {
        let err = corecard_error_to_checkout(crate::logic::corecard::CoreCardError::host_failure(
            CoreCardFailureCode::HostUnavailable,
            "Host unavailable",
            true,
        ));
        match err {
            super::CheckoutError::CoreCardHostFailure(message) => {
                assert!(message.contains("Host unavailable"));
            }
            other => panic!("expected CoreCardHostFailure, got {other:?}"),
        }
    }
}
