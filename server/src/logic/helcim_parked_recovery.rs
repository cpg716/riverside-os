//! Guarded recovery of a retained parked cart after Helcim approved the card.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::logic::tax::TaxCategory;
use crate::logic::transaction_checkout::{
    execute_recovery_checkout, BelowCostApproval, CheckoutDone, CheckoutError, CheckoutItem,
    CheckoutPaymentSplit, CheckoutRecoveryContext, CheckoutRequest,
};
use crate::models::{DbFulfillmentType, DbOrderItemLifecycleStatus};

const CONFIRMATION_TEXT: &str = "RECOVER PAID SALE";

pub struct RecoverPaidParkedSaleRequest {
    pub parked_sale_id: Uuid,
    pub payment_provider_attempt_id: Uuid,
    pub authorized_by_staff_id: Uuid,
    pub confirmation: String,
    pub note: String,
}

fn invalid(message: impl Into<String>) -> CheckoutError {
    CheckoutError::InvalidPayload(message.into())
}

fn required_uuid(line: &Value, key: &str) -> Result<Uuid, CheckoutError> {
    line.get(key)
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
        .ok_or_else(|| invalid(format!("Retained cart line is missing {key}")))
}

fn optional_uuid(value: Option<&Value>) -> Option<Uuid> {
    value
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
}

fn decimal(line: &Value, key: &str) -> Result<Decimal, CheckoutError> {
    let value = line
        .get(key)
        .ok_or_else(|| invalid(format!("Retained cart line is missing {key}")))?;
    let raw = value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_f64().map(|number| number.to_string()))
        .ok_or_else(|| invalid(format!("Retained cart line has invalid {key}")))?;
    raw.parse::<Decimal>()
        .map_err(|_| invalid(format!("Retained cart line has invalid {key}")))
}

fn optional_decimal(line: &Value, key: &str) -> Option<Decimal> {
    line.get(key).and_then(|value| {
        value
            .as_str()
            .map(str::to_string)
            .or_else(|| value.as_f64().map(|number| number.to_string()))
            .and_then(|raw| raw.parse::<Decimal>().ok())
    })
}

fn optional_string(line: &Value, key: &str) -> Option<String> {
    line.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn retained_checkout_item(line: &Value) -> Result<CheckoutItem, CheckoutError> {
    let quantity = line
        .get("quantity")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(|| invalid("Retained cart line has invalid quantity"))?;
    let fulfillment = serde_json::from_value::<DbFulfillmentType>(
        line.get("fulfillment")
            .cloned()
            .ok_or_else(|| invalid("Retained cart line is missing fulfillment"))?,
    )
    .map_err(|_| invalid("Retained cart line has invalid fulfillment"))?;
    let tax_category_override = line
        .get("tax_category")
        .cloned()
        .filter(|value| !value.is_null())
        .map(serde_json::from_value::<TaxCategory>)
        .transpose()
        .map_err(|_| invalid("Retained cart line has invalid tax category"))?;
    let order_lifecycle_status = line
        .get("order_lifecycle_status")
        .cloned()
        .filter(|value| !value.is_null())
        .map(serde_json::from_value::<DbOrderItemLifecycleStatus>)
        .transpose()
        .map_err(|_| invalid("Retained cart line has invalid order lifecycle status"))?;

    Ok(CheckoutItem {
        client_line_id: optional_string(line, "cart_row_id"),
        line_type: optional_string(line, "line_type").or_else(|| Some("merchandise".to_string())),
        alteration_intake_id: optional_string(line, "alteration_intake_id"),
        product_id: required_uuid(line, "product_id")?,
        variant_id: required_uuid(line, "variant_id")?,
        fulfillment,
        quantity,
        unit_price: decimal(line, "standard_retail_price")?,
        original_unit_price: optional_decimal(line, "original_unit_price"),
        price_override_reason: optional_string(line, "price_override_reason"),
        unit_cost: decimal(line, "unit_cost")?,
        state_tax: decimal(line, "state_tax")?,
        local_tax: decimal(line, "local_tax")?,
        tax_category_override,
        salesperson_id: optional_uuid(line.get("salesperson_id")),
        discount_event_id: optional_uuid(line.get("discount_event_id")),
        gift_card_load_code: optional_string(line, "gift_card_load_code"),
        custom_item_type: optional_string(line, "custom_item_type"),
        custom_order_details: line
            .get("custom_order_details")
            .cloned()
            .filter(|v| !v.is_null()),
        is_rush: line
            .get("is_rush")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        need_by_date: optional_string(line, "need_by_date")
            .and_then(|value| chrono::NaiveDate::parse_from_str(&value, "%Y-%m-%d").ok()),
        needs_gift_wrap: line
            .get("needs_gift_wrap")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        order_lifecycle_status,
    })
}

pub async fn recover_paid_parked_sale(
    pool: &PgPool,
    http: &reqwest::Client,
    global_employee_markup: Decimal,
    request: RecoverPaidParkedSaleRequest,
) -> Result<CheckoutDone, CheckoutError> {
    if request.confirmation.trim() != CONFIRMATION_TEXT {
        return Err(invalid(format!(
            "Type {CONFIRMATION_TEXT} to confirm this financial recovery"
        )));
    }
    let note = request.note.trim();
    if note.chars().count() < 10 || note.chars().count() > 500 {
        return Err(invalid(
            "Recovery note must be between 10 and 500 characters",
        ));
    }

    let manager_ok =
        crate::logic::pricing_limits::is_admin_or_manager(pool, request.authorized_by_staff_id)
            .await?;
    if !manager_ok {
        return Err(invalid("Paid sale recovery requires Manager Access"));
    }

    let attempt = sqlx::query(
        r#"
        SELECT ppa.status, ppa.amount_cents, ppa.register_session_id, ppa.staff_id,
               ppa.terminal_id, ppa.provider_payment_id, ppa.provider_transaction_id,
               ppa.completed_at, ppa.created_at, staff.full_name
        FROM payment_provider_attempts ppa
        LEFT JOIN staff ON staff.id = ppa.staff_id
        WHERE ppa.id = $1 AND ppa.provider = 'helcim'
        "#,
    )
    .bind(request.payment_provider_attempt_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| invalid("Helcim approval was not found"))?;
    let status = attempt.get::<String, _>("status");
    if !matches!(status.as_str(), "approved" | "captured") {
        return Err(invalid("Helcim payment is not approved"));
    }
    let session_id = attempt
        .get::<Option<Uuid>, _>("register_session_id")
        .ok_or_else(|| invalid("Helcim approval has no register session"))?;
    let operator_staff_id = attempt
        .get::<Option<Uuid>, _>("staff_id")
        .ok_or_else(|| invalid("Helcim approval has no staff attribution"))?;
    let provider_transaction_id = attempt
        .get::<Option<String>, _>("provider_transaction_id")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid("Helcim approval has no provider transaction ID"))?;
    let approved_at = attempt
        .get::<Option<DateTime<Utc>>, _>("completed_at")
        .unwrap_or_else(|| attempt.get::<DateTime<Utc>, _>("created_at"));
    let approved_amount = Decimal::new(attempt.get::<i64, _>("amount_cents"), 2);

    let parked = sqlx::query(
        r#"
        SELECT register_session_id, parked_by_staff_id, customer_id, payload_json, status::text
        FROM pos_parked_sale
        WHERE id = $1
        "#,
    )
    .bind(request.parked_sale_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| invalid("Retained parked sale was not found"))?;
    if parked.get::<Uuid, _>("register_session_id") != session_id {
        return Err(invalid(
            "Parked sale and Helcim approval belong to different register sessions",
        ));
    }
    let parked_status = parked.get::<String, _>("status");
    if !matches!(parked_status.as_str(), "parked" | "deleted") {
        return Err(invalid(
            "Parked sale has already been recalled or recovered",
        ));
    }
    let customer_id = parked
        .get::<Option<Uuid>, _>("customer_id")
        .ok_or_else(|| invalid("Parked sale has no linked customer"))?;
    let payload_json = parked.get::<Value, _>("payload_json");
    if payload_json
        .get("activeWeddingMember")
        .is_some_and(|value| !value.is_null())
        || payload_json
            .get("disbursementMembers")
            .and_then(Value::as_array)
            .is_some_and(|values| !values.is_empty())
    {
        return Err(invalid(
            "Wedding payment recovery requires the Wedding payment workflow",
        ));
    }
    let retained_lines = payload_json
        .get("lines")
        .and_then(Value::as_array)
        .filter(|lines| !lines.is_empty())
        .ok_or_else(|| invalid("Retained parked sale has no cart lines"))?;
    let items = retained_lines
        .iter()
        .map(retained_checkout_item)
        .collect::<Result<Vec<_>, _>>()?;
    if items
        .iter()
        .any(|item| item.line_type.as_deref() == Some("alteration_service"))
    {
        return Err(invalid(
            "Alteration-service recovery requires its original intake data",
        ));
    }
    let cart_total = items.iter().fold(Decimal::ZERO, |sum, item| {
        sum + (item.unit_price + item.state_tax + item.local_tax) * Decimal::from(item.quantity)
    });
    if cart_total.round_dp(2) != approved_amount.round_dp(2) {
        return Err(invalid(format!(
            "Retained cart total ${:.2} does not match Helcim approval ${:.2}",
            cart_total, approved_amount
        )));
    }

    let batch = sqlx::query(
        r#"
        SELECT gross_amount, payment_transaction_id
        FROM payment_provider_batch_transactions
        WHERE provider = 'helcim' AND provider_transaction_id = $1
        "#,
    )
    .bind(&provider_transaction_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| invalid("Helcim processor transaction has not been synchronized"))?;
    if batch
        .get::<Option<Uuid>, _>("payment_transaction_id")
        .is_some()
    {
        return Err(invalid("Helcim processor transaction is already linked"));
    }
    let processor_amount = batch
        .get::<Option<Decimal>, _>("gross_amount")
        .ok_or_else(|| invalid("Helcim processor transaction has no amount"))?;
    if processor_amount.abs().round_dp(2) != approved_amount.abs().round_dp(2) {
        return Err(invalid(
            "Helcim synchronized amount does not match the approval",
        ));
    }

    let primary_salesperson_id = optional_uuid(payload_json.get("primarySalespersonId"));
    let booked_at_local = approved_at
        .with_timezone(&chrono_tz::America::New_York)
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    let payment_metadata = json!({
        "payment_provider": "helcim",
        "payment_provider_attempt_id": request.payment_provider_attempt_id,
        "provider_status": status,
        "provider_payment_id": attempt.get::<Option<String>, _>("provider_payment_id"),
        "provider_transaction_id": provider_transaction_id,
        "provider_terminal_id": attempt.get::<Option<String>, _>("terminal_id"),
        "recovered_from_parked_sale_id": request.parked_sale_id,
        "recovery_authorized_by_staff_id": request.authorized_by_staff_id,
    });

    let checkout = CheckoutRequest {
        session_id,
        operator_staff_id,
        primary_salesperson_id,
        customer_id: Some(customer_id),
        wedding_member_id: None,
        payment_method: "card_terminal".to_string(),
        total_price: approved_amount,
        amount_paid: approved_amount,
        items,
        alteration_intakes: Vec::new(),
        actor_name: attempt.get::<Option<String>, _>("full_name"),
        payment_splits: Some(vec![CheckoutPaymentSplit {
            payment_method: "card_terminal".to_string(),
            amount: approved_amount,
            sub_type: None,
            applied_deposit_amount: None,
            gift_card_code: None,
            check_number: None,
            metadata: Some(payment_metadata),
        }]),
        wedding_disbursements: None,
        order_payments: Vec::new(),
        below_cost_approval: Some(BelowCostApproval {
            approved_by_staff_id: request.authorized_by_staff_id,
            reason: Some(note.to_string()),
            line_signature: None,
        }),
        checkout_client_id: Some(request.parked_sale_id),
        booked_at_local: Some(booked_at_local),
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
    };

    execute_recovery_checkout(
        pool,
        http,
        global_employee_markup,
        checkout,
        CheckoutRecoveryContext {
            parked_sale_id: request.parked_sale_id,
            payment_provider_attempt_id: request.payment_provider_attempt_id,
            authorized_by_staff_id: request.authorized_by_staff_id,
            approved_at,
            note: note.to_string(),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebuilds_retained_cart_line_without_changing_money() {
        let line = json!({
            "cart_row_id": "line-1",
            "product_id": "11111111-1111-4111-8111-111111111111",
            "variant_id": "22222222-2222-4222-8222-222222222222",
            "fulfillment": "special_order",
            "quantity": 1,
            "standard_retail_price": "260.00",
            "original_unit_price": "375.00",
            "price_override_reason": "Manual override",
            "unit_cost": "117.90",
            "state_tax": "10.40",
            "local_tax": "12.35",
            "tax_category": "clothing",
            "salesperson_id": "33333333-3333-4333-8333-333333333333"
        });

        let item = retained_checkout_item(&line).expect("retained line should rebuild");

        assert_eq!(item.unit_price, Decimal::new(26000, 2));
        assert_eq!(item.original_unit_price, Some(Decimal::new(37500, 2)));
        assert_eq!(item.state_tax + item.local_tax, Decimal::new(2275, 2));
        assert_eq!(
            item.unit_price + item.state_tax + item.local_tax,
            Decimal::new(28275, 2)
        );
        assert_eq!(item.fulfillment, DbFulfillmentType::SpecialOrder);
    }

    #[test]
    fn rejects_retained_line_with_missing_financial_fields() {
        let line = json!({
            "product_id": "11111111-1111-4111-8111-111111111111",
            "variant_id": "22222222-2222-4222-8222-222222222222",
            "fulfillment": "takeaway",
            "quantity": 1
        });

        assert!(retained_checkout_item(&line).is_err());
    }
}
