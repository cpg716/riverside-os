use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::logic::customer_notifications::{
    record_customer_notification, CustomerNotificationChannel, CustomerNotificationKind,
};
use crate::logic::email as store_email;
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
    row.transactional_email_opt_in
}

fn sms_opt_in_ok(row: &CustomerMessagingRow) -> bool {
    row.transactional_sms_opt_in
}

fn url_encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn google_calendar_link(summary: &str, starts_at: chrono::DateTime<chrono::Utc>) -> String {
    let ends_at = starts_at + chrono::Duration::hours(1);
    let start = starts_at.format("%Y%m%dT%H%M%SZ").to_string();
    let end = ends_at.format("%Y%m%dT%H%M%SZ").to_string();
    format!(
        "https://calendar.google.com/calendar/render?action=TEMPLATE&text={}&dates={}/{}",
        url_encode_component(summary),
        start,
        end
    )
}

fn ics_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

fn appointment_ics(
    appointment_id: Uuid,
    summary: &str,
    starts_at: chrono::DateTime<chrono::Utc>,
    notes: Option<&str>,
) -> String {
    let ends_at = starts_at + chrono::Duration::hours(1);
    let now = chrono::Utc::now();
    format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Riverside OS//Appointments//EN\r\nMETHOD:PUBLISH\r\nBEGIN:VEVENT\r\nUID:{}@riverside-os\r\nDTSTAMP:{}\r\nDTSTART:{}\r\nDTEND:{}\r\nSUMMARY:{}\r\nDESCRIPTION:{}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        appointment_id,
        now.format("%Y%m%dT%H%M%SZ"),
        starts_at.format("%Y%m%dT%H%M%SZ"),
        ends_at.format("%Y%m%dT%H%M%SZ"),
        ics_escape(summary),
        ics_escape(notes.unwrap_or("Riverside appointment"))
    )
}

#[allow(clippy::too_many_arguments)]
async fn record_outcome(
    pool: &PgPool,
    customer_id: Uuid,
    entity_type: &str,
    entity_id: Uuid,
    kind: CustomerNotificationKind,
    channel: CustomerNotificationChannel,
    body_preview: &str,
    delivery_error: Option<String>,
    metadata: serde_json::Value,
) {
    let _ = record_customer_notification(
        pool,
        customer_id,
        entity_type,
        entity_id,
        kind,
        channel,
        Some(body_preview),
        delivery_error.as_deref(),
        metadata,
    )
    .await;
}

/// Core messaging dispatcher for automated notifications.
/// SMS: Podium when env + `podium_sms_config.sms_send_enabled` + location_uid.
/// Email: first-party store email (IONOS-compatible IMAP/SMTP) when enabled.
pub struct MessagingService;

impl MessagingService {
    /// New appointment with a linked `customer_id` — confirmation email when opted in.
    pub async fn trigger_appointment_confirmation(
        pool: &PgPool,
        _http: &reqwest::Client,
        _podium_cache: &Arc<Mutex<PodiumTokenCache>>,
        appt: &AppointmentRow,
    ) -> Result<(), sqlx::Error> {
        let Some(customer_id) = appt.customer_id else {
            return Ok(());
        };

        let customer = load_customer_messaging_row(pool, customer_id).await?;
        let podium_cfg = podium::load_store_podium_config(pool).await.ok();
        let sms_templates = podium_cfg
            .as_ref()
            .map(|c| c.templates.merged_defaults())
            .unwrap_or_default();
        let email_templates = podium_cfg
            .as_ref()
            .map(|c| c.email_templates.merged_defaults())
            .unwrap_or_default();

        let first = customer.first_name.as_deref().unwrap_or("there");
        let starts = appt.starts_at.format("%Y-%m-%d %H:%M %Z").to_string();
        let appt_type = appt.appointment_type.as_str();
        let calendar_summary = format!("Riverside {appt_type} Appointment");
        let calendar_url = google_calendar_link(&calendar_summary, appt.starts_at);
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
        let mut attempted = Vec::new();
        let mut errors: Vec<String> = Vec::new();

        if sms_opt_in_ok(&customer) {
            if let Some(ref phone) = customer.phone {
                if let Some(e164) = normalize_phone_e164(phone) {
                    let sms_body = apply_template_placeholders(
                        &sms_templates.appointment_confirmation,
                        &[
                            ("first_name", first),
                            ("starts_at", starts.as_str()),
                            ("appointment_type", appt_type),
                        ],
                    );
                    let sms_ics = appointment_ics(
                        appt.id,
                        &calendar_summary,
                        appt.starts_at,
                        appt.notes.as_deref(),
                    );
                    let sms_result = podium::send_podium_phone_message_with_attachment(
                        pool,
                        _http,
                        _podium_cache,
                        &e164,
                        &sms_body,
                        sms_ics.into_bytes(),
                        "riverside-appointment.ics",
                        "text/calendar; charset=utf-8",
                    )
                    .await;
                    if sms_result.is_ok() {
                        attempted.push("sms");
                    }
                    let sms_error = sms_result.err().map(|e| e.to_string());
                    if let Some(error) = sms_error.as_ref() {
                        errors.push(error.clone());
                    }
                    record_outcome(
                        pool,
                        customer_id,
                        "appointment",
                        appt.id,
                        CustomerNotificationKind::AppointmentConfirmation,
                        CustomerNotificationChannel::Sms,
                        &sms_body,
                        sms_error,
                        serde_json::json!({ "appointment_type": appt_type, "starts_at": starts, "calendar_url": calendar_url }),
                    )
                    .await;
                } else {
                    errors.push(
                        "SMS skipped: customer phone is not a valid mobile number.".to_string(),
                    );
                }
            } else {
                errors.push("SMS skipped: customer has no phone number.".to_string());
            }
        } else {
            errors.push("SMS skipped: customer is not opted in for transactional SMS.".to_string());
        }

        let subject =
            apply_template_placeholders(&email_templates.appointment_confirmation_subject, &vars);
        let mut html =
            apply_template_placeholders(&email_templates.appointment_confirmation_html, &vars);
        html.push_str(&format!(
            "<p><a href=\"{}\">Add this appointment to your calendar</a></p>",
            calendar_url
        ));

        if email_opt_in_ok(&customer) {
            if let Some(ref em) = customer.email {
                if looks_like_email(em) {
                    tracing::info!(
                        target: "messaging",
                        event = "email_dispatch",
                        customer_id = %customer_id,
                        appointment_id = %appt.id,
                        kind = "appointment_confirmation",
                        "Appointment confirmation email triggered"
                    );

                    let ics = appointment_ics(
                        appt.id,
                        &calendar_summary,
                        appt.starts_at,
                        appt.notes.as_deref(),
                    );
                    let email_result = store_email::send_email_with_attachments(
                        pool,
                        em,
                        &subject,
                        &html,
                        None,
                        None,
                        "automated",
                        vec![store_email::EmailAttachmentPayload {
                            filename: "riverside-appointment.ics".to_string(),
                            content_type: "text/calendar; charset=utf-8".to_string(),
                            bytes: ics.into_bytes(),
                        }],
                    )
                    .await;
                    if email_result.is_ok() {
                        attempted.push("email");
                    }
                    let email_error = email_result.err().map(|e| e.to_string());
                    if let Some(error) = email_error.as_ref() {
                        errors.push(error.clone());
                    }
                    record_outcome(
                        pool,
                        customer_id,
                        "appointment",
                        appt.id,
                        CustomerNotificationKind::AppointmentConfirmation,
                        CustomerNotificationChannel::Email,
                        &format!("{subject}\n{html}"),
                        email_error,
                        serde_json::json!({ "appointment_type": appt_type, "starts_at": starts, "calendar_url": calendar_url }),
                    )
                    .await;
                } else {
                    errors.push("Email skipped: customer email address is invalid.".to_string());
                }
            } else {
                errors.push("Email skipped: customer has no email address.".to_string());
            }
        } else {
            errors.push(
                "Email skipped: customer is not opted in for transactional email.".to_string(),
            );
        }

        Ok(())
    }

    /// Sends the automated customer reminder at the 24-hour-before mark.
    pub async fn trigger_appointment_reminder(
        pool: &PgPool,
        http: &reqwest::Client,
        podium_cache: &Arc<Mutex<PodiumTokenCache>>,
        appt: &AppointmentRow,
    ) -> Result<(), sqlx::Error> {
        let Some(customer_id) = appt.customer_id else {
            return Ok(());
        };

        let customer = load_customer_messaging_row(pool, customer_id).await?;
        let podium_cfg = podium::load_store_podium_config(pool).await.ok();
        let sms_templates = podium_cfg
            .as_ref()
            .map(|c| c.templates.merged_defaults())
            .unwrap_or_default();

        let first = customer.first_name.as_deref().unwrap_or("there");
        let starts = appt.starts_at.format("%Y-%m-%d %H:%M %Z").to_string();
        let appt_type = appt.appointment_type.as_str();

        if sms_opt_in_ok(&customer) {
            if let Some(ref phone) = customer.phone {
                let sms_body = apply_template_placeholders(
                    &sms_templates.appointment_reminder,
                    &[
                        ("first_name", first),
                        ("starts_at", starts.as_str()),
                        ("appointment_type", appt_type),
                    ],
                );
                let sms_error = if let Some(e164) = normalize_phone_e164(phone) {
                    podium::try_send_operational_sms(
                        pool,
                        http,
                        podium_cache,
                        &e164,
                        sms_body.clone(),
                        Some(customer_id),
                    )
                    .await
                    .err()
                    .map(|e| e.to_string())
                } else {
                    Some("SMS skipped: customer phone is not a valid mobile number.".to_string())
                };
                record_outcome(
                    pool,
                    customer_id,
                    "appointment",
                    appt.id,
                    CustomerNotificationKind::AppointmentReminder,
                    CustomerNotificationChannel::Sms,
                    &sms_body,
                    sms_error,
                    serde_json::json!({ "appointment_type": appt_type, "starts_at": starts }),
                )
                .await;
            }
        }

        if email_opt_in_ok(&customer) {
            if let Some(ref email) = customer.email {
                if looks_like_email(email) {
                    let subject = format!("Reminder: Riverside {appt_type} appointment tomorrow");
                    let html = format!(
                        "<p>Hi {},</p><p>Reminder: your <b>{}</b> appointment is tomorrow at <b>{}</b>.</p>",
                        html_escape_minimal(first),
                        html_escape_minimal(appt_type),
                        html_escape_minimal(&starts)
                    );
                    let email_error = store_email::try_send_operational_email(
                        pool,
                        email,
                        subject.clone(),
                        html.clone(),
                        Some(customer_id),
                    )
                    .await
                    .err()
                    .map(|e| e.to_string());
                    record_outcome(
                        pool,
                        customer_id,
                        "appointment",
                        appt.id,
                        CustomerNotificationKind::AppointmentReminder,
                        CustomerNotificationChannel::Email,
                        &format!("{subject}\n{html}"),
                        email_error,
                        serde_json::json!({ "appointment_type": appt_type, "starts_at": starts }),
                    )
                    .await;
                }
            }
        }

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
                    let sms_result = podium::try_send_operational_sms(
                        pool,
                        http,
                        podium_cache,
                        &e164,
                        body.clone(),
                        Some(customer_id),
                    )
                    .await;
                    record_outcome(
                        pool,
                        customer_id,
                        "order",
                        transaction_id,
                        CustomerNotificationKind::ReadyForPickup,
                        CustomerNotificationChannel::Sms,
                        &body,
                        sms_result.err().map(|e| e.to_string()),
                        serde_json::json!({ "order_ref": order_ref }),
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
                        "Ready for Pickup email triggered"
                    );
                    let email_result = store_email::try_send_operational_email(
                        pool,
                        email,
                        subject.clone(),
                        html.clone(),
                        Some(customer_id),
                    )
                    .await;
                    record_outcome(
                        pool,
                        customer_id,
                        "order",
                        transaction_id,
                        CustomerNotificationKind::ReadyForPickup,
                        CustomerNotificationChannel::Email,
                        &format!("{subject}\n{html}"),
                        email_result.err().map(|e| e.to_string()),
                        serde_json::json!({ "order_ref": order_ref }),
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
                    let sms_result = podium::try_send_operational_sms(
                        pool,
                        http,
                        podium_cache,
                        &e164,
                        body.clone(),
                        Some(customer_id),
                    )
                    .await;
                    record_outcome(
                        pool,
                        customer_id,
                        "alteration",
                        alteration_id,
                        CustomerNotificationKind::AlterationReady,
                        CustomerNotificationChannel::Sms,
                        &body,
                        sms_result.err().map(|e| e.to_string()),
                        serde_json::json!({ "alteration_ref": short }),
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
                        "Alteration ready email triggered"
                    );
                    let email_result = store_email::try_send_operational_email(
                        pool,
                        email,
                        subject.clone(),
                        html.clone(),
                        Some(customer_id),
                    )
                    .await;
                    record_outcome(
                        pool,
                        customer_id,
                        "alteration",
                        alteration_id,
                        CustomerNotificationKind::AlterationReady,
                        CustomerNotificationChannel::Email,
                        &format!("{subject}\n{html}"),
                        email_result.err().map(|e| e.to_string()),
                        serde_json::json!({ "alteration_ref": short }),
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
