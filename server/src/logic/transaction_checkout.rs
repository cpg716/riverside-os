//! POS checkout: split resolution, validation, and transactional persistence.

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Error as SqlxError, Executor, PgPool, Postgres};
use std::collections::{HashMap, HashSet};
use std::time::Instant;
use thiserror::Error;
use uuid::Uuid;

use crate::logic::checkout_validate;
use crate::logic::custom_orders::{
    canonical_custom_order_details, known_custom_item_type_for_sku, known_custom_subtype_for_sku,
};
use crate::logic::customer_open_deposit;
use crate::logic::gift_card_ops;
use crate::logic::order_lifecycle;
use crate::logic::pricing_limits;
use crate::logic::sales_commission;
use crate::logic::store_credit;
use crate::logic::tax::{erie_local_tax_usd, nys_state_tax_usd, TaxCategory};
use crate::logic::transaction_fulfillment::persist_fulfillment;
use crate::logic::transaction_recalc;
use crate::logic::weather;
use crate::logic::{operational_outbox, pos_rms_charge, staff_accounts};
use crate::models::{
    DbFulfillmentType, DbOrderFulfillmentMethod, DbOrderItemLifecycleStatus, DbOrderStatus,
    DbTransactionCategory,
};
use crate::services::inventory;
use sqlx::types::Json;
use std::sync::Arc;
use tokio::sync::Mutex;

const CUSTOMER_PROFILE_DISCOUNT_REASON: &str = "Customer profile discount";
const EMPLOYEE_DISCOUNT_REASON: &str = "Employee Discount";
const CUSTOMER_PROFILE_DISCOUNT_RECEIPT_LABEL: &str = "Special Discount";

fn tax_category_audit_label(category: TaxCategory) -> &'static str {
    match category {
        TaxCategory::Clothing => "clothing",
        TaxCategory::Footwear => "footwear",
        TaxCategory::Accessory => "accessory",
        TaxCategory::Service => "service",
        TaxCategory::Other => "other",
    }
}

#[derive(Debug, Error)]
pub enum CheckoutError {
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Clone)]
pub enum CheckoutRecoverySource {
    ParkedSale {
        parked_sale_id: Uuid,
    },
    ExistingOrderPayment {
        target_transaction_id: Uuid,
        target_display_id: String,
    },
    OfflineCheckout {
        recovery_client_job_key: String,
    },
}

#[derive(Debug, Clone)]
pub struct CheckoutRecoveryContext {
    pub source: CheckoutRecoverySource,
    pub payment_provider_attempt_id: Option<Uuid>,
    pub authorized_by_staff_id: Uuid,
    pub approved_at: DateTime<Utc>,
    pub note: String,
    pub allow_closed_session: bool,
    pub require_checkout_binding: bool,
}

#[derive(Debug, Deserialize, Serialize)]
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
    pub tax_category_override: Option<TaxCategory>,
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
    #[serde(default)]
    pub order_lifecycle_status: Option<DbOrderItemLifecycleStatus>,
}

#[derive(Debug, Deserialize, Serialize)]
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
    pub capacity_bucket: Option<String>,
    #[serde(default)]
    pub capacity_units: Option<i32>,
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

#[derive(Debug, Deserialize, Serialize)]
pub struct WeddingDisbursement {
    pub wedding_member_id: Uuid,
    pub amount: Decimal,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BelowCostApproval {
    pub approved_by_staff_id: Uuid,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub line_signature: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BackdateApproval {
    pub approved_by_staff_id: Uuid,
    pub reason: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CheckoutOrderPayment {
    pub client_line_id: String,
    pub target_transaction_id: Uuid,
    pub target_display_id: String,
    pub customer_id: Uuid,
    pub amount: Decimal,
    pub balance_before: Decimal,
    pub projected_balance_after: Decimal,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CheckoutShippingLink {
    pub target_transaction_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize)]
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
    pub below_cost_approval: Option<BelowCostApproval>,
    #[serde(default)]
    pub checkout_client_id: Option<Uuid>,
    /// Store-local date/time selected in Register for this transaction only.
    /// Format: `YYYY-MM-DDTHH:MM` from an HTML datetime-local input.
    #[serde(default)]
    pub booked_at_local: Option<String>,
    /// Required when `booked_at_local` is supplied. The approval is verified
    /// server-side and recorded with the transaction for audit/QBO review.
    #[serde(default)]
    pub backdate_approval: Option<BackdateApproval>,
    /// Consumed at checkout (single use); amount included in `total_price` validation.
    #[serde(default)]
    pub shipping_rate_quote_id: Option<Uuid>,
    /// Existing customer Transaction Records whose delivery is covered by this
    /// Register-collected shipping charge.
    #[serde(default)]
    pub shipping_links: Vec<CheckoutShippingLink>,
    /// Customer delivery mode requested by the Register. Shipping is only authoritative
    /// when paired with a valid `shipping_rate_quote_id` so the address/charge snapshot
    /// comes from the POS shipping flow.
    #[serde(default)]
    pub fulfillment_mode: Option<DbOrderFulfillmentMethod>,
    /// Legacy/client hint. Checkout ignores this unless the shipping quote metadata
    /// carries the matching authoritative address snapshot.
    #[serde(default)]
    pub ship_to: Option<Value>,
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
    #[serde(default)]
    pub is_processing: bool,
    /// Exchange settlement intent persisted in the same transaction as the
    /// replacement checkout. The settlement API remains the financial source
    /// of truth; this snapshot provides a durable, Z-close-blocking recovery.
    #[serde(default)]
    pub exchange_settlement: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize)]
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

fn sha256_json<T: Serialize>(value: &T) -> Result<String, CheckoutError> {
    let encoded = serde_json::to_vec(value).map_err(|error| {
        CheckoutError::InvalidPayload(format!(
            "checkout request could not be fingerprinted: {error}"
        ))
    })?;
    Ok(hex::encode(Sha256::digest(encoded)))
}

pub(crate) fn checkout_request_fingerprints(
    payload: &CheckoutRequest,
) -> Result<(String, String), CheckoutError> {
    let mut request_value = serde_json::to_value(payload).map_err(|error| {
        CheckoutError::InvalidPayload(format!(
            "checkout request could not be fingerprinted: {error}"
        ))
    })?;
    strip_sensitive_payment_metadata(&mut request_value);
    let request_fingerprint = sha256_json(&request_value)?;
    let mut payment_value = json!({
        "session_id": payload.session_id,
        "checkout_client_id": payload.checkout_client_id,
        "payment_method": payload.payment_method,
        "total_price": payload.total_price,
        "amount_paid": payload.amount_paid,
        "payment_splits": payload.payment_splits,
        "rounding_adjustment": payload.rounding_adjustment,
        "final_cash_due": payload.final_cash_due,
    });
    strip_sensitive_payment_metadata(&mut payment_value);
    let payment_fingerprint = sha256_json(&payment_value)?;
    Ok((request_fingerprint, payment_fingerprint))
}

fn checkout_processing_intent_fingerprint(
    payload: &CheckoutRequest,
) -> Result<String, CheckoutError> {
    let mut intent = json!({
        "session_id": payload.session_id,
        "operator_staff_id": payload.operator_staff_id,
        "primary_salesperson_id": payload.primary_salesperson_id,
        "customer_id": payload.customer_id,
        "wedding_member_id": payload.wedding_member_id,
        "total_price": payload.total_price,
        "items": payload.items,
        "alteration_intakes": payload.alteration_intakes,
        "actor_name": payload.actor_name,
        "wedding_disbursements": payload.wedding_disbursements,
        "order_payments": payload.order_payments,
        "below_cost_approval": payload.below_cost_approval,
        "checkout_client_id": payload.checkout_client_id,
        "booked_at_local": payload.booked_at_local,
        "backdate_approval": payload.backdate_approval,
        "shipping_rate_quote_id": payload.shipping_rate_quote_id,
        "shipping_links": payload.shipping_links,
        "fulfillment_mode": payload.fulfillment_mode,
        "ship_to": payload.ship_to,
        "target_transaction_id": payload.target_transaction_id,
        "is_rush": payload.is_rush,
        "need_by_date": payload.need_by_date,
        "is_tax_exempt": payload.is_tax_exempt,
        "tax_exempt_reason": payload.tax_exempt_reason,
        "exchange_settlement": payload.exchange_settlement,
    });
    strip_sensitive_payment_metadata(&mut intent);
    sha256_json(&intent)
}

fn validate_processing_intent_fingerprint(
    payload: &CheckoutRequest,
    stored_session_id: Option<Uuid>,
    stored_processing_fingerprint: Option<&str>,
    processing_fingerprint: &str,
) -> Result<(), CheckoutError> {
    if stored_session_id != Some(payload.session_id) {
        return Err(CheckoutError::InvalidPayload(
            "checkout identity belongs to a different register session".to_string(),
        ));
    }
    if stored_processing_fingerprint != Some(processing_fingerprint) {
        return Err(CheckoutError::InvalidPayload(
            "processing checkout identity was already used with different sale details; recover the original checkout instead of changing it"
                .to_string(),
        ));
    }
    Ok(())
}

fn validate_checkout_replay_fingerprints(
    payload: &CheckoutRequest,
    stored_session_id: Option<Uuid>,
    stored_request_fingerprint: Option<&str>,
    stored_payment_fingerprint: Option<&str>,
    request_fingerprint: &str,
    payment_fingerprint: &str,
) -> Result<(), CheckoutError> {
    if stored_session_id != Some(payload.session_id) {
        return Err(CheckoutError::InvalidPayload(
            "checkout identity belongs to a different register session".to_string(),
        ));
    }
    if stored_request_fingerprint != Some(request_fingerprint)
        || stored_payment_fingerprint != Some(payment_fingerprint)
    {
        return Err(CheckoutError::InvalidPayload(
            "checkout identity was already used with different sale or payment details; recover the original checkout instead of recording another sale"
                .to_string(),
        ));
    }
    Ok(())
}

fn validate_exchange_checkout_intent(
    payload: &CheckoutRequest,
    payment_splits: &[ResolvedPaymentSplit],
) -> Result<Option<(Uuid, Decimal)>, CheckoutError> {
    let Some(intent) = payload.exchange_settlement.as_ref() else {
        if payment_splits
            .iter()
            .any(|split| split.method.trim().eq_ignore_ascii_case("exchange_credit"))
        {
            return Err(CheckoutError::InvalidPayload(
                "exchange credit tender requires a matching exchange settlement intent".to_string(),
            ));
        }
        return Ok(None);
    };
    payload.checkout_client_id.ok_or_else(|| {
        CheckoutError::InvalidPayload(
            "exchange replacement checkout requires a checkout identity".to_string(),
        )
    })?;
    let object = intent.as_object().ok_or_else(|| {
        CheckoutError::InvalidPayload("exchange settlement intent must be an object".to_string())
    })?;
    let original_transaction_id = object
        .get("original_transaction_id")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
        .ok_or_else(|| {
            CheckoutError::InvalidPayload(
                "exchange settlement intent requires original_transaction_id".to_string(),
            )
        })?;
    let exchange_credit_amount: Decimal = serde_json::from_value(
        object
            .get("exchange_credit_amount")
            .cloned()
            .ok_or_else(|| {
                CheckoutError::InvalidPayload(
                    "exchange settlement intent requires exchange_credit_amount".to_string(),
                )
            })?,
    )
    .map_err(|_| {
        CheckoutError::InvalidPayload("exchange settlement credit amount is invalid".to_string())
    })?;
    if exchange_credit_amount < Decimal::ZERO {
        return Err(CheckoutError::InvalidPayload(
            "exchange settlement credit amount cannot be negative".to_string(),
        ));
    }

    let original_transaction_id_text = original_transaction_id.to_string();
    let matching_credit: Decimal = payment_splits
        .iter()
        .filter(|split| split.method.trim().eq_ignore_ascii_case("exchange_credit"))
        .map(|split| {
            let linked_original =
                metadata_optional_text(&split.metadata, "original_transaction_id");
            if linked_original.as_deref() != Some(original_transaction_id_text.as_str()) {
                return Err(CheckoutError::InvalidPayload(
                    "exchange credit tender does not identify the staged return transaction"
                        .to_string(),
                ));
            }
            Ok(split.amount)
        })
        .collect::<Result<Vec<_>, CheckoutError>>()?
        .into_iter()
        .sum::<Decimal>()
        .round_dp(2);
    if matching_credit != exchange_credit_amount.round_dp(2) {
        return Err(CheckoutError::InvalidPayload(
            "exchange settlement intent does not match the replacement sale exchange-credit tender"
                .to_string(),
        ));
    }
    Ok(Some((
        original_transaction_id,
        exchange_credit_amount.round_dp(2),
    )))
}

#[derive(Debug, Serialize)]
pub struct CheckoutResponse {
    pub transaction_id: Uuid,
    pub transaction_display_id: String,
    pub status: String,
    pub loyalty_points_earned: i32,
    pub loyalty_points_balance: Option<i32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

fn parse_booked_at_local(raw: &str) -> Result<NaiveDateTime, CheckoutError> {
    let trimmed = raw.trim();
    for fmt in ["%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(trimmed, fmt) {
            return Ok(dt);
        }
    }
    Err(CheckoutError::InvalidPayload(
        "transaction date/time must be a valid store-local date and time".to_string(),
    ))
}

async fn resolve_checkout_booked_at(
    pool: &PgPool,
    raw: Option<&str>,
) -> Result<(Option<String>, Option<NaiveDate>), CheckoutError> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok((None, None));
    };
    let parsed = parse_booked_at_local(raw)?;
    let sql_value = parsed.format("%Y-%m-%d %H:%M:%S").to_string();
    let is_allowed: bool = sqlx::query_scalar(
        r#"
        SELECT ($1::timestamp AT TIME ZONE reporting.effective_store_timezone())
            <= CURRENT_TIMESTAMP + INTERVAL '5 minutes'
        "#,
    )
    .bind(&sql_value)
    .fetch_one(pool)
    .await?;
    if !is_allowed {
        return Err(CheckoutError::InvalidPayload(
            "transaction date/time cannot be in the future".to_string(),
        ));
    }
    Ok((Some(sql_value), Some(parsed.date())))
}

fn payment_effective_date(
    method: &str,
    provider: Option<&str>,
    business_date: Option<NaiveDate>,
) -> Option<NaiveDate> {
    let _ = (method, provider, business_date);
    // Every tender movement remains on the actual processing day. This keeps
    // card batches, physical cash/check reconciliation, Z-Reports, and QBO
    // payment-day evidence aligned. Only the transaction business date is
    // backdated. NULL lets the database use the current store-local date.
    None
}

async fn backdate_approval_was_logged(
    pool: &PgPool,
    approval: &BackdateApproval,
    booked_at_local: &str,
    session_id: Uuid,
) -> Result<bool, CheckoutError> {
    Ok(sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM staff_access_log
            WHERE staff_id = $1
              AND event_kind = 'pos_backdate_sale'
              AND created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
              AND metadata->>'booked_at_local' = $2
              AND metadata->>'register_session_id' = $3::text
        )
        "#,
    )
    .bind(approval.approved_by_staff_id)
    .bind(booked_at_local)
    .bind(session_id)
    .fetch_one(pool)
    .await?)
}

#[derive(Debug)]
pub struct ResolvedPaymentSplit {
    pub method: String,
    pub amount: Decimal,
    pub gift_card_code: Option<String>,
    pub metadata: serde_json::Value,
    pub payment_provider: Option<String>,
    pub provider_payment_id: Option<String>,
    pub provider_status: Option<String>,
    pub provider_terminal_id: Option<String>,
    pub provider_transaction_id: Option<String>,
    pub provider_auth_code: Option<String>,
    pub provider_card_type: Option<String>,
    pub check_number: Option<String>,
    pub merchant_fee: Decimal,
    pub net_amount: Decimal,
    pub card_brand: Option<String>,
    pub card_last4: Option<String>,
}

fn strip_sensitive_payment_metadata(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.retain(|key, _| !crate::auth::pins::is_sensitive_pin_metadata_key(key));
            for nested in object.values_mut() {
                strip_sensitive_payment_metadata(nested);
            }
        }
        Value::Array(values) => {
            for nested in values {
                strip_sensitive_payment_metadata(nested);
            }
        }
        Value::String(encoded) => {
            let Ok(mut decoded) = serde_json::from_str::<Value>(encoded) else {
                return;
            };
            if !matches!(decoded, Value::Object(_) | Value::Array(_)) {
                return;
            }
            let original = decoded.clone();
            strip_sensitive_payment_metadata(&mut decoded);
            if decoded != original {
                if let Ok(sanitized) = serde_json::to_string(&decoded) {
                    *encoded = sanitized;
                }
            }
        }
        _ => {}
    }
}

fn strip_sensitive_checkout_request(payload: &mut CheckoutRequest) {
    if let Some(splits) = payload.payment_splits.as_mut() {
        for split in splits {
            if let Some(metadata) = split.metadata.as_mut() {
                strip_sensitive_payment_metadata(metadata);
            }
        }
    }
    if let Some(exchange_settlement) = payload.exchange_settlement.as_mut() {
        strip_sensitive_payment_metadata(exchange_settlement);
    }
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

fn metadata_nonnegative_cents(metadata: &Value, key: &str) -> Result<Option<i64>, CheckoutError> {
    let Some(raw) = metadata.get(key) else {
        return Ok(None);
    };
    let cents = raw
        .as_i64()
        .or_else(|| raw.as_str().and_then(|value| value.parse::<i64>().ok()))
        .filter(|value| *value >= 0)
        .ok_or_else(|| {
            CheckoutError::InvalidPayload(format!("{key} must be a non-negative whole-cent amount"))
        })?;
    Ok(Some(cents))
}

fn metadata_optional_text(metadata: &Value, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn is_fee_only_shipping_quote(metadata: &Value) -> bool {
    metadata
        .get("fee_only")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn helcim_attempt_comparison_cents(split_amount_cents: i64, is_refund_attempt: bool) -> i64 {
    if is_refund_attempt {
        split_amount_cents.abs()
    } else {
        split_amount_cents
    }
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

fn rms_source_mode(metadata: &Value) -> String {
    metadata_optional_text(metadata, "rms_charge_source")
        .or_else(|| metadata_optional_text(metadata, "source_mode"))
        .unwrap_or_else(|| "manual".to_string())
}

fn apply_manual_rms_tracking_metadata(metadata: &mut Value) {
    let mut object = metadata.as_object().cloned().unwrap_or_default();
    object.insert(
        "source_mode".to_string(),
        Value::String("manual".to_string()),
    );
    object.insert(
        "rms_charge_source".to_string(),
        Value::String("manual".to_string()),
    );
    object
        .entry("posting_status".to_string())
        .or_insert_with(|| Value::String("recorded_manually".to_string()));
    object.insert(
        "manual_tracking_status".to_string(),
        Value::String("reference_tracked".to_string()),
    );
    object.insert("not_host_posted".to_string(), Value::Bool(true));

    if let Some(reference) = object
        .get("reference_number")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
    {
        object
            .entry("host_reference".to_string())
            .or_insert_with(|| Value::String(reference));
    }

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

fn validate_open_deposit_scope(
    splits: &[ResolvedPaymentSplit],
    current_sale_total: Decimal,
    takeaway_total: Decimal,
    wedding_disbursement_total: Decimal,
    order_payment_total: Decimal,
) -> Result<(), CheckoutError> {
    let open_deposit_total = splits
        .iter()
        .filter(|split| split.method.trim().eq_ignore_ascii_case("open_deposit"))
        .map(|split| split.amount)
        .sum::<Decimal>()
        .round_dp(2);
    if open_deposit_total <= Decimal::ZERO {
        return Ok(());
    }

    if wedding_disbursement_total > Decimal::ZERO || order_payment_total > Decimal::ZERO {
        return Err(CheckoutError::InvalidPayload(
            "open deposit may only be applied to the selected customer's current sale; clear party disbursements and existing-order payments"
                .to_string(),
        ));
    }

    let eligible_deferred_total = (current_sale_total - takeaway_total)
        .max(Decimal::ZERO)
        .round_dp(2);
    if open_deposit_total > eligible_deferred_total {
        return Err(CheckoutError::InvalidPayload(
            "open deposit amount exceeds the deferred order portion of this sale".to_string(),
        ));
    }

    Ok(())
}

fn can_carry_applied_deposit_metadata(method: &str) -> bool {
    let method = method.trim().to_ascii_lowercase();
    method != "deposit_ledger" && method != "open_deposit"
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
    transaction_display_id: String,
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
        let amount = payment.amount.round_dp(2);
        if amount < Decimal::ZERO {
            return Err(CheckoutError::InvalidPayload(
                "order payment amount cannot be negative".to_string(),
            ));
        }
        if amount == Decimal::ZERO {
            tracing::info!(
                client_line_id = client_line_id,
                target_transaction_id = %payment.target_transaction_id,
                "ignored zero-dollar order payment row"
            );
            continue;
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

async fn validate_wedding_member_checkout_customer(
    pool: &PgPool,
    checkout_customer_id: Option<Uuid>,
    original_checkout_customer_id: Option<Uuid>,
    wedding_member_id: Option<Uuid>,
) -> Result<(), CheckoutError> {
    let Some(member_id) = wedding_member_id else {
        return Ok(());
    };
    let customer_id = checkout_customer_id.ok_or_else(|| {
        CheckoutError::InvalidPayload(
            "customer_id is required when checkout includes wedding_member_id".to_string(),
        )
    })?;
    let member_customer_id: Option<Uuid> =
        sqlx::query_scalar("SELECT customer_id FROM wedding_members WHERE id = $1")
            .bind(member_id)
            .fetch_optional(pool)
            .await?;
    let member_customer_id = member_customer_id.ok_or_else(|| {
        CheckoutError::InvalidPayload("wedding_member_id was not found".to_string())
    })?;
    if member_customer_id != customer_id
        && Some(member_customer_id) != original_checkout_customer_id
    {
        return Err(CheckoutError::InvalidPayload(
            "wedding_member_id must belong to checkout customer_id".to_string(),
        ));
    }
    Ok(())
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
    let display_id = target.display_id.trim();
    let transaction_display_id = target.transaction_display_id.trim();
    if !display_id.is_empty()
        && display_id != payment.target_display_id
        && transaction_display_id != payment.target_display_id
    {
        return Err(CheckoutError::InvalidPayload(
            "order payment target_display_id does not match target transaction".to_string(),
        ));
    }

    Ok(())
}

fn validate_wedding_disbursement_against_balance(
    amount: Decimal,
    live_balance_due: Decimal,
) -> Result<(), CheckoutError> {
    let amount = amount.round_dp(2);
    let live_balance_due = live_balance_due.round_dp(2);
    if amount > live_balance_due + Decimal::new(2, 2) {
        return Err(CheckoutError::InvalidPayload(format!(
            "party disbursement amount ${amount:.2} exceeds the member's current balance due of ${live_balance_due:.2}"
        )));
    }
    Ok(())
}

fn build_payment_allocation_plan(
    payment_splits: &[ResolvedPaymentSplit],
    current_transaction_id: Uuid,
    current_transaction_allocation: Decimal,
    current_transaction_deposit_allocation: Decimal,
    order_payments: &[ResolvedOrderPayment],
    allowed_unallocated_tender: Decimal,
) -> Result<Vec<PaymentAllocationPlan>, CheckoutError> {
    if current_transaction_allocation.round_dp(2) < Decimal::ZERO {
        if !order_payments.is_empty() {
            return Err(CheckoutError::InvalidPayload(
                "refund allocation cannot target existing order payments".to_string(),
            ));
        }
        if !allowed_unallocated_tender.round_dp(2).is_zero() {
            return Err(CheckoutError::InvalidPayload(
                "refund allocation cannot include party disbursements".to_string(),
            ));
        }
        let mut plan = Vec::new();
        for (split_index, split) in payment_splits.iter().enumerate() {
            let amount = split.amount.round_dp(2);
            if amount.is_zero() {
                continue;
            }
            if amount > Decimal::ZERO {
                return Err(CheckoutError::InvalidPayload(
                    "refund allocation cannot include positive tender".to_string(),
                ));
            }
            plan.push(PaymentAllocationPlan {
                payment_split_index: split_index,
                target_transaction_id: current_transaction_id,
                amount,
                metadata: split.metadata.clone(),
                check_number: split.check_number.clone(),
                is_existing_order_payment: false,
            });
        }
        let allocated_total: Decimal = plan.iter().map(|allocation| allocation.amount).sum();
        if allocated_total.round_dp(2) != current_transaction_allocation.round_dp(2) {
            return Err(CheckoutError::InvalidPayload(
                "payment allocation plan does not cover requested order payments".to_string(),
            ));
        }
        return Ok(plan);
    }

    let mut current_remaining = current_transaction_allocation.round_dp(2);
    let mut current_deposit_remaining = current_transaction_deposit_allocation
        .round_dp(2)
        .max(Decimal::ZERO)
        .min(current_remaining.max(Decimal::ZERO));
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
    let mut unallocated_tender = Decimal::ZERO;

    for (split_index, split) in payment_splits.iter().enumerate() {
        let mut split_remaining = split.amount.round_dp(2);
        if split_remaining <= Decimal::ZERO {
            continue;
        }

        if current_remaining > Decimal::ZERO {
            let amount = split_remaining.min(current_remaining).round_dp(2);
            if amount > Decimal::ZERO {
                let mut metadata = split.metadata.clone();
                if current_deposit_remaining > Decimal::ZERO
                    && can_carry_applied_deposit_metadata(&split.method)
                {
                    let deposit_amount = amount.min(current_deposit_remaining).round_dp(2);
                    if deposit_amount > Decimal::ZERO {
                        metadata = merge_metadata(
                            metadata,
                            json!({ "applied_deposit_amount": deposit_amount.to_string() }),
                        );
                        current_deposit_remaining =
                            (current_deposit_remaining - deposit_amount).round_dp(2);
                    }
                }
                plan.push(PaymentAllocationPlan {
                    payment_split_index: split_index,
                    target_transaction_id: current_transaction_id,
                    amount,
                    metadata,
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

        unallocated_tender += split_remaining;
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
    if unallocated_tender.round_dp(2) != allowed_unallocated_tender.round_dp(2) {
        let message = if allowed_unallocated_tender.round_dp(2).is_zero() {
            "payment allocation plan has unallocated tender"
        } else {
            "payment allocation plan does not match party disbursements"
        };
        return Err(CheckoutError::InvalidPayload(message.to_string()));
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

fn creates_fulfillment_order(fulfillment: DbFulfillmentType) -> bool {
    matches!(
        fulfillment,
        DbFulfillmentType::SpecialOrder
            | DbFulfillmentType::Custom
            | DbFulfillmentType::WeddingOrder
    )
}

fn validate_checkout_item_quantity(item: &CheckoutItem) -> Result<(), CheckoutError> {
    if item.quantity == 0 {
        return Err(CheckoutError::InvalidPayload(format!(
            "Invalid quantity for variant {}",
            item.variant_id
        )));
    }

    if item.quantity < 0 {
        if item.fulfillment != DbFulfillmentType::Takeaway {
            return Err(CheckoutError::InvalidPayload(
                "Negative quantity is only allowed for take-away retail lines".to_string(),
            ));
        }
        if is_alteration_service_item(item) {
            return Err(CheckoutError::InvalidPayload(
                "Alteration service lines cannot use negative quantity".to_string(),
            ));
        }
    }

    Ok(())
}

fn initial_order_lifecycle_status(
    fulfillment: DbFulfillmentType,
    line_fulfilled: bool,
    requested: Option<DbOrderItemLifecycleStatus>,
) -> Result<DbOrderItemLifecycleStatus, CheckoutError> {
    let default = order_lifecycle::initial_status_for_line(fulfillment, line_fulfilled);
    if line_fulfilled || fulfillment == DbFulfillmentType::Takeaway {
        return Ok(default);
    }
    match requested {
        Some(DbOrderItemLifecycleStatus::NeedsMeasurements) => {
            Ok(DbOrderItemLifecycleStatus::NeedsMeasurements)
        }
        Some(DbOrderItemLifecycleStatus::Ntbo) | None => Ok(default),
        Some(other) => Err(CheckoutError::InvalidPayload(format!(
            "checkout cannot initialize order line lifecycle as {}",
            other.as_str()
        ))),
    }
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
        if let Some(bucket) = intake.capacity_bucket.as_deref() {
            if !matches!(bucket.trim(), "jacket" | "pant" | "other") {
                return Err(CheckoutError::InvalidPayload(
                    "alteration intake capacity_bucket is invalid".to_string(),
                ));
            }
        }
        if intake.capacity_units.is_some_and(|units| units <= 0) {
            return Err(CheckoutError::InvalidPayload(
                "alteration intake capacity_units must be positive".to_string(),
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
        warnings: Vec<String>,
    },
}

type DeferredWeddingActivity = operational_outbox::CheckoutWeddingActivity;

async fn staff_id_active(pool: &PgPool, id: Uuid) -> Result<bool, CheckoutError> {
    let ok: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE id = $1 AND is_active = TRUE)")
            .bind(id)
            .fetch_one(pool)
            .await?;
    Ok(ok)
}

async fn staff_id_active_salesperson(pool: &PgPool, id: Uuid) -> Result<bool, CheckoutError> {
    let ok: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM staff
            WHERE id = $1
              AND is_active = TRUE
              AND (role = 'salesperson' OR base_commission_rate > 0)
        )
        "#,
    )
    .bind(id)
    .fetch_one(pool)
    .await?;
    Ok(ok)
}

fn is_manual_below_cost_reason(reason: &str) -> bool {
    let normalized = reason.trim();
    if normalized.is_empty() {
        return false;
    }
    ![
        CUSTOMER_PROFILE_DISCOUNT_REASON,
        EMPLOYEE_DISCOUNT_REASON,
        "custom_order_booking",
        "pending_return_refund",
        "alteration_service",
        "Wedding Promo (Free Suit Selection)",
    ]
    .iter()
    .any(|known| normalized.eq_ignore_ascii_case(known))
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
                tax_category_override: None,
                salesperson_id: item.salesperson_id,
                discount_event_id: None,
                gift_card_load_code: None,
                custom_item_type: item.custom_item_type.clone(),
                custom_order_details: item.custom_order_details.clone(),
                is_rush: item.is_rush,
                need_by_date: item.need_by_date,
                needs_gift_wrap: item.needs_gift_wrap,
                order_lifecycle_status: item.order_lifecycle_status,
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
    let refund_checkout =
        payload.total_price.round_dp(2) < Decimal::ZERO && amount_paid < Decimal::ZERO;

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
                    if let Some(st) = line
                        .sub_type
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        if st != "paid_liability"
                            && st != "loyalty_giveaway"
                            && st != "donated_giveaway"
                            && st != "promo_gift_card"
                        {
                            return Err(CheckoutError::InvalidPayload(
                                "gift_card sub_type must be `paid_liability`, `loyalty_giveaway`, `donated_giveaway`, or `promo_gift_card`".to_string(),
                            ));
                        }
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
                if a.is_zero() {
                    return Err(CheckoutError::InvalidPayload(
                        "split amounts must be positive".to_string(),
                    ));
                }
                if a < Decimal::ZERO {
                    let refund_tender_allowed = m.eq_ignore_ascii_case("cash")
                        || m.eq_ignore_ascii_case("card_credit")
                        || m.eq_ignore_ascii_case("store_credit");
                    if !refund_checkout || !refund_tender_allowed {
                        return Err(CheckoutError::InvalidPayload(
                            "negative split amounts are only allowed for customer refunds"
                                .to_string(),
                        ));
                    }
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
                if !refund_checkout && applied_deposit_amount > a {
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
                let cash_tendered_cents =
                    metadata_nonnegative_cents(&normalized_meta, "cash_tendered_cents")?;
                let change_due_cents =
                    metadata_nonnegative_cents(&normalized_meta, "change_due_cents")?;
                if cash_tendered_cents.is_some() || change_due_cents.is_some() {
                    if !m.eq_ignore_ascii_case("cash") {
                        return Err(CheckoutError::InvalidPayload(
                            "cash tendered and change metadata is only allowed for cash payments"
                                .to_string(),
                        ));
                    }
                    let (Some(tendered_cents), Some(change_cents)) =
                        (cash_tendered_cents, change_due_cents)
                    else {
                        return Err(CheckoutError::InvalidPayload(
                            "cash tendered and change must be recorded together".to_string(),
                        ));
                    };
                    if change_cents > tendered_cents
                        || Decimal::new(tendered_cents - change_cents, 2) != a
                    {
                        return Err(CheckoutError::InvalidPayload(
                            "cash tendered minus change must equal the applied cash payment"
                                .to_string(),
                        ));
                    }
                }
                if m.eq_ignore_ascii_case("donation") {
                    let donation_note = metadata_optional_text(&normalized_meta, "donation_note")
                        .or_else(|| metadata_optional_text(&normalized_meta, "note"))
                        .ok_or_else(|| {
                            CheckoutError::InvalidPayload(
                                "donation payment requires a donation note".to_string(),
                            )
                        })?;
                    if donation_note.chars().count() > 500 {
                        return Err(CheckoutError::InvalidPayload(
                            "donation note must be 500 characters or less".to_string(),
                        ));
                    }
                    let mut object = normalized_meta.as_object().cloned().unwrap_or_default();
                    object.insert(
                        "tender_family".to_string(),
                        Value::String("donation".to_string()),
                    );
                    object.insert("donation_note".to_string(), Value::String(donation_note));
                    normalized_meta = Value::Object(object);
                }
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
                if m.eq_ignore_ascii_case("staff_account_charge") {
                    let mut object = normalized_meta.as_object().cloned().unwrap_or_default();
                    object.insert(
                        "tender_family".to_string(),
                        Value::String("staff_account".to_string()),
                    );
                    normalized_meta = Value::Object(object);
                }
                let payment_provider = normalized_meta
                    .get("payment_provider")
                    .or_else(|| normalized_meta.get("provider"))
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_ascii_lowercase);
                let provider_payment_id = normalized_meta
                    .get("provider_payment_id")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let provider_status = metadata_optional_text(&normalized_meta, "provider_status");
                if payment_provider.as_deref() == Some("helcim") {
                    let status = provider_status
                        .as_deref()
                        .unwrap_or("")
                        .trim()
                        .to_ascii_lowercase();
                    if !matches!(status.as_str(), "approved" | "approval" | "captured") {
                        return Err(CheckoutError::InvalidPayload(
                            "Helcim card payment must be approved before checkout can be completed"
                                .to_string(),
                        ));
                    }
                }
                let provider_terminal_id =
                    metadata_optional_text(&normalized_meta, "provider_terminal_id");
                let provider_transaction_id =
                    metadata_optional_text(&normalized_meta, "provider_transaction_id");
                let provider_auth_code =
                    metadata_optional_text(&normalized_meta, "provider_auth_code");
                let provider_card_type =
                    metadata_optional_text(&normalized_meta, "provider_card_type");
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

                let fee = Decimal::ZERO;
                let net_amount = if payment_provider.as_deref() == Some("helcim") {
                    Decimal::ZERO
                } else {
                    a - fee
                };

                out.push(ResolvedPaymentSplit {
                    method: m.to_string(),
                    amount: a,
                    gift_card_code: gift_card_code.clone(),
                    metadata: normalized_meta,
                    payment_provider,
                    provider_payment_id,
                    provider_status,
                    provider_terminal_id,
                    provider_transaction_id,
                    provider_auth_code,
                    provider_card_type,
                    check_number,
                    merchant_fee: fee,
                    net_amount,
                    card_brand,
                    card_last4,
                });
            }
            if sum.round_dp(2) != amount_paid {
                return Err(CheckoutError::InvalidPayload(
                    "payment_splits must sum to amount_paid".to_string(),
                ));
            }
            if refund_checkout && deposit_sum > Decimal::ZERO {
                return Err(CheckoutError::InvalidPayload(
                    "refund splits cannot apply deposit amounts".to_string(),
                ));
            }
            if !refund_checkout && deposit_sum > amount_paid {
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
    if m.eq_ignore_ascii_case("donation") {
        return Err(CheckoutError::InvalidPayload(
            "donation payment requires a donation note and explicit payment_splits".to_string(),
        ));
    }
    if m.eq_ignore_ascii_case("check") {
        return Err(CheckoutError::InvalidPayload(
            "check payment requires check_number".to_string(),
        ));
    }
    if amount_paid < Decimal::ZERO {
        return Err(CheckoutError::InvalidPayload(
            "customer refunds require explicit payment_splits".to_string(),
        ));
    }
    Ok((
        vec![ResolvedPaymentSplit {
            method: m.to_string(),
            amount: amount_paid,
            gift_card_code: None,
            metadata: json!({}),
            payment_provider: None,
            provider_payment_id: None,
            provider_status: None,
            provider_terminal_id: None,
            provider_transaction_id: None,
            provider_auth_code: None,
            provider_card_type: None,
            check_number: None,
            merchant_fee: Decimal::ZERO,
            net_amount: amount_paid,
            card_brand: None,
            card_last4: None,
        }],
        m.to_string(),
    ))
}

fn helcim_tender_method_matches_amount(method: &str, amount: Decimal) -> bool {
    let method = method.trim().to_ascii_lowercase();
    if amount < Decimal::ZERO {
        method == "card_credit"
    } else {
        matches!(
            method.as_str(),
            "card_terminal" | "card_manual" | "card_saved"
        )
    }
}

fn canonical_helcim_ledger_transaction_id(
    is_return: bool,
    provider_transaction_id: Option<&str>,
    provider_payment_id: Option<&str>,
) -> Result<Option<String>, CheckoutError> {
    if is_return {
        return provider_payment_id
            .map(str::to_string)
            .map(Some)
            .ok_or_else(|| {
                CheckoutError::InvalidPayload(
                    "Helcim card refund is missing its approved refund/reverse reference"
                        .to_string(),
                )
            });
    }
    Ok(provider_transaction_id.map(str::to_string))
}

async fn validate_helcim_payment_splits(
    pool: &PgPool,
    checkout_register_session_id: Uuid,
    checkout_client_id: Option<Uuid>,
    require_checkout_binding: bool,
    payment_splits: &mut [ResolvedPaymentSplit],
) -> Result<(), CheckoutError> {
    for split in payment_splits {
        if split.payment_provider.as_deref() != Some("helcim") {
            continue;
        }

        if !helcim_tender_method_matches_amount(&split.method, split.amount) {
            return Err(CheckoutError::InvalidPayload(
                "Helcim provider references may only be attached to the matching approved card tender"
                    .to_string(),
            ));
        }
        let is_return_tender = split.amount < Decimal::ZERO;

        let provider_transaction_id = split
            .provider_transaction_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let provider_payment_id = split
            .provider_payment_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let provider_attempt_reference =
            metadata_optional_text(&split.metadata, "payment_provider_attempt_id");
        let provider_attempt_id = provider_attempt_reference
            .as_deref()
            .map(Uuid::parse_str)
            .transpose()
            .map_err(|_| {
                CheckoutError::InvalidPayload(
                    "Helcim card payment has an invalid provider attempt reference".to_string(),
                )
            })?;

        if provider_transaction_id.is_none()
            && provider_payment_id.is_none()
            && provider_attempt_id.is_none()
        {
            return Err(CheckoutError::InvalidPayload(
                "Helcim card payment is missing its approved transaction reference".to_string(),
            ));
        }

        let split_amount_cents = (split.amount.round_dp(2) * Decimal::from(100))
            .to_i64()
            .ok_or_else(|| {
                CheckoutError::InvalidPayload("Helcim card payment amount is not valid".to_string())
            })?;

        let attempts: Vec<(
            Uuid,
            String,
            i64,
            Option<Uuid>,
            Option<Uuid>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        )> = sqlx::query_as(
            r#"
            SELECT id, status, amount_cents, register_session_id, checkout_client_id,
                   raw_audit_reference, error_code, provider_transaction_id,
                   provider_payment_id, terminal_id
            FROM payment_provider_attempts
            WHERE provider = 'helcim'
              AND (
                ($1::uuid IS NOT NULL AND id = $1)
                OR ($2::text IS NOT NULL AND provider_transaction_id = $2)
                OR ($3::text IS NOT NULL AND provider_payment_id = $3)
              )
            ORDER BY created_at DESC
            "#,
        )
        .bind(provider_attempt_id)
        .bind(provider_transaction_id)
        .bind(provider_payment_id)
        .fetch_all(pool)
        .await?;
        if attempts.len() != 1 {
            return Err(CheckoutError::InvalidPayload(
                "Helcim card references do not identify one approved provider attempt".to_string(),
            ));
        }
        let (
            canonical_attempt_id,
            attempt_status,
            attempt_amount_cents,
            attempt_register_session_id,
            attempt_checkout_client_id,
            raw_audit_reference,
            attempt_error_code,
            canonical_transaction_id,
            canonical_payment_id,
            canonical_terminal_id,
        ) = attempts.into_iter().next().expect("one Helcim attempt");
        let supplied_transaction_matches = provider_transaction_id.is_none_or(|value| {
            canonical_transaction_id.as_deref() == Some(value)
                || (is_return_tender && canonical_payment_id.as_deref() == Some(value))
        });
        if provider_attempt_id.is_some_and(|value| value != canonical_attempt_id)
            || !supplied_transaction_matches
            || provider_payment_id
                .is_some_and(|value| canonical_payment_id.as_deref() != Some(value))
        {
            return Err(CheckoutError::InvalidPayload(
                "Helcim card references do not all belong to the same approved provider attempt"
                    .to_string(),
            ));
        }
        if attempt_register_session_id != Some(checkout_register_session_id) {
            return Err(CheckoutError::InvalidPayload(
                "Helcim card payment does not belong to this register session".to_string(),
            ));
        }
        validate_helcim_attempt_checkout_binding(
            require_checkout_binding,
            checkout_client_id,
            attempt_checkout_client_id,
        )?;

        if !matches!(attempt_status.as_str(), "approved" | "captured") {
            return Err(CheckoutError::InvalidPayload(
                "Helcim card payment must be approved before checkout can be completed".to_string(),
            ));
        }
        if matches!(
            attempt_error_code.as_deref(),
            Some("amount_mismatch" | "provider_identity_mismatch" | "provider_result_mismatch")
        ) {
            return Err(CheckoutError::InvalidPayload(
                "Helcim card payment identity does not match the provider response; reconcile it in Payments Health"
                    .to_string(),
            ));
        }
        let is_refund_attempt = raw_audit_reference
            .as_deref()
            .map(|value| {
                let normalized = value.to_ascii_lowercase();
                normalized.contains("refund") || normalized.contains("reverse")
            })
            .unwrap_or(false);
        if is_return_tender != is_refund_attempt {
            return Err(CheckoutError::InvalidPayload(
                "Helcim purchase and refund attempts cannot be substituted for one another"
                    .to_string(),
            ));
        }
        let comparable_split_cents =
            helcim_attempt_comparison_cents(split_amount_cents, is_refund_attempt);
        if attempt_amount_cents != comparable_split_cents {
            return Err(CheckoutError::InvalidPayload(
                "Helcim card payment amount does not match the approved terminal amount"
                    .to_string(),
            ));
        }

        // Persist only the canonical provider identity resolved from ROS's
        // durable attempt. Return attempts retain the original charge in the
        // attempt's provider_transaction_id; the new refund/reverse movement
        // is provider_payment_id and is the only transaction identity valid
        // for the negative tender row.
        let ledger_transaction_id = canonical_helcim_ledger_transaction_id(
            is_refund_attempt,
            canonical_transaction_id.as_deref(),
            canonical_payment_id.as_deref(),
        )?;
        split.provider_transaction_id = ledger_transaction_id.clone();
        split.provider_payment_id = canonical_payment_id.clone();
        split.provider_terminal_id = canonical_terminal_id.clone();
        split.provider_status = Some(attempt_status.clone());
        let mut canonical_metadata = split.metadata.as_object().cloned().unwrap_or_default();
        canonical_metadata.insert(
            "payment_provider".to_string(),
            Value::String("helcim".to_string()),
        );
        canonical_metadata.insert(
            "payment_provider_attempt_id".to_string(),
            Value::String(canonical_attempt_id.to_string()),
        );
        canonical_metadata.insert(
            "provider_status".to_string(),
            Value::String(attempt_status.clone()),
        );
        for (key, value) in [
            ("provider_transaction_id", ledger_transaction_id.as_ref()),
            ("provider_payment_id", canonical_payment_id.as_ref()),
            ("provider_terminal_id", canonical_terminal_id.as_ref()),
        ] {
            if let Some(value) = value {
                canonical_metadata.insert(key.to_string(), Value::String(value.clone()));
            } else {
                canonical_metadata.remove(key);
            }
        }
        if is_refund_attempt {
            if let Some(original_transaction_id) = canonical_transaction_id.as_ref() {
                canonical_metadata.insert(
                    "original_provider_transaction_id".to_string(),
                    Value::String(original_transaction_id.clone()),
                );
            }
        }
        split.metadata = Value::Object(canonical_metadata);

        let provider_attempt_id_text = canonical_attempt_id.to_string();

        let already_recorded: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM payment_transactions
                WHERE COALESCE(payment_provider, '') = 'helcim'
                  AND (
                    ($1::text IS NOT NULL AND provider_transaction_id = $1)
                    OR ($2::text IS NOT NULL AND provider_payment_id = $2)
                    OR ($3::text IS NOT NULL AND metadata->>'payment_provider_attempt_id' = $3)
                  )
            )
            "#,
        )
        .bind(ledger_transaction_id.as_deref())
        .bind(canonical_payment_id.as_deref())
        .bind(&provider_attempt_id_text)
        .fetch_one(pool)
        .await?;
        if already_recorded {
            return Err(CheckoutError::InvalidPayload(
                "Helcim card payment has already been used on another transaction".to_string(),
            ));
        }
    }

    Ok(())
}

fn helcim_checkout_references(payment_splits: &[ResolvedPaymentSplit]) -> Vec<String> {
    payment_splits
        .iter()
        .filter(|split| split.payment_provider.as_deref() == Some("helcim"))
        .flat_map(|split| {
            [
                split.provider_transaction_id.clone(),
                split.provider_payment_id.clone(),
                metadata_optional_text(&split.metadata, "payment_provider_attempt_id"),
            ]
            .into_iter()
            .flatten()
            .filter(|value| !value.trim().is_empty())
        })
        .collect()
}

async fn reject_unattached_helcim_attempt<'e, E>(
    executor: E,
    checkout_client_id: Option<Uuid>,
    payment_splits: &[ResolvedPaymentSplit],
) -> Result<(), CheckoutError>
where
    E: Executor<'e, Database = Postgres>,
{
    let checkout_references = helcim_checkout_references(payment_splits);
    let unresolved: Option<(String, i64, Option<String>)> = sqlx::query_as(
        r#"
        SELECT ppa.status, ppa.amount_cents, ppa.provider_transaction_id
        FROM payment_provider_attempts ppa
        WHERE ppa.provider = 'helcim'
          AND ($2::uuid IS NOT NULL AND ppa.checkout_client_id = $2)
          AND (
              ppa.status IN ('pending', 'expired')
              OR (ppa.status = 'failed' AND ppa.error_code = 'outcome_unknown')
              OR (
                  ppa.status IN ('approved', 'captured')
                  AND NOT (
                      ppa.id::text = ANY($1::text[])
                      OR COALESCE(ppa.provider_transaction_id, '') = ANY($1::text[])
                      OR COALESCE(ppa.provider_payment_id, '') = ANY($1::text[])
                  )
              )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM payment_transactions pt
              WHERE COALESCE(pt.payment_provider, '') = 'helcim'
                AND pt.status IN ('success', 'approved', 'captured')
                AND pt.session_id = ppa.register_session_id
                AND ABS(pt.amount) = ppa.amount_cents::numeric / 100
                AND (
                    (ppa.provider_payment_id IS NOT NULL
                        AND pt.provider_payment_id = ppa.provider_payment_id)
                    OR pt.metadata->>'payment_provider_attempt_id' = ppa.id::text
                    OR pt.metadata->>'provider_attempt_id' = ppa.id::text
                    OR (
                        LOWER(COALESCE(ppa.raw_audit_reference, '')) NOT LIKE '%refund%'
                        AND LOWER(COALESCE(ppa.raw_audit_reference, '')) NOT LIKE '%reverse%'
                        AND ppa.provider_transaction_id IS NOT NULL
                        AND pt.provider_transaction_id = ppa.provider_transaction_id
                    )
                )
                AND (
                    SELECT ABS(COALESCE(SUM(pa.amount_allocated), 0))
                    FROM payment_allocations pa
                    INNER JOIN transactions target
                        ON target.id = pa.target_transaction_id
                    WHERE pa.transaction_id = pt.id
                ) = ABS(pt.amount)
                AND (
                    ppa.checkout_client_id IS NULL
                    OR NOT EXISTS (
                        SELECT 1
                        FROM payment_allocations pa
                        INNER JOIN transactions target
                            ON target.id = pa.target_transaction_id
                        WHERE pa.transaction_id = pt.id
                          AND target.checkout_client_id IS DISTINCT FROM ppa.checkout_client_id
                    )
                )
          )
        ORDER BY ppa.created_at DESC
        LIMIT 1
        "#,
    )
    .bind(&checkout_references)
    .bind(checkout_client_id)
    .fetch_optional(executor)
    .await?;

    if let Some((status, amount_cents, provider_transaction_id)) = unresolved {
        let reference = provider_transaction_id
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!(" (provider transaction {value})"))
            .unwrap_or_default();
        let amount = Decimal::new(amount_cents, 2);
        if matches!(status.as_str(), "approved" | "captured") {
            return Err(CheckoutError::InvalidPayload(format!(
                "An approved Helcim payment of ${amount:.2}{reference} is still waiting to be attached to this sale. Attach it before recording the sale, or use Payments Health to recover or refund it."
            )));
        }
        return Err(CheckoutError::InvalidPayload(format!(
            "A Helcim payment of ${amount:.2} still has an unresolved provider outcome. Recover its final status before retrying the card, using another tender, clearing the sale, or completing checkout."
        )));
    }

    Ok(())
}

fn validate_helcim_attempt_checkout_binding(
    require_checkout_binding: bool,
    checkout_client_id: Option<Uuid>,
    attempt_checkout_client_id: Option<Uuid>,
) -> Result<(), CheckoutError> {
    if !require_checkout_binding {
        return Ok(());
    }
    let checkout_client_id = checkout_client_id.ok_or_else(|| {
        CheckoutError::InvalidPayload(
            "Helcim card payments require a checkout identity. Start a new card request from this sale."
                .to_string(),
        )
    })?;
    if attempt_checkout_client_id != Some(checkout_client_id) {
        return Err(CheckoutError::InvalidPayload(
            "Helcim card payment belongs to a different sale. Do not reuse it; recover or refund it from Payments Health."
                .to_string(),
        ));
    }
    Ok(())
}

#[derive(Debug)]
struct ExactOrderPaymentHelcimReplay {
    checkout_client_id: Uuid,
    session_id: Uuid,
    operator_staff_id: Uuid,
    customer_id: Uuid,
    target_transaction_id: Uuid,
    target_display_id: String,
    balance_before: String,
    projected_balance_after: String,
    amount: Decimal,
    amount_cents: i64,
    payment_provider_attempt_id: Uuid,
    provider_transaction_id: String,
    provider_payment_id: Option<String>,
}

fn exact_order_payment_helcim_replay_shape(
    payload: &CheckoutRequest,
) -> Option<ExactOrderPaymentHelcimReplay> {
    if payload.total_price.round_dp(2) != Decimal::ZERO
        || payload.amount_paid.round_dp(2) <= Decimal::ZERO
        || !payload.items.is_empty()
        || !payload.alteration_intakes.is_empty()
        || payload
            .wedding_disbursements
            .as_ref()
            .is_some_and(|values| !values.is_empty())
        || payload.shipping_rate_quote_id.is_some()
        || !payload.shipping_links.is_empty()
        || payload.target_transaction_id.is_some()
        || payload.is_processing
        || payload.order_payments.len() != 1
    {
        return None;
    }

    let checkout_client_id = payload.checkout_client_id?;
    let customer_id = payload.customer_id?;
    let order_payment = &payload.order_payments[0];
    let payment_splits = payload.payment_splits.as_ref()?;
    if payment_splits.len() != 1
        || order_payment.client_line_id.trim().is_empty()
        || order_payment.target_display_id.trim().is_empty()
        || order_payment.customer_id != customer_id
        || order_payment.balance_before <= Decimal::ZERO
        || order_payment.projected_balance_after < Decimal::ZERO
        || order_payment.amount.round_dp(2) != payload.amount_paid.round_dp(2)
        || (order_payment.balance_before - order_payment.amount).round_dp(2)
            != order_payment.projected_balance_after.round_dp(2)
    {
        return None;
    }

    let split = &payment_splits[0];
    if split.amount.round_dp(2) != payload.amount_paid.round_dp(2)
        || !helcim_tender_method_matches_amount(&split.payment_method, split.amount)
        || split.applied_deposit_amount.unwrap_or(Decimal::ZERO) != Decimal::ZERO
        || split.gift_card_code.is_some()
        || split.check_number.is_some()
    {
        return None;
    }
    let metadata = split.metadata.as_ref()?;
    let provider = metadata
        .get("payment_provider")
        .or_else(|| metadata.get("provider"))
        .and_then(Value::as_str)?
        .trim();
    let provider_status = metadata_optional_text(metadata, "provider_status")?;
    if !provider.eq_ignore_ascii_case("helcim")
        || !matches!(
            provider_status.trim().to_ascii_lowercase().as_str(),
            "approved" | "approval" | "captured"
        )
    {
        return None;
    }

    let payment_provider_attempt_id = Uuid::parse_str(&metadata_optional_text(
        metadata,
        "payment_provider_attempt_id",
    )?)
    .ok()?;
    let provider_transaction_id = metadata_optional_text(metadata, "provider_transaction_id")?;
    let provider_payment_id = metadata_optional_text(metadata, "provider_payment_id");
    let amount = payload.amount_paid.round_dp(2);
    let amount_cents = (amount * Decimal::from(100)).to_i64()?;

    Some(ExactOrderPaymentHelcimReplay {
        checkout_client_id,
        session_id: payload.session_id,
        operator_staff_id: payload.operator_staff_id,
        customer_id,
        target_transaction_id: order_payment.target_transaction_id,
        target_display_id: order_payment.target_display_id.trim().to_string(),
        balance_before: order_payment.balance_before.to_string(),
        projected_balance_after: order_payment.projected_balance_after.to_string(),
        amount,
        amount_cents,
        payment_provider_attempt_id,
        provider_transaction_id,
        provider_payment_id,
    })
}

async fn find_exact_committed_order_payment_helcim_replay(
    pool: &PgPool,
    payload: &CheckoutRequest,
) -> Result<Option<(Uuid, String)>, CheckoutError> {
    let Some(evidence) = exact_order_payment_helcim_replay_shape(payload) else {
        return Ok(None);
    };

    let matches: Vec<(Uuid, String)> = sqlx::query_as(
        r#"
        SELECT source.id, source.display_id
        FROM payment_provider_attempts attempt
        INNER JOIN payment_transactions payment
            ON LOWER(BTRIM(COALESCE(payment.payment_provider, ''))) = 'helcim'
           AND payment.provider_transaction_id = attempt.provider_transaction_id
        INNER JOIN payment_allocations allocation
            ON allocation.transaction_id = payment.id
        INNER JOIN transactions target
            ON target.id = allocation.target_transaction_id
        INNER JOIN transactions source
            ON source.id::text = payment.metadata->>'checkout_transaction_id'
        WHERE attempt.id = $1
          AND LOWER(BTRIM(attempt.provider)) = 'helcim'
          AND attempt.status IN ('approved', 'captured')
          AND attempt.completed_at IS NOT NULL
          AND attempt.error_code IS NULL
          AND LOWER(BTRIM(attempt.currency)) = 'usd'
          AND attempt.amount_cents = $2
          AND attempt.register_session_id = $3
          AND attempt.staff_id = $4
          AND attempt.checkout_client_id = $5
          AND attempt.provider_transaction_id = $6
          AND ($7::text IS NULL OR attempt.provider_payment_id = $7)
          AND payment.status IN ('success', 'approved', 'captured')
          AND LOWER(BTRIM(COALESCE(payment.provider_status, '')))
                IN ('approved', 'approval', 'captured')
          AND payment.session_id = $3
          AND payment.payer_id = $8
          AND payment.amount = $9
          AND payment.provider_transaction_id = $6
          AND allocation.target_transaction_id = $10
          AND allocation.amount_allocated = $9
          AND allocation.metadata->>'kind' = 'existing_order_payment'
          AND NULLIF(BTRIM(allocation.metadata->>'client_line_id'), '') IS NOT NULL
          AND allocation.metadata->>'target_transaction_id' = $10::text
          AND NULLIF(BTRIM(allocation.metadata->>'target_display_id'), '') IS NOT NULL
          AND allocation.metadata->>'customer_id' = $8::text
          AND allocation.metadata->>'balance_before' = $12
          AND allocation.metadata->>'projected_balance_after' = $13
          AND target.customer_id = $8
          AND BTRIM(target.display_id) = $11
          AND target.status = 'fulfilled'::order_status
          AND target.total_price > 0
          AND target.amount_paid = target.total_price
          AND target.balance_due = 0
          AND source.register_session_id = $3
          AND source.customer_id = $8
          AND source.total_price = 0
          AND source.amount_paid = 0
          AND source.balance_due = 0
          AND source.status = 'fulfilled'::order_status
          AND (
              NULLIF(BTRIM(payment.metadata->>'checkout_display_id'), '') IS NULL
              OR payment.metadata->>'checkout_display_id' = source.display_id
          )
          AND (
              SELECT COUNT(*)::bigint
              FROM payment_provider_attempts other_attempt
              WHERE LOWER(BTRIM(other_attempt.provider)) = 'helcim'
                AND (
                    other_attempt.id = $1
                    OR other_attempt.provider_transaction_id = $6
                    OR (
                        $7::text IS NOT NULL
                        AND other_attempt.provider_payment_id = $7
                    )
                )
          ) = 1
          AND (
              SELECT COUNT(*)::bigint
              FROM payment_transactions other_payment
              WHERE LOWER(BTRIM(COALESCE(other_payment.payment_provider, ''))) = 'helcim'
                AND other_payment.provider_transaction_id = $6
          ) = 1
          AND (
              SELECT COUNT(*)::bigint
              FROM payment_allocations other_allocation
              WHERE other_allocation.transaction_id = payment.id
          ) = 1
        "#,
    )
    .bind(evidence.payment_provider_attempt_id)
    .bind(evidence.amount_cents)
    .bind(evidence.session_id)
    .bind(evidence.operator_staff_id)
    .bind(evidence.checkout_client_id)
    .bind(&evidence.provider_transaction_id)
    .bind(evidence.provider_payment_id.as_deref())
    .bind(evidence.customer_id)
    .bind(evidence.amount)
    .bind(evidence.target_transaction_id)
    .bind(&evidence.target_display_id)
    .bind(&evidence.balance_before)
    .bind(&evidence.projected_balance_after)
    .fetch_all(pool)
    .await?;

    match matches.as_slice() {
        [] => Ok(None),
        [committed] => Ok(Some(committed.clone())),
        _ => Err(CheckoutError::InvalidPayload(
            "Helcim order-payment replay evidence is ambiguous; reconcile it in Payments Health"
                .to_string(),
        )),
    }
}

pub async fn execute_checkout(
    pool: &PgPool,
    http: &reqwest::Client,
    global_employee_markup: Decimal,
    payload: CheckoutRequest,
) -> Result<CheckoutDone, CheckoutError> {
    execute_checkout_internal(pool, http, global_employee_markup, payload, None).await
}

pub async fn execute_recovery_checkout(
    pool: &PgPool,
    http: &reqwest::Client,
    global_employee_markup: Decimal,
    payload: CheckoutRequest,
    recovery: CheckoutRecoveryContext,
) -> Result<CheckoutDone, CheckoutError> {
    execute_checkout_internal(pool, http, global_employee_markup, payload, Some(recovery)).await
}

async fn execute_checkout_internal(
    pool: &PgPool,
    http: &reqwest::Client,
    global_employee_markup: Decimal,
    mut payload: CheckoutRequest,
    recovery: Option<CheckoutRecoveryContext>,
) -> Result<CheckoutDone, CheckoutError> {
    let checkout_started = Instant::now();
    strip_sensitive_checkout_request(&mut payload);
    let (checkout_request_fingerprint, checkout_payment_fingerprint) =
        checkout_request_fingerprints(&payload)?;
    let checkout_processing_intent_fingerprint = checkout_processing_intent_fingerprint(&payload)?;

    // A provider response can be lost after the database commit. Resolve an
    // exact replay before provider-reference uniqueness checks so the Register
    // reports the already committed transaction truthfully. Never accept a
    // checkout_client_id by itself: the register session, full request, and
    // payment fingerprint must all match the committed sale.
    if let Some(checkout_client_id) = payload.checkout_client_id {
        let existing: Option<(
            Uuid,
            String,
            DbOrderStatus,
            Option<Uuid>,
            Option<String>,
            Option<String>,
            Option<String>,
        )> = sqlx::query_as(
            r#"
            SELECT id, display_id, status, register_session_id,
                   checkout_request_fingerprint, checkout_payment_fingerprint,
                   checkout_processing_intent_fingerprint
            FROM transactions
            WHERE checkout_client_id = $1
            "#,
        )
        .bind(checkout_client_id)
        .fetch_optional(pool)
        .await?;

        if let Some((
            transaction_id,
            display_id,
            status,
            register_session_id,
            request_hash,
            payment_hash,
            processing_hash,
        )) = existing
        {
            if status == DbOrderStatus::Processing {
                validate_processing_intent_fingerprint(
                    &payload,
                    register_session_id,
                    processing_hash.as_deref(),
                    &checkout_processing_intent_fingerprint,
                )?;
            } else {
                validate_checkout_replay_fingerprints(
                    &payload,
                    register_session_id,
                    request_hash.as_deref(),
                    payment_hash.as_deref(),
                    &checkout_request_fingerprint,
                    &checkout_payment_fingerprint,
                )?;
            }
            if status != DbOrderStatus::Processing || payload.is_processing {
                if status == DbOrderStatus::Processing {
                    validate_checkout_replay_fingerprints(
                        &payload,
                        register_session_id,
                        request_hash.as_deref(),
                        payment_hash.as_deref(),
                        &checkout_request_fingerprint,
                        &checkout_payment_fingerprint,
                    )?;
                }
                tracing::info!(%transaction_id, "checkout exact idempotent replay");
                return Ok(CheckoutDone::Idempotent {
                    transaction_id,
                    display_id,
                });
            }
        }
    }

    // Some approved manual-card replacements are normalized into a dedicated
    // zero-dollar ledger Transaction Record before the original Register
    // request receives a response. That source record intentionally has its
    // own checkout identity, so the ordinary checkout_client_id lookup above
    // cannot find it. Accept only the exact final Helcim attempt, normalized
    // payment, single target allocation, and linked source Transaction Record.
    // This is read-only and runs before target lifecycle validation, allowing
    // a replay after the payment closes its target without recording it twice.
    if let Some((transaction_id, display_id)) =
        find_exact_committed_order_payment_helcim_replay(pool, &payload).await?
    {
        tracing::info!(
            %transaction_id,
            checkout_client_id = ?payload.checkout_client_id,
            "checkout exact order-payment Helcim ledger replay"
        );
        return Ok(CheckoutDone::Idempotent {
            transaction_id,
            display_id,
        });
    }

    let has_wedding_disbursements = payload
        .wedding_disbursements
        .as_ref()
        .is_some_and(|v| !v.is_empty());
    let has_shipping_charge = payload.shipping_rate_quote_id.is_some();
    if payload.items.is_empty()
        && !has_wedding_disbursements
        && payload.order_payments.is_empty()
        && !has_shipping_charge
    {
        return Err(CheckoutError::InvalidPayload(
            "Cart cannot be empty (must have items, wedding payouts, order payments, or shipping)"
                .to_string(),
        ));
    }
    if !payload.shipping_links.is_empty() && !has_shipping_charge {
        return Err(CheckoutError::InvalidPayload(
            "Shipping links require a Register shipping charge.".to_string(),
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
    validate_wedding_member_checkout_customer(
        pool,
        payload.customer_id,
        customer_id_orig,
        payload.wedding_member_id,
    )
    .await?;
    let mut order_payments = validate_order_payment_shape(
        payload.customer_id,
        customer_id_orig,
        &payload.order_payments,
    )?;

    for item in &payload.items {
        validate_checkout_item_quantity(item)?;
    }
    let alteration_client_line_ids = validate_checkout_alteration_intakes(
        payload.customer_id,
        &payload.items,
        &payload.alteration_intakes,
    )?;

    let is_employee_purchase_order: bool = if let Some(cid) = customer_id_orig {
        sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(SELECT 1 FROM staff WHERE employee_customer_id = $1)"#,
        )
        .bind(cid)
        .fetch_one(pool)
        .await?
    } else {
        false
    };
    if is_employee_purchase_order {
        payload.primary_salesperson_id = None;
        for item in &mut payload.items {
            item.salesperson_id = None;
        }
    }

    if !staff_id_active(pool, payload.operator_staff_id).await? {
        return Err(CheckoutError::InvalidPayload(
            "operator_staff_id is invalid or inactive".to_string(),
        ));
    }
    if let Some(pid) = payload.primary_salesperson_id {
        if !staff_id_active_salesperson(pool, pid).await? {
            return Err(CheckoutError::InvalidPayload(
                "primary_salesperson_id must be an active salesperson".to_string(),
            ));
        }
    }
    for item in &payload.items {
        if let Some(sid) = item.salesperson_id {
            if !staff_id_active_salesperson(pool, sid).await? {
                return Err(CheckoutError::InvalidPayload(format!(
                    "salesperson_id must be an active salesperson for variant {}",
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

    // Pre-resolve all unique variant IDs once to avoid repeated DB lookups during validation.
    let mut resolved_variants: HashMap<Uuid, inventory::ResolvedSkuItem> = HashMap::new();
    for item in &payload.items {
        if resolved_variants.contains_key(&item.variant_id) {
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
        resolved_variants.insert(item.variant_id, resolved);
    }

    let mut is_rms_payment_collection = false;
    let mut is_staff_account_payment_collection = false;
    {
        let rms_line_count = payload
            .items
            .iter()
            .filter(|item| {
                resolved_variants
                    .get(&item.variant_id)
                    .and_then(|r| r.pos_line_kind.as_deref())
                    == Some("rms_charge_payment")
            })
            .count();
        if rms_line_count > 0 {
            if payload.items.len() != 1 || payload.items[0].quantity != 1 {
                return Err(CheckoutError::InvalidPayload(
                    "RMS CHARGE PAYMENT cannot be combined with other items and must be quantity 1"
                        .to_string(),
                ));
            }
            let r0 = resolved_variants.get(&payload.items[0].variant_id).unwrap();
            if r0.pos_line_kind.as_deref() != Some("rms_charge_payment") {
                return Err(CheckoutError::InvalidPayload(
                    "Invalid RMS payment line".to_string(),
                ));
            }
            is_rms_payment_collection = true;
        }
        let staff_account_line_count = payload
            .items
            .iter()
            .filter(|item| {
                resolved_variants
                    .get(&item.variant_id)
                    .and_then(|r| r.pos_line_kind.as_deref())
                    == Some("staff_account_payment")
            })
            .count();
        if staff_account_line_count > 0 {
            if payload.items.len() != 1 || payload.items[0].quantity != 1 {
                return Err(CheckoutError::InvalidPayload(
                    "STAFF ACCOUNT PAYMENT cannot be combined with other items and must be quantity 1"
                        .to_string(),
                ));
            }
            let r0 = resolved_variants.get(&payload.items[0].variant_id).unwrap();
            if r0.pos_line_kind.as_deref() != Some("staff_account_payment") {
                return Err(CheckoutError::InvalidPayload(
                    "Invalid Staff Account payment line".to_string(),
                ));
            }
            is_staff_account_payment_collection = true;
        }
    }

    let mut has_pos_gift_card_load = false;
    let mut gc_load_codes: HashSet<String> = HashSet::new();
    for item in &payload.items {
        let resolved = resolved_variants.get(&item.variant_id).unwrap();
        let kind = resolved.pos_line_kind.as_deref();
        if payload.primary_salesperson_id.is_none()
            && item.salesperson_id.is_none()
            && !is_employee_purchase_order
            && !matches!(
                kind,
                Some("pos_gift_card_load")
                    | Some("rms_charge_payment")
                    | Some("staff_account_payment")
            )
        {
            return Err(CheckoutError::InvalidPayload(
                "salesperson_id or primary_salesperson_id is required for sale lines".to_string(),
            ));
        }
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

    if is_staff_account_payment_collection {
        if payload.customer_id.is_none() {
            return Err(CheckoutError::InvalidPayload(
                "STAFF ACCOUNT PAYMENT requires a linked staff customer".to_string(),
            ));
        }
        if payload.wedding_member_id.is_some() {
            return Err(CheckoutError::InvalidPayload(
                "STAFF ACCOUNT PAYMENT cannot be used with wedding member checkout".to_string(),
            ));
        }
        if payload
            .wedding_disbursements
            .as_ref()
            .map(|d| !d.is_empty())
            .unwrap_or(false)
        {
            return Err(CheckoutError::InvalidPayload(
                "STAFF ACCOUNT PAYMENT does not support wedding disbursements".to_string(),
            ));
        }
        if !order_payments.is_empty() {
            return Err(CheckoutError::InvalidPayload(
                "STAFF ACCOUNT PAYMENT does not support existing order payments".to_string(),
            ));
        }
        let summary =
            staff_accounts::summary_for_customer(pool, payload.customer_id.unwrap()).await?;
        if summary
            .as_ref()
            .map(|account| account.status.as_str() == "active")
            != Some(true)
        {
            return Err(CheckoutError::InvalidPayload(
                "Linked customer does not have an active staff account".to_string(),
            ));
        }
    }

    let has_customer_profile_discount = payload.items.iter().any(|item| {
        item.price_override_reason
            .as_deref()
            .map(str::trim)
            .map(|reason| reason.eq_ignore_ascii_case(CUSTOMER_PROFILE_DISCOUNT_REASON))
            .unwrap_or(false)
    });
    let customer_profile_discount = if has_customer_profile_discount {
        let customer_id = customer_id_orig.or(payload.customer_id).ok_or_else(|| {
            CheckoutError::InvalidPayload(
                "Customer profile discount requires a linked customer".to_string(),
            )
        })?;
        let pct = sqlx::query_scalar::<_, Decimal>(
            "SELECT profile_discount_percent FROM customers WHERE id = $1",
        )
        .bind(customer_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| CheckoutError::InvalidPayload("Customer not found".to_string()))?;
        if pct <= Decimal::ZERO {
            return Err(CheckoutError::InvalidPayload(
                "Customer profile discount is not enabled for this customer".to_string(),
            ));
        }
        Some((customer_id, pct))
    } else {
        None
    };

    let discount_authority_staff_id = recovery
        .as_ref()
        .map(|context| context.authorized_by_staff_id)
        .unwrap_or(payload.operator_staff_id);
    let max_disc_pct =
        pricing_limits::max_discount_percent_for_staff(pool, discount_authority_staff_id).await?;

    for item in &payload.items {
        let reason = item
            .price_override_reason
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty());
        let has_ov = reason.is_some();
        if !has_ov {
            continue;
        }
        let resolved = resolved_variants.get(&item.variant_id).unwrap();
        let retail = resolved.standard_retail_price;
        if retail <= Decimal::ZERO {
            continue;
        }
        if reason
            .map(|r| r.eq_ignore_ascii_case(CUSTOMER_PROFILE_DISCOUNT_REASON))
            .unwrap_or(false)
        {
            if item.discount_event_id.is_some() {
                return Err(CheckoutError::InvalidPayload(
                    "Customer profile discount cannot be combined with a sale event discount"
                        .to_string(),
                ));
            }
            let kind = resolved.pos_line_kind.as_deref();
            if matches!(
                kind,
                Some("rms_charge_payment")
                    | Some("pos_gift_card_load")
                    | Some("staff_account_payment")
                    | Some("alteration_service")
            ) || item.line_type.as_deref() == Some("alteration_service")
            {
                return Err(CheckoutError::InvalidPayload(
                    "Customer profile discount only applies to merchandise lines".to_string(),
                ));
            }
            let (_, pct) = customer_profile_discount.ok_or_else(|| {
                CheckoutError::InvalidPayload(
                    "Customer profile discount is not enabled for this customer".to_string(),
                )
            })?;
            let expected_unit =
                (retail * (Decimal::from(100) - pct) / Decimal::from(100)).round_dp(2);
            if !checkout_validate::money_close_decimal(item.unit_price, expected_unit) {
                return Err(CheckoutError::InvalidPayload(format!(
                    "unit price for variant {} does not match customer profile discount {:.2}% off retail",
                    item.variant_id, pct
                )));
            }
            continue;
        }
        if reason
            .map(|r| r.eq_ignore_ascii_case(EMPLOYEE_DISCOUNT_REASON))
            .unwrap_or(false)
        {
            if !is_employee_purchase_order {
                return Err(CheckoutError::InvalidPayload(
                    "Employee Discount requires a linked employee customer account".to_string(),
                ));
            }
            if item.discount_event_id.is_some() {
                return Err(CheckoutError::InvalidPayload(
                    "Employee Discount cannot be combined with a sale event discount".to_string(),
                ));
            }
            let kind = resolved.pos_line_kind.as_deref();
            if matches!(
                kind,
                Some("rms_charge_payment")
                    | Some("pos_gift_card_load")
                    | Some("staff_account_payment")
                    | Some("alteration_service")
            ) || item.line_type.as_deref() == Some("alteration_service")
            {
                return Err(CheckoutError::InvalidPayload(
                    "Employee Discount only applies to merchandise lines".to_string(),
                ));
            }
            if !checkout_validate::money_close_decimal(item.unit_price, resolved.employee_price) {
                return Err(CheckoutError::InvalidPayload(format!(
                    "unit price for variant {} does not match employee price",
                    item.variant_id
                )));
            }
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
        let resolved = resolved_variants.get(&item.variant_id).unwrap();
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
        if resolved.pos_line_kind.as_deref() == Some("staff_account_payment") {
            return Err(CheckoutError::InvalidPayload(
                "Discount events cannot apply to STAFF ACCOUNT PAYMENT".to_string(),
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
                de.scope_type = 'all'
                OR
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

    let mut below_cost_lines: Vec<Value> = Vec::new();
    for item in &payload.items {
        if item.quantity <= 0 || item.discount_event_id.is_some() {
            continue;
        }
        let Some(reason) = item
            .price_override_reason
            .as_deref()
            .map(str::trim)
            .filter(|reason| is_manual_below_cost_reason(reason))
        else {
            continue;
        };
        let resolved = resolved_variants.get(&item.variant_id).unwrap();
        if matches!(
            resolved.pos_line_kind.as_deref(),
            Some("rms_charge_payment")
                | Some("pos_gift_card_load")
                | Some("staff_account_payment")
                | Some("alteration_service")
        ) || item.line_type.as_deref() == Some("alteration_service")
            || item.fulfillment == DbFulfillmentType::Custom
        {
            continue;
        }
        if resolved.unit_cost <= Decimal::ZERO || item.unit_price < resolved.unit_cost {
            below_cost_lines.push(json!({
                "product_id": item.product_id,
                "variant_id": item.variant_id,
                "sku": resolved.sku,
                "name": resolved.name,
                "unit_price": item.unit_price,
                "unit_cost": resolved.unit_cost,
                "standard_retail_price": resolved.standard_retail_price,
                "reason": reason,
            }));
        }
    }

    let below_cost_approval_metadata = if below_cost_lines.is_empty() {
        None
    } else {
        let approval = payload.below_cost_approval.as_ref().ok_or_else(|| {
            CheckoutError::InvalidPayload(
                "Manual discounts below cost require Manager Access approval before checkout"
                    .to_string(),
            )
        })?;
        let ok = pricing_limits::is_admin_or_manager(pool, approval.approved_by_staff_id).await?;
        if !ok {
            return Err(CheckoutError::InvalidPayload(
                "Manual discounts below cost require an active manager approval".to_string(),
            ));
        }
        Some(json!({
            "approved_by_staff_id": approval.approved_by_staff_id,
            "reason": approval.reason.as_deref().unwrap_or("Manager approved below-cost manual discount"),
            "line_signature": approval.line_signature,
            "lines": below_cost_lines,
        }))
    };

    let (mut payment_splits, payment_activity_label) = resolve_payment_splits(&payload)?;
    let exchange_checkout_intent = validate_exchange_checkout_intent(&payload, &payment_splits)?;
    for split in &mut payment_splits {
        strip_sensitive_payment_metadata(&mut split.metadata);
    }

    let has_rms_charge = payment_splits
        .iter()
        .any(|s| pos_rms_charge::is_rms_method(&s.method));
    if has_rms_charge || is_rms_payment_collection {
        for split in &mut payment_splits {
            if pos_rms_charge::is_rms_method(&split.method) || is_rms_payment_collection {
                apply_manual_rms_tracking_metadata(&mut split.metadata);
            }
        }
    }
    let (checkout_booked_at_local, checkout_business_date) =
        resolve_checkout_booked_at(pool, payload.booked_at_local.as_deref()).await?;

    if checkout_booked_at_local.is_some() && recovery.is_none() {
        let approval = payload.backdate_approval.as_ref().ok_or_else(|| {
            CheckoutError::InvalidPayload(
                "Backdated sales require Manager Access approval before checkout".to_string(),
            )
        })?;
        if approval.reason.trim().is_empty() {
            return Err(CheckoutError::InvalidPayload(
                "A reason is required for a backdated sale".to_string(),
            ));
        }
        if !pricing_limits::is_admin_or_manager(pool, approval.approved_by_staff_id).await? {
            return Err(CheckoutError::InvalidPayload(
                "Backdated sales require an active manager approval".to_string(),
            ));
        }
        if !backdate_approval_was_logged(
            pool,
            approval,
            checkout_booked_at_local.as_deref().unwrap_or_default(),
            payload.session_id,
        )
        .await?
        {
            return Err(CheckoutError::InvalidPayload(
                "Backdate approval expired or could not be verified; approve the date again"
                    .to_string(),
            ));
        }
    }

    if let Some(business_date) = checkout_business_date {
        for split in &mut payment_splits {
            if let Some(metadata) = split.metadata.as_object_mut() {
                metadata.insert("register_backdated".to_string(), json!(true));
                metadata.insert(
                    "backdated_business_date".to_string(),
                    json!(business_date.to_string()),
                );
            }
        }
    }

    let mut transaction_financing_metadata = pos_rms_charge::transaction_metadata_from_splits(
        payment_splits
            .iter()
            .map(|split| (split.method.as_str(), &split.metadata)),
    );
    if let (Some(booked_at_local), Some(business_date)) =
        (checkout_booked_at_local.as_deref(), checkout_business_date)
    {
        if let Some(obj) = transaction_financing_metadata.as_object_mut() {
            obj.insert("register_backdated".to_string(), json!(true));
            obj.insert("booked_at_local".to_string(), json!(booked_at_local));
            obj.insert(
                "business_date".to_string(),
                json!(business_date.to_string()),
            );
            if let Some(approval) = payload.backdate_approval.as_ref() {
                obj.insert(
                    "backdate_approval".to_string(),
                    json!({
                        "approved_by_staff_id": approval.approved_by_staff_id,
                        "reason": approval.reason.trim(),
                    }),
                );
            }
        }
    }
    if let Some(metadata) = below_cost_approval_metadata {
        if let Some(obj) = transaction_financing_metadata.as_object_mut() {
            obj.insert("below_cost_approval".to_string(), metadata);
        }
    }
    if let (Some(selected_customer_id), Some(effective_customer_id)) =
        (customer_id_orig, payload.customer_id)
    {
        if selected_customer_id != effective_customer_id {
            if let Some(obj) = transaction_financing_metadata.as_object_mut() {
                obj.insert(
                    "selected_customer_id".to_string(),
                    json!(selected_customer_id.to_string()),
                );
                obj.insert(
                    "effective_customer_id".to_string(),
                    json!(effective_customer_id.to_string()),
                );
                obj.insert(
                    "customer_resolution".to_string(),
                    json!("couple_primary_financial_owner"),
                );
            }
        }
    }

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
        if s.method.trim().eq_ignore_ascii_case("staff_account_charge") {
            let Some(cid) = payload.customer_id else {
                return Err(CheckoutError::InvalidPayload(
                    "Staff Account charge requires a linked staff customer".to_string(),
                ));
            };
            let summary = staff_accounts::summary_for_customer(pool, cid).await?;
            if summary
                .as_ref()
                .map(|account| account.status.as_str() == "active")
                != Some(true)
            {
                return Err(CheckoutError::InvalidPayload(
                    "Staff Account charge requires an active staff account".to_string(),
                ));
            }
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

    if is_staff_account_payment_collection {
        for s in &payment_splits {
            let m = s.method.trim().to_ascii_lowercase();
            if !matches!(
                m.as_str(),
                "cash" | "check" | "card_terminal" | "card_manual" | "card_saved"
            ) {
                return Err(CheckoutError::InvalidPayload(
                    "STAFF ACCOUNT PAYMENT accepts cash, check, or approved card only".to_string(),
                ));
            }
        }
    }

    validate_helcim_payment_splits(
        pool,
        payload.session_id,
        payload.checkout_client_id,
        recovery
            .as_ref()
            .map(|context| context.require_checkout_binding)
            .unwrap_or(true),
        &mut payment_splits,
    )
    .await?;

    if recovery
        .as_ref()
        .map(|context| context.require_checkout_binding)
        .unwrap_or(true)
    {
        reject_unattached_helcim_attempt(pool, payload.checkout_client_id, &payment_splits).await?;
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
                tax_category_override: i.tax_category_override,
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
    let shipping_peek: Option<(Decimal, serde_json::Value)> = if let Some(qid) = shipping_quote_id {
        let row: Option<(Decimal, serde_json::Value)> = sqlx::query_as(
            r#"
            SELECT amount_usd, metadata FROM store_shipping_rate_quote
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
    let shipping_fee_only = shipping_peek
        .as_ref()
        .is_some_and(|(_, metadata)| is_fee_only_shipping_quote(metadata));
    let shipping_peek_amt = shipping_peek.as_ref().map(|(amount, _)| *amount);

    if requested_ship && shipping_quote_id.is_none() {
        return Err(CheckoutError::InvalidPayload(
            "Ship current sale requires the Register Shipping action so rates, address, and shipment tracking are recorded."
                .to_string(),
        ));
    }
    if requested_ship && shipping_fee_only {
        return Err(CheckoutError::InvalidPayload(
            "A shipping fee does not create a shipment. Clear it and use Ship Current Sale for delivery."
                .to_string(),
        ));
    }
    if shipping_fee_only && !payload.shipping_links.is_empty() {
        return Err(CheckoutError::InvalidPayload(
            "A shipping fee cannot be linked to delivery records. Use the Shipping workflow instead."
                .to_string(),
        ));
    }
    if payload.fulfillment_mode == Some(DbOrderFulfillmentMethod::Pickup)
        && shipping_quote_id.is_some()
        && !shipping_fee_only
    {
        return Err(CheckoutError::InvalidPayload(
            "Shipping quote was attached but fulfillment mode is pickup; clear shipping or choose Ship Current Sale."
                .to_string(),
        ));
    }
    if shipping_quote_id.is_some() && !shipping_fee_only && payload.ship_to.is_none() {
        tracing::debug!(
            "checkout shipping uses ship_to from rate quote metadata; payload ship_to was empty"
        );
    }
    if let Some(sa) = shipping_peek_amt {
        sum_expected += sa;
    }

    let tol = Decimal::new(2, 2);
    if !checkout_total_matches(payload.total_price, sum_expected) {
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

    let rounding_adj = payload.rounding_adjustment.unwrap_or(Decimal::ZERO);
    let refund_checkout = payload.total_price.round_dp(2) < Decimal::ZERO
        || payload.amount_paid.round_dp(2) < Decimal::ZERO;
    if refund_checkout {
        if payload.total_price.round_dp(2) >= Decimal::ZERO
            || payload.amount_paid.round_dp(2) >= Decimal::ZERO
        {
            return Err(CheckoutError::InvalidPayload(
                "refund checkout requires a negative total and negative refund tender".to_string(),
            ));
        }
        if d_total > Decimal::ZERO || order_payment_total > Decimal::ZERO {
            return Err(CheckoutError::InvalidPayload(
                "refund checkout cannot include party disbursements or order payments".to_string(),
            ));
        }
    } else {
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
    }

    let amount_toward_order = if refund_checkout {
        payload.amount_paid.round_dp(2)
    } else {
        (payload.amount_paid - d_total - order_payment_total).round_dp(2)
    };
    if !refund_checkout && amount_toward_order < Decimal::ZERO {
        return Err(CheckoutError::InvalidPayload(
            "amount collected is less than party disbursements and order payments".to_string(),
        ));
    }

    if !refund_checkout && amount_toward_order > payload.total_price + tol {
        return Err(CheckoutError::InvalidPayload(
            "amount applied to this order exceeds total_price — reduce tenders or adjust party disbursements"
                .to_string(),
        ));
    }

    let balance_due = (payload.total_price + rounding_adj - amount_toward_order).round_dp(2);
    if refund_checkout && balance_due.abs() > tol {
        return Err(CheckoutError::InvalidPayload(
            "refund checkout must be fully tendered before recording".to_string(),
        ));
    }
    if !refund_checkout && balance_due < Decimal::ZERO {
        return Err(CheckoutError::InvalidPayload(
            "order balance due cannot be negative".to_string(),
        ));
    }

    let takeaway_total = takeaway_line_total_decimal(&payload.items);
    validate_open_deposit_scope(
        &payment_splits,
        payload.total_price,
        takeaway_total,
        d_total,
        order_payment_total,
    )?;
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
    let has_deferred_current_lines = payload.items.iter().any(|i| {
        matches!(
            i.fulfillment,
            DbFulfillmentType::SpecialOrder
                | DbFulfillmentType::Custom
                | DbFulfillmentType::WeddingOrder
                | DbFulfillmentType::Layaway
        )
    });
    let current_transaction_deposit_allocation = if !refund_checkout && has_deferred_current_lines {
        (amount_toward_order - takeaway_total)
            .round_dp(2)
            .max(Decimal::ZERO)
    } else {
        Decimal::ZERO
    };

    let ship_order = shipping_quote_id.is_some() && !shipping_fee_only;

    let order_status = if is_fully_paid && all_takeaway && !ship_order {
        DbOrderStatus::Fulfilled
    } else {
        DbOrderStatus::Open
    };

    let _set_fulfilled_at = order_status == DbOrderStatus::Fulfilled;

    let mut price_override_audit: Vec<Value> = Vec::new();
    let mut checkout_warnings: Vec<String> = Vec::new();
    let mut deferred_wedding_activities: Vec<DeferredWeddingActivity> = Vec::new();

    let mut tx = pool.begin().await?;

    // Lock the Register session before re-reading checkout_client_id. This
    // serializes checkout completion with other sales and Z-close so a waiter
    // cannot retain a stale `processing` status after another request commits.
    let session_state: Option<(bool, String, i16)> = sqlx::query_as(
        r#"
        SELECT is_open, lifecycle_status, register_lane
        FROM register_sessions
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(payload.session_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((session_is_open, session_lifecycle, register_lane)) = session_state else {
        return Err(CheckoutError::InvalidPayload(
            "Register session is invalid. Open or join an active Register, then retry; no sale was recorded."
                .to_string(),
        ));
    };
    let recovery_allows_closed_session = recovery
        .as_ref()
        .map(|context| context.allow_closed_session)
        .unwrap_or(false);
    if !recovery_allows_closed_session && (!session_is_open || session_lifecycle.as_str() != "open")
    {
        let message = if session_is_open && session_lifecycle == "reconciling" {
            format!(
                "Register #{register_lane} is waiting for Z-close. Finish the close or choose Restore Register for Selling in Register Settings, then retry; no sale was recorded."
            )
        } else {
            format!(
                "Register #{register_lane} is closed. Open or join an active Register, then retry; no sale was recorded."
            )
        };
        return Err(CheckoutError::InvalidPayload(message));
    }

    // Payment initiation uses the same provider+checkout advisory identity.
    // Taking it after the Register row lock serializes this checkout with a
    // Helcim start for the same sale even when another Register initiated it.
    if let Some(checkout_client_id) = payload.checkout_client_id {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("helcim:checkout:{checkout_client_id}"))
            .execute(&mut *tx)
            .await?;
    }

    // Payment initiation takes the same Register-session lock before creating
    // a provider attempt. Recheck while holding it so a pending/unknown Helcim
    // request cannot race the earlier validation and let an alternate tender
    // complete this checkout.
    if recovery
        .as_ref()
        .map(|context| context.require_checkout_binding)
        .unwrap_or(true)
    {
        reject_unattached_helcim_attempt(&mut *tx, payload.checkout_client_id, &payment_splits)
            .await?;
    }

    let mut transaction_id = Uuid::new_v4();
    let mut transaction_display_id = String::new();
    let mut is_completing_processing = false;

    if let Some(cid) = payload.checkout_client_id {
        let existing: Option<(
            Uuid,
            String,
            DbOrderStatus,
            Option<Uuid>,
            Option<String>,
            Option<String>,
            Option<String>,
        )> = sqlx::query_as(
            r#"
            SELECT id, display_id, status, register_session_id,
                   checkout_request_fingerprint, checkout_payment_fingerprint,
                   checkout_processing_intent_fingerprint
            FROM transactions
            WHERE checkout_client_id = $1
            "#,
        )
        .bind(cid)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some((
            tid,
            d_id,
            status,
            register_session_id,
            request_hash,
            payment_hash,
            processing_hash,
        )) = existing
        {
            if status == DbOrderStatus::Processing {
                validate_processing_intent_fingerprint(
                    &payload,
                    register_session_id,
                    processing_hash.as_deref(),
                    &checkout_processing_intent_fingerprint,
                )?;
            } else {
                validate_checkout_replay_fingerprints(
                    &payload,
                    register_session_id,
                    request_hash.as_deref(),
                    payment_hash.as_deref(),
                    &checkout_request_fingerprint,
                    &checkout_payment_fingerprint,
                )?;
            }
            if status != DbOrderStatus::Processing {
                tx.commit().await?;
                tracing::info!(transaction_id = %tid, "checkout idempotent replay");
                return Ok(CheckoutDone::Idempotent {
                    transaction_id: tid,
                    display_id: d_id,
                });
            } else {
                if payload.is_processing {
                    validate_checkout_replay_fingerprints(
                        &payload,
                        register_session_id,
                        request_hash.as_deref(),
                        payment_hash.as_deref(),
                        &checkout_request_fingerprint,
                        &checkout_payment_fingerprint,
                    )?;
                    tx.commit().await?;
                    tracing::info!(transaction_id = %tid, "checkout idempotent processing replay");
                    return Ok(CheckoutDone::Completed {
                        transaction_id: tid,
                        display_id: d_id,
                        operator_staff_id: payload.operator_staff_id,
                        customer_id: payload.customer_id,
                        price_override_audit: Vec::new(),
                        alteration_order_ids: Vec::new(),
                        amount_paid: Decimal::ZERO,
                        total_price: payload.total_price,
                        warnings: Vec::new(),
                    });
                } else {
                    transaction_id = tid;
                    transaction_display_id = d_id;
                    is_completing_processing = true;
                }
            }
        }
    }

    let mut linked_shipping_targets: Vec<(Uuid, String)> = Vec::new();
    if !payload.shipping_links.is_empty() {
        let Some(checkout_customer_id) = payload.customer_id else {
            return Err(CheckoutError::InvalidPayload(
                "Select the customer before linking shipping to existing Transaction Records."
                    .to_string(),
            ));
        };
        let mut seen_shipping_targets = std::collections::HashSet::new();
        for link in &payload.shipping_links {
            if !seen_shipping_targets.insert(link.target_transaction_id) {
                continue;
            }
            let target: Option<(Uuid, String, Option<Uuid>, DbOrderStatus)> = sqlx::query_as(
                r#"
                SELECT id, display_id, customer_id, status
                FROM transactions
                WHERE id = $1
                FOR UPDATE
                "#,
            )
            .bind(link.target_transaction_id)
            .fetch_optional(&mut *tx)
            .await?;
            let Some((target_id, display_id, target_customer_id, status)) = target else {
                return Err(CheckoutError::InvalidPayload(
                    "Linked shipping Transaction Record was not found.".to_string(),
                ));
            };
            if target_customer_id != Some(checkout_customer_id) {
                return Err(CheckoutError::InvalidPayload(
                    "Linked shipping Transaction Record belongs to a different customer."
                        .to_string(),
                ));
            }
            if matches!(status, DbOrderStatus::Cancelled) {
                return Err(CheckoutError::InvalidPayload(
                    "Cancelled Transaction Records cannot be linked to a shipping charge."
                        .to_string(),
                ));
            }
            linked_shipping_targets.push((target_id, display_id));
        }
    }

    for payment in &mut order_payments {
        let target: Option<(Uuid, String, String, Option<Uuid>, Decimal, DbOrderStatus)> =
            sqlx::query_as(
                r#"
            SELECT
                o.id,
                COALESCE(
                    (
                        SELECT string_agg(DISTINCT fo.display_id, ', ' ORDER BY fo.display_id)
                        FROM transaction_lines tl
                        INNER JOIN fulfillment_orders fo ON fo.id = tl.fulfillment_order_id
                        WHERE tl.transaction_id = o.id
                    ),
                    o.counterpoint_doc_ref,
                    o.counterpoint_ticket_ref,
                    o.display_id,
                    o.id::text
                ) AS display_id,
                o.display_id AS transaction_display_id,
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
        let Some((
            target_transaction_id,
            display_id,
            transaction_display_id,
            customer_id,
            balance_due,
            status,
        )) = target
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
            transaction_display_id,
            customer_id,
            balance_due: balance_due.round_dp(2),
            status,
            line_count,
        };
        validate_order_payment_against_target(payment, &target)?;
        payment.target_display_id = target.display_id;
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
        if shipping_fee_only {
            (DbOrderFulfillmentMethod::Pickup, None, Some(amt), None)
        } else {
            let st = meta.get("ship_to").cloned().ok_or_else(|| {
                CheckoutError::InvalidPayload("shipping quote missing address snapshot".to_string())
            })?;
            (
                DbOrderFulfillmentMethod::Ship,
                Some(Json(st)),
                Some(amt),
                shippo_rate_object_id,
            )
        }
    } else {
        (DbOrderFulfillmentMethod::Pickup, None, None, None)
    };

    let ship_to_snapshot_for_registry = order_ship_to
        .as_ref()
        .map(|j| j.0.clone())
        .unwrap_or_else(|| json!({}));

    let (transaction_id, transaction_display_id): (Uuid, String) = if is_completing_processing {
        sqlx::query(
            r#"
            UPDATE transactions
            SET status = $1::order_status,
                amount_paid = $2,
                balance_due = $3,
                fulfilled_at = CASE WHEN $1::order_status = 'fulfilled'::order_status THEN CURRENT_TIMESTAMP ELSE NULL END,
                checkout_request_fingerprint = $5,
                checkout_payment_fingerprint = $6
            WHERE id = $4
            "#,
        )
        .bind(order_status)
        .bind(amount_toward_order)
        .bind(balance_due)
        .bind(transaction_id)
        .bind(&checkout_request_fingerprint)
        .bind(&checkout_payment_fingerprint)
        .execute(&mut *tx)
        .await?;

        (transaction_id, transaction_display_id)
    } else {
        let insert_status = if payload.is_processing {
            DbOrderStatus::Processing
        } else {
            order_status
        };

        let txn_insert: Result<(Uuid, String), SqlxError> = sqlx::query_as(
            r#"
            INSERT INTO transactions (
                customer_id, wedding_member_id, operator_id, primary_salesperson_id,
                total_price, amount_paid, balance_due, booked_at, business_date,
                weather_snapshot, checkout_client_id,
                fulfillment_method, ship_to, shipping_amount_usd,
                is_employee_purchase, is_rush, need_by_date,
                is_tax_exempt, tax_exempt_reason, register_session_id,
                rounding_adjustment, final_cash_due, metadata,
                status, fulfilled_at,
                checkout_request_fingerprint, checkout_payment_fingerprint,
                checkout_processing_intent_fingerprint
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                COALESCE(($8::timestamp AT TIME ZONE reporting.effective_store_timezone()), CURRENT_TIMESTAMP),
                COALESCE($9::date, (CURRENT_TIMESTAMP AT TIME ZONE reporting.effective_store_timezone())::date),
                $10, $11,
                $12, $13, $14,
                $15, $16, $17, $18, $19, $20,
                $21, $22, $23,
                $24::order_status,
                CASE WHEN $24::order_status = 'fulfilled'::order_status THEN CURRENT_TIMESTAMP ELSE NULL END,
                $25, $26, $27
            )
            RETURNING id, display_id
            "#,
        )
        .bind(payload.customer_id)
        .bind(payload.wedding_member_id)
        .bind(payload.operator_staff_id)
        .bind(payload.primary_salesperson_id)
        .bind(payload.total_price)
        .bind(if payload.is_processing { Decimal::ZERO } else { amount_toward_order })
        .bind(if payload.is_processing { payload.total_price } else { balance_due })
        .bind(checkout_booked_at_local.as_deref())
        .bind(checkout_business_date)
        .bind(Option::<serde_json::Value>::None)
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
        .bind(insert_status)
        .bind(&checkout_request_fingerprint)
        .bind(&checkout_payment_fingerprint)
        .bind(&checkout_processing_intent_fingerprint)
        .fetch_one(&mut *tx)
        .await;

        match txn_insert {
            Ok(id_display) => id_display,
            Err(SqlxError::Database(db_err))
                if db_err.constraint() == Some("orders_checkout_client_id_uidx") =>
            {
                let Some(cid) = payload.checkout_client_id else {
                    return Err(CheckoutError::Database(SqlxError::Database(db_err)));
                };
                tx.rollback().await?;
                let r: (
                    Uuid,
                    String,
                    DbOrderStatus,
                    Option<Uuid>,
                    Option<String>,
                    Option<String>,
                    Option<String>,
                ) = sqlx::query_as(
                    r#"
                    SELECT id, display_id, status, register_session_id,
                           checkout_request_fingerprint, checkout_payment_fingerprint,
                           checkout_processing_intent_fingerprint
                    FROM transactions
                    WHERE checkout_client_id = $1
                    "#,
                )
                .bind(cid)
                .fetch_one(pool)
                .await?;
                if r.2 == DbOrderStatus::Processing {
                    validate_processing_intent_fingerprint(
                        &payload,
                        r.3,
                        r.6.as_deref(),
                        &checkout_processing_intent_fingerprint,
                    )?;
                    if !payload.is_processing {
                        return Box::pin(execute_checkout_internal(
                            pool,
                            http,
                            global_employee_markup,
                            payload,
                            recovery,
                        ))
                        .await;
                    }
                }
                validate_checkout_replay_fingerprints(
                    &payload,
                    r.3,
                    r.4.as_deref(),
                    r.5.as_deref(),
                    &checkout_request_fingerprint,
                    &checkout_payment_fingerprint,
                )?;
                tracing::info!(transaction_id = %r.0, "checkout idempotent replay after checkout_client_id race");
                return Ok(CheckoutDone::Idempotent {
                    transaction_id: r.0,
                    display_id: r.1,
                });
            }
            Err(e) => return Err(e.into()),
        }
    };

    if let Some((original_transaction_id, exchange_credit_amount)) = exchange_checkout_intent {
        if original_transaction_id == transaction_id {
            return Err(CheckoutError::InvalidPayload(
                "exchange replacement transaction must differ from the original transaction"
                    .to_string(),
            ));
        }
        let checkout_client_id = payload.checkout_client_id.ok_or_else(|| {
            CheckoutError::InvalidPayload(
                "exchange replacement checkout requires a checkout identity".to_string(),
            )
        })?;
        let mut settlement_request = payload
            .exchange_settlement
            .clone()
            .unwrap_or_else(|| json!({}));
        let settlement_object = settlement_request.as_object_mut().ok_or_else(|| {
            CheckoutError::InvalidPayload(
                "exchange settlement intent must be an object".to_string(),
            )
        })?;
        settlement_object.insert("session_id".to_string(), json!(payload.session_id));
        settlement_object.insert(
            "replacement_transaction_id".to_string(),
            json!(transaction_id),
        );

        let recovery_job_key: Option<String> = sqlx::query_scalar(
            r#"
            INSERT INTO operational_recovery_job (
                client_job_key, kind, status, register_session_id,
                transaction_id, checkout_client_id, label, payload, last_error
            )
            VALUES ($1, 'exchange_settlement', 'blocked', $2, $3, $4, $5, $6, $7)
            ON CONFLICT (client_job_key) DO UPDATE SET
                register_session_id = EXCLUDED.register_session_id,
                transaction_id = EXCLUDED.transaction_id,
                checkout_client_id = EXCLUDED.checkout_client_id,
                label = EXCLUDED.label,
                payload = EXCLUDED.payload,
                last_error = EXCLUDED.last_error,
                last_seen_at = now()
            WHERE operational_recovery_job.kind = 'exchange_settlement'
              AND operational_recovery_job.status IN ('pending', 'blocked')
            RETURNING client_job_key
            "#,
        )
        .bind(format!("exchange:{checkout_client_id}"))
        .bind(payload.session_id)
        .bind(transaction_id)
        .bind(checkout_client_id)
        .bind(format!(
            "Exchange settlement for {transaction_display_id}"
        ))
        .bind(json!({
            "original_transaction_id": original_transaction_id,
            "replacement_transaction_id": transaction_id,
            "exchange_credit_amount": exchange_credit_amount,
            "settlement_request": settlement_request,
        }))
        .bind("Replacement transaction committed; exchange return settlement must complete before Z-close")
        .fetch_optional(&mut *tx)
        .await?;
        if recovery_job_key.is_none() {
            return Err(CheckoutError::InvalidPayload(
                "exchange recovery identity collides with a closed or unrelated recovery record"
                    .to_string(),
            ));
        }
    }

    let mut alteration_order_ids = Vec::new();
    let mut negative_stock_alerts: Vec<String> = Vec::new();
    let mut checkout_recovery_alerts: Vec<String> = Vec::new();

    if !is_completing_processing {
        let registered_shipment_id = if order_fulfillment_method == DbOrderFulfillmentMethod::Ship {
            Some(
                crate::logic::shipment::insert_from_pos_order_tx(
                    &mut tx,
                    transaction_id,
                    payload.customer_id,
                    payload.operator_staff_id,
                    ship_to_snapshot_for_registry,
                    order_shipping_amt,
                    pos_shippo_rate_object_id,
                )
                .await?,
            )
        } else {
            None
        };

        if !linked_shipping_targets.is_empty() {
            let link_amount = order_shipping_amt.unwrap_or(Decimal::ZERO);
            for (target_transaction_id, target_display_id) in &linked_shipping_targets {
                sqlx::query(
                    r#"
                    INSERT INTO pos_shipping_charge_links (
                        shipping_transaction_id,
                        target_transaction_id,
                        shipment_id,
                        amount_usd,
                        metadata
                    )
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (shipping_transaction_id, target_transaction_id)
                    DO UPDATE SET
                        shipment_id = EXCLUDED.shipment_id,
                        amount_usd = EXCLUDED.amount_usd,
                        metadata = EXCLUDED.metadata
                    "#,
                )
                .bind(transaction_id)
                .bind(*target_transaction_id)
                .bind(registered_shipment_id)
                .bind(link_amount)
                .bind(json!({
                    "target_display_id": target_display_id,
                    "source": "register_shipping_charge"
                }))
                .execute(&mut *tx)
                .await?;
            }
        }

        // Order-level default: lines with no explicit `salesperson_id` inherit `primary_salesperson_id`
        // for `transaction_lines.salesperson_id` and per-line commission snapshots.
        let primary_for_lines = payload.primary_salesperson_id;

        // Takeaway stock to deduct once per variant (multiple cart lines can reference the same variant).
        let mut layaway_stock_by_variant: HashMap<Uuid, i32> = HashMap::new();
        let mut takeaway_stock_by_variant: HashMap<Uuid, i32> = HashMap::new();

        let mut fulfillment_order_id: Option<Uuid> = None;
        let mut fulfillment_order_display_id: Option<String> = None;

        let needs_fulfillment = payload.items.iter().try_fold(false, |needs, item| {
            let fulfillment = persist_fulfillment(payload.wedding_member_id, item.fulfillment)
                .map_err(|m| CheckoutError::InvalidPayload(m.to_string()))?;
            Ok::<bool, CheckoutError>(needs || creates_fulfillment_order(fulfillment))
        })?;
        if needs_fulfillment {
            let wedding_party_id: Option<Uuid> = if let Some(member_id) = payload.wedding_member_id
            {
                sqlx::query_scalar("SELECT wedding_party_id FROM wedding_members WHERE id = $1")
                    .bind(member_id)
                    .fetch_optional(&mut *tx)
                    .await?
            } else {
                None
            };

            let row: (Uuid, String) = sqlx::query_as(
                r#"
                INSERT INTO fulfillment_orders (customer_id, wedding_id, status)
                VALUES ($1, $2, 'open')
                RETURNING id, display_id
                "#,
            )
            .bind(payload.customer_id)
            .bind(wedding_party_id)
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

            let (target_fulfillment_id, line_display_id, fulfilled_at) =
                if creates_fulfillment_order(fulfillment) {
                    fulfillment_line_counter += 1;
                    let parent_id =
                        fulfillment_order_display_id
                            .as_ref()
                            .cloned()
                            .ok_or_else(|| {
                                CheckoutError::InvalidPayload(
                                    "fulfillment order display missing for order line".to_string(),
                                )
                            })?;
                    let target_id = fulfillment_order_id.ok_or_else(|| {
                        CheckoutError::InvalidPayload(
                            "fulfillment order missing for order line".to_string(),
                        )
                    })?;
                    (
                        Some(target_id),
                        Some(format!("{parent_id}-{fulfillment_line_counter}")),
                        None,
                    )
                } else if !line_fulfilled {
                    (None, None, None)
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
            if let Some(reason) = override_reason {
                let receipt_label = if reason.eq_ignore_ascii_case(CUSTOMER_PROFILE_DISCOUNT_REASON)
                {
                    Some(CUSTOMER_PROFILE_DISCOUNT_RECEIPT_LABEL)
                } else if reason.eq_ignore_ascii_case(EMPLOYEE_DISCOUNT_REASON) {
                    Some(EMPLOYEE_DISCOUNT_REASON)
                } else {
                    None
                };
                if let Some(label) = receipt_label {
                    let mut base = override_meta.unwrap_or_else(|| json!({}));
                    if let serde_json::Value::Object(ref mut m) = base {
                        m.insert("discount_event_label".to_string(), json!(label));
                        if reason.eq_ignore_ascii_case(CUSTOMER_PROFILE_DISCOUNT_REASON) {
                            if let Some((source_customer_id, pct)) = customer_profile_discount {
                                m.insert(
                                    "profile_discount_customer_id".to_string(),
                                    json!(source_customer_id.to_string()),
                                );
                                m.insert("profile_discount_percent".to_string(), json!(pct));
                            }
                        }
                    }
                    override_meta = Some(base);
                }
            }
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

            let catalog_tax_cat =
                resolve_checkout_tax_category_tx(&mut tx, item.variant_id).await?;
            let logic_tax_cat = match item.tax_category_override {
                Some(
                    category @ (TaxCategory::Clothing
                    | TaxCategory::Footwear
                    | TaxCategory::Service
                    | TaxCategory::Other),
                ) => category,
                Some(TaxCategory::Accessory) => {
                    return Err(CheckoutError::InvalidPayload(
                        "tax_category_override may only be clothing, footwear, service, or other"
                            .to_string(),
                    ));
                }
                None => catalog_tax_cat,
            };

            let pos_kind = fetch_variant_pos_line_kind(&mut *tx, item.variant_id).await?;
            let is_shipping_charge = resolved_variants
                .get(&item.variant_id)
                .map(|resolved| checkout_validate::is_shipping_charge_sku(&resolved.sku))
                .unwrap_or(false);
            // Internal POS-only service/payment lines must remain non-taxable.
            let (state_tax, local_tax) = if matches!(
                pos_kind.as_deref(),
                Some("rms_charge_payment")
                    | Some("pos_gift_card_load")
                    | Some("staff_account_payment")
                    | Some("alteration_service")
            ) || is_shipping_charge
            {
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
            let line_is_internal = matches!(
                pos_kind.as_deref(),
                Some("rms_charge_payment") | Some("staff_account_payment")
            );
            if item.tax_category_override.is_some()
                && !matches!(
                    pos_kind.as_deref(),
                    Some("rms_charge_payment")
                        | Some("pos_gift_card_load")
                        | Some("staff_account_payment")
                        | Some("alteration_service")
                )
                && logic_tax_cat != catalog_tax_cat
            {
                let mut base = override_meta.unwrap_or_else(|| json!({}));
                if let Value::Object(ref mut map) = base {
                    map.insert(
                        "tax_category_override".to_string(),
                        json!({
                            "source": "register_sale_line",
                            "from": tax_category_audit_label(catalog_tax_cat),
                            "to": tax_category_audit_label(logic_tax_cat),
                        }),
                    );
                }
                override_meta = Some(base);
            }

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

            order_lifecycle::initialize_line_tx(
                &mut tx,
                transaction_line_id,
                initial_order_lifecycle_status(
                    fulfillment,
                    line_fulfilled,
                    item.order_lifecycle_status,
                )?,
                Some(payload.operator_staff_id),
                "checkout",
            )
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
                    event_id, transaction_id, order_item_id, variant_id, quantity,
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
                    gift_card_ops::GiftCardOpError::BadRequest(m) => {
                        CheckoutError::InvalidPayload(m)
                    }
                    gift_card_ops::GiftCardOpError::Db(d) => CheckoutError::Database(d),
                })?;
            }

            // Only decrement stock_on_hand for Takeaway (floor stock) lines.
            // Special / wedding lines are pending fulfillment: no checkout-time deduction;
            // inventory is adjusted when product is received / at pickup per ops flow.
            let skip_stock = matches!(
                pos_kind.as_deref(),
                Some("rms_charge_payment")
                    | Some("pos_gift_card_load")
                    | Some("staff_account_payment")
                    | Some("alteration_service")
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
            let alteration_line_client_id =
                trimmed_non_empty(Some(&intake.alteration_line_client_id)).ok_or_else(|| {
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
            let work_requested =
                trimmed_non_empty(Some(&intake.work_requested)).ok_or_else(|| {
                    CheckoutError::InvalidPayload(
                        "alteration intake requires work_requested".to_string(),
                    )
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
            let capacity_bucket = intake
                .capacity_bucket
                .as_deref()
                .map(str::trim)
                .filter(|bucket| matches!(*bucket, "jacket" | "pant" | "other"))
                .unwrap_or("other");
            let capacity_units = intake.capacity_units.unwrap_or(1).max(1);
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

            sqlx::query(
                r#"
            INSERT INTO alteration_order_items (alteration_order_id, label, capacity_bucket, units)
            VALUES ($1, $2, $3::alteration_bucket, $4)
            "#,
            )
            .bind(alteration_id)
            .bind(work_requested.as_str())
            .bind(capacity_bucket)
            .bind(capacity_units)
            .execute(&mut *tx)
            .await?;

            match capacity_bucket {
                "jacket" => {
                    sqlx::query(
                    "UPDATE alteration_orders SET total_units_jacket = total_units_jacket + $1 WHERE id = $2",
                )
                .bind(capacity_units)
                .bind(alteration_id)
                .execute(&mut *tx)
                .await?;
                }
                "pant" => {
                    sqlx::query(
                    "UPDATE alteration_orders SET total_units_pant = total_units_pant + $1 WHERE id = $2",
                )
                .bind(capacity_units)
                .bind(alteration_id)
                .execute(&mut *tx)
                .await?;
                }
                _ => {}
            }

            let detail = json!({
                "customer_id": payload.customer_id,
                "due_at": intake.due_at.as_ref().map(|d| d.to_rfc3339()),
                "notes_set": notes.is_some(),
                "linked_transaction_id": transaction_id,
                "source_type": source_type,
                "item_description": item_description,
                "work_requested": work_requested,
                "capacity_bucket": capacity_bucket,
                "capacity_units": capacity_units,
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
            if payload.wedding_member_id.is_some() {
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
            let after_row: Option<(i32, String)> = sqlx::query_as(
                r#"
            UPDATE product_variants
            SET stock_on_hand = stock_on_hand - $1
            WHERE id = $2
            RETURNING stock_on_hand, sku
            "#,
            )
            .bind(qty)
            .bind(variant_id)
            .fetch_optional(&mut *tx)
            .await?;

            if let Some((new_stock, sku)) = after_row {
                if new_stock < 0 {
                    let alert_msg = format!("Inventory Reconciliation Over-Allocation: SKU {sku} stock fell to {new_stock} after checkout");
                    negative_stock_alerts.push(alert_msg);
                    checkout_warnings.push(format!(
                        "{sku} stock went negative after sale (now {new_stock})"
                    ));
                }
                sqlx::query(
                    r#"
                INSERT INTO inventory_transactions (
                    variant_id, tx_type, quantity_delta, reference_table, reference_id, notes
                )
                VALUES ($1, 'sale', $2, 'transactions', $3, $4)
                "#,
                )
                .bind(variant_id)
                .bind(-qty)
                .bind(transaction_id)
                .bind(format!(
                    "Takeaway checkout stock decrement for transaction {transaction_id}"
                ))
                .execute(&mut *tx)
                .await?;
            } else {
                let alert_msg = format!(
                    "Inventory Reconciliation Required: checkout {transaction_display_id} could not decrement stock for variant {variant_id} by {qty}; sale completed and needs review"
                );
                checkout_recovery_alerts.push(alert_msg);
                checkout_warnings.push(
                    "Inventory reconciliation required — sale completed but one stock movement needs review."
                        .to_string(),
                );
                tracing::warn!(
                    variant_id = %variant_id,
                    qty,
                    "checkout: takeaway stock decrement skipped (no product_variants row — sale still completes)"
                );
            }
        }
    }

    let alteration_order_ids = if is_completing_processing {
        sqlx::query_scalar("SELECT id FROM alteration_orders WHERE transaction_id = $1")
            .bind(transaction_id)
            .fetch_all(&mut *tx)
            .await?
    } else {
        alteration_order_ids
    };

    if payload.is_processing {
        tx.commit().await?;
        weather::schedule_transaction_weather_snapshot(http.clone(), pool.clone(), transaction_id);
        return Ok(CheckoutDone::Completed {
            transaction_id,
            display_id: transaction_display_id,
            operator_staff_id: payload.operator_staff_id,
            customer_id: payload.customer_id,
            price_override_audit,
            alteration_order_ids,
            amount_paid: Decimal::ZERO,
            total_price: payload.total_price,
            warnings: checkout_warnings,
        });
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
        current_transaction_deposit_allocation,
        &order_payments,
        d_total,
    )?;
    let mut allocated_by_split = vec![Decimal::ZERO; payment_splits.len()];
    for allocation in &allocation_plan {
        if let Some(total) = allocated_by_split.get_mut(allocation.payment_split_index) {
            *total = (*total + allocation.amount).round_dp(2);
        }
    }
    let mut order_payment_targets_to_recalc: HashSet<Uuid> = HashSet::new();

    if !payload.amount_paid.is_zero() {
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

        let mut payment_tx_ids_by_split: Vec<Option<Uuid>> = vec![None; payment_splits.len()];

        for (split_index, split) in payment_splits.iter_mut().enumerate() {
            if split.amount.is_zero() {
                continue;
            }
            let method = split.method.trim();
            if pos_rms_charge::is_rms_method(method) || is_rms_payment_collection {
                apply_manual_rms_tracking_metadata(&mut split.metadata);
            }

            // 1. Store credit redemption
            if method.eq_ignore_ascii_case("store_credit") {
                let cid = payload.customer_id.ok_or_else(|| {
                    CheckoutError::InvalidPayload("customer_id required".to_string())
                })?;
                if split.amount > Decimal::ZERO {
                    store_credit::apply_checkout_redemption(
                        &mut tx,
                        cid,
                        split.amount,
                        transaction_id,
                    )
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
                } else if split.amount < Decimal::ZERO {
                    let balance_after = store_credit::credit_refund_in_tx(
                        &mut tx,
                        cid,
                        -split.amount,
                        transaction_id,
                        "checkout_store_credit_refund",
                    )
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
                    if let Some(metadata) = split.metadata.as_object_mut() {
                        metadata.insert(
                            "store_credit_balance_after".to_string(),
                            json!(balance_after.to_string()),
                        );
                    }
                }
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
                    metadata_object.insert(
                        "gift_card_balance_after".to_string(),
                        Value::String(redemption.new_balance.to_string()),
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

            if let Some(metadata) = split.metadata.as_object_mut() {
                metadata.insert(
                    "checkout_transaction_id".to_string(),
                    json!(transaction_id.to_string()),
                );
                metadata.insert(
                    "checkout_display_id".to_string(),
                    json!(transaction_display_id.clone()),
                );
                if is_rms_payment_collection {
                    metadata.insert("rms_charge_collection".to_string(), json!(true));
                }
                if is_staff_account_payment_collection {
                    metadata.insert("staff_account_collection".to_string(), json!(true));
                    metadata.insert("tender_family".to_string(), json!("staff_account"));
                }
            }

            // 3. Create the movement record (payment_transactions)
            let payment_tx_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO payment_transactions (
                    session_id, wedding_member_id, category, payment_method, amount, effective_date, metadata,
                    payment_provider, provider_payment_id, provider_status,
                    provider_terminal_id, provider_transaction_id, provider_auth_code,
                    provider_card_type, merchant_fee, net_amount, card_brand, card_last4,
                    check_number, created_at, occurred_at, payer_id
                )
                VALUES (
                    $1, $2, $3, $4, $5,
                    COALESCE($6::date, (CURRENT_TIMESTAMP AT TIME ZONE reporting.effective_store_timezone())::date),
                    $7, $8, $9, $10,
                    $11, $12, $13, $14, $15, $16, $17, $18, $19,
                    COALESCE($20, CURRENT_TIMESTAMP), COALESCE($20, CURRENT_TIMESTAMP), $21
                )
                RETURNING id
                "#,
            )
            .bind(payload.session_id)
            .bind(payload.wedding_member_id)
            .bind(payment_tx_category)
            .bind(method)
            .bind(split.amount)
            .bind(payment_effective_date(
                &method,
                split.payment_provider.as_deref(),
                checkout_business_date,
            ))
            .bind(&split.metadata)
            .bind(&split.payment_provider)
            .bind(&split.provider_payment_id)
            .bind(&split.provider_status)
            .bind(&split.provider_terminal_id)
            .bind(&split.provider_transaction_id)
            .bind(&split.provider_auth_code)
            .bind(&split.provider_card_type)
            .bind(split.merchant_fee)
            .bind(split.net_amount)
            .bind(&split.card_brand)
            .bind(&split.card_last4)
            .bind(&split.check_number)
            .bind(recovery.as_ref().map(|context| context.approved_at))
            .bind(payload.customer_id)
            .fetch_one(&mut *tx)
            .await?;

            if recovery
                .as_ref()
                .and_then(|context| context.payment_provider_attempt_id)
                .is_some()
                && split.payment_provider.as_deref() == Some("helcim")
            {
                let recovery_match_type = match recovery.as_ref().map(|context| &context.source) {
                    Some(CheckoutRecoverySource::ParkedSale { .. }) => "recovered_parked_sale",
                    Some(CheckoutRecoverySource::ExistingOrderPayment { .. }) => {
                        "recovered_order_payment"
                    }
                    Some(CheckoutRecoverySource::OfflineCheckout { .. }) => {
                        return Err(CheckoutError::InvalidPayload(
                            "offline checkout recovery cannot attach a Helcim recovery payment"
                                .to_string(),
                        ));
                    }
                    None => unreachable!("recovery context is required"),
                };
                let provider_transaction_id =
                    split.provider_transaction_id.as_deref().ok_or_else(|| {
                        CheckoutError::InvalidPayload(
                            "Recovered Helcim payment is missing its provider transaction ID"
                                .to_string(),
                        )
                    })?;
                let linked = sqlx::query(
                    r#"
                    UPDATE payment_provider_batch_transactions
                    SET payment_transaction_id = $1,
                        match_status = 'matched',
                        match_type = $3,
                        updated_at = now()
                    WHERE provider = 'helcim'
                      AND provider_transaction_id = $2
                      AND payment_transaction_id IS NULL
                    "#,
                )
                .bind(payment_tx_id)
                .bind(provider_transaction_id)
                .bind(recovery_match_type)
                .execute(&mut *tx)
                .await?
                .rows_affected();
                if linked != 1 {
                    return Err(CheckoutError::InvalidPayload(
                        "Helcim processor payment is missing or already linked".to_string(),
                    ));
                }
            }

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
                rms_notifications.push(pos_rms_charge::RmsChargeNotify {
                    payment_transaction_id: payment_tx_id,
                    amount: split.amount,
                    method: method.to_string(),
                    metadata: split.metadata.clone(),
                });
            }

            if method.eq_ignore_ascii_case("staff_account_charge") {
                let cid = payload.customer_id.ok_or_else(|| {
                    CheckoutError::InvalidPayload(
                        "Staff Account charge requires a linked staff customer".to_string(),
                    )
                })?;
                staff_accounts::record_charge_in_tx(
                    &mut tx,
                    cid,
                    split.amount,
                    transaction_id,
                    payment_tx_id,
                    payload.session_id,
                    payload.operator_staff_id,
                    Some(&split.metadata),
                )
                .await
                .map_err(|error| match error {
                    staff_accounts::StaffAccountError::Database(d) => CheckoutError::Database(d),
                    other => CheckoutError::InvalidPayload(other.to_string()),
                })?;
            } else if is_staff_account_payment_collection {
                let cid = payload.customer_id.ok_or_else(|| {
                    CheckoutError::InvalidPayload(
                        "Staff Account payment requires a linked staff customer".to_string(),
                    )
                })?;
                staff_accounts::record_payment_in_tx(
                    &mut tx,
                    cid,
                    split.amount,
                    transaction_id,
                    Some(payment_tx_id),
                    payload.session_id,
                    payload.operator_staff_id,
                    Some(&split.metadata),
                )
                .await
                .map_err(|error| match error {
                    staff_accounts::StaffAccountError::Database(d) => CheckoutError::Database(d),
                    other => CheckoutError::InvalidPayload(other.to_string()),
                })?;
            }

            if let Some(slot) = payment_tx_ids_by_split.get_mut(split_index) {
                *slot = Some(payment_tx_id);
            }

            for allocation in allocation_plan
                .iter()
                .filter(|allocation| allocation.payment_split_index == split_index)
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
                let mut disbursement_sources: Vec<(Uuid, Decimal)> = Vec::new();
                for (split_index, split) in payment_splits.iter().enumerate() {
                    let allocated = allocated_by_split
                        .get(split_index)
                        .copied()
                        .unwrap_or(Decimal::ZERO);
                    let remaining = (split.amount - allocated).round_dp(2);
                    if remaining <= Decimal::ZERO {
                        continue;
                    }
                    let payment_tx_id = payment_tx_ids_by_split
                        .get(split_index)
                        .and_then(|id| *id)
                        .ok_or_else(|| {
                            CheckoutError::InvalidPayload(
                                "party disbursement source payment was not recorded".to_string(),
                            )
                        })?;
                    disbursement_sources.push((payment_tx_id, remaining));
                }
                let source_total: Decimal = disbursement_sources
                    .iter()
                    .map(|(_, amount)| *amount)
                    .sum::<Decimal>()
                    .round_dp(2);
                if source_total != d_total {
                    return Err(CheckoutError::InvalidPayload(
                        "party disbursement sources do not match disbursement total".to_string(),
                    ));
                }
                let mut source_index = 0usize;

                let mut take_disbursement_sources =
                    |mut amount: Decimal| -> Result<Vec<(Uuid, Decimal)>, CheckoutError> {
                        let mut chunks = Vec::new();
                        amount = amount.round_dp(2);
                        while amount > Decimal::ZERO {
                            let Some((payment_tx_id, available)) =
                                disbursement_sources.get_mut(source_index)
                            else {
                                return Err(CheckoutError::InvalidPayload(
                                    "party disbursement source tender is insufficient".to_string(),
                                ));
                            };
                            if *available <= Decimal::ZERO {
                                source_index += 1;
                                continue;
                            }
                            let chunk = (*available).min(amount).round_dp(2);
                            chunks.push((*payment_tx_id, chunk));
                            *available = (*available - chunk).round_dp(2);
                            amount = (amount - chunk).round_dp(2);
                            if *available <= Decimal::ZERO {
                                source_index += 1;
                            }
                        }
                        Ok(chunks)
                    };

                for d in disbursements {
                    if d.amount <= Decimal::ZERO {
                        continue;
                    }

                    let bene_order: Option<(Uuid, Option<Uuid>, Decimal)> = sqlx::query_as(
                        r#"
                        SELECT o.id, wm.wedding_party_id, o.balance_due
                        FROM transactions o
                        JOIN wedding_members wm ON wm.id = o.wedding_member_id
                        WHERE wm.id = $1
                          AND o.status IN ('open', 'pending_measurement')
                          AND o.balance_due > 0
                        ORDER BY o.booked_at DESC
                        LIMIT 1
                        FOR UPDATE OF o
                        "#,
                    )
                    .bind(d.wedding_member_id)
                    .fetch_optional(&mut *tx)
                    .await?;

                    if let Some((bene_transaction_id, party_id, live_balance_due)) = bene_order {
                        validate_wedding_disbursement_against_balance(d.amount, live_balance_due)?;
                        for (source_payment_tx_id, amount) in take_disbursement_sources(d.amount)? {
                            sqlx::query(
                                r#"
                                INSERT INTO payment_allocations (
                                    transaction_id, target_transaction_id, amount_allocated, metadata
                                )
                                VALUES ($1, $2, $3, $4)
                                "#,
                            )
                            .bind(source_payment_tx_id)
                            .bind(bene_transaction_id)
                            .bind(amount)
                            .bind(json!({
                                "kind": "wedding_group_disbursement",
                                "payer_member_id": payload.wedding_member_id,
                                "wedding_member_id": d.wedding_member_id,
                                "applied_deposit_amount": amount.to_string()
                            }))
                            .execute(&mut *tx)
                            .await?;
                        }

                        sqlx::query(
                            "UPDATE transactions SET amount_paid = amount_paid + $1 WHERE id = $2",
                        )
                        .bind(d.amount)
                        .bind(bene_transaction_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(CheckoutError::Database)?;

                        transaction_recalc::recalc_transaction_totals(&mut tx, bene_transaction_id)
                            .await
                            .map_err(CheckoutError::Database)?;

                        if let Some(pid) = party_id {
                            let actor = payload.actor_name.as_deref().unwrap_or("Riverside POS");
                            let desc = format!(
                                "Received disbursement payment of ${} from party group.",
                                d.amount
                            );
                            deferred_wedding_activities.push(DeferredWeddingActivity {
                                party_id: pid,
                                member_id: Some(d.wedding_member_id),
                                actor: actor.to_string(),
                                description: desc,
                                metadata: json!({
                                    "source_payer_id": payload.wedding_member_id,
                                    "target_transaction_id": bene_transaction_id,
                                    "amount": d.amount
                                }),
                            });
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
                            let source_chunks = take_disbursement_sources(d.amount)?;
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
                            let source_chunks: Vec<customer_open_deposit::OpenDepositSourceChunk> =
                                source_chunks
                                    .into_iter()
                                    .map(|(source_payment_transaction_id, amount)| {
                                        customer_open_deposit::OpenDepositSourceChunk {
                                            source_payment_transaction_id,
                                            amount,
                                        }
                                    })
                                    .collect();
                            customer_open_deposit::credit_party_split_with_sources(
                                &mut tx,
                                bene_customer_id,
                                d.amount,
                                payload.customer_id,
                                payer_trim,
                                bene_party_id,
                                transaction_id,
                                &source_chunks,
                                payload.wedding_member_id,
                                Some(d.wedding_member_id),
                            )
                            .await
                            .map(|_| ())
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
                            return Err(CheckoutError::InvalidPayload(
                                "wedding disbursement target member was not found".to_string(),
                            ));
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
                deferred_wedding_activities.push(DeferredWeddingActivity {
                    party_id,
                    member_id: Some(member_id),
                    actor: actor.to_string(),
                    description: desc,
                    metadata: json!({
                        "transaction_id": transaction_id,
                        "amount_paid": payload.amount_paid,
                        "payment_method": payment_activity_label,
                        "balance_due": balance_due,
                    }),
                });
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

    if let Some(context) = recovery.as_ref() {
        let mut recovery_metadata = json!({
            "transaction_id": transaction_id,
            "transaction_display_id": transaction_display_id,
            "payment_provider_attempt_id": context.payment_provider_attempt_id,
            "approved_at": context.approved_at,
            "original_operator_staff_id": payload.operator_staff_id,
            "authorized_by_staff_id": context.authorized_by_staff_id,
            "register_session_was_closed": !session_is_open,
            "note": context.note,
        });
        match &context.source {
            CheckoutRecoverySource::ParkedSale { parked_sale_id } => {
                let parked_updated = sqlx::query(
                    r#"
                    UPDATE pos_parked_sale
                    SET status = 'recalled',
                        recalled_at = COALESCE(recalled_at, now()),
                        recalled_by_staff_id = $2,
                        updated_at = now()
                    WHERE id = $1
                      AND register_session_id = $3
                      AND status IN ('parked', 'deleted')
                    "#,
                )
                .bind(parked_sale_id)
                .bind(context.authorized_by_staff_id)
                .bind(payload.session_id)
                .execute(&mut *tx)
                .await?
                .rows_affected();
                if parked_updated != 1 {
                    return Err(CheckoutError::InvalidPayload(
                        "Parked sale is no longer available for recovery".to_string(),
                    ));
                }

                recovery_metadata["recovery_kind"] = json!("parked_sale");
                recovery_metadata["parked_sale_id"] = json!(parked_sale_id);
                sqlx::query(
                    r#"
                    INSERT INTO pos_parked_sale_audit (
                        register_session_id, parked_sale_id, action, actor_staff_id, metadata
                    )
                    VALUES ($1, $2, 'recover_to_transaction', $3, $4)
                    "#,
                )
                .bind(payload.session_id)
                .bind(parked_sale_id)
                .bind(context.authorized_by_staff_id)
                .bind(&recovery_metadata)
                .execute(&mut *tx)
                .await?;
            }
            CheckoutRecoverySource::ExistingOrderPayment {
                target_transaction_id,
                target_display_id,
            } => {
                recovery_metadata["recovery_kind"] = json!("existing_order_payment");
                recovery_metadata["target_transaction_id"] = json!(target_transaction_id);
                recovery_metadata["target_display_id"] = json!(target_display_id);
                sqlx::query(
                    r#"
                    INSERT INTO transaction_activity_log (
                        transaction_id, customer_id, event_kind, summary, metadata
                    )
                    VALUES ($1, $2, 'payment_recovered', $3, $4)
                    "#,
                )
                .bind(target_transaction_id)
                .bind(payload.customer_id)
                .bind(format!(
                    "Recovered approved Helcim payment of ${:.2}",
                    payload.amount_paid
                ))
                .bind(&recovery_metadata)
                .execute(&mut *tx)
                .await?;
            }
            CheckoutRecoverySource::OfflineCheckout {
                recovery_client_job_key,
            } => {
                recovery_metadata["recovery_kind"] = json!("offline_checkout");
                recovery_metadata["recovery_client_job_key"] = json!(recovery_client_job_key);
                sqlx::query(
                    r#"
                    INSERT INTO transaction_activity_log (
                        transaction_id, customer_id, event_kind, summary, metadata
                    )
                    VALUES ($1, $2, 'checkout_recovered', $3, $4)
                    "#,
                )
                .bind(transaction_id)
                .bind(payload.customer_id)
                .bind("Manager recovered an unacknowledged Register checkout")
                .bind(&recovery_metadata)
                .execute(&mut *tx)
                .await?;
            }
        }

        if let Some(payment_provider_attempt_id) = context.payment_provider_attempt_id {
            sqlx::query(
                r#"
                INSERT INTO helcim_terminal_recovery_actions (
                    source_kind, source_id, action, note, actor_staff_id, metadata
                )
                VALUES (
                    'payment_provider_attempt', $1, 'recovered_transaction', $2, $3, $4
                )
                "#,
            )
            .bind(payment_provider_attempt_id)
            .bind(&context.note)
            .bind(context.authorized_by_staff_id)
            .bind(recovery_metadata)
            .execute(&mut *tx)
            .await?;
        }
    }

    let operator_staff_id = payload.operator_staff_id;
    let customer_id = payload.customer_id;
    let amount_paid = amount_toward_order;
    let total_price = payload.total_price;
    let session_id_for_log = payload.session_id;

    operational_outbox::enqueue_checkout_post_commit(
        &mut tx,
        &operational_outbox::CheckoutPostCommitPayload {
            transaction_id,
            transaction_display_id: transaction_display_id.clone(),
            operator_staff_id,
            customer_id,
            customer_display_rms,
            order_short_ref,
            register_session_id: session_id_for_log,
            amount_paid,
            total_price,
            price_override_audit: price_override_audit.clone(),
            payment_activity_label,
            is_rms_payment_collection,
            has_rms_charge,
            transaction_financing_metadata,
            negative_stock_alerts,
            checkout_recovery_alerts,
            wedding_activities: deferred_wedding_activities,
            rms_notifications,
        },
    )
    .await?;

    let commit_started = Instant::now();
    tx.commit().await?;
    crate::logic::operation_metrics::record_phase(
        pool.clone(),
        "checkout",
        "database_commit",
        commit_started.elapsed(),
        true,
        Some(transaction_id),
        Some(session_id_for_log),
        json!({}),
    );
    crate::logic::operation_metrics::record_phase(
        pool.clone(),
        "checkout",
        "total",
        checkout_started.elapsed(),
        true,
        Some(transaction_id),
        Some(session_id_for_log),
        json!({}),
    );

    if let Some(backdated_business_date) = checkout_business_date {
        let qbo_pool = pool.clone();
        tokio::spawn(async move {
            if let Err(error) = crate::logic::qbo_journal::ensure_pending_daily_journal(
                &qbo_pool,
                backdated_business_date,
            )
            .await
            {
                tracing::error!(
                    %error,
                    %backdated_business_date,
                    "QBO backdated business-day revision staging failed after checkout"
                );
            }
        });
    }

    weather::schedule_transaction_weather_snapshot(http.clone(), pool.clone(), transaction_id);

    Ok(CheckoutDone::Completed {
        transaction_id,
        display_id: transaction_display_id,
        operator_staff_id,
        customer_id,
        price_override_audit,
        alteration_order_ids,
        amount_paid,
        total_price,
        warnings: checkout_warnings,
    })
}

#[inline]
fn checkout_total_matches(client_total: Decimal, server_total: Decimal) -> bool {
    client_total.round_dp(2) == server_total.round_dp(2)
}

#[derive(Debug, Serialize)]
pub struct ComboSpiffReward {
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub reward_amount: Decimal,
    pub label: String,
}

fn parse_combo_reward_amount(rule_json: &Value) -> Result<Decimal, CheckoutError> {
    let raw = rule_json
        .get("reward_amount")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CheckoutError::InvalidPayload(
                "combo incentive reward_amount must be a decimal string".to_string(),
            )
        })?;

    raw.parse::<Decimal>().map_err(|_| {
        CheckoutError::InvalidPayload("combo incentive reward_amount is invalid".to_string())
    })
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
            'reward_amount', r.reward_amount::text,
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
    let mut variant_counts: HashMap<Uuid, i32> = HashMap::new();
    // Cache categories to avoid re-querying in inner loops
    let mut item_cat_map: HashMap<Uuid, Uuid> = HashMap::new();

    for item in items {
        *prod_counts.entry(item.product_id).or_default() += item.quantity;
        *variant_counts.entry(item.variant_id).or_default() += item.quantity;
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
        let reward_amount = parse_combo_reward_amount(&rule_json)?;
        if reward_amount <= Decimal::ZERO {
            return Err(CheckoutError::InvalidPayload(
                "combo incentive reward_amount must be greater than zero".to_string(),
            ));
        }
        let label = rule_json["label"].as_str().unwrap_or("SPIFF").to_string();
        let requirements = rule_json["items"].as_array();

        if let Some(reqs) = requirements {
            if reqs.is_empty() {
                return Err(CheckoutError::InvalidPayload(
                    "combo incentive requires at least one requirement".to_string(),
                ));
            }
            loop {
                let mut satisfied = true;
                for req in reqs {
                    let m_type = req["match_type"].as_str().unwrap_or("");
                    if !matches!(m_type, "category" | "product" | "variant") {
                        return Err(CheckoutError::InvalidPayload(
                            "combo incentive requirement target must be category, product, or variant"
                                .to_string(),
                        ));
                    }
                    let m_id =
                        Uuid::parse_str(req["match_id"].as_str().unwrap_or("")).map_err(|_| {
                            CheckoutError::InvalidPayload(
                                "combo incentive requirement target is invalid".to_string(),
                            )
                        })?;
                    let qty_req = req["qty_required"].as_i64().unwrap_or(1) as i32;
                    if qty_req <= 0 {
                        return Err(CheckoutError::InvalidPayload(
                            "combo incentive requirement quantity must be greater than zero"
                                .to_string(),
                        ));
                    }

                    let available = match m_type {
                        "product" => prod_counts.get(&m_id).copied().unwrap_or(0),
                        "variant" => variant_counts.get(&m_id).copied().unwrap_or(0),
                        _ => cat_counts.get(&m_id).copied().unwrap_or(0),
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
                            let m_id = match Uuid::parse_str(req["match_id"].as_str().unwrap_or(""))
                            {
                                Ok(id) => id,
                                Err(_) => return None,
                            };
                            match m_type {
                                "product" => items
                                    .iter()
                                    .find(|item| item.product_id == m_id)
                                    .map(|item| (item.product_id, item.variant_id)),
                                "variant" => items
                                    .iter()
                                    .find(|item| item.variant_id == m_id)
                                    .map(|item| (item.product_id, item.variant_id)),
                                _ => items
                                    .iter()
                                    .find(|item| item_cat_map.get(&item.product_id) == Some(&m_id))
                                    .map(|item| (item.product_id, item.variant_id)),
                            }
                        })
                        .or_else(|| items.first().map(|item| (item.product_id, item.variant_id)));

                    // Consume quantities
                    for req in reqs {
                        let m_type = req["match_type"].as_str().unwrap_or("");
                        let m_id = Uuid::parse_str(req["match_id"].as_str().unwrap_or(""))
                            .map_err(|_| {
                                CheckoutError::InvalidPayload(
                                    "combo incentive requirement target is invalid".to_string(),
                                )
                            })?;
                        let qty_req = req["qty_required"].as_i64().unwrap_or(1) as i32;

                        match m_type {
                            "product" => prod_counts.entry(m_id).and_modify(|q| *q -= qty_req),
                            "variant" => variant_counts.entry(m_id).and_modify(|q| *q -= qty_req),
                            _ => cat_counts.entry(m_id).and_modify(|q| *q -= qty_req),
                        };
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
        } else {
            return Err(CheckoutError::InvalidPayload(
                "combo incentive requires at least one requirement".to_string(),
            ));
        }
    }

    Ok(rewards)
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
        build_payment_allocation_plan, canonical_helcim_ledger_transaction_id,
        checkout_processing_intent_fingerprint, checkout_request_fingerprints,
        checkout_total_matches, evaluate_combo_incentives, exact_order_payment_helcim_replay_shape,
        execute_checkout, fetch_variant_pos_line_kind, helcim_attempt_comparison_cents,
        helcim_checkout_references, helcim_tender_method_matches_amount,
        is_fee_only_shipping_quote, parse_combo_reward_amount, payment_effective_date,
        resolve_payment_splits, strip_sensitive_checkout_request, strip_sensitive_payment_metadata,
        validate_checkout_alteration_intakes, validate_checkout_item_quantity,
        validate_checkout_replay_fingerprints, validate_exchange_checkout_intent,
        validate_helcim_attempt_checkout_binding, validate_open_deposit_scope,
        validate_order_payment_against_target, validate_order_payment_shape,
        validate_processing_intent_fingerprint, validate_wedding_disbursement_against_balance,
        CheckoutAlterationIntake, CheckoutDone, CheckoutItem, CheckoutOrderPayment,
        CheckoutPaymentSplit, CheckoutRequest, ExistingOrderPaymentTarget, ResolvedOrderPayment,
        ResolvedPaymentSplit, WeddingDisbursement,
    };
    use crate::logic::customer_open_deposit;
    use crate::logic::customers::{insert_customer, CustomerCreatedSource, InsertCustomerParams};
    use crate::logic::qbo_journal;
    use crate::models::{DbFulfillmentType, DbOrderStatus};
    use chrono::NaiveDate;
    use rust_decimal::Decimal;
    use rust_decimal_macros::dec;
    use serde_json::{json, Value};
    use sqlx::{Connection, PgPool};
    use std::sync::Arc;
    use tokio::sync::Mutex;
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
            tax_category_override: None,
            salesperson_id: None,
            discount_event_id: None,
            gift_card_load_code: None,
            custom_item_type: None,
            custom_order_details: None,
            is_rush: false,
            need_by_date: None,
            needs_gift_wrap: false,
            order_lifecycle_status: None,
        }
    }

    fn checkout_request_for_split_validation(
        total_price: Decimal,
        amount_paid: Decimal,
        splits: Vec<CheckoutPaymentSplit>,
    ) -> CheckoutRequest {
        CheckoutRequest {
            session_id: Uuid::new_v4(),
            operator_staff_id: Uuid::new_v4(),
            primary_salesperson_id: None,
            customer_id: None,
            wedding_member_id: None,
            payment_method: "split".to_string(),
            total_price,
            amount_paid,
            items: vec![checkout_item_with_client_line(None)],
            alteration_intakes: vec![],
            actor_name: None,
            payment_splits: Some(splits),
            wedding_disbursements: None,
            order_payments: vec![],
            below_cost_approval: None,
            checkout_client_id: None,
            shipping_rate_quote_id: None,
            shipping_links: vec![],
            fulfillment_mode: None,
            ship_to: None,
            target_transaction_id: None,
            booked_at_local: None,
            backdate_approval: None,
            is_rush: false,
            need_by_date: None,
            is_tax_exempt: false,
            tax_exempt_reason: None,
            rounding_adjustment: None,
            final_cash_due: None,
            is_processing: false,
            exchange_settlement: None,
        }
    }

    fn cash_split(amount: Decimal) -> CheckoutPaymentSplit {
        CheckoutPaymentSplit {
            payment_method: "cash".to_string(),
            amount,
            sub_type: None,
            applied_deposit_amount: None,
            gift_card_code: None,
            check_number: None,
            metadata: None,
        }
    }

    fn donation_split(amount: Decimal, note: Option<&str>) -> CheckoutPaymentSplit {
        CheckoutPaymentSplit {
            payment_method: "donation".to_string(),
            amount,
            sub_type: None,
            applied_deposit_amount: None,
            gift_card_code: None,
            check_number: None,
            metadata: note.map(|value| json!({ "donation_note": value })),
        }
    }

    fn store_credit_split(amount: Decimal) -> CheckoutPaymentSplit {
        CheckoutPaymentSplit {
            payment_method: "store_credit".to_string(),
            amount,
            sub_type: None,
            applied_deposit_amount: None,
            gift_card_code: None,
            check_number: None,
            metadata: None,
        }
    }

    #[test]
    fn checkout_replay_requires_exact_session_request_and_payment_fingerprints() {
        let mut payload = checkout_request_for_split_validation(
            dec!(100.00),
            dec!(100.00),
            vec![cash_split(dec!(100.00))],
        );
        payload.checkout_client_id = Some(Uuid::new_v4());

        let (request_fingerprint, payment_fingerprint) =
            checkout_request_fingerprints(&payload).expect("fingerprint checkout");
        let repeated = checkout_request_fingerprints(&payload).expect("repeat fingerprint");
        assert_eq!(
            (request_fingerprint.clone(), payment_fingerprint.clone()),
            repeated
        );
        assert_eq!(request_fingerprint.len(), 64);
        assert_eq!(payment_fingerprint.len(), 64);
        validate_checkout_replay_fingerprints(
            &payload,
            Some(payload.session_id),
            Some(&request_fingerprint),
            Some(&payment_fingerprint),
            &request_fingerprint,
            &payment_fingerprint,
        )
        .expect("exact checkout replay");

        payload.payment_splits.as_mut().expect("payment splits")[0].metadata =
            Some(json!({ "provider_transaction_id": "changed-reference" }));
        let (changed_request, changed_payment) =
            checkout_request_fingerprints(&payload).expect("changed fingerprint");
        assert_ne!(request_fingerprint, changed_request);
        assert_ne!(payment_fingerprint, changed_payment);
        let error = validate_checkout_replay_fingerprints(
            &payload,
            Some(payload.session_id),
            Some(&request_fingerprint),
            Some(&payment_fingerprint),
            &changed_request,
            &changed_payment,
        )
        .expect_err("changed checkout replay must fail");
        assert!(error
            .to_string()
            .contains("different sale or payment details"));

        let error = validate_checkout_replay_fingerprints(
            &payload,
            Some(Uuid::new_v4()),
            Some(&changed_request),
            Some(&changed_payment),
            &changed_request,
            &changed_payment,
        )
        .expect_err("cross-session replay must fail");
        assert!(error.to_string().contains("different register session"));
    }

    #[test]
    fn processing_completion_keeps_immutable_intent_but_rejects_sale_changes() {
        let mut initial = checkout_request_for_split_validation(
            dec!(100.00),
            Decimal::ZERO,
            vec![cash_split(Decimal::ZERO)],
        );
        initial.checkout_client_id = Some(Uuid::new_v4());
        initial.is_processing = true;
        let stored = checkout_processing_intent_fingerprint(&initial).expect("initial intent");

        let mut completion: CheckoutRequest =
            serde_json::from_value(serde_json::to_value(&initial).expect("serialize checkout"))
                .expect("clone checkout");
        completion.is_processing = false;
        completion.amount_paid = dec!(100.00);
        completion.payment_splits = Some(vec![cash_split(dec!(100.00))]);
        let completing =
            checkout_processing_intent_fingerprint(&completion).expect("completion intent");
        assert_eq!(stored, completing);
        validate_processing_intent_fingerprint(
            &completion,
            Some(initial.session_id),
            Some(&stored),
            &completing,
        )
        .expect("stable processing completion");

        completion.total_price = dec!(101.00);
        let changed_total =
            checkout_processing_intent_fingerprint(&completion).expect("changed total intent");
        assert!(validate_processing_intent_fingerprint(
            &completion,
            Some(initial.session_id),
            Some(&stored),
            &changed_total,
        )
        .is_err());

        completion.total_price = dec!(100.00);
        completion.items[0].quantity = 2;
        let changed_items =
            checkout_processing_intent_fingerprint(&completion).expect("changed items intent");
        assert!(validate_processing_intent_fingerprint(
            &completion,
            Some(initial.session_id),
            Some(&stored),
            &changed_items,
        )
        .is_err());
    }

    #[test]
    fn checkout_transaction_locks_register_session_before_processing_identity_reread() {
        let source = include_str!("transaction_checkout.rs");
        let transaction_scope = source
            .split_once("let mut tx = pool.begin().await?;")
            .expect("checkout transaction boundary")
            .1;
        let session_lock = transaction_scope
            .find("FROM register_sessions\n        WHERE id = $1\n        FOR UPDATE")
            .expect("Register session row lock");
        let recovery_override = transaction_scope
            .find("context.allow_closed_session")
            .expect("recovery closed-session policy");
        let checkout_advisory_lock = transaction_scope
            .find("helcim:checkout:{checkout_client_id}")
            .expect("cross-Register Helcim checkout advisory lock");
        let helcim_recheck = transaction_scope
            .find("reject_unattached_helcim_attempt(\n            &mut *tx")
            .expect("in-transaction Helcim outcome recheck");
        let checkout_identity_reread = transaction_scope
            .find("FROM transactions\n            WHERE checkout_client_id = $1")
            .expect("in-transaction checkout identity re-read");

        assert!(
            session_lock < recovery_override
                && recovery_override < checkout_advisory_lock
                && checkout_advisory_lock < helcim_recheck
                && helcim_recheck < checkout_identity_reread,
            "Register session lock and lifecycle validation must precede the checkout advisory lock, Helcim outcome recheck, and checkout identity re-read"
        );
    }

    #[test]
    fn checkout_helcim_guard_covers_cross_register_identity_and_return_movements() {
        let source = include_str!("transaction_checkout.rs");
        let guard = source
            .split_once("async fn reject_unattached_helcim_attempt")
            .expect("Helcim checkout guard")
            .1
            .split_once("fn validate_helcim_attempt_checkout_binding")
            .expect("end of Helcim checkout guard")
            .0;

        assert!(guard.contains("ppa.checkout_client_id = $2"));
        assert!(!guard.contains("ppa.register_session_id ="));
        assert!(guard.contains("pt.status IN ('success', 'approved', 'captured')"));
        assert!(guard.contains("pt.metadata->>'provider_attempt_id'"));
        assert!(guard.contains("NOT LIKE '%refund%'"));
        assert!(guard.contains("ppa.checkout_client_id IS NULL"));
    }

    #[test]
    fn checkout_fingerprints_never_include_sensitive_pin_metadata() {
        let mut first = checkout_request_for_split_validation(
            dec!(100.00),
            dec!(100.00),
            vec![cash_split(dec!(100.00))],
        );
        first.payment_splits.as_mut().expect("splits")[0].metadata = Some(json!({
            "manager_pin": "1234",
            "x-riverside-staff-pin": "1234",
            "encoded_approval": r#"{"accessPin":"1234","reason":"approved"}"#,
            "manager_staff_id": Uuid::nil()
        }));
        first.exchange_settlement = Some(json!({
            "manager_pin": "1234",
            "x-riverside-staff-pin": "1234",
            "reason": "safe"
        }));
        let mut second: CheckoutRequest =
            serde_json::from_value(serde_json::to_value(&first).expect("serialize checkout"))
                .expect("clone checkout");
        second.payment_splits.as_mut().expect("splits")[0].metadata = Some(json!({
            "manager_pin": "9876",
            "x-riverside-staff-pin": "9876",
            "encoded_approval": r#"{"accessPin":"9876","reason":"approved"}"#,
            "manager_staff_id": Uuid::nil()
        }));
        second.exchange_settlement = Some(json!({
            "manager_pin": "9876",
            "x-riverside-staff-pin": "9876",
            "reason": "safe"
        }));

        assert_eq!(
            checkout_request_fingerprints(&first).expect("first fingerprint"),
            checkout_request_fingerprints(&second).expect("second fingerprint")
        );
        strip_sensitive_checkout_request(&mut first);
        assert!(first.payment_splits.as_ref().expect("splits")[0]
            .metadata
            .as_ref()
            .expect("metadata")
            .get("manager_pin")
            .is_none());
        assert!(first.payment_splits.as_ref().expect("splits")[0]
            .metadata
            .as_ref()
            .expect("metadata")
            .get("x-riverside-staff-pin")
            .is_none());
        assert_eq!(first.exchange_settlement, Some(json!({ "reason": "safe" })));
    }

    #[test]
    fn exchange_replacement_intent_must_match_exchange_credit_tender() {
        let original_transaction_id = Uuid::new_v4();
        let mut exchange_credit = cash_split(dec!(40.00));
        exchange_credit.payment_method = "exchange_credit".to_string();
        exchange_credit.metadata = Some(json!({
            "original_transaction_id": original_transaction_id,
        }));
        let mut payload = checkout_request_for_split_validation(
            dec!(100.00),
            dec!(100.00),
            vec![exchange_credit, cash_split(dec!(60.00))],
        );
        payload.checkout_client_id = Some(Uuid::new_v4());
        payload.exchange_settlement = Some(json!({
            "original_transaction_id": original_transaction_id,
            "exchange_credit_amount": "40.00",
        }));
        let (splits, _) = resolve_payment_splits(&payload).expect("resolve exchange tenders");

        assert_eq!(
            validate_exchange_checkout_intent(&payload, &splits).expect("matching exchange intent"),
            Some((original_transaction_id, dec!(40.00)))
        );

        payload.exchange_settlement = Some(json!({
            "original_transaction_id": original_transaction_id,
            "exchange_credit_amount": "39.99",
        }));
        let error = validate_exchange_checkout_intent(&payload, &splits)
            .expect_err("mismatched exchange credit must fail");
        assert!(error
            .to_string()
            .contains("does not match the replacement sale exchange-credit tender"));

        payload.exchange_settlement = None;
        let error = validate_exchange_checkout_intent(&payload, &splits)
            .expect_err("unbound exchange credit must fail");
        assert!(error
            .to_string()
            .contains("requires a matching exchange settlement intent"));
    }

    #[test]
    fn sensitive_pin_fields_are_removed_from_payment_metadata() {
        let unchanged_encoded = r#"{ "reason": "keeps original formatting" }"#;
        let mut metadata = json!({
            "manager_pin": "1234",
            "manager_staff_id": Uuid::new_v4(),
            "nested": { "accessPin": "9999", "reason": "approved" },
            "items": [{ "pin": "0000", "x-riverside-staff-pin": "1111", "reference": "safe" }],
            "encoded_object": r#"{"manager_pin":"2222","reason":"approved"}"#,
            "encoded_array": r#"[{"accessPin":"3333","reference":"safe"}]"#,
            "encoded_nested": r#"{"payload":"{\"x-riverside-staff-pin\":\"4444\",\"reference\":\"safe\"}"}"#,
            "unchanged_encoded": unchanged_encoded,
            "encoded_scalar": "1234",
        });
        strip_sensitive_payment_metadata(&mut metadata);

        assert!(metadata.get("manager_pin").is_none());
        assert!(metadata["nested"].get("accessPin").is_none());
        assert!(metadata["items"][0].get("pin").is_none());
        assert!(metadata["items"][0].get("x-riverside-staff-pin").is_none());
        assert!(metadata.get("manager_staff_id").is_some());
        assert_eq!(metadata["nested"]["reason"], "approved");
        let encoded_object: Value = serde_json::from_str(
            metadata["encoded_object"]
                .as_str()
                .expect("encoded object remains a JSON string"),
        )
        .expect("decode scrubbed object");
        assert!(encoded_object.get("manager_pin").is_none());
        assert_eq!(encoded_object["reason"], "approved");
        let encoded_array: Value = serde_json::from_str(
            metadata["encoded_array"]
                .as_str()
                .expect("encoded array remains a JSON string"),
        )
        .expect("decode scrubbed array");
        assert!(encoded_array[0].get("accessPin").is_none());
        assert_eq!(encoded_array[0]["reference"], "safe");
        let encoded_nested: Value = serde_json::from_str(
            metadata["encoded_nested"]
                .as_str()
                .expect("encoded nested object remains a JSON string"),
        )
        .expect("decode scrubbed nested object");
        let nested_payload: Value = serde_json::from_str(
            encoded_nested["payload"]
                .as_str()
                .expect("nested payload remains a JSON string"),
        )
        .expect("decode scrubbed nested payload");
        assert!(nested_payload.get("x-riverside-staff-pin").is_none());
        assert_eq!(nested_payload["reference"], "safe");
        assert_eq!(metadata["unchanged_encoded"], unchanged_encoded);
        assert_eq!(metadata["encoded_scalar"], "1234");
    }

    #[test]
    fn backdated_card_payment_keeps_actual_provider_date() {
        let business_date = NaiveDate::from_ymd_opt(2026, 7, 1);
        assert_eq!(
            payment_effective_date("card_not_present", Some("helcim"), business_date),
            None
        );
        assert_eq!(
            payment_effective_date("manual_card", None, business_date),
            None
        );
    }

    #[test]
    fn backdated_internal_payment_keeps_actual_processing_date() {
        let business_date = NaiveDate::from_ymd_opt(2026, 7, 1);
        assert_eq!(payment_effective_date("cash", None, business_date), None);
        assert_eq!(payment_effective_date("check", None, business_date), None);
    }

    #[test]
    fn checkout_quantity_allows_negative_takeaway_retail_line() {
        let mut item = checkout_item_with_client_line(None);
        item.quantity = -1;

        validate_checkout_item_quantity(&item).unwrap();
    }

    #[test]
    fn checkout_total_requires_exact_cent_parity() {
        assert!(checkout_total_matches(dec!(108.75), dec!(108.75)));
        assert!(!checkout_total_matches(dec!(108.74), dec!(108.75)));
        assert!(!checkout_total_matches(dec!(108.76), dec!(108.75)));
    }

    #[test]
    fn shipping_fee_quote_requires_explicit_fee_only_marker() {
        assert!(is_fee_only_shipping_quote(&json!({ "fee_only": true })));
        assert!(!is_fee_only_shipping_quote(&json!({ "fee_only": false })));
        assert!(!is_fee_only_shipping_quote(&json!({ "manual": true })));
    }

    #[test]
    fn checkout_splits_allow_negative_cash_for_refund_checkout() {
        let payload = checkout_request_for_split_validation(
            Decimal::new(-7125, 2),
            Decimal::new(-7125, 2),
            vec![cash_split(Decimal::new(-7125, 2))],
        );

        let (splits, label) = resolve_payment_splits(&payload).unwrap();

        assert_eq!(splits[0].amount, Decimal::new(-7125, 2));
        assert_eq!(label, "cash");
    }

    #[test]
    fn checkout_splits_allow_negative_store_credit_for_refund_checkout() {
        let payload = checkout_request_for_split_validation(
            Decimal::new(-7125, 2),
            Decimal::new(-7125, 2),
            vec![store_credit_split(Decimal::new(-7125, 2))],
        );

        let (splits, label) = resolve_payment_splits(&payload).unwrap();

        assert_eq!(splits[0].amount, Decimal::new(-7125, 2));
        assert_eq!(label, "store_credit");
    }

    #[test]
    fn checkout_splits_reject_negative_cash_on_positive_sale() {
        let payload = checkout_request_for_split_validation(
            Decimal::new(7125, 2),
            Decimal::new(-7125, 2),
            vec![cash_split(Decimal::new(-7125, 2))],
        );

        let err = resolve_payment_splits(&payload).unwrap_err();

        assert!(err
            .to_string()
            .contains("negative split amounts are only allowed for customer refunds"));
    }

    #[test]
    fn checkout_splits_preserve_valid_cash_tendered_and_change() {
        let mut split = cash_split(Decimal::new(5000, 2));
        split.metadata = Some(json!({
            "cash_tendered_cents": 10000,
            "change_due_cents": 5000
        }));
        let payload = checkout_request_for_split_validation(
            Decimal::new(5000, 2),
            Decimal::new(5000, 2),
            vec![split],
        );

        let (splits, _) = resolve_payment_splits(&payload).unwrap();

        assert_eq!(splits[0].metadata["cash_tendered_cents"], json!(10000));
        assert_eq!(splits[0].metadata["change_due_cents"], json!(5000));
    }

    #[test]
    fn checkout_splits_reject_incorrect_cash_change_math() {
        let mut split = cash_split(Decimal::new(5000, 2));
        split.metadata = Some(json!({
            "cash_tendered_cents": 10000,
            "change_due_cents": 4000
        }));
        let payload = checkout_request_for_split_validation(
            Decimal::new(5000, 2),
            Decimal::new(5000, 2),
            vec![split],
        );

        let err = resolve_payment_splits(&payload).unwrap_err();

        assert!(err
            .to_string()
            .contains("cash tendered minus change must equal the applied cash payment"));
    }

    #[test]
    fn checkout_splits_accept_donation_with_note() {
        let payload = checkout_request_for_split_validation(
            Decimal::new(2500, 2),
            Decimal::new(2500, 2),
            vec![donation_split(
                Decimal::new(2500, 2),
                Some("Local fundraiser"),
            )],
        );

        let (splits, label) = resolve_payment_splits(&payload).unwrap();

        assert_eq!(label, "donation");
        assert_eq!(splits[0].metadata["tender_family"], json!("donation"));
        assert_eq!(
            splits[0].metadata["donation_note"],
            json!("Local fundraiser")
        );
    }

    #[test]
    fn checkout_splits_reject_donation_without_note() {
        let payload = checkout_request_for_split_validation(
            Decimal::new(2500, 2),
            Decimal::new(2500, 2),
            vec![donation_split(Decimal::new(2500, 2), None)],
        );

        let err = resolve_payment_splits(&payload).unwrap_err();

        assert!(err
            .to_string()
            .contains("donation payment requires a donation note"));
    }

    #[test]
    fn checkout_quantity_rejects_zero_quantity() {
        let mut item = checkout_item_with_client_line(None);
        item.quantity = 0;

        let err = validate_checkout_item_quantity(&item).unwrap_err();

        assert!(err.to_string().contains("Invalid quantity for variant"));
    }

    #[test]
    fn checkout_quantity_rejects_negative_non_takeaway_line() {
        let mut item = checkout_item_with_client_line(None);
        item.fulfillment = DbFulfillmentType::Layaway;
        item.quantity = -1;

        let err = validate_checkout_item_quantity(&item).unwrap_err();

        assert!(err
            .to_string()
            .contains("Negative quantity is only allowed for take-away retail lines"));
    }

    #[test]
    fn checkout_quantity_rejects_negative_alteration_service_line() {
        let mut item = alteration_service_item("line-1", "intake-1", Decimal::new(2500, 2));
        item.quantity = -1;

        let err = validate_checkout_item_quantity(&item).unwrap_err();

        assert!(err
            .to_string()
            .contains("Alteration service lines cannot use negative quantity"));
    }

    #[test]
    fn transaction_checkout_combo_reward_parses_decimal_text() {
        let rule = json!({ "reward_amount": "12.34" });

        let reward = parse_combo_reward_amount(&rule).unwrap();

        assert_eq!(reward, Decimal::new(1234, 2));
    }

    #[test]
    fn helcim_refund_attempts_compare_against_absolute_refund_amount() {
        assert_eq!(helcim_attempt_comparison_cents(-1000, true), 1000);
        assert_eq!(helcim_attempt_comparison_cents(1000, true), 1000);
        assert_eq!(helcim_attempt_comparison_cents(-1000, false), -1000);
    }

    #[test]
    fn helcim_provider_identity_only_attaches_to_card_tenders() {
        assert!(helcim_tender_method_matches_amount(
            "card_terminal",
            dec!(10.00)
        ));
        assert!(helcim_tender_method_matches_amount(
            "card_manual",
            dec!(10.00)
        ));
        assert!(helcim_tender_method_matches_amount(
            "card_saved",
            dec!(10.00)
        ));
        assert!(helcim_tender_method_matches_amount(
            "card_credit",
            dec!(-10.00)
        ));
        assert!(!helcim_tender_method_matches_amount("cash", dec!(10.00)));
        assert!(!helcim_tender_method_matches_amount(
            "card_credit",
            dec!(10.00)
        ));
    }

    #[test]
    fn helcim_return_ledger_uses_new_movement_not_original_charge() {
        assert_eq!(
            canonical_helcim_ledger_transaction_id(
                true,
                Some("original-charge"),
                Some("refund-movement"),
            )
            .expect("return movement"),
            Some("refund-movement".to_string())
        );
        assert!(
            canonical_helcim_ledger_transaction_id(true, Some("original-charge"), None,).is_err()
        );
        assert_eq!(
            canonical_helcim_ledger_transaction_id(
                false,
                Some("purchase-movement"),
                Some("provider-payment"),
            )
            .expect("purchase movement"),
            Some("purchase-movement".to_string())
        );
    }

    #[test]
    fn helcim_attempt_requires_the_checkout_that_started_it() {
        let checkout_id = Uuid::new_v4();

        assert!(validate_helcim_attempt_checkout_binding(
            true,
            Some(checkout_id),
            Some(checkout_id),
        )
        .is_ok());
        assert!(validate_helcim_attempt_checkout_binding(true, Some(checkout_id), None).is_err());
        assert!(validate_helcim_attempt_checkout_binding(
            true,
            Some(checkout_id),
            Some(Uuid::new_v4()),
        )
        .is_err());
    }

    #[test]
    fn helcim_checkout_references_include_all_provider_identifiers() {
        let attempt_id = Uuid::new_v4();
        let split = ResolvedPaymentSplit {
            method: "card_terminal".to_string(),
            amount: dec!(652.50),
            gift_card_code: None,
            metadata: json!({ "payment_provider_attempt_id": attempt_id.to_string() }),
            payment_provider: Some("helcim".to_string()),
            provider_payment_id: Some("payment-1".to_string()),
            provider_status: Some("approved".to_string()),
            provider_terminal_id: Some("terminal-1".to_string()),
            provider_transaction_id: Some("transaction-1".to_string()),
            provider_auth_code: None,
            provider_card_type: None,
            check_number: None,
            merchant_fee: Decimal::ZERO,
            net_amount: dec!(652.50),
            card_brand: None,
            card_last4: None,
        };

        let references = helcim_checkout_references(&[split]);

        assert!(references.iter().any(|value| value == "payment-1"));
        assert!(references.iter().any(|value| value == "transaction-1"));
        assert!(references
            .iter()
            .any(|value| value == &attempt_id.to_string()));
        assert_eq!(references.len(), 3);
    }

    #[test]
    fn transaction_checkout_combo_reward_rejects_numeric_json() {
        let rule = json!({ "reward_amount": 12 });

        let err = parse_combo_reward_amount(&rule).unwrap_err();

        assert!(err
            .to_string()
            .contains("reward_amount must be a decimal string"));
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
            tax_category_override: None,
            salesperson_id: None,
            discount_event_id: None,
            gift_card_load_code: None,
            custom_item_type: Some("alteration_service".to_string()),
            custom_order_details: None,
            is_rush: false,
            need_by_date: None,
            needs_gift_wrap: false,
            order_lifecycle_status: None,
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
            capacity_bucket: None,
            capacity_units: None,
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

    fn order_payment_helcim_retry_payload(
        checkout_client_id: Uuid,
        session_id: Uuid,
        operator_staff_id: Uuid,
        customer_id: Uuid,
        target_transaction_id: Uuid,
        target_display_id: String,
        amount: Decimal,
        payment_provider_attempt_id: Uuid,
        provider_transaction_id: &str,
        provider_payment_id: &str,
    ) -> CheckoutRequest {
        CheckoutRequest {
            session_id,
            operator_staff_id,
            primary_salesperson_id: None,
            customer_id: Some(customer_id),
            wedding_member_id: None,
            payment_method: "card_manual".to_string(),
            total_price: Decimal::ZERO,
            amount_paid: amount,
            items: Vec::new(),
            alteration_intakes: Vec::new(),
            actor_name: Some("Order payment replay regression".to_string()),
            payment_splits: Some(vec![CheckoutPaymentSplit {
                payment_method: "card_manual".to_string(),
                amount,
                sub_type: None,
                applied_deposit_amount: None,
                gift_card_code: None,
                check_number: None,
                metadata: Some(json!({
                    "payment_provider": "helcim",
                    "payment_provider_attempt_id": payment_provider_attempt_id,
                    "provider_status": "approved",
                    "provider_payment_id": provider_payment_id,
                    "provider_transaction_id": provider_transaction_id,
                })),
            }]),
            wedding_disbursements: None,
            order_payments: vec![CheckoutOrderPayment {
                client_line_id: format!("order-pay-{target_transaction_id}"),
                target_transaction_id,
                target_display_id,
                customer_id,
                amount,
                balance_before: amount,
                projected_balance_after: Decimal::ZERO,
            }],
            below_cost_approval: None,
            checkout_client_id: Some(checkout_client_id),
            booked_at_local: None,
            backdate_approval: None,
            shipping_rate_quote_id: None,
            shipping_links: Vec::new(),
            fulfillment_mode: None,
            ship_to: None,
            target_transaction_id: None,
            is_rush: false,
            need_by_date: None,
            is_tax_exempt: false,
            tax_exempt_reason: None,
            rounding_adjustment: None,
            final_cash_due: None,
            is_processing: false,
            exchange_settlement: None,
        }
    }

    #[test]
    fn exact_order_payment_helcim_replay_shape_is_narrow_and_financially_exact() {
        let amount = dec!(142.75);
        let mut payload = order_payment_helcim_retry_payload(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            "TXN-12345".to_string(),
            amount,
            Uuid::new_v4(),
            "provider-transaction",
            "provider-payment",
        );

        let evidence =
            exact_order_payment_helcim_replay_shape(&payload).expect("exact replay shape");
        assert_eq!(evidence.amount, amount);
        assert_eq!(
            evidence.target_transaction_id,
            payload.order_payments[0].target_transaction_id
        );

        payload.order_payments[0].projected_balance_after = dec!(0.01);
        assert!(exact_order_payment_helcim_replay_shape(&payload).is_none());
        payload.order_payments[0].projected_balance_after = Decimal::ZERO;

        payload.payment_splits.as_mut().expect("payment split")[0].amount = dec!(142.74);
        assert!(exact_order_payment_helcim_replay_shape(&payload).is_none());
        payload.payment_splits.as_mut().expect("payment split")[0].amount = amount;

        payload.items.push(checkout_item_with_client_line(Some(
            "unrelated-current-sale-line",
        )));
        assert!(exact_order_payment_helcim_replay_shape(&payload).is_none());
    }

    #[tokio::test]
    async fn execute_checkout_returns_exact_normalized_order_payment_replay_without_writes() {
        let Ok(database_url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect test database");

        let staff_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let checkout_client_id = Uuid::new_v4();
        let source_checkout_client_id = Uuid::new_v4();
        let target_transaction_id = Uuid::new_v4();
        let source_transaction_id = Uuid::new_v4();
        let payment_provider_attempt_id = Uuid::new_v4();
        let payment_transaction_id = Uuid::new_v4();
        let provider_transaction_id = format!("order-payment-replay-{}", Uuid::new_v4().simple());
        let provider_payment_id = format!("payment-{}", Uuid::new_v4().simple());
        let amount = dec!(142.75);

        sqlx::query(
            r#"
            INSERT INTO staff (
                id, full_name, cashier_code, base_commission_rate,
                role, max_discount_percent
            )
            VALUES ($1, $2, $3, 0, 'admin'::staff_role, 100)
            "#,
        )
        .bind(staff_id)
        .bind("Order Payment Replay Regression Staff")
        .bind(format!("T{}", &staff_id.simple().to_string()[0..8]))
        .execute(&pool)
        .await
        .expect("insert staff");

        loop {
            let register_lane = ((Uuid::new_v4().as_u128() % 99) + 1) as i16;
            let inserted = sqlx::query(
                r#"
                INSERT INTO register_sessions (
                    id, opened_by, opening_float, is_open, register_lane, till_close_group_id
                )
                VALUES ($1, $2, 0, TRUE, $3, $4)
                "#,
            )
            .bind(session_id)
            .bind(staff_id)
            .bind(register_lane)
            .bind(Uuid::new_v4())
            .execute(&pool)
            .await;
            match inserted {
                Ok(_) => break,
                Err(error)
                    if error
                        .as_database_error()
                        .and_then(|db_error| db_error.constraint())
                        == Some("register_sessions_open_lane_uidx") =>
                {
                    continue;
                }
                Err(error) => panic!("insert register session: {error:?}"),
            }
        }

        let suffix = Uuid::new_v4().simple().to_string();
        let customer_id = insert_customer(
            &pool,
            InsertCustomerParams {
                customer_code: None,
                first_name: "Order Payment".to_string(),
                last_name: format!("Replay {}", &suffix[0..8]),
                company_name: None,
                email: Some(format!("order-payment-replay-{suffix}@example.test")),
                phone: Some(format!("555{}", &suffix[0..7])),
                address_line1: None,
                address_line2: None,
                city: None,
                state: None,
                postal_code: None,
                date_of_birth: None,
                anniversary_date: None,
                custom_field_1: None,
                custom_field_2: None,
                custom_field_3: None,
                custom_field_4: None,
                marketing_email_opt_in: false,
                marketing_sms_opt_in: false,
                transactional_sms_opt_in: true,
                transactional_email_opt_in: true,
                customer_created_source: CustomerCreatedSource::Store,
            },
        )
        .await
        .expect("insert customer");

        let target_display_id: String = sqlx::query_scalar(
            r#"
            INSERT INTO transactions (
                id, customer_id, operator_id, total_price, amount_paid, balance_due,
                status, register_session_id
            )
            VALUES ($1, $2, $3, $4, $4, 0, 'fulfilled'::order_status, $5)
            RETURNING display_id
            "#,
        )
        .bind(target_transaction_id)
        .bind(customer_id)
        .bind(staff_id)
        .bind(amount)
        .bind(session_id)
        .fetch_one(&pool)
        .await
        .expect("insert paid target transaction");

        let source_display_id: String = sqlx::query_scalar(
            r#"
            INSERT INTO transactions (
                id, customer_id, total_price, amount_paid, balance_due,
                status, register_session_id, checkout_client_id
            )
            VALUES ($1, $2, 0, 0, 0, 'fulfilled'::order_status, $3, $4)
            RETURNING display_id
            "#,
        )
        .bind(source_transaction_id)
        .bind(customer_id)
        .bind(session_id)
        .bind(source_checkout_client_id)
        .fetch_one(&pool)
        .await
        .expect("insert manual-card ledger source transaction");

        sqlx::query(
            r#"
            INSERT INTO payment_provider_attempts (
                id, provider, status, amount_cents, currency,
                register_session_id, staff_id, idempotency_key,
                provider_payment_id, provider_transaction_id,
                completed_at, checkout_client_id
            )
            VALUES (
                $1, 'helcim', 'approved', 14275, 'usd',
                $2, $3, $4, $5, $6, now(), $7
            )
            "#,
        )
        .bind(payment_provider_attempt_id)
        .bind(session_id)
        .bind(staff_id)
        .bind(format!("order-payment-replay-{checkout_client_id}"))
        .bind(&provider_payment_id)
        .bind(&provider_transaction_id)
        .bind(checkout_client_id)
        .execute(&pool)
        .await
        .expect("insert approved Helcim attempt");

        sqlx::query(
            r#"
            INSERT INTO payment_transactions (
                id, session_id, payer_id, payment_method, amount, metadata,
                status, payment_provider, provider_status, provider_transaction_id
            )
            VALUES (
                $1, $2, $3, 'card_manual', $4, $5,
                'success', 'helcim', 'approved', $6
            )
            "#,
        )
        .bind(payment_transaction_id)
        .bind(session_id)
        .bind(customer_id)
        .bind(amount)
        .bind(json!({
            "checkout_transaction_id": source_transaction_id,
            "checkout_display_id": source_display_id,
        }))
        .bind(&provider_transaction_id)
        .execute(&pool)
        .await
        .expect("insert normalized Helcim payment");

        sqlx::query(
            r#"
            INSERT INTO payment_allocations (
                transaction_id, target_transaction_id, amount_allocated, metadata
            )
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(payment_transaction_id)
        .bind(target_transaction_id)
        .bind(amount)
        .bind(json!({
            "kind": "existing_order_payment",
            "client_line_id": "legacy-normalized-client-line",
            "target_transaction_id": target_transaction_id,
            "target_display_id": format!("MAIN|legacy|{target_transaction_id}"),
            "customer_id": customer_id,
            "balance_before": amount.to_string(),
            "projected_balance_after": Decimal::ZERO.to_string(),
            "applied_deposit_amount": amount.to_string(),
        }))
        .execute(&pool)
        .await
        .expect("insert exact target allocation");

        let payload = order_payment_helcim_retry_payload(
            checkout_client_id,
            session_id,
            staff_id,
            customer_id,
            target_transaction_id,
            target_display_id.clone(),
            amount,
            payment_provider_attempt_id,
            &provider_transaction_id,
            &provider_payment_id,
        );
        let replay = execute_checkout(&pool, &reqwest::Client::new(), Decimal::ZERO, payload)
            .await
            .expect("exact committed order payment should replay");
        match replay {
            CheckoutDone::Idempotent {
                transaction_id,
                display_id,
            } => {
                assert_eq!(transaction_id, source_transaction_id);
                assert_eq!(display_id, source_display_id);
            }
            other => panic!("expected exact idempotent replay, got {other:?}"),
        }

        let payment_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*)::bigint FROM payment_transactions WHERE id = $1")
                .bind(payment_transaction_id)
                .fetch_one(&pool)
                .await
                .expect("count normalized payment");
        let allocation_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM payment_allocations WHERE transaction_id = $1",
        )
        .bind(payment_transaction_id)
        .fetch_one(&pool)
        .await
        .expect("count exact allocation");
        let recovery_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM operational_recovery_job WHERE checkout_client_id = $1",
        )
        .bind(checkout_client_id)
        .fetch_one(&pool)
        .await
        .expect("count checkout recovery rows");
        assert_eq!(payment_count, 1);
        assert_eq!(allocation_count, 1);
        assert_eq!(recovery_count, 0);

        let mismatched_payload = order_payment_helcim_retry_payload(
            checkout_client_id,
            session_id,
            staff_id,
            customer_id,
            target_transaction_id,
            target_display_id.clone(),
            amount,
            payment_provider_attempt_id,
            "different-provider-transaction",
            &provider_payment_id,
        );
        assert!(
            execute_checkout(
                &pool,
                &reqwest::Client::new(),
                Decimal::ZERO,
                mismatched_payload,
            )
            .await
            .is_err(),
            "mismatched provider evidence must remain blocked"
        );

        sqlx::query(
            r#"
            INSERT INTO payment_allocations (
                transaction_id, target_transaction_id, amount_allocated, metadata
            )
            VALUES ($1, $2, $3, '{"kind":"ambiguous_test"}'::jsonb)
            "#,
        )
        .bind(payment_transaction_id)
        .bind(target_transaction_id)
        .bind(amount)
        .execute(&pool)
        .await
        .expect("insert ambiguous second allocation");
        let ambiguous_payload = order_payment_helcim_retry_payload(
            checkout_client_id,
            session_id,
            staff_id,
            customer_id,
            target_transaction_id,
            target_display_id,
            amount,
            payment_provider_attempt_id,
            &provider_transaction_id,
            &provider_payment_id,
        );
        assert!(
            execute_checkout(
                &pool,
                &reqwest::Client::new(),
                Decimal::ZERO,
                ambiguous_payload,
            )
            .await
            .is_err(),
            "ambiguous allocation evidence must remain blocked"
        );

        sqlx::query("DELETE FROM payment_allocations WHERE transaction_id = $1")
            .bind(payment_transaction_id)
            .execute(&pool)
            .await
            .expect("delete allocations");
        sqlx::query("DELETE FROM payment_transactions WHERE id = $1")
            .bind(payment_transaction_id)
            .execute(&pool)
            .await
            .expect("delete payment");
        sqlx::query("DELETE FROM payment_provider_attempts WHERE id = $1")
            .bind(payment_provider_attempt_id)
            .execute(&pool)
            .await
            .expect("delete attempt");
        sqlx::query("DELETE FROM transactions WHERE id = ANY($1)")
            .bind(vec![target_transaction_id, source_transaction_id])
            .execute(&pool)
            .await
            .expect("delete transactions");
        sqlx::query("DELETE FROM register_sessions WHERE id = $1")
            .bind(session_id)
            .execute(&pool)
            .await
            .expect("delete Register session");
        sqlx::query("DELETE FROM customers WHERE id = $1")
            .bind(customer_id)
            .execute(&pool)
            .await
            .expect("delete customer");
        sqlx::query("DELETE FROM staff WHERE id = $1")
            .bind(staff_id)
            .execute(&pool)
            .await
            .expect("delete staff");
    }

    fn target_snapshot(
        customer_id: Uuid,
        target_transaction_id: Uuid,
        balance_due: Decimal,
    ) -> ExistingOrderPaymentTarget {
        ExistingOrderPaymentTarget {
            target_transaction_id,
            display_id: "TXN-12345".to_string(),
            transaction_display_id: "TXN-12345".to_string(),
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
            payment_provider: None,
            provider_payment_id: None,
            provider_status: None,
            provider_terminal_id: None,
            provider_transaction_id: None,
            provider_auth_code: None,
            provider_card_type: None,
            check_number: None,
            merchant_fee: Decimal::ZERO,
            net_amount: amount,
            card_brand: None,
            card_last4: None,
        }
    }

    fn resolved_open_deposit_split(amount: Decimal) -> ResolvedPaymentSplit {
        let mut split = resolved_split(amount);
        split.method = "open_deposit".to_string();
        split
    }

    #[test]
    fn open_deposit_scope_allows_only_the_deferred_current_sale_portion() {
        assert!(validate_open_deposit_scope(
            &[resolved_open_deposit_split(Decimal::new(6000, 2))],
            Decimal::new(10000, 2),
            Decimal::new(4000, 2),
            Decimal::ZERO,
            Decimal::ZERO,
        )
        .is_ok());

        let error = validate_open_deposit_scope(
            &[resolved_open_deposit_split(Decimal::new(6001, 2))],
            Decimal::new(10000, 2),
            Decimal::new(4000, 2),
            Decimal::ZERO,
            Decimal::ZERO,
        )
        .expect_err("takeaway value must remain cash-equivalent");
        assert!(error.to_string().contains("deferred order portion"));
    }

    #[test]
    fn open_deposit_scope_rejects_external_allocations() {
        let error = validate_open_deposit_scope(
            &[resolved_open_deposit_split(Decimal::new(5000, 2))],
            Decimal::new(5000, 2),
            Decimal::ZERO,
            Decimal::new(100, 2),
            Decimal::ZERO,
        )
        .expect_err("member-held funds cannot be redirected to another member");
        assert!(error.to_string().contains("current sale"));
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
    fn transaction_checkout_order_payment_shape_ignores_zero_amount_rows() {
        let customer_id = Uuid::new_v4();
        let target_id = Uuid::new_v4();
        let payload = validate_order_payment_shape(
            Some(customer_id),
            Some(customer_id),
            &[order_payment_payload(
                customer_id,
                target_id,
                Decimal::ZERO,
                Decimal::new(10000, 2),
            )],
        )
        .unwrap();

        assert!(payload.is_empty());
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
    fn transaction_checkout_wedding_disbursement_rejects_live_balance_overpayment() {
        let err = validate_wedding_disbursement_against_balance(
            Decimal::new(10003, 2),
            Decimal::new(10000, 2),
        )
        .unwrap_err();
        assert!(err
            .to_string()
            .contains("exceeds the member's current balance due"));

        validate_wedding_disbursement_against_balance(
            Decimal::new(10000, 2),
            Decimal::new(10000, 2),
        )
        .expect("paying the exact live balance should remain valid");
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
            Decimal::ZERO,
            &order_payments,
            Decimal::ZERO,
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

    #[test]
    fn transaction_checkout_allocation_plan_allows_order_payment_only() {
        let current_tx_id = Uuid::new_v4();
        let customer_id = Uuid::new_v4();
        let target_id = Uuid::new_v4();
        let order_payments = vec![ResolvedOrderPayment {
            client_line_id: "order-pay-1".to_string(),
            target_transaction_id: target_id,
            target_display_id: "TXN-12345".to_string(),
            customer_id,
            amount: Decimal::new(8799, 2),
            balance_before: Decimal::new(8799, 2),
            projected_balance_after: Decimal::ZERO,
        }];

        let plan = build_payment_allocation_plan(
            &[resolved_split(Decimal::new(8799, 2))],
            current_tx_id,
            Decimal::ZERO,
            Decimal::ZERO,
            &order_payments,
            Decimal::ZERO,
        )
        .unwrap();

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].target_transaction_id, target_id);
        assert_eq!(plan[0].amount, Decimal::new(8799, 2));
        assert!(plan[0].is_existing_order_payment);
        assert_eq!(
            plan[0]
                .metadata
                .get("kind")
                .and_then(|value| value.as_str()),
            Some("existing_order_payment")
        );
    }

    #[test]
    fn transaction_checkout_allocation_plan_reserves_party_disbursement_tender() {
        let current_tx_id = Uuid::new_v4();

        let plan = build_payment_allocation_plan(
            &[resolved_split(Decimal::new(12500, 2))],
            current_tx_id,
            Decimal::new(7500, 2),
            Decimal::ZERO,
            &[],
            Decimal::new(5000, 2),
        )
        .unwrap();

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].target_transaction_id, current_tx_id);
        assert_eq!(plan[0].amount, Decimal::new(7500, 2));
        assert!(!plan[0].is_existing_order_payment);
    }

    #[test]
    fn transaction_checkout_allocation_plan_allows_cash_rounded_refund() {
        let current_tx_id = Uuid::new_v4();

        let plan = build_payment_allocation_plan(
            &[resolved_split(Decimal::new(-7125, 2))],
            current_tx_id,
            Decimal::new(-7125, 2),
            Decimal::ZERO,
            &[],
            Decimal::ZERO,
        )
        .unwrap();

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].target_transaction_id, current_tx_id);
        assert_eq!(plan[0].amount, Decimal::new(-7125, 2));
        assert!(!plan[0].is_existing_order_payment);
    }

    #[test]
    fn transaction_checkout_allocation_plan_auto_tags_current_order_payment_as_deposit() {
        let current_tx_id = Uuid::new_v4();

        let plan = build_payment_allocation_plan(
            &[resolved_split(Decimal::new(25000, 2))],
            current_tx_id,
            Decimal::new(25000, 2),
            Decimal::new(25000, 2),
            &[],
            Decimal::ZERO,
        )
        .unwrap();

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].target_transaction_id, current_tx_id);
        assert_eq!(plan[0].amount, Decimal::new(25000, 2));
        assert!(!plan[0].is_existing_order_payment);
        assert_eq!(
            plan[0]
                .metadata
                .get("applied_deposit_amount")
                .and_then(|value| value.as_str()),
            Some("250.00")
        );
    }

    #[test]
    fn transaction_checkout_allocation_plan_tags_only_deferred_portion_for_mixed_sale() {
        let current_tx_id = Uuid::new_v4();

        let plan = build_payment_allocation_plan(
            &[resolved_split(Decimal::new(15000, 2))],
            current_tx_id,
            Decimal::new(15000, 2),
            Decimal::new(10000, 2),
            &[],
            Decimal::ZERO,
        )
        .unwrap();

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].target_transaction_id, current_tx_id);
        assert_eq!(plan[0].amount, Decimal::new(15000, 2));
        assert_eq!(
            plan[0]
                .metadata
                .get("applied_deposit_amount")
                .and_then(|value| value.as_str()),
            Some("100.00")
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

    #[tokio::test]
    async fn evaluate_combo_incentives_preserves_decimal_reward_from_db() {
        let Ok(database_url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let mut conn = sqlx::PgConnection::connect(&database_url)
            .await
            .expect("connect test database");
        let mut tx = conn.begin().await.expect("begin transaction");

        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        let sku = format!("E2E-COMBO-SPIFF-{}", Uuid::new_v4().simple());

        sqlx::query(
            r#"
            INSERT INTO products (id, name, base_retail_price, base_cost)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(product_id)
        .bind("Combo SPIFF Decimal Regression Product")
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

        let rule_id = sqlx::query_scalar::<_, Uuid>(
            r#"
            INSERT INTO commission_combo_rules (label, reward_amount, is_active)
            VALUES ($1, $2, TRUE)
            RETURNING id
            "#,
        )
        .bind("Decimal SPIFF")
        .bind(Decimal::new(1234, 2))
        .fetch_one(&mut *tx)
        .await
        .expect("insert combo rule");

        sqlx::query(
            r#"
            INSERT INTO commission_combo_rule_items (rule_id, match_type, match_id, qty_required)
            VALUES ($1, 'product', $2, 1)
            "#,
        )
        .bind(rule_id)
        .bind(product_id)
        .execute(&mut *tx)
        .await
        .expect("insert combo rule item");

        let mut item = checkout_item_with_client_line(Some("combo-item-1"));
        item.product_id = product_id;
        item.variant_id = variant_id;
        item.quantity = 1;

        let rewards = evaluate_combo_incentives(&mut tx, &[&item])
            .await
            .expect("evaluate combo incentives");

        assert_eq!(rewards.len(), 1);
        assert_eq!(rewards[0].product_id, product_id);
        assert_eq!(rewards[0].variant_id, variant_id);
        assert_eq!(rewards[0].reward_amount, Decimal::new(1234, 2));

        tx.rollback().await.expect("rollback transaction");
    }

    async fn cleanup_combo_checkout_persistence_test(
        pool: &PgPool,
        transaction_id: Option<Uuid>,
        session_id: Uuid,
        staff_id: Uuid,
        rule_id: Uuid,
        product_id: Uuid,
        category_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        if let Some(transaction_id) = transaction_id {
            sqlx::query("DELETE FROM payment_allocations WHERE target_transaction_id = $1")
                .bind(transaction_id)
                .execute(pool)
                .await?;
            sqlx::query("DELETE FROM commission_events WHERE transaction_id = $1")
                .bind(transaction_id)
                .execute(pool)
                .await?;
            sqlx::query("DELETE FROM transactions WHERE id = $1")
                .bind(transaction_id)
                .execute(pool)
                .await?;
        }

        sqlx::query("DELETE FROM payment_transactions WHERE session_id = $1")
            .bind(session_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM register_sessions WHERE id = $1")
            .bind(session_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM inventory_transactions WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)")
            .bind(product_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM commission_combo_rules WHERE id = $1")
            .bind(rule_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(product_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM categories WHERE id = $1")
            .bind(category_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM staff WHERE id = $1")
            .bind(staff_id)
            .execute(pool)
            .await?;

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn cleanup_wedding_group_pay_checkout_test(
        pool: &PgPool,
        transaction_ids: &[Uuid],
        session_id: Uuid,
        staff_id: Uuid,
        product_id: Uuid,
        variant_id: Uuid,
        category_id: Uuid,
        party_id: Uuid,
        member_id: Uuid,
        beneficiary_customer_id: Uuid,
        payer_customer_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            DELETE FROM customer_open_deposit_ledger_sources
            WHERE source_payment_transaction_id IN (
                SELECT id FROM payment_transactions WHERE session_id = $1
            )
            "#,
        )
        .bind(session_id)
        .execute(pool)
        .await?;
        sqlx::query(
            r#"
            DELETE FROM customer_open_deposit_accounts
            WHERE customer_id = ANY($1)
            "#,
        )
        .bind(vec![beneficiary_customer_id, payer_customer_id])
        .execute(pool)
        .await?;
        sqlx::query(
            r#"
            DELETE FROM payment_allocations
            WHERE target_transaction_id = ANY($1)
               OR transaction_id IN (
                    SELECT id FROM payment_transactions WHERE session_id = $2
               )
            "#,
        )
        .bind(transaction_ids)
        .bind(session_id)
        .execute(pool)
        .await?;
        sqlx::query("DELETE FROM transaction_lines WHERE transaction_id = ANY($1)")
            .bind(transaction_ids)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM transactions WHERE id = ANY($1)")
            .bind(transaction_ids)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM fulfillment_orders WHERE customer_id = $1 OR wedding_id = $2")
            .bind(beneficiary_customer_id)
            .bind(party_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM payment_transactions WHERE session_id = $1")
            .bind(session_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM register_sessions WHERE id = $1")
            .bind(session_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM wedding_members WHERE id = $1 OR wedding_party_id = $2")
            .bind(member_id)
            .bind(party_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM wedding_parties WHERE id = $1")
            .bind(party_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM product_variants WHERE id = $1")
            .bind(variant_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM products WHERE id = $1")
            .bind(product_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM categories WHERE id = $1")
            .bind(category_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM staff WHERE id = $1")
            .bind(staff_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM customers WHERE id = ANY($1)")
            .bind(vec![beneficiary_customer_id, payer_customer_id])
            .execute(pool)
            .await?;

        Ok(())
    }

    #[tokio::test]
    async fn execute_checkout_rejects_wedding_member_customer_mismatch() {
        let Ok(database_url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect test database");

        let party_id = Uuid::new_v4();
        let member_id = Uuid::new_v4();
        let suffix = Uuid::new_v4().simple().to_string();
        let member_customer_id = insert_customer(
            &pool,
            InsertCustomerParams {
                customer_code: None,
                first_name: "Wedding".to_string(),
                last_name: format!("Member {}", &suffix[0..8]),
                company_name: None,
                email: Some(format!("wed-member-{suffix}@example.test")),
                phone: Some(format!("557{}", &suffix[0..7])),
                address_line1: None,
                address_line2: None,
                city: None,
                state: None,
                postal_code: None,
                date_of_birth: None,
                anniversary_date: None,
                custom_field_1: None,
                custom_field_2: None,
                custom_field_3: None,
                custom_field_4: None,
                marketing_email_opt_in: false,
                marketing_sms_opt_in: false,
                transactional_sms_opt_in: true,
                transactional_email_opt_in: true,
                customer_created_source: CustomerCreatedSource::Store,
            },
        )
        .await
        .expect("insert member customer");
        let other_customer_id = insert_customer(
            &pool,
            InsertCustomerParams {
                customer_code: None,
                first_name: "Wrong".to_string(),
                last_name: format!("Customer {}", &suffix[0..8]),
                company_name: None,
                email: Some(format!("wed-wrong-{suffix}@example.test")),
                phone: Some(format!("558{}", &suffix[0..7])),
                address_line1: None,
                address_line2: None,
                city: None,
                state: None,
                postal_code: None,
                date_of_birth: None,
                anniversary_date: None,
                custom_field_1: None,
                custom_field_2: None,
                custom_field_3: None,
                custom_field_4: None,
                marketing_email_opt_in: false,
                marketing_sms_opt_in: false,
                transactional_sms_opt_in: true,
                transactional_email_opt_in: true,
                customer_created_source: CustomerCreatedSource::Store,
            },
        )
        .await
        .expect("insert wrong customer");

        sqlx::query(
            r#"
            INSERT INTO wedding_parties (id, party_name, groom_name, event_date, party_type, is_deleted)
            VALUES ($1, $2, $3, $4, 'Wedding', FALSE)
            "#,
        )
        .bind(party_id)
        .bind("Wedding Member Customer Guard Regression Party")
        .bind("Regression Groom")
        .bind(chrono::NaiveDate::from_ymd_opt(2027, 3, 20).unwrap())
        .execute(&pool)
        .await
        .expect("insert wedding party");

        sqlx::query(
            r#"
            INSERT INTO wedding_members (
                id, wedding_party_id, customer_id, role, status, member_index
            )
            VALUES ($1, $2, $3, 'Groomsman', 'active', 1)
            "#,
        )
        .bind(member_id)
        .bind(party_id)
        .bind(member_customer_id)
        .execute(&pool)
        .await
        .expect("insert wedding member");

        let mut item = checkout_item_with_client_line(Some("wrong-customer-wedding-line"));
        item.fulfillment = DbFulfillmentType::WeddingOrder;
        let payload = CheckoutRequest {
            session_id: Uuid::new_v4(),
            operator_staff_id: Uuid::new_v4(),
            primary_salesperson_id: None,
            customer_id: Some(other_customer_id),
            wedding_member_id: Some(member_id),
            payment_method: "cash".to_string(),
            total_price: Decimal::new(10000, 2),
            amount_paid: Decimal::ZERO,
            items: vec![item],
            alteration_intakes: vec![],
            actor_name: Some("Wedding Customer Guard Test".to_string()),
            payment_splits: Some(vec![]),
            wedding_disbursements: None,
            order_payments: vec![],
            below_cost_approval: None,
            checkout_client_id: Some(Uuid::new_v4()),
            shipping_rate_quote_id: None,
            shipping_links: vec![],
            fulfillment_mode: None,
            ship_to: None,
            target_transaction_id: None,
            booked_at_local: None,
            backdate_approval: None,
            is_rush: false,
            need_by_date: None,
            is_tax_exempt: true,
            tax_exempt_reason: Some("test tax-exempt checkout".to_string()),
            rounding_adjustment: None,
            final_cash_due: None,
            is_processing: false,
            exchange_settlement: None,
        };

        let err = execute_checkout(&pool, &reqwest::Client::new(), Decimal::ZERO, payload)
            .await
            .expect_err("mismatched wedding member customer should be rejected");
        assert!(
            err.to_string()
                .contains("wedding_member_id must belong to checkout customer_id"),
            "unexpected error: {err}"
        );

        sqlx::query("DELETE FROM wedding_members WHERE id = $1")
            .bind(member_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM wedding_parties WHERE id = $1")
            .bind(party_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM customers WHERE id = ANY($1)")
            .bind(vec![member_customer_id, other_customer_id])
            .execute(&pool)
            .await
            .ok();
    }

    #[tokio::test]
    async fn execute_checkout_persists_combo_spiff_reward_line_decimal() {
        let Ok(database_url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect test database");

        let staff_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let category_id = Uuid::new_v4();
        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        let sku = format!("E2E-CHECKOUT-SPIFF-{}", Uuid::new_v4().simple());

        sqlx::query(
            r#"
            INSERT INTO staff (
                id, full_name, cashier_code, base_commission_rate,
                role, max_discount_percent
            )
            VALUES ($1, $2, $3, $4, 'admin'::staff_role, $5)
            "#,
        )
        .bind(staff_id)
        .bind("Combo SPIFF Checkout Regression Staff")
        .bind(format!("T{}", &staff_id.simple().to_string()[0..8]))
        .bind(Decimal::new(200, 4))
        .bind(Decimal::new(10000, 2))
        .execute(&pool)
        .await
        .expect("insert staff");

        let register_lane = loop {
            let candidate = ((Uuid::new_v4().as_u128() % 99) + 1) as i16;
            let result = sqlx::query(
                r#"
                INSERT INTO register_sessions (
                    id, opened_by, opening_float, is_open, register_lane, till_close_group_id
                )
                VALUES ($1, $2, 0, TRUE, $3, $4)
                "#,
            )
            .bind(session_id)
            .bind(staff_id)
            .bind(candidate)
            .bind(Uuid::new_v4())
            .execute(&pool)
            .await;

            match result {
                Ok(_) => break candidate,
                Err(error)
                    if error
                        .as_database_error()
                        .and_then(|db_error| db_error.constraint())
                        == Some("register_sessions_open_lane_uidx") =>
                {
                    continue;
                }
                Err(error) => panic!("insert register session: {error:?}"),
            }
        };

        sqlx::query(
            r#"
            INSERT INTO categories (id, name, is_clothing_footwear)
            VALUES ($1, $2, FALSE)
            "#,
        )
        .bind(category_id)
        .bind(format!(
            "Checkout SPIFF Regression {}",
            category_id.simple()
        ))
        .execute(&pool)
        .await
        .expect("insert category");

        sqlx::query(
            r#"
            INSERT INTO products (id, category_id, name, base_retail_price, base_cost)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(product_id)
        .bind(category_id)
        .bind("Checkout SPIFF Decimal Regression Product")
        .bind(Decimal::new(10000, 2))
        .bind(Decimal::new(4000, 2))
        .execute(&pool)
        .await
        .expect("insert product");

        sqlx::query(
            r#"
            INSERT INTO product_variants (id, product_id, sku, variation_values, stock_on_hand)
            VALUES ($1, $2, $3, '{}'::jsonb, 5)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(&sku)
        .execute(&pool)
        .await
        .expect("insert variant");

        let rule_id = sqlx::query_scalar::<_, Uuid>(
            r#"
            INSERT INTO commission_combo_rules (label, reward_amount, is_active)
            VALUES ($1, $2, TRUE)
            RETURNING id
            "#,
        )
        .bind("Checkout Decimal SPIFF")
        .bind(Decimal::new(1234, 2))
        .fetch_one(&pool)
        .await
        .expect("insert combo rule");

        sqlx::query(
            r#"
            INSERT INTO commission_combo_rule_items (rule_id, match_type, match_id, qty_required)
            VALUES ($1, 'product', $2, 1)
            "#,
        )
        .bind(rule_id)
        .bind(product_id)
        .execute(&pool)
        .await
        .expect("insert combo rule item");

        let payload = CheckoutRequest {
            session_id,
            operator_staff_id: staff_id,
            primary_salesperson_id: Some(staff_id),
            customer_id: None,
            wedding_member_id: None,
            payment_method: "cash".to_string(),
            total_price: Decimal::new(10000, 2),
            amount_paid: Decimal::new(10000, 2),
            items: vec![CheckoutItem {
                client_line_id: Some("checkout-spiff-line-1".to_string()),
                line_type: None,
                alteration_intake_id: None,
                product_id,
                variant_id,
                fulfillment: DbFulfillmentType::Takeaway,
                quantity: 1,
                unit_price: Decimal::new(10000, 2),
                original_unit_price: None,
                price_override_reason: None,
                unit_cost: Decimal::new(4000, 2),
                state_tax: Decimal::ZERO,
                local_tax: Decimal::ZERO,
                tax_category_override: None,
                salesperson_id: Some(staff_id),
                discount_event_id: None,
                gift_card_load_code: None,
                custom_item_type: None,
                custom_order_details: None,
                is_rush: false,
                need_by_date: None,
                needs_gift_wrap: false,
                order_lifecycle_status: None,
            }],
            alteration_intakes: vec![],
            actor_name: Some("Combo SPIFF Test".to_string()),
            payment_splits: None,
            wedding_disbursements: None,
            order_payments: vec![],
            below_cost_approval: None,
            checkout_client_id: Some(Uuid::new_v4()),
            shipping_rate_quote_id: None,
            shipping_links: vec![],
            fulfillment_mode: None,
            ship_to: None,
            target_transaction_id: None,
            booked_at_local: None,
            backdate_approval: None,
            is_rush: false,
            need_by_date: None,
            is_tax_exempt: true,
            tax_exempt_reason: Some("test tax-exempt checkout".to_string()),
            rounding_adjustment: None,
            final_cash_due: None,
            is_processing: false,
            exchange_settlement: None,
        };

        let result = execute_checkout(&pool, &reqwest::Client::new(), Decimal::ZERO, payload).await;

        let transaction_id = match result {
            Ok(CheckoutDone::Completed { transaction_id, .. }) => transaction_id,
            Ok(CheckoutDone::Idempotent { .. }) => {
                cleanup_combo_checkout_persistence_test(
                    &pool,
                    None,
                    session_id,
                    staff_id,
                    rule_id,
                    product_id,
                    category_id,
                )
                .await
                .expect("cleanup after unexpected idempotent checkout");
                panic!("checkout should complete a new transaction");
            }
            Err(error) => {
                cleanup_combo_checkout_persistence_test(
                    &pool,
                    None,
                    session_id,
                    staff_id,
                    rule_id,
                    product_id,
                    category_id,
                )
                .await
                .expect("cleanup after checkout failure");
                panic!("checkout should complete: {error}");
            }
        };

        let spiff_lines: Vec<(Decimal, Decimal, Decimal, Decimal, bool, Option<String>)> =
            sqlx::query_as(
                r#"
                SELECT calculated_commission, unit_price, state_tax, local_tax, is_internal, custom_item_type
                FROM transaction_lines
                WHERE transaction_id = $1 AND custom_item_type = 'spiff_reward'
                "#,
            )
            .bind(transaction_id)
            .fetch_all(&pool)
            .await
            .expect("fetch spiff reward lines");

        assert_eq!(spiff_lines.len(), 1);
        let (commission, unit_price, state_tax, local_tax, is_internal, custom_item_type) =
            &spiff_lines[0];
        assert_eq!(*commission, Decimal::new(1234, 2));
        assert_eq!(*unit_price, Decimal::ZERO);
        assert_eq!(*state_tax, Decimal::ZERO);
        assert_eq!(*local_tax, Decimal::ZERO);
        assert!(*is_internal);
        assert_eq!(custom_item_type.as_deref(), Some("spiff_reward"));

        cleanup_combo_checkout_persistence_test(
            &pool,
            Some(transaction_id),
            session_id,
            staff_id,
            rule_id,
            product_id,
            category_id,
        )
        .await
        .expect("cleanup checkout persistence test");
    }

    #[tokio::test]
    async fn execute_checkout_completes_wedding_group_pay_and_routes_deposit() {
        let Ok(database_url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect test database");

        let staff_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let category_id = Uuid::new_v4();
        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        let party_id = Uuid::new_v4();
        let member_id = Uuid::new_v4();
        let sku = format!("E2E-WED-GROUP-PAY-{}", Uuid::new_v4().simple());
        let register_lane: i16 = sqlx::query_scalar(
            r#"
            SELECT gs.lane::smallint
            FROM generate_series(1, 99) AS gs(lane)
            WHERE NOT EXISTS (
                SELECT 1
                FROM register_sessions rs
                WHERE rs.is_open = TRUE AND rs.register_lane = gs.lane
            )
            LIMIT 1
            "#,
        )
        .fetch_one(&pool)
        .await
        .expect("find open register lane for checkout test");

        sqlx::query(
            r#"
            INSERT INTO staff (
                id, full_name, cashier_code, base_commission_rate,
                role, max_discount_percent
            )
            VALUES ($1, $2, $3, $4, 'admin'::staff_role, $5)
            "#,
        )
        .bind(staff_id)
        .bind("Wedding Group Pay Checkout Regression Staff")
        .bind(format!("W{}", &staff_id.simple().to_string()[0..8]))
        .bind(Decimal::new(200, 4))
        .bind(Decimal::new(10000, 2))
        .execute(&pool)
        .await
        .expect("insert staff");

        sqlx::query(
            r#"
            INSERT INTO register_sessions (
                id, opened_by, opening_float, is_open, register_lane, till_close_group_id
            )
            VALUES ($1, $2, 0, TRUE, $3, $4)
            "#,
        )
        .bind(session_id)
        .bind(staff_id)
        .bind(register_lane)
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .expect("insert register session");

        sqlx::query(
            r#"
            INSERT INTO categories (id, name, is_clothing_footwear)
            VALUES ($1, $2, FALSE)
            "#,
        )
        .bind(category_id)
        .bind(format!(
            "Wedding Group Pay Regression {}",
            category_id.simple()
        ))
        .execute(&pool)
        .await
        .expect("insert category");

        sqlx::query(
            r#"
            INSERT INTO products (id, category_id, name, base_retail_price, base_cost)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(product_id)
        .bind(category_id)
        .bind("Wedding Group Pay Regression Product")
        .bind(Decimal::new(10000, 2))
        .bind(Decimal::new(4000, 2))
        .execute(&pool)
        .await
        .expect("insert product");

        sqlx::query(
            r#"
            INSERT INTO product_variants (id, product_id, sku, variation_values, stock_on_hand)
            VALUES ($1, $2, $3, '{}'::jsonb, 0)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(&sku)
        .execute(&pool)
        .await
        .expect("insert variant");

        let suffix = Uuid::new_v4().simple().to_string();
        let beneficiary_customer_id = insert_customer(
            &pool,
            InsertCustomerParams {
                customer_code: None,
                first_name: "Wedding".to_string(),
                last_name: format!("Beneficiary {}", &suffix[0..8]),
                company_name: None,
                email: Some(format!("wed-beneficiary-{suffix}@example.test")),
                phone: Some(format!("555{}", &suffix[0..7])),
                address_line1: None,
                address_line2: None,
                city: None,
                state: None,
                postal_code: None,
                date_of_birth: None,
                anniversary_date: None,
                custom_field_1: None,
                custom_field_2: None,
                custom_field_3: None,
                custom_field_4: None,
                marketing_email_opt_in: false,
                marketing_sms_opt_in: false,
                transactional_sms_opt_in: true,
                transactional_email_opt_in: true,
                customer_created_source: CustomerCreatedSource::Store,
            },
        )
        .await
        .expect("insert beneficiary customer");
        let payer_customer_id = insert_customer(
            &pool,
            InsertCustomerParams {
                customer_code: None,
                first_name: "Wedding".to_string(),
                last_name: format!("Payer {}", &suffix[0..8]),
                company_name: None,
                email: Some(format!("wed-payer-{suffix}@example.test")),
                phone: Some(format!("556{}", &suffix[0..7])),
                address_line1: None,
                address_line2: None,
                city: None,
                state: None,
                postal_code: None,
                date_of_birth: None,
                anniversary_date: None,
                custom_field_1: None,
                custom_field_2: None,
                custom_field_3: None,
                custom_field_4: None,
                marketing_email_opt_in: false,
                marketing_sms_opt_in: false,
                transactional_sms_opt_in: true,
                transactional_email_opt_in: true,
                customer_created_source: CustomerCreatedSource::Store,
            },
        )
        .await
        .expect("insert payer customer");

        sqlx::query(
            r#"
            INSERT INTO wedding_parties (id, party_name, groom_name, event_date, party_type, is_deleted)
            VALUES ($1, $2, $3, $4, 'Wedding', FALSE)
            "#,
        )
        .bind(party_id)
        .bind("Wedding Group Pay Regression Party")
        .bind("Regression Groom")
        .bind(chrono::NaiveDate::from_ymd_opt(2027, 1, 10).unwrap())
        .execute(&pool)
        .await
        .expect("insert wedding party");

        sqlx::query(
            r#"
            INSERT INTO wedding_members (
                id, wedding_party_id, customer_id, role, status, member_index
            )
            VALUES ($1, $2, $3, 'Groomsman', 'active', 1)
            "#,
        )
        .bind(member_id)
        .bind(party_id)
        .bind(beneficiary_customer_id)
        .execute(&pool)
        .await
        .expect("insert wedding member");

        let order_payload = CheckoutRequest {
            session_id,
            operator_staff_id: staff_id,
            primary_salesperson_id: Some(staff_id),
            customer_id: Some(beneficiary_customer_id),
            wedding_member_id: Some(member_id),
            payment_method: "cash".to_string(),
            total_price: Decimal::new(10000, 2),
            amount_paid: Decimal::ZERO,
            items: vec![CheckoutItem {
                client_line_id: Some("wedding-order-line-1".to_string()),
                line_type: None,
                alteration_intake_id: None,
                product_id,
                variant_id,
                fulfillment: DbFulfillmentType::WeddingOrder,
                quantity: 1,
                unit_price: Decimal::new(10000, 2),
                original_unit_price: None,
                price_override_reason: None,
                unit_cost: Decimal::new(4000, 2),
                state_tax: Decimal::ZERO,
                local_tax: Decimal::ZERO,
                tax_category_override: None,
                salesperson_id: Some(staff_id),
                discount_event_id: None,
                gift_card_load_code: None,
                custom_item_type: None,
                custom_order_details: None,
                is_rush: false,
                need_by_date: None,
                needs_gift_wrap: false,
                order_lifecycle_status: None,
            }],
            alteration_intakes: vec![],
            actor_name: Some("Wedding Group Pay Test".to_string()),
            payment_splits: Some(vec![]),
            wedding_disbursements: None,
            order_payments: vec![],
            below_cost_approval: None,
            checkout_client_id: Some(Uuid::new_v4()),
            shipping_rate_quote_id: None,
            shipping_links: vec![],
            fulfillment_mode: None,
            ship_to: None,
            target_transaction_id: None,
            booked_at_local: None,
            backdate_approval: None,
            is_rush: false,
            need_by_date: None,
            is_tax_exempt: true,
            tax_exempt_reason: Some("test tax-exempt checkout".to_string()),
            rounding_adjustment: None,
            final_cash_due: None,
            is_processing: false,
            exchange_settlement: None,
        };

        let order_transaction_id =
            match execute_checkout(&pool, &reqwest::Client::new(), Decimal::ZERO, order_payload)
                .await
            {
                Ok(CheckoutDone::Completed { transaction_id, .. }) => transaction_id,
                other => {
                    cleanup_wedding_group_pay_checkout_test(
                        &pool,
                        &[],
                        session_id,
                        staff_id,
                        product_id,
                        variant_id,
                        category_id,
                        party_id,
                        member_id,
                        beneficiary_customer_id,
                        payer_customer_id,
                    )
                    .await
                    .expect("cleanup after order checkout failure");
                    panic!("wedding order checkout should complete: {other:?}");
                }
            };

        let group_pay_payload = CheckoutRequest {
            session_id,
            operator_staff_id: staff_id,
            primary_salesperson_id: Some(staff_id),
            customer_id: Some(payer_customer_id),
            wedding_member_id: None,
            payment_method: "cash".to_string(),
            total_price: Decimal::ZERO,
            amount_paid: Decimal::new(5000, 2),
            items: vec![],
            alteration_intakes: vec![],
            actor_name: Some("Wedding Group Pay Test".to_string()),
            payment_splits: Some(vec![CheckoutPaymentSplit {
                payment_method: "cash".to_string(),
                amount: Decimal::new(5000, 2),
                sub_type: None,
                applied_deposit_amount: None,
                gift_card_code: None,
                check_number: None,
                metadata: None,
            }]),
            wedding_disbursements: Some(vec![WeddingDisbursement {
                wedding_member_id: member_id,
                amount: Decimal::new(5000, 2),
            }]),
            order_payments: vec![],
            below_cost_approval: None,
            checkout_client_id: Some(Uuid::new_v4()),
            shipping_rate_quote_id: None,
            shipping_links: vec![],
            fulfillment_mode: None,
            ship_to: None,
            target_transaction_id: None,
            booked_at_local: None,
            backdate_approval: None,
            is_rush: false,
            need_by_date: None,
            is_tax_exempt: true,
            tax_exempt_reason: Some("test tax-exempt checkout".to_string()),
            rounding_adjustment: None,
            final_cash_due: None,
            is_processing: false,
            exchange_settlement: None,
        };

        let group_pay_transaction_id = match execute_checkout(
            &pool,
            &reqwest::Client::new(),
            Decimal::ZERO,
            group_pay_payload,
        )
        .await
        {
            Ok(CheckoutDone::Completed { transaction_id, .. }) => transaction_id,
            other => {
                cleanup_wedding_group_pay_checkout_test(
                    &pool,
                    &[order_transaction_id],
                    session_id,
                    staff_id,
                    product_id,
                    variant_id,
                    category_id,
                    party_id,
                    member_id,
                    beneficiary_customer_id,
                    payer_customer_id,
                )
                .await
                .expect("cleanup after group pay checkout failure");
                panic!("wedding group pay checkout should complete: {other:?}");
            }
        };

        let (amount_paid, balance_due): (Decimal, Decimal) =
            sqlx::query_as("SELECT amount_paid, balance_due FROM transactions WHERE id = $1")
                .bind(order_transaction_id)
                .fetch_one(&pool)
                .await
                .expect("fetch beneficiary transaction totals");
        assert_eq!(amount_paid, Decimal::new(5000, 2));
        assert_eq!(balance_due, Decimal::new(5000, 2));

        let (allocated, applied_deposit): (Option<Decimal>, Option<Decimal>) = sqlx::query_as(
            r#"
            SELECT
                COALESCE(SUM(amount_allocated), 0::numeric),
                COALESCE(SUM((metadata->>'applied_deposit_amount')::numeric(14,2)), 0::numeric)
            FROM payment_allocations
            WHERE target_transaction_id = $1
            "#,
        )
        .bind(order_transaction_id)
        .fetch_one(&pool)
        .await
        .expect("fetch beneficiary payment allocation totals");
        assert_eq!(allocated.unwrap_or(Decimal::ZERO), Decimal::new(5000, 2));
        assert_eq!(
            applied_deposit.unwrap_or(Decimal::ZERO),
            Decimal::new(5000, 2)
        );

        let beneficiary_timeline =
            crate::api::customers::build_customer_timeline(&pool, beneficiary_customer_id)
                .await
                .expect("build beneficiary customer timeline");
        assert!(beneficiary_timeline.iter().any(|event| {
            event.kind == "payment"
                && event.reference_type.as_deref() == Some("transaction")
                && event.reference_id == Some(order_transaction_id)
                && event.summary == "Payment recorded: 50.00 via Cash"
        }));

        cleanup_wedding_group_pay_checkout_test(
            &pool,
            &[order_transaction_id, group_pay_transaction_id],
            session_id,
            staff_id,
            product_id,
            variant_id,
            category_id,
            party_id,
            member_id,
            beneficiary_customer_id,
            payer_customer_id,
        )
        .await
        .expect("cleanup wedding group pay checkout test");
    }

    #[tokio::test]
    async fn execute_checkout_preserves_open_deposit_group_pay_tender_sources() {
        let Ok(database_url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect test database");

        let staff_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let category_id = Uuid::new_v4();
        let product_id = Uuid::new_v4();
        let variant_id = Uuid::new_v4();
        let party_id = Uuid::new_v4();
        let payer_customer_id = Uuid::new_v4();
        let first_customer_id = Uuid::new_v4();
        let second_customer_id = Uuid::new_v4();
        let payer_member_id = Uuid::new_v4();
        let first_member_id = Uuid::new_v4();
        let second_member_id = Uuid::new_v4();
        let liability_account_id = format!("test-liability-deposit-{}", Uuid::new_v4().simple());
        let sku = format!("E2E-WED-OPEN-DEP-{}", Uuid::new_v4().simple());

        let register_lane: i16 = sqlx::query_scalar(
            r#"
            SELECT gs.lane::smallint
            FROM generate_series(1, 99) AS gs(lane)
            WHERE NOT EXISTS (
                SELECT 1
                FROM register_sessions rs
                WHERE rs.is_open = TRUE AND rs.register_lane = gs.lane
            )
            LIMIT 1
            "#,
        )
        .fetch_one(&pool)
        .await
        .expect("find open register lane for checkout test");

        sqlx::query(
            r#"
            INSERT INTO staff (
                id, full_name, cashier_code, base_commission_rate,
                role, max_discount_percent
            )
            VALUES ($1, $2, $3, $4, 'admin'::staff_role, $5)
            "#,
        )
        .bind(staff_id)
        .bind("Wedding Open Deposit Source Regression Staff")
        .bind(format!("O{}", &staff_id.simple().to_string()[0..8]))
        .bind(Decimal::new(200, 4))
        .bind(Decimal::new(10000, 2))
        .execute(&pool)
        .await
        .expect("insert staff");

        sqlx::query(
            r#"
            INSERT INTO register_sessions (
                id, opened_by, opening_float, is_open, register_lane, till_close_group_id
            )
            VALUES ($1, $2, 0, TRUE, $3, $4)
            "#,
        )
        .bind(session_id)
        .bind(staff_id)
        .bind(register_lane)
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .expect("insert register session");

        sqlx::query(
            r#"
            INSERT INTO categories (id, name, is_clothing_footwear)
            VALUES ($1, $2, FALSE)
            "#,
        )
        .bind(category_id)
        .bind(format!(
            "Wedding Open Deposit Regression {}",
            category_id.simple()
        ))
        .execute(&pool)
        .await
        .expect("insert category");
        sqlx::query(
            r#"
            INSERT INTO products (id, category_id, name, base_retail_price, base_cost)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(product_id)
        .bind(category_id)
        .bind("Wedding Open Deposit Redemption Product")
        .bind(Decimal::new(7500, 2))
        .bind(Decimal::new(3000, 2))
        .execute(&pool)
        .await
        .expect("insert product");
        sqlx::query(
            r#"
            INSERT INTO product_variants (id, product_id, sku, variation_values, stock_on_hand)
            VALUES ($1, $2, $3, '{}'::jsonb, 1)
            "#,
        )
        .bind(variant_id)
        .bind(product_id)
        .bind(&sku)
        .execute(&pool)
        .await
        .expect("insert variant");

        for (id, first, last) in [
            (payer_customer_id, "Wedding", "Open Deposit Payer"),
            (first_customer_id, "Wedding", "Open Deposit First"),
            (second_customer_id, "Wedding", "Open Deposit Second"),
        ] {
            sqlx::query(
                r#"
                INSERT INTO customers (
                    id, customer_code, first_name, last_name, email, customer_created_source,
                    marketing_email_opt_in, marketing_sms_opt_in,
                    transactional_sms_opt_in, transactional_email_opt_in
                )
                VALUES ($1, $2, $3, $4, $5, 'store', FALSE, FALSE, TRUE, TRUE)
                "#,
            )
            .bind(id)
            .bind(format!("TST-{}", id.simple()))
            .bind(first)
            .bind(format!("{} {}", last, id.simple()))
            .bind(format!("{}@example.test", id.simple()))
            .execute(&pool)
            .await
            .expect("insert customer");
        }

        sqlx::query(
            r#"
            INSERT INTO wedding_parties (id, party_name, groom_name, event_date, party_type, is_deleted)
            VALUES ($1, $2, $3, $4, 'Wedding', FALSE)
            "#,
        )
        .bind(party_id)
        .bind("Wedding Open Deposit Source Regression Party")
        .bind("Regression Groom")
        .bind(chrono::NaiveDate::from_ymd_opt(2027, 2, 14).unwrap())
        .execute(&pool)
        .await
        .expect("insert wedding party");

        for (member_id, customer_id, role, member_index) in [
            (payer_member_id, payer_customer_id, "Groom", 1),
            (first_member_id, first_customer_id, "Groomsman", 2),
            (second_member_id, second_customer_id, "Groomsman", 3),
        ] {
            sqlx::query(
                r#"
                INSERT INTO wedding_members (
                    id, wedding_party_id, customer_id, role, status, member_index
                )
                VALUES ($1, $2, $3, $4, 'active', $5)
                "#,
            )
            .bind(member_id)
            .bind(party_id)
            .bind(customer_id)
            .bind(role)
            .bind(member_index)
            .execute(&pool)
            .await
            .expect("insert wedding member");
        }

        sqlx::query(
            r#"
            INSERT INTO qbo_accounts_cache (id, name, account_type)
            VALUES ($1, 'Test Deposit Liability', 'Other Current Liability')
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(&liability_account_id)
        .execute(&pool)
        .await
        .expect("insert test qbo account");
        sqlx::query(
            r#"
            INSERT INTO qbo_mappings (source_type, source_id, qbo_account_id, qbo_account_name)
            VALUES ('liability_deposit', 'default', $1, 'Test Deposit Liability')
            ON CONFLICT (source_type, source_id) DO NOTHING
            "#,
        )
        .bind(&liability_account_id)
        .execute(&pool)
        .await
        .expect("insert test qbo mapping");

        let group_pay_payload = CheckoutRequest {
            session_id,
            operator_staff_id: staff_id,
            primary_salesperson_id: Some(staff_id),
            customer_id: Some(payer_customer_id),
            wedding_member_id: Some(payer_member_id),
            payment_method: "split".to_string(),
            total_price: Decimal::ZERO,
            amount_paid: Decimal::new(20000, 2),
            items: vec![],
            alteration_intakes: vec![],
            actor_name: Some("Wedding Open Deposit Source Test".to_string()),
            payment_splits: Some(vec![
                CheckoutPaymentSplit {
                    payment_method: "cash".to_string(),
                    amount: Decimal::new(10000, 2),
                    sub_type: None,
                    applied_deposit_amount: None,
                    gift_card_code: None,
                    check_number: None,
                    metadata: None,
                },
                CheckoutPaymentSplit {
                    payment_method: "card".to_string(),
                    amount: Decimal::new(10000, 2),
                    sub_type: None,
                    applied_deposit_amount: None,
                    gift_card_code: None,
                    check_number: None,
                    metadata: None,
                },
            ]),
            wedding_disbursements: Some(vec![
                WeddingDisbursement {
                    wedding_member_id: first_member_id,
                    amount: Decimal::new(7500, 2),
                },
                WeddingDisbursement {
                    wedding_member_id: second_member_id,
                    amount: Decimal::new(12500, 2),
                },
            ]),
            order_payments: vec![],
            below_cost_approval: None,
            checkout_client_id: Some(Uuid::new_v4()),
            shipping_rate_quote_id: None,
            shipping_links: vec![],
            fulfillment_mode: None,
            ship_to: None,
            target_transaction_id: None,
            booked_at_local: None,
            backdate_approval: None,
            is_rush: false,
            need_by_date: None,
            is_tax_exempt: true,
            tax_exempt_reason: Some("test tax-exempt checkout".to_string()),
            rounding_adjustment: None,
            final_cash_due: None,
            is_processing: false,
            exchange_settlement: None,
        };

        let group_pay_transaction_id = match execute_checkout(
            &pool,
            &reqwest::Client::new(),
            Decimal::ZERO,
            group_pay_payload,
        )
        .await
        {
            Ok(CheckoutDone::Completed { transaction_id, .. }) => transaction_id,
            other => panic!("wedding open-deposit group pay should complete: {other:?}"),
        };

        let source_rows: Vec<(Uuid, String, Decimal, i64, bool)> = sqlx::query_as(
            r#"
            SELECT
                codls.beneficiary_wedding_member_id,
                pt.payment_method,
                SUM(codls.amount)::numeric(14,2) AS amount,
                COUNT(DISTINCT codls.source_payment_transaction_id)::bigint AS source_count,
                BOOL_AND(codls.payer_wedding_member_id = $1) AS payer_linked
            FROM customer_open_deposit_ledger_sources codls
            JOIN customer_open_deposit_ledger codl ON codl.id = codls.ledger_id
            JOIN payment_transactions pt ON pt.id = codls.source_payment_transaction_id
            WHERE codl.transaction_id = $2
            GROUP BY codls.beneficiary_wedding_member_id, pt.payment_method
            ORDER BY codls.beneficiary_wedding_member_id, pt.payment_method
            "#,
        )
        .bind(payer_member_id)
        .bind(group_pay_transaction_id)
        .fetch_all(&pool)
        .await
        .expect("fetch open-deposit source rows");
        assert_eq!(source_rows.len(), 3);
        assert!(source_rows
            .iter()
            .all(|(_, _, _, _, payer_linked)| *payer_linked));
        assert!(source_rows.iter().any(|(member_id, method, amount, _, _)| {
            *member_id == first_member_id && method == "cash" && *amount == Decimal::new(7500, 2)
        }));
        assert!(source_rows.iter().any(|(member_id, method, amount, _, _)| {
            *member_id == second_member_id && method == "cash" && *amount == Decimal::new(2500, 2)
        }));
        assert!(source_rows.iter().any(|(member_id, method, amount, _, _)| {
            *member_id == second_member_id && method == "card" && *amount == Decimal::new(10000, 2)
        }));

        let source_payers: Vec<Option<Uuid>> = sqlx::query_scalar(
            r#"
            SELECT DISTINCT pt.payer_id
            FROM payment_transactions pt
            WHERE pt.id IN (
                SELECT codls.source_payment_transaction_id
                FROM customer_open_deposit_ledger_sources codls
                JOIN customer_open_deposit_ledger codl ON codl.id = codls.ledger_id
                WHERE codl.transaction_id = $1
            )
            "#,
        )
        .bind(group_pay_transaction_id)
        .fetch_all(&pool)
        .await
        .expect("fetch group-pay source payer links");
        assert_eq!(source_payers, vec![Some(payer_customer_id)]);

        let party_financial_context =
            crate::logic::wedding_queries::try_load_party_financial_context(&pool, party_id)
                .await
                .expect("load party financial context")
                .expect("party financial context exists");
        assert_eq!(
            party_financial_context.summary.total_paid,
            Decimal::new(20000, 2)
        );
        assert!(party_financial_context.members.iter().any(|member| {
            member.wedding_member_id == first_member_id
                && member.paid_total == Decimal::new(7500, 2)
                && member.payment_count == 1
        }));
        assert!(party_financial_context.members.iter().any(|member| {
            member.wedding_member_id == second_member_id
                && member.paid_total == Decimal::new(12500, 2)
                && member.payment_count == 2
        }));

        let party_readiness =
            crate::logic::wedding_health::calculate_wedding_readiness(&pool, party_id)
                .await
                .expect("load party readiness with deposit contributions");
        assert_eq!(
            party_readiness.summary.deposit_contributions.total,
            Decimal::new(20000, 2)
        );
        assert_eq!(
            party_readiness.summary.deposit_contributions.funded_members,
            2
        );

        let payer_timeline =
            crate::api::customers::build_customer_timeline(&pool, payer_customer_id)
                .await
                .expect("build group-pay payer timeline");
        assert!(payer_timeline.iter().any(|event| {
            event.reference_type.as_deref() == Some("wedding_deposit_contribution")
                && event.summary.contains("Wedding deposits placed: $200.00")
                && event.summary.contains("2 party members")
                && event.wedding_party_id == Some(party_id)
        }));

        let disbursement_allocation_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint
            FROM payment_allocations
            WHERE transaction_id IN (
                SELECT source_payment_transaction_id
                FROM customer_open_deposit_ledger_sources codls
                JOIN customer_open_deposit_ledger codl ON codl.id = codls.ledger_id
                WHERE codl.transaction_id = $1
            )
              AND metadata->>'kind' = 'wedding_group_disbursement'
            "#,
        )
        .bind(group_pay_transaction_id)
        .fetch_one(&pool)
        .await
        .expect("count no-order disbursement allocations");
        assert_eq!(disbursement_allocation_count, 0);

        let balances: Vec<(Uuid, Decimal)> = sqlx::query_as(
            r#"
            SELECT a.customer_id, a.balance
            FROM customer_open_deposit_accounts a
            WHERE a.customer_id = ANY($1)
            ORDER BY a.customer_id
            "#,
        )
        .bind(vec![first_customer_id, second_customer_id])
        .fetch_all(&pool)
        .await
        .expect("fetch open-deposit balances");
        assert!(balances.iter().any(|(customer_id, balance)| {
            *customer_id == first_customer_id && *balance == Decimal::new(7500, 2)
        }));
        assert!(balances.iter().any(|(customer_id, balance)| {
            *customer_id == second_customer_id && *balance == Decimal::new(12500, 2)
        }));

        let first_beneficiary_timeline =
            crate::api::customers::build_customer_timeline(&pool, first_customer_id)
                .await
                .expect("build first open-deposit beneficiary timeline");
        assert!(first_beneficiary_timeline.iter().any(|event| {
            event.reference_type.as_deref() == Some("open_deposit")
                && event.summary.contains("Wedding deposit received: $75.00")
                && event.summary.contains("from Wedding Open Deposit Payer")
                && event.wedding_party_id == Some(party_id)
        }));
        let first_beneficiary_hub_stats =
            crate::logic::customer_hub::fetch_hub_stats(&pool, first_customer_id)
                .await
                .expect("fetch first open-deposit beneficiary hub stats");
        assert!(first_beneficiary_hub_stats.last_activity_at.is_some());

        let activity_date: chrono::NaiveDate = sqlx::query_scalar(
            "SELECT (CURRENT_TIMESTAMP AT TIME ZONE reporting.effective_store_timezone())::date",
        )
        .fetch_one(&pool)
        .await
        .expect("fetch activity date");
        let proposal = qbo_journal::propose_daily_journal(&pool, activity_date)
            .await
            .expect("propose qbo journal");
        let deposit_line = proposal
            .lines
            .iter()
            .find(|line| line.memo == "New deposits received (liability increase)")
            .expect("new deposit liability line");
        assert!(deposit_line.credit >= Decimal::new(20000, 2));
        let detail = &deposit_line.detail[0];
        let open_deposit_party_split_amount: Decimal = serde_json::from_value(
            detail
                .get("open_deposit_party_split_amount")
                .expect("open deposit party split amount in qbo detail")
                .clone(),
        )
        .expect("parse open deposit party split amount");
        assert!(open_deposit_party_split_amount >= Decimal::new(20000, 2));
        let group_pay_transaction_id_text = group_pay_transaction_id.to_string();
        let matching_sources = detail
            .get("open_deposit_sources")
            .and_then(|v| v.as_array())
            .expect("open deposit source rows")
            .iter()
            .filter(|source| {
                source.get("source_transaction_id").and_then(|v| v.as_str())
                    == Some(group_pay_transaction_id_text.as_str())
            })
            .collect::<Vec<_>>();
        assert_eq!(
            matching_sources.len(),
            3,
            "the group-pay transaction should preserve all three tender source rows"
        );
        let matching_source_total = matching_sources
            .iter()
            .map(|source| {
                serde_json::from_value::<Decimal>(
                    source
                        .get("amount")
                        .expect("open deposit source amount")
                        .clone(),
                )
                .expect("parse open deposit source amount")
            })
            .sum::<Decimal>();
        assert_eq!(matching_source_total, Decimal::new(20000, 2));

        let redemption_payload = CheckoutRequest {
            session_id,
            operator_staff_id: staff_id,
            primary_salesperson_id: Some(staff_id),
            customer_id: Some(first_customer_id),
            wedding_member_id: Some(first_member_id),
            payment_method: "open_deposit".to_string(),
            total_price: Decimal::new(7500, 2),
            amount_paid: Decimal::new(7500, 2),
            items: vec![CheckoutItem {
                client_line_id: Some("open-deposit-redemption-line".to_string()),
                line_type: None,
                alteration_intake_id: None,
                product_id,
                variant_id,
                fulfillment: DbFulfillmentType::WeddingOrder,
                quantity: 1,
                unit_price: Decimal::new(7500, 2),
                original_unit_price: None,
                price_override_reason: None,
                unit_cost: Decimal::new(3000, 2),
                state_tax: Decimal::ZERO,
                local_tax: Decimal::ZERO,
                tax_category_override: None,
                salesperson_id: Some(staff_id),
                discount_event_id: None,
                gift_card_load_code: None,
                custom_item_type: None,
                custom_order_details: None,
                is_rush: false,
                need_by_date: None,
                needs_gift_wrap: false,
                order_lifecycle_status: None,
            }],
            alteration_intakes: vec![],
            actor_name: Some("Wedding Open Deposit Source Test".to_string()),
            payment_splits: Some(vec![CheckoutPaymentSplit {
                payment_method: "open_deposit".to_string(),
                amount: Decimal::new(7500, 2),
                sub_type: None,
                applied_deposit_amount: None,
                gift_card_code: None,
                check_number: None,
                metadata: None,
            }]),
            wedding_disbursements: None,
            order_payments: vec![],
            below_cost_approval: None,
            checkout_client_id: Some(Uuid::new_v4()),
            shipping_rate_quote_id: None,
            shipping_links: vec![],
            fulfillment_mode: None,
            ship_to: None,
            target_transaction_id: None,
            booked_at_local: None,
            backdate_approval: None,
            is_rush: false,
            need_by_date: None,
            is_tax_exempt: true,
            tax_exempt_reason: Some("test tax-exempt checkout".to_string()),
            rounding_adjustment: None,
            final_cash_due: None,
            is_processing: false,
            exchange_settlement: None,
        };

        let redemption_transaction_id = match execute_checkout(
            &pool,
            &reqwest::Client::new(),
            Decimal::ZERO,
            redemption_payload,
        )
        .await
        {
            Ok(CheckoutDone::Completed { transaction_id, .. }) => transaction_id,
            other => panic!("open-deposit redemption checkout should complete: {other:?}"),
        };

        let first_balance_after: Decimal = sqlx::query_scalar(
            "SELECT balance FROM customer_open_deposit_accounts WHERE customer_id = $1",
        )
        .bind(first_customer_id)
        .fetch_one(&pool)
        .await
        .expect("fetch first beneficiary open deposit after redemption");
        assert_eq!(first_balance_after, Decimal::ZERO);

        let redemption_payment_transaction_id: Uuid = sqlx::query_scalar(
            r#"
            SELECT id
            FROM payment_transactions
            WHERE payment_method = 'open_deposit'
              AND metadata->>'checkout_transaction_id' = $1
              AND amount = 75.00
            "#,
        )
        .bind(redemption_transaction_id.to_string())
        .fetch_one(&pool)
        .await
        .expect("fetch financially recorded open-deposit payment transaction");

        let (ledger_amount, ledger_balance_after, ledger_transaction_id): (
            Decimal,
            Decimal,
            Option<Uuid>,
        ) = sqlx::query_as(
            r#"
            SELECT l.amount, l.balance_after, l.transaction_id
            FROM customer_open_deposit_ledger l
            JOIN customer_open_deposit_accounts a ON a.id = l.account_id
            WHERE a.customer_id = $1
              AND l.reason = 'checkout_redemption'
            ORDER BY l.created_at DESC
            LIMIT 1
            "#,
        )
        .bind(first_customer_id)
        .fetch_one(&pool)
        .await
        .expect("fetch open-deposit redemption ledger entry");
        assert_eq!(ledger_amount, Decimal::new(-7500, 2));
        assert_eq!(ledger_balance_after, Decimal::ZERO);
        assert_eq!(ledger_transaction_id, Some(redemption_transaction_id));

        let booking_day_proposal = qbo_journal::propose_daily_journal(&pool, activity_date)
            .await
            .expect("propose booking-day qbo journal after redemption");
        let redemption_payment_id = redemption_payment_transaction_id.to_string();
        assert!(
            booking_day_proposal.lines.iter().all(|line| {
                line.detail.iter().all(|detail| {
                    !detail
                        .get("payment_transaction_ids")
                        .and_then(|value| value.as_array())
                        .is_some_and(|ids| {
                            ids.iter()
                                .any(|id| id.as_str() == Some(redemption_payment_id.as_str()))
                        })
                })
            }),
            "unfulfilled held-deposit use must remain in deposit liability on booking day"
        );

        let fulfillment_date = activity_date
            .succ_opt()
            .expect("activity date should have a following day");
        sqlx::query(
            r#"
            UPDATE transactions
            SET fulfilled_at = (($2::date + TIME '12:00') AT TIME ZONE reporting.effective_store_timezone()),
                status = 'fulfilled'
            WHERE id = $1
            "#,
        )
        .bind(redemption_transaction_id)
        .bind(fulfillment_date)
        .execute(&pool)
        .await
        .expect("mark held-deposit sale fulfilled on following business date");

        let fulfillment_proposal = qbo_journal::propose_daily_journal(&pool, fulfillment_date)
            .await
            .expect("propose fulfillment-day qbo journal");
        assert!(
            fulfillment_proposal.lines.iter().any(|line| {
                line.memo
                    .starts_with("Deposit release — Wedding Open Deposit Regression")
                    && line.debit == Decimal::new(7500, 2)
            }),
            "fulfillment must debit deposit liability for the redeemed held deposit"
        );

        let mut reversal_tx = pool.begin().await.expect("begin open-deposit reversal");
        let restored_balance = customer_open_deposit::restore_checkout_redemption(
            &mut reversal_tx,
            first_customer_id,
            Decimal::new(7500, 2),
            redemption_transaction_id,
            customer_open_deposit::OpenDepositRestoreReason::TransactionVoid,
        )
        .await
        .expect("restore held deposit after void");
        reversal_tx
            .commit()
            .await
            .expect("commit open-deposit reversal");
        assert_eq!(restored_balance, Decimal::new(7500, 2));
        let restored_ledger: (Decimal, Decimal, String) = sqlx::query_as(
            r#"
            SELECT l.amount, l.balance_after, l.reason
            FROM customer_open_deposit_ledger l
            JOIN customer_open_deposit_accounts a ON a.id = l.account_id
            WHERE a.customer_id = $1
            ORDER BY l.created_at DESC
            LIMIT 1
            "#,
        )
        .bind(first_customer_id)
        .fetch_one(&pool)
        .await
        .expect("fetch held-deposit restoration ledger entry");
        assert_eq!(
            restored_ledger,
            (
                Decimal::new(7500, 2),
                Decimal::new(7500, 2),
                "transaction_void_reversal".to_string()
            )
        );

        cleanup_wedding_group_pay_checkout_test(
            &pool,
            &[group_pay_transaction_id, redemption_transaction_id],
            session_id,
            staff_id,
            product_id,
            variant_id,
            category_id,
            party_id,
            first_member_id,
            first_customer_id,
            payer_customer_id,
        )
        .await
        .expect("cleanup primary wedding open deposit regression rows");
        sqlx::query("DELETE FROM wedding_members WHERE id = ANY($1)")
            .bind(vec![payer_member_id, second_member_id])
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM customers WHERE id = $1")
            .bind(second_customer_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM qbo_mappings WHERE qbo_account_id = $1")
            .bind(&liability_account_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM qbo_accounts_cache WHERE id = $1")
            .bind(&liability_account_id)
            .execute(&pool)
            .await
            .ok();
    }
}
