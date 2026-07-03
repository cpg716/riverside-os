//! Merge GrapesJS-exported receipt HTML (`receipt_studio_exported_html`) with order data.
//!
//! Placeholders use a `{{ROS_*}}` prefix to avoid collision with CSS class names.

use chrono_tz::Tz;
use rust_decimal::Decimal;
use uuid::Uuid;

use crate::api::settings::ReceiptConfig;
use crate::logic::receipt_privacy;
use crate::logic::receipt_shared::{
    order_status_label, payment_summary_has_receipt_detail, receipt_display_ref,
    tender_display_label, ReceiptOrder,
};

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

fn build_items_table(order: &ReceiptOrder) -> String {
    let mut rows = String::new();
    for it in &order.items {
        let var = it
            .variation_label
            .as_deref()
            .map(|v| format!(" ({})", html_escape(v)))
            .unwrap_or_default();
        let discount_label = it
            .discount_event_label
            .as_deref()
            .map(str::trim)
            .filter(|label| !label.is_empty());
        let discount_row = discount_label
            .map(|label| {
                format!(
                    "<tr><td colspan=\"3\" style=\"padding:0 0 5px 0;color:#7c3aed;font-size:11px;font-weight:800;\">{}</td></tr>",
                    html_escape(label)
                )
            })
            .unwrap_or_default();
        rows.push_str(&format!(
            "<tr>\
               <td style=\"overflow-wrap:break-word;word-break:break-word;min-width:0;width:58%\"><strong>{}</strong>{}<br><span style=\"font-size:11px;color:#666\">SKU {}</span></td>\
               <td style=\"text-align:center;padding-left:8px;width:14%\">{}</td>\
               <td style=\"text-align:right;padding-left:8px;width:28%\">{}</td>\
             </tr>{}",
            html_escape(&it.product_name),
            var,
            html_escape(&it.sku),
            it.quantity,
            it.unit_price,
            discount_row
        ));
    }
    format!(
        "<table style=\"width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed\"><tbody>{rows}</tbody></table>"
    )
}

fn build_items_table_gift(order: &ReceiptOrder) -> String {
    let mut rows = String::new();
    for it in &order.items {
        let var = it
            .variation_label
            .as_deref()
            .map(|v| format!(" ({})", html_escape(v)))
            .unwrap_or_default();
        rows.push_str(&format!(
            "<tr>\
               <td style=\"overflow-wrap:break-word;word-break:break-word;min-width:0;width:72%\"><strong>{}</strong>{}<br><span style=\"font-size:11px;color:#666\">SKU {}</span></td>\
               <td style=\"text-align:right;padding-left:8px;width:28%\">Qty {}</td>\
             </tr>",
            html_escape(&it.product_name),
            var,
            html_escape(&it.sku),
            it.quantity,
        ));
    }
    format!(
        "<table style=\"width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed\"><tbody>{rows}</tbody></table>"
    )
}

fn build_payment_applications(order: &ReceiptOrder) -> String {
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

fn customer_identity_html(order: &ReceiptOrder) -> String {
    order
        .customer
        .as_ref()
        .map(|c| {
            c.identity_lines()
                .into_iter()
                .map(|line| format!("<div>{}</div>", html_escape(&line)))
                .collect::<Vec<_>>()
                .join("")
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "<div>Customer: Walk-in</div>".to_string())
}

pub fn render_standard_receipt_html(
    order: &ReceiptOrder,
    cfg: &ReceiptConfig,
    gift: bool,
) -> String {
    let tz: Tz = cfg.timezone.parse().unwrap_or(chrono_tz::America::New_York);
    let local_time = order.booked_at.with_timezone(&tz);
    let order_ref = receipt_display_ref(order);
    let customer = customer_identity_html(order);
    let header_lines = cfg
        .header_lines
        .iter()
        .map(|l| format!("<div>{}</div>", html_escape(l)))
        .collect::<Vec<_>>()
        .join("");
    let footer_lines = cfg
        .footer_lines
        .iter()
        .map(|l| format!("<div>{}</div>", html_escape(l)))
        .collect::<Vec<_>>()
        .join("");
    let items_html = if gift {
        build_items_table_gift(order)
    } else {
        build_items_table(order)
    };
    let totals_html = if gift {
        "<div class=\"muted\">Pricing omitted for gift receipt.</div>".to_string()
    } else {
        format!(
            r#"<div class="totals">
  <div><span>Total</span><strong>{}</strong></div>
  <div><span>Paid</span><strong>{}</strong></div>
  <div><span>Balance</span><strong>{}</strong></div>
  <div><span>Tender</span><strong>{}</strong></div>
  {}
</div>"#,
            order.total_price,
            order.amount_paid,
            order.balance_due,
            html_escape(&order.payment_methods_summary),
            build_payment_applications(order)
        )
    };

    format!(
        r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Receipt {order_ref}</title>
  <style>
    :root {{ color-scheme: light; }}
    body {{ margin:0; background:#f4f4f5; color:#111827; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }}
    .paper {{ width:320px; margin:24px auto; background:#fff; padding:22px 18px; border-radius:14px; box-shadow:0 20px 45px rgba(15,23,42,.16); overflow-wrap:break-word; word-wrap:break-word; }}
    .center {{ text-align:center; }}
    .store {{ font-weight:900; font-size:20px; letter-spacing:.02em; text-transform:uppercase; }}
    .title {{ margin-top:10px; font-weight:900; text-transform:uppercase; letter-spacing:.16em; font-size:11px; }}
    .muted {{ color:#6b7280; font-size:12px; line-height:1.35; }}
    .rule {{ border-top:1px dashed #9ca3af; margin:14px 0; }}
    table td {{ padding:5px 0; vertical-align:top; border-bottom:1px solid #f3f4f6; overflow-wrap:break-word; word-break:break-word; }}
    .totals {{ margin-top:8px; font-size:13px; }}
    .totals > div {{ display:flex; justify-content:space-between; gap:12px; padding:3px 0; }}
    .totals strong {{ text-align:right; }}
    @media print {{ body {{ background:#fff; }} .paper {{ margin:0 auto; box-shadow:none; border-radius:0; }} }}
  </style>
</head>
<body>
  <main class="paper">
    <div class="center">
      <div class="store">{store}</div>
      <div class="muted">{header_lines}</div>
      <div class="title">{title}</div>
      <div class="muted">Receipt {order_ref}</div>
      <div class="muted">{date}</div>
    </div>
    <div class="rule"></div>
    <div class="muted">{customer}</div>
    <div class="rule"></div>
    {items_html}
    <div class="rule"></div>
    {totals_html}
    <div class="rule"></div>
    <div class="center muted">{footer_lines}</div>
  </main>
</body>
</html>"#,
        store = html_escape(&cfg.store_name),
        title = if gift { "Gift receipt" } else { "Receipt" },
        date = local_time.format("%m/%d/%Y %I:%M %p"),
        customer = customer,
    )
}

fn replace_all(haystack: &mut String, needle: &str, repl: &str) {
    *haystack = haystack.replace(needle, repl);
}

/// Replace documented tokens; unknown `{{...}}` tokens are left unchanged.
pub fn merge_receipt_studio_html(
    template: &str,
    order: &ReceiptOrder,
    cfg: &ReceiptConfig,
    gift: bool,
) -> String {
    let mut out = template.to_string();
    let tz: Tz = cfg.timezone.parse().unwrap_or(chrono_tz::America::New_York);
    let local_time = order.booked_at.with_timezone(&tz);
    let order_ref = receipt_display_ref(order);
    let customer = order
        .customer
        .as_ref()
        .map(|c| c.identity_summary())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "—".to_string());
    let customer_name = order
        .customer
        .as_ref()
        .map(|c| c.display_name.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "—".to_string());
    let customer_phone = order
        .customer
        .as_ref()
        .and_then(|c| c.phone.as_deref().map(str::trim).filter(|s| !s.is_empty()))
        .unwrap_or("—");
    let customer_code = order
        .customer
        .as_ref()
        .and_then(|c| {
            c.customer_code
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or("—");

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
    replace_all(
        &mut out,
        "{{ROS_CUSTOMER_FULL_NAME}}",
        &html_escape(&customer_name),
    );
    replace_all(
        &mut out,
        "{{ROS_CUSTOMER_PHONE}}",
        &html_escape(customer_phone),
    );
    replace_all(
        &mut out,
        "{{ROS_CUSTOMER_CODE}}",
        &html_escape(customer_code),
    );
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
        let tender_summary = if order.payments.is_empty() {
            html_escape(&order.payment_methods_summary)
        } else {
            let mut lines = order
                .payments
                .iter()
                .map(|payment| {
                    format!(
                        "{} ${}",
                        html_escape(&tender_display_label(&payment.method)),
                        payment.amount.round_dp(2)
                    )
                })
                .collect::<Vec<_>>();
            if payment_summary_has_receipt_detail(&order.payment_methods_summary) {
                lines.push(html_escape(order.payment_methods_summary.trim()));
            }
            lines.join("<br>")
        };
        let payment_summary = if order.payment_applications.is_empty() {
            tender_summary
        } else {
            format!("{}{}", tender_summary, build_payment_applications(order))
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
pub fn sample_receipt_order_for_preview() -> ReceiptOrder {
    use crate::models::{DbFulfillmentType, DbOrderFulfillmentMethod, DbOrderStatus};
    use chrono::Utc;

    ReceiptOrder {
        transaction_id: Uuid::nil(),
        transaction_display_id: "TXN-66736".to_string(),
        booked_at: Utc::now(),
        status: DbOrderStatus::Open,
        subtotal_price: Decimal::new(19950, 2),
        tax_total: Decimal::ZERO,
        total_price: Decimal::new(19950, 2),
        total_savings: Decimal::ZERO,
        amount_paid: Decimal::new(19950, 2),
        balance_due: Decimal::ZERO,
        payment_methods_summary: "VISA ••••4242".to_string(),
        payment_applications: Vec::new(),
        customer: Some(crate::logic::receipt_shared::ReceiptCustomerLine {
            display_name: "Alex Rivera".to_string(),
            phone: Some("716-555-0199".to_string()),
            customer_code: Some("ROS-00066736".to_string()),
        }),
        items: vec![
            crate::logic::receipt_shared::ReceiptLine {
                product_name: "Wool suit jacket".to_string(),
                sku: "SKU-DEMO-01".to_string(),
                quantity: 1,
                unit_price: Decimal::new(17500, 2),
                fulfillment: DbFulfillmentType::Takeaway,
                salesperson_name: receipt_privacy::mask_name_for_receipt(Some("Chris Green")),
                variation_label: Some("42R Navy".to_string()),
                original_unit_price: None,
                discount_event_label: None,
                gift_card_load_code: None,
                custom_order_details: None,
                custom_item_type: None,
                is_fulfilled: true,
            },
            crate::logic::receipt_shared::ReceiptLine {
                product_name: "Silk tie".to_string(),
                sku: "SKU-DEMO-02".to_string(),
                quantity: 2,
                unit_price: Decimal::new(1225, 2),
                fulfillment: DbFulfillmentType::Takeaway,
                salesperson_name: None,
                variation_label: None,
                original_unit_price: None,
                discount_event_label: None,
                gift_card_load_code: None,
                custom_order_details: None,
                custom_item_type: None,
                is_fulfilled: true,
            },
        ],
        is_tax_exempt: false,
        tax_exempt_reason: None,
        fulfillment_method: DbOrderFulfillmentMethod::Pickup,
        cashier_name: Some("Taylor M.".to_string()),
        salesperson_display_name: Some("Alex B.".to_string()),
        payments: Vec::new(),
    }
}
