//! Merge GrapesJS-exported receipt HTML (`receipt_studio_exported_html`) with order data.
//!
//! Placeholders use a `{{ROS_*}}` prefix to avoid collision with CSS class names.

use chrono_tz::Tz;
use rust_decimal::Decimal;
use uuid::Uuid;

use crate::api::settings::ReceiptConfig;
use crate::logic::receipt_privacy;
use crate::logic::receipt_shared::{
    payment_summary_has_receipt_detail, receipt_display_ref, tender_display_label, ReceiptKind,
    ReceiptLine, ReceiptLineAdjustment, ReceiptOrder,
};
use crate::models::{DbFulfillmentType, DbOrderFulfillmentMethod};

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

fn money(amount: Decimal) -> String {
    let rounded = amount.round_dp(2);
    if rounded < Decimal::ZERO {
        format!("-${:.2}", -rounded)
    } else {
        format!("${rounded:.2}")
    }
}

fn fulfillment_label(order: &ReceiptOrder, item: &ReceiptLine) -> &'static str {
    match item.adjustment {
        Some(ReceiptLineAdjustment::Returned) => return "Returned / refunded",
        Some(ReceiptLineAdjustment::Exchanged) => return "Exchanged",
        None => {}
    }
    match item.custom_item_type.as_deref() {
        Some("linked_pickup") => return "Picked up",
        Some("alteration_service" | "alteration_fee") => return "Alteration",
        Some("shipping_fee") => return "Shipping",
        Some("rms_charge_payment") => return "Payment",
        _ => {}
    }
    if item.is_fulfilled {
        return match order.fulfillment_method {
            DbOrderFulfillmentMethod::Ship => "Shipped",
            DbOrderFulfillmentMethod::Pickup => {
                if item.fulfillment == DbFulfillmentType::Takeaway {
                    "Taken today"
                } else {
                    "Picked up"
                }
            }
        };
    }
    match item.fulfillment {
        DbFulfillmentType::Takeaway => "Taken today",
        DbFulfillmentType::SpecialOrder => "Special order",
        DbFulfillmentType::Custom => "Custom order",
        DbFulfillmentType::WeddingOrder => "Wedding order",
        DbFulfillmentType::Layaway => "Layaway",
    }
}

fn build_items_table(order: &ReceiptOrder) -> String {
    let mut rows = String::new();
    if order.has_wedding_order_items() {
        let context = order
            .wedding_order_context_lines()
            .into_iter()
            .map(|line| html_escape(&line))
            .collect::<Vec<_>>()
            .join("<br>");
        rows.push_str(&format!(
            "<tr><td colspan=\"3\" style=\"padding:8px 0\"><strong>Wedding Order</strong>{}</td></tr>",
            if context.is_empty() {
                String::new()
            } else {
                format!("<br><span style=\"font-size:11px;color:#666\">{context}</span>")
            }
        ));
    }
    for it in &order.items {
        let var = it
            .variation_label
            .as_deref()
            .map(|v| format!(" ({})", html_escape(v)))
            .unwrap_or_default();
        let pickup_source = if it.custom_item_type.as_deref() == Some("linked_pickup") {
            it.discount_event_label
                .as_deref()
                .map(str::trim)
                .filter(|label| !label.is_empty())
                .map(|label| {
                    format!(
                        "<br><span style=\"font-size:11px;color:#666\">{}</span>",
                        html_escape(label)
                    )
                })
                .unwrap_or_default()
        } else {
            String::new()
        };
        let line_tax = it
            .tax_amount
            .map(|tax_amount| {
                format!(
                    "<br><span style=\"font-size:10px;color:#64748b\">Tax {}</span>",
                    money(tax_amount)
                )
            })
            .unwrap_or_default();
        let fulfillment = format!(
            "<br><span style=\"font-size:11px;font-weight:700;color:#374151\">{}</span>",
            fulfillment_label(order, it)
        );
        let price_detail = it
            .original_unit_price
            .filter(|original| *original > it.unit_price && *original > Decimal::ZERO)
            .map(|original| {
                format!(
                    "<br><span style=\"font-size:11px;color:#4b5563\">Regular {} · Sale {}</span>",
                    money(original),
                    money(it.unit_price)
                )
            })
            .unwrap_or_else(|| {
                if it.quantity != 1 {
                    format!(
                        "<br><span style=\"font-size:11px;color:#4b5563\">{} each</span>",
                        money(it.unit_price)
                    )
                } else {
                    String::new()
                }
            });
        let line_total = it.unit_price * Decimal::from(it.quantity);
        rows.push_str(&format!(
            "<tr>\
               <td style=\"overflow-wrap:break-word;word-break:break-word;min-width:0;width:58%\"><strong>{}</strong>{}<br><span style=\"font-size:11px;color:#666\">SKU {}</span>{}</td>\
               <td style=\"text-align:center;padding-left:8px;width:14%\">{}</td>\
               <td style=\"text-align:right;padding-left:8px;width:28%\"><strong>{}</strong>{}</td>\
             </tr>",
            html_escape(&it.product_name),
            var,
            html_escape(&it.sku),
            format!("{fulfillment}{pickup_source}{line_tax}"),
            it.quantity,
            money(line_total),
            price_detail,
        ));
    }
    format!(
        "<table style=\"width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed\"><caption class=\"sr-only\">Purchased items</caption><thead><tr><th scope=\"col\" style=\"text-align:left\">Item</th><th scope=\"col\" style=\"text-align:center\">Qty</th><th scope=\"col\" style=\"text-align:right\">Amount</th></tr></thead><tbody>{rows}</tbody></table>"
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
        "<table style=\"width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed\"><caption class=\"sr-only\">Gift receipt items</caption><thead><tr><th scope=\"col\" style=\"text-align:left\">Item</th><th scope=\"col\" style=\"text-align:right\">Quantity</th></tr></thead><tbody>{rows}</tbody></table>"
    )
}

fn build_tender_summary(order: &ReceiptOrder) -> String {
    let mut rows = if order.payments.is_empty() {
        vec![format!(
            "<div><span>Tender</span><strong>{}</strong></div>",
            html_escape(&order.payment_methods_summary)
        )]
    } else {
        order
            .payments
            .iter()
            .map(|payment| {
                format!(
                    "<div><span>Tender {}</span><strong>{}</strong></div>",
                    html_escape(&tender_display_label(&payment.method)),
                    money(payment.amount)
                )
            })
            .collect::<Vec<_>>()
    };
    if payment_summary_has_receipt_detail(&order.payment_methods_summary) {
        rows.push(format!(
            "<div class=\"payment-detail\">{}</div>",
            html_escape(order.payment_methods_summary.trim())
        ));
    }
    for payment in &order.payments {
        if let (Some(cash_tendered), Some(change_due)) = (payment.cash_tendered, payment.change_due)
        {
            if change_due > Decimal::ZERO {
                rows.push(format!(
                    "<div><span>Cash tendered</span><strong>{}</strong></div>",
                    money(cash_tendered)
                ));
                rows.push(format!(
                    "<div><span>Change</span><strong>{}</strong></div>",
                    money(change_due)
                ));
            }
        }
    }
    rows.join("")
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
                "<div style=\"display:flex;justify-content:space-between;gap:12px\"><span>{} {}</span><span>{} · remaining balance {}</span></div>",
                app.activity_label(),
                html_escape(&app.target_display_id),
                money(app.amount),
                money(app.remaining_balance)
            )
        })
        .collect::<Vec<_>>()
        .join("");
    format!(
        "<div style=\"margin-top:8px;font-size:12px\"><strong>{}</strong>{rows}</div>",
        order.order_payment_heading()
    )
}

fn build_pickup_payment_summary(order: &ReceiptOrder) -> String {
    match order.pickup_prior_paid {
        Some(prior_paid) => {
            format!(
                "<div><span>Previously paid</span><strong>{}</strong></div>",
                money(prior_paid)
            )
        }
        None => String::new(),
    }
}

fn build_paid_summary(order: &ReceiptOrder) -> String {
    if order.show_paid_line() {
        format!(
            "<div><span>{}</span><strong>{}</strong></div>",
            order.paid_label(),
            money(order.amount_paid)
        )
    } else {
        String::new()
    }
}

fn build_wedding_deposit_summary(order: &ReceiptOrder) -> String {
    if !order.wedding_deposits.is_empty() {
        return order
            .wedding_deposits
            .iter()
            .map(|deposit| {
                let beneficiary = deposit
                    .beneficiary_name
                    .as_deref()
                    .map(|name| format!(" for {}", html_escape(name)))
                    .unwrap_or_default();
                let destination = deposit
                    .destination_label
                    .as_deref()
                    .map(|label| format!("<small>{}</small>", html_escape(label)))
                    .unwrap_or_default();
                format!(
                    "<div><span>Wedding Party Deposit{} ({}){}</span><strong>{}</strong></div>",
                    beneficiary,
                    html_escape(&deposit.party_name),
                    destination,
                    money(deposit.amount)
                )
            })
            .collect::<Vec<_>>()
            .join("");
    }
    if order.wedding_deposit_amount > Decimal::ZERO {
        return format!(
            "<div><span>Wedding Party Deposit</span><strong>{}</strong></div>",
            money(order.wedding_deposit_amount)
        );
    }
    String::new()
}

fn build_applied_wedding_deposit_summary(order: &ReceiptOrder) -> String {
    order
        .applied_wedding_deposits
        .iter()
        .map(|source| {
            format!(
                "<div><span>Wedding Deposit Applied<small>Paid by {} · {}</small></span><strong>{}</strong></div>",
                html_escape(&source.payer_name),
                html_escape(&source.party_name),
                money(source.amount)
            )
        })
        .collect::<Vec<_>>()
        .join("")
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

fn gift_card_balance_html(order: &ReceiptOrder) -> String {
    order
        .payments
        .iter()
        .filter_map(|payment| {
            payment.gift_card_balance_after.map(|balance| {
                format!(
                    "<div><strong>Gift Card Balance</strong> {}</div>",
                    money(balance)
                )
            })
        })
        .collect::<Vec<_>>()
        .join("")
}

pub fn render_standard_receipt_html(
    order: &ReceiptOrder,
    cfg: &ReceiptConfig,
    gift: bool,
) -> String {
    let tz: Tz = cfg.timezone.parse().unwrap_or(chrono_tz::America::New_York);
    let local_time = order.booked_at.with_timezone(&tz);
    let order_ref = receipt_display_ref(order);
    let document_title = if gift {
        "Gift receipt"
    } else if order.receipt_kind.is_standard_sale() {
        "Receipt"
    } else {
        order.receipt_kind.title()
    };
    let backdated_notice = crate::logic::receipt_shared::backdated_receipt_notice(order)
        .map(|notice| {
            format!(
                "<div class=\"muted\"><strong>{}</strong></div>",
                html_escape(&notice)
            )
        })
        .unwrap_or_default();
    let customer = customer_identity_html(order);
    let header_lines = [
        cfg.show_address.then_some(cfg.store_address.as_str()),
        cfg.show_phone.then_some(cfg.store_phone.as_str()),
        cfg.show_email.then_some(cfg.store_email.as_str()),
    ]
    .into_iter()
    .flatten()
    .chain(cfg.header_lines.iter().map(String::as_str))
    .map(str::trim)
    .filter(|line| !line.is_empty())
    .map(|line| format!("<div>{}</div>", html_escape(line)))
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
        let savings = if order.total_savings > Decimal::ZERO {
            format!(
                "<div><span>Total savings</span><strong>{}</strong></div>",
                money(order.total_savings)
            )
        } else {
            String::new()
        };
        let balance = if order.balance_due > Decimal::ZERO || order.is_pickup_event() {
            format!(
                "<div><span>Balance remaining</span><strong>{}</strong></div>",
                money(order.balance_due)
            )
        } else {
            String::new()
        };
        format!(
            r#"<div class="totals">
  <div><span>Subtotal</span><strong>{}</strong></div>
  <div><span>Sales tax</span><strong>{}</strong></div>
  {}
  <div><span>{}</span><strong>{}</strong></div>
  {}
  {}
  {}
  {}
  {}
  {}
</div>"#,
            money(order.subtotal_price),
            money(order.tax_total),
            savings,
            order.total_label(),
            money(order.total_price),
            build_paid_summary(order),
            build_pickup_payment_summary(order),
            balance,
            build_tender_summary(order),
            format!(
                "{}{}",
                build_wedding_deposit_summary(order),
                build_applied_wedding_deposit_summary(order)
            ),
            build_payment_applications(order)
        )
    };
    let staff_lines = [
        order
            .salesperson_display_name
            .as_ref()
            .map(|name| format!("<div>Salesperson: {}</div>", html_escape(name))),
        order
            .cashier_name
            .as_ref()
            .map(|name| format!("<div>Staff: {}</div>", html_escape(name))),
        order
            .register_lane
            .map(|register_lane| format!("<div>Register #{register_lane}</div>")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("");
    let status = if gift {
        String::new()
    } else {
        format!(
            "<div class=\"status\"><strong>Status:</strong> {}</div>",
            html_escape(order.customer_status_label())
        )
    };
    let tax_exempt = if !gift && order.is_tax_exempt {
        format!(
            "<div class=\"tax-exempt\"><strong>Tax exempt:</strong> {}</div>",
            html_escape(order.tax_exempt_reason.as_deref().unwrap_or("Yes"))
        )
    } else {
        String::new()
    };

    format!(
        r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>{title} {order_ref}</title>
  <style>
    :root {{ color-scheme: light; }}
    body {{ margin:0; background:#f4f4f5; color:#111827; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }}
    .paper {{ width:320px; margin:24px auto; background:#fff; padding:22px 18px; border-radius:14px; box-shadow:0 20px 45px rgba(15,23,42,.16); overflow-wrap:break-word; word-wrap:break-word; }}
    .center {{ text-align:center; }}
    .store {{ font-weight:900; font-size:20px; letter-spacing:.02em; text-transform:uppercase; }}
    .title {{ margin-top:10px; font-weight:900; text-transform:uppercase; letter-spacing:.16em; font-size:11px; }}
    .muted {{ color:#6b7280; font-size:12px; line-height:1.35; }}
    .sr-only {{ position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0; }}
    .rule {{ border-top:1px dashed #9ca3af; margin:14px 0; }}
    th {{ padding:5px 0;border-bottom:1px solid #d1d5db;color:#374151;font-size:11px;text-transform:uppercase;letter-spacing:.05em; }}
    table td {{ padding:5px 0; vertical-align:top; border-bottom:1px solid #f3f4f6; overflow-wrap:break-word; word-break:break-word; }}
    .totals {{ margin-top:8px; font-size:13px; }}
    .totals > div {{ display:flex; justify-content:space-between; gap:12px; padding:3px 0; }}
    .totals strong {{ text-align:right; }}
    .payment-detail {{ display:block!important;color:#4b5563;font-size:11px;line-height:1.35;padding-top:1px!important; }}
    .status,.tax-exempt {{ margin-top:10px;font-size:12px; }}
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
      {backdated_notice}
    </div>
    <div class="rule"></div>
    <div class="muted">{customer}</div>
    <div class="muted">{staff_lines}</div>
    <div class="rule"></div>
    {items_html}
    <div class="rule"></div>
    {totals_html}
    {status}
    {tax_exempt}
    <div class="rule"></div>
    <div class="center muted">{footer_lines}</div>
  </main>
</body>
</html>"#,
        store = html_escape(&cfg.store_name),
        title = document_title,
        date = local_time.format("%m/%d/%Y %I:%M %p"),
        backdated_notice = backdated_notice,
        customer = customer,
        staff_lines = staff_lines,
        status = status,
        tax_exempt = tax_exempt,
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
    let had_receipt_title_token = out.contains("{{ROS_RECEIPT_TITLE}}");
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
    let header_lines = [
        cfg.show_address.then_some(cfg.store_address.as_str()),
        cfg.show_phone.then_some(cfg.store_phone.as_str()),
        cfg.show_email.then_some(cfg.store_email.as_str()),
    ]
    .into_iter()
    .flatten()
    .chain(cfg.header_lines.iter().map(String::as_str))
    .map(str::trim)
    .filter(|line| !line.is_empty())
    .map(html_escape)
    .collect::<Vec<_>>()
    .join("<br/>");
    let backdated_notice = crate::logic::receipt_shared::backdated_receipt_notice(order)
        .map(|notice| {
            format!(
                "<div style=\"font-weight:900;text-align:center;color:#9a3412;margin:8px 0\">{}</div>",
                html_escape(&notice)
            )
        })
        .unwrap_or_default();
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
    let title = if gift {
        "Gift receipt"
    } else if order.receipt_kind.is_standard_sale() {
        ""
    } else {
        order.receipt_kind.title()
    };
    replace_all(&mut out, "{{ROS_RECEIPT_TITLE}}", title);
    if !gift && !order.receipt_kind.is_standard_sale() && !had_receipt_title_token {
        let title_banner = format!(
            "<div style=\"font-weight:900;text-align:center;margin:8px 0\">{}</div>",
            html_escape(title)
        );
        if let Some(body_start) = out.to_ascii_lowercase().find("<body") {
            if let Some(body_end_offset) = out[body_start..].find('>') {
                let insert_at = body_start + body_end_offset + 1;
                out.insert_str(insert_at, &title_banner);
            }
        } else {
            out.insert_str(0, &title_banner);
        }
    }
    replace_all(&mut out, "{{ROS_BACKDATED_NOTICE}}", &backdated_notice);
    if !backdated_notice.is_empty() && !out.contains(&backdated_notice) {
        if let Some(body_start) = out.to_ascii_lowercase().find("<body") {
            if let Some(body_end_offset) = out[body_start..].find('>') {
                let insert_at = body_start + body_end_offset + 1;
                out.insert_str(insert_at, &backdated_notice);
            }
        }
    }

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
            let mut lines = Vec::new();
            for payment in &order.payments {
                lines.push(format!(
                    "{} ${}",
                    html_escape(&tender_display_label(&payment.method)),
                    payment.amount.round_dp(2)
                ));
                if let (Some(cash_tendered), Some(change_due)) =
                    (payment.cash_tendered, payment.change_due)
                {
                    if change_due > Decimal::ZERO {
                        lines.push(format!("Cash Tendered ${}", cash_tendered.round_dp(2)));
                        lines.push(format!("Change ${}", change_due.round_dp(2)));
                    }
                }
            }
            if payment_summary_has_receipt_detail(&order.payment_methods_summary) {
                lines.push(html_escape(order.payment_methods_summary.trim()));
            }
            lines.join("<br>")
        };
        let payment_summary = format!(
            "{}{}{}{}",
            tender_summary,
            build_pickup_payment_summary(order),
            format!(
                "{}{}",
                build_wedding_deposit_summary(order),
                build_applied_wedding_deposit_summary(order)
            ),
            build_payment_applications(order)
        );
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
    replace_all(&mut out, "{{ROS_STATUS}}", order.customer_status_label());
    replace_all(&mut out, "{{ROS_ITEMS_TABLE}}", &items_html);
    replace_all(
        &mut out,
        "{{ROS_GIFT_CARD_BALANCE}}",
        &gift_card_balance_html(order),
    );
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
        register_lane: Some(1),
        receipt_kind: ReceiptKind::StandardSale,
        booked_at: Utc::now(),
        backdated_business_date: None,
        status: DbOrderStatus::Open,
        subtotal_price: Decimal::new(19950, 2),
        tax_total: Decimal::ZERO,
        total_price: Decimal::new(19950, 2),
        total_savings: Decimal::ZERO,
        amount_paid: Decimal::new(19950, 2),
        wedding_deposit_amount: Decimal::ZERO,
        wedding_deposits: Vec::new(),
        applied_wedding_deposits: Vec::new(),
        balance_due: Decimal::ZERO,
        payment_methods_summary: "VISA ••••4242".to_string(),
        payment_applications: Vec::new(),
        pickup_prior_paid: None,
        pickup_balance_remaining: None,
        customer: Some(crate::logic::receipt_shared::ReceiptCustomerLine {
            display_name: "Alex Rivera".to_string(),
            phone: Some("716-555-0199".to_string()),
            customer_code: Some("ROS-00066736".to_string()),
        }),
        wedding_party_name: None,
        wedding_event_date: None,
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
                adjustment: None,
                contributes_to_totals: true,
                is_taxable: Some(true),
                tax_amount: Some(Decimal::new(1488, 2)),
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
                adjustment: None,
                contributes_to_totals: true,
                is_taxable: Some(false),
                tax_amount: Some(Decimal::ZERO),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logic::receipt_shared::ReceiptWeddingPartyDeposit;

    #[test]
    fn standard_html_receipt_title_is_unchanged() {
        let order = sample_receipt_order_for_preview();
        let html = render_standard_receipt_html(&order, &ReceiptConfig::default(), false);

        assert!(html.contains("<title>Receipt TXN-66736</title>"));
        assert!(html.contains("<div class=\"title\">Receipt</div>"));
        assert!(!html.contains("RETURN /"));
    }

    #[test]
    fn standard_html_receipt_contains_customer_financial_and_audit_detail() {
        let mut order = sample_receipt_order_for_preview();
        order.tax_total = Decimal::new(1696, 2);
        order.total_savings = Decimal::new(2500, 2);
        order.payments = vec![crate::logic::receipt_shared::ReceiptPayment {
            date: chrono::Utc::now(),
            method: "card_terminal".to_string(),
            amount: Decimal::new(21646, 2),
            cash_tendered: None,
            change_due: None,
            gift_card_balance_after: None,
        }];

        let html = render_standard_receipt_html(&order, &ReceiptConfig::default(), false);

        assert!(html.contains("<span>Subtotal</span><strong>$199.50</strong>"));
        assert!(html.contains("<span>Sales tax</span><strong>$16.96</strong>"));
        assert!(html.contains("<span>Total savings</span><strong>$25.00</strong>"));
        assert!(html.contains("Tender CC"));
        assert!(html.contains("Register #1"));
        assert!(html.contains("Salesperson:"));
        assert!(html.contains("Staff:"));
        assert!(html.contains("Tax $14.88"));
        assert!(html.contains("Tax $0.00"));
        assert!(!html.contains("Tax: Taxable"));
        assert!(html.contains("Taken today"));
        assert!(html.contains("<th scope=\"col\""));
    }

    #[test]
    fn customer_html_receipt_hides_internal_discount_provenance() {
        let mut order = sample_receipt_order_for_preview();
        order.items[0].original_unit_price = Some(Decimal::new(20000, 2));
        order.items[0].discount_event_label = Some("Counterpoint imported discount".to_string());

        let items = build_items_table(&order);

        assert!(!items.contains("Counterpoint imported discount"));
        assert!(items.contains("Wool suit jacket"));
    }

    #[test]
    fn linked_pickup_html_names_the_source_order() {
        let mut order = sample_receipt_order_for_preview();
        order.items[0].custom_item_type = Some("linked_pickup".to_string());
        order.items[0].discount_event_label = Some("Picked up from ORD-100001".to_string());

        let items = build_items_table(&order);

        assert!(items.contains("Picked up from ORD-100001"));
    }

    #[test]
    fn wedding_party_deposit_names_the_party_in_html_receipts() {
        let mut order = sample_receipt_order_for_preview();
        order.wedding_deposit_amount = Decimal::new(71038, 2);
        order.wedding_deposits = vec![ReceiptWeddingPartyDeposit {
            party_name: "Whitrock & Family".to_string(),
            beneficiary_name: Some("James Brown".to_string()),
            destination_label: Some("Held for future order".to_string()),
            amount: Decimal::new(71038, 2),
        }];

        let html = render_standard_receipt_html(&order, &ReceiptConfig::default(), false);

        assert!(html.contains("Wedding Party Deposit for James Brown (Whitrock &amp; Family)"));
        assert!(html.contains("for James Brown"));
        assert!(html.contains("Held for future order"));
        assert!(html.contains("<strong>$710.38</strong>"));
    }

    #[test]
    fn wedding_order_html_names_the_party_and_wedding_date() {
        let mut order = sample_receipt_order_for_preview();
        order.items[0].fulfillment = crate::models::DbFulfillmentType::WeddingOrder;
        order.items[0].is_fulfilled = false;
        order.wedding_party_name = Some("Adams Wedding".to_string());
        order.wedding_event_date =
            Some(chrono::NaiveDate::from_ymd_opt(2026, 9, 19).expect("valid wedding date"));

        let html = render_standard_receipt_html(&order, &ReceiptConfig::default(), false);

        assert!(html.contains("Wedding Order"));
        assert!(html.contains("Party: Adams Wedding"));
        assert!(html.contains("Wedding Date: 09/19/2026"));
    }

    #[test]
    fn return_document_titles_render_in_standard_and_studio_html() {
        for (kind, expected) in [
            (ReceiptKind::ReturnRefund, "RETURN / REFUND"),
            (ReceiptKind::ReturnExchange, "RETURN / EXCHANGE"),
        ] {
            let mut order = sample_receipt_order_for_preview();
            order.receipt_kind = kind;

            let standard = render_standard_receipt_html(&order, &ReceiptConfig::default(), false);
            assert!(standard.contains(&format!("<title>{expected} TXN-66736</title>")));
            assert!(standard.contains(&format!("<div class=\"title\">{expected}</div>")));

            let studio = merge_receipt_studio_html(
                "<h1>{{ROS_RECEIPT_TITLE}}</h1>",
                &order,
                &ReceiptConfig::default(),
                false,
            );
            assert_eq!(studio, format!("<h1>{expected}</h1>"));

            let studio_without_token = merge_receipt_studio_html(
                "<section>Receipt body</section>",
                &order,
                &ReceiptConfig::default(),
                false,
            );
            assert!(studio_without_token.contains(expected));
            assert!(studio_without_token.ends_with("<section>Receipt body</section>"));
        }
    }

    #[test]
    fn standard_studio_title_token_remains_empty() {
        let order = sample_receipt_order_for_preview();
        let studio = merge_receipt_studio_html(
            "<h1>{{ROS_RECEIPT_TITLE}}</h1>",
            &order,
            &ReceiptConfig::default(),
            false,
        );

        assert_eq!(studio, "<h1></h1>");
    }
}
