//! Podium API: OAuth refresh-token flow and outbound SMS via `POST /v4/messages`.
//! Operator setup: https://docs.podium.com/docs/getting-started
//! Send payload shape: https://github.com/podium/podium-api-sample-messages

use chrono::{DateTime, Duration, Utc};
use reqwest::{RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration as StdDuration;
use thiserror::Error;
use tokio::sync::Mutex;
use uuid::Uuid;

const PODIUM_MAX_RETRIES: u32 = 3;
const PODIUM_BASE_RETRY_DELAY_MS: u64 = 500;
const PODIUM_MAX_ATTACHMENT_BYTES: usize = 30 * 1024 * 1024;

pub const PODIUM_REQUIRED_WEBHOOK_EVENT_TYPES: &[&str] = &[
    "message.failed",
    "message.received",
    "message.sent",
    "call.completed",
    "call.missed",
    "call.received",
    "call.voicemail_left",
    "contact.created",
    "contact.deleted",
    "contact.merged",
    "contact.unchanged",
    "contact.updated",
    "review.created",
    "review.invite_link_created",
    "review.invite_link_updated",
    "review.response_created",
    "review.response_updated",
    "review.updated",
];

fn podium_retry_delay(attempt: u32) -> StdDuration {
    StdDuration::from_millis(PODIUM_BASE_RETRY_DELAY_MS * 2_u64.pow(attempt))
}

#[derive(Debug, Clone, Copy)]
enum PodiumRequestSafety {
    SafeRead,
    Mutation,
}

#[derive(Debug, Clone, Copy)]
enum PodiumHttpErrorKind {
    General,
    ReviewInvite,
}

fn podium_http_error(
    kind: PodiumHttpErrorKind,
    status: StatusCode,
    detail: Option<String>,
) -> PodiumError {
    match (kind, detail) {
        (PodiumHttpErrorKind::General, Some(detail)) => PodiumError::SendHttpDetail {
            status: status.as_u16(),
            detail,
        },
        (PodiumHttpErrorKind::ReviewInvite, Some(detail)) => PodiumError::ReviewInviteHttpDetail {
            status: status.as_u16(),
            detail,
        },
        (PodiumHttpErrorKind::General, None) => PodiumError::SendHttp(status.as_u16()),
        (PodiumHttpErrorKind::ReviewInvite, None) => PodiumError::ReviewInviteHttp(status.as_u16()),
    }
}

fn podium_retry_after(response: &Response, attempt: u32) -> StdDuration {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| StdDuration::from_secs(seconds.clamp(1, 60)))
        .unwrap_or_else(|| podium_retry_delay(attempt))
}

fn podium_error_detail(body: &str) -> Option<String> {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .or_else(|| value.get("error"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            let trimmed = body.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })?;
    let normalized = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    (!normalized.is_empty()).then(|| normalized.chars().take(500).collect())
}

use crate::logic::integration_credentials;
use crate::logic::podium_messaging;

const DEFAULT_READY_PICKUP: &str =
    "Hi {first_name}, your Riverside order {transaction_ref} is ready for pickup. We look forward to seeing you.";
const DEFAULT_ALTERATION_READY: &str =
    "Hi {first_name}, your alteration {alteration_ref} is ready for your final fitting or pickup.";
const DEFAULT_UNKNOWN_SENDER_WELCOME: &str =
    "Hi from Riverside! We've saved your contact info. Reply here for questions about your order.";
const DEFAULT_APPOINTMENT_CONFIRMATION_SMS: &str =
    "Hi {first_name}, your Riverside {appointment_type} appointment is set for {starts_at}. Calendar invite attached.";
const DEFAULT_APPOINTMENT_REMINDER_SMS: &str =
    "Hi {first_name}, reminder: your Riverside {appointment_type} appointment is tomorrow at {starts_at}.";

const DEFAULT_EMAIL_READY_SUBJECT: &str = "Your Riverside order is ready";
const DEFAULT_EMAIL_READY_HTML: &str = "<p>Hi {first_name},</p><p>Your Riverside order <b>{transaction_ref}</b> is ready for pickup.</p><p>Questions? Call {store_phone}.</p>";
const DEFAULT_EMAIL_ALTERATION_SUBJECT: &str = "Your alteration is ready";
const DEFAULT_EMAIL_ALTERATION_HTML: &str = "<p>Hi {first_name},</p><p>Your alteration <b>{alteration_ref}</b> is ready for your final fitting or pickup.</p><p>Questions? Call {store_phone}.</p>";
const DEFAULT_EMAIL_APPOINTMENT_SUBJECT: &str = "Appointment confirmed — Riverside";
const DEFAULT_EMAIL_APPOINTMENT_HTML: &str = "<p>Hi {first_name},</p><p>Your <b>{appointment_type}</b> appointment is scheduled for <b>{starts_at}</b>.</p>{notes_block}";
const DEFAULT_EMAIL_APPOINTMENT_REMINDER_SUBJECT: &str =
    "Reminder: your Riverside appointment is tomorrow";
const DEFAULT_EMAIL_APPOINTMENT_REMINDER_HTML: &str = "<p>Hi {first_name},</p><p>This is a reminder that your <b>{appointment_type}</b> appointment is tomorrow at <b>{starts_at}</b>.</p><p>Questions? Call {store_phone}.</p>";
const DEFAULT_REVIEW_SMS_BODY: &str = "Hi {first_name}, thank you for choosing {store_name}. We would appreciate your review: {review_url}";
const DEFAULT_REVIEW_EMAIL_SUBJECT: &str = "How was your Riverside experience?";
const DEFAULT_REVIEW_EMAIL_BODY: &str = "Hi {first_name},\n\nThank you for choosing {store_name}. We would appreciate your feedback. Share your review here: {review_url}\n\nThank you,\n{store_name}";
const DEFAULT_RECEIPT_SMS_CAPTION: &str = "{store_name} — Receipt {receipt_ref} (image attached).";
const DEFAULT_GIFT_RECEIPT_SMS_CAPTION: &str =
    "{store_name} — Gift receipt {receipt_ref} (image attached).";
const DEFAULT_RECEIPT_EMAIL_SUBJECT: &str = "Receipt — {receipt_ref}";
const DEFAULT_GIFT_RECEIPT_EMAIL_SUBJECT: &str = "Gift receipt — {receipt_ref}";
const DEFAULT_PODIUM_API_VERSION: &str = "2021.04.01";
const PODIUM_CREDENTIAL_KEYS: &[&str] = &[
    "client_id",
    "client_secret",
    "refresh_token",
    "oauth_token_url",
    "api_base_url",
];

/// In-memory access token (refresh via env-backed OAuth).
#[derive(Debug, Default, Clone)]
pub struct PodiumTokenCache {
    access_token: Option<String>,
    expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SmsTemplatesStored {
    #[serde(default)]
    pub ready_for_pickup: String,
    #[serde(default)]
    pub alteration_ready: String,
    #[serde(default)]
    pub unknown_sender_welcome: String,
    #[serde(default)]
    pub appointment_confirmation: String,
    #[serde(default)]
    pub appointment_reminder: String,
}

impl SmsTemplatesStored {
    pub fn merged_defaults(&self) -> Self {
        Self {
            ready_for_pickup: non_empty_or(&self.ready_for_pickup, DEFAULT_READY_PICKUP),
            alteration_ready: non_empty_or(&self.alteration_ready, DEFAULT_ALTERATION_READY),
            unknown_sender_welcome: non_empty_or(
                &self.unknown_sender_welcome,
                DEFAULT_UNKNOWN_SENDER_WELCOME,
            ),
            appointment_confirmation: non_empty_or(
                &self.appointment_confirmation,
                DEFAULT_APPOINTMENT_CONFIRMATION_SMS,
            ),
            appointment_reminder: non_empty_or(
                &self.appointment_reminder,
                DEFAULT_APPOINTMENT_REMINDER_SMS,
            ),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EmailTemplatesStored {
    #[serde(default)]
    pub ready_for_pickup_subject: String,
    #[serde(default)]
    pub ready_for_pickup_html: String,
    #[serde(default)]
    pub alteration_ready_subject: String,
    #[serde(default)]
    pub alteration_ready_html: String,
    #[serde(default)]
    pub appointment_confirmation_subject: String,
    #[serde(default)]
    pub appointment_confirmation_html: String,
    #[serde(default)]
    pub appointment_reminder_subject: String,
    #[serde(default)]
    pub appointment_reminder_html: String,
}

impl EmailTemplatesStored {
    pub fn merged_defaults(&self) -> Self {
        Self {
            ready_for_pickup_subject: non_empty_or(
                &self.ready_for_pickup_subject,
                DEFAULT_EMAIL_READY_SUBJECT,
            ),
            ready_for_pickup_html: non_empty_or(
                &self.ready_for_pickup_html,
                DEFAULT_EMAIL_READY_HTML,
            ),
            alteration_ready_subject: non_empty_or(
                &self.alteration_ready_subject,
                DEFAULT_EMAIL_ALTERATION_SUBJECT,
            ),
            alteration_ready_html: non_empty_or(
                &self.alteration_ready_html,
                DEFAULT_EMAIL_ALTERATION_HTML,
            ),
            appointment_confirmation_subject: non_empty_or(
                &self.appointment_confirmation_subject,
                DEFAULT_EMAIL_APPOINTMENT_SUBJECT,
            ),
            appointment_confirmation_html: non_empty_or(
                &self.appointment_confirmation_html,
                DEFAULT_EMAIL_APPOINTMENT_HTML,
            ),
            appointment_reminder_subject: non_empty_or(
                &self.appointment_reminder_subject,
                DEFAULT_EMAIL_APPOINTMENT_REMINDER_SUBJECT,
            ),
            appointment_reminder_html: non_empty_or(
                &self.appointment_reminder_html,
                DEFAULT_EMAIL_APPOINTMENT_REMINDER_HTML,
            ),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReviewMessageTemplatesStored {
    #[serde(default)]
    pub sms_body: String,
    #[serde(default)]
    pub email_subject: String,
    #[serde(default)]
    pub email_body: String,
}

impl ReviewMessageTemplatesStored {
    pub fn merged_defaults(&self) -> Self {
        Self {
            sms_body: non_empty_or(&self.sms_body, DEFAULT_REVIEW_SMS_BODY),
            email_subject: non_empty_or(&self.email_subject, DEFAULT_REVIEW_EMAIL_SUBJECT),
            email_body: non_empty_or(&self.email_body, DEFAULT_REVIEW_EMAIL_BODY),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReceiptMessageTemplatesStored {
    #[serde(default)]
    pub sms_caption: String,
    #[serde(default)]
    pub gift_sms_caption: String,
    #[serde(default)]
    pub email_subject: String,
    #[serde(default)]
    pub gift_email_subject: String,
}

impl ReceiptMessageTemplatesStored {
    pub fn merged_defaults(&self) -> Self {
        Self {
            sms_caption: non_empty_or(&self.sms_caption, DEFAULT_RECEIPT_SMS_CAPTION),
            gift_sms_caption: non_empty_or(
                &self.gift_sms_caption,
                DEFAULT_GIFT_RECEIPT_SMS_CAPTION,
            ),
            email_subject: non_empty_or(&self.email_subject, DEFAULT_RECEIPT_EMAIL_SUBJECT),
            gift_email_subject: non_empty_or(
                &self.gift_email_subject,
                DEFAULT_GIFT_RECEIPT_EMAIL_SUBJECT,
            ),
        }
    }
}

fn non_empty_or(s: &str, fallback: &'static str) -> String {
    let t = s.trim();
    if t.is_empty() {
        fallback.to_string()
    } else {
        t.to_string()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PodiumSmsFeatureSettings {
    #[serde(default)]
    pub staff_messages: bool,
    #[serde(default)]
    pub receipts: bool,
    #[serde(default)]
    pub ready_for_pickup: bool,
    #[serde(default)]
    pub alteration_ready: bool,
    #[serde(default)]
    pub appointment_confirmation: bool,
    #[serde(default)]
    pub appointment_reminder: bool,
    #[serde(default)]
    pub unknown_sender_welcome: bool,
}

impl PodiumSmsFeatureSettings {
    fn from_legacy(enabled: bool) -> Self {
        Self {
            staff_messages: enabled,
            receipts: enabled,
            ready_for_pickup: enabled,
            alteration_ready: enabled,
            appointment_confirmation: enabled,
            appointment_reminder: enabled,
            unknown_sender_welcome: enabled,
        }
    }

    pub fn any_enabled(&self) -> bool {
        self.staff_messages
            || self.receipts
            || self.ready_for_pickup
            || self.alteration_ready
            || self.appointment_confirmation
            || self.appointment_reminder
            || self.unknown_sender_welcome
    }

    pub fn is_enabled(&self, feature: PodiumSmsFeature) -> bool {
        match feature {
            PodiumSmsFeature::StaffMessages => self.staff_messages,
            PodiumSmsFeature::Receipts => self.receipts,
            PodiumSmsFeature::ReadyForPickup => self.ready_for_pickup,
            PodiumSmsFeature::AlterationReady => self.alteration_ready,
            PodiumSmsFeature::AppointmentConfirmation => self.appointment_confirmation,
            PodiumSmsFeature::AppointmentReminder => self.appointment_reminder,
            PodiumSmsFeature::UnknownSenderWelcome => self.unknown_sender_welcome,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum PodiumSmsFeature {
    StaffMessages,
    Receipts,
    ReadyForPickup,
    AlterationReady,
    AppointmentConfirmation,
    AppointmentReminder,
    UnknownSenderWelcome,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StorePodiumSmsConfig {
    /// Legacy aggregate retained in saved JSON and readiness responses. New code
    /// derives it from `sms_features` so each SMS workflow can be controlled alone.
    #[serde(default)]
    pub sms_send_enabled: bool,
    #[serde(default)]
    pub sms_features: PodiumSmsFeatureSettings,
    /// Legacy JSON field retained for older saved settings. General operational
    /// Podium email is disabled; review-request email uses its dedicated path.
    #[serde(default)]
    pub email_send_enabled: bool,
    #[serde(default)]
    pub location_uid: String,
    #[serde(default)]
    pub widget_embed_enabled: bool,
    #[serde(default)]
    pub widget_snippet_html: String,
    #[serde(default)]
    pub templates: SmsTemplatesStored,
    #[serde(default)]
    pub email_templates: EmailTemplatesStored,
    #[serde(default)]
    pub review_templates: ReviewMessageTemplatesStored,
    #[serde(default)]
    pub receipt_templates: ReceiptMessageTemplatesStored,
}

impl StorePodiumSmsConfig {
    pub fn load_from_json(v: serde_json::Value) -> Self {
        let has_feature_settings = v.get("sms_features").is_some();
        let legacy_enabled = v
            .get("sms_send_enabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let mut cfg: Self = serde_json::from_value(v).unwrap_or_default();
        if !has_feature_settings {
            cfg.sms_features = PodiumSmsFeatureSettings::from_legacy(legacy_enabled);
        }
        cfg.sms_send_enabled = cfg.sms_features.any_enabled();
        cfg.email_send_enabled = false;
        cfg
    }
}

#[derive(Debug, Serialize)]
pub struct PodiumSmsSettingsResponse {
    pub sms_send_enabled: bool,
    pub sms_features: PodiumSmsFeatureSettings,
    pub location_uid: String,
    pub widget_embed_enabled: bool,
    pub widget_snippet_html: String,
    pub templates: SmsTemplatesStored,
    pub templates_effective: SmsTemplatesStored,
    pub email_templates: EmailTemplatesStored,
    pub email_templates_effective: EmailTemplatesStored,
    pub review_templates: ReviewMessageTemplatesStored,
    pub review_templates_effective: ReviewMessageTemplatesStored,
    pub receipt_templates: ReceiptMessageTemplatesStored,
    pub receipt_templates_effective: ReceiptMessageTemplatesStored,
    pub credentials_configured: bool,
    pub oauth_authorize_url: &'static str,
    pub oauth_token_url_hint: &'static str,
}

#[derive(Debug, Error)]
pub enum PodiumError {
    #[error("podium not configured")]
    NotConfigured,
    #[error("podium token exchange failed: HTTP {0}")]
    TokenHttp(u16),
    #[error("podium token response missing access_token")]
    TokenMissing,
    #[error("podium token response missing refresh_token")]
    RefreshTokenMissing,
    #[error("podium send failed: HTTP {0}")]
    SendHttp(u16),
    #[error("podium send failed: HTTP {status}: {detail}")]
    SendHttpDetail { status: u16, detail: String },
    #[error("podium review invite failed: HTTP {0}")]
    ReviewInviteHttp(u16),
    #[error("podium review invite failed: HTTP {status}: {detail}")]
    ReviewInviteHttpDetail { status: u16, detail: String },
    #[error("podium rate limited the request; retry after {retry_after_seconds} seconds")]
    RateLimited { retry_after_seconds: u64 },
    #[error("reqwest error: {0}")]
    Http(#[from] reqwest::Error),
}

impl PodiumError {
    pub fn http_status(&self) -> Option<u16> {
        match self {
            Self::TokenHttp(status) | Self::SendHttp(status) | Self::ReviewInviteHttp(status) => {
                Some(*status)
            }
            Self::SendHttpDetail { status, .. } | Self::ReviewInviteHttpDetail { status, .. } => {
                Some(*status)
            }
            Self::RateLimited { .. } => Some(StatusCode::TOO_MANY_REQUESTS.as_u16()),
            Self::NotConfigured
            | Self::TokenMissing
            | Self::RefreshTokenMissing
            | Self::Http(_) => None,
        }
    }
}

/// OAuth **app** credentials (client id + secret). Used for token exchange; never logged.
#[derive(Debug, Clone)]
pub struct PodiumOAuthAppCredentials {
    pub client_id: String,
    pub client_secret: String,
    pub token_url: String,
}

impl PodiumOAuthAppCredentials {
    pub fn from_env() -> Option<Self> {
        let client_id = std::env::var("RIVERSIDE_PODIUM_CLIENT_ID")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())?;
        let client_secret = std::env::var("RIVERSIDE_PODIUM_CLIENT_SECRET")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())?;
        let token_url = std::env::var("RIVERSIDE_PODIUM_OAUTH_TOKEN_URL").unwrap_or_else(|_| {
            format!(
                "{}/oauth/token",
                podium_rest_api_base().trim_end_matches('/')
            )
        });
        Some(Self {
            client_id,
            client_secret,
            token_url,
        })
    }

    pub async fn load(pool: &PgPool) -> Option<Self> {
        let values = load_podium_credential_values(pool).await;
        let client_id = credential_value(&values, "client_id", "RIVERSIDE_PODIUM_CLIENT_ID")?;
        let client_secret =
            credential_value(&values, "client_secret", "RIVERSIDE_PODIUM_CLIENT_SECRET")?;
        let token_url = credential_value(
            &values,
            "oauth_token_url",
            "RIVERSIDE_PODIUM_OAUTH_TOKEN_URL",
        )
        .unwrap_or_else(|| {
            format!(
                "{}/oauth/token",
                podium_rest_api_base_from_values(&values).trim_end_matches('/')
            )
        });
        Some(Self {
            client_id,
            client_secret,
            token_url,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PodiumOAuthAppCredentialStatus {
    pub client_id_configured: bool,
    pub client_secret_configured: bool,
}

pub async fn podium_oauth_app_credential_status(pool: &PgPool) -> PodiumOAuthAppCredentialStatus {
    let values = load_podium_credential_values(pool).await;
    PodiumOAuthAppCredentialStatus {
        client_id_configured: credential_value(&values, "client_id", "RIVERSIDE_PODIUM_CLIENT_ID")
            .is_some(),
        client_secret_configured: credential_value(
            &values,
            "client_secret",
            "RIVERSIDE_PODIUM_CLIENT_SECRET",
        )
        .is_some(),
    }
}

pub async fn podium_oauth_client_id(pool: &PgPool) -> Option<String> {
    let values = load_podium_credential_values(pool).await;
    credential_value(&values, "client_id", "RIVERSIDE_PODIUM_CLIENT_ID")
}

/// OAuth client credentials from encrypted Settings credentials, falling back to env (never logged).
#[derive(Debug, Clone)]
pub struct PodiumEnvCredentials {
    pub client_id: String,
    pub client_secret: String,
    pub refresh_token: String,
    pub token_url: String,
    pub api_base_url: String,
}

impl PodiumEnvCredentials {
    pub fn from_env() -> Option<Self> {
        let app = PodiumOAuthAppCredentials::from_env()?;
        let refresh_token = std::env::var("RIVERSIDE_PODIUM_REFRESH_TOKEN")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())?;
        Some(Self {
            client_id: app.client_id,
            client_secret: app.client_secret,
            refresh_token,
            token_url: app.token_url,
            api_base_url: podium_rest_api_base(),
        })
    }

    pub async fn load(pool: &PgPool) -> Option<Self> {
        let values = load_podium_credential_values(pool).await;
        let app = PodiumOAuthAppCredentials::load(pool).await?;
        let refresh_token =
            credential_value(&values, "refresh_token", "RIVERSIDE_PODIUM_REFRESH_TOKEN")?;
        Some(Self {
            client_id: app.client_id,
            client_secret: app.client_secret,
            refresh_token,
            token_url: app.token_url,
            api_base_url: podium_rest_api_base_from_values(&values),
        })
    }
}

async fn load_podium_credential_values(pool: &PgPool) -> HashMap<String, String> {
    match integration_credentials::load_integration_credentials(
        pool,
        "podium",
        PODIUM_CREDENTIAL_KEYS,
    )
    .await
    {
        Ok(values) => values,
        Err(error) => {
            tracing::warn!(
                target = "podium",
                event = "credential_load_failed",
                error = %error,
                "Falling back to Podium environment credentials"
            );
            HashMap::new()
        }
    }
}

fn credential_value(
    values: &HashMap<String, String>,
    credential_key: &str,
    env_key: &str,
) -> Option<String> {
    values
        .get(credential_key)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var(env_key)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
}

/// Restrict `redirect_uri` for authorization-code helpers (open-redirect hardening).
/// Allows **`https://`** (production) and loopback **`http://localhost` / `http://127.0.0.1`** for local dev.
/// Podium’s dashboard may still require HTTPS for non-loopback; use **`VITE_PODIUM_OAUTH_REDIRECT_URI`** when needed.
pub fn validate_podium_oauth_redirect_uri(redirect_uri: &str) -> bool {
    let s = redirect_uri.trim();
    if s.is_empty() || s.chars().any(|c| c.is_control()) {
        return false;
    }
    let lower = s.to_ascii_lowercase();
    let path_is_callback = |after_scheme: &str| -> bool {
        let idx = match after_scheme.find('/') {
            Some(i) => i,
            None => return false,
        };
        let path_and_query = &after_scheme[idx..];
        let path_only = path_and_query.split('?').next().unwrap_or(path_and_query);
        path_only == "/callback"
    };

    if let Some(after) = lower.strip_prefix("http://") {
        let host_ok = after.starts_with("localhost:")
            || after.starts_with("localhost/")
            || after.starts_with("127.0.0.1:")
            || after.starts_with("127.0.0.1/");
        return host_ok && path_is_callback(after);
    }
    let Some(after) = lower.strip_prefix("https://") else {
        return false;
    };
    let auth_end = after.find('/').unwrap_or(after.len());
    let authority = &after[..auth_end];
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    path_is_callback(after)
}

/// CSRF `state` for `/oauth/authorize` (alphanumeric, `-`, `_`).
pub fn validate_podium_oauth_state(state: &str) -> bool {
    let t = state.trim();
    !t.is_empty()
        && t.len() <= 200
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Builds Podium authorize URL (same REST base as `RIVERSIDE_PODIUM_API_BASE`).
pub fn build_podium_oauth_authorize_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    scope: Option<&str>,
) -> String {
    build_podium_oauth_authorize_url_for_base(
        &podium_rest_api_base(),
        client_id,
        redirect_uri,
        state,
        scope,
    )
}

pub fn build_podium_oauth_authorize_url_for_base(
    base_url: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    scope: Option<&str>,
) -> String {
    let base = format!("{}/oauth/authorize", base_url.trim_end_matches('/'));
    let mut url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&state={}",
        base,
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(state),
    );
    if let Some(sc) = scope {
        let t = sc.trim();
        if !t.is_empty() {
            url.push_str("&scope=");
            url.push_str(&urlencoding::encode(t));
        }
    }
    url
}

#[derive(Debug, Clone)]
pub struct PodiumAuthCodeExchangeResult {
    pub refresh_token: String,
    pub expires_in: Option<i64>,
}

/// Exchange an authorization code for tokens (Podium: `POST` JSON to `/oauth/token`).
pub async fn exchange_podium_oauth_authorization_code(
    http: &reqwest::Client,
    creds: &PodiumOAuthAppCredentials,
    code: &str,
    redirect_uri: &str,
) -> Result<PodiumAuthCodeExchangeResult, PodiumError> {
    let res = add_podium_headers(http.post(&creds.token_url), None)
        .header("Content-Type", "application/json")
        .json(&json!({
            "grant_type": "authorization_code",
            "code": code.trim(),
            "redirect_uri": redirect_uri.trim(),
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
        }))
        .send()
        .await?;

    if !res.status().is_success() {
        return Err(PodiumError::TokenHttp(res.status().as_u16()));
    }

    let tr: AuthCodeTokenResponse = res.json().await?;
    let refresh = tr
        .refresh_token
        .filter(|s| !s.trim().is_empty())
        .ok_or(PodiumError::RefreshTokenMissing)?;

    Ok(PodiumAuthCodeExchangeResult {
        refresh_token: refresh,
        expires_in: tr.expires_in,
    })
}

/// REST API origin for Podium (`/v4/messages`, `/v4/locations`, etc.). Override in tests via `RIVERSIDE_PODIUM_API_BASE` (no trailing slash).
pub fn podium_rest_api_base() -> String {
    std::env::var("RIVERSIDE_PODIUM_API_BASE")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.podium.com".to_string())
}

pub fn validate_podium_service_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|_| "Podium endpoint must be a valid URL.".to_string())?;
    let host = parsed
        .host_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "Podium endpoint must include a host.".to_string())?;
    let is_loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1");
    let is_podium_host = host == "podium.com" || host.ends_with(".podium.com");
    let scheme_allowed = parsed.scheme() == "https" || (parsed.scheme() == "http" && is_loopback);
    if !scheme_allowed {
        return Err(
            "Podium endpoints must use HTTPS; HTTP is allowed only for loopback development."
                .to_string(),
        );
    }
    if !is_podium_host && !is_loopback {
        return Err("Podium endpoints must use an official podium.com host.".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Podium endpoints must not include embedded credentials.".to_string());
    }
    Ok(trimmed.to_string())
}

fn podium_rest_api_base_from_values(values: &HashMap<String, String>) -> String {
    values
        .get("api_base_url")
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var("RIVERSIDE_PODIUM_API_BASE")
                .ok()
                .map(|s| s.trim().trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "https://api.podium.com".to_string())
}

pub async fn podium_effective_rest_api_base(pool: &PgPool) -> String {
    podium_rest_api_base_from_values(&load_podium_credential_values(pool).await)
}

pub fn podium_api_version() -> String {
    std::env::var("RIVERSIDE_PODIUM_API_VERSION")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_PODIUM_API_VERSION.to_string())
}

fn add_podium_headers(
    builder: reqwest::RequestBuilder,
    token: Option<&str>,
) -> reqwest::RequestBuilder {
    let builder = builder.header("podium-version", podium_api_version());
    if let Some(token) = token {
        builder.header("Authorization", format!("Bearer {token}"))
    } else {
        builder
    }
}

pub(crate) async fn invalidate_podium_access_token(token_cache: &Arc<Mutex<PodiumTokenCache>>) {
    let mut cache = token_cache.lock().await;
    cache.access_token = None;
    cache.expires_at = None;
}

async fn send_authenticated_podium_request<F>(
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    creds: &PodiumEnvCredentials,
    safety: PodiumRequestSafety,
    error_kind: PodiumHttpErrorKind,
    allowed_statuses: &[StatusCode],
    mut build: F,
) -> Result<Response, PodiumError>
where
    F: FnMut(&str) -> RequestBuilder,
{
    let mut refreshed_after_unauthorized = false;
    for attempt in 0..=PODIUM_MAX_RETRIES {
        let token = get_valid_access_token(http, token_cache, creds).await?;
        let response = match build(&token).send().await {
            Ok(response) => response,
            Err(error) => {
                let retry_safe_read = matches!(safety, PodiumRequestSafety::SafeRead)
                    && (error.is_timeout() || error.is_connect())
                    && attempt < PODIUM_MAX_RETRIES;
                if retry_safe_read {
                    tokio::time::sleep(podium_retry_delay(attempt)).await;
                    continue;
                }
                return Err(PodiumError::Http(error));
            }
        };
        let status = response.status();
        if status.is_success() || allowed_statuses.contains(&status) {
            return Ok(response);
        }
        if status == StatusCode::UNAUTHORIZED
            && !refreshed_after_unauthorized
            && attempt < PODIUM_MAX_RETRIES
        {
            refreshed_after_unauthorized = true;
            invalidate_podium_access_token(token_cache).await;
            continue;
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            let retry_after = podium_retry_after(&response, attempt);
            if attempt < PODIUM_MAX_RETRIES {
                tokio::time::sleep(retry_after).await;
                continue;
            }
            return Err(PodiumError::RateLimited {
                retry_after_seconds: retry_after.as_secs().max(1),
            });
        }
        if status.is_server_error()
            && matches!(safety, PodiumRequestSafety::SafeRead)
            && attempt < PODIUM_MAX_RETRIES
        {
            tokio::time::sleep(podium_retry_delay(attempt)).await;
            continue;
        }
        let detail = response
            .text()
            .await
            .ok()
            .and_then(|body| podium_error_detail(&body));
        return Err(podium_http_error(error_kind, status, detail));
    }
    Err(match error_kind {
        PodiumHttpErrorKind::General => PodiumError::SendHttp(0),
        PodiumHttpErrorKind::ReviewInvite => PodiumError::ReviewInviteHttp(0),
    })
}

fn podium_messages_url(base_url: &str) -> String {
    format!("{}/v4/messages", base_url.trim_end_matches('/'))
}

fn podium_messages_attachment_url(base_url: &str) -> String {
    format!("{}/v4/messages/attachment", base_url.trim_end_matches('/'))
}

fn podium_review_invites_url(base_url: &str) -> String {
    format!("{}/v4/reviews/invites", base_url.trim_end_matches('/'))
}

fn podium_conversations_url(base_url: &str) -> String {
    format!("{}/v4/conversations", base_url.trim_end_matches('/'))
}

fn podium_contacts_url(base_url: &str) -> String {
    format!("{}/v4/contacts", base_url.trim_end_matches('/'))
}

fn podium_locations_url(base_url: &str) -> String {
    format!("{}/v4/locations", base_url.trim_end_matches('/'))
}

fn podium_webhooks_url(base_url: &str) -> String {
    format!("{}/v4/webhooks", base_url.trim_end_matches('/'))
}

fn podium_webhook_url(base_url: &str, webhook_uid: &str) -> String {
    format!(
        "{}/v4/webhooks/{}",
        base_url.trim_end_matches('/'),
        urlencoding::encode(webhook_uid)
    )
}

fn podium_contact_url(base_url: &str, identifier: &str) -> String {
    format!(
        "{}/v4/contacts/{}",
        base_url.trim_end_matches('/'),
        urlencoding::encode(identifier)
    )
}

fn podium_conversation_messages_url(base_url: &str, conversation_uid: &str) -> String {
    format!(
        "{}/v4/conversations/{}/messages",
        base_url.trim_end_matches('/'),
        conversation_uid
    )
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AuthCodeTokenResponse {
    /// Present on success; not used (we persist refresh token for the server env).
    #[serde(default)]
    #[allow(dead_code)]
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

/// Normalize common US stored phones to E.164 (+1…). Returns None if unusable.
pub fn normalize_phone_e164(phone: &str) -> Option<String> {
    let t = phone.trim();
    if t.is_empty() {
        return None;
    }
    let digits: String = t.chars().filter(|c| c.is_ascii_digit()).collect();
    if t.starts_with('+') {
        if digits.len() >= 10 {
            return Some(format!("+{digits}"));
        }
        return None;
    }
    match digits.len() {
        10 => Some(format!("+1{digits}")),
        11 if digits.starts_with('1') => Some(format!("+{digits}")),
        _ => None,
    }
}

pub async fn load_store_podium_config(pool: &PgPool) -> Result<StorePodiumSmsConfig, sqlx::Error> {
    let raw: serde_json::Value =
        sqlx::query_scalar("SELECT podium_sms_config FROM store_settings WHERE id = 1")
            .fetch_one(pool)
            .await?;
    Ok(StorePodiumSmsConfig::load_from_json(raw))
}

pub fn apply_template_placeholders(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

/// Fire-and-forget operational SMS for one independently enabled workflow.
/// Logs `podium_send_ok` / `podium_send_err` (no phone/body).
/// When `crm_customer_id` is set and the send succeeds, appends an **`automated`** row to **`podium_message`** for the customer hub thread.
pub async fn try_send_operational_sms(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_e164: &str,
    body: String,
    crm_customer_id: Option<Uuid>,
    feature: PodiumSmsFeature,
) -> Result<(), PodiumError> {
    let creds = match PodiumEnvCredentials::load(pool).await {
        Some(c) => c,
        None => {
            tracing::debug!(
                target = "podium",
                event = "podium_send_skip",
                reason = "no_credentials"
            );
            return Err(PodiumError::NotConfigured);
        }
    };

    let cfg = match load_store_podium_config(pool).await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "podium load_store_podium_config failed");
            return Err(PodiumError::NotConfigured);
        }
    };

    if !cfg.sms_features.is_enabled(feature) {
        tracing::debug!(
            target = "podium",
            event = "podium_send_skip",
            reason = "sms_feature_disabled"
        );
        return Err(PodiumError::NotConfigured);
    }

    let loc = cfg.location_uid.trim();
    if loc.is_empty() {
        tracing::warn!(
            target = "podium",
            event = "podium_send_err",
            reason_class = "missing_location_uid"
        );
        return Err(PodiumError::NotConfigured);
    }

    let Some(phone_e164) = normalize_phone_e164(to_e164) else {
        tracing::warn!(
            target = "podium",
            event = "podium_send_err",
            reason_class = "invalid_phone"
        );
        return Err(PodiumError::SendHttp(400));
    };

    match send_v4_message(
        http,
        token_cache,
        &creds,
        loc,
        "phone",
        phone_e164.as_str(),
        body.as_str(),
        None,
        None,
    )
    .await
    {
        Ok(raw_response) => {
            tracing::info!(
                target = "podium",
                event = "podium_send_ok",
                channel = "phone"
            );
            if let Some(cid) = crm_customer_id {
                let e164 = normalize_phone_e164(to_e164);
                if let Err(e) = podium_messaging::record_outbound_message(
                    pool,
                    cid,
                    "sms",
                    body.as_str(),
                    None,
                    e164.as_deref(),
                    None,
                    "automated",
                    podium_message_send_result(raw_response.clone())
                        .provider_message_id
                        .as_deref(),
                    Some(&raw_response),
                )
                .await
                {
                    tracing::error!(error = %e, customer_id = %cid, "record automated SMS to podium_message");
                }
            }
            Ok(())
        }
        Err(e) => {
            let reason = match &e {
                PodiumError::NotConfigured => "not_configured",
                PodiumError::TokenHttp(_s) => "token_http",
                PodiumError::TokenMissing => "token_missing",
                PodiumError::RefreshTokenMissing => "refresh_token_missing",
                PodiumError::SendHttp(_s) => "send_http",
                PodiumError::SendHttpDetail { .. } => "send_http",
                PodiumError::ReviewInviteHttp(_s) => "review_invite_http",
                PodiumError::ReviewInviteHttpDetail { .. } => "review_invite_http",
                PodiumError::RateLimited { .. } => "rate_limited",
                PodiumError::Http(_) => "http",
            };
            tracing::warn!(target = "podium", event = "podium_send_err", reason_class = reason, error = %e);
            Err(e)
        }
    }
}

/// Basic check for an email address value (not full RFC validation).
pub fn looks_like_email(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && t.contains('@') && !t.starts_with('@') && !t.ends_with('@')
}

#[allow(clippy::too_many_arguments)]
async fn send_v4_message(
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    creds: &PodiumEnvCredentials,
    location_uid: &str,
    channel_type: &str,
    identifier: &str,
    body: &str,
    subject: Option<&str>,
    sender_name: Option<&str>,
) -> Result<Value, PodiumError> {
    let url = podium_messages_url(&creds.api_base_url);
    let mut payload = json!({
        "channel": {
            "identifier": identifier,
            "type": channel_type
        },
        "body": body,
        "locationUid": location_uid
    });
    if let Some(sub) = subject {
        let st = sub.trim();
        if !st.is_empty() {
            payload["subject"] = json!(st);
        }
    }
    if let Some(sender) = sender_name {
        let sender_t = sender.trim();
        if !sender_t.is_empty() {
            payload["senderName"] = json!(sender_t);
        }
    }

    let response = send_authenticated_podium_request(
        http,
        token_cache,
        creds,
        PodiumRequestSafety::Mutation,
        PodiumHttpErrorKind::General,
        &[],
        |token| {
            add_podium_headers(http.post(&url), Some(token))
                .header("Content-Type", "application/json")
                .json(&payload)
        },
    )
    .await?;
    Ok(response.json().await.unwrap_or_else(|_| json!({})))
}

#[derive(Debug, Clone, Serialize)]
pub struct PodiumReviewInviteResult {
    pub provider_id: Option<String>,
    pub review_url: Option<String>,
    pub raw_response: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct PodiumMessageSendResult {
    pub provider_message_id: Option<String>,
    pub raw_response: Value,
}

fn podium_message_send_result(raw_response: Value) -> PodiumMessageSendResult {
    let provider_message_id = first_string_at(
        &raw_response,
        &[
            "/uid",
            "/id",
            "/messageUid",
            "/conversationItemUid",
            "/data/uid",
            "/data/id",
            "/data/messageUid",
            "/data/conversationItemUid",
            "/data/items/0/uid",
            "/items/0/uid",
        ],
    );
    PodiumMessageSendResult {
        provider_message_id,
        raw_response,
    }
}

fn first_string_at(value: &Value, pointers: &[&str]) -> Option<String> {
    pointers.iter().find_map(|pointer| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
    })
}

pub async fn create_podium_review_invite(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_phone_raw: Option<&str>,
    to_email: Option<&str>,
) -> Result<PodiumReviewInviteResult, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let cfg = load_store_podium_config(pool).await.map_err(|e| {
        tracing::error!(error = %e, "podium load_store_podium_config failed (review invite)");
        PodiumError::NotConfigured
    })?;
    let loc = cfg.location_uid.trim();
    if loc.is_empty() {
        return Err(PodiumError::NotConfigured);
    }

    let e164 = to_phone_raw.and_then(normalize_phone_e164);
    let email = to_email
        .map(str::trim)
        .filter(|addr| looks_like_email(addr))
        .map(ToOwned::to_owned);
    if e164.is_none() && email.is_none() {
        return Err(PodiumError::NotConfigured);
    }

    let mut payload = json!({
        "locationUid": loc,
    });
    if let Some(phone) = e164 {
        payload["phoneNumber"] = json!(phone);
    }
    if let Some(addr) = email {
        payload["email"] = json!(addr);
    }

    let url = podium_review_invites_url(&creds.api_base_url);
    let response = send_authenticated_podium_request(
        http,
        token_cache,
        &creds,
        PodiumRequestSafety::Mutation,
        PodiumHttpErrorKind::ReviewInvite,
        &[],
        |token| {
            add_podium_headers(http.post(&url), Some(token))
                .header("Content-Type", "application/json")
                .json(&payload)
        },
    )
    .await?;
    let raw_response: Value = response.json().await.unwrap_or_else(|_| json!({}));
    let provider_id = first_string_at(
        &raw_response,
        &[
            "/id",
            "/uid",
            "/inviteId",
            "/data/id",
            "/data/uid",
            "/data/inviteId",
            "/invite/id",
            "/invite/uid",
        ],
    );
    let review_url = first_string_at(
        &raw_response,
        &[
            "/url",
            "/link",
            "/reviewUrl",
            "/shortUrl",
            "/data/url",
            "/data/link",
            "/data/reviewUrl",
            "/data/shortUrl",
            "/invite/url",
            "/invite/link",
            "/invite/reviewUrl",
            "/invite/shortUrl",
        ],
    );

    Ok(PodiumReviewInviteResult {
        provider_id,
        review_url,
        raw_response,
    })
}

fn values_from_collection(value: Value) -> Vec<Value> {
    if let Some(items) = value.get("data").and_then(Value::as_array) {
        return items.clone();
    }
    if let Some(items) = value.pointer("/data/items").and_then(Value::as_array) {
        return items.clone();
    }
    if let Some(items) = value.pointer("/data/messages").and_then(Value::as_array) {
        return items.clone();
    }
    if let Some(items) = value
        .pointer("/data/conversations")
        .and_then(Value::as_array)
    {
        return items.clone();
    }
    if let Some(items) = value.get("results").and_then(Value::as_array) {
        return items.clone();
    }
    if let Some(items) = value.get("items").and_then(Value::as_array) {
        return items.clone();
    }
    if let Some(items) = value.get("conversations").and_then(Value::as_array) {
        return items.clone();
    }
    if let Some(items) = value.get("messages").and_then(Value::as_array) {
        return items.clone();
    }
    if let Some(items) = value.as_array() {
        return items.clone();
    }
    Vec::new()
}

fn is_collection_response(value: &Value) -> bool {
    value.as_array().is_some()
        || value.get("data").is_some_and(Value::is_array)
        || value.pointer("/data/items").is_some_and(Value::is_array)
        || value.get("results").is_some_and(Value::is_array)
        || value.get("items").is_some_and(Value::is_array)
}

fn next_cursor_from_collection(value: &Value) -> Option<String> {
    first_string_at(
        value,
        &[
            "/metadata/nextCursor",
            "/data/metadata/nextCursor",
            "/data/nextCursor",
            "/nextCursor",
        ],
    )
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PodiumLocationSummary {
    pub uid: String,
    pub name: String,
    pub display_name: Option<String>,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PodiumWebhookSummary {
    pub uid: String,
    pub location_uid: Option<String>,
    pub organization_uid: Option<String>,
    pub url: String,
    pub disabled: bool,
    pub event_types: Vec<String>,
}

fn parse_podium_locations(value: Value) -> Result<Vec<PodiumLocationSummary>, PodiumError> {
    if !is_collection_response(&value) {
        return Err(PodiumError::SendHttp(502));
    }
    Ok(values_from_collection(value)
        .into_iter()
        .filter_map(|location| {
            let uid = first_string_at(&location, &["/uid", "/id"])?;
            let name = first_string_at(&location, &["/name", "/displayName"])
                .unwrap_or_else(|| uid.clone());
            Some(PodiumLocationSummary {
                uid,
                name,
                display_name: first_string_at(&location, &["/displayName"]),
                archived: location
                    .get("archived")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect())
}

fn parse_podium_webhooks(value: Value) -> Result<Vec<PodiumWebhookSummary>, PodiumError> {
    if !is_collection_response(&value) {
        return Err(PodiumError::SendHttp(502));
    }
    Ok(values_from_collection(value)
        .into_iter()
        .filter_map(|webhook| {
            Some(PodiumWebhookSummary {
                uid: first_string_at(&webhook, &["/uid", "/id"])?,
                location_uid: first_string_at(&webhook, &["/locationUid"]),
                organization_uid: first_string_at(&webhook, &["/organizationUid"]),
                url: first_string_at(&webhook, &["/url"]).unwrap_or_default(),
                disabled: webhook
                    .get("disabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                event_types: webhook
                    .get("eventTypes")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToOwned::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect())
}

pub async fn fetch_podium_locations(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
) -> Result<Vec<PodiumLocationSummary>, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let url = podium_locations_url(&creds.api_base_url);
    let mut cursor: Option<String> = None;
    let mut locations = Vec::new();
    loop {
        let page_cursor = cursor.clone();
        let response = send_authenticated_podium_request(
            http,
            token_cache,
            &creds,
            PodiumRequestSafety::SafeRead,
            PodiumHttpErrorKind::General,
            &[],
            |token| {
                if let Some(cursor) = page_cursor.as_deref() {
                    add_podium_headers(http.get(&url), Some(token)).query(&[("cursor", cursor)])
                } else {
                    add_podium_headers(http.get(&url), Some(token)).query(&[("limit", 100_u8)])
                }
            },
        )
        .await?;
        let value = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
        locations.extend(parse_podium_locations(value.clone())?);
        let Some(next_cursor) = next_cursor_from_collection(&value) else {
            break;
        };
        if cursor.as_deref() == Some(next_cursor.as_str()) {
            return Err(PodiumError::SendHttp(502));
        }
        cursor = Some(next_cursor);
    }
    Ok(locations)
}

pub async fn fetch_podium_webhooks(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
) -> Result<Vec<PodiumWebhookSummary>, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let response = send_authenticated_podium_request(
        http,
        token_cache,
        &creds,
        PodiumRequestSafety::SafeRead,
        PodiumHttpErrorKind::General,
        &[],
        |token| {
            add_podium_headers(
                http.get(podium_webhooks_url(&creds.api_base_url)),
                Some(token),
            )
        },
    )
    .await?;
    let value = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
    parse_podium_webhooks(value)
}

pub async fn ensure_podium_webhook(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    location_uid: &str,
    webhook_url: &str,
    secret: &str,
) -> Result<PodiumWebhookSummary, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let existing = fetch_podium_webhooks(pool, http, token_cache)
        .await?
        .into_iter()
        .find(|webhook| {
            webhook.url == webhook_url && webhook.location_uid.as_deref() == Some(location_uid)
        });
    let event_types = PODIUM_REQUIRED_WEBHOOK_EVENT_TYPES.to_vec();
    let payload = json!({
        "disabled": false,
        "eventTypes": event_types,
        "secret": secret,
        "url": webhook_url,
    });
    let response = if let Some(webhook) = existing {
        let url = podium_webhook_url(&creds.api_base_url, &webhook.uid);
        send_authenticated_podium_request(
            http,
            token_cache,
            &creds,
            PodiumRequestSafety::Mutation,
            PodiumHttpErrorKind::General,
            &[],
            |token| {
                add_podium_headers(http.put(&url), Some(token))
                    .header("Content-Type", "application/json")
                    .json(&payload)
            },
        )
        .await?
    } else {
        let url = podium_webhooks_url(&creds.api_base_url);
        let create_payload = json!({
            "eventTypes": PODIUM_REQUIRED_WEBHOOK_EVENT_TYPES,
            "locationUid": location_uid,
            "secret": secret,
            "url": webhook_url,
        });
        send_authenticated_podium_request(
            http,
            token_cache,
            &creds,
            PodiumRequestSafety::Mutation,
            PodiumHttpErrorKind::General,
            &[],
            |token| {
                add_podium_headers(http.post(&url), Some(token))
                    .header("Content-Type", "application/json")
                    .json(&create_payload)
            },
        )
        .await?
    };
    let value = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
    let webhook_value = value.get("data").cloned().unwrap_or(value);
    parse_podium_webhooks(json!({ "data": [webhook_value] }))?
        .into_iter()
        .next()
        .ok_or(PodiumError::SendHttp(502))
}

pub async fn fetch_podium_conversations(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    limit: i64,
) -> Result<Vec<Value>, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let cfg = load_store_podium_config(pool).await.map_err(|e| {
        tracing::error!(error = %e, "podium load_store_podium_config failed (conversation sync)");
        PodiumError::NotConfigured
    })?;
    let loc = cfg.location_uid.trim();
    let total_limit = limit.clamp(1, 500) as usize;
    let page_limit = total_limit.min(100) as i64;
    let mut cursor: Option<String> = None;
    let mut conversations = Vec::new();

    loop {
        let page_cursor = cursor.clone();
        let res = send_authenticated_podium_request(
            http,
            token_cache,
            &creds,
            PodiumRequestSafety::SafeRead,
            PodiumHttpErrorKind::General,
            &[],
            |token| {
                let mut req = add_podium_headers(
                    http.get(podium_conversations_url(&creds.api_base_url)),
                    Some(token),
                );
                if let Some(cursor) = page_cursor.as_deref() {
                    req = req.query(&[("cursor", cursor)]);
                } else {
                    req = req.query(&[("limit", page_limit)]);
                    if !loc.is_empty() {
                        req = req.query(&[("locationUid", loc)]);
                    }
                }
                req
            },
        )
        .await?;
        let value = res.json::<Value>().await.unwrap_or_else(|_| json!({}));
        conversations.extend(values_from_collection(value.clone()));
        if conversations.len() >= total_limit {
            conversations.truncate(total_limit);
            break;
        }
        let Some(next_cursor) = next_cursor_from_collection(&value) else {
            break;
        };
        if cursor.as_deref() == Some(next_cursor.as_str()) {
            break;
        }
        cursor = Some(next_cursor);
    }
    Ok(conversations)
}

pub async fn fetch_podium_conversation_messages(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    conversation_uid: &str,
    limit: i64,
) -> Result<Vec<Value>, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let total_limit = limit.clamp(1, 500) as usize;
    let url = podium_conversation_messages_url(&creds.api_base_url, conversation_uid);
    let mut cursor: Option<String> = None;
    let mut messages = Vec::new();
    loop {
        let page_cursor = cursor.clone();
        let response = send_authenticated_podium_request(
            http,
            token_cache,
            &creds,
            PodiumRequestSafety::SafeRead,
            PodiumHttpErrorKind::General,
            &[],
            |token| {
                let mut request = add_podium_headers(http.get(&url), Some(token));
                if let Some(cursor) = page_cursor.as_deref() {
                    request = request.query(&[("cursor", cursor)]);
                }
                request
            },
        )
        .await?;
        let value = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
        messages.extend(values_from_collection(value.clone()));
        if messages.len() >= total_limit {
            messages.truncate(total_limit);
            break;
        }
        let Some(next_cursor) = next_cursor_from_collection(&value) else {
            break;
        };
        if cursor.as_deref() == Some(next_cursor.as_str()) {
            break;
        }
        cursor = Some(next_cursor);
    }
    Ok(messages)
}

pub async fn fetch_podium_review_invites(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    limit: i64,
) -> Result<Vec<Value>, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let total_limit = limit.clamp(1, 500) as usize;
    let page_limit = total_limit.min(100) as i64;
    let url = podium_review_invites_url(&creds.api_base_url);
    let mut cursor: Option<String> = None;
    let mut invites = Vec::new();
    loop {
        let page_cursor = cursor.clone();
        let response = send_authenticated_podium_request(
            http,
            token_cache,
            &creds,
            PodiumRequestSafety::SafeRead,
            PodiumHttpErrorKind::ReviewInvite,
            &[],
            |token| {
                let mut request = add_podium_headers(http.get(&url), Some(token));
                if let Some(cursor) = page_cursor.as_deref() {
                    request = request.query(&[("cursor", cursor)]);
                } else {
                    request = request.query(&[("limit", page_limit)]);
                }
                request
            },
        )
        .await?;
        let value = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
        invites.extend(values_from_collection(value.clone()));
        if invites.len() >= total_limit {
            invites.truncate(total_limit);
            break;
        }
        let Some(next_cursor) = next_cursor_from_collection(&value) else {
            break;
        };
        if cursor.as_deref() == Some(next_cursor.as_str()) {
            break;
        }
        cursor = Some(next_cursor);
    }
    Ok(invites)
}

/// Read the complete Podium contact list for reconciliation. The provider caps
/// each page at 100. A hard ceiling fails explicitly instead of silently
/// certifying a partial list as complete.
pub async fn fetch_all_podium_contacts(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
) -> Result<Vec<Value>, PodiumError> {
    const MAX_RECONCILIATION_CONTACTS: usize = 50_000;
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let url = podium_contacts_url(&creds.api_base_url);
    let mut cursor: Option<String> = None;
    let mut contacts = Vec::new();
    loop {
        let page_cursor = cursor.clone();
        let response = send_authenticated_podium_request(
            http,
            token_cache,
            &creds,
            PodiumRequestSafety::SafeRead,
            PodiumHttpErrorKind::General,
            &[],
            |token| {
                let mut request =
                    add_podium_headers(http.get(&url), Some(token)).query(&[("limit", 100_u8)]);
                if let Some(cursor) = page_cursor.as_deref() {
                    request = request.query(&[("cursor", cursor)]);
                }
                request
            },
        )
        .await?;
        let value = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
        if !is_collection_response(&value) {
            tracing::error!("Podium contacts response was not a recognized collection");
            return Err(PodiumError::SendHttp(502));
        }
        contacts.extend(values_from_collection(value.clone()));
        if contacts.len() > MAX_RECONCILIATION_CONTACTS {
            tracing::error!(
                contact_count = contacts.len(),
                "Podium contact reconciliation exceeded its explicit safety ceiling"
            );
            return Err(PodiumError::SendHttp(413));
        }
        let Some(next_cursor) = next_cursor_from_collection(&value) else {
            break;
        };
        if cursor.as_deref() == Some(next_cursor.as_str()) {
            tracing::error!(cursor = %next_cursor, "Podium contact cursor repeated");
            return Err(PodiumError::SendHttp(502));
        }
        cursor = Some(next_cursor);
    }
    Ok(contacts)
}

/// Send one SMS via Podium (`channel.type`: `phone`); returns error for API callers (e.g. POS receipt).
pub async fn send_podium_sms_message(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_phone_raw: &str,
    body: &str,
) -> Result<(), PodiumError> {
    send_podium_sms_message_with_sender(pool, http, token_cache, to_phone_raw, body, None).await
}

pub async fn send_podium_sms_message_tracked(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_phone_raw: &str,
    body: &str,
) -> Result<PodiumMessageSendResult, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let cfg = load_store_podium_config(pool).await.map_err(|error| {
        tracing::error!(error = %error, "podium load_store_podium_config failed (tracked sms send)");
        PodiumError::NotConfigured
    })?;
    if cfg.location_uid.trim().is_empty() || body.trim().is_empty() {
        return Err(PodiumError::NotConfigured);
    }
    let Some(e164) = normalize_phone_e164(to_phone_raw) else {
        return Err(PodiumError::NotConfigured);
    };
    let raw_response = send_v4_message(
        http,
        token_cache,
        &creds,
        cfg.location_uid.trim(),
        "phone",
        &e164,
        body.trim(),
        None,
        None,
    )
    .await?;
    Ok(podium_message_send_result(raw_response))
}

/// Send a review-related email through Podium so its message and review-invite
/// delivery lifecycle remain correlated. General operational email continues to
/// use the Riverside Store Email mailbox.
pub async fn send_podium_email_message_tracked(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_email: &str,
    subject: &str,
    body: &str,
) -> Result<PodiumMessageSendResult, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let cfg = load_store_podium_config(pool).await.map_err(|error| {
        tracing::error!(error = %error, "podium load_store_podium_config failed (tracked email send)");
        PodiumError::NotConfigured
    })?;
    let email = to_email.trim();
    if cfg.location_uid.trim().is_empty()
        || !looks_like_email(email)
        || subject.trim().is_empty()
        || body.trim().is_empty()
    {
        return Err(PodiumError::NotConfigured);
    }
    let raw_response = send_v4_message(
        http,
        token_cache,
        &creds,
        cfg.location_uid.trim(),
        "email",
        email,
        body.trim(),
        Some(subject.trim()),
        None,
    )
    .await?;
    Ok(podium_message_send_result(raw_response))
}

pub async fn send_podium_sms_message_with_sender(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_phone_raw: &str,
    body: &str,
    sender_name: Option<&str>,
) -> Result<(), PodiumError> {
    send_podium_sms_message_with_sender_tracked(
        pool,
        http,
        token_cache,
        to_phone_raw,
        body,
        sender_name,
    )
    .await
    .map(|_| ())
}

pub async fn send_podium_sms_message_with_sender_tracked(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_phone_raw: &str,
    body: &str,
    sender_name: Option<&str>,
) -> Result<PodiumMessageSendResult, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let cfg = load_store_podium_config(pool).await.map_err(|e| {
        tracing::error!(error = %e, "podium load_store_podium_config failed (sms send)");
        PodiumError::NotConfigured
    })?;
    if !cfg.sms_send_enabled {
        return Err(PodiumError::NotConfigured);
    }
    let loc = cfg.location_uid.trim();
    if loc.is_empty() {
        return Err(PodiumError::NotConfigured);
    }
    let body_t = body.trim();
    if body_t.is_empty() {
        return Err(PodiumError::NotConfigured);
    }
    let Some(e164) = normalize_phone_e164(to_phone_raw) else {
        return Err(PodiumError::NotConfigured);
    };
    let raw_response = send_v4_message(
        http,
        token_cache,
        &creds,
        loc,
        "phone",
        e164.as_str(),
        body_t,
        None,
        sender_name,
    )
    .await?;
    Ok(podium_message_send_result(raw_response))
}

/// SMS/MMS with a file via `POST /v4/messages/attachment` (multipart). Carrier must support MMS.
pub async fn send_podium_phone_message_with_attachment(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_phone_raw: &str,
    body: &str,
    attachment_bytes: Vec<u8>,
    attachment_filename: &str,
    attachment_content_type: &str,
) -> Result<(), PodiumError> {
    send_podium_phone_message_with_attachment_tracked(
        pool,
        http,
        token_cache,
        to_phone_raw,
        body,
        attachment_bytes,
        attachment_filename,
        attachment_content_type,
    )
    .await
    .map(|_| ())
}

pub async fn send_podium_phone_message_with_attachment_tracked(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_phone_raw: &str,
    body: &str,
    attachment_bytes: Vec<u8>,
    attachment_filename: &str,
    attachment_content_type: &str,
) -> Result<PodiumMessageSendResult, PodiumError> {
    send_podium_phone_message_with_attachment_with_sender_tracked(
        pool,
        http,
        token_cache,
        to_phone_raw,
        body,
        attachment_bytes,
        attachment_filename,
        attachment_content_type,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn send_podium_phone_message_with_attachment_with_sender_tracked(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_phone_raw: &str,
    body: &str,
    attachment_bytes: Vec<u8>,
    attachment_filename: &str,
    attachment_content_type: &str,
    sender_name: Option<&str>,
) -> Result<PodiumMessageSendResult, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let cfg = load_store_podium_config(pool).await.map_err(|e| {
        tracing::error!(error = %e, "podium load_store_podium_config failed (sms attachment send)");
        PodiumError::NotConfigured
    })?;
    if !cfg.sms_send_enabled {
        return Err(PodiumError::NotConfigured);
    }
    let loc = cfg.location_uid.trim();
    if loc.is_empty() {
        return Err(PodiumError::NotConfigured);
    }
    let body_t = body.trim();
    if body_t.is_empty() {
        return Err(PodiumError::NotConfigured);
    }
    if attachment_bytes.is_empty()
        || attachment_filename.trim().is_empty()
        || attachment_content_type.trim().is_empty()
    {
        return Err(PodiumError::NotConfigured);
    }
    if attachment_bytes.len() > PODIUM_MAX_ATTACHMENT_BYTES {
        return Err(PodiumError::SendHttp(413));
    }
    let Some(e164) = normalize_phone_e164(to_phone_raw) else {
        return Err(PodiumError::NotConfigured);
    };
    let mut data = json!({
        "body": body_t,
        "channel": {
            "type": "phone",
            "identifier": e164,
        },
        "locationUid": loc,
    });
    if let Some(sender_name) = sender_name.map(str::trim).filter(|value| !value.is_empty()) {
        data["senderName"] = json!(sender_name);
    }
    let data_str = serde_json::to_string(&data).map_err(|_| PodiumError::NotConfigured)?;

    let attachment_filename = attachment_filename.trim().to_string();
    let attachment_content_type = attachment_content_type.trim().to_string();
    let url = podium_messages_attachment_url(&creds.api_base_url);
    let response = send_authenticated_podium_request(
        http,
        token_cache,
        &creds,
        PodiumRequestSafety::Mutation,
        PodiumHttpErrorKind::General,
        &[],
        |token| {
            let part = reqwest::multipart::Part::bytes(attachment_bytes.clone())
                .file_name(attachment_filename.clone())
                .mime_str(&attachment_content_type)
                .expect("validated Podium attachment MIME type");
            let form = reqwest::multipart::Form::new()
                .text("data", data_str.clone())
                .part("attachment", part);
            add_podium_headers(http.post(&url), Some(token)).multipart(form)
        },
    )
    .await?;
    let raw_response = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
    tracing::info!(
        target = "podium",
        event = "podium_send_ok",
        channel = "phone_attachment",
    );
    Ok(podium_message_send_result(raw_response))
}

/// SMS/MMS with image via `POST /v4/messages/attachment` (multipart). Carrier must support MMS.
pub async fn send_podium_phone_message_with_png_attachment(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_phone_raw: &str,
    body: &str,
    attachment_png: Vec<u8>,
) -> Result<(), PodiumError> {
    send_podium_phone_message_with_attachment(
        pool,
        http,
        token_cache,
        to_phone_raw,
        body,
        attachment_png,
        "receipt.png",
        "image/png",
    )
    .await
}

pub async fn send_podium_phone_message_with_png_attachment_tracked(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_phone_raw: &str,
    body: &str,
    attachment_png: Vec<u8>,
) -> Result<PodiumMessageSendResult, PodiumError> {
    send_podium_phone_message_with_attachment_tracked(
        pool,
        http,
        token_cache,
        to_phone_raw,
        body,
        attachment_png,
        "receipt.png",
        "image/png",
    )
    .await
}

pub async fn send_podium_phone_message_with_png_attachment_with_sender_tracked(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_phone_raw: &str,
    body: &str,
    attachment_png: Vec<u8>,
    sender_name: Option<&str>,
) -> Result<PodiumMessageSendResult, PodiumError> {
    send_podium_phone_message_with_attachment_with_sender_tracked(
        pool,
        http,
        token_cache,
        to_phone_raw,
        body,
        attachment_png,
        "receipt.png",
        "image/png",
        sender_name,
    )
    .await
}

/// Legacy general-purpose Podium email entry point. Store operational email uses
/// the ROS mailbox; review-request email uses `send_podium_email_message_tracked`.
pub async fn send_podium_email_message(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_email: &str,
    subject: &str,
    html_body: &str,
) -> Result<(), PodiumError> {
    send_podium_email_message_with_sender(
        pool,
        http,
        token_cache,
        to_email,
        subject,
        html_body,
        None,
    )
    .await
}

pub async fn send_podium_email_message_with_sender(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_email: &str,
    subject: &str,
    html_body: &str,
    sender_name: Option<&str>,
) -> Result<(), PodiumError> {
    let _ = (
        pool,
        http,
        token_cache,
        to_email,
        subject,
        html_body,
        sender_name,
    );
    tracing::debug!(
        "General Podium email is disabled; use the ROS mailbox or the dedicated review-email path"
    );
    Err(PodiumError::NotConfigured)
}

/// Fire-and-forget operational email (pickup, alterations, appointments, loyalty). Logs outcomes.
/// When `crm_customer_id` is set and the send succeeds, appends an **`automated`** row to **`podium_message`**.
pub async fn try_send_operational_email(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_email: &str,
    subject: String,
    html_body: String,
    crm_customer_id: Option<Uuid>,
) {
    match send_podium_email_message(pool, http, token_cache, to_email, &subject, &html_body).await {
        Ok(()) => {
            tracing::info!(
                target = "podium",
                event = "podium_send_ok",
                channel = "email"
            );
            if let Some(cid) = crm_customer_id {
                let em_t = to_email.trim();
                let body_for_thread = format!("<p><b>{subject}</b></p>{html_body}");
                if let Err(e) = podium_messaging::record_outbound_message(
                    pool,
                    cid,
                    "email",
                    body_for_thread.as_str(),
                    None,
                    None,
                    Some(em_t),
                    "automated",
                    None,
                    None,
                )
                .await
                {
                    tracing::error!(error = %e, customer_id = %cid, "record automated email to podium_message");
                }
            }
        }
        Err(e) => {
            let reason = match &e {
                PodiumError::NotConfigured => "not_configured_or_disabled",
                PodiumError::TokenHttp(_s) => "token_http",
                PodiumError::TokenMissing => "token_missing",
                PodiumError::RefreshTokenMissing => "refresh_token_missing",
                PodiumError::SendHttp(_s) => "send_http",
                PodiumError::SendHttpDetail { .. } => "send_http",
                PodiumError::ReviewInviteHttp(_s) => "review_invite_http",
                PodiumError::ReviewInviteHttpDetail { .. } => "review_invite_http",
                PodiumError::RateLimited { .. } => "rate_limited",
                PodiumError::Http(_) => "http",
            };
            tracing::warn!(target = "podium", event = "podium_send_err", reason_class = reason, channel = "email", error = %e);
        }
    }
}

async fn get_valid_access_token(
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    creds: &PodiumEnvCredentials,
) -> Result<String, PodiumError> {
    let mut guard = token_cache.lock().await;
    let now = Utc::now();
    if let (Some(tok), Some(exp)) = (&guard.access_token, guard.expires_at) {
        if exp - Duration::seconds(90) > now {
            return Ok(tok.clone());
        }
    }

    for attempt in 0..=PODIUM_MAX_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(podium_retry_delay(attempt - 1)).await;
            tracing::info!(attempt, "Retrying Podium token refresh");
        }
        let res = match add_podium_headers(http.post(&creds.token_url), None)
            .header("Content-Type", "application/json")
            .json(&json!({
                "client_id": &creds.client_id,
                "client_secret": &creds.client_secret,
                "grant_type": "refresh_token",
                "refresh_token": &creds.refresh_token,
            }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                if e.is_timeout() || e.is_connect() {
                    tracing::warn!("Podium token refresh network error: {e}");
                    continue;
                }
                return Err(PodiumError::Http(e));
            }
        };

        let status = res.status();
        if status.is_success() {
            let tr: TokenResponse = res.json().await?;
            if tr.access_token.is_empty() {
                return Err(PodiumError::TokenMissing);
            }
            let exp = tr.expires_in.unwrap_or(3600);
            guard.access_token = Some(tr.access_token.clone());
            guard.expires_at = Some(now + Duration::seconds(exp.max(60)));
            return Ok(tr.access_token);
        }
        if status.is_server_error() && attempt < PODIUM_MAX_RETRIES {
            tracing::warn!("Podium token refresh HTTP {status}, retrying");
            continue;
        }
        return Err(PodiumError::TokenHttp(status.as_u16()));
    }
    Err(PodiumError::TokenHttp(0))
}

pub async fn fetch_podium_users(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
) -> Result<Vec<Value>, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let url = format!("{}/v4/users", creds.api_base_url.trim_end_matches('/'));
    let mut cursor: Option<String> = None;
    let mut users = Vec::new();
    loop {
        let page_cursor = cursor.clone();
        let response = send_authenticated_podium_request(
            http,
            token_cache,
            &creds,
            PodiumRequestSafety::SafeRead,
            PodiumHttpErrorKind::General,
            &[],
            |token| {
                let request = add_podium_headers(http.get(&url), Some(token));
                if let Some(cursor) = page_cursor.as_deref() {
                    request.query(&[("cursor", cursor)])
                } else {
                    request.query(&[("limit", 100_i64)])
                }
            },
        )
        .await?;
        let value = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
        users.extend(values_from_collection(value.clone()));
        let Some(next_cursor) = next_cursor_from_collection(&value) else {
            break;
        };
        if cursor.as_deref() == Some(next_cursor.as_str()) {
            break;
        }
        cursor = Some(next_cursor);
    }
    Ok(users)
}

pub async fn list_podium_users_combined(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
) -> Result<Vec<Value>, PodiumError> {
    // 1. Try to fetch from API
    let api_users = match fetch_podium_users(pool, http, token_cache).await {
        Ok(users) => users,
        Err(_) => Vec::new(),
    };

    // 2. Fetch already seen senders from database messages
    let db_users: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        r#"
        SELECT DISTINCT pm.podium_sender_uid, pm.podium_sender_name
        FROM podium_message pm
        WHERE pm.direction IN ('outbound', 'automated')
          AND pm.podium_sender_uid IS NOT NULL
        "#,
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    // 3. Merge them uniquely by uid
    let mut merged = Vec::new();
    let mut seen_uids = std::collections::HashSet::new();

    for user in api_users {
        if let Some(uid) = user.get("uid").and_then(Value::as_str) {
            seen_uids.insert(uid.to_string());
            merged.push(user);
        } else if let Some(uid) = user.get("id").and_then(Value::as_str) {
            seen_uids.insert(uid.to_string());
            merged.push(user);
        }
    }

    for (uid_opt, name_opt) in db_users {
        if let Some(uid) = uid_opt {
            if !seen_uids.contains(&uid) {
                seen_uids.insert(uid.clone());
                let name = name_opt.clone().unwrap_or_default();
                merged.push(json!({
                    "uid": uid,
                    "firstName": name,
                    "lastName": "",
                    "name": name,
                }));
            }
        }
    }

    Ok(merged)
}

fn podium_contact_payload(
    first_name: &str,
    last_name: &str,
    phone: Option<&str>,
    email: Option<&str>,
    location_uid: &str,
) -> Value {
    let mut payload = json!({
        "name": format!("{} {}", first_name, last_name).trim(),
        "locations": [location_uid],
    });
    if let Some(phone_number) = phone.and_then(normalize_phone_e164) {
        payload["phoneNumber"] = json!(phone_number);
    }
    if let Some(email_address) = email.map(str::trim).filter(|value| looks_like_email(value)) {
        payload["email"] = json!(email_address);
    }
    payload
}

pub(crate) fn podium_contact_identifier_from_payload(value: &Value) -> Option<String> {
    first_string_at(
        value,
        &["/conversations/0/uid", "/data/conversations/0/uid"],
    )
    .or_else(|| {
        first_string_at(
            value,
            &[
                "/phoneNumber",
                "/phoneNumbers/0",
                "/phoneNumbers/0/identifier",
                "/data/phoneNumber",
                "/data/phoneNumbers/0",
                "/data/phoneNumbers/0/identifier",
            ],
        )
        .and_then(|phone| normalize_phone_e164(&phone))
    })
    .or_else(|| {
        first_string_at(
            value,
            &[
                "/email",
                "/emails/0",
                "/emails/0/identifier",
                "/data/email",
                "/data/emails/0",
                "/data/emails/0/identifier",
            ],
        )
        .filter(|email| looks_like_email(email))
    })
}

#[derive(Debug, Clone)]
pub struct PodiumContactUpsertResult {
    pub provider_contact_uid: String,
    pub provider_match_identifier: String,
    pub provider_response: Value,
}

fn podium_contact_upsert_result(
    provider_response: Value,
    current_identifier: &str,
) -> Option<PodiumContactUpsertResult> {
    let provider_contact_uid = first_string_at(
        &provider_response,
        &["/uid", "/id", "/data/uid", "/data/id"],
    )?;
    let provider_match_identifier = podium_contact_identifier_from_payload(&provider_response)
        .unwrap_or_else(|| current_identifier.to_string());
    Some(PodiumContactUpsertResult {
        provider_contact_uid,
        provider_match_identifier,
        provider_response,
    })
}

fn podium_assignee_payload(user_uid: Option<&str>) -> Value {
    let assignee_uids = user_uid
        .map(str::trim)
        .filter(|uid| !uid.is_empty())
        .map(|uid| vec![uid])
        .unwrap_or_default();
    json!({ "assigneeUids": assignee_uids })
}

fn podium_conversation_closed_payload(closed: bool) -> Value {
    json!({ "closed": closed })
}

/// Push (create or update) a Riverside customer as a Podium contact.
/// Uses phone or email as the identifier. Requires `write_contacts` scope.
pub async fn upsert_podium_contact(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    customer_id: Uuid,
) -> Result<PodiumContactUpsertResult, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let cfg = load_store_podium_config(pool).await.map_err(|e| {
        tracing::error!(error = %e, "podium load_store_podium_config failed (contact upsert)");
        PodiumError::NotConfigured
    })?;
    // Fetch customer data
    let row: Option<(
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<Value>,
    )> = sqlx::query_as(
        r#"
        SELECT c.first_name, c.last_name, c.phone, c.email, c.company_name,
            state.provider_match_identifier, state.last_provider_payload
        FROM customers c
        LEFT JOIN podium_contact_sync_state state ON state.customer_id = c.id
        WHERE c.id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "failed to load customer for podium contact sync");
        PodiumError::NotConfigured
    })?;

    let Some((
        first_name,
        last_name,
        phone,
        email,
        _company_name,
        provider_match_identifier,
        last_provider_payload,
    )) = row
    else {
        return Err(PodiumError::NotConfigured);
    };

    // Build identifier: prefer phone, fallback email
    let current_identifier = phone
        .as_deref()
        .and_then(normalize_phone_e164)
        .or_else(|| {
            email
                .as_deref()
                .map(str::trim)
                .filter(|value| looks_like_email(value))
                .map(ToOwned::to_owned)
        })
        .ok_or(PodiumError::NotConfigured)?;
    let patch_identifier = provider_match_identifier
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            last_provider_payload
                .as_ref()
                .and_then(podium_contact_identifier_from_payload)
        })
        .unwrap_or_else(|| current_identifier.clone());

    let base = creds.api_base_url.trim_end_matches('/');
    let patch_url = podium_contact_url(base, &patch_identifier);
    let current_url = podium_contact_url(base, &current_identifier);

    let loc = cfg.location_uid.trim();
    if loc.is_empty() {
        return Err(PodiumError::NotConfigured);
    }
    let body = podium_contact_payload(
        &first_name,
        &last_name,
        phone.as_deref(),
        email.as_deref(),
        loc,
    );

    let res = send_authenticated_podium_request(
        http,
        token_cache,
        &creds,
        PodiumRequestSafety::Mutation,
        PodiumHttpErrorKind::General,
        &[StatusCode::NOT_FOUND],
        |token| add_podium_headers(http.patch(&patch_url), Some(token)).json(&body),
    )
    .await?;
    let status = res.status();
    if status == StatusCode::NOT_FOUND {
        // Contact doesn't exist, create it
        let create_url = podium_contacts_url(base);
        let create_res = send_authenticated_podium_request(
            http,
            token_cache,
            &creds,
            PodiumRequestSafety::Mutation,
            PodiumHttpErrorKind::General,
            &[],
            |token| add_podium_headers(http.post(&create_url), Some(token)).json(&body),
        )
        .await?;
        let created = create_res
            .json::<Value>()
            .await
            .unwrap_or_else(|_| json!({}));
        if let Some(result) = podium_contact_upsert_result(created, &current_identifier) {
            return Ok(result);
        }
        let read_res = send_authenticated_podium_request(
            http,
            token_cache,
            &creds,
            PodiumRequestSafety::SafeRead,
            PodiumHttpErrorKind::General,
            &[],
            |token| add_podium_headers(http.get(&current_url), Some(token)),
        )
        .await?;
        let read_value = read_res.json::<Value>().await.unwrap_or_else(|_| json!({}));
        let Some(result) = podium_contact_upsert_result(read_value, &current_identifier) else {
            tracing::error!(
                customer_id = %customer_id,
                "Podium contact create succeeded without a retrievable provider contact UID"
            );
            return Err(PodiumError::SendHttp(502));
        };
        return Ok(result);
    }
    let updated = res.json::<Value>().await.unwrap_or_else(|_| json!({}));
    if let Some(result) = podium_contact_upsert_result(updated, &current_identifier) {
        return Ok(result);
    }
    let read_res = send_authenticated_podium_request(
        http,
        token_cache,
        &creds,
        PodiumRequestSafety::SafeRead,
        PodiumHttpErrorKind::General,
        &[],
        |token| add_podium_headers(http.get(&current_url), Some(token)),
    )
    .await?;
    let read_value = read_res.json::<Value>().await.unwrap_or_else(|_| json!({}));
    let Some(result) = podium_contact_upsert_result(read_value, &current_identifier) else {
        tracing::error!(
            customer_id = %customer_id,
            "Podium contact update succeeded without a retrievable provider contact UID"
        );
        return Err(PodiumError::SendHttp(502));
    };
    Ok(result)
}

/// Get conversation assignees from Podium.
pub async fn fetch_conversation_assignees(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    conversation_uid: &str,
) -> Result<Vec<Value>, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let base = creds.api_base_url.trim_end_matches('/');
    let url = format!(
        "{}/v4/conversations/{}/assignees",
        base,
        urlencoding::encode(conversation_uid)
    );

    let res = send_authenticated_podium_request(
        http,
        token_cache,
        &creds,
        PodiumRequestSafety::SafeRead,
        PodiumHttpErrorKind::General,
        &[],
        |token| add_podium_headers(http.get(&url), Some(token)),
    )
    .await?;
    let value = res.json::<Value>().await.unwrap_or_else(|_| json!({}));
    Ok(values_from_collection(value))
}

/// Update conversation assignee in Podium.
pub async fn update_conversation_assignee(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    conversation_uid: &str,
    user_uid: Option<&str>,
) -> Result<Value, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let base = creds.api_base_url.trim_end_matches('/');
    let url = format!(
        "{}/v4/conversations/{}/assignees",
        base,
        urlencoding::encode(conversation_uid)
    );

    let body = podium_assignee_payload(user_uid);

    let res = send_authenticated_podium_request(
        http,
        token_cache,
        &creds,
        PodiumRequestSafety::Mutation,
        PodiumHttpErrorKind::General,
        &[],
        |token| add_podium_headers(http.put(&url), Some(token)).json(&body),
    )
    .await?;
    Ok(res.json::<Value>().await.unwrap_or_else(|_| json!({})))
}

/// Close or reopen a conversation in Podium.
pub async fn update_conversation_closed(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    conversation_uid: &str,
    closed: bool,
) -> Result<Value, PodiumError> {
    let creds = PodiumEnvCredentials::load(pool)
        .await
        .ok_or(PodiumError::NotConfigured)?;
    let base = creds.api_base_url.trim_end_matches('/');
    let url = format!(
        "{}/v4/conversations/{}",
        base,
        urlencoding::encode(conversation_uid)
    );

    let res = send_authenticated_podium_request(
        http,
        token_cache,
        &creds,
        PodiumRequestSafety::Mutation,
        PodiumHttpErrorKind::General,
        &[],
        |token| {
            add_podium_headers(http.put(&url), Some(token))
                .json(&podium_conversation_closed_payload(closed))
        },
    )
    .await?;
    Ok(res.json::<Value>().await.unwrap_or_else(|_| json!({})))
}

#[derive(Debug, serde::Serialize)]
pub struct PodiumHealth {
    pub configured: bool,
    pub reachable: bool,
    pub latency_ms: u64,
    pub message: String,
}

pub async fn health_check(pool: &PgPool, http: &reqwest::Client) -> PodiumHealth {
    let start = std::time::Instant::now();
    let creds = match PodiumEnvCredentials::load(pool).await {
        Some(creds) => creds,
        None => {
            return PodiumHealth {
                configured: false,
                reachable: false,
                latency_ms: 0,
                message: "Podium OAuth credentials are incomplete".to_string(),
            };
        }
    };

    let health_token_cache = Arc::new(Mutex::new(PodiumTokenCache::default()));
    let base = creds.api_base_url.trim_end_matches('/');
    let checks = [
        ("read_locations", format!("{base}/v4/locations")),
        ("read_messages", format!("{base}/v4/conversations")),
        ("read_contacts", format!("{base}/v4/contacts")),
        ("read_reviews", format!("{base}/v4/reviews/invites")),
        ("read_users", format!("{base}/v4/users")),
    ];
    for (scope, url) in checks {
        let result = send_authenticated_podium_request(
            http,
            &health_token_cache,
            &creds,
            PodiumRequestSafety::SafeRead,
            PodiumHttpErrorKind::General,
            &[],
            |token| add_podium_headers(http.get(&url), Some(token)).query(&[("limit", 1_u8)]),
        )
        .await;
        if let Err(error) = result {
            return PodiumHealth {
                configured: true,
                reachable: false,
                latency_ms: start.elapsed().as_millis() as u64,
                message: format!("Podium {scope} readiness check failed: {error}"),
            };
        }
    }
    PodiumHealth {
        configured: true,
        reachable: true,
        latency_ms: start.elapsed().as_millis() as u64,
        message: "Podium OAuth and required read scopes are healthy; delivery toggles and webhook processing are reported separately.".to_string(),
    }
}

#[cfg(test)]

mod tests {
    #![allow(clippy::await_holding_lock)]

    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn invalidating_access_token_clears_cached_oauth_grant() {
        let cache = Arc::new(tokio::sync::Mutex::new(PodiumTokenCache {
            access_token: Some("stale-access-token".to_string()),
            expires_at: Some(Utc::now() + Duration::hours(1)),
        }));

        invalidate_podium_access_token(&cache).await;

        let cache = cache.lock().await;
        assert!(cache.access_token.is_none());
        assert!(cache.expires_at.is_none());
    }

    #[test]
    fn legacy_settings_receive_all_message_catalog_defaults() {
        let cfg = StorePodiumSmsConfig::load_from_json(json!({
            "sms_send_enabled": true,
            "location_uid": "location-1",
            "templates": { "ready_for_pickup": "Custom pickup" }
        }));

        assert_eq!(
            cfg.templates.merged_defaults().ready_for_pickup,
            "Custom pickup"
        );
        assert!(cfg.sms_features.staff_messages);
        assert!(cfg.sms_features.receipts);
        assert!(cfg.sms_features.ready_for_pickup);
        assert!(cfg.sms_features.alteration_ready);
        assert!(cfg.sms_features.appointment_confirmation);
        assert!(cfg.sms_features.appointment_reminder);
        assert!(cfg.sms_features.unknown_sender_welcome);
        assert!(cfg
            .email_templates
            .merged_defaults()
            .appointment_reminder_html
            .contains("{starts_at}"));
        assert!(cfg
            .review_templates
            .merged_defaults()
            .sms_body
            .contains("{review_url}"));
        assert!(cfg
            .receipt_templates
            .merged_defaults()
            .gift_email_subject
            .contains("{receipt_ref}"));
    }

    #[test]
    fn sms_features_are_independent_and_drive_legacy_aggregate() {
        let cfg = StorePodiumSmsConfig::load_from_json(json!({
            "sms_send_enabled": true,
            "sms_features": {
                "staff_messages": false,
                "receipts": true,
                "ready_for_pickup": false,
                "alteration_ready": false,
                "appointment_confirmation": false,
                "appointment_reminder": false,
                "unknown_sender_welcome": false
            }
        }));

        assert!(cfg.sms_send_enabled);
        assert!(cfg.sms_features.receipts);
        assert!(!cfg.sms_features.staff_messages);
        assert!(!cfg.sms_features.ready_for_pickup);
    }

    #[test]
    fn saved_message_catalog_values_override_defaults() {
        let cfg = StorePodiumSmsConfig::load_from_json(json!({
            "review_templates": {
                "sms_body": "Review {review_url}",
                "email_subject": "Your visit",
                "email_body": "Open {review_url}"
            },
            "receipt_templates": {
                "sms_caption": "Attached {receipt_ref}",
                "gift_sms_caption": "Gift {receipt_ref}",
                "email_subject": "Receipt {receipt_ref}",
                "gift_email_subject": "Gift {receipt_ref}"
            }
        }));

        assert_eq!(
            cfg.review_templates.merged_defaults().email_subject,
            "Your visit"
        );
        assert_eq!(
            cfg.receipt_templates.merged_defaults().sms_caption,
            "Attached {receipt_ref}"
        );
    }

    #[test]
    fn redirect_uri_validation_https_and_loopback_http() {
        assert!(validate_podium_oauth_redirect_uri(
            "https://localhost:5173/callback"
        ));
        assert!(validate_podium_oauth_redirect_uri(
            "https://127.0.0.1:3000/callback"
        ));
        assert!(validate_podium_oauth_redirect_uri(
            "http://localhost:5173/callback"
        ));
        assert!(!validate_podium_oauth_redirect_uri(
            "http://evil.com/callback"
        ));
        assert!(!validate_podium_oauth_redirect_uri(
            "https://localhost:5173/"
        ));
        assert!(!validate_podium_oauth_redirect_uri(
            "https://user:pass@evil.com/callback"
        ));
        assert!(validate_podium_oauth_redirect_uri(
            "https://ros.example.com/callback"
        ));
    }

    #[test]
    fn oauth_state_validation() {
        assert!(validate_podium_oauth_state(
            "550e8400-e29b-41d4-a716-446655440000"
        ));
        assert!(!validate_podium_oauth_state(""));
        assert!(!validate_podium_oauth_state("x;y"));
    }

    #[test]
    fn podium_service_urls_require_official_https_or_loopback() {
        assert!(validate_podium_service_url("https://api.podium.com").is_ok());
        assert!(validate_podium_service_url("https://accounts.podium.com/oauth/token").is_ok());
        assert!(validate_podium_service_url("http://127.0.0.1:9000").is_ok());
        assert!(validate_podium_service_url("http://api.podium.com").is_err());
        assert!(validate_podium_service_url("https://example.com/podium").is_err());
        assert!(validate_podium_service_url("https://user:secret@api.podium.com").is_err());
    }

    #[test]
    fn contact_payload_uses_documented_fields() {
        let payload = podium_contact_payload(
            "Ada",
            "Lovelace",
            Some("(555) 123-4567"),
            Some("ada@example.com"),
            "location-1",
        );
        assert_eq!(payload["name"], "Ada Lovelace");
        assert_eq!(payload["phoneNumber"], "+15551234567");
        assert_eq!(payload["email"], "ada@example.com");
        assert_eq!(payload["locations"], json!(["location-1"]));
        assert!(payload.get("phone").is_none());
        assert!(payload.get("locationUid").is_none());
    }

    #[test]
    fn stored_contact_identifier_prefers_stable_conversation_identity() {
        let payload = json!({
            "conversations": [{ "uid": "conversation-1" }],
            "phoneNumbers": ["+15551234567"],
            "emails": ["old@example.com"]
        });

        assert_eq!(
            podium_contact_identifier_from_payload(&payload).as_deref(),
            Some("conversation-1")
        );
    }

    #[test]
    fn stored_contact_identifier_reads_documented_phone_array() {
        let payload = json!({ "phoneNumbers": ["(555) 123-4567"] });

        assert_eq!(
            podium_contact_identifier_from_payload(&payload).as_deref(),
            Some("+15551234567")
        );
    }

    #[test]
    fn assignee_payload_uses_documented_uid_array() {
        assert_eq!(
            podium_assignee_payload(Some("user-1")),
            json!({ "assigneeUids": ["user-1"] })
        );
        assert_eq!(podium_assignee_payload(None), json!({ "assigneeUids": [] }));
    }

    #[test]
    fn conversation_closed_payload_uses_documented_boolean() {
        assert_eq!(
            podium_conversation_closed_payload(true),
            json!({ "closed": true })
        );
        assert_eq!(
            podium_conversation_closed_payload(false),
            json!({ "closed": false })
        );
    }

    #[test]
    fn provider_error_detail_prefers_documented_message_field() {
        assert_eq!(
            podium_error_detail(r#"{"message":"User lacks webhook permission"}"#).as_deref(),
            Some("User lacks webhook permission")
        );
    }

    #[test]
    fn rate_limit_error_exposes_http_status() {
        assert_eq!(
            PodiumError::RateLimited {
                retry_after_seconds: 30
            }
            .http_status(),
            Some(429)
        );
    }

    static PODIUM_TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var(key).ok();
            unsafe {
                std::env::set_var(key, value);
            }
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.previous {
                    None => std::env::remove_var(self.key),
                    Some(v) => std::env::set_var(self.key, v),
                }
            }
        }
    }

    #[tokio::test]
    async fn send_sms_posts_to_configured_api_base() {
        let _lock = PODIUM_TEST_ENV_LOCK.lock().unwrap();
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "test-access",
                "expires_in": 3600
            })))
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/v4/messages"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&mock)
            .await;

        let _a = EnvGuard::set("RIVERSIDE_PODIUM_CLIENT_ID", "cid");
        let _b = EnvGuard::set("RIVERSIDE_PODIUM_CLIENT_SECRET", "sec");
        let _c = EnvGuard::set("RIVERSIDE_PODIUM_REFRESH_TOKEN", "rtok");
        let base = mock.uri();
        let _d = EnvGuard::set("RIVERSIDE_PODIUM_API_BASE", base.as_str());
        let token_url = format!("{base}/oauth/token");
        let _e = EnvGuard::set("RIVERSIDE_PODIUM_OAUTH_TOKEN_URL", &token_url);

        let creds = PodiumEnvCredentials::from_env().expect("creds");
        let http = reqwest::Client::new();
        let cache = Arc::new(tokio::sync::Mutex::new(PodiumTokenCache::default()));
        let r = send_v4_message(
            &http,
            &cache,
            &creds,
            "loc-uid",
            "phone",
            "15551234567",
            "pickup ready",
            None,
            None,
        )
        .await;
        assert!(r.is_ok(), "{r:?}");
    }

    #[tokio::test]
    async fn send_email_uses_documented_podium_channel_and_subject() {
        let _lock = PODIUM_TEST_ENV_LOCK.lock().unwrap();
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "test-access",
                "expires_in": 3600
            })))
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/v4/messages"))
            .and(body_json(json!({
                "channel": {
                    "identifier": "customer@example.com",
                    "type": "email"
                },
                "body": "Please share your review: https://example.test/review",
                "locationUid": "loc-uid",
                "subject": "How was your Riverside experience?"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "uid": "message-uid"
            })))
            .mount(&mock)
            .await;

        let _a = EnvGuard::set("RIVERSIDE_PODIUM_CLIENT_ID", "cid");
        let _b = EnvGuard::set("RIVERSIDE_PODIUM_CLIENT_SECRET", "sec");
        let _c = EnvGuard::set("RIVERSIDE_PODIUM_REFRESH_TOKEN", "rtok");
        let base = mock.uri();
        let _d = EnvGuard::set("RIVERSIDE_PODIUM_API_BASE", base.as_str());
        let token_url = format!("{base}/oauth/token");
        let _e = EnvGuard::set("RIVERSIDE_PODIUM_OAUTH_TOKEN_URL", &token_url);

        let creds = PodiumEnvCredentials::from_env().expect("creds");
        let result = send_v4_message(
            &reqwest::Client::new(),
            &Arc::new(tokio::sync::Mutex::new(PodiumTokenCache::default())),
            &creds,
            "loc-uid",
            "email",
            "customer@example.com",
            "Please share your review: https://example.test/review",
            Some("How was your Riverside experience?"),
            None,
        )
        .await
        .expect("Podium email send");
        assert_eq!(result["uid"], "message-uid");
    }

    #[tokio::test]
    async fn message_mutation_does_not_retry_ambiguous_server_error() {
        let _lock = PODIUM_TEST_ENV_LOCK.lock().unwrap();
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "test-access",
                "expires_in": 3600
            })))
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/v4/messages"))
            .respond_with(ResponseTemplate::new(500))
            .expect(1)
            .mount(&mock)
            .await;

        let _a = EnvGuard::set("RIVERSIDE_PODIUM_CLIENT_ID", "cid");
        let _b = EnvGuard::set("RIVERSIDE_PODIUM_CLIENT_SECRET", "sec");
        let _c = EnvGuard::set("RIVERSIDE_PODIUM_REFRESH_TOKEN", "rtok");
        let base = mock.uri();
        let _d = EnvGuard::set("RIVERSIDE_PODIUM_API_BASE", base.as_str());
        let token_url = format!("{base}/oauth/token");
        let _e = EnvGuard::set("RIVERSIDE_PODIUM_OAUTH_TOKEN_URL", &token_url);

        let creds = PodiumEnvCredentials::from_env().expect("creds");
        let cache = Arc::new(tokio::sync::Mutex::new(PodiumTokenCache::default()));
        let result = send_v4_message(
            &reqwest::Client::new(),
            &cache,
            &creds,
            "loc-uid",
            "phone",
            "15551234567",
            "pickup ready",
            None,
            None,
        )
        .await;
        assert!(matches!(result, Err(PodiumError::SendHttp(500))));
    }

    #[tokio::test]
    async fn exchange_auth_code_returns_refresh_token() {
        let _lock = PODIUM_TEST_ENV_LOCK.lock().unwrap();
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "at",
                "refresh_token": "rt-test",
                "expires_in": 3600
            })))
            .mount(&mock)
            .await;

        let creds = PodiumOAuthAppCredentials {
            client_id: "cid".into(),
            client_secret: "sec".into(),
            token_url: format!("{}/oauth/token", mock.uri()),
        };
        let http = reqwest::Client::new();
        let r = exchange_podium_oauth_authorization_code(
            &http,
            &creds,
            "auth-code-here",
            "http://localhost:5173/callback",
        )
        .await
        .expect("exchange");
        assert_eq!(r.refresh_token, "rt-test");
        assert_eq!(r.expires_in, Some(3600));
    }

    #[tokio::test]
    async fn send_email_posts_subject_and_email_channel() {
        let _lock = PODIUM_TEST_ENV_LOCK.lock().unwrap();
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "test-access",
                "expires_in": 3600
            })))
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/v4/messages"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&mock)
            .await;

        let _a = EnvGuard::set("RIVERSIDE_PODIUM_CLIENT_ID", "cid");
        let _b = EnvGuard::set("RIVERSIDE_PODIUM_CLIENT_SECRET", "sec");
        let _c = EnvGuard::set("RIVERSIDE_PODIUM_REFRESH_TOKEN", "rtok");
        let base = mock.uri();
        let _d = EnvGuard::set("RIVERSIDE_PODIUM_API_BASE", base.as_str());
        let token_url = format!("{base}/oauth/token");
        let _e = EnvGuard::set("RIVERSIDE_PODIUM_OAUTH_TOKEN_URL", &token_url);

        let creds = PodiumEnvCredentials::from_env().expect("creds");
        let http = reqwest::Client::new();
        let cache = Arc::new(tokio::sync::Mutex::new(PodiumTokenCache::default()));
        let r = send_v4_message(
            &http,
            &cache,
            &creds,
            "loc-uid",
            "email",
            "buyer@example.com",
            "<p>Hello</p>",
            Some("Subject line"),
            None,
        )
        .await;
        assert!(r.is_ok(), "{r:?}");
    }

    #[test]
    fn parses_documented_location_and_webhook_objects() {
        let locations = parse_podium_locations(json!({
            "data": [{
                "uid": "location-1",
                "name": "Riverside",
                "displayName": "Riverside Men's Shop",
                "archived": false
            }],
            "metadata": { "nextCursor": null }
        }))
        .expect("locations");
        assert_eq!(locations[0].uid, "location-1");
        assert_eq!(
            locations[0].display_name.as_deref(),
            Some("Riverside Men's Shop")
        );

        let webhooks = parse_podium_webhooks(json!({
            "data": [{
                "uid": "webhook-1",
                "locationUid": "location-1",
                "url": "https://ros.example/api/webhooks/podium",
                "disabled": false,
                "eventTypes": ["message.received", "contact.updated"]
            }]
        }))
        .expect("webhooks");
        assert_eq!(webhooks[0].location_uid.as_deref(), Some("location-1"));
        assert_eq!(webhooks[0].event_types.len(), 2);
    }

    #[test]
    fn webhook_subscription_covers_every_processed_provider_event() {
        for event_type in [
            "message.failed",
            "message.received",
            "message.sent",
            "contact.created",
            "contact.deleted",
            "contact.merged",
            "contact.unchanged",
            "contact.updated",
            "review.invite_link_created",
            "review.invite_link_updated",
        ] {
            assert!(PODIUM_REQUIRED_WEBHOOK_EVENT_TYPES.contains(&event_type));
        }
    }
}
