//! Plain-text receipt body for SMS / messaging (same order snapshot as thermal / Receipt Builder merge).

use chrono_tz::Tz;
use rust_decimal::Decimal;

use crate::api::settings::ReceiptConfig;
use crate::logic::receipt_shared::{
    backdated_receipt_notice, payment_summary_has_receipt_detail, receipt_display_ref,
    tender_display_label, ReceiptOrder,
};

fn money(amount: Decimal) -> String {
    let rounded = amount.round_dp(2);
    if rounded < Decimal::ZERO {
        format!("-${:.2}", -rounded)
    } else {
        format!("${rounded:.2}")
    }
}

fn append_store_contact(lines: &mut Vec<String>, cfg: &ReceiptConfig) {
    for value in [
        cfg.show_address.then_some(cfg.store_address.as_str()),
        cfg.show_phone.then_some(cfg.store_phone.as_str()),
        cfg.show_email.then_some(cfg.store_email.as_str()),
    ]
    .into_iter()
    .flatten()
    .chain(cfg.header_lines.iter().map(String::as_str))
    {
        let value = value.trim();
        if !value.is_empty() {
            lines.push(value.to_string());
        }
    }
}

/// Gift receipt body for SMS when MMS/HTML is not used: items only, no prices or payment details.
pub fn format_pos_gift_receipt_text_message(order: &ReceiptOrder, cfg: &ReceiptConfig) -> String {
    let tz: Tz = cfg.timezone.parse().unwrap_or(chrono_tz::America::New_York);
    let local_time = order.booked_at.with_timezone(&tz);
    let order_ref = receipt_display_ref(order);

    let mut lines: Vec<String> = Vec::new();
    lines.push(cfg.store_name.trim().to_string());
    lines.push(format!("Gift receipt {order_ref}"));
    lines.push(local_time.format("%m/%d/%Y %I:%M %p").to_string());
    append_store_contact(&mut lines, cfg);
    if let Some(notice) = backdated_receipt_notice(order) {
        lines.push(notice);
    }
    lines.push(String::from("---"));

    if let Some(c) = &order.customer {
        lines.extend(c.identity_lines());
    }
    if let Some(name) = &order.salesperson_display_name {
        lines.push(format!("Salesperson: {name}"));
    }
    if let Some(name) = &order.cashier_name {
        lines.push(format!("Staff: {name}"));
    }
    if let Some(register_lane) = order.register_lane {
        lines.push(format!("Register #{register_lane}"));
    }

    if order.has_wedding_order_items() {
        lines.push("Wedding Order".to_string());
        lines.extend(order.wedding_order_context_lines());
    }

    for it in &order.items {
        let var = it
            .variation_label
            .as_deref()
            .map(|v| format!(" ({v})"))
            .unwrap_or_default();
        lines.push(format!(
            "{} x{}  {}{}",
            it.product_name.trim(),
            it.quantity,
            it.sku.trim(),
            var
        ));
    }

    lines.push(String::from("---"));
    lines.push("Pricing omitted (gift receipt).".to_string());

    if !cfg.footer_lines.is_empty() {
        for f in &cfg.footer_lines {
            let t = f.trim();
            if !t.is_empty() {
                lines.push(t.to_string());
            }
        }
    }

    lines.join("\n")
}

/// Formats a concise receipt for SMS (no HTML). Uses `ReceiptConfig` timezone and store name.
pub fn format_pos_receipt_text_message(order: &ReceiptOrder, cfg: &ReceiptConfig) -> String {
    let tz: Tz = cfg.timezone.parse().unwrap_or(chrono_tz::America::New_York);
    let local_time = order.booked_at.with_timezone(&tz);
    let order_ref = receipt_display_ref(order);

    let mut lines: Vec<String> = Vec::new();
    lines.push(cfg.store_name.trim().to_string());
    lines.push(if order.receipt_kind.is_standard_sale() {
        format!("Receipt {order_ref}")
    } else {
        format!("{} {order_ref}", order.receipt_kind.title())
    });
    lines.push(local_time.format("%m/%d/%Y %I:%M %p").to_string());
    append_store_contact(&mut lines, cfg);
    if let Some(notice) = backdated_receipt_notice(order) {
        lines.push(notice);
    }
    lines.push(String::from("---"));

    if let Some(c) = &order.customer {
        lines.extend(c.identity_lines());
    }

    if let Some(name) = &order.salesperson_display_name {
        lines.push(format!("Salesperson: {name}"));
    }
    if let Some(name) = &order.cashier_name {
        lines.push(format!("Staff: {name}"));
    }
    if let Some(register_lane) = order.register_lane {
        lines.push(format!("Register #{register_lane}"));
    }

    if order.has_wedding_order_items() {
        lines.push("Wedding Order".to_string());
        lines.extend(order.wedding_order_context_lines());
    }

    for it in &order.items {
        let var = it
            .variation_label
            .as_deref()
            .map(|v| format!(" ({v})"))
            .unwrap_or_default();
        lines.push(format!(
            "{} x{} @ {} = {}  {}{}",
            it.product_name.trim(),
            it.quantity,
            money(it.unit_price),
            money(it.unit_price * Decimal::from(it.quantity)),
            it.sku.trim(),
            var
        ));
        for (label, amount) in it.tax_detail_lines() {
            lines.push(format!("{label}: {}", money(amount)));
        }
        if it.custom_item_type.as_deref() == Some("linked_pickup") {
            if let Some(source_label) = it
                .discount_event_label
                .as_deref()
                .map(str::trim)
                .filter(|label| !label.is_empty())
            {
                lines.push(source_label.to_string());
            }
        }
    }

    lines.push(String::from("---"));
    lines.push(format!("Subtotal: {}", money(order.subtotal_price)));
    lines.push(format!("Sales tax: {}", money(order.tax_total)));
    if order.total_savings > Decimal::ZERO {
        lines.push(format!("Total savings: {}", money(order.total_savings)));
    }
    lines.push(format!(
        "{}: {}",
        order.total_label(),
        money(order.total_price)
    ));
    if order.show_paid_line() {
        lines.push(format!(
            "{}: {}",
            order.paid_label(),
            money(order.amount_paid)
        ));
    }
    if !order.is_pickup_event() && !order.has_order_payments() && order.balance_due > Decimal::ZERO
    {
        lines.push(format!("Balance remaining: {}", money(order.balance_due)));
    }
    if order.is_pickup_event() || order.has_order_payments() {
        // Tender and allocation are combined below for order-payment receipts.
    } else if order.payments.is_empty() {
        lines.push(format!("Tender: {}", order.payment_methods_summary.trim()));
    } else {
        lines.push("Tender:".to_string());
        for payment in &order.payments {
            lines.push(format!(
                "{}: {}",
                tender_display_label(&payment.method),
                money(payment.amount)
            ));
            if let (Some(cash_tendered), Some(change_due)) =
                (payment.cash_tendered, payment.change_due)
            {
                if change_due > Decimal::ZERO {
                    lines.push(format!("Cash Tendered: {}", money(cash_tendered)));
                    lines.push(format!("Change: {}", money(change_due)));
                }
            }
        }
        if payment_summary_has_receipt_detail(&order.payment_methods_summary) {
            lines.push(order.payment_methods_summary.trim().to_string());
        }
    }
    if !order.wedding_deposits.is_empty() {
        for deposit in &order.wedding_deposits {
            let beneficiary = deposit
                .beneficiary_name
                .as_deref()
                .map(|name| format!(" for {name}"))
                .unwrap_or_default();
            let destination = deposit
                .destination_label
                .as_deref()
                .map(|label| format!(" — {label}"))
                .unwrap_or_default();
            lines.push(format!(
                "Wedding Party Deposit{} ({}): {}{}",
                beneficiary,
                deposit.party_name,
                money(deposit.amount),
                destination
            ));
        }
    } else if order.wedding_deposit_amount > Decimal::ZERO {
        lines.push(format!(
            "Wedding Party Deposit: {}",
            money(order.wedding_deposit_amount)
        ));
    }
    for source in &order.applied_wedding_deposits {
        lines.push(format!(
            "Wedding Deposit Applied (paid by {}, {}): {}",
            source.payer_name,
            source.party_name,
            money(source.amount)
        ));
    }
    if order.is_pickup_event() || order.has_order_payments() {
        let multiple_orders = order.payment_applications.len() > 1;
        let tender_total = order
            .payments
            .iter()
            .fold(Decimal::ZERO, |total, payment| total + payment.amount);
        let single_application_matches_tender = !order.payments.is_empty()
            && order
                .payment_applications
                .first()
                .is_some_and(|app| app.amount == tender_total);
        lines.push(if multiple_orders {
            "Order payments".to_string()
        } else {
            "Order payment".to_string()
        });
        if let Some(prior_paid) = order.pickup_prior_paid {
            lines.push(format!("Previously paid: {}", money(prior_paid)));
        }
        for app in &order.payment_applications {
            if multiple_orders {
                lines.push(format!(
                    "Applied today to {}: {}",
                    app.target_display_id,
                    money(app.amount)
                ));
                lines.push(format!(
                    "Balance on {}: {}",
                    app.target_display_id,
                    money(app.remaining_balance)
                ));
            } else {
                lines.push(format!("Order: {}", app.target_display_id));
                if !single_application_matches_tender && !order.payments.is_empty() {
                    lines.push(format!("Applied today: {}", money(app.amount)));
                }
            }
        }
        if order.payments.is_empty() {
            if let Some(app) = order
                .payment_applications
                .first()
                .filter(|_| !multiple_orders)
            {
                lines.push(format!("Applied today: {}", money(app.amount)));
            } else if order.is_pickup_event() {
                lines.push(order.payment_methods_summary.trim().to_string());
            }
        } else {
            for payment in &order.payments {
                lines.push(format!(
                    "Paid today - {}: {}",
                    tender_display_label(&payment.method),
                    money(payment.amount)
                ));
                if let (Some(cash_tendered), Some(change_due)) =
                    (payment.cash_tendered, payment.change_due)
                {
                    if change_due > Decimal::ZERO {
                        lines.push(format!("Cash Tendered: {}", money(cash_tendered)));
                        lines.push(format!("Change: {}", money(change_due)));
                    }
                }
            }
        }
        if !multiple_orders {
            let remaining = order
                .payment_applications
                .first()
                .map(|app| app.remaining_balance)
                .or(order.pickup_balance_remaining)
                .unwrap_or(order.balance_due);
            lines.push(format!("Balance remaining: {}", money(remaining)));
            lines.push(format!(
                "Status: {}",
                if remaining <= Decimal::ZERO {
                    "Paid in full"
                } else {
                    "Balance due"
                }
            ));
        }
    }
    lines.push(format!("Status: {}", order.customer_status_label()));
    if order.is_tax_exempt {
        lines.push(format!(
            "TAX EXEMPT: {}",
            order.tax_exempt_reason.as_deref().unwrap_or("Yes")
        ));
    }

    if !cfg.footer_lines.is_empty() {
        lines.push(String::from("---"));
        for f in &cfg.footer_lines {
            let t = f.trim();
            if !t.is_empty() {
                lines.push(t.to_string());
            }
        }
    }

    lines.join("\n")
}

/// Clamp to a safe length for transactional SMS (concatenated segments).
pub fn clamp_sms_text(s: &str, max_chars: usize) -> String {
    let t = s.trim();
    let count = t.chars().count();
    if count <= max_chars {
        return t.to_string();
    }
    let take = max_chars.saturating_sub(1);
    format!("{}…", t.chars().take(take).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logic::receipt_shared::{ReceiptKind, ReceiptWeddingPartyDeposit};
    use crate::logic::receipt_studio_html::sample_receipt_order_for_preview;

    #[test]
    fn standard_sms_receipt_heading_is_unchanged() {
        let order = sample_receipt_order_for_preview();
        let text = format_pos_receipt_text_message(&order, &ReceiptConfig::default());

        assert!(text.lines().any(|line| line == "Receipt TXN-66736"));
        assert!(text.contains("4.75%: $7.88"));
        assert!(text.contains("4.00%: $7.00"));
        assert!(text.contains("Total Tax: $14.88"));
        assert!(text.contains("4.75%: $0.00"));
        assert!(text.contains("4.00%: $0.00"));
        assert!(text.contains("Total Tax: $0.00"));
        assert!(!text.contains("RETURN /"));
    }

    #[test]
    fn return_document_titles_render_in_sms_text() {
        for (kind, expected) in [
            (ReceiptKind::ReturnRefund, "RETURN / REFUND TXN-66736"),
            (ReceiptKind::ReturnExchange, "RETURN / EXCHANGE TXN-66736"),
        ] {
            let mut order = sample_receipt_order_for_preview();
            order.receipt_kind = kind;

            let text = format_pos_receipt_text_message(&order, &ReceiptConfig::default());
            assert!(text.lines().any(|line| line == expected));
        }
    }

    #[test]
    fn wedding_party_deposit_names_the_party_in_receipt_text() {
        let mut order = sample_receipt_order_for_preview();
        order.wedding_deposit_amount = Decimal::new(71038, 2);
        order.wedding_deposits = vec![ReceiptWeddingPartyDeposit {
            party_name: "Whitrock Wedding".to_string(),
            beneficiary_name: Some("James Brown".to_string()),
            destination_label: Some("Held for future order".to_string()),
            amount: Decimal::new(71038, 2),
        }];

        let text = format_pos_receipt_text_message(&order, &ReceiptConfig::default());

        assert!(text.contains(
            "Wedding Party Deposit for James Brown (Whitrock Wedding): $710.38 — Held for future order"
        ));
    }

    #[test]
    fn wedding_order_text_names_the_party_and_wedding_date() {
        let mut order = sample_receipt_order_for_preview();
        order.items[0].fulfillment = crate::models::DbFulfillmentType::WeddingOrder;
        order.items[0].is_fulfilled = false;
        order.wedding_party_name = Some("Adams Wedding".to_string());
        order.wedding_event_date =
            Some(chrono::NaiveDate::from_ymd_opt(2026, 9, 19).expect("valid wedding date"));

        let text = format_pos_receipt_text_message(&order, &ReceiptConfig::default());

        assert!(text.contains("Wedding Order"));
        assert!(text.contains("Party: Adams Wedding"));
        assert!(text.contains("Wedding Date: 09/19/2026"));
    }

    #[test]
    fn linked_pickup_text_names_the_source_order() {
        let mut order = sample_receipt_order_for_preview();
        order.items[0].custom_item_type = Some("linked_pickup".to_string());
        order.items[0].discount_event_label = Some("Picked up from ORD-100001".to_string());

        let text = format_pos_receipt_text_message(&order, &ReceiptConfig::default());

        assert!(text.contains("Picked up from ORD-100001"));
    }
}
