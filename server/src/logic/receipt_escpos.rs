//! ESC/POS helpers for Epson TM-m30III-compatible receipt printers.

use base64::Engine;
use chrono_tz::Tz;
use image::codecs::png::PngEncoder;
use image::{ColorType, ImageEncoder};
use rust_decimal::Decimal;
use std::collections::HashMap;

/// Optional loyalty point data for receipt rendering. When supplied, the
/// `{{LOYALTY_EARNED}}` and `{{LOYALTY_BALANCE}}` tokens are populated.
#[derive(Debug, Clone, Default)]
pub struct LoyaltyReceiptData {
    pub points_earned: Option<i32>,
    pub points_balance: Option<i32>,
}

use crate::api::settings::ReceiptConfig;
use crate::logic::receipt_shared::{
    order_status_label, payment_summary_has_receipt_detail, receipt_display_ref,
    tender_display_label, ReceiptLine, ReceiptLineAdjustment, ReceiptOrder,
};
use crate::models::{DbFulfillmentType, DbOrderFulfillmentMethod};

const CPL: usize = 48;
const RECEIPT_HEADER_FOOTER_WRAP_CPL: usize = 42;
const RECEIPT_LOGO_WIDTH_PX: u32 = 384;
const RECEIPT_LOGO_IMAGE: &[u8] =
    include_bytes!("../../../client/src/assets/images/riverside_logo.jpg");

fn ascii_clean(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii() && !c.is_control() {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn money(v: Decimal) -> String {
    format!("${}", v.round_dp(2))
}

fn line_total(it: &ReceiptLine) -> Decimal {
    it.unit_price * Decimal::from(it.quantity)
}

fn receiptline_escape(s: &str) -> String {
    ascii_clean(s)
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace('{', "\\{")
        .replace('}', "\\}")
}

fn receiptline_emphasis(s: &str) -> String {
    format!("\"{}\"", receiptline_escape(s).replace('"', "\\\""))
}

fn receiptline_logo_image() -> String {
    let Ok(img) = image::load_from_memory(RECEIPT_LOGO_IMAGE) else {
        return String::new();
    };
    let img = img.into_rgba8();
    let (w0, h0) = img.dimensions();
    if w0 == 0 || h0 == 0 {
        return String::new();
    }
    let target_w = RECEIPT_LOGO_WIDTH_PX.min(w0).max(1);
    let target_h = ((h0 as f64) * (target_w as f64) / (w0 as f64))
        .round()
        .max(1.0) as u32;
    let img = image::imageops::resize(
        &img,
        target_w,
        target_h,
        image::imageops::FilterType::Triangle,
    );
    let mut png = Vec::new();
    let encoder = PngEncoder::new(&mut png);
    if encoder
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            ColorType::Rgba8.into(),
        )
        .is_err()
    {
        return String::new();
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    format!("{{image:{b64}}}")
}

fn receipt_template_with_slots(template: &str, show_logo: bool, show_barcode: bool) -> String {
    let mut next = template.to_string();
    if show_logo && !next.contains("{{LOGO_IMAGE}}") {
        next = format!("{{{{LOGO_IMAGE}}}}\n{next}");
    }
    if show_barcode && !next.contains("{{BARCODE_IMAGE}}") {
        if next.contains("{{FOOTER_LINES}}") {
            // Only replace the first occurrence to avoid duplication if the token is already repeated
            let parts: Vec<&str> = next.splitn(2, "{{FOOTER_LINES}}").collect();
            if parts.len() == 2 {
                next = format!(
                    "{}{}{}{}",
                    parts[0], "{{BARCODE_IMAGE}}\n", "{{FOOTER_LINES}}", parts[1]
                );
            }
        } else {
            next = format!("{next}\n{{{{BARCODE_IMAGE}}}}");
        }
    }
    for token in [
        "{{SUBTOTAL_LINE}}",
        "{{TAX_LINE}}",
        "{{TOTAL_SAVINGS_LINE}}",
    ] {
        if !next.contains(token) {
            if next.contains("{{TOTAL_LINE}}") {
                next = next.replacen("{{TOTAL_LINE}}", &format!("{token}\n{{{{TOTAL_LINE}}}}"), 1);
            } else {
                next = format!("{next}\n{token}");
            }
        }
    }
    next
}

fn push_line(out: &mut Vec<u8>, line: &str) {
    out.extend_from_slice(ascii_clean(line).as_bytes());
    out.push(b'\n');
}

fn push_raw_line(out: &mut Vec<u8>, line: &str) {
    out.extend_from_slice(line.as_bytes());
    out.push(b'\n');
}

fn right_pair(left: &str, right: &str) -> String {
    let l = ascii_clean(left);
    let r = ascii_clean(right);
    let total = l.len() + r.len();
    if total >= CPL {
        return format!("{l} {r}");
    }
    format!("{l}{}{r}", " ".repeat(CPL - total))
}

fn wrap_text(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in ascii_clean(text).split_whitespace() {
        if current.is_empty() {
            current.push_str(word);
        } else if current.len() + 1 + word.len() <= width {
            current.push(' ');
            current.push_str(word);
        } else {
            lines.push(current);
            current = word.to_string();
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

fn divider(out: &mut Vec<u8>) {
    push_raw_line(out, "------------------------------------------");
}

fn set_align(out: &mut Vec<u8>, align: u8) {
    out.extend_from_slice(&[0x1b, 0x61, align]);
}

fn set_bold(out: &mut Vec<u8>, on: bool) {
    out.extend_from_slice(&[0x1b, 0x45, if on { 1 } else { 0 }]);
}

fn set_text_size(out: &mut Vec<u8>, size: u8) {
    out.extend_from_slice(&[0x1d, 0x21, size]);
}

fn truthy_param(params: &HashMap<String, String>, key: &str) -> bool {
    params
        .get(key)
        .map(|v| {
            let t = v.trim().to_ascii_lowercase();
            matches!(t.as_str(), "1" | "true" | "yes")
        })
        .unwrap_or(false)
}

fn kick_cash_drawer(out: &mut Vec<u8>) {
    // Epson ESC/POS drawer kick: pin 2, 100ms on, 500ms off.
    out.extend_from_slice(&[0x1b, 0x70, 0x00, 0x32, 0xfa]);
}

fn push_header(out: &mut Vec<u8>, d: &ReceiptOrder, cfg: &ReceiptConfig, gift: bool) {
    let tz: Tz = cfg.timezone.parse().unwrap_or_else(|_| {
        tracing::warn!(timezone = %cfg.timezone, "Receipt timezone invalid; falling back to UTC");
        chrono_tz::UTC
    });
    let local_time = d.booked_at.with_timezone(&tz);
    let order_ref = receipt_ref(d);

    set_align(out, 1);
    set_bold(out, true);
    set_text_size(out, 0x11);
    push_line(out, &cfg.store_name);
    set_text_size(out, 0x00);
    set_bold(out, false);
    for hl in &cfg.header_lines {
        let t = hl.trim();
        if !t.is_empty() {
            for line in wrap_text(t, RECEIPT_HEADER_FOOTER_WRAP_CPL) {
                push_line(out, &line);
            }
        }
    }
    if gift {
        set_bold(out, true);
        push_line(out, "GIFT RECEIPT");
        set_bold(out, false);
    }
    push_line(out, &format!("Receipt {order_ref}"));
    push_line(out, &local_time.format("%m/%d/%Y %I:%M %p").to_string());
    if let Some(notice) = crate::logic::receipt_shared::backdated_receipt_notice(d) {
        set_bold(out, true);
        push_line(out, &notice);
        set_bold(out, false);
    }
    set_align(out, 0);
    if let Some(c) = &d.customer {
        for line in c.identity_lines() {
            push_line(out, &line);
        }
    }
    divider(out);
}

fn push_items(out: &mut Vec<u8>, d: &ReceiptOrder, gift: bool) {
    for it in &d.items {
        if it.adjustment.is_some()
            || is_rms_charge_payment_line(it)
            || is_alteration_service_line(it)
        {
            let label = receipt_item_section_label(d, it);
            set_bold(out, true);
            push_line(out, label);
            set_bold(out, false);
        }
        set_bold(out, true);
        for line in wrap_text(it.product_name.trim(), CPL) {
            push_line(out, &line);
        }
        set_bold(out, false);
        if it.quantity != 1 {
            push_line(out, &format!("Qty {}", it.quantity));
        }
        if let Some(var) = it
            .variation_label
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            push_line(out, &format!("Variation: {var}"));
        }
        if gift {
            push_line(out, &format!("SKU {}", it.sku));
        } else {
            push_line(
                out,
                &right_pair(&format!("SKU {}", it.sku), &money(line_total(it))),
            );
            if let Some(orig) = it.original_unit_price {
                if orig > it.unit_price && orig > Decimal::ZERO {
                    let each = if it.quantity != 1 { " ea" } else { "" };
                    push_line(
                        out,
                        &format!("Reg {}  Sale {}{each}", money(orig), money(it.unit_price)),
                    );
                }
            }
            if let Some(label) = &it.discount_event_label {
                let t = label.trim();
                if !t.is_empty() {
                    push_line(out, t);
                }
            }
        }
        if let Some(code) = it
            .gift_card_load_code
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            push_line(out, &format!("Gift Card #: {code}"));
        }
        let status_label = if matches!(it.adjustment, Some(ReceiptLineAdjustment::Exchanged)) {
            "Exchanged item"
        } else if matches!(it.adjustment, Some(ReceiptLineAdjustment::Returned)) {
            "Returned / refunded item"
        } else if is_rms_charge_payment_line(it) {
            "Payment on RMS Charge"
        } else if is_alteration_service_line(it) {
            "Alteration service"
        } else {
            match it.fulfillment {
                DbFulfillmentType::Takeaway => "Taken home today",
                DbFulfillmentType::WeddingOrder => "Wedding order",
                DbFulfillmentType::SpecialOrder | DbFulfillmentType::Custom => "Order",
                DbFulfillmentType::Layaway => "Layaway",
            }
        };
        push_line(out, status_label);
        out.push(b'\n');
    }
}

fn push_totals(out: &mut Vec<u8>, d: &ReceiptOrder) {
    divider(out);
    push_line(out, &right_pair("Subtotal", &money(d.subtotal_price)));
    push_line(out, &right_pair("Taxes", &money(d.tax_total)));
    if d.total_savings > Decimal::ZERO {
        push_line(out, &right_pair("Total Savings", &money(d.total_savings)));
    }
    set_bold(out, true);
    push_line(out, &right_pair("Total", &money(d.total_price)));
    set_bold(out, false);
    push_line(out, &right_pair("Paid", &money(d.amount_paid)));
    if d.balance_due > Decimal::ZERO {
        push_line(out, &right_pair("Balance", &money(d.balance_due)));
    }
    if d.payments.is_empty() {
        push_line(out, &format!("Tender: {}", d.payment_methods_summary));
    } else {
        push_line(out, "Tender:");
        for payment in &d.payments {
            push_line(
                out,
                &right_pair(
                    &tender_display_label(&payment.method),
                    &money(payment.amount),
                ),
            );
            if let (Some(cash_tendered), Some(change_due)) =
                (payment.cash_tendered, payment.change_due)
            {
                if change_due > Decimal::ZERO {
                    push_line(out, &right_pair("Cash Tendered", &money(cash_tendered)));
                    push_line(out, &right_pair("Change", &money(change_due)));
                }
            }
        }
        if payment_summary_has_receipt_detail(&d.payment_methods_summary) {
            push_line(out, d.payment_methods_summary.trim());
        }
    }
    if d.wedding_deposit_amount > Decimal::ZERO {
        push_line(
            out,
            &right_pair("Wedding party deposits", &money(d.wedding_deposit_amount)),
        );
    }
    if !d.payment_applications.is_empty() {
        push_line(out, "Applied payments:");
        for app in &d.payment_applications {
            push_line(
                out,
                &format!(
                    "Applied to {} {} rem {}",
                    app.target_display_id,
                    money(app.amount),
                    money(app.remaining_balance)
                ),
            );
        }
    }
    push_line(out, &format!("Status: {}", receipt_status_label(d)));
    if d.is_tax_exempt {
        push_line(
            out,
            &format!(
                "TAX EXEMPT: {}",
                d.tax_exempt_reason.as_deref().unwrap_or("Yes")
            ),
        );
    }
}

fn push_footer(out: &mut Vec<u8>, cfg: &ReceiptConfig) {
    divider(out);
    set_text_size(out, 0x00);
    set_bold(out, false);
    set_align(out, 1);
    for fl in &cfg.footer_lines {
        let t = fl.trim();
        if !t.is_empty() {
            for line in wrap_text(t, RECEIPT_HEADER_FOOTER_WRAP_CPL) {
                push_line(out, &line);
            }
        }
    }
    set_align(out, 0);
}

fn receipt_ref(d: &ReceiptOrder) -> String {
    receipt_display_ref(d)
}

fn receipt_date(d: &ReceiptOrder, cfg: &ReceiptConfig) -> String {
    let tz: Tz = cfg.timezone.parse().unwrap_or_else(|_| {
        tracing::warn!(timezone = %cfg.timezone, "Receipt timezone invalid; falling back to UTC");
        chrono_tz::UTC
    });
    d.booked_at
        .with_timezone(&tz)
        .format("%m/%d/%Y %I:%M %p")
        .to_string()
}

fn centered_lines(lines: &[String]) -> String {
    lines
        .iter()
        .flat_map(|line| wrap_text(line.trim(), RECEIPT_HEADER_FOOTER_WRAP_CPL))
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .map(|line| format!("| {} |", receiptline_escape(&line)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn receipt_header_lines(cfg: &ReceiptConfig) -> Vec<String> {
    let mut lines = Vec::new();
    if cfg.show_address {
        let value = cfg.store_address.trim();
        if !value.is_empty() {
            lines.push(value.to_string());
        }
    }
    if cfg.show_phone {
        let value = cfg.store_phone.trim();
        if !value.is_empty() {
            lines.push(value.to_string());
        }
    }
    if cfg.show_email {
        let value = cfg.store_email.trim();
        if !value.is_empty() {
            lines.push(value.to_string());
        }
    }
    lines.extend(cfg.header_lines.iter().cloned());
    lines
}

fn receiptline_item_lines(
    d: &ReceiptOrder,
    cfg: &ReceiptConfig,
    gift: bool,
    is_pickup: bool,
) -> String {
    let mut out_lines = Vec::new();

    let labels = [
        "PAYMENT",
        "Alterations",
        "Shipping",
        "RETURNED / REFUNDED",
        "EXCHANGED",
        "Taken Today",
        "PICKED UP",
        "SHIPPED",
        "Special Order",
        "Custom Order",
        "Wedding Order",
        "Layaway",
    ];

    for label in labels {
        let items: Vec<_> = d
            .items
            .iter()
            .filter(|it| {
                let section = receipt_item_section_label(d, it);
                section == label && (!is_pickup || section == "PICKED UP")
            })
            .collect();

        if items.is_empty() {
            continue;
        }

        if !out_lines.is_empty() {
            out_lines.push(String::new());
        }

        out_lines.push(format!("^^^{}", receiptline_escape(label)));

        for it in items {
            if let Some(details) = &it.custom_order_details {
                let note = match details {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Object(m) => m
                        .get("note")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    _ => String::new(),
                };
                if !note.trim().is_empty() {
                    out_lines.push(format!("NOTICE: {} |", receiptline_escape(note.trim())));
                }
            }

            let name = receiptline_emphasis(it.product_name.trim());
            let variation = it
                .variation_label
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty());

            if gift {
                out_lines.push(format!("{name} |"));
                if it.quantity != 1 {
                    out_lines.push(format!("Qty {} |", it.quantity));
                }
                if let Some(v) = variation {
                    out_lines.push(format!("Variation: {} |", receiptline_escape(v)));
                }
                out_lines.push(format!("| SKU {} |", receiptline_escape(&it.sku)));
                if let Some(code) = it
                    .gift_card_load_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    out_lines.push(format!("Gift Card #: {} |", receiptline_escape(code)));
                }
            } else {
                out_lines.push(format!("{name} |"));
                if it.quantity != 1 {
                    out_lines.push(format!("Qty {} |", it.quantity));
                }
                if let Some(v) = variation {
                    out_lines.push(format!("Variation: {} |", receiptline_escape(v)));
                }
                if is_pickup && label == "PICKED UP" {
                    out_lines.push(format!("Order Date: {} |", receipt_date(d, cfg)));
                }
                out_lines.push(format!(
                    "| SKU {} | {}",
                    receiptline_escape(&it.sku),
                    money(line_total(it))
                ));
                if let Some(code) = it
                    .gift_card_load_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    out_lines.push(format!("Gift Card #: {} |", receiptline_escape(code)));
                }
                if let Some(orig) = it.original_unit_price {
                    if orig > it.unit_price && orig > Decimal::ZERO {
                        let diff = orig - it.unit_price;
                        let pct = (diff / orig * Decimal::from(100)).round_dp(0);
                        let each = if it.quantity != 1 { " ea" } else { "" };
                        out_lines.push(format!(
                            "Reg {} Sale {}{} ({}% Discount) |",
                            money(orig),
                            money(it.unit_price),
                            each,
                            pct
                        ));
                    }
                }
                if let Some(label) = &it.discount_event_label {
                    let t = label.trim();
                    if !t.is_empty() {
                        out_lines.push(format!("{} |", receiptline_escape(t)));
                    }
                }
            }
        }
    }

    out_lines.join("\n")
}

fn is_rms_charge_payment_line(it: &crate::logic::receipt_shared::ReceiptLine) -> bool {
    it.custom_item_type.as_deref() == Some("rms_charge_payment")
        || it.sku.trim().eq_ignore_ascii_case("ROS-RMS-CHARGE-PAYMENT")
        || it
            .product_name
            .trim()
            .eq_ignore_ascii_case("RMS CHARGE PAYMENT")
}

fn is_alteration_service_line(it: &crate::logic::receipt_shared::ReceiptLine) -> bool {
    it.custom_item_type.as_deref() == Some("alteration_service")
}

fn is_shipping_fee_line(it: &crate::logic::receipt_shared::ReceiptLine) -> bool {
    it.custom_item_type.as_deref() == Some("shipping_fee")
        || it.sku.trim().eq_ignore_ascii_case("ROS-SHIPPING-FEE")
}

fn receipt_item_section_label(
    d: &ReceiptOrder,
    it: &crate::logic::receipt_shared::ReceiptLine,
) -> &'static str {
    match it.adjustment {
        Some(ReceiptLineAdjustment::Returned) => return "RETURNED / REFUNDED",
        Some(ReceiptLineAdjustment::Exchanged) => return "EXCHANGED",
        None => {}
    }
    if is_rms_charge_payment_line(it) {
        return "PAYMENT";
    }
    if is_alteration_service_line(it) {
        return "Alterations";
    }
    if is_shipping_fee_line(it) {
        return "Shipping";
    }
    if it.is_fulfilled {
        match d.fulfillment_method {
            DbOrderFulfillmentMethod::Ship => "SHIPPED",
            DbOrderFulfillmentMethod::Pickup => {
                if it.fulfillment == DbFulfillmentType::Takeaway {
                    "Taken Today"
                } else {
                    "PICKED UP"
                }
            }
        }
    } else {
        match it.fulfillment {
            DbFulfillmentType::Takeaway => "Taken Today",
            DbFulfillmentType::SpecialOrder => "Special Order",
            DbFulfillmentType::Custom => "Custom Order",
            DbFulfillmentType::WeddingOrder => "Wedding Order",
            DbFulfillmentType::Layaway => "Layaway",
        }
    }
}

fn receiptline_payment_lines(d: &ReceiptOrder) -> String {
    if d.payment_applications.is_empty() {
        return String::new();
    }
    let mut lines = vec!["Applied payments:".to_string()];
    for app in &d.payment_applications {
        lines.push(format!(
            "Applied to {} | {}",
            receiptline_escape(&app.target_display_id),
            money(app.amount)
        ));
        lines.push(format!("Remaining | {}", money(app.remaining_balance)));
    }
    lines.join("\n")
}

fn receiptline_tender_lines(d: &ReceiptOrder, gift: bool) -> String {
    if gift {
        return String::new();
    }
    if d.payments.is_empty() {
        return format!(
            "Tender | {}",
            receiptline_escape(&d.payment_methods_summary)
        );
    }
    let mut lines = Vec::new();
    for payment in &d.payments {
        lines.push(format!(
            "Tender {} | {}",
            receiptline_escape(&tender_display_label(&payment.method)),
            money(payment.amount)
        ));
        if let (Some(cash_tendered), Some(change_due)) = (payment.cash_tendered, payment.change_due)
        {
            if change_due > Decimal::ZERO {
                lines.push(format!("Cash Tendered | {}", money(cash_tendered)));
                lines.push(format!("Change | {}", money(change_due)));
            }
        }
    }
    if payment_summary_has_receipt_detail(&d.payment_methods_summary) {
        lines.push(receiptline_escape(d.payment_methods_summary.trim()));
    }
    lines.join("\n")
}

fn receiptline_gift_card_balance_line(d: &ReceiptOrder, gift: bool) -> String {
    if gift {
        return String::new();
    }
    d.payments
        .iter()
        .filter_map(|payment| {
            payment
                .gift_card_balance_after
                .map(|balance| format!("Gift Card Balance | {}", money(balance)))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn receipt_status_label(d: &ReceiptOrder) -> &'static str {
    let all_takeaway = !d.items.is_empty()
        && d.items
            .iter()
            .all(|it| it.fulfillment == DbFulfillmentType::Takeaway);
    let all_fulfilled = !d.items.is_empty() && d.items.iter().all(|it| it.is_fulfilled);
    if all_takeaway || all_fulfilled {
        return "Complete";
    }
    order_status_label(d.status)
}

fn default_receiptline_template() -> &'static str {
    "{{LOGO_IMAGE}}\n{{HEADER_LINES}}\n{{RECEIPT_TITLE}}\n{{RECEIPT_ID}}\n{{RECEIPT_DATE}}\n{{CUSTOMER_LINE}}\n{{SALESPERSON_LINE}}\n{{CASHIER_LINE}}\n---\n{{ITEM_LINES}}\n{{LOYALTY_EARNED}}\n{{LOYALTY_BALANCE}}\n{{PAYMENT_BLOCK}}\n{{SUBTOTAL_LINE}}\n{{TAX_LINE}}\n{{TOTAL_SAVINGS_LINE}}\n{{TOTAL_LINE}}\n{{PAID_LINE}}\n{{BALANCE_LINE}}\n{{TENDER_LINE}}\n{{GIFT_CARD_BALANCE}}\n{{STATUS_LINE}}\n{{TAX_EXEMPT_LINE}}\n---\n{{BARCODE_IMAGE}}\n{{FOOTER_LINES}}\n{{CUT}}"
}

fn default_receiptline_pickup_template() -> &'static str {
    "{{LOGO_IMAGE}}\n{{HEADER_LINES}}\n{{RECEIPT_TITLE}}\n{{RECEIPT_ID}}\n{{CUSTOMER_LINE}}\n{{SALESPERSON_LINE}}\n{{CASHIER_LINE}}\n---\n{{ITEM_LINES}}\n---\n{{PAYMENT_HISTORY_BLOCK}}\n{{SUBTOTAL_LINE}}\n{{TAX_LINE}}\n{{TOTAL_SAVINGS_LINE}}\n{{TOTAL_LINE}}\n{{PAID_LINE}}\n{{BALANCE_LINE}}\n{{GIFT_CARD_BALANCE}}\n{{STATUS_LINE}}\n---\n{{BARCODE_IMAGE}}\n{{FOOTER_LINES}}\n{{CUT}}"
}

fn receiptline_payment_history_block(d: &ReceiptOrder) -> String {
    if d.payments.is_empty() {
        return String::new();
    }
    let mut lines = vec!["| ^^^Payment History |".to_string(), "---".to_string()];
    for pay in &d.payments {
        let date_str = pay.date.format("%m/%d/%Y").to_string();
        lines.push(format!(
            "{} {} | {}",
            date_str,
            receiptline_escape(&tender_display_label(&pay.method)),
            money(pay.amount)
        ));
        if let (Some(cash_tendered), Some(change_due)) = (pay.cash_tendered, pay.change_due) {
            if change_due > Decimal::ZERO {
                lines.push(format!("Cash Tendered | {}", money(cash_tendered)));
                lines.push(format!("Change | {}", money(change_due)));
            }
        }
    }
    lines.join("\n")
}

pub fn build_receiptline_markdown(
    d: &ReceiptOrder,
    cfg: &ReceiptConfig,
    params: &HashMap<String, String>,
    loyalty: &LoyaltyReceiptData,
) -> String {
    let gift = truthy_param(params, "gift");
    let is_pickup = params.contains_key("pickup") || truthy_param(params, "pickup");
    let template = if is_pickup {
        match cfg.receiptline_pickup_template.as_deref().map(str::trim) {
            Some(value) if !value.is_empty() => value,
            _ => default_receiptline_pickup_template(),
        }
    } else {
        match cfg.receiptline_template.as_deref().map(str::trim) {
            Some(value) if !value.is_empty() => value,
            _ => default_receiptline_template(),
        }
    };
    let template = receipt_template_with_slots(template, cfg.show_logo, cfg.show_barcode);
    let title = if gift {
        "| ^^^GIFT RECEIPT |"
    } else if is_pickup {
        "| ^^^RECEIPT |"
    } else {
        "| ^^^RECEIPT |"
    };
    let customer_line = d
        .customer
        .as_ref()
        .map(|c| {
            c.identity_lines()
                .into_iter()
                .map(|line| receiptline_escape(&line))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let cashier_line = d
        .cashier_name
        .as_ref()
        .map(|n| format!("Cashier: {}", receiptline_escape(n)))
        .unwrap_or_default();
    let salesperson_line = d
        .salesperson_display_name
        .as_ref()
        .map(|n| format!("Salesperson: {}", receiptline_escape(n)))
        .unwrap_or_default();
    let payment_lines = receiptline_payment_lines(d);
    let payment_block = if payment_lines.is_empty() {
        String::new()
    } else {
        format!("---\n{payment_lines}")
    };
    let balance_line = if !gift && d.balance_due > Decimal::ZERO {
        format!("Balance | {}", money(d.balance_due))
    } else {
        String::new()
    };
    let tender_line = receiptline_tender_lines(d, gift);
    let gift_card_balance_line = receiptline_gift_card_balance_line(d, gift);
    let status_line = if gift {
        String::new()
    } else {
        format!("Status | {}", receiptline_escape(receipt_status_label(d)))
    };
    let tax_exempt_line = if !gift && d.is_tax_exempt {
        format!(
            "TAX EXEMPT | {}",
            receiptline_escape(d.tax_exempt_reason.as_deref().unwrap_or("Yes"))
        )
    } else {
        String::new()
    };
    let store_name = format!("| ^^{} |", receiptline_escape(&cfg.store_name));
    let header_lines = centered_lines(&receipt_header_lines(cfg));
    let receipt_id = format!("| Receipt {} |", receipt_ref(d));
    let receipt_date = if is_pickup {
        String::new()
    } else {
        format!("| {} |", receipt_date(d, cfg))
    };
    let item_lines = receiptline_item_lines(d, cfg, gift, is_pickup);
    let payment_block_value = if gift { "" } else { payment_block.as_str() };
    let total_line = if gift {
        String::new()
    } else {
        format!("Total | ^^{}", money(d.total_price))
    };
    let subtotal_line = if gift {
        String::new()
    } else {
        format!("Subtotal | {}", money(d.subtotal_price))
    };
    let tax_line = if gift {
        String::new()
    } else {
        format!("Taxes | {}", money(d.tax_total))
    };
    let total_savings_line = if !gift && d.total_savings > Decimal::ZERO {
        format!("Total Savings | {}", money(d.total_savings))
    } else {
        String::new()
    };
    let paid_line = if gift {
        String::new()
    } else {
        format!("Paid | {}", money(d.amount_paid))
    };
    let footer_lines = centered_lines(&cfg.footer_lines);

    let logo_image = if cfg.show_logo {
        receiptline_logo_image()
    } else {
        String::new()
    };
    let barcode_image = if cfg.show_barcode {
        format!(
            "{{code:{};option:code128,hri}}",
            receiptline_escape(&receipt_ref(d))
        )
    } else {
        String::new()
    };

    let loyalty_earned_line = if !gift && cfg.show_loyalty_earned {
        match loyalty.points_earned {
            Some(pts) if pts > 0 => format!("Loyalty earned | {pts} pts"),
            _ => String::new(),
        }
    } else {
        String::new()
    };
    let loyalty_balance_line = if !gift && cfg.show_loyalty_balance {
        match loyalty.points_balance {
            Some(bal) => format!("Loyalty balance | {bal} pts"),
            _ => String::new(),
        }
    } else {
        String::new()
    };

    let payment_history_block = if gift {
        String::new()
    } else {
        receiptline_payment_history_block(d)
    };

    template
        .replace("{{LOGO_IMAGE}}", &logo_image)
        .replace("{{STORE_NAME}}", &store_name)
        .replace("{{HEADER_LINES}}", &header_lines)
        .replace("{{RECEIPT_TITLE}}", title)
        .replace("{{RECEIPT_ID}}", &receipt_id)
        .replace("{{RECEIPT_DATE}}", &receipt_date)
        .replace("{{CUSTOMER_LINE}}", &customer_line)
        .replace("{{CASHIER_LINE}}", &cashier_line)
        .replace("{{SALESPERSON_LINE}}", &salesperson_line)
        .replace("{{ITEM_LINES}}", &item_lines)
        .replace("{{PAYMENT_BLOCK}}", payment_block_value)
        .replace("{{PAYMENT_HISTORY_BLOCK}}", &payment_history_block)
        .replace("{{SUBTOTAL_LINE}}", &subtotal_line)
        .replace("{{TAX_LINE}}", &tax_line)
        .replace("{{TOTAL_SAVINGS_LINE}}", &total_savings_line)
        .replace("{{TOTAL_LINE}}", &total_line)
        .replace("{{PAID_LINE}}", &paid_line)
        .replace("{{BALANCE_LINE}}", &balance_line)
        .replace("{{TENDER_LINE}}", &tender_line)
        .replace("{{GIFT_CARD_BALANCE}}", &gift_card_balance_line)
        .replace("{{STATUS_LINE}}", &status_line)
        .replace("{{TAX_EXEMPT_LINE}}", &tax_exempt_line)
        .replace("{{LOYALTY_EARNED}}", &loyalty_earned_line)
        .replace("{{LOYALTY_BALANCE}}", &loyalty_balance_line)
        .replace("{{BARCODE_IMAGE}}", &barcode_image)
        .replace("{{FOOTER_LINES}}", &footer_lines)
        .replace("{{CUT}}", "=")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn build_receipt_escpos(
    d: &ReceiptOrder,
    cfg: &ReceiptConfig,
    params: HashMap<String, String>,
) -> Vec<u8> {
    let gift = truthy_param(&params, "gift");
    let open_cash_drawer = truthy_param(&params, "open_cash_drawer") && !gift;

    let mut out = Vec::new();
    out.extend_from_slice(&[0x1b, 0x40]);
    out.extend_from_slice(&[0x1b, 0x74, 0x00]);
    if open_cash_drawer {
        kick_cash_drawer(&mut out);
    }
    push_header(&mut out, d, cfg, gift);
    if gift {
        push_line(&mut out, "Items (pricing omitted)");
    }
    push_items(&mut out, d, gift);
    if !gift {
        push_totals(&mut out, d);
    }
    push_footer(&mut out, cfg);
    out.extend_from_slice(b"\n\n\n\n");
    out.extend_from_slice(&[0x1d, 0x56, 0x41, 0x00]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logic::receipt_shared::{ReceiptLine, ReceiptOrder, ReceiptPayment};
    use crate::models::DbOrderStatus;
    use chrono::Utc;
    use uuid::Uuid;

    fn receipt_order_with(items: Vec<ReceiptLine>) -> ReceiptOrder {
        ReceiptOrder {
            transaction_id: Uuid::nil(),
            transaction_display_id: "TXN-TEST".to_string(),
            booked_at: Utc::now(),
            backdated_business_date: None,
            status: DbOrderStatus::Fulfilled,
            subtotal_price: Decimal::ZERO,
            tax_total: Decimal::ZERO,
            total_price: Decimal::ZERO,
            total_savings: Decimal::ZERO,
            amount_paid: Decimal::ZERO,
            wedding_deposit_amount: Decimal::ZERO,
            balance_due: Decimal::ZERO,
            payment_methods_summary: "Cash".to_string(),
            payment_applications: Vec::new(),
            customer: None,
            items,
            is_tax_exempt: false,
            tax_exempt_reason: None,
            fulfillment_method: DbOrderFulfillmentMethod::Pickup,
            cashier_name: None,
            salesperson_display_name: None,
            payments: Vec::new(),
        }
    }

    fn receipt_line(name: &str, sku: &str, custom_item_type: Option<&str>) -> ReceiptLine {
        ReceiptLine {
            product_name: name.to_string(),
            sku: sku.to_string(),
            quantity: 1,
            unit_price: Decimal::new(2500, 2),
            fulfillment: DbFulfillmentType::Takeaway,
            salesperson_name: None,
            variation_label: None,
            original_unit_price: None,
            discount_event_label: None,
            gift_card_load_code: None,
            custom_order_details: None,
            custom_item_type: custom_item_type.map(str::to_string),
            is_fulfilled: true,
            adjustment: None,
            contributes_to_totals: true,
        }
    }

    #[test]
    fn receiptline_groups_rms_payments_and_alterations() {
        let order = receipt_order_with(vec![
            receipt_line("RMS CHARGE PAYMENT", "ROS-RMS-CHARGE-PAYMENT", None),
            receipt_line(
                "Alteration: Hem Pants",
                "ALT-001",
                Some("alteration_service"),
            ),
            receipt_line("SHIPPING FEE", "ROS-SHIPPING-FEE", Some("shipping_fee")),
        ]);

        let lines = receiptline_item_lines(&order, &ReceiptConfig::default(), false, false);

        assert!(lines.contains("^^^PAYMENT"));
        assert!(lines.contains("RMS CHARGE PAYMENT"));
        assert!(lines.contains("^^^Alterations"));
        assert!(lines.contains("Alteration: Hem Pants"));
        assert!(lines.contains("^^^Shipping"));
        assert!(lines.contains("SHIPPING FEE"));
    }

    #[test]
    fn pickup_receipts_only_show_items_picked_up_in_that_event() {
        let mut picked_up = receipt_line("Mantoni Classic Fit DrShirt", "B-1471078", None);
        picked_up.fulfillment = DbFulfillmentType::SpecialOrder;
        picked_up.is_fulfilled = true;

        let mut remaining = receipt_line("Gruppo Bravo Slacks", "B-1393029", None);
        remaining.fulfillment = DbFulfillmentType::SpecialOrder;
        remaining.is_fulfilled = false;

        let order = receipt_order_with(vec![picked_up, remaining]);
        let mut params = HashMap::new();
        params.insert("pickup".to_string(), "true".to_string());

        let markdown = build_receiptline_markdown(
            &order,
            &ReceiptConfig::default(),
            &params,
            &LoyaltyReceiptData::default(),
        );

        assert!(markdown.contains("^^^PICKED UP"));
        assert!(markdown.contains("Mantoni Classic Fit DrShirt"));
        assert!(!markdown.contains("^^^Special Order"));
        assert!(!markdown.contains("Gruppo Bravo Slacks"));
    }

    #[test]
    fn receiptline_shows_cash_tendered_and_change_when_change_was_given() {
        let mut order = receipt_order_with(vec![receipt_line("Cash Item", "CASH-1", None)]);
        order.total_price = Decimal::new(5000, 2);
        order.amount_paid = Decimal::new(5000, 2);
        order.payments = vec![ReceiptPayment {
            date: Utc::now(),
            method: "cash".to_string(),
            amount: Decimal::new(5000, 2),
            cash_tendered: Some(Decimal::new(10000, 2)),
            change_due: Some(Decimal::new(5000, 2)),
            gift_card_balance_after: None,
        }];

        let markdown = build_receiptline_markdown(
            &order,
            &ReceiptConfig::default(),
            &HashMap::new(),
            &LoyaltyReceiptData::default(),
        );

        assert!(markdown.contains("Cash Tendered | $100.00"));
        assert!(markdown.contains("Change | $50.00"));
    }

    #[test]
    fn receiptline_header_footer_are_normal_size_centered_and_wrapped() {
        let mut cfg = ReceiptConfig::default();
        cfg.show_logo = false;
        cfg.show_barcode = false;
        cfg.show_address = true;
        cfg.store_address = "6470 Transit Rd, Depew, NY".to_string();
        cfg.store_phone = "(716) 833-8401".to_string();
        cfg.footer_lines = vec![
            "Return Policy: We will accept returns of any merchandise in its unworn, unaltered, like new condition with original receipt within (30) days of purchase/pickup.".to_string(),
        ];
        let order = receipt_order_with(Vec::new());

        let markdown = build_receiptline_markdown(
            &order,
            &cfg,
            &HashMap::new(),
            &LoyaltyReceiptData::default(),
        );

        assert!(markdown.contains("| 6470 Transit Rd, Depew, NY |"));
        assert!(markdown.contains("| (716) 833-8401 |"));
        assert!(!markdown.contains("| ^6470 Transit Rd"));
        assert!(!markdown.contains("| ^Return Policy"));
        assert!(markdown.contains("| Return Policy: We will accept returns of |"));
        assert!(markdown.contains("| any merchandise in its unworn, unaltered, |"));
        assert!(!markdown.contains("will a\nccept"));
    }
}

#[derive(Debug, Clone)]
pub struct AlterationCardInput {
    pub store_name: String,
    pub header_lines: Vec<String>,
    pub footer_lines: Vec<String>,
    pub customer_name: String,
    pub customer_phone: Option<String>,
    pub ticket_number: Option<String>,
    pub item_description: Option<String>,
    pub work_requested: Option<String>,
    pub notes: Option<String>,
    pub alteration_id: String,
    pub due_at: Option<chrono::DateTime<chrono::Utc>>,
    pub fitting_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub timezone: String,
}

#[derive(Debug, Clone)]
pub struct AlterationPickupReceiptInput {
    pub store_name: String,
    pub header_lines: Vec<String>,
    pub footer_lines: Vec<String>,
    pub customer_name: String,
    pub item_description: Option<String>,
    pub work_requested: Option<String>,
    pub alteration_id: String,
    pub picked_up_at: chrono::DateTime<chrono::Utc>,
    pub picked_up_by: String,
    pub timezone: String,
}

pub fn build_alteration_pickup_receiptline(
    input: &AlterationPickupReceiptInput,
    show_logo: bool,
) -> String {
    let tz: Tz = input
        .timezone
        .parse()
        .unwrap_or_else(|_| {
            tracing::warn!(timezone = %input.timezone, "Alteration receipt timezone invalid; falling back to UTC");
            chrono_tz::UTC
        });
    let local_time = input.picked_up_at.with_timezone(&tz);

    let mut lines = Vec::new();
    if show_logo {
        lines.push(receiptline_logo_image());
    }
    lines.push(format!("| ^^{} |", receiptline_escape(&input.store_name)));
    for hl in &input.header_lines {
        let t = hl.trim();
        if !t.is_empty() {
            lines.extend(centered_lines(&[t.to_string()]).lines().map(str::to_string));
        }
    }
    lines.push("| ^^^ALTERATIONS PICKUP |".to_string());
    lines.push(format!("| {} |", local_time.format("%m/%d/%Y %I:%M %p")));
    lines.push(String::new());
    lines.push(format!(
        "Customer: {}",
        receiptline_escape(&input.customer_name)
    ));
    if let Some(desc) = input.item_description.as_deref() {
        let t = desc.trim();
        if !t.is_empty() {
            lines.push(format!("Item: {}", receiptline_escape(t)));
        }
    }
    if let Some(work) = input.work_requested.as_deref() {
        let t = work.trim();
        if !t.is_empty() {
            lines.push(format!("Work: {}", receiptline_escape(t)));
        }
    }
    lines.push(format!(
        "Alteration ID: {}",
        receiptline_escape(&input.alteration_id)
    ));
    lines.push(format!(
        "Released by: {}",
        receiptline_escape(&input.picked_up_by)
    ));
    lines.push(String::new());
    lines.push("---".to_string());
    for fl in &input.footer_lines {
        let t = fl.trim();
        if !t.is_empty() {
            lines.extend(centered_lines(&[t.to_string()]).lines().map(str::to_string));
        }
    }
    lines.push("=".to_string());
    lines.join("\n")
}

pub fn build_alteration_pickup_escpos(
    input: &AlterationPickupReceiptInput,
    cfg: &ReceiptConfig,
) -> Vec<u8> {
    let tz: Tz = cfg.timezone.parse().unwrap_or_else(|_| {
        tracing::warn!(timezone = %cfg.timezone, "Alteration receipt timezone invalid; falling back to UTC");
        chrono_tz::UTC
    });
    let local_time = input.picked_up_at.with_timezone(&tz);
    let mut out = Vec::new();
    out.extend_from_slice(&[0x1b, 0x40]);
    out.extend_from_slice(&[0x1b, 0x74, 0x00]);
    push_raw_line(&mut out, "");
    set_align(&mut out, 1);
    set_bold(&mut out, true);
    set_text_size(&mut out, 0x11);
    push_line(&mut out, &cfg.store_name);
    set_text_size(&mut out, 0x00);
    set_bold(&mut out, false);
    for hl in &cfg.header_lines {
        let t = hl.trim();
        if !t.is_empty() {
            for line in wrap_text(t, RECEIPT_HEADER_FOOTER_WRAP_CPL) {
                push_line(&mut out, &line);
            }
        }
    }
    set_bold(&mut out, true);
    push_line(&mut out, "ALTERATIONS PICKUP");
    set_bold(&mut out, false);
    push_line(
        &mut out,
        &local_time.format("%m/%d/%Y %I:%M %p").to_string(),
    );
    set_align(&mut out, 0);
    divider(&mut out);
    push_line(
        &mut out,
        &format!("Customer: {}", ascii_clean(&input.customer_name)),
    );
    if let Some(desc) = input.item_description.as_deref() {
        let t = desc.trim();
        if !t.is_empty() {
            for line in wrap_text(&format!("Item: {t}"), CPL) {
                push_line(&mut out, &line);
            }
        }
    }
    if let Some(work) = input.work_requested.as_deref() {
        let t = work.trim();
        if !t.is_empty() {
            for line in wrap_text(&format!("Work: {t}"), CPL) {
                push_line(&mut out, &line);
            }
        }
    }
    push_line(
        &mut out,
        &format!("Alteration ID: {}", ascii_clean(&input.alteration_id)),
    );
    push_line(
        &mut out,
        &format!("Released by: {}", ascii_clean(&input.picked_up_by)),
    );
    divider(&mut out);
    set_align(&mut out, 1);
    for fl in &cfg.footer_lines {
        let t = fl.trim();
        if !t.is_empty() {
            for line in wrap_text(t, RECEIPT_HEADER_FOOTER_WRAP_CPL) {
                push_line(&mut out, &line);
            }
        }
    }
    set_align(&mut out, 0);
    out.extend_from_slice(b"\n\n\n\n");
    out.extend_from_slice(&[0x1d, 0x56, 0x41, 0x00]);
    out
}

pub fn build_alteration_card_receiptline(input: &AlterationCardInput, show_logo: bool) -> String {
    let tz: Tz = input
        .timezone
        .parse()
        .unwrap_or_else(|_| {
            tracing::warn!(timezone = %input.timezone, "Alteration card timezone invalid; falling back to UTC");
            chrono_tz::UTC
        });
    let created_local = input.created_at.with_timezone(&tz);

    let mut lines = Vec::new();
    if show_logo {
        lines.push(receiptline_logo_image());
    }
    lines.push(format!("| ^^{} |", receiptline_escape(&input.store_name)));
    for hl in &input.header_lines {
        let t = hl.trim();
        if !t.is_empty() {
            lines.extend(centered_lines(&[t.to_string()]).lines().map(str::to_string));
        }
    }
    lines.push("| ^^^ALTERATIONS CARD |".to_string());
    lines.push(format!("| {} |", created_local.format("%m/%d/%Y %I:%M %p")));
    lines.push(String::new());
    lines.push(format!(
        "Customer: {}",
        receiptline_escape(&input.customer_name)
    ));
    if let Some(phone) = input.customer_phone.as_deref() {
        let t = phone.trim();
        if !t.is_empty() {
            lines.push(format!("Phone: {}", receiptline_escape(t)));
        }
    }
    if let Some(ticket) = input.ticket_number.as_deref() {
        let t = ticket.trim();
        if !t.is_empty() {
            lines.push(format!("Ticket #: {}", receiptline_escape(t)));
        }
    }
    lines.push(format!(
        "Alteration ID: {}",
        receiptline_escape(&input.alteration_id)
    ));
    lines.push(String::new());
    if let Some(desc) = input.item_description.as_deref() {
        let t = desc.trim();
        if !t.is_empty() {
            lines.push(format!("Item: {}", receiptline_escape(t)));
        }
    }
    if let Some(work) = input.work_requested.as_deref() {
        let t = work.trim();
        if !t.is_empty() {
            lines.push(format!("Work: {}", receiptline_escape(t)));
        }
    }
    if let Some(due) = input.due_at {
        let due_local = due.with_timezone(&tz);
        lines.push(format!("Due: {}", due_local.format("%m/%d/%Y")));
    }
    if let Some(fitting) = input.fitting_at {
        let fitting_local = fitting.with_timezone(&tz);
        lines.push(format!(
            "Scheduled: {}",
            fitting_local.format("%m/%d/%Y %I:%M %p")
        ));
    }
    if let Some(notes) = input.notes.as_deref() {
        let t = notes.trim();
        if !t.is_empty() {
            lines.push(String::new());
            lines.push(format!("Notes: {}", receiptline_escape(t)));
        }
    }
    lines.push(String::new());
    lines.push("---".to_string());
    for fl in &input.footer_lines {
        let t = fl.trim();
        if !t.is_empty() {
            lines.extend(centered_lines(&[t.to_string()]).lines().map(str::to_string));
        }
    }
    lines.push("=".to_string());
    lines.join("\n")
}

pub fn build_alteration_card_escpos(input: &AlterationCardInput, cfg: &ReceiptConfig) -> Vec<u8> {
    let tz: Tz = cfg.timezone.parse().unwrap_or_else(|_| {
        tracing::warn!(timezone = %cfg.timezone, "Alteration card timezone invalid; falling back to UTC");
        chrono_tz::UTC
    });
    let created_local = input.created_at.with_timezone(&tz);
    let mut out = Vec::new();
    out.extend_from_slice(&[0x1b, 0x40]);
    out.extend_from_slice(&[0x1b, 0x74, 0x00]);
    push_raw_line(&mut out, "");
    set_align(&mut out, 1);
    set_bold(&mut out, true);
    set_text_size(&mut out, 0x11);
    push_line(&mut out, &cfg.store_name);
    set_text_size(&mut out, 0x00);
    set_bold(&mut out, false);
    for hl in &cfg.header_lines {
        let t = hl.trim();
        if !t.is_empty() {
            push_line(&mut out, t);
        }
    }
    set_bold(&mut out, true);
    push_line(&mut out, "ALTERATIONS CARD");
    set_bold(&mut out, false);
    push_line(
        &mut out,
        &created_local.format("%m/%d/%Y %I:%M %p").to_string(),
    );
    set_align(&mut out, 0);
    divider(&mut out);
    push_line(
        &mut out,
        &format!("Customer: {}", ascii_clean(&input.customer_name)),
    );
    if let Some(phone) = input.customer_phone.as_deref() {
        let t = phone.trim();
        if !t.is_empty() {
            push_line(&mut out, &format!("Phone: {}", ascii_clean(t)));
        }
    }
    if let Some(ticket) = input.ticket_number.as_deref() {
        let t = ticket.trim();
        if !t.is_empty() {
            push_line(&mut out, &format!("Ticket #: {}", ascii_clean(t)));
        }
    }
    push_line(
        &mut out,
        &format!("ID: {}", ascii_clean(&input.alteration_id)),
    );
    divider(&mut out);
    if let Some(desc) = input.item_description.as_deref() {
        let t = desc.trim();
        if !t.is_empty() {
            for line in wrap_text(&format!("Item: {t}"), CPL) {
                push_line(&mut out, &line);
            }
        }
    }
    if let Some(work) = input.work_requested.as_deref() {
        let t = work.trim();
        if !t.is_empty() {
            for line in wrap_text(&format!("Work: {t}"), CPL) {
                push_line(&mut out, &line);
            }
        }
    }
    if let Some(due) = input.due_at {
        let due_local = due.with_timezone(&tz);
        push_line(&mut out, &format!("Due: {}", due_local.format("%m/%d/%Y")));
    }
    if let Some(fitting) = input.fitting_at {
        let fitting_local = fitting.with_timezone(&tz);
        push_line(
            &mut out,
            &format!("Scheduled: {}", fitting_local.format("%m/%d/%Y %I:%M %p")),
        );
    }
    if let Some(notes) = input.notes.as_deref() {
        let t = notes.trim();
        if !t.is_empty() {
            divider(&mut out);
            for line in wrap_text(&format!("Notes: {t}"), CPL) {
                push_line(&mut out, &line);
            }
        }
    }
    divider(&mut out);
    set_align(&mut out, 1);
    for fl in &cfg.footer_lines {
        let t = fl.trim();
        if !t.is_empty() {
            push_line(&mut out, t);
        }
    }
    set_align(&mut out, 0);
    out.extend_from_slice(b"\n\n\n\n");
    out.extend_from_slice(&[0x1d, 0x56, 0x41, 0x00]);
    out
}
