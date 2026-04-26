//! ESC/POS helpers for Epson TM-m30III-compatible receipt printers.

use chrono_tz::Tz;
use rust_decimal::Decimal;
use std::collections::HashMap;

use crate::api::settings::ReceiptConfig;
use crate::logic::receipt_zpl::{order_status_label, ReceiptOrderForZpl};
use crate::models::DbFulfillmentType;

const CPL: usize = 42;

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

fn push_header(out: &mut Vec<u8>, d: &ReceiptOrderForZpl, cfg: &ReceiptConfig, gift: bool) {
    let tz: Tz = cfg.timezone.parse().unwrap_or(chrono_tz::America::New_York);
    let local_time = d.booked_at.with_timezone(&tz);
    let order_ref = d
        .transaction_id
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>()
        .to_uppercase();

    set_align(out, 1);
    set_bold(out, true);
    set_text_size(out, 0x11);
    push_line(out, &cfg.store_name);
    set_text_size(out, 0x00);
    set_bold(out, false);
    for hl in &cfg.header_lines {
        let t = hl.trim();
        if !t.is_empty() {
            push_line(out, t);
        }
    }
    if gift {
        set_bold(out, true);
        push_line(out, "GIFT RECEIPT");
        set_bold(out, false);
    }
    push_line(out, &format!("Receipt {order_ref}"));
    push_line(out, &local_time.format("%m/%d/%Y %I:%M %p").to_string());
    set_align(out, 0);
    if let Some(c) = &d.customer {
        push_line(out, &format!("Customer: {}", c.display_name));
    }
    divider(out);
}

fn push_items(out: &mut Vec<u8>, d: &ReceiptOrderForZpl, gift: bool) {
    for it in &d.items {
        let var = it
            .variation_label
            .as_deref()
            .map(|v| format!(" ({v})"))
            .unwrap_or_default();
        let name = format!("{}x {}{var}", it.quantity, it.product_name);
        for line in wrap_text(&name, CPL) {
            push_line(out, &line);
        }
        if gift {
            push_line(out, &format!("SKU {}", it.sku));
        } else {
            push_line(
                out,
                &right_pair(&format!("SKU {}", it.sku), &money(it.unit_price)),
            );
            if let Some(orig) = it.original_unit_price {
                if orig > it.unit_price && orig > Decimal::ZERO {
                    push_line(
                        out,
                        &format!("Reg {}  Sale {}", money(orig), money(it.unit_price)),
                    );
                }
            }
            if let Some(label) = &it.discount_event_label {
                let t = label.trim();
                if !t.is_empty() {
                    push_line(out, &format!("Discount: {t}"));
                }
            }
        }
        let status_label = match it.fulfillment {
            DbFulfillmentType::Takeaway => "Taken home today",
            DbFulfillmentType::WeddingOrder => "Wedding order",
            DbFulfillmentType::SpecialOrder | DbFulfillmentType::Custom => "Order",
            DbFulfillmentType::Layaway => "Layaway",
        };
        push_line(out, status_label);
        out.push(b'\n');
    }
}

fn push_totals(out: &mut Vec<u8>, d: &ReceiptOrderForZpl) {
    divider(out);
    set_bold(out, true);
    push_line(out, &right_pair("Total", &money(d.total_price)));
    set_bold(out, false);
    push_line(out, &right_pair("Paid", &money(d.amount_paid)));
    if d.balance_due > Decimal::ZERO {
        push_line(out, &right_pair("Balance", &money(d.balance_due)));
    }
    push_line(out, &format!("Tender: {}", d.payment_methods_summary));
    if !d.payment_applications.is_empty() {
        push_line(out, "Applied payments:");
        for app in &d.payment_applications {
            push_line(
                out,
                &format!(
                    "Payment on {} {} rem {}",
                    app.target_display_id,
                    money(app.amount),
                    money(app.remaining_balance)
                ),
            );
        }
    }
    push_line(out, &format!("Status: {}", order_status_label(d.status)));
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
    set_align(out, 1);
    for fl in &cfg.footer_lines {
        let t = fl.trim();
        if !t.is_empty() {
            push_line(out, t);
        }
    }
    set_align(out, 0);
}

pub fn build_receipt_escpos(
    d: &ReceiptOrderForZpl,
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
