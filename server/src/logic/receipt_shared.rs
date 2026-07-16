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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptLineAdjustment {
    Returned,
    Exchanged,
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
    /// Gift card number/code loaded by a POS gift-card sale line.
    pub gift_card_load_code: Option<String>,
    pub custom_order_details: Option<serde_json::Value>,
    pub custom_item_type: Option<String>,
    pub is_fulfilled: bool,
    pub adjustment: Option<ReceiptLineAdjustment>,
    pub contributes_to_totals: bool,
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
    pub cash_tendered: Option<Decimal>,
    pub change_due: Option<Decimal>,
    pub gift_card_balance_after: Option<Decimal>,
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
    /// Amount collected for wedding-party split deposits alongside this sale.
    pub wedding_deposit_amount: Decimal,
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

pub fn tender_display_label(method: &str) -> String {
    let key = method
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>();
    match key.as_str() {
        "card" | "cardterminal" | "cardmanual" | "cardsaved" | "cardcredit" | "offlinecc"
        | "credit" | "creditcard" | "creditcards" | "creditdebit" | "debit" | "helcim" | "visa"
        | "mastercard" | "mc" | "amex" | "americanexpress" | "discover" => "CC".to_string(),
        "cash" => "Cash".to_string(),
        "rms90" | "rms90day" | "rms90days" | "rmscharge90" | "onaccountrms90" => {
            "RMS90".to_string()
        }
        "rms" | "rmscharge" | "onaccountrms" => "RMS".to_string(),
        "check" | "cheque" => "Check".to_string(),
        "giftcard" => "Gift Card".to_string(),
        "sc" | "storecredit" => "SC".to_string(),
        _ => method.trim().to_string(),
    }
}

pub fn payment_summary_has_receipt_detail(summary: &str) -> bool {
    let clean = summary.trim();
    !clean.is_empty()
        && clean != "—"
        && (clean.contains(" | ") || clean.contains("Card:") || clean.contains("RMS Ref"))
}

#[cfg(test)]
mod tests {
    use super::tender_display_label;

    #[test]
    fn card_tender_variants_use_customer_facing_label() {
        for method in [
            "card_terminal",
            "card_manual",
            "card_saved",
            "card_credit",
            "offline_cc",
        ] {
            assert_eq!(tender_display_label(method), "CC");
        }
    }

    #[test]
    fn non_card_tenders_keep_specific_labels() {
        assert_eq!(tender_display_label("cash"), "Cash");
        assert_eq!(tender_display_label("check"), "Check");
        assert_eq!(tender_display_label("gift_card"), "Gift Card");
        assert_eq!(tender_display_label("store_credit"), "SC");
    }
}
