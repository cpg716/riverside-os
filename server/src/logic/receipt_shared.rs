//! Shared receipt data types and helpers.
//! Note: This module provides a unified data contract for all receipt formats.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use uuid::Uuid;

use crate::models::{DbFulfillmentType, DbOrderFulfillmentMethod, DbOrderStatus};

pub fn order_status_label(s: DbOrderStatus) -> &'static str {
    match s {
        DbOrderStatus::Open => "Open Order",
        DbOrderStatus::Fulfilled => "Fulfilled",
        DbOrderStatus::Cancelled => "Cancelled",
        DbOrderStatus::PendingMeasurement => "Waiting on Measurements",
        DbOrderStatus::Processing => "Processing",
    }
}

#[derive(Debug, Clone)]
pub struct ReceiptCustomerLine {
    pub display_name: String,
    pub phone: Option<String>,
    pub customer_code: Option<String>,
}

impl ReceiptCustomerLine {
    pub fn identity_lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        let name = self.display_name.trim();
        if !name.is_empty() {
            lines.push(format!("Customer: {name}"));
        }
        if let Some(phone) = self
            .phone
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            lines.push(format!("Phone: {phone}"));
        }
        if let Some(code) = self
            .customer_code
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            lines.push(format!("Customer #: {code}"));
        }
        lines
    }

    pub fn identity_summary(&self) -> String {
        self.identity_lines().join(" | ")
    }
}

#[derive(Debug, Clone)]
pub struct ReceiptLine {
    pub product_name: String,
    pub sku: String,
    pub quantity: i32,
    pub unit_price: Decimal,
    pub fulfillment: DbFulfillmentType,
    pub salesperson_name: Option<String>,
    pub variation_label: Option<String>,
    /// Regular / pre-discount unit price when checkout stored an override in `size_specs`.
    pub original_unit_price: Option<Decimal>,
    /// Discount event label from `size_specs`, when set.
    pub discount_event_label: Option<String>,
    pub custom_order_details: Option<serde_json::Value>,
    pub is_fulfilled: bool,
}

#[derive(Debug, Clone)]
pub struct ReceiptPaymentApplication {
    pub target_display_id: String,
    pub amount: Decimal,
    pub remaining_balance: Decimal,
}

#[derive(Debug, Clone)]
pub struct ReceiptPayment {
    pub date: DateTime<Utc>,
    pub method: String,
    pub amount: Decimal,
}

#[derive(Debug, Clone)]
pub struct ReceiptOrder {
    pub transaction_id: Uuid,
    pub transaction_display_id: String,
    pub booked_at: DateTime<Utc>,
    pub status: DbOrderStatus,
    pub subtotal_price: Decimal,
    pub tax_total: Decimal,
    pub total_price: Decimal,
    pub total_savings: Decimal,
    pub amount_paid: Decimal,
    pub balance_due: Decimal,
    pub payment_methods_summary: String,
    pub payment_applications: Vec<ReceiptPaymentApplication>,
    pub customer: Option<ReceiptCustomerLine>,
    pub items: Vec<ReceiptLine>,
    pub is_tax_exempt: bool,
    pub tax_exempt_reason: Option<String>,
    pub fulfillment_method: DbOrderFulfillmentMethod,
    /// Cashier (operator) display name, masked as First + Last Initial.
    pub cashier_name: Option<String>,
    /// Primary salesperson display name, masked as First + Last Initial.
    pub salesperson_display_name: Option<String>,
    pub payments: Vec<ReceiptPayment>,
}

pub fn receipt_display_ref(order: &ReceiptOrder) -> String {
    let display_id = order.transaction_display_id.trim();
    if !display_id.is_empty() {
        return display_id.to_string();
    }
    order
        .transaction_id
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>()
        .to_uppercase()
}
