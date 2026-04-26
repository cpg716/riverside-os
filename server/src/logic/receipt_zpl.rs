//! ZPL string helpers for thermal receipts (`GET .../receipt.zpl`).

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use rust_decimal::Decimal;
use std::collections::HashMap;
use uuid::Uuid;

use crate::models::{DbFulfillmentType, DbOrderStatus};

pub fn zpl_escape(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '^' | '~' | '\n' | '\r' => ' ',
            _ => c,
        })
        .collect()
}

pub fn zpl_push_line(out: &mut String, y: &mut i32, h: i32, text: &str) {
    out.push_str(&format!(
        "^FO40,{}^A0N,{},{}^FD{}^FS\n",
        *y,
        h,
        h,
        zpl_escape(text)
    ));
    *y += h + 8;
}

pub fn order_status_label(s: DbOrderStatus) -> &'static str {
    match s {
        DbOrderStatus::Open => "open",
        DbOrderStatus::Fulfilled => "fulfilled",
        DbOrderStatus::Cancelled => "cancelled",
        DbOrderStatus::PendingMeasurement => "pending_measurement",
    }
}

#[derive(Debug, Clone)]
pub struct ReceiptCustomerLine {
    pub display_name: String,
}

#[derive(Debug, Clone)]
pub struct ReceiptLineForZpl {
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
}

#[derive(Debug, Clone)]
pub struct ReceiptPaymentApplicationForZpl {
    pub target_display_id: String,
    pub amount: Decimal,
    pub remaining_balance: Decimal,
}

#[derive(Debug, Clone)]
pub struct ReceiptOrderForZpl {
    pub transaction_id: Uuid,
    pub booked_at: DateTime<Utc>,
    pub status: DbOrderStatus,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    pub balance_due: Decimal,
    pub payment_methods_summary: String,
    pub payment_applications: Vec<ReceiptPaymentApplicationForZpl>,
    pub customer: Option<ReceiptCustomerLine>,
    pub items: Vec<ReceiptLineForZpl>,
    pub is_tax_exempt: bool,
    pub tax_exempt_reason: Option<String>,
    /// Cashier (operator) display name, masked as First + Last Initial.
    pub cashier_name: Option<String>,
    /// Primary salesperson display name, masked as First + Last Initial.
    pub salesperson_display_name: Option<String>,
}

/// Builds ZPL for receipt or bag-tag mode from normalized order fields.
pub fn build_receipt_zpl(
    d: &ReceiptOrderForZpl,
    cfg: &crate::api::settings::ReceiptConfig,
    loyalty_points_earned: Option<i32>,
    loyalty_points_balance: Option<i32>,
    params: HashMap<String, String>,
) -> String {
    let mode = params
        .get("mode")
        .cloned()
        .unwrap_or_else(|| "receipt".to_string());

    let gift = params
        .get("gift")
        .map(|v| {
            let t = v.trim().to_ascii_lowercase();
            matches!(t.as_str(), "1" | "true" | "yes")
        })
        .unwrap_or(false);

    if mode == "bag-tag" {
        let mut zpl = String::new();
        let customer_name = d
            .customer
            .as_ref()
            .map(|c| c.display_name.as_str())
            .unwrap_or("");
        let order_ref = d
            .transaction_id
            .simple()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>()
            .to_uppercase();

        for item in &d.items {
            if item.product_name.to_lowercase().contains("gift card") {
                continue;
            }

            zpl.push_str("^XA\n");
            zpl.push_str("^PW400\n");
            zpl.push_str("^LL240\n");
            zpl.push_str("^FO20,30^A0N,25,25^FDRIVERSIDE OS^FS\n");
            zpl.push_str(&format!(
                "^FO20,60^A0N,30,30^FD{}^FS\n",
                zpl_escape(customer_name)
            ));
            zpl.push_str(&format!(
                "^FO20,100^A0N,20,20^FDORDER: {}^FS\n",
                zpl_escape(&order_ref)
            ));
            zpl.push_str(&format!(
                "^FO20,130^A0N,25,25^FD{}^FS\n",
                zpl_escape(&item.product_name.to_uppercase())
            ));
            zpl.push_str(&format!(
                "^FO20,160^A0N,20,20^FDSKU: {}^FS\n",
                zpl_escape(&item.sku)
            ));
            if let Some(sp) = &item.salesperson_name {
                zpl.push_str(&format!(
                    "^FO20,190^A0N,18,18^FDSTF: {}^FS\n",
                    zpl_escape(&sp.to_uppercase())
                ));
            }
            zpl.push_str("^XZ\n");
        }
        return zpl;
    }

    if gift {
        return build_gift_receipt_zpl(d, cfg);
    }

    let mut out = String::from("^XA\n^PW800\n^LL2000\n");
    let mut y: i32 = 40;

    zpl_push_line(&mut out, &mut y, 28, &cfg.store_name);
    for hl in &cfg.header_lines {
        zpl_push_line(&mut out, &mut y, 18, hl);
    }
    zpl_push_line(&mut out, &mut y, 22, &format!("Order {}", d.transaction_id));
    let tz: Tz = cfg.timezone.parse().unwrap_or(chrono_tz::America::New_York);
    let local_time = d.booked_at.with_timezone(&tz);
    zpl_push_line(
        &mut out,
        &mut y,
        20,
        &local_time.format("%m/%d/%Y %I:%M %p").to_string(),
    );

    if let Some(c) = &d.customer {
        zpl_push_line(
            &mut out,
            &mut y,
            20,
            &format!("Customer: {}", c.display_name),
        );
    }

    zpl_push_line(&mut out, &mut y, 20, "--------------------------------");

    for it in &d.items {
        let var = it
            .variation_label
            .as_deref()
            .map(|v| format!(" ({v})"))
            .unwrap_or_default();
        zpl_push_line(
            &mut out,
            &mut y,
            22,
            &format!("{}x {}{var}", it.quantity, it.product_name),
        );
        let status_label = match it.fulfillment {
            DbFulfillmentType::Takeaway => "*** TAKEN HOME TODAY ***",
            DbFulfillmentType::WeddingOrder => "--- WEDDING ORDER ---",
            DbFulfillmentType::SpecialOrder | DbFulfillmentType::Custom => "--- ORDER ---",
            DbFulfillmentType::Layaway => "--- LAYAWAY ---",
        };
        if let Some(orig) = it.original_unit_price {
            if orig > it.unit_price && orig > Decimal::ZERO {
                let pct = ((orig - it.unit_price) / orig * Decimal::from(100)).round_dp(0);
                zpl_push_line(
                    &mut out,
                    &mut y,
                    18,
                    &format!("SKU {}  REG {}", zpl_escape(&it.sku), orig),
                );
                zpl_push_line(
                    &mut out,
                    &mut y,
                    18,
                    &format!("SALE {} ({}% off)", it.unit_price, pct),
                );
            } else {
                zpl_push_line(
                    &mut out,
                    &mut y,
                    18,
                    &format!("SKU {}  @ {}", it.sku, it.unit_price),
                );
            }
        } else {
            zpl_push_line(
                &mut out,
                &mut y,
                18,
                &format!("SKU {}  @ {}", it.sku, it.unit_price),
            );
        }
        if let Some(lbl) = &it.discount_event_label {
            let t = lbl.trim();
            if !t.is_empty() {
                zpl_push_line(
                    &mut out,
                    &mut y,
                    18,
                    &format!("Discount: {}", zpl_escape(t)),
                );
            }
        }
        zpl_push_line(&mut out, &mut y, 18, status_label);
        y += 4;
    }

    zpl_push_line(&mut out, &mut y, 20, "--------------------------------");
    zpl_push_line(&mut out, &mut y, 24, &format!("Total {}", d.total_price));
    zpl_push_line(&mut out, &mut y, 22, &format!("Paid {}", d.amount_paid));
    zpl_push_line(&mut out, &mut y, 22, &format!("Balance {}", d.balance_due));
    zpl_push_line(
        &mut out,
        &mut y,
        20,
        &format!("Tender: {}", d.payment_methods_summary),
    );
    if !d.payment_applications.is_empty() {
        zpl_push_line(&mut out, &mut y, 20, "Applied payments:");
        for app in &d.payment_applications {
            zpl_push_line(
                &mut out,
                &mut y,
                18,
                &format!(
                    "{} {} rem {}",
                    app.target_display_id, app.amount, app.remaining_balance
                ),
            );
        }
    }
    zpl_push_line(
        &mut out,
        &mut y,
        18,
        &format!("Status {}", order_status_label(d.status)),
    );
    if d.is_tax_exempt {
        zpl_push_line(
            &mut out,
            &mut y,
            20,
            &format!(
                "TAX EXEMPT: {}",
                d.tax_exempt_reason.as_deref().unwrap_or("Yes")
            ),
        );
    }

    if cfg.show_loyalty_earned {
        let earned = loyalty_points_earned.unwrap_or(0);
        if earned > 0 {
            zpl_push_line(&mut out, &mut y, 18, &format!("Points earned: +{earned}"));
        }
    }
    if cfg.show_loyalty_balance {
        if let Some(bal) = loyalty_points_balance {
            zpl_push_line(&mut out, &mut y, 18, &format!("Total points: {bal}"));
        }
    }

    zpl_push_line(&mut out, &mut y, 20, "--------------------------------");
    for fl in &cfg.footer_lines {
        zpl_push_line(&mut out, &mut y, 18, fl);
    }

    out.push_str("^XZ\n");
    out
}

/// Gift receipt: line items only (no unit prices, totals, tender, or payment details).
fn build_gift_receipt_zpl(
    d: &ReceiptOrderForZpl,
    cfg: &crate::api::settings::ReceiptConfig,
) -> String {
    let mut out = String::from("^XA\n^PW800\n^LL2000\n");
    let mut y: i32 = 40;

    zpl_push_line(&mut out, &mut y, 28, &cfg.store_name);
    for hl in &cfg.header_lines {
        zpl_push_line(&mut out, &mut y, 18, hl);
    }
    zpl_push_line(&mut out, &mut y, 26, "GIFT RECEIPT");
    zpl_push_line(&mut out, &mut y, 22, &format!("Order {}", d.transaction_id));
    let tz: Tz = cfg.timezone.parse().unwrap_or(chrono_tz::America::New_York);
    let local_time = d.booked_at.with_timezone(&tz);
    zpl_push_line(
        &mut out,
        &mut y,
        20,
        &local_time.format("%m/%d/%Y %I:%M %p").to_string(),
    );

    if let Some(c) = &d.customer {
        zpl_push_line(
            &mut out,
            &mut y,
            20,
            &format!("Customer: {}", c.display_name),
        );
    }

    zpl_push_line(&mut out, &mut y, 20, "--------------------------------");
    zpl_push_line(&mut out, &mut y, 18, "Items (pricing omitted)");

    for it in &d.items {
        let var = it
            .variation_label
            .as_deref()
            .map(|v| format!(" ({v})"))
            .unwrap_or_default();
        zpl_push_line(
            &mut out,
            &mut y,
            22,
            &format!("{}x {}{var}", it.quantity, it.product_name),
        );
        zpl_push_line(
            &mut out,
            &mut y,
            18,
            &format!("SKU {}", zpl_escape(&it.sku)),
        );
        y += 4;
    }

    zpl_push_line(&mut out, &mut y, 20, "--------------------------------");
    for fl in &cfg.footer_lines {
        zpl_push_line(&mut out, &mut y, 18, fl);
    }

    out.push_str("^XZ\n");
    out
}
