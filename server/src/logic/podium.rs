//! Podium API: OAuth refresh-token flow and outbound SMS via `POST /v4/messages`.
//! Operator setup: https://docs.podium.com/docs/getting-started
//! Send payload shape: https://github.com/podium/podium-api-sample-messages

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::logic::podium_messaging;

const DEFAULT_READY_PICKUP: &str =
    "Hi {first_name}, your Riverside order ({order_ref}) is ready for pickup! See you soon.";
const DEFAULT_ALTERATION_READY: &str =
    "Hi {first_name}, your alteration ({alteration_ref}) is ready at Riverside. See you soon.";
const DEFAULT_UNKNOWN_SENDER_WELCOME: &str = "Thank you for contacting Riverside Men's Shop. Please reply with your first and last name and someone will be with you as soon as possible during regular business hours. Thank you.";
const DEFAULT_LOYALTY_REDEEMED_SMS: &str = "Hi {first_name}, your ${reward_amount} Riverside loyalty reward is processed. {reward_breakdown} Your balance is now {new_balance} points. We may also mail a physical card. Thank you!";

const DEFAULT_EMAIL_READY_SUBJECT: &str = "Your Riverside order is ready";
const DEFAULT_EMAIL_READY_HTML: &str = "<p>Hi {first_name},</p><p>Your Riverside order <b>{order_ref}</b> is ready for pickup. See you soon.</p>";
const DEFAULT_EMAIL_ALTERATION_SUBJECT: &str = "Your alteration is ready";
const DEFAULT_EMAIL_ALTERATION_HTML: &str = "<p>Hi {first_name},</p><p>Your alteration <b>{alteration_ref}</b> is ready at Riverside. See you soon.</p>";
const DEFAULT_EMAIL_APPOINTMENT_SUBJECT: &str = "Appointment confirmed — Riverside";
const DEFAULT_EMAIL_APPOINTMENT_HTML: &str = "<p>Hi {first_name},</p><p>Your <b>{appointment_type}</b> appointment is scheduled for <b>{starts_at}</b>.</p>{notes_block}";
const DEFAULT_EMAIL_LOYALTY_REDEEMED_SUBJECT: &str = "Your Riverside loyalty reward";
const DEFAULT_EMAIL_LOYALTY_REDEEMED_HTML: &str = "<p>Hi {first_name},</p><p>We have processed your <b>${reward_amount}</b> loyalty reward.</p>{reward_breakdown_html}<p>Your loyalty balance is now <b>{new_balance}</b> points.</p><p>We may also mail a physical gift card when applicable.</p><p>Thank you for shopping with us.</p>";

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
    /// Sent only when staff opts in at loyalty reward redemption (`POST /api/loyalty/redeem-reward`).
    #[serde(default)]
    pub loyalty_reward_redeemed: String,
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
            loyalty_reward_redeemed: non_empty_or(
                &self.loyalty_reward_redeemed,
                DEFAULT_LOYALTY_REDEEMED_SMS,
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
    /// Sent only when staff opts in at loyalty reward redemption.
    #[serde(default, alias = "loyalty_reward_eligible_subject")]
    pub loyalty_reward_redeemed_subject: String,
    #[serde(default, alias = "loyalty_reward_eligible_html")]
    pub loyalty_reward_redeemed_html: String,
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
            loyalty_reward_redeemed_subject: non_empty_or(
                &self.loyalty_reward_redeemed_subject,
                DEFAULT_EMAIL_LOYALTY_REDEEMED_SUBJECT,
            ),
            loyalty_reward_redeemed_html: non_empty_or(
                &self.loyalty_reward_redeemed_html,
                DEFAULT_EMAIL_LOYALTY_REDEEMED_HTML,
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
pub struct StorePodiumSmsConfig {
    /// When true and env credentials + location_uid are set, operational SMS uses Podium.
    #[serde(default)]
    pub sms_send_enabled: bool,
    /// When true, transactional / templated emails use Podium (`channel.type`: `email`).
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
}

impl StorePodiumSmsConfig {
    pub fn load_from_json(v: serde_json::Value) -> Self {
        serde_json::from_value(v).unwrap_or_default()
    }
}

#[derive(Debug, Serialize)]
pub struct PodiumSmsSettingsResponse {
    #[serde(flatten)]
    pub settings: StorePodiumSmsConfig,
    pub templates_effective: SmsTemplatesStored,
    pub email_templates_effective: EmailTemplatesStored,
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
    #[error("reqwest error: {0}")]
    Http(#[from] reqwest::Error),
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
}

/// OAuth client credentials from environment (never logged).
#[derive(Debug, Clone)]
pub struct PodiumEnvCredentials {
    pub client_id: String,
    pub client_secret: String,
    pub refresh_token: String,
    pub token_url: String,
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
        })
    }
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
    let base = format!(
        "{}/oauth/authorize",
        podium_rest_api_base().trim_end_matches('/')
    );
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
    let res = http
        .post(&creds.token_url)
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

fn podium_messages_url() -> String {
    format!(
        "{}/v4/messages",
        podium_rest_api_base().trim_end_matches('/')
    )
}

fn podium_messages_attachment_url() -> String {
    format!(
        "{}/v4/messages/attachment",
        podium_rest_api_base().trim_end_matches('/')
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

/// Fire-and-forget operational SMS. Logs `podium_send_ok` / `podium_send_err` (no phone/body).
/// When `crm_customer_id` is set and the send succeeds, appends an **`automated`** row to **`podium_message`** for the customer hub thread.
pub async fn try_send_operational_sms(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_e164: &str,
    body: String,
    crm_customer_id: Option<Uuid>,
) {
    let creds = match PodiumEnvCredentials::from_env() {
        Some(c) => c,
        None => {
            tracing::debug!(
                target = "podium",
                event = "podium_send_skip",
                reason = "no_env_credentials"
            );
            return;
        }
    };

    let cfg = match load_store_podium_config(pool).await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "podium load_store_podium_config failed");
            return;
        }
    };

    if !cfg.sms_send_enabled {
        tracing::debug!(
            target = "podium",
            event = "podium_send_skip",
            reason = "sms_send_disabled"
        );
        return;
    }

    let loc = cfg.location_uid.trim();
    if loc.is_empty() {
        tracing::warn!(
            target = "podium",
            event = "podium_send_err",
            reason_class = "missing_location_uid"
        );
        return;
    }

    let phone_digits: String = to_e164.chars().filter(|c| c.is_ascii_digit()).collect();
    if phone_digits.is_empty() {
        tracing::warn!(
            target = "podium",
            event = "podium_send_err",
            reason_class = "invalid_phone"
        );
        return;
    }

    match send_v4_message(
        http,
        token_cache,
        &creds,
        loc,
        "phone",
        phone_digits.as_str(),
        body.as_str(),
        None,
    )
    .await
    {
        Ok(()) => {
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
                )
                .await
                {
                    tracing::error!(error = %e, customer_id = %cid, "record automated SMS to podium_message");
                }
            }
        }
        Err(e) => {
            let reason = match &e {
                PodiumError::NotConfigured => "not_configured",
                PodiumError::TokenHttp(_s) => "token_http",
                PodiumError::TokenMissing => "token_missing",
                PodiumError::RefreshTokenMissing => "refresh_token_missing",
                PodiumError::SendHttp(_s) => "send_http",
                PodiumError::Http(_) => "http",
            };
            tracing::warn!(target = "podium", event = "podium_send_err", reason_class = reason, error = %e);
        }
    }
}

/// Basic check for Podium email `identifier` (not full RFC validation).
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
) -> Result<(), PodiumError> {
    let token = get_valid_access_token(http, token_cache, creds).await?;
    let url = podium_messages_url();
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

    let res = http
        .post(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await?;

    let status = res.status();
    if status.is_success() {
        return Ok(());
    }
    Err(PodiumError::SendHttp(status.as_u16()))
}

/// Send one SMS via Podium (`channel.type`: `phone`); returns error for API callers (e.g. POS receipt).
pub async fn send_podium_sms_message(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_phone_raw: &str,
    body: &str,
) -> Result<(), PodiumError> {
    let creds = PodiumEnvCredentials::from_env().ok_or(PodiumError::NotConfigured)?;
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
    let phone_digits: String = e164.chars().filter(|c| c.is_ascii_digit()).collect();
    if phone_digits.is_empty() {
        return Err(PodiumError::NotConfigured);
    }
    send_v4_message(
        http,
        token_cache,
        &creds,
        loc,
        "phone",
        phone_digits.as_str(),
        body_t,
        None,
    )
    .await
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
    let creds = PodiumEnvCredentials::from_env().ok_or(PodiumError::NotConfigured)?;
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
    if attachment_png.is_empty() {
        return Err(PodiumError::NotConfigured);
    }
    let Some(e164) = normalize_phone_e164(to_phone_raw) else {
        return Err(PodiumError::NotConfigured);
    };
    let phone_digits: String = e164.chars().filter(|c| c.is_ascii_digit()).collect();
    if phone_digits.is_empty() {
        return Err(PodiumError::NotConfigured);
    }

    let token = get_valid_access_token(http, token_cache, &creds).await?;
    let data = json!({
        "body": body_t,
        "channel": {
            "type": "phone",
            "identifier": phone_digits,
        },
        "locationUid": loc,
    });
    let data_str = serde_json::to_string(&data).map_err(|_| PodiumError::NotConfigured)?;

    let part = reqwest::multipart::Part::bytes(attachment_png)
        .file_name("receipt.png")
        .mime_str("image/png")
        .map_err(|_| PodiumError::NotConfigured)?;
    let form = reqwest::multipart::Form::new()
        .text("data", data_str)
        .part("attachment", part);

    let res = http
        .post(podium_messages_attachment_url())
        .header("Authorization", format!("Bearer {token}"))
        .multipart(form)
        .send()
        .await?;

    let status = res.status();
    if status.is_success() {
        tracing::info!(
            target = "podium",
            event = "podium_send_ok",
            channel = "phone_attachment"
        );
        return Ok(());
    }
    tracing::warn!(
        target = "podium",
        event = "podium_send_err",
        channel = "phone_attachment",
        status = status.as_u16(),
        "Podium attachment send failed"
    );
    Err(PodiumError::SendHttp(status.as_u16()))
}

/// Send one email via Podium; returns error for API callers (e.g. hub compose, POS receipt).
pub async fn send_podium_email_message(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    to_email: &str,
    subject: &str,
    html_body: &str,
) -> Result<(), PodiumError> {
    let creds = PodiumEnvCredentials::from_env().ok_or(PodiumError::NotConfigured)?;
    let cfg = load_store_podium_config(pool).await.map_err(|e| {
        tracing::error!(error = %e, "podium load_store_podium_config failed (email send)");
        PodiumError::NotConfigured
    })?;
    if !cfg.email_send_enabled {
        return Err(PodiumError::NotConfigured);
    }
    let loc = cfg.location_uid.trim();
    if loc.is_empty() {
        return Err(PodiumError::NotConfigured);
    }
    let addr = to_email.trim();
    if !looks_like_email(addr) {
        return Err(PodiumError::NotConfigured);
    }
    let sub = subject.trim();
    if sub.is_empty() {
        return Err(PodiumError::NotConfigured);
    }
    if html_body.trim().is_empty() {
        return Err(PodiumError::NotConfigured);
    }
    send_v4_message(
        http,
        token_cache,
        &creds,
        loc,
        "email",
        addr,
        html_body,
        Some(sub),
    )
    .await
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

    let res = http
        .post(&creds.token_url)
        .header("Content-Type", "application/json")
        .json(&json!({
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "grant_type": "refresh_token",
            "refresh_token": creds.refresh_token,
        }))
        .send()
        .await?;

    if !res.status().is_success() {
        return Err(PodiumError::TokenHttp(res.status().as_u16()));
    }

    let tr: TokenResponse = res.json().await?;
    if tr.access_token.is_empty() {
        return Err(PodiumError::TokenMissing);
    }

    let exp = tr.expires_in.unwrap_or(3600);
    guard.access_token = Some(tr.access_token.clone());
    guard.expires_at = Some(now + Duration::seconds(exp.max(60)));
    Ok(tr.access_token)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::await_holding_lock)]

    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

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
        )
        .await;
        assert!(r.is_ok(), "{r:?}");
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
        )
        .await;
        assert!(r.is_ok(), "{r:?}");
    }
}
