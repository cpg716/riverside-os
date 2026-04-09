//! Plain-text receipt body for SMS / messaging (same order snapshot as ZPL / Receipt Builder merge).

use chrono_tz::Tz;
use rust_decimal::Decimal;

use crate::api::settings::ReceiptConfig;
use crate::logic::receipt_zpl::{order_status_label, ReceiptOrderForZpl};

/// Gift receipt body for SMS when MMS/HTML is not used: items only, no prices or payment details.
pub fn format_pos_gift_receipt_text_message(
    order: &ReceiptOrderForZpl,
    cfg: &ReceiptConfig,
) -> String {
    let tz: Tz = cfg.timezone.parse().unwrap_or(chrono_tz::America::New_York);
    let local_time = order.booked_at.with_timezone(&tz);
    let order_ref: String = order
        .order_id
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>()
        .to_uppercase();

    let mut lines: Vec<String> = Vec::new();
    lines.push(cfg.store_name.trim().to_string());
    lines.push(format!("Gift receipt {order_ref}"));
    lines.push(local_time.format("%m/%d/%Y %I:%M %p").to_string());
    lines.push(String::from("---"));

    if let Some(c) = &order.customer {
        let name = format!("{} {}", c.first_name.trim(), c.last_name.trim())
            .trim()
            .to_string();
        if !name.is_empty() {
            lines.push(name);
        }
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
pub fn format_pos_receipt_text_message(order: &ReceiptOrderForZpl, cfg: &ReceiptConfig) -> String {
    let tz: Tz = cfg.timezone.parse().unwrap_or(chrono_tz::America::New_York);
    let local_time = order.booked_at.with_timezone(&tz);
    let order_ref: String = order
        .order_id
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>()
        .to_uppercase();

    let mut lines: Vec<String> = Vec::new();
    lines.push(cfg.store_name.trim().to_string());
    lines.push(format!("Receipt {order_ref}"));
    lines.push(local_time.format("%m/%d/%Y %I:%M %p").to_string());
    lines.push(String::from("---"));

    if let Some(c) = &order.customer {
        let name = format!("{} {}", c.first_name.trim(), c.last_name.trim())
            .trim()
            .to_string();
        if !name.is_empty() {
            lines.push(name);
        }
    }

    for it in &order.items {
        let var = it
            .variation_label
            .as_deref()
            .map(|v| format!(" ({v})"))
            .unwrap_or_default();
        lines.push(format!(
            "{} x{} @ {}  {}{}",
            it.product_name.trim(),
            it.quantity,
            it.unit_price,
            it.sku.trim(),
            var
        ));
    }

    lines.push(String::from("---"));
    lines.push(format!("Total: {}", order.total_price));
    lines.push(format!("Paid: {}", order.amount_paid));
    if order.balance_due > Decimal::ZERO {
        lines.push(format!("Balance: {}", order.balance_due));
    }
    lines.push(format!("Tender: {}", order.payment_methods_summary.trim()));
    lines.push(format!("Status: {}", order_status_label(order.status)));

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
