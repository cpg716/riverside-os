use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::logic::podium::{
    self, apply_template_placeholders, looks_like_email, normalize_phone_e164, PodiumTokenCache,
};
use crate::logic::wedding_api_types::AppointmentRow;
use crate::models::DbOrderStatus;

#[derive(Debug, sqlx::FromRow)]
struct CustomerMessagingRow {
    first_name: Option<String>,
    email: Option<String>,
    phone: Option<String>,
    marketing_email_opt_in: bool,
    marketing_sms_opt_in: bool,
    transactional_sms_opt_in: bool,
    transactional_email_opt_in: bool,
}

async fn load_customer_messaging_row(
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<CustomerMessagingRow, sqlx::Error> {
    sqlx::query_as::<_, CustomerMessagingRow>(
        r#"
        SELECT first_name, email, phone,
               marketing_email_opt_in, marketing_sms_opt_in, transactional_sms_opt_in,
               transactional_email_opt_in
        FROM customers WHERE id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await
}

fn email_opt_in_ok(row: &CustomerMessagingRow) -> bool {
    row.transactional_email_opt_in || row.marketing_email_opt_in
}

fn sms_opt_in_ok(row: &CustomerMessagingRow) -> bool {
    row.transactional_sms_opt_in || row.marketing_sms_opt_in
}

fn fmt_money_dec(d: Decimal) -> String {
    d.to_f64()
        .map(|f| format!("{f:.2}"))
        .unwrap_or_else(|| d.to_string())
}

fn loyalty_redeem_breakdown_sms(apply: Decimal, remainder: Decimal) -> String {
    let mut parts: Vec<String> = Vec::new();
    if apply > Decimal::ZERO {
        parts.push(format!(
            "${} applied to your sale today.",
            fmt_money_dec(apply)
        ));
    }
    if remainder > Decimal::ZERO {
        parts.push(format!(
            "${} loaded onto your gift card.",
            fmt_money_dec(remainder)
        ));
    }
    if parts.is_empty() {
        "Your reward has been recorded.".to_string()
    } else {
        parts.join(" ")
    }
}

fn loyalty_redeem_breakdown_html(apply: Decimal, remainder: Decimal) -> String {
    let mut s = String::new();
    if apply > Decimal::ZERO {
        s.push_str(&format!(
            "<p>We applied <b>${}</b> to your sale today.</p>",
            fmt_money_dec(apply)
        ));
    }
    if remainder > Decimal::ZERO {
        s.push_str(&format!(
            "<p>We loaded <b>${}</b> onto your loyalty gift card.</p>",
            fmt_money_dec(remainder)
        ));
    }
    if s.is_empty() {
        "<p>Your reward has been recorded.</p>".to_string()
    } else {
        s
    }
}

/// Core messaging dispatcher for automated notifications.
/// SMS: Podium when env + `podium_sms_config.sms_send_enabled` + location_uid.
/// Email: Podium when env + `podium_sms_config.email_send_enabled` + location_uid.
pub struct MessagingService;

impl MessagingService {
    /// Staff-triggered Podium SMS/email after `POST /api/loyalty/redeem-reward` when flags are set.
    #[allow(clippy::too_many_arguments)]
    pub async fn notify_loyalty_reward_redeemed(
        pool: &PgPool,
        http: &reqwest::Client,
        podium_cache: &Arc<Mutex<PodiumTokenCache>>,
        customer_id: Uuid,
        notify_sms: bool,
        notify_email: bool,
        reward_amount: Decimal,
        apply_to_sale: Decimal,
        remainder: Decimal,
        new_balance: i32,
        points_redeemed: i32,
    ) -> Result<(), sqlx::Error> {
        if !notify_sms && !notify_email {
            return Ok(());
        }

        let customer = load_customer_messaging_row(pool, customer_id).await?;
        let first = customer.first_name.as_deref().unwrap_or("there");
        let reward_s = fmt_money_dec(reward_amount);
        let balance_s = new_balance.to_string();
        let pts_s = points_redeemed.to_string();
        let breakdown_sms = loyalty_redeem_breakdown_sms(apply_to_sale, remainder);
        let breakdown_html = loyalty_redeem_breakdown_html(apply_to_sale, remainder);

        let vars_common = [
            ("first_name", first),
            ("reward_amount", reward_s.as_str()),
            ("new_balance", balance_s.as_str()),
            ("points_redeemed", pts_s.as_str()),
            ("reward_breakdown", breakdown_sms.as_str()),
            ("reward_breakdown_html", breakdown_html.as_str()),
        ];

        let podium_cfg = podium::load_store_podium_config(pool).await.ok();
        let sms_templates = podium_cfg
            .as_ref()
            .map(|c| c.templates.merged_defaults())
            .unwrap_or_default();
        let email_templates = podium_cfg
            .as_ref()
            .map(|c| c.email_templates.merged_defaults())
            .unwrap_or_default();

        if notify_sms && sms_opt_in_ok(&customer) {
            if let Some(ref phone) = customer.phone {
                if let Some(e164) = normalize_phone_e164(phone) {
                    let body = apply_template_placeholders(
                        &sms_templates.loyalty_reward_redeemed,
                        &vars_common,
                    );
                    tracing::info!(
                        target: "messaging",
                        event = "sms_dispatch",
                        customer_id = %customer_id,
                        kind = "loyalty_reward_redeemed",
                        "Loyalty redeem SMS (Podium) triggered"
                    );
                    podium::try_send_operational_sms(
                        pool,
                        http,
                        podium_cache,
                        &e164,
                        body,
                        Some(customer_id),
                    )
                    .await;
                }
            }
        }

        if notify_email && email_opt_in_ok(&customer) {
            if let Some(ref em) = customer.email {
                if looks_like_email(em) {
                    let subject = apply_template_placeholders(
                        &email_templates.loyalty_reward_redeemed_subject,
                        &vars_common,
                    );
                    let html = apply_template_placeholders(
                        &email_templates.loyalty_reward_redeemed_html,
                        &vars_common,
                    );
                    tracing::info!(
                        target: "messaging",
                        event = "email_dispatch",
                        customer_id = %customer_id,
                        kind = "loyalty_reward_redeemed",
                        "Loyalty redeem email (Podium) triggered"
                    );
                    podium::try_send_operational_email(
                        pool,
                        http,
                        podium_cache,
                        em,
                        subject,
                        html,
                        Some(customer_id),
                    )
                    .await;
                }
            }
        }

        Ok(())
    }

    /// New appointment with a linked `customer_id` — confirmation email via Podium when opted in.
    pub async fn trigger_appointment_confirmation(
        pool: &PgPool,
        http: &reqwest::Client,
        podium_cache: &Arc<Mutex<PodiumTokenCache>>,
        appt: &AppointmentRow,
    ) -> Result<(), sqlx::Error> {
        let Some(customer_id) = appt.customer_id else {
            return Ok(());
        };

        let customer = load_customer_messaging_row(pool, customer_id).await?;
        if !email_opt_in_ok(&customer) {
            return Ok(());
        }
        let Some(ref em) = customer.email else {
            return Ok(());
        };
        if !looks_like_email(em) {
            return Ok(());
        }

        let podium_cfg = podium::load_store_podium_config(pool).await.ok();
        let email_templates = podium_cfg
            .as_ref()
            .map(|c| c.email_templates.merged_defaults())
            .unwrap_or_default();

        let first = customer.first_name.as_deref().unwrap_or("there");
        let starts = appt.starts_at.format("%Y-%m-%d %H:%M %Z").to_string();
        let appt_type = appt.appointment_type.as_str();
        let notes_block = appt
            .notes
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|n| format!("<p><b>Notes:</b> {}</p>", html_escape_minimal(n)))
            .unwrap_or_default();

        let vars = [
            ("first_name", first),
            ("starts_at", starts.as_str()),
            ("appointment_type", appt_type),
            ("notes_block", notes_block.as_str()),
        ];
        let subject =
            apply_template_placeholders(&email_templates.appointment_confirmation_subject, &vars);
        let html =
            apply_template_placeholders(&email_templates.appointment_confirmation_html, &vars);

        tracing::info!(
            target: "messaging",
            event = "email_dispatch",
            customer_id = %customer_id,
            appointment_id = %appt.id,
            kind = "appointment_confirmation",
            "Appointment confirmation email triggered"
        );

        podium::try_send_operational_email(
            pool,
            http,
            podium_cache,
            em,
            subject,
            html,
            Some(customer_id),
        )
        .await;

        Ok(())
    }

    /// Triggers a "Ready for Pickup" notification to the customer.
    pub async fn trigger_ready_for_pickup(
        pool: &PgPool,
        http: &reqwest::Client,
        podium_cache: &Arc<Mutex<PodiumTokenCache>>,
        transaction_id: Uuid,
        customer_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        let customer = load_customer_messaging_row(pool, customer_id).await?;

        let order_ref = transaction_id
            .simple()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>();

        let podium_cfg = podium::load_store_podium_config(pool).await.ok();
        let sms_templates = podium_cfg
            .as_ref()
            .map(|c| c.templates.merged_defaults())
            .unwrap_or_default();
        let email_templates = podium_cfg
            .as_ref()
            .map(|c| c.email_templates.merged_defaults())
            .unwrap_or_default();

        let sms_ok = customer.transactional_sms_opt_in || customer.marketing_sms_opt_in;
        if sms_ok {
            if let Some(ref phone) = customer.phone {
                let first = customer.first_name.as_deref().unwrap_or("there");
                let body = apply_template_placeholders(
                    &sms_templates.ready_for_pickup,
                    &[("first_name", first), ("order_ref", order_ref.as_str())],
                );

                tracing::info!(
                    target: "messaging",
                    event = "sms_dispatch",
                    customer_id = %customer_id,
                    transaction_id = %transaction_id,
                    "Ready for Pickup SMS triggered"
                );

                if let Some(e164) = normalize_phone_e164(phone) {
                    podium::try_send_operational_sms(
                        pool,
                        http,
                        podium_cache,
                        &e164,
                        body.clone(),
                        Some(customer_id),
                    )
                    .await;
                } else {
                    tracing::warn!(
                        target: "messaging",
                        event = "sms_skip",
                        reason_class = "phone_normalization",
                        customer_id = %customer_id,
                        "Skipping SMS: phone could not be normalized to E.164"
                    );
                }
            }
        }

        if email_opt_in_ok(&customer) {
            if let Some(ref email) = customer.email {
                if looks_like_email(email) {
                    let first = customer.first_name.as_deref().unwrap_or("there");
                    let subject = apply_template_placeholders(
                        &email_templates.ready_for_pickup_subject,
                        &[("first_name", first), ("order_ref", order_ref.as_str())],
                    );
                    let html = apply_template_placeholders(
                        &email_templates.ready_for_pickup_html,
                        &[("first_name", first), ("order_ref", order_ref.as_str())],
                    );
                    tracing::info!(
                        target: "messaging",
                        event = "email_dispatch",
                        customer_id = %customer_id,
                        transaction_id = %transaction_id,
                        kind = "ready_for_pickup",
                        "Ready for Pickup email (Podium) triggered"
                    );
                    podium::try_send_operational_email(
                        pool,
                        http,
                        podium_cache,
                        email,
                        subject,
                        html,
                        Some(customer_id),
                    )
                    .await;
                }
            }
        }

        Ok(())
    }

    /// Alteration work order marked ready — SMS/email (same opt-in rules as pickup).
    pub async fn trigger_alteration_ready(
        pool: &PgPool,
        http: &reqwest::Client,
        podium_cache: &Arc<Mutex<PodiumTokenCache>>,
        customer_id: Uuid,
        alteration_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        let customer = load_customer_messaging_row(pool, customer_id).await?;

        let short = alteration_id
            .simple()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>();

        let podium_cfg = podium::load_store_podium_config(pool).await.ok();
        let sms_templates = podium_cfg
            .as_ref()
            .map(|c| c.templates.merged_defaults())
            .unwrap_or_default();
        let email_templates = podium_cfg
            .as_ref()
            .map(|c| c.email_templates.merged_defaults())
            .unwrap_or_default();

        let sms_ok = customer.transactional_sms_opt_in || customer.marketing_sms_opt_in;
        if sms_ok {
            if let Some(ref phone) = customer.phone {
                let first = customer.first_name.as_deref().unwrap_or("there");
                let body = apply_template_placeholders(
                    &sms_templates.alteration_ready,
                    &[("first_name", first), ("alteration_ref", short.as_str())],
                );

                tracing::info!(
                    target: "messaging",
                    event = "sms_dispatch",
                    customer_id = %customer_id,
                    alteration_id = %alteration_id,
                    "Alteration ready SMS triggered"
                );

                if let Some(e164) = normalize_phone_e164(phone) {
                    podium::try_send_operational_sms(
                        pool,
                        http,
                        podium_cache,
                        &e164,
                        body,
                        Some(customer_id),
                    )
                    .await;
                } else {
                    tracing::warn!(
                        target: "messaging",
                        event = "sms_skip",
                        reason_class = "phone_normalization",
                        customer_id = %customer_id,
                        "Skipping alteration SMS: phone could not be normalized to E.164"
                    );
                }
            }
        }

        if email_opt_in_ok(&customer) {
            if let Some(ref email) = customer.email {
                if looks_like_email(email) {
                    let first = customer.first_name.as_deref().unwrap_or("there");
                    let subject = apply_template_placeholders(
                        &email_templates.alteration_ready_subject,
                        &[("first_name", first), ("alteration_ref", short.as_str())],
                    );
                    let html = apply_template_placeholders(
                        &email_templates.alteration_ready_html,
                        &[("first_name", first), ("alteration_ref", short.as_str())],
                    );
                    tracing::info!(
                        target: "messaging",
                        event = "email_dispatch",
                        customer_id = %customer_id,
                        alteration_id = %alteration_id,
                        kind = "alteration_ready",
                        "Alteration ready email (Podium) triggered"
                    );
                    podium::try_send_operational_email(
                        pool,
                        http,
                        podium_cache,
                        email,
                        subject,
                        html,
                        Some(customer_id),
                    )
                    .await;
                }
            }
        }

        Ok(())
    }

    /// Listens for order status changes and triggers relevant automated pings.
    pub async fn handle_status_change(
        pool: &PgPool,
        http: &reqwest::Client,
        podium_cache: &Arc<Mutex<PodiumTokenCache>>,
        transaction_id: Uuid,
        new_status: DbOrderStatus,
    ) -> Result<(), sqlx::Error> {
        if new_status == DbOrderStatus::Fulfilled {
            let customer_id: Option<Uuid> =
                sqlx::query_scalar("SELECT customer_id FROM transactions WHERE id = $1")
                    .bind(transaction_id)
                    .fetch_one(pool)
                    .await?;

            if let Some(cid) = customer_id {
                let pool_clone = pool.clone();
                let http_clone = http.clone();
                let cache_clone = Arc::clone(podium_cache);
                tokio::spawn(async move {
                    if let Err(e) = Self::trigger_ready_for_pickup(
                        &pool_clone,
                        &http_clone,
                        &cache_clone,
                        transaction_id,
                        cid,
                    )
                    .await
                    {
                        tracing::error!(error = %e, transaction_id = %transaction_id, "Failed to trigger messaging ping");
                    }
                });
            }
        }
        Ok(())
    }
}

fn html_escape_minimal(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
