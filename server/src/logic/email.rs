//! First-party store email via IMAP/SMTP (IONOS-compatible).

use chrono::{DateTime, Utc};
use lettre::message::{header::ContentType, Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};
use mail_parser::{Address, GetHeader, HeaderName, HeaderValue, MessageParser};
use native_tls::TlsConnector;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashMap;
use thiserror::Error;
use uuid::Uuid;

use crate::auth::permissions::CUSTOMERS_HUB_VIEW;
use crate::logic::integration_credentials;
use crate::logic::notifications;
use crate::logic::podium;
use crate::logic::podium_messaging;

const EMAIL_CREDENTIAL_KEYS: &[&str] = &[
    "imap_username",
    "imap_password",
    "smtp_username",
    "smtp_password",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct StoreEmailConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_from_email")]
    pub from_email: String,
    #[serde(default = "default_from_name")]
    pub from_name: String,
    #[serde(default = "default_from_email")]
    pub reply_to_email: String,
    #[serde(default = "default_imap_host")]
    pub imap_host: String,
    #[serde(default = "default_imap_port")]
    pub imap_port: u16,
    #[serde(default = "default_true")]
    pub imap_tls: bool,
    #[serde(default = "default_imap_folder")]
    pub imap_folder: String,
    #[serde(default = "default_smtp_host")]
    pub smtp_host: String,
    #[serde(default = "default_smtp_port")]
    pub smtp_port: u16,
    #[serde(default = "default_smtp_tls")]
    pub smtp_tls: String,
    #[serde(default = "default_true")]
    pub sync_enabled: bool,
    #[serde(default = "default_sync_limit")]
    pub sync_limit: i64,
}

impl Default for StoreEmailConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            from_email: default_from_email(),
            from_name: default_from_name(),
            reply_to_email: default_from_email(),
            imap_host: default_imap_host(),
            imap_port: default_imap_port(),
            imap_tls: true,
            imap_folder: default_imap_folder(),
            smtp_host: default_smtp_host(),
            smtp_port: default_smtp_port(),
            smtp_tls: default_smtp_tls(),
            sync_enabled: true,
            sync_limit: default_sync_limit(),
        }
    }
}

fn default_from_email() -> String {
    "info@riversidemens.com".to_string()
}
fn default_from_name() -> String {
    "Riverside Men's Shop".to_string()
}
fn default_imap_host() -> String {
    "imap.ionos.com".to_string()
}
fn default_imap_port() -> u16 {
    993
}
fn default_imap_folder() -> String {
    "INBOX".to_string()
}
fn default_smtp_host() -> String {
    "smtp.ionos.com".to_string()
}
fn default_smtp_port() -> u16 {
    465
}
fn default_smtp_tls() -> String {
    "ssl_tls".to_string()
}
fn default_sync_limit() -> i64 {
    50
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone)]
struct EmailCredentials {
    imap_username: String,
    imap_password: String,
    smtp_username: String,
    smtp_password: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EmailSettingsResponse {
    pub settings: StoreEmailConfig,
    pub credentials_configured: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MailboxMessageRow {
    pub id: Uuid,
    pub message_id: Option<String>,
    pub thread_key: Option<String>,
    pub direction: String,
    pub subject: Option<String>,
    pub from_email: Option<String>,
    pub from_name: Option<String>,
    pub to_emails: Value,
    pub cc_emails: Value,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub received_at: Option<DateTime<Utc>>,
    pub sent_at: Option<DateTime<Utc>>,
    pub customer_id: Option<Uuid>,
    pub customer_code: Option<String>,
    pub customer_name: Option<String>,
    pub staff_id: Option<Uuid>,
    pub staff_full_name: Option<String>,
    pub folder: String,
    pub status: String,
}

#[derive(Debug, Error)]
pub enum EmailError {
    #[error("email is not configured")]
    NotConfigured,
    #[error("invalid email payload: {0}")]
    InvalidPayload(String),
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("smtp error: {0}")]
    Smtp(String),
    #[error("imap error: {0}")]
    Imap(String),
}

pub fn parse_store_email_config(value: Value) -> StoreEmailConfig {
    serde_json::from_value(value).unwrap_or_default()
}

pub async fn load_store_email_config(pool: &PgPool) -> Result<StoreEmailConfig, sqlx::Error> {
    let raw: Value = sqlx::query_scalar("SELECT email_config FROM store_settings WHERE id = 1")
        .fetch_one(pool)
        .await?;
    Ok(parse_store_email_config(raw))
}

pub async fn save_store_email_config(
    pool: &PgPool,
    cfg: &StoreEmailConfig,
) -> Result<(), sqlx::Error> {
    let value = serde_json::to_value(cfg).unwrap_or_else(|_| json!({}));
    sqlx::query("UPDATE store_settings SET email_config = $1 WHERE id = 1")
        .bind(value)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn email_settings_response(pool: &PgPool) -> Result<EmailSettingsResponse, EmailError> {
    let settings = load_store_email_config(pool).await?;
    Ok(EmailSettingsResponse {
        settings,
        credentials_configured: load_email_credentials(pool).await.is_some(),
    })
}

async fn load_email_credentials(pool: &PgPool) -> Option<EmailCredentials> {
    let saved =
        integration_credentials::load_integration_credentials(pool, "email", EMAIL_CREDENTIAL_KEYS)
            .await
            .unwrap_or_default();
    let value = |saved: &HashMap<String, String>, key: &str, env: &str| {
        saved
            .get(key)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                std::env::var(env)
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            })
    };
    let imap_username = value(&saved, "imap_username", "RIVERSIDE_EMAIL_IMAP_USERNAME")?;
    let imap_password = value(&saved, "imap_password", "RIVERSIDE_EMAIL_IMAP_PASSWORD")?;
    let smtp_username = value(&saved, "smtp_username", "RIVERSIDE_EMAIL_SMTP_USERNAME")
        .unwrap_or_else(|| imap_username.clone());
    let smtp_password = value(&saved, "smtp_password", "RIVERSIDE_EMAIL_SMTP_PASSWORD")
        .unwrap_or_else(|| imap_password.clone());
    Some(EmailCredentials {
        imap_username,
        imap_password,
        smtp_username,
        smtp_password,
    })
}

fn clean_addr(addr: &str) -> Option<String> {
    let t = addr.trim().to_ascii_lowercase();
    if podium::looks_like_email(&t) {
        Some(t)
    } else {
        None
    }
}

fn parse_mailbox(input: &str, fallback_name: Option<&str>) -> Result<Mailbox, EmailError> {
    let email = clean_addr(input)
        .ok_or_else(|| EmailError::InvalidPayload("invalid email address".to_string()))?;
    let parsed = email
        .parse()
        .map_err(|_| EmailError::InvalidPayload("invalid email address".to_string()))?;
    Ok(Mailbox::new(fallback_name.map(str::to_string), parsed))
}

fn extract_addresses(addr: Option<&Address<'_>>) -> Vec<String> {
    match addr {
        Some(Address::List(list)) => list
            .iter()
            .filter_map(|a| a.address.as_deref().and_then(clean_addr))
            .collect(),
        Some(Address::Group(groups)) => groups
            .iter()
            .flat_map(|g| g.addresses.iter())
            .filter_map(|a| a.address.as_deref().and_then(clean_addr))
            .collect(),
        None => Vec::new(),
    }
}

fn extract_first_address(addr: Option<&Address<'_>>) -> (Option<String>, Option<String>) {
    match addr {
        Some(Address::List(list)) => list
            .first()
            .map(|a| {
                (
                    a.address.as_deref().and_then(clean_addr),
                    a.name.as_deref().map(str::to_string),
                )
            })
            .unwrap_or((None, None)),
        Some(Address::Group(groups)) => groups
            .iter()
            .flat_map(|g| g.addresses.iter())
            .next()
            .map(|a| {
                (
                    a.address.as_deref().and_then(clean_addr),
                    a.name.as_deref().map(str::to_string),
                )
            })
            .unwrap_or((None, None)),
        None => (None, None),
    }
}

fn canonical_message_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let inner = trimmed.trim_start_matches('<').trim_end_matches('>').trim();
    if inner.is_empty() {
        None
    } else {
        Some(format!("<{}>", inner.to_ascii_lowercase()))
    }
}

fn header_id_values(value: &HeaderValue<'_>) -> Vec<String> {
    value
        .as_text_list()
        .map(|ids| {
            ids.iter()
                .filter_map(|id| canonical_message_id(id.as_ref()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn parsed_header_ids(parsed: &mail_parser::Message<'_>, name: HeaderName<'_>) -> Vec<String> {
    parsed
        .parts
        .first()
        .and_then(|part| part.headers.header_value(&name))
        .map(header_id_values)
        .unwrap_or_default()
}

fn generated_message_id(from_email: &str) -> String {
    let domain = from_email
        .split('@')
        .nth(1)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("riversidemens.com");
    format!("<{}@{}>", Uuid::new_v4().simple(), domain)
}

fn first_non_empty(values: &[String]) -> Option<String> {
    values
        .iter()
        .find(|value| !value.trim().is_empty())
        .cloned()
}

fn thread_key_for(
    message_id: Option<&String>,
    in_reply_to: &[String],
    references: &[String],
) -> Option<String> {
    first_non_empty(references)
        .or_else(|| first_non_empty(in_reply_to))
        .or_else(|| message_id.cloned())
}

async fn match_customer_by_email(
    pool: &PgPool,
    email: Option<&str>,
) -> Result<Option<Uuid>, sqlx::Error> {
    let Some(email) = email.and_then(clean_addr) else {
        return Ok(None);
    };
    sqlx::query_scalar(
        r#"
        SELECT id
        FROM customers
        WHERE lower(email) = lower($1)
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(email)
    .fetch_optional(pool)
    .await
}

struct CustomerEmailMessage<'a> {
    direction: &'a str,
    subject: Option<&'a str>,
    body_text: Option<&'a str>,
    body_html: Option<&'a str>,
    staff_id: Option<Uuid>,
    to_email: Option<&'a str>,
}

async fn record_customer_email_message(
    pool: &PgPool,
    customer_id: Uuid,
    message: CustomerEmailMessage<'_>,
) -> Result<(), sqlx::Error> {
    let body = match (message.subject, message.body_text, message.body_html) {
        (Some(subject), Some(text), _) if !subject.trim().is_empty() => {
            format!("Subject: {}\n\n{}", subject.trim(), text.trim())
        }
        (Some(subject), None, Some(html)) if !subject.trim().is_empty() => {
            format!("<p><b>{}</b></p>{}", subject.trim(), html)
        }
        (_, Some(text), _) => text.to_string(),
        (_, _, Some(html)) => html.to_string(),
        _ => String::new(),
    };
    podium_messaging::record_outbound_message(
        pool,
        customer_id,
        "email",
        &body,
        message.staff_id,
        None,
        message.to_email,
        if message.direction == "automated" {
            "automated"
        } else {
            "outbound"
        },
    )
    .await
}

async fn record_inbound_customer_message(
    pool: &PgPool,
    customer_id: Uuid,
    subject: Option<&str>,
    body_text: Option<&str>,
    body_html: Option<&str>,
    from_email: Option<&str>,
) -> Result<(), sqlx::Error> {
    let body = match (subject, body_text, body_html) {
        (Some(subject), Some(text), _) if !subject.trim().is_empty() => {
            format!("Subject: {}\n\n{}", subject.trim(), text.trim())
        }
        (Some(subject), None, Some(html)) if !subject.trim().is_empty() => {
            format!("<p><b>{}</b></p>{}", subject.trim(), html)
        }
        (_, Some(text), _) => text.to_string(),
        (_, _, Some(html)) => html.to_string(),
        _ => String::new(),
    };
    let mut tx = pool.begin().await?;
    let conv_id: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM podium_conversation
        WHERE customer_id = $1 AND channel = 'email'
        ORDER BY last_message_at DESC
        LIMIT 1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(&mut *tx)
    .await?;
    let conv_id = if let Some(conv_id) = conv_id {
        conv_id
    } else {
        sqlx::query_scalar(
            r#"
            INSERT INTO podium_conversation (customer_id, channel, podium_conversation_uid, contact_email)
            VALUES ($1, 'email', NULL, $2)
            RETURNING id
            "#,
        )
        .bind(customer_id)
        .bind(from_email)
        .fetch_one(&mut *tx)
        .await?
    };
    sqlx::query("UPDATE podium_conversation SET last_message_at = NOW() WHERE id = $1")
        .bind(conv_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"
        INSERT INTO podium_message (
            conversation_id, direction, channel, body, staff_id, podium_message_uid, raw_payload, podium_sender_name
        )
        VALUES ($1, 'inbound', 'email', $2, NULL, NULL, NULL, NULL)
        "#,
    )
    .bind(conv_id)
    .bind(body)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn send_email(
    pool: &PgPool,
    to_email: &str,
    subject: &str,
    html_body: &str,
    staff_id: Option<Uuid>,
    signature_html: Option<&str>,
    direction: &str,
) -> Result<Uuid, EmailError> {
    send_email_with_reply_context(
        pool,
        to_email,
        subject,
        html_body,
        staff_id,
        signature_html,
        direction,
        None,
    )
    .await
}

#[derive(Debug, Clone)]
pub struct EmailAttachmentPayload {
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[allow(clippy::too_many_arguments)]
pub async fn send_email_with_attachments(
    pool: &PgPool,
    to_email: &str,
    subject: &str,
    html_body: &str,
    staff_id: Option<Uuid>,
    signature_html: Option<&str>,
    direction: &str,
    attachments: Vec<EmailAttachmentPayload>,
) -> Result<Uuid, EmailError> {
    send_email_with_reply_context_and_attachments(
        pool,
        to_email,
        subject,
        html_body,
        staff_id,
        signature_html,
        direction,
        None,
        attachments,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn send_email_with_reply_context(
    pool: &PgPool,
    to_email: &str,
    subject: &str,
    html_body: &str,
    staff_id: Option<Uuid>,
    signature_html: Option<&str>,
    direction: &str,
    reply_to_mailbox_message_id: Option<Uuid>,
) -> Result<Uuid, EmailError> {
    send_email_with_reply_context_and_attachments(
        pool,
        to_email,
        subject,
        html_body,
        staff_id,
        signature_html,
        direction,
        reply_to_mailbox_message_id,
        Vec::new(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn send_email_with_reply_context_and_attachments(
    pool: &PgPool,
    to_email: &str,
    subject: &str,
    html_body: &str,
    staff_id: Option<Uuid>,
    signature_html: Option<&str>,
    direction: &str,
    reply_to_mailbox_message_id: Option<Uuid>,
    attachments: Vec<EmailAttachmentPayload>,
) -> Result<Uuid, EmailError> {
    let cfg = load_store_email_config(pool).await?;
    if !cfg.enabled {
        return Err(EmailError::NotConfigured);
    }
    let creds = load_email_credentials(pool)
        .await
        .ok_or(EmailError::NotConfigured)?;
    let to = clean_addr(to_email)
        .ok_or_else(|| EmailError::InvalidPayload("recipient email is invalid".to_string()))?;
    let subject = subject.trim();
    if subject.is_empty() {
        return Err(EmailError::InvalidPayload(
            "subject is required".to_string(),
        ));
    }
    let mut html = html_body.trim().to_string();
    if html.is_empty() {
        return Err(EmailError::InvalidPayload(
            "message body is required".to_string(),
        ));
    }
    if let Some(sig) = signature_html.map(str::trim).filter(|s| !s.is_empty()) {
        html.push_str("<br><br>");
        html.push_str(sig);
    }
    let from = parse_mailbox(&cfg.from_email, Some(&cfg.from_name))?;
    let reply_to = parse_mailbox(&cfg.reply_to_email, Some(&cfg.from_name))?;
    let to_box = parse_mailbox(&to, None)?;
    let outbound_message_id = generated_message_id(&cfg.from_email);
    let reply_context = if let Some(parent_id) = reply_to_mailbox_message_id {
        sqlx::query_as::<_, ReplyContextRow>(
            r#"
            SELECT message_id, thread_key, raw_headers
            FROM mailbox_messages
            WHERE id = $1
            "#,
        )
        .bind(parent_id)
        .fetch_optional(pool)
        .await?
    } else {
        None
    };

    let in_reply_to = reply_context
        .as_ref()
        .and_then(|ctx| ctx.message_id.as_deref())
        .and_then(canonical_message_id);
    let mut references = reply_context
        .as_ref()
        .map(|ctx| references_from_raw_headers(&ctx.raw_headers))
        .unwrap_or_default();
    if let Some(parent_message_id) = in_reply_to.as_ref() {
        if !references.iter().any(|value| value == parent_message_id) {
            references.push(parent_message_id.clone());
        }
    }
    let thread_key = reply_context
        .as_ref()
        .and_then(|ctx| ctx.thread_key.clone())
        .or_else(|| first_non_empty(&references))
        .unwrap_or_else(|| outbound_message_id.clone());

    let mut builder = Message::builder()
        .from(from)
        .reply_to(reply_to)
        .to(to_box)
        .subject(subject)
        .message_id(Some(outbound_message_id.clone()));
    if let Some(parent_message_id) = in_reply_to.as_ref() {
        builder = builder.in_reply_to(parent_message_id.clone());
    }
    if !references.is_empty() {
        builder = builder.references(references.join(" "));
    }
    let body_part = MultiPart::alternative()
        .singlepart(
            SinglePart::builder()
                .header(ContentType::TEXT_PLAIN)
                .body(mail_parser::decoders::html::html_to_text(&html)),
        )
        .singlepart(
            SinglePart::builder()
                .header(ContentType::TEXT_HTML)
                .body(html.clone()),
        );
    let message = if attachments.is_empty() {
        builder.multipart(body_part)
    } else {
        let mut mixed = MultiPart::mixed().multipart(body_part);
        for attachment in attachments {
            let filename = attachment.filename.trim();
            if filename.is_empty() || attachment.bytes.is_empty() {
                continue;
            }
            let content_type = ContentType::parse(&attachment.content_type)
                .unwrap_or_else(|_| ContentType::parse("application/octet-stream").unwrap());
            mixed = mixed.singlepart(
                Attachment::new(filename.to_string()).body(attachment.bytes, content_type),
            );
        }
        builder.multipart(mixed)
    }
    .map_err(|e| EmailError::Smtp(e.to_string()))?;

    let cfg_for_send = cfg.clone();
    tokio::task::spawn_blocking(move || {
        let builder = if cfg_for_send.smtp_tls == "starttls" {
            SmtpTransport::starttls_relay(&cfg_for_send.smtp_host)
        } else {
            SmtpTransport::relay(&cfg_for_send.smtp_host)
        }
        .map_err(|e| EmailError::Smtp(e.to_string()))?;
        let mailer = builder
            .port(cfg_for_send.smtp_port)
            .credentials(Credentials::new(creds.smtp_username, creds.smtp_password))
            .build();
        mailer
            .send(&message)
            .map_err(|e| EmailError::Smtp(e.to_string()))
    })
    .await
    .map_err(|e| EmailError::Smtp(e.to_string()))??;

    let customer_id = match_customer_by_email(pool, Some(&to)).await?;
    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO mailbox_messages (
            message_id, thread_key, direction, subject, from_email, from_name, to_emails,
            body_html, sent_at, customer_id, staff_id, status, raw_headers
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10, 'sent', $11)
        RETURNING id
        "#,
    )
    .bind(&outbound_message_id)
    .bind(&thread_key)
    .bind(direction)
    .bind(subject)
    .bind(clean_addr(&cfg.from_email))
    .bind(&cfg.from_name)
    .bind(json!([to]))
    .bind(&html)
    .bind(customer_id)
    .bind(staff_id)
    .bind(json!({
        "message_id": outbound_message_id,
        "in_reply_to": in_reply_to,
        "references": references
    }))
    .fetch_one(pool)
    .await?;

    if let Some(customer_id) = customer_id {
        let _ = record_customer_email_message(
            pool,
            customer_id,
            CustomerEmailMessage {
                direction,
                subject: Some(subject),
                body_text: None,
                body_html: Some(&html),
                staff_id,
                to_email: Some(&to),
            },
        )
        .await;
    }

    Ok(id)
}

#[derive(sqlx::FromRow)]
struct ReplyContextRow {
    message_id: Option<String>,
    thread_key: Option<String>,
    raw_headers: Value,
}

fn references_from_raw_headers(raw_headers: &Value) -> Vec<String> {
    raw_headers
        .get("references")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .filter_map(canonical_message_id)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub async fn try_send_operational_email(
    pool: &PgPool,
    to_email: &str,
    subject: String,
    html_body: String,
    customer_id: Option<Uuid>,
) {
    match send_email(
        pool,
        to_email,
        &subject,
        &html_body,
        None,
        None,
        "automated",
    )
    .await
    {
        Ok(_) => {}
        Err(error) => tracing::warn!(
            target = "email",
            event = "send_failed",
            error = %error,
            customer_id = ?customer_id,
            "Automated email send failed"
        ),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MailboxSyncResult {
    pub fetched: usize,
    pub inserted: usize,
    pub matched_customers: usize,
}

pub async fn sync_inbox(pool: &PgPool) -> Result<MailboxSyncResult, EmailError> {
    let cfg = load_store_email_config(pool).await?;
    if !cfg.enabled || !cfg.sync_enabled {
        return Err(EmailError::NotConfigured);
    }
    let creds = load_email_credentials(pool)
        .await
        .ok_or(EmailError::NotConfigured)?;
    let cfg_for_sync = cfg.clone();
    let raw_messages =
        tokio::task::spawn_blocking(move || fetch_imap_messages(cfg_for_sync, creds))
            .await
            .map_err(|e| EmailError::Imap(e.to_string()))??;

    let mut inserted = 0usize;
    let mut matched = 0usize;
    let fetched = raw_messages.len();
    for raw in raw_messages {
        let outcome = insert_inbound_message(pool, raw).await?;
        if outcome.inserted {
            inserted += 1;
        }
        if outcome.matched_customer {
            matched += 1;
        }
    }
    Ok(MailboxSyncResult {
        fetched,
        inserted,
        matched_customers: matched,
    })
}

pub async fn notify_new_mail(
    pool: &PgPool,
    summary: &MailboxSyncResult,
) -> Result<(), sqlx::Error> {
    if summary.inserted == 0 {
        return Ok(());
    }

    let staff_ids = notifications::staff_ids_with_permission(pool, CUSTOMERS_HUB_VIEW).await?;
    if staff_ids.is_empty() {
        return Ok(());
    }

    let title = if summary.inserted == 1 {
        "New store email".to_string()
    } else {
        format!("{} new store emails", summary.inserted)
    };
    let body = if summary.matched_customers > 0 {
        format!(
            "{} matched to customer records. Review the mailbox for staff follow-up.",
            summary.matched_customers
        )
    } else {
        "Review the mailbox for staff follow-up.".to_string()
    };
    let notification_id = notifications::upsert_app_notification_by_dedupe(
        pool,
        "store_email_inbound",
        &title,
        &body,
        json!({
            "type": "home",
            "subsection": "mailbox"
        }),
        "mailbox_sync",
        json!({
            "permission": CUSTOMERS_HUB_VIEW
        }),
        "store-email-inbound-unread",
    )
    .await?;
    notifications::fan_out_notification_to_staff_ids(pool, notification_id, &staff_ids).await
}

pub async fn update_mailbox_message_state(
    pool: &PgPool,
    id: Uuid,
    folder: Option<&str>,
    status: Option<&str>,
) -> Result<MailboxMessageRow, EmailError> {
    let folder = folder
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_uppercase());
    if let Some(ref value) = folder {
        if !matches!(
            value.as_str(),
            "INBOX" | "IMPORTANT" | "FOLLOW_UP" | "ARCHIVED"
        ) {
            return Err(EmailError::InvalidPayload(
                "Unsupported mailbox folder.".to_string(),
            ));
        }
    }

    let status = status
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase());
    if let Some(ref value) = status {
        if !matches!(
            value.as_str(),
            "received" | "sent" | "draft" | "failed" | "archived"
        ) {
            return Err(EmailError::InvalidPayload(
                "Unsupported mailbox status.".to_string(),
            ));
        }
    }

    let row = sqlx::query_as::<_, MailboxMessageDbRow>(
        r#"
        WITH updated AS (
            UPDATE mailbox_messages
            SET
                folder = COALESCE($2, folder),
                status = COALESCE($3, status),
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
        )
        SELECT
            m.id,
            m.message_id,
            m.thread_key,
            m.direction,
            m.subject,
            m.from_email,
            m.from_name,
            m.to_emails,
            m.cc_emails,
            m.body_text,
            m.body_html,
            m.received_at,
            m.sent_at,
            m.customer_id,
            c.customer_code,
            NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS customer_name,
            m.staff_id,
            s.full_name AS staff_full_name,
            m.folder,
            m.status
        FROM updated m
        LEFT JOIN customers c ON c.id = m.customer_id
        LEFT JOIN staff s ON s.id = m.staff_id
        "#,
    )
    .bind(id)
    .bind(folder.as_deref())
    .bind(status.as_deref())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| EmailError::InvalidPayload("Mailbox message not found.".to_string()))?;
    Ok(row.into_public())
}

struct RawInboundMessage {
    provider_uid: String,
    bytes: Vec<u8>,
}

struct InsertInboundOutcome {
    inserted: bool,
    matched_customer: bool,
}

fn fetch_imap_messages(
    cfg: StoreEmailConfig,
    creds: EmailCredentials,
) -> Result<Vec<RawInboundMessage>, EmailError> {
    let tls = TlsConnector::builder()
        .build()
        .map_err(|e| EmailError::Imap(e.to_string()))?;
    let client = imap::connect(
        (cfg.imap_host.as_str(), cfg.imap_port),
        cfg.imap_host.as_str(),
        &tls,
    )
    .map_err(|e| EmailError::Imap(e.to_string()))?;
    let mut session = client
        .login(creds.imap_username, creds.imap_password)
        .map_err(|e| EmailError::Imap(e.0.to_string()))?;
    session
        .select(cfg.imap_folder.as_str())
        .map_err(|e| EmailError::Imap(e.to_string()))?;
    let mailbox = session
        .uid_search("ALL")
        .map_err(|e| EmailError::Imap(e.to_string()))?;
    let mut uids: Vec<u32> = mailbox.into_iter().collect();
    uids.sort_unstable();
    uids.reverse();
    uids.truncate(cfg.sync_limit.clamp(1, 250) as usize);
    if uids.is_empty() {
        let _ = session.logout();
        return Ok(Vec::new());
    }
    let sequence = uids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let messages = session
        .uid_fetch(sequence, "RFC822")
        .map_err(|e| EmailError::Imap(e.to_string()))?;
    let mut out = Vec::new();
    for message in messages.iter() {
        if let (Some(uid), Some(body)) = (message.uid, message.body()) {
            out.push(RawInboundMessage {
                provider_uid: format!("imap:{uid}"),
                bytes: body.to_vec(),
            });
        }
    }
    let _ = session.logout();
    Ok(out)
}

async fn insert_inbound_message(
    pool: &PgPool,
    raw: RawInboundMessage,
) -> Result<InsertInboundOutcome, EmailError> {
    let Some(parsed) = MessageParser::new()
        .with_minimal_headers()
        .with_message_ids()
        .parse(&raw.bytes)
    else {
        return Ok(InsertInboundOutcome {
            inserted: false,
            matched_customer: false,
        });
    };
    let (from_email, from_name) = extract_first_address(parsed.from());
    let to_emails = extract_addresses(parsed.to());
    let cc_emails = extract_addresses(parsed.cc());
    let subject = parsed.subject().map(str::to_string);
    let body_text = parsed.body_text(0).map(|c| c.into_owned());
    let body_html = parsed.body_html(0).map(|c| c.into_owned());
    let message_id = parsed.message_id().and_then(canonical_message_id);
    let in_reply_to = parsed_header_ids(&parsed, HeaderName::InReplyTo);
    let references = header_id_values(parsed.references());
    let thread_key = thread_key_for(message_id.as_ref(), &in_reply_to, &references);
    let received_at = parsed.date().and_then(|date| {
        chrono::DateTime::parse_from_rfc3339(&date.to_rfc3339())
            .ok()
            .map(|dt| dt.with_timezone(&Utc))
    });
    let customer_id = match_customer_by_email(pool, from_email.as_deref()).await?;

    let inserted: Option<Uuid> = sqlx::query_scalar(
        r#"
        INSERT INTO mailbox_messages (
            provider_uid, message_id, thread_key, direction, subject, from_email, from_name,
            to_emails, cc_emails, body_text, body_html, received_at, customer_id, status,
            raw_headers
        )
        VALUES ($1, $2, $3, 'inbound', $4, $5, $6, $7, $8, $9, $10, COALESCE($11, NOW()), $12, 'received', $13)
        ON CONFLICT (provider_uid) WHERE provider_uid IS NOT NULL DO NOTHING
        RETURNING id
        "#,
    )
    .bind(&raw.provider_uid)
    .bind(&message_id)
    .bind(&thread_key)
    .bind(&subject)
    .bind(&from_email)
    .bind(&from_name)
    .bind(json!(to_emails))
    .bind(json!(cc_emails))
    .bind(&body_text)
    .bind(&body_html)
    .bind(received_at)
    .bind(customer_id)
    .bind(json!({
        "message_id": message_id,
        "in_reply_to": in_reply_to,
        "references": references
    }))
    .fetch_optional(pool)
    .await?;

    if inserted.is_some() {
        if let Some(customer_id) = customer_id {
            let _ = record_inbound_customer_message(
                pool,
                customer_id,
                subject.as_deref(),
                body_text.as_deref(),
                body_html.as_deref(),
                from_email.as_deref(),
            )
            .await;
        }
        return Ok(InsertInboundOutcome {
            inserted: true,
            matched_customer: customer_id.is_some(),
        });
    }
    Ok(InsertInboundOutcome {
        inserted: false,
        matched_customer: false,
    })
}

pub async fn list_mailbox_messages(
    pool: &PgPool,
    customer_id: Option<Uuid>,
    unmatched_only: bool,
    limit: i64,
) -> Result<Vec<MailboxMessageRow>, EmailError> {
    let limit = limit.clamp(1, 200);
    let rows = sqlx::query_as::<_, MailboxMessageDbRow>(
        r#"
        SELECT
            m.id,
            m.message_id,
            m.thread_key,
            m.direction,
            m.subject,
            m.from_email,
            m.from_name,
            m.to_emails,
            m.cc_emails,
            m.body_text,
            m.body_html,
            m.received_at,
            m.sent_at,
            m.customer_id,
            c.customer_code,
            NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS customer_name,
            m.staff_id,
            s.full_name AS staff_full_name,
            m.folder,
            m.status
        FROM mailbox_messages m
        LEFT JOIN customers c ON c.id = m.customer_id
        LEFT JOIN staff s ON s.id = m.staff_id
        WHERE ($1::uuid IS NULL OR m.customer_id = $1)
          AND ($2::bool = false OR m.customer_id IS NULL)
        ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at) DESC
        LIMIT $3
        "#,
    )
    .bind(customer_id)
    .bind(unmatched_only)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| MailboxMessageRow {
            id: r.id,
            message_id: r.message_id,
            thread_key: r.thread_key,
            direction: r.direction,
            subject: r.subject,
            from_email: r.from_email,
            from_name: r.from_name,
            to_emails: r.to_emails,
            cc_emails: r.cc_emails,
            body_text: r.body_text,
            body_html: r.body_html,
            received_at: r.received_at,
            sent_at: r.sent_at,
            customer_id: r.customer_id,
            customer_code: r.customer_code,
            customer_name: r.customer_name,
            staff_id: r.staff_id,
            staff_full_name: r.staff_full_name,
            folder: r.folder,
            status: r.status,
        })
        .collect())
}

#[derive(sqlx::FromRow)]
struct MailboxMessageDbRow {
    id: Uuid,
    message_id: Option<String>,
    thread_key: Option<String>,
    direction: String,
    subject: Option<String>,
    from_email: Option<String>,
    from_name: Option<String>,
    to_emails: Value,
    cc_emails: Value,
    body_text: Option<String>,
    body_html: Option<String>,
    received_at: Option<DateTime<Utc>>,
    sent_at: Option<DateTime<Utc>>,
    customer_id: Option<Uuid>,
    customer_code: Option<String>,
    customer_name: Option<String>,
    staff_id: Option<Uuid>,
    staff_full_name: Option<String>,
    folder: String,
    status: String,
}

impl MailboxMessageDbRow {
    fn into_public(self) -> MailboxMessageRow {
        MailboxMessageRow {
            id: self.id,
            message_id: self.message_id,
            thread_key: self.thread_key,
            direction: self.direction,
            subject: self.subject,
            from_email: self.from_email,
            from_name: self.from_name,
            to_emails: self.to_emails,
            cc_emails: self.cc_emails,
            body_text: self.body_text,
            body_html: self.body_html,
            received_at: self.received_at,
            sent_at: self.sent_at,
            customer_id: self.customer_id,
            customer_code: self.customer_code,
            customer_name: self.customer_name,
            staff_id: self.staff_id,
            staff_full_name: self.staff_full_name,
            folder: self.folder,
            status: self.status,
        }
    }
}
