//! Shared receipt data types and helpers.
//! Note: This module provides a unified data contract for all receipt formats.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use uuid::Uuid;

use crate::models::{DbFulfillmentType, DbOrderFulfillmentMethod, DbOrderStatus};

pub fn order_status_label(s: DbOrderStatus) -> &'static str {
    match s {
        DbOrderStatus::Open => "open",
        DbOrderStatus::Fulfilled => "fulfilled",
        DbOrderStatus::Cancelled => "cancelled",
        DbOrderStatus::PendingMeasurement => "pending_measurement",
    }
}

#[derive(Debug, Clone)]
pub struct ReceiptCustomerLine {
    pub display_name: String,
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
pub struct ReceiptOrder {
    pub transaction_id: Uuid,
    pub booked_at: DateTime<Utc>,
    pub status: DbOrderStatus,
    pub total_price: Decimal,
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
}
