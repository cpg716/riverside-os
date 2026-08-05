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
    payment_summary_has_receipt_detail, receipt_display_ref, tender_display_label, ReceiptLine,
    ReceiptLineAdjustment, ReceiptOrder,
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
    let rounded = v.round_dp(2);
    if rounded < Decimal::ZERO {
        format!("-${:.2}", -rounded)
    } else {
        format!("${rounded:.2}")
    }
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
    if !next.contains("{{RECEIPT_DATE}}") {
        next = if next.contains("{{RECEIPT_ID}}") {
            next.replacen("{{RECEIPT_ID}}", "{{RECEIPT_ID}}\n{{RECEIPT_DATE}}", 1)
        } else {
            format!("{{{{RECEIPT_DATE}}}}\n{next}")
        };
    }
    if !next.contains("{{REGISTER_LINE}}") {
        next = if next.contains("{{CASHIER_LINE}}") {
            next.replacen("{{CASHIER_LINE}}", "{{CASHIER_LINE}}\n{{REGISTER_LINE}}", 1)
        } else {
            format!("{next}\n{{{{REGISTER_LINE}}}}")
        };
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
    if !next.contains("{{WEDDING_DEPOSIT_LINES}}") {
        if next.contains("{{STATUS_LINE}}") {
            next = next.replacen(
                "{{STATUS_LINE}}",
                "{{WEDDING_DEPOSIT_LINES}}\n{{STATUS_LINE}}",
                1,
            );
        } else {
            next = format!("{next}\n{{{{WEDDING_DEPOSIT_LINES}}}}");
        }
    }
    if !next.contains("{{PAYMENT_BLOCK}}") {
        if next.contains("{{PAYMENT_HISTORY_BLOCK}}") {
            next = next.replacen(
                "{{PAYMENT_HISTORY_BLOCK}}",
                "{{PAYMENT_BLOCK}}\n{{PAYMENT_HISTORY_BLOCK}}",
                1,
            );
        } else if next.contains("{{SUBTOTAL_LINE}}") {
            next = next.replacen(
                "{{SUBTOTAL_LINE}}",
                "{{PAYMENT_BLOCK}}\n{{SUBTOTAL_LINE}}",
                1,
            );
        } else {
            next = format!("{next}\n{{{{PAYMENT_BLOCK}}}}");
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
    } else if !d.receipt_kind.is_standard_sale() {
        set_bold(out, true);
        push_line(out, d.receipt_kind.title());
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
    if let Some(register_lane) = d.register_lane {
        push_line(out, &format!("Register #{register_lane}"));
    }
    divider(out);
}

fn push_items(out: &mut Vec<u8>, d: &ReceiptOrder, gift: bool) {
    let mut wedding_context_printed = false;
    for it in &d.items {
        if is_simple_fee_line(it) {
            set_bold(out, true);
            let label = simple_fee_label(it);
            if gift {
                push_line(out, label);
            } else {
                push_line(out, &right_pair(label, &money(line_total(it))));
                if let Some(tax_amount) = it.tax_amount {
                    push_line(out, &right_pair("Tax", &money(tax_amount)));
                }
            }
            set_bold(out, false);
            out.push(b'\n');
            continue;
        }
        if it.adjustment.is_some()
            || is_rms_charge_payment_line(it)
            || is_alteration_service_line(it)
            || is_linked_pickup_line(it)
        {
            let label = receipt_item_section_label(d, it);
            set_bold(out, true);
            push_line(out, label);
            set_bold(out, false);
        }
        if receipt_item_section_label(d, it) == "Wedding Order" && !wedding_context_printed {
            set_bold(out, true);
            push_line(out, "Wedding Order");
            set_bold(out, false);
            for line in d.wedding_order_context_lines() {
                push_line(out, &line);
            }
            wedding_context_printed = true;
        }
        set_bold(out, true);
        for line in wrap_text(it.product_name.trim(), CPL) {
            push_line(out, &line);
        }
        set_bold(out, false);
        if it.quantity != 1 {
            push_line(out, &format!("Qty {}", it.quantity));
        }
        if let Some(description) = alteration_customer_item_description(it) {
            push_line(out, &format!("Customer item: {description}"));
        } else if let Some(var) = it
            .variation_label
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            let label = if is_alteration_service_line(it) {
                "Customer item"
            } else {
                "Variation"
            };
            push_line(out, &format!("{label}: {var}"));
        }
        if is_linked_pickup_line(it) {
            if let Some(source_label) = it
                .discount_event_label
                .as_deref()
                .map(str::trim)
                .filter(|label| !label.is_empty())
            {
                push_line(out, source_label);
            }
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
        }
        if let Some(code) = it
            .gift_card_load_code
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            push_line(out, &format!("Gift Card #: {code}"));
        }
        if !gift {
            if let Some(tax_amount) = it.tax_amount {
                push_line(out, &right_pair("Tax", &money(tax_amount)));
            }
        }
        let status_label = if matches!(it.adjustment, Some(ReceiptLineAdjustment::Exchanged)) {
            "Exchanged item"
        } else if matches!(it.adjustment, Some(ReceiptLineAdjustment::Returned)) {
            "Returned / refunded item"
        } else if is_rms_charge_payment_line(it) {
            "Payment on RMS Charge"
        } else if is_alteration_service_line(it) {
            "Alteration service"
        } else if is_linked_pickup_line(it) {
            "Picked up"
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
    push_line(out, &right_pair("Sales Tax", &money(d.tax_total)));
    if d.total_savings > Decimal::ZERO {
        push_line(out, &right_pair("Total Savings", &money(d.total_savings)));
    }
    set_bold(out, true);
    push_line(out, &right_pair(d.total_label(), &money(d.total_price)));
    set_bold(out, false);
    if d.show_paid_line() {
        push_line(out, &right_pair(d.paid_label(), &money(d.amount_paid)));
    }
    if let Some(prior_paid) = d.pickup_prior_paid {
        push_line(out, &right_pair("Previously paid", &money(prior_paid)));
    }
    if d.balance_due > Decimal::ZERO || d.is_pickup_event() {
        push_line(out, &right_pair("Balance remaining", &money(d.balance_due)));
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
    if !d.wedding_deposits.is_empty() {
        for deposit in &d.wedding_deposits {
            let beneficiary = deposit
                .beneficiary_name
                .as_deref()
                .map(|name| format!(" for {name}"))
                .unwrap_or_default();
            push_line(
                out,
                &right_pair(
                    &format!(
                        "Wedding Party Deposit{} ({})",
                        beneficiary, deposit.party_name
                    ),
                    &money(deposit.amount),
                ),
            );
            if let Some(destination) = deposit.destination_label.as_deref() {
                push_line(out, &format!("  {destination}"));
            }
        }
    } else if d.wedding_deposit_amount > Decimal::ZERO {
        push_line(
            out,
            &right_pair("Wedding Party Deposit", &money(d.wedding_deposit_amount)),
        );
    }
    for source in &d.applied_wedding_deposits {
        push_line(
            out,
            &right_pair("Wedding Deposit Applied", &money(source.amount)),
        );
        push_line(
            out,
            &format!("  Paid by {} · {}", source.payer_name, source.party_name),
        );
    }
    if !d.payment_applications.is_empty() {
        push_line(out, &format!("{}:", d.order_payment_heading()));
        for app in &d.payment_applications {
            push_line(
                out,
                &right_pair(
                    &format!("{} {}", app.activity_label(), app.target_display_id),
                    &money(app.amount),
                ),
            );
            push_line(
                out,
                &right_pair("Remaining balance", &money(app.remaining_balance)),
            );
        }
    }
    push_line(out, &format!("Status: {}", d.customer_status_label()));
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

    for it in d.items.iter().filter(|item| is_simple_fee_line(item)) {
        let label = receiptline_emphasis(simple_fee_label(it));
        if gift {
            out_lines.push(format!("{label} |"));
        } else {
            out_lines.push(format!("{label} | {}", money(line_total(it))));
            if let Some(tax_amount) = it.tax_amount {
                out_lines.push(format!("Tax | {}", money(tax_amount)));
            }
        }
    }

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
                if is_simple_fee_line(it) {
                    return false;
                }
                let section = receipt_item_section_label(d, it);
                section == label
                    && (!is_pickup || matches!(section, "PICKED UP" | "Alterations" | "Shipping"))
            })
            .collect();

        if items.is_empty() {
            continue;
        }

        if !out_lines.is_empty() {
            out_lines.push(String::new());
        }

        out_lines.push(format!("^^^{}", receiptline_escape(label)));

        if label == "Wedding Order" {
            out_lines.extend(
                d.wedding_order_context_lines()
                    .into_iter()
                    .map(|line| receiptline_escape(&line)),
            );
        }

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
                if let Some(description) = alteration_customer_item_description(it) {
                    out_lines.push(format!(
                        "Customer item: {} |",
                        receiptline_escape(description)
                    ));
                } else if let Some(v) = variation {
                    let label = if is_alteration_service_line(it) {
                        "Customer item"
                    } else {
                        "Variation"
                    };
                    out_lines.push(format!("{label}: {} |", receiptline_escape(v)));
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
                if let Some(description) = alteration_customer_item_description(it) {
                    out_lines.push(format!(
                        "Customer item: {} |",
                        receiptline_escape(description)
                    ));
                } else if let Some(v) = variation {
                    let label = if is_alteration_service_line(it) {
                        "Customer item"
                    } else {
                        "Variation"
                    };
                    out_lines.push(format!("{label}: {} |", receiptline_escape(v)));
                }
                if is_linked_pickup_line(it) {
                    if let Some(source_label) = it
                        .discount_event_label
                        .as_deref()
                        .map(str::trim)
                        .filter(|source_label| !source_label.is_empty())
                    {
                        out_lines.push(format!("{} |", receiptline_escape(source_label)));
                    }
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
                if let Some(tax_amount) = it.tax_amount {
                    out_lines.push(format!("Tax | {}", money(tax_amount)));
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

fn alteration_customer_item_description(
    it: &crate::logic::receipt_shared::ReceiptLine,
) -> Option<&str> {
    is_alteration_service_line(it)
        .then_some(())
        .and_then(|_| it.custom_order_details.as_ref())
        .and_then(serde_json::Value::as_object)
        .and_then(|details| details.get("alteration_item_description"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn is_shipping_fee_line(it: &crate::logic::receipt_shared::ReceiptLine) -> bool {
    it.custom_item_type.as_deref() == Some("shipping_fee")
        || it.sku.trim().eq_ignore_ascii_case("ROS-SHIPPING-FEE")
}

fn is_alteration_fee_line(it: &crate::logic::receipt_shared::ReceiptLine) -> bool {
    it.custom_item_type.as_deref() == Some("alteration_fee")
        || it.sku.trim().eq_ignore_ascii_case("ROS-ALTERATION-FEE")
}

fn is_simple_fee_line(it: &crate::logic::receipt_shared::ReceiptLine) -> bool {
    is_shipping_fee_line(it) || is_alteration_fee_line(it)
}

fn is_linked_pickup_line(it: &crate::logic::receipt_shared::ReceiptLine) -> bool {
    it.custom_item_type.as_deref() == Some("linked_pickup")
}

fn simple_fee_label(it: &crate::logic::receipt_shared::ReceiptLine) -> &'static str {
    if is_shipping_fee_line(it) {
        "SHIPPING FEE"
    } else {
        "ALTERATION FEE"
    }
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
    if is_linked_pickup_line(it) {
        return "PICKED UP";
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
    if d.payment_applications.is_empty() && !d.is_pickup_event() {
        return String::new();
    }
    let mut lines = Vec::new();
    if d.is_pickup_event() {
        lines.push("^^^Pickup payment status".to_string());
        if let Some(prior_paid) = d.pickup_prior_paid {
            lines.push(format!("Previously paid | {}", money(prior_paid)));
        }
    }
    if !d.payment_applications.is_empty() {
        lines.push(format!("^^^{}", d.order_payment_heading()));
    }
    for app in &d.payment_applications {
        lines.push(format!(
            "{} {} | {}",
            app.activity_label(),
            receiptline_escape(&app.target_display_id),
            money(app.amount)
        ));
        lines.push(format!(
            "Remaining balance | {}",
            money(app.remaining_balance)
        ));
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

fn receiptline_wedding_deposit_lines(d: &ReceiptOrder, gift: bool) -> String {
    if gift {
        return String::new();
    }
    if !d.wedding_deposits.is_empty() {
        return d
            .wedding_deposits
            .iter()
            .map(|deposit| {
                let beneficiary = deposit
                    .beneficiary_name
                    .as_deref()
                    .map(|name| format!(" for {}", receiptline_escape(name)))
                    .unwrap_or_default();
                format!(
                    "Wedding Party Deposit{} ({}) | {}{}",
                    beneficiary,
                    receiptline_escape(&deposit.party_name),
                    money(deposit.amount),
                    deposit
                        .destination_label
                        .as_deref()
                        .map(|label| format!("\n  {}", receiptline_escape(label)))
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    if d.wedding_deposit_amount > Decimal::ZERO {
        return format!(
            "Wedding Party Deposit | {}",
            money(d.wedding_deposit_amount)
        );
    }
    d.applied_wedding_deposits
        .iter()
        .map(|source| {
            format!(
                "Wedding Deposit Applied | {}\n  Paid by {} · {}",
                money(source.amount),
                receiptline_escape(&source.payer_name),
                receiptline_escape(&source.party_name)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
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

fn default_receiptline_template() -> &'static str {
    "{{LOGO_IMAGE}}\n{{HEADER_LINES}}\n{{RECEIPT_TITLE}}\n{{RECEIPT_ID}}\n{{RECEIPT_DATE}}\n{{CUSTOMER_LINE}}\n{{SALESPERSON_LINE}}\n{{CASHIER_LINE}}\n{{REGISTER_LINE}}\n---\n{{ITEM_LINES}}\n{{LOYALTY_EARNED}}\n{{LOYALTY_BALANCE}}\n{{PAYMENT_BLOCK}}\n{{SUBTOTAL_LINE}}\n{{TAX_LINE}}\n{{TOTAL_SAVINGS_LINE}}\n{{TOTAL_LINE}}\n{{PAID_LINE}}\n{{BALANCE_LINE}}\n{{TENDER_LINE}}\n{{GIFT_CARD_BALANCE}}\n{{WEDDING_DEPOSIT_LINES}}\n{{STATUS_LINE}}\n{{TAX_EXEMPT_LINE}}\n---\n{{BARCODE_IMAGE}}\n{{FOOTER_LINES}}\n{{CUT}}"
}

fn default_receiptline_pickup_template() -> &'static str {
    "{{LOGO_IMAGE}}\n{{HEADER_LINES}}\n{{RECEIPT_TITLE}}\n{{RECEIPT_ID}}\n{{RECEIPT_DATE}}\n{{CUSTOMER_LINE}}\n{{SALESPERSON_LINE}}\n{{CASHIER_LINE}}\n{{REGISTER_LINE}}\n---\n{{ITEM_LINES}}\n{{PAYMENT_BLOCK}}\n---\n{{PAYMENT_HISTORY_BLOCK}}\n{{SUBTOTAL_LINE}}\n{{TAX_LINE}}\n{{TOTAL_SAVINGS_LINE}}\n{{TOTAL_LINE}}\n{{PAID_LINE}}\n{{BALANCE_LINE}}\n{{GIFT_CARD_BALANCE}}\n{{WEDDING_DEPOSIT_LINES}}\n{{STATUS_LINE}}\n---\n{{BARCODE_IMAGE}}\n{{FOOTER_LINES}}\n{{CUT}}"
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
    let mut template = receipt_template_with_slots(template, cfg.show_logo, cfg.show_barcode);
    if !gift && !d.receipt_kind.is_standard_sale() && !template.contains("{{RECEIPT_TITLE}}") {
        template = if template.contains("{{RECEIPT_ID}}") {
            template.replacen("{{RECEIPT_ID}}", "{{RECEIPT_TITLE}}\n{{RECEIPT_ID}}", 1)
        } else {
            format!("{{{{RECEIPT_TITLE}}}}\n{template}")
        };
    }
    let title = if gift {
        "| ^^^GIFT RECEIPT |".to_string()
    } else {
        format!("| ^^^{} |", receiptline_escape(d.receipt_kind.title()))
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
    let register_line = d
        .register_lane
        .map(|register_lane| format!("Register #{register_lane}"))
        .unwrap_or_default();
    let payment_lines = receiptline_payment_lines(d);
    let payment_block = if payment_lines.is_empty() {
        String::new()
    } else {
        format!("---\n{payment_lines}")
    };
    let balance_line = if !gift && (d.balance_due > Decimal::ZERO || d.is_pickup_event()) {
        format!("Balance remaining | {}", money(d.balance_due))
    } else {
        String::new()
    };
    let tender_line = receiptline_tender_lines(d, gift);
    let wedding_deposit_lines = receiptline_wedding_deposit_lines(d, gift);
    let gift_card_balance_line = receiptline_gift_card_balance_line(d, gift);
    let status_line = if gift {
        String::new()
    } else {
        format!("Status | {}", receiptline_escape(d.customer_status_label()))
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
    let receipt_date = format!("| {} |", receipt_date(d, cfg));
    let item_lines = receiptline_item_lines(d, cfg, gift, is_pickup);
    let payment_block_value = if gift { "" } else { payment_block.as_str() };
    let total_line = if gift {
        String::new()
    } else {
        format!("{} | ^^{}", d.total_label(), money(d.total_price))
    };
    let subtotal_line = if gift {
        String::new()
    } else {
        format!("Subtotal | {}", money(d.subtotal_price))
    };
    let tax_line = if gift {
        String::new()
    } else {
        format!("Sales Tax | {}", money(d.tax_total))
    };
    let total_savings_line = if !gift && d.total_savings > Decimal::ZERO {
        format!("Total Savings | {}", money(d.total_savings))
    } else {
        String::new()
    };
    let paid_line = if gift || !d.show_paid_line() {
        String::new()
    } else {
        format!("{} | {}", d.paid_label(), money(d.amount_paid))
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
        .replace("{{RECEIPT_TITLE}}", &title)
        .replace("{{RECEIPT_ID}}", &receipt_id)
        .replace("{{RECEIPT_DATE}}", &receipt_date)
        .replace("{{CUSTOMER_LINE}}", &customer_line)
        .replace("{{CASHIER_LINE}}", &cashier_line)
        .replace("{{SALESPERSON_LINE}}", &salesperson_line)
        .replace("{{REGISTER_LINE}}", &register_line)
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
        .replace("{{WEDDING_DEPOSIT_LINES}}", &wedding_deposit_lines)
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
    use crate::logic::receipt_shared::{
        ReceiptKind, ReceiptLine, ReceiptOrder, ReceiptPayment, ReceiptWeddingPartyDeposit,
    };
    use crate::models::DbOrderStatus;
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;

    fn receipt_order_with(items: Vec<ReceiptLine>) -> ReceiptOrder {
        ReceiptOrder {
            transaction_id: Uuid::nil(),
            transaction_display_id: "TXN-TEST".to_string(),
            register_lane: Some(1),
            receipt_kind: ReceiptKind::StandardSale,
            booked_at: Utc::now(),
            backdated_business_date: None,
            status: DbOrderStatus::Fulfilled,
            subtotal_price: Decimal::ZERO,
            tax_total: Decimal::ZERO,
            total_price: Decimal::ZERO,
            total_savings: Decimal::ZERO,
            amount_paid: Decimal::ZERO,
            wedding_deposit_amount: Decimal::ZERO,
            wedding_deposits: Vec::new(),
            applied_wedding_deposits: Vec::new(),
            balance_due: Decimal::ZERO,
            payment_methods_summary: "Cash".to_string(),
            payment_applications: Vec::new(),
            pickup_prior_paid: None,
            pickup_balance_remaining: None,
            customer: None,
            wedding_party_name: None,
            wedding_event_date: None,
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
            is_taxable: Some(true),
            tax_amount: Some(Decimal::new(213, 2)),
        }
    }

    #[test]
    fn receiptline_groups_rms_payments_and_alterations() {
        let order = receipt_order_with(vec![
            receipt_line("RMS CHARGE PAYMENT", "ROS-RMS-CHARGE-PAYMENT", None),
            receipt_line(
                "Alteration: Hem Pants",
                "ROS-ALTERATION-SERVICE",
                Some("alteration_service"),
            ),
            receipt_line("SHIPPING FEE", "ROS-SHIPPING-FEE", Some("shipping_fee")),
        ]);

        let lines = receiptline_item_lines(&order, &ReceiptConfig::default(), false, false);

        assert!(lines.contains("^^^PAYMENT"));
        assert!(lines.contains("RMS CHARGE PAYMENT"));
        assert!(lines.contains("^^^Alterations"));
        assert!(lines.contains("Alteration: Hem Pants"));
        assert!(lines.contains("SHIPPING FEE"));
        assert!(!lines.contains("^^^Shipping"));
    }

    #[test]
    fn customer_receipts_show_saved_line_tax_amounts() {
        let taxable = receipt_line("Taxable suit", "TAXABLE", None);
        let mut exempt = receipt_line("Exempt alteration", "EXEMPT", None);
        exempt.is_taxable = Some(false);
        exempt.tax_amount = Some(Decimal::ZERO);
        let order = receipt_order_with(vec![taxable, exempt]);

        let receiptline = receiptline_item_lines(&order, &ReceiptConfig::default(), false, false);
        let thermal_bytes = build_receipt_escpos(&order, &ReceiptConfig::default(), HashMap::new());
        let thermal = String::from_utf8_lossy(&thermal_bytes);

        for output in [&receiptline, thermal.as_ref()] {
            assert!(output.contains("Tax"));
            assert!(output.contains("$2.13"));
            assert!(output.contains("$0.00"));
            assert!(!output.contains("Tax: Taxable"));
            assert!(!output.contains("Tax: Exempt"));
        }
    }

    #[test]
    fn customer_thermal_receipt_hides_internal_discount_provenance() {
        let mut line = receipt_line("Discounted suit", "B-DISCOUNT", None);
        line.unit_price = Decimal::new(30000, 2);
        line.original_unit_price = Some(Decimal::new(37500, 2));
        line.discount_event_label = Some("Counterpoint imported discount".to_string());
        let order = receipt_order_with(vec![line]);

        let receiptline = receiptline_item_lines(&order, &ReceiptConfig::default(), false, false);

        assert!(receiptline.contains("Reg $375.00 Sale $300.00"));
        assert!(!receiptline.contains("Counterpoint imported discount"));
    }

    #[test]
    fn wedding_party_deposit_names_the_party_in_thermal_formats() {
        let mut order = receipt_order_with(Vec::new());
        order.wedding_deposit_amount = Decimal::new(71038, 2);
        order.wedding_deposits = vec![ReceiptWeddingPartyDeposit {
            party_name: "Whitrock Wedding".to_string(),
            beneficiary_name: Some("James Brown".to_string()),
            destination_label: Some("Held for future order".to_string()),
            amount: Decimal::new(71038, 2),
        }];

        let receiptline = build_receiptline_markdown(
            &order,
            &ReceiptConfig::default(),
            &HashMap::new(),
            &LoyaltyReceiptData::default(),
        );
        let escpos = build_receipt_escpos(&order, &ReceiptConfig::default(), HashMap::new());
        let escpos_text = String::from_utf8_lossy(&escpos);

        assert!(
            receiptline
                .contains("Wedding Party Deposit for James Brown (Whitrock Wedding) | $710.38"),
            "{receiptline}"
        );
        assert!(receiptline.contains("Held for future order"));
        assert!(escpos_text.contains("Wedding Party Deposit for James Brown (Whitrock Wedding)"));
        assert!(escpos_text.contains("$710.38"));
    }

    #[test]
    fn wedding_order_receipts_name_the_party_and_wedding_date() {
        let mut line = receipt_line("Navy wedding suit", "B-WEDDING", None);
        line.fulfillment = DbFulfillmentType::WeddingOrder;
        line.is_fulfilled = false;
        let mut order = receipt_order_with(vec![line]);
        order.wedding_party_name = Some("Adams Wedding".to_string());
        order.wedding_event_date =
            Some(chrono::NaiveDate::from_ymd_opt(2026, 9, 19).expect("valid wedding date"));

        let receiptline = receiptline_item_lines(&order, &ReceiptConfig::default(), false, false);
        let escpos = String::from_utf8_lossy(&build_receipt_escpos(
            &order,
            &ReceiptConfig::default(),
            HashMap::new(),
        ))
        .into_owned();

        for output in [&receiptline, &escpos] {
            assert!(output.contains("Wedding Order"), "{output}");
            assert!(output.contains("Party: Adams Wedding"), "{output}");
            assert!(output.contains("Wedding Date: 09/19/2026"), "{output}");
        }
    }

    #[test]
    fn fee_only_receipt_lines_show_only_the_fee_name_and_price() {
        let mut shipping = receipt_line("Shipping", "ROS-SHIPPING-FEE", Some("shipping_fee"));
        shipping.variation_label = Some("Non-taxable delivery charge".to_string());
        let mut alteration = receipt_line(
            "ALTERATION SERVICE",
            "ROS-ALTERATION-FEE",
            Some("alteration_fee"),
        );
        alteration.variation_label = Some("Fee only — no alteration record".to_string());
        let order = receipt_order_with(vec![shipping, alteration]);

        let thermal = String::from_utf8(build_receipt_escpos(
            &order,
            &ReceiptConfig::default(),
            HashMap::new(),
        ))
        .expect("receipt bytes are text apart from printer controls");
        let markdown = receiptline_item_lines(&order, &ReceiptConfig::default(), false, false);

        for output in [&thermal, &markdown] {
            assert!(output.contains("SHIPPING FEE"));
            assert!(output.contains("ALTERATION FEE"));
            assert!(!output.contains("ROS-SHIPPING-FEE"));
            assert!(!output.contains("ROS-ALTERATION-FEE"));
            assert!(!output.contains("Non-taxable delivery charge"));
            assert!(!output.contains("Fee only"));
        }
        assert!(!markdown.contains("^^^Shipping"));
        assert!(!markdown.contains("^^^Alterations"));
    }

    #[test]
    fn alteration_receipts_show_the_customer_item_description() {
        let mut alteration = receipt_line(
            "Alteration: Hem pants",
            "ROS-ALTERATION-SERVICE",
            Some("alteration_service"),
        );
        alteration.custom_order_details = Some(json!({
            "alteration_item_description": "Customer-owned navy suit pants"
        }));
        let order = receipt_order_with(vec![alteration]);

        let thermal = String::from_utf8(build_receipt_escpos(
            &order,
            &ReceiptConfig::default(),
            HashMap::new(),
        ))
        .expect("receipt bytes are text apart from printer controls");
        let markdown = receiptline_item_lines(&order, &ReceiptConfig::default(), false, false);

        assert!(thermal.contains("Customer item: Customer-owned navy suit pants"));
        assert!(markdown.contains("Customer item: Customer-owned navy suit pants |"));
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
    fn linked_pickups_print_each_source_order_reference() {
        let mut first = receipt_line("First picked-up suit", "SKU-ORDER-A", Some("linked_pickup"));
        first.discount_event_label = Some("Picked up from ORD-100001".to_string());
        let mut second = receipt_line(
            "Second picked-up suit",
            "SKU-ORDER-B",
            Some("linked_pickup"),
        );
        second.discount_event_label = Some("Picked up from ORD-100002".to_string());
        let order = receipt_order_with(vec![first, second]);

        let thermal = String::from_utf8(build_receipt_escpos(
            &order,
            &ReceiptConfig::default(),
            HashMap::new(),
        ))
        .expect("receipt bytes are text apart from printer controls");
        let markdown = receiptline_item_lines(&order, &ReceiptConfig::default(), false, false);

        for source in ["ORD-100001", "ORD-100002"] {
            assert!(thermal.contains(&format!("Picked up from {source}")));
            assert!(markdown.contains(&format!("Picked up from {source} |")));
        }
    }

    #[test]
    fn pickup_receipts_keep_shipping_and_alteration_fee_sections() {
        let order = receipt_order_with(vec![
            receipt_line("Picked up suit", "SKU-PICKUP", None),
            receipt_line(
                "ALTERATIONS FEE",
                "ROS-ALTERATION-FEE",
                Some("alteration_fee"),
            ),
            receipt_line("SHIPPING FEE", "ROS-SHIPPING-FEE", Some("shipping_fee")),
        ]);
        let mut params = HashMap::new();
        params.insert("pickup".to_string(), "true".to_string());

        let markdown = build_receiptline_markdown(
            &order,
            &ReceiptConfig::default(),
            &params,
            &LoyaltyReceiptData::default(),
        );

        assert!(markdown.contains("ALTERATION FEE"));
        assert!(markdown.contains("SHIPPING FEE"));
    }

    #[test]
    fn linked_order_pickups_never_print_as_taken_today() {
        let linked_pickup = receipt_line("Gruppo Bravo Suit", "B-1350131", Some("linked_pickup"));
        let alteration_fee = receipt_line(
            "ALTERATION FEE",
            "ROS-ALTERATION-FEE",
            Some("alteration_fee"),
        );
        let order = receipt_order_with(vec![alteration_fee, linked_pickup]);

        let markdown = build_receiptline_markdown(
            &order,
            &ReceiptConfig::default(),
            &HashMap::new(),
            &LoyaltyReceiptData::default(),
        );
        let escpos = String::from_utf8_lossy(&build_receipt_escpos(
            &order,
            &ReceiptConfig::default(),
            HashMap::new(),
        ))
        .into_owned();

        for output in [markdown, escpos] {
            assert!(output.contains("PICKED UP") || output.contains("Picked up"));
            assert!(!output.contains("Taken Today"));
            assert!(!output.contains("Taken home today"));
        }
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

    #[test]
    fn return_document_titles_render_in_thermal_and_receiptline_formats() {
        for (kind, expected) in [
            (ReceiptKind::ReturnRefund, "RETURN / REFUND"),
            (ReceiptKind::ReturnExchange, "RETURN / EXCHANGE"),
        ] {
            let mut order = receipt_order_with(Vec::new());
            order.receipt_kind = kind;

            let escpos = build_receipt_escpos(&order, &ReceiptConfig::default(), HashMap::new());
            assert!(
                escpos
                    .windows(expected.len())
                    .any(|window| window == expected.as_bytes()),
                "raw ESC/POS should contain {expected}"
            );

            let markdown = build_receiptline_markdown(
                &order,
                &ReceiptConfig::default(),
                &HashMap::new(),
                &LoyaltyReceiptData::default(),
            );
            assert!(markdown.contains(&format!("^^^{expected}")));

            let mut custom_cfg = ReceiptConfig::default();
            custom_cfg.receiptline_template = Some("{{RECEIPT_ID}}".to_string());
            let custom_markdown = build_receiptline_markdown(
                &order,
                &custom_cfg,
                &HashMap::new(),
                &LoyaltyReceiptData::default(),
            );
            assert!(custom_markdown.contains(&format!("^^^{expected}")));
        }
    }

    #[test]
    fn standard_sale_document_title_remains_receipt() {
        let order = receipt_order_with(Vec::new());
        let markdown = build_receiptline_markdown(
            &order,
            &ReceiptConfig::default(),
            &HashMap::new(),
            &LoyaltyReceiptData::default(),
        );

        assert!(markdown.contains("^^^RECEIPT"));
        assert!(!markdown.contains("RETURN /"));
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
