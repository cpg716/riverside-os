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
use crate::logic::podium_messaging;
use crate::logic::wedding_api_types::AppointmentRow;
use crate::models::DbOrderStatus;

#[derive(Debug, sqlx::FromRow)]
struct CustomerMessagingRow {
    first_name: Option<String>,
    last_name: Option<String>,
    customer_code: String,
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
        SELECT first_name, last_name, customer_code, email, phone,
               marketing_email_opt_in, marketing_sms_opt_in, transactional_sms_opt_in,
               transactional_email_opt_in
        FROM customers WHERE id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await
}

#[derive(Debug, sqlx::FromRow)]
struct StoreMessageIdentity {
    store_name: String,
    store_phone: String,
    store_email: String,
    store_address: String,
}

async fn load_store_message_identity(pool: &PgPool) -> Result<StoreMessageIdentity, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT
            COALESCE(NULLIF(BTRIM(receipt_config->>'store_name'), ''), 'Riverside Men''s Shop') AS store_name,
            COALESCE(NULLIF(BTRIM(receipt_config->>'store_phone'), ''), '(716) 833-8401') AS store_phone,
            COALESCE(NULLIF(BTRIM(receipt_config->>'store_email'), ''), 'info@riversidemens.com') AS store_email,
            COALESCE(NULLIF(BTRIM(receipt_config->>'store_address'), ''), '6470 Transit Rd, Depew, NY') AS store_address
        FROM store_settings
        WHERE id = 1
        "#,
    )
    .fetch_one(pool)
    .await
}

fn customer_full_name(customer: &CustomerMessagingRow) -> String {
    [
        customer.first_name.as_deref(),
        customer.last_name.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
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

#[derive(Debug, Clone, Default)]
pub struct MessagingDeliverySummary {
    successful_channels: Vec<&'static str>,
    errors: Vec<String>,
}

impl MessagingDeliverySummary {
    fn delivered(&mut self, channel: &'static str) {
        if !self.successful_channels.contains(&channel) {
            self.successful_channels.push(channel);
        }
    }

    fn failed(&mut self, error: impl Into<String>) {
        self.errors.push(error.into());
    }

    pub fn is_delivered(&self) -> bool {
        !self.successful_channels.is_empty()
    }

    pub fn delivery_method(&self) -> &'static str {
        match (
            self.successful_channels.contains(&"sms"),
            self.successful_channels.contains(&"email"),
        ) {
            (true, true) => "both",
            (true, false) => "sms",
            (false, true) => "email",
            (false, false) => "none",
        }
    }

    pub fn delivery_error(&self) -> Option<String> {
        (!self.errors.is_empty()).then(|| self.errors.join("; "))
    }
}

/// Core messaging dispatcher for automated notifications.
/// SMS: Podium when credentials, location UID, and the matching `sms_features` flag are set.
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
        let store = load_store_message_identity(pool).await?;
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
        let last = customer.last_name.as_deref().unwrap_or("");
        let full_name = customer_full_name(&customer);
        let starts = appt.starts_at.format("%Y-%m-%d %H:%M %Z").to_string();
        let appointment_date = appt.starts_at.format("%A, %B %-d, %Y").to_string();
        let appointment_time = appt.starts_at.format("%-I:%M %p %Z").to_string();
        let appt_type = appt.appointment_type.as_str();
        let notes = appt.notes.as_deref().unwrap_or("");
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
            ("last_name", last),
            ("full_name", full_name.as_str()),
            ("customer_code", customer.customer_code.as_str()),
            ("starts_at", starts.as_str()),
            ("appointment_date", appointment_date.as_str()),
            ("appointment_time", appointment_time.as_str()),
            ("appointment_type", appt_type),
            ("notes", notes),
            ("notes_block", notes_block.as_str()),
            ("calendar_url", calendar_url.as_str()),
            ("store_name", store.store_name.as_str()),
            ("store_phone", store.store_phone.as_str()),
            ("store_email", store.store_email.as_str()),
            ("store_address", store.store_address.as_str()),
        ];
        let mut attempted = Vec::new();
        let mut errors: Vec<String> = Vec::new();

        if podium_cfg
            .as_ref()
            .is_some_and(|cfg| cfg.sms_features.appointment_confirmation)
            && sms_opt_in_ok(&customer)
        {
            if let Some(ref phone) = customer.phone {
                if let Some(e164) = normalize_phone_e164(phone) {
                    let sms_body =
                        apply_template_placeholders(&sms_templates.appointment_confirmation, &vars);
                    let sms_ics = appointment_ics(
                        appt.id,
                        &calendar_summary,
                        appt.starts_at,
                        appt.notes.as_deref(),
                    );
                    let sms_result = podium::send_podium_phone_message_with_attachment_tracked(
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
                    if let Ok(send_result) = sms_result.as_ref() {
                        attempted.push("sms");
                        if let Err(error) = podium_messaging::record_outbound_message(
                            pool,
                            customer_id,
                            "sms",
                            &sms_body,
                            None,
                            Some(&e164),
                            None,
                            "automated",
                            send_result.provider_message_id.as_deref(),
                            Some(&send_result.raw_response),
                        )
                        .await
                        {
                            tracing::error!(
                                customer_id = %customer_id,
                                error = %error,
                                "Could not record Podium appointment confirmation identity"
                            );
                        }
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
                            content_id: None,
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
        let store = load_store_message_identity(pool).await?;
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
        let last = customer.last_name.as_deref().unwrap_or("");
        let full_name = customer_full_name(&customer);
        let starts = appt.starts_at.format("%Y-%m-%d %H:%M %Z").to_string();
        let appointment_date = appt.starts_at.format("%A, %B %-d, %Y").to_string();
        let appointment_time = appt.starts_at.format("%-I:%M %p %Z").to_string();
        let appt_type = appt.appointment_type.as_str();
        let notes = appt.notes.as_deref().unwrap_or("");
        let vars = [
            ("first_name", first),
            ("last_name", last),
            ("full_name", full_name.as_str()),
            ("customer_code", customer.customer_code.as_str()),
            ("starts_at", starts.as_str()),
            ("appointment_date", appointment_date.as_str()),
            ("appointment_time", appointment_time.as_str()),
            ("appointment_type", appt_type),
            ("notes", notes),
            ("store_name", store.store_name.as_str()),
            ("store_phone", store.store_phone.as_str()),
            ("store_email", store.store_email.as_str()),
            ("store_address", store.store_address.as_str()),
        ];

        if podium_cfg
            .as_ref()
            .is_some_and(|cfg| cfg.sms_features.appointment_reminder)
            && sms_opt_in_ok(&customer)
        {
            if let Some(ref phone) = customer.phone {
                let sms_body =
                    apply_template_placeholders(&sms_templates.appointment_reminder, &vars);
                let sms_error = if let Some(e164) = normalize_phone_e164(phone) {
                    podium::try_send_operational_sms(
                        pool,
                        http,
                        podium_cache,
                        &e164,
                        sms_body.clone(),
                        Some(customer_id),
                        podium::PodiumSmsFeature::AppointmentReminder,
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
                    let subject = apply_template_placeholders(
                        &email_templates.appointment_reminder_subject,
                        &vars,
                    );
                    let html = apply_template_placeholders(
                        &email_templates.appointment_reminder_html,
                        &vars,
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
    ) -> Result<MessagingDeliverySummary, sqlx::Error> {
        let customer = load_customer_messaging_row(pool, customer_id).await?;
        let store = load_store_message_identity(pool).await?;
        let mut delivery = MessagingDeliverySummary::default();
        let transaction_ref: String =
            sqlx::query_scalar("SELECT display_id FROM transactions WHERE id = $1")
                .bind(transaction_id)
                .fetch_one(pool)
                .await?;

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
        let last = customer.last_name.as_deref().unwrap_or("");
        let full_name = customer_full_name(&customer);
        let vars = [
            ("first_name", first),
            ("last_name", last),
            ("full_name", full_name.as_str()),
            ("customer_code", customer.customer_code.as_str()),
            ("order_ref", transaction_ref.as_str()),
            ("transaction_ref", transaction_ref.as_str()),
            ("store_name", store.store_name.as_str()),
            ("store_phone", store.store_phone.as_str()),
            ("store_email", store.store_email.as_str()),
            ("store_address", store.store_address.as_str()),
        ];

        let sms_ok = customer.transactional_sms_opt_in || customer.marketing_sms_opt_in;
        if podium_cfg
            .as_ref()
            .is_some_and(|cfg| cfg.sms_features.ready_for_pickup)
            && sms_ok
        {
            if let Some(ref phone) = customer.phone {
                let body = apply_template_placeholders(&sms_templates.ready_for_pickup, &vars);

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
                        podium::PodiumSmsFeature::ReadyForPickup,
                    )
                    .await;
                    match &sms_result {
                        Ok(()) => delivery.delivered("sms"),
                        Err(error) => delivery.failed(format!("SMS failed: {error}")),
                    }
                    record_outcome(
                        pool,
                        customer_id,
                        "order",
                        transaction_id,
                        CustomerNotificationKind::ReadyForPickup,
                        CustomerNotificationChannel::Sms,
                        &body,
                        sms_result.err().map(|e| e.to_string()),
                        serde_json::json!({ "transaction_ref": transaction_ref }),
                    )
                    .await;
                } else {
                    delivery.failed("SMS skipped: customer phone is invalid.");
                    tracing::warn!(
                        target: "messaging",
                        event = "sms_skip",
                        reason_class = "phone_normalization",
                        customer_id = %customer_id,
                        "Skipping SMS: phone could not be normalized to E.164"
                    );
                }
            } else {
                delivery.failed("SMS skipped: customer has no phone number.");
            }
        } else {
            delivery.failed("SMS skipped: customer is not opted in.");
        }

        if email_opt_in_ok(&customer) {
            if let Some(ref email) = customer.email {
                if looks_like_email(email) {
                    let subject = apply_template_placeholders(
                        &email_templates.ready_for_pickup_subject,
                        &vars,
                    );
                    let html =
                        apply_template_placeholders(&email_templates.ready_for_pickup_html, &vars);
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
                    match &email_result {
                        Ok(_) => delivery.delivered("email"),
                        Err(error) => delivery.failed(format!("Email failed: {error}")),
                    }
                    record_outcome(
                        pool,
                        customer_id,
                        "order",
                        transaction_id,
                        CustomerNotificationKind::ReadyForPickup,
                        CustomerNotificationChannel::Email,
                        &format!("{subject}\n{html}"),
                        email_result.err().map(|e| e.to_string()),
                        serde_json::json!({ "transaction_ref": transaction_ref }),
                    )
                    .await;
                } else {
                    delivery.failed("Email skipped: customer email address is invalid.");
                }
            } else {
                delivery.failed("Email skipped: customer has no email address.");
            }
        } else {
            delivery.failed("Email skipped: customer is not opted in.");
        }

        Ok(delivery)
    }

    /// Alteration work order marked ready — SMS/email (same opt-in rules as pickup).
    pub async fn trigger_alteration_ready(
        pool: &PgPool,
        http: &reqwest::Client,
        podium_cache: &Arc<Mutex<PodiumTokenCache>>,
        customer_id: Uuid,
        alteration_id: Uuid,
    ) -> Result<MessagingDeliverySummary, sqlx::Error> {
        let customer = load_customer_messaging_row(pool, customer_id).await?;
        let store = load_store_message_identity(pool).await?;
        let mut delivery = MessagingDeliverySummary::default();
        let (alteration_ref, transaction_ref): (String, Option<String>) = sqlx::query_as(
            r#"
            SELECT
                COALESCE(NULLIF(BTRIM(a.ticket_number), ''), LEFT(a.id::text, 8)) AS alteration_ref,
                t.display_id AS transaction_ref
            FROM alteration_orders a
            LEFT JOIN transactions t ON t.id = a.transaction_id
            WHERE a.id = $1
            "#,
        )
        .bind(alteration_id)
        .fetch_one(pool)
        .await?;

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
        let last = customer.last_name.as_deref().unwrap_or("");
        let full_name = customer_full_name(&customer);
        let transaction_ref = transaction_ref.unwrap_or_default();
        let vars = [
            ("first_name", first),
            ("last_name", last),
            ("full_name", full_name.as_str()),
            ("customer_code", customer.customer_code.as_str()),
            ("alteration_ref", alteration_ref.as_str()),
            ("transaction_ref", transaction_ref.as_str()),
            ("store_name", store.store_name.as_str()),
            ("store_phone", store.store_phone.as_str()),
            ("store_email", store.store_email.as_str()),
            ("store_address", store.store_address.as_str()),
        ];

        let sms_ok = customer.transactional_sms_opt_in || customer.marketing_sms_opt_in;
        if podium_cfg
            .as_ref()
            .is_some_and(|cfg| cfg.sms_features.alteration_ready)
            && sms_ok
        {
            if let Some(ref phone) = customer.phone {
                let body = apply_template_placeholders(&sms_templates.alteration_ready, &vars);

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
                        podium::PodiumSmsFeature::AlterationReady,
                    )
                    .await;
                    match &sms_result {
                        Ok(()) => delivery.delivered("sms"),
                        Err(error) => delivery.failed(format!("SMS failed: {error}")),
                    }
                    record_outcome(
                        pool,
                        customer_id,
                        "alteration",
                        alteration_id,
                        CustomerNotificationKind::AlterationReady,
                        CustomerNotificationChannel::Sms,
                        &body,
                        sms_result.err().map(|e| e.to_string()),
                        serde_json::json!({ "alteration_ref": alteration_ref, "transaction_ref": transaction_ref }),
                    )
                    .await;
                } else {
                    delivery.failed("SMS skipped: customer phone is invalid.");
                    tracing::warn!(
                        target: "messaging",
                        event = "sms_skip",
                        reason_class = "phone_normalization",
                        customer_id = %customer_id,
                        "Skipping alteration SMS: phone could not be normalized to E.164"
                    );
                }
            } else {
                delivery.failed("SMS skipped: customer has no phone number.");
            }
        } else {
            delivery.failed("SMS skipped: customer is not opted in.");
        }

        if email_opt_in_ok(&customer) {
            if let Some(ref email) = customer.email {
                if looks_like_email(email) {
                    let subject = apply_template_placeholders(
                        &email_templates.alteration_ready_subject,
                        &vars,
                    );
                    let html =
                        apply_template_placeholders(&email_templates.alteration_ready_html, &vars);
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
                    match &email_result {
                        Ok(_) => delivery.delivered("email"),
                        Err(error) => delivery.failed(format!("Email failed: {error}")),
                    }
                    record_outcome(
                        pool,
                        customer_id,
                        "alteration",
                        alteration_id,
                        CustomerNotificationKind::AlterationReady,
                        CustomerNotificationChannel::Email,
                        &format!("{subject}\n{html}"),
                        email_result.err().map(|e| e.to_string()),
                        serde_json::json!({ "alteration_ref": alteration_ref, "transaction_ref": transaction_ref }),
                    )
                    .await;
                } else {
                    delivery.failed("Email skipped: customer email address is invalid.");
                }
            } else {
                delivery.failed("Email skipped: customer has no email address.");
            }
        } else {
            delivery.failed("Email skipped: customer is not opted in.");
        }

        Ok(delivery)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_summary_reports_only_successful_channels() {
        let mut summary = MessagingDeliverySummary::default();
        summary.failed("SMS failed");
        summary.delivered("email");
        assert!(summary.is_delivered());
        assert_eq!(summary.delivery_method(), "email");
        assert_eq!(summary.delivery_error().as_deref(), Some("SMS failed"));
    }

    #[test]
    fn delivery_summary_fails_when_no_channel_succeeds() {
        let mut summary = MessagingDeliverySummary::default();
        summary.failed("SMS disabled");
        summary.failed("Email missing");
        assert!(!summary.is_delivered());
        assert_eq!(summary.delivery_method(), "none");
        assert_eq!(
            summary.delivery_error().as_deref(),
            Some("SMS disabled; Email missing")
        );
    }
}
