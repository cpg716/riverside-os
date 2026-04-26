//! ESC/POS helpers for Epson TM-m30III-compatible receipt printers.

use base64::Engine;
use chrono_tz::Tz;
use image::codecs::png::PngEncoder;
use image::{ColorType, ImageEncoder};
use rust_decimal::Decimal;
use std::collections::HashMap;

use crate::api::settings::ReceiptConfig;
use crate::logic::receipt_zpl::{order_status_label, ReceiptOrderForZpl};
use crate::models::DbFulfillmentType;

const CPL: usize = 42;
const RECEIPT_LOGO_WIDTH_PX: u32 = 180;
const RECEIPT_LOGO_PNG: &[u8] = include_bytes!("../../../client/src/assets/images/logo1.png");

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

fn receiptline_escape(s: &str) -> String {
    ascii_clean(s)
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace('{', "\\{")
        .replace('}', "\\}")
}

fn receiptline_logo_image() -> String {
    let Ok(img) = image::load_from_memory(RECEIPT_LOGO_PNG) else {
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

fn receipt_template_with_logo_slot(template: &str, show_logo: bool) -> String {
    if !show_logo || template.contains("{{LOGO_IMAGE}}") {
        return template.to_string();
    }
    format!("{{{{LOGO_IMAGE}}}}\n{template}")
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

fn receipt_ref(d: &ReceiptOrderForZpl) -> String {
    d.transaction_id
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>()
        .to_uppercase()
}

fn receipt_date(d: &ReceiptOrderForZpl, cfg: &ReceiptConfig) -> String {
    let tz: Tz = cfg.timezone.parse().unwrap_or(chrono_tz::America::New_York);
    d.booked_at
        .with_timezone(&tz)
        .format("%m/%d/%Y %I:%M %p")
        .to_string()
}

fn centered_lines(lines: &[String]) -> String {
    lines
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|line| format!("^{}", receiptline_escape(line)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn receiptline_item_lines(d: &ReceiptOrderForZpl, gift: bool) -> String {
    let mut lines = Vec::new();
    for it in &d.items {
        let var = it
            .variation_label
            .as_deref()
            .map(|v| format!(" ({v})"))
            .unwrap_or_default();
        let name = receiptline_escape(&format!("{}x {}{var}", it.quantity, it.product_name));
        if gift {
            lines.push(name);
            lines.push(format!("SKU {}", receiptline_escape(&it.sku)));
        } else {
            lines.push(format!("{name} | {}", money(it.unit_price)));
            lines.push(format!("SKU {}", receiptline_escape(&it.sku)));
            if let Some(orig) = it.original_unit_price {
                if orig > it.unit_price && orig > Decimal::ZERO {
                    lines.push(format!("Reg {} Sale {}", money(orig), money(it.unit_price)));
                }
            }
            if let Some(label) = &it.discount_event_label {
                let t = label.trim();
                if !t.is_empty() {
                    lines.push(format!("Discount: {}", receiptline_escape(t)));
                }
            }
        }
        let status_label = match it.fulfillment {
            DbFulfillmentType::Takeaway => "Taken home today",
            DbFulfillmentType::WeddingOrder => "Wedding order",
            DbFulfillmentType::SpecialOrder | DbFulfillmentType::Custom => "Order",
            DbFulfillmentType::Layaway => "Layaway",
        };
        lines.push(receiptline_escape(status_label));
        lines.push(String::new());
    }
    lines.join("\n")
}

fn receiptline_payment_lines(d: &ReceiptOrderForZpl) -> String {
    if d.payment_applications.is_empty() {
        return String::new();
    }
    let mut lines = vec!["Applied payments:".to_string()];
    for app in &d.payment_applications {
        lines.push(format!(
            "Payment on {} | {}",
            receiptline_escape(&app.target_display_id),
            money(app.amount)
        ));
        lines.push(format!("Remaining | {}", money(app.remaining_balance)));
    }
    lines.join("\n")
}

fn default_receiptline_template() -> &'static str {
    "{{LOGO_IMAGE}}\n{{STORE_NAME}}\n{{HEADER_LINES}}\n{{RECEIPT_TITLE}}\n{{RECEIPT_ID}}\n{{RECEIPT_DATE}}\n{{CUSTOMER_LINE}}\n---\n{{ITEM_LINES}}\n{{PAYMENT_BLOCK}}\n{{TOTAL_LINE}}\n{{PAID_LINE}}\n{{BALANCE_LINE}}\n{{TENDER_LINE}}\n{{STATUS_LINE}}\n{{TAX_EXEMPT_LINE}}\n---\n{{FOOTER_LINES}}\n{{CUT}}"
}

pub fn build_receiptline_markdown(
    d: &ReceiptOrderForZpl,
    cfg: &ReceiptConfig,
    params: &HashMap<String, String>,
) -> String {
    let gift = truthy_param(params, "gift");
    let template = match cfg.receiptline_template.as_deref().map(str::trim) {
        Some(value) if !value.is_empty() => value,
        _ => default_receiptline_template(),
    };
    let template = receipt_template_with_logo_slot(template, cfg.show_logo);
    let title = if gift {
        "^^^GIFT RECEIPT"
    } else {
        "^^^RECEIPT"
    };
    let customer_line = d
        .customer
        .as_ref()
        .map(|c| format!("Customer: {}", receiptline_escape(&c.display_name)))
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
    let tender_line = if gift {
        String::new()
    } else {
        format!(
            "Tender | {}",
            receiptline_escape(&d.payment_methods_summary)
        )
    };
    let status_line = if gift {
        String::new()
    } else {
        format!(
            "Status | {}",
            receiptline_escape(order_status_label(d.status))
        )
    };
    let tax_exempt_line = if !gift && d.is_tax_exempt {
        format!(
            "TAX EXEMPT | {}",
            receiptline_escape(d.tax_exempt_reason.as_deref().unwrap_or("Yes"))
        )
    } else {
        String::new()
    };
    let store_name = format!("^{}", receiptline_escape(&cfg.store_name));
    let header_lines = centered_lines(&cfg.header_lines);
    let receipt_id = format!("^Receipt {}", receipt_ref(d));
    let receipt_date = format!("^{}", receipt_date(d, cfg));
    let item_lines = receiptline_item_lines(d, gift);
    let payment_block_value = if gift { "" } else { payment_block.as_str() };
    let total_line = if gift {
        String::new()
    } else {
        format!("^Total | ^{}", money(d.total_price))
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

    template
        .replace("{{LOGO_IMAGE}}", &logo_image)
        .replace("{{STORE_NAME}}", &store_name)
        .replace("{{HEADER_LINES}}", &header_lines)
        .replace("{{RECEIPT_TITLE}}", title)
        .replace("{{RECEIPT_ID}}", &receipt_id)
        .replace("{{RECEIPT_DATE}}", &receipt_date)
        .replace("{{CUSTOMER_LINE}}", &customer_line)
        .replace("{{ITEM_LINES}}", &item_lines)
        .replace("{{PAYMENT_BLOCK}}", payment_block_value)
        .replace("{{TOTAL_LINE}}", &total_line)
        .replace("{{PAID_LINE}}", &paid_line)
        .replace("{{BALANCE_LINE}}", &balance_line)
        .replace("{{TENDER_LINE}}", &tender_line)
        .replace("{{STATUS_LINE}}", &status_line)
        .replace("{{TAX_EXEMPT_LINE}}", &tax_exempt_line)
        .replace("{{FOOTER_LINES}}", &footer_lines)
        .replace("{{CUT}}", "=")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
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
