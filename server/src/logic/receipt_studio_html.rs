//! Merge GrapesJS-exported receipt HTML (`receipt_studio_exported_html`) with order data.
//!
//! Placeholders use a `{{ROS_*}}` prefix to avoid collision with CSS class names.

use chrono_tz::Tz;
use rust_decimal::Decimal;
use uuid::Uuid;

use crate::api::settings::ReceiptConfig;
use crate::logic::receipt_privacy;
use crate::logic::receipt_zpl::{order_status_label, ReceiptOrderForZpl};

fn html_escape(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            '&' => "&amp;".chars().collect::<Vec<_>>(),
            '<' => "&lt;".chars().collect::<Vec<_>>(),
            '>' => "&gt;".chars().collect::<Vec<_>>(),
            '"' => "&quot;".chars().collect::<Vec<_>>(),
            _ => vec![c],
        })
        .collect()
}

fn build_items_table(order: &ReceiptOrderForZpl) -> String {
    let mut rows = String::new();
    for it in &order.items {
        let var = it
            .variation_label
            .as_deref()
            .map(|v| format!(" ({})", html_escape(v)))
            .unwrap_or_default();
        rows.push_str(&format!(
            "<tr><td>{}{}</td><td style=\"text-align:right;white-space:nowrap\">{} × {}</td><td style=\"text-align:right\">{}</td></tr>",
            html_escape(&it.product_name),
            var,
            it.quantity,
            html_escape(&it.sku),
            it.unit_price
        ));
    }
    format!(
        "<table style=\"width:100%;border-collapse:collapse;font-size:12px\"><tbody>{rows}</tbody></table>"
    )
}

fn build_items_table_gift(order: &ReceiptOrderForZpl) -> String {
    let mut rows = String::new();
    for it in &order.items {
        let var = it
            .variation_label
            .as_deref()
            .map(|v| format!(" ({})", html_escape(v)))
            .unwrap_or_default();
        rows.push_str(&format!(
            "<tr><td>{}{}</td><td style=\"text-align:right;white-space:nowrap\">{} × {}</td></tr>",
            html_escape(&it.product_name),
            var,
            it.quantity,
            html_escape(&it.sku),
        ));
    }
    format!(
        "<table style=\"width:100%;border-collapse:collapse;font-size:12px\"><tbody>{rows}</tbody></table>"
    )
}

fn build_payment_applications(order: &ReceiptOrderForZpl) -> String {
    if order.payment_applications.is_empty() {
        return String::new();
    }
    let rows = order
        .payment_applications
        .iter()
        .map(|app| {
            format!(
                "<div style=\"display:flex;justify-content:space-between;gap:12px\"><span>Payment on {}</span><span>{} · remaining {}</span></div>",
                html_escape(&app.target_display_id),
                app.amount,
                app.remaining_balance
            )
        })
        .collect::<Vec<_>>()
        .join("");
    format!("<div style=\"margin-top:8px;font-size:12px\"><strong>Applied payments</strong>{rows}</div>")
}

fn replace_all(haystack: &mut String, needle: &str, repl: &str) {
    *haystack = haystack.replace(needle, repl);
}

/// Replace documented tokens; unknown `{{...}}` tokens are left unchanged.
pub fn merge_receipt_studio_html(
    template: &str,
    order: &ReceiptOrderForZpl,
    cfg: &ReceiptConfig,
    gift: bool,
) -> String {
    let mut out = template.to_string();
    let tz: Tz = cfg.timezone.parse().unwrap_or(chrono_tz::America::New_York);
    let local_time = order.booked_at.with_timezone(&tz);
    let order_ref = order
        .transaction_id
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>()
        .to_uppercase();
    let customer = order
        .customer
        .as_ref()
        .map(|c| c.display_name.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "—".to_string());

    let items_html = if gift {
        build_items_table_gift(order)
    } else {
        build_items_table(order)
    };
    let header_lines = cfg
        .header_lines
        .iter()
        .map(|l| html_escape(l))
        .collect::<Vec<_>>()
        .join("<br/>");
    let footer_lines = cfg
        .footer_lines
        .iter()
        .map(|l| html_escape(l))
        .collect::<Vec<_>>()
        .join("<br/>");

    replace_all(
        &mut out,
        "{{ROS_STORE_NAME}}",
        &html_escape(&cfg.store_name),
    );
    replace_all(&mut out, "{{ROS_ORDER_ID}}", &order_ref);
    replace_all(
        &mut out,
        "{{ROS_ORDER_ID_FULL}}",
        &html_escape(&order.transaction_id.to_string()),
    );
    replace_all(
        &mut out,
        "{{ROS_ORDER_DATE}}",
        &local_time.format("%m/%d/%Y %I:%M %p").to_string(),
    );
    replace_all(&mut out, "{{ROS_CUSTOMER_NAME}}", &html_escape(&customer));
    let title = if gift { "Gift receipt" } else { "" };
    replace_all(&mut out, "{{ROS_RECEIPT_TITLE}}", title);

    if gift {
        replace_all(
            &mut out,
            "{{ROS_PAYMENT_SUMMARY}}",
            "Gift receipt (pricing omitted)",
        );
        replace_all(&mut out, "{{ROS_TOTAL}}", "—");
        replace_all(&mut out, "{{ROS_AMOUNT_PAID}}", "—");
        replace_all(&mut out, "{{ROS_BALANCE_DUE}}", "—");
    } else {
        let payment_summary = if order.payment_applications.is_empty() {
            html_escape(&order.payment_methods_summary)
        } else {
            format!(
                "{}{}",
                html_escape(&order.payment_methods_summary),
                build_payment_applications(order)
            )
        };
        replace_all(&mut out, "{{ROS_PAYMENT_SUMMARY}}", &payment_summary);
        replace_all(&mut out, "{{ROS_TOTAL}}", &order.total_price.to_string());
        replace_all(
            &mut out,
            "{{ROS_AMOUNT_PAID}}",
            &order.amount_paid.to_string(),
        );
        replace_all(
            &mut out,
            "{{ROS_BALANCE_DUE}}",
            &order.balance_due.to_string(),
        );
    }
    replace_all(&mut out, "{{ROS_STATUS}}", order_status_label(order.status));
    replace_all(&mut out, "{{ROS_ITEMS_TABLE}}", &items_html);
    replace_all(&mut out, "{{ROS_HEADER_LINES}}", &header_lines);
    replace_all(&mut out, "{{ROS_FOOTER_LINES}}", &footer_lines);
    out
}

/// Wrap GrapesJS body fragment in a minimal email document when it is not already a full HTML page.
/// Prefer [`wrap_receipt_fragment_for_podium_email_inline`] for Podium transactional email (inline HTML in the inbox).
pub fn wrap_receipt_fragment_as_email_document(fragment: &str) -> String {
    let t = fragment.trim();
    let lower = t.to_ascii_lowercase();
    if lower.contains("<html") {
        return t.to_string();
    }
    format!(
        r#"<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="margin:0;padding:16px;font-family:system-ui,-apple-system,sans-serif;background:#f4f4f5;color:#111827">{t}</body></html>"#
    )
}

/// Inline HTML for Podium `POST /v4/messages` email body. Full `<html>...</html>` documents are often delivered as downloads;
/// a single styled `<div>` renders as normal message HTML in most clients.
pub fn wrap_receipt_fragment_for_podium_email_inline(fragment: &str) -> String {
    let t = fragment.trim();
    format!(
        r#"<div style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.35;max-width:600px;margin:0 auto;color:#111827;background:#ffffff;">{t}</div>"#
    )
}

/// Demo order for Settings → Receipt Builder preview (`GET /api/settings/receipt/preview-html`).
pub fn sample_receipt_order_for_preview() -> ReceiptOrderForZpl {
    use crate::models::{DbFulfillmentType, DbOrderStatus};
    use chrono::Utc;

    ReceiptOrderForZpl {
        transaction_id: Uuid::nil(),
        booked_at: Utc::now(),
        status: DbOrderStatus::Open,
        total_price: Decimal::new(19950, 2),
        amount_paid: Decimal::new(19950, 2),
        balance_due: Decimal::ZERO,
        payment_methods_summary: "VISA ••••4242".to_string(),
        payment_applications: Vec::new(),
        customer: Some(crate::logic::receipt_zpl::ReceiptCustomerLine {
            display_name: "Alex R.".to_string(),
        }),
        items: vec![
            crate::logic::receipt_zpl::ReceiptLineForZpl {
                product_name: "Wool suit jacket".to_string(),
                sku: "SKU-DEMO-01".to_string(),
                quantity: 1,
                unit_price: Decimal::new(17500, 2),
                fulfillment: DbFulfillmentType::Takeaway,
                salesperson_name: receipt_privacy::mask_name_for_receipt(Some("Chris Green")),
                variation_label: Some("42R Navy".to_string()),
                original_unit_price: None,
                discount_event_label: None,
            },
            crate::logic::receipt_zpl::ReceiptLineForZpl {
                product_name: "Silk tie".to_string(),
                sku: "SKU-DEMO-02".to_string(),
                quantity: 2,
                unit_price: Decimal::new(1225, 2),
                fulfillment: DbFulfillmentType::Takeaway,
                salesperson_name: None,
                variation_label: None,
                original_unit_price: None,
                discount_event_label: None,
            },
        ],
        is_tax_exempt: false,
        tax_exempt_reason: None,
    }
}
