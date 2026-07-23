use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use std::{
    collections::VecDeque,
    net::IpAddr,
    str::FromStr,
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore, SemaphorePermit};

use crate::logic::integration_credentials::{self, IntegrationCredentialError};

pub const HELCIM_PROVIDER_KEY: &str = "helcim";
pub const DEFAULT_HELCIM_API_BASE_URL: &str = "https://api.helcim.com/v2";
pub const SIMULATOR_DEVICE_CODE: &str = "SIM1";

const HELCIM_MAX_RETRIES: u32 = 3;
const HELCIM_BASE_RETRY_DELAY_MS: u64 = 500;
const HELCIM_PAYMENT_IDEMPOTENCY_WINDOW_SECONDS: i64 = 5 * 60;
// The shared HTTP client allows 25 seconds per request and Payment API calls
// may make four total attempts with backoff. Stop replaying well before
// Helcim clears the key so the complete retry sequence remains inside the
// provider's five-minute idempotency window, even with limiter contention.
const HELCIM_PAYMENT_IDEMPOTENCY_RETRY_RESERVE_SECONDS: i64 = 3 * 60;
const HELCIM_MAX_CONCURRENT_REQUESTS: usize = 5;
const HELCIM_MINUTE_REQUEST_LIMIT: u32 = 100;
const HELCIM_HOUR_REQUEST_LIMIT: u32 = 3_000;

#[derive(Debug, Clone)]
pub struct HelcimConfig {
    api_token: Option<String>,
    terminal_1_device_code: Option<String>,
    terminal_2_device_code: Option<String>,
    api_base_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimConfigStatus {
    pub enabled: bool,
    pub api_token_configured: bool,
    pub terminal_1_device_configured: bool,
    pub terminal_2_device_configured: bool,
    pub terminal_payments_ready: bool,
    pub live_terminal_payments_ready: bool,
    pub simulator_enabled: bool,
    pub webhook_secret_configured: bool,
    pub terminal_1_device_code_suffix: Option<String>,
    pub terminal_2_device_code_suffix: Option<String>,
    pub api_base_host: String,
    pub missing_config: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimPurchaseRequest {
    pub currency: String,
    #[serde(rename = "transactionAmount")]
    pub transaction_amount: String,
    #[serde(rename = "invoiceNumber")]
    pub invoice_number: String,
    #[serde(rename = "customerCode", skip_serializing_if = "Option::is_none")]
    pub customer_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimTerminalRefundRequest {
    #[serde(rename = "transactionAmount")]
    pub transaction_amount: String,
    #[serde(rename = "originalTransactionId")]
    pub original_transaction_id: i64,
}

#[derive(Debug)]
pub struct HelcimTerminalRequestError {
    pub status: Option<reqwest::StatusCode>,
    pub message: String,
    pub raw_text: Option<String>,
    /// The request may have reached Helcim even though ROS did not receive a
    /// definitive response. Hardware requests must be recovered, not retried.
    pub outcome_unknown: bool,
}

#[derive(Debug)]
pub struct HelcimPaymentRequestError {
    pub status: Option<reqwest::StatusCode>,
    pub message: String,
    /// True only when the Payment API request may have reached Helcim or a
    /// successful provider response could not be decoded. Callers must retain
    /// the same attempt/idempotency key for recovery instead of starting over.
    pub outcome_unknown: bool,
}

impl std::fmt::Display for HelcimPaymentRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for HelcimPaymentRequestError {}

#[derive(Debug)]
struct HelcimRateState {
    minute_requests: VecDeque<Instant>,
    hour_requests: VecDeque<Instant>,
    provider_minute_remaining: Option<(u32, Instant)>,
    provider_hour_remaining: Option<(u32, Instant)>,
    blocked_until: Option<Instant>,
}

impl HelcimRateState {
    fn new() -> Self {
        Self {
            minute_requests: VecDeque::new(),
            hour_requests: VecDeque::new(),
            provider_minute_remaining: None,
            provider_hour_remaining: None,
            blocked_until: None,
        }
    }

    fn refresh_windows(&mut self, now: Instant) {
        while self
            .minute_requests
            .front()
            .is_some_and(|sent_at| now.duration_since(*sent_at) >= Duration::from_secs(60))
        {
            self.minute_requests.pop_front();
        }
        while self
            .hour_requests
            .front()
            .is_some_and(|sent_at| now.duration_since(*sent_at) >= Duration::from_secs(60 * 60))
        {
            self.hour_requests.pop_front();
        }
        if self
            .provider_minute_remaining
            .is_some_and(|(_, observed_at)| {
                now.duration_since(observed_at) >= Duration::from_secs(60)
            })
        {
            self.provider_minute_remaining = None;
        }
        if self
            .provider_hour_remaining
            .is_some_and(|(_, observed_at)| {
                now.duration_since(observed_at) >= Duration::from_secs(60 * 60)
            })
        {
            self.provider_hour_remaining = None;
        }
        if self
            .blocked_until
            .is_some_and(|blocked_until| blocked_until <= now)
        {
            self.blocked_until = None;
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct HelcimQuotaHeaders {
    retry_after_seconds: Option<u64>,
    minute_remaining: Option<u32>,
    hour_remaining: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimCardData {
    #[serde(rename = "cardToken")]
    pub card_token: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimCardPurchaseRequest {
    #[serde(rename = "ipAddress")]
    pub ip_address: String,
    pub ecommerce: bool,
    pub currency: String,
    pub amount: String,
    #[serde(rename = "customerCode", skip_serializing_if = "Option::is_none")]
    pub customer_code: Option<String>,
    #[serde(rename = "invoiceNumber", skip_serializing_if = "Option::is_none")]
    pub invoice_number: Option<String>,
    #[serde(rename = "cardData")]
    pub card_data: HelcimCardData,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimCardRefundRequest {
    #[serde(rename = "originalTransactionId")]
    pub original_transaction_id: i64,
    pub amount: String,
    #[serde(rename = "ipAddress")]
    pub ip_address: String,
    pub ecommerce: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimCardReverseRequest {
    #[serde(rename = "cardTransactionId")]
    pub card_transaction_id: i64,
    #[serde(rename = "ipAddress")]
    pub ip_address: String,
    pub ecommerce: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimPayInitializeRequest {
    #[serde(rename = "paymentType")]
    pub payment_type: String,
    pub amount: String,
    pub currency: String,
    #[serde(rename = "paymentMethod")]
    pub payment_method: String,
    #[serde(rename = "customerCode", skip_serializing_if = "Option::is_none")]
    pub customer_code: Option<String>,
    #[serde(rename = "invoiceNumber", skip_serializing_if = "Option::is_none")]
    pub invoice_number: Option<String>,
    #[serde(
        rename = "hideExistingPaymentDetails",
        skip_serializing_if = "Option::is_none"
    )]
    pub hide_existing_payment_details: Option<i32>,
    #[serde(
        rename = "setAsDefaultPaymentMethod",
        skip_serializing_if = "Option::is_none"
    )]
    pub set_as_default_payment_method: Option<i32>,
    #[serde(rename = "confirmationScreen")]
    pub confirmation_screen: bool,
    #[serde(
        rename = "displayContactFields",
        skip_serializing_if = "Option::is_none"
    )]
    pub display_contact_fields: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HelcimAcceptedPurchaseResponse {
    pub status: Option<String>,
    #[serde(rename = "paymentId")]
    pub payment_id: Option<String>,
    #[serde(rename = "transactionId")]
    pub transaction_id: Option<String>,
    #[serde(rename = "auditReference")]
    pub audit_reference: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimPendingAttempt {
    pub provider: &'static str,
    pub status: &'static str,
    pub amount_cents: i64,
    pub currency: String,
    pub terminal_id: String,
    pub idempotency_key: String,
    pub provider_payment_id: Option<String>,
    pub provider_transaction_id: Option<String>,
    pub raw_audit_reference: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HelcimPayInitializeResponse {
    #[serde(rename = "checkoutToken")]
    pub checkout_token: String,
    #[serde(rename = "secretToken")]
    pub secret_token: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HelcimCardTransaction {
    #[serde(rename = "transactionId")]
    pub transaction_id: Value,
    pub status: Option<String>,
    pub amount: Value,
    pub currency: Option<String>,
    #[serde(rename = "cardType")]
    pub card_type: Option<String>,
    #[serde(rename = "approvalCode")]
    pub approval_code: Option<String>,
    #[serde(rename = "cardNumber")]
    pub card_number: Option<String>,
    #[serde(rename = "invoiceNumber")]
    pub invoice_number: Option<String>,
    pub warning: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimFeeDetails {
    pub merchant_fee: Option<Decimal>,
    pub net_amount: Option<Decimal>,
    pub card_batch_id: Option<String>,
    pub source_field: Option<String>,
    pub net_source_field: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelcimCardReturnAction {
    Refund,
    Reverse,
}

pub fn card_return_action(
    batch_status: Option<&str>,
    original_amount_cents: i64,
    requested_amount_cents: i64,
    already_refunded_cents: i64,
) -> Result<HelcimCardReturnAction, String> {
    let status = batch_status
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Helcim card batch status is unavailable; no refund was sent".to_string())?
        .to_ascii_lowercase();
    let open_batch = matches!(status.as_str(), "open" | "opened" | "active" | "pending");
    let closed_batch = matches!(
        status.as_str(),
        "closed" | "settled" | "completed" | "deposited"
    );
    if closed_batch {
        return Ok(HelcimCardReturnAction::Refund);
    }
    if open_batch && already_refunded_cents == 0 && requested_amount_cents == original_amount_cents
    {
        return Ok(HelcimCardReturnAction::Reverse);
    }
    if open_batch {
        Err(
            "Helcim only permits a full reversal while the original card batch is open. Close the batch before issuing a partial refund."
                .to_string(),
        )
    } else {
        Err(format!(
            "Helcim card batch status `{status}` is not recognized as open or closed; no refund was sent"
        ))
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HelcimCardBatchSnapshot {
    pub provider_batch_id: String,
    pub status: Option<String>,
    pub currency: Option<String>,
    pub opened_at: Option<DateTime<Utc>>,
    pub closed_at: Option<DateTime<Utc>>,
    pub settled_at: Option<DateTime<Utc>>,
    pub expected_deposit_at: Option<DateTime<Utc>>,
    pub gross_amount: Option<Decimal>,
    pub fee_amount: Option<Decimal>,
    pub net_amount: Option<Decimal>,
    pub transaction_count: Option<i32>,
    pub raw_payload: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HelcimBatchTransactionSnapshot {
    pub provider_batch_id: String,
    pub provider_transaction_id: String,
    pub transaction_type: Option<String>,
    pub status: Option<String>,
    pub currency: Option<String>,
    pub occurred_at: Option<DateTime<Utc>>,
    pub settled_at: Option<DateTime<Utc>>,
    pub gross_amount: Option<Decimal>,
    pub fee_amount: Option<Decimal>,
    pub net_amount: Option<Decimal>,
    pub raw_payload: Value,
}

#[derive(Debug, Clone, Default)]
pub struct HelcimCardBatchesQuery {
    pub batch_number: Option<i64>,
    pub terminal_id: Option<i64>,
    pub collect_stats: bool,
}

#[derive(Debug, Clone)]
pub struct HelcimCardTransactionsQuery {
    pub date_from: Option<NaiveDate>,
    pub date_to: Option<NaiveDate>,
    pub card_batch_id: Option<String>,
    pub invoice_number: Option<String>,
    pub limit: Option<i32>,
    pub page: Option<i32>,
}

#[derive(Debug, Clone, Default)]
pub struct HelcimDevicesQuery {
    pub code: Option<String>,
    pub limit: Option<i32>,
    pub page: Option<i32>,
}

impl HelcimConfig {
    pub fn from_env() -> Self {
        let mut api_token = non_empty_env("HELCIM_API_TOKEN");
        let terminal_1_device_code = non_empty_env("HELCIM_TERMINAL_1_DEVICE_CODE");
        let terminal_2_device_code = non_empty_env("HELCIM_TERMINAL_2_DEVICE_CODE");
        let api_base_url = non_empty_env("HELCIM_API_BASE_URL")
            .map(|value| match validate_helcim_api_base_url(&value) {
                Ok(value) => value,
                Err(error) => {
                    // An explicit but invalid development/test override must
                    // not silently redirect a real credential to production.
                    // Keep the canonical URL for status display, but disable
                    // live API calls until the override is corrected.
                    api_token = None;
                    tracing::error!(%error, "Disabling Helcim API because its explicit base URL is unsafe");
                    DEFAULT_HELCIM_API_BASE_URL.to_string()
                }
            })
            .unwrap_or_else(|| DEFAULT_HELCIM_API_BASE_URL.to_string());

        Self {
            api_token,
            terminal_1_device_code,
            terminal_2_device_code,
            api_base_url,
        }
    }

    pub fn enabled(&self) -> bool {
        self.api_enabled()
    }

    pub fn api_enabled(&self) -> bool {
        self.api_token.is_some() || self.simulator_enabled()
    }

    pub fn device_code_for_register_lane(&self, register_lane: i16) -> Option<&str> {
        match register_lane {
            1 => self.terminal_1_device_code.as_deref(),
            2 => self.terminal_2_device_code.as_deref(),
            _ => None,
        }
        .or_else(|| {
            if self.simulator_enabled() {
                Some(SIMULATOR_DEVICE_CODE)
            } else {
                None
            }
        })
    }

    pub fn device_code_for_terminal_key(&self, terminal_key: &str) -> Option<&str> {
        match terminal_key {
            "terminal_1" => self.terminal_1_device_code.as_deref(),
            "terminal_2" => self.terminal_2_device_code.as_deref(),
            _ => None,
        }
        .or_else(|| {
            if self.simulator_enabled() && matches!(terminal_key, "terminal_1" | "terminal_2") {
                Some(SIMULATOR_DEVICE_CODE)
            } else {
                None
            }
        })
    }

    pub fn api_token(&self) -> Option<&str> {
        self.api_token.as_deref()
    }

    pub fn api_base_url(&self) -> &str {
        &self.api_base_url
    }

    pub fn simulator_enabled(&self) -> bool {
        env_truthy("HELCIM_SIMULATOR_ENABLED") && !env_truthy("RIVERSIDE_STRICT_PRODUCTION")
    }

    pub fn status(&self) -> HelcimConfigStatus {
        let mut missing_config = Vec::new();
        let simulator_enabled = self.simulator_enabled();
        let api_token_configured = self.api_token.is_some();
        let terminal_1_device_configured =
            self.device_code_for_terminal_key("terminal_1").is_some();
        let terminal_2_device_configured =
            self.device_code_for_terminal_key("terminal_2").is_some();
        let webhook_secret_configured = non_empty_env("HELCIM_WEBHOOK_SECRET").is_some();
        let any_terminal_device_configured =
            terminal_1_device_configured || terminal_2_device_configured;
        let live_terminal_payments_ready = api_token_configured && any_terminal_device_configured;

        if let Some(explicit_base_url) = non_empty_env("HELCIM_API_BASE_URL") {
            if let Err(error) = validate_helcim_api_base_url(&explicit_base_url) {
                missing_config.push(format!(
                    "Helcim API host is invalid; live calls are disabled. {error}"
                ));
            }
        }
        if !simulator_enabled && !api_token_configured {
            missing_config
                .push("Helcim API token is not saved in Backoffice Settings.".to_string());
        }
        if !simulator_enabled && !terminal_1_device_configured {
            missing_config.push(
                "Helcim Register #1 terminal device code is not saved in Backoffice Settings."
                    .to_string(),
            );
        }
        if !simulator_enabled && !terminal_2_device_configured {
            missing_config.push(
                "Helcim Register #2 terminal device code is not saved in Backoffice Settings."
                    .to_string(),
            );
        }
        HelcimConfigStatus {
            enabled: self.enabled(),
            api_token_configured,
            terminal_1_device_configured,
            terminal_2_device_configured,
            terminal_payments_ready: simulator_enabled || live_terminal_payments_ready,
            live_terminal_payments_ready,
            simulator_enabled,
            webhook_secret_configured,
            terminal_1_device_code_suffix: self
                .device_code_for_terminal_key("terminal_1")
                .map(mask_suffix),
            terminal_2_device_code_suffix: self
                .device_code_for_terminal_key("terminal_2")
                .map(mask_suffix),
            api_base_host: api_base_host(&self.api_base_url),
            missing_config,
        }
    }
}

pub fn helcim_custom_api_base_url_allowed() -> bool {
    !env_truthy("RIVERSIDE_STRICT_PRODUCTION") && env_truthy("HELCIM_ALLOW_CUSTOM_API_BASE_URL")
}

pub fn validate_helcim_api_base_url(value: &str) -> Result<String, String> {
    let normalized = value.trim().trim_end_matches('/');
    if normalized == DEFAULT_HELCIM_API_BASE_URL {
        return Ok(DEFAULT_HELCIM_API_BASE_URL.to_string());
    }
    if env_truthy("RIVERSIDE_STRICT_PRODUCTION") {
        return Err(format!(
            "Strict production requires the Helcim API host {DEFAULT_HELCIM_API_BASE_URL}."
        ));
    }
    if !helcim_custom_api_base_url_allowed() {
        return Err(format!(
            "Custom Helcim API hosts are disabled. Use {DEFAULT_HELCIM_API_BASE_URL}, or explicitly enable HELCIM_ALLOW_CUSTOM_API_BASE_URL only in development/test."
        ));
    }

    let parsed = reqwest::Url::parse(normalized)
        .map_err(|_| "Helcim API host must be a valid URL.".to_string())?;
    if parsed.username() != "" || parsed.password().is_some() {
        return Err("Helcim API host must not include URL credentials.".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Helcim API host must not include a query or fragment.".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Helcim API host must include a hostname.".to_string())?;
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false);
    match parsed.scheme() {
        "https" => {}
        "http" if loopback => {}
        "http" => {
            return Err(
                "Custom non-HTTPS Helcim API hosts are allowed only on loopback in development/test."
                    .to_string(),
            );
        }
        _ => return Err("Helcim API host must use HTTPS.".to_string()),
    }

    Ok(normalized.to_string())
}

pub fn redact_provider_payload(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut redacted = serde_json::Map::new();
            for (key, value) in object {
                if helcim_field_is_sensitive(key) {
                    redacted.insert(key.clone(), Value::String("[REDACTED]".to_string()));
                } else {
                    redacted.insert(key.clone(), redact_provider_payload(value));
                }
            }
            Value::Object(redacted)
        }
        Value::Array(values) => Value::Array(values.iter().map(redact_provider_payload).collect()),
        _ => value.clone(),
    }
}

pub fn redact_provider_text(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    match serde_json::from_str::<Value>(trimmed) {
        Ok(value) => redact_provider_payload(&value).to_string(),
        Err(_) => redact_sensitive_text_fragments(trimmed),
    }
}

pub async fn apply_persisted_helcim_config_to_env(
    pool: &PgPool,
) -> Result<(), IntegrationCredentialError> {
    integration_credentials::apply_integration_credentials_to_env(pool, HELCIM_PROVIDER_KEY).await
}

impl HelcimCardTransaction {
    pub fn transaction_id_string(&self) -> Option<String> {
        value_to_string(&self.transaction_id)
    }

    pub fn amount_cents(&self) -> Option<i64> {
        let amount = match &self.amount {
            Value::Number(number) => number.to_string(),
            Value::String(value) => value.trim().to_string(),
            _ => return None,
        };
        let decimal = rust_decimal::Decimal::from_str(&amount).ok()?;
        (decimal * rust_decimal::Decimal::from(100))
            .round_dp(0)
            .to_string()
            .parse::<i64>()
            .ok()
    }

    pub fn normalized_status(&self) -> String {
        let status = self
            .status
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        match status.as_str() {
            "approved" | "approval" | "captured" | "capture" => "approved".to_string(),
            "declined" | "decline" => "failed".to_string(),
            "cancelled" | "canceled" => "canceled".to_string(),
            "failed" | "error" => "failed".to_string(),
            _ => "failed".to_string(),
        }
    }

    pub fn provider_status(&self) -> Option<String> {
        self.status
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    pub fn transaction_type(&self) -> Option<String> {
        first_string_field(
            &Value::Object(self.extra.clone()),
            &["transactionType", "transaction_type", "type"],
        )
    }

    pub fn card_last4(&self) -> Option<String> {
        let digits: String = self
            .card_number
            .as_deref()?
            .chars()
            .filter(|c| c.is_ascii_digit())
            .collect();
        if digits.len() < 4 {
            return None;
        }
        Some(digits[digits.len().saturating_sub(4)..].to_string())
    }

    pub fn card_brand(&self) -> Option<String> {
        self.card_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_ascii_lowercase())
    }

    pub fn audit_reference(&self) -> Option<String> {
        let transaction_id = self.transaction_id_string()?;
        Some(format!("helcim:cardTransaction:{transaction_id}"))
    }
}

impl HelcimFeeDetails {
    pub fn from_card_transaction(transaction: &HelcimCardTransaction) -> Self {
        let mut root = serde_json::Map::new();
        if let Ok(Value::Object(serialized)) = serde_json::to_value(transaction) {
            root = serialized;
        }
        extract_fee_details(&Value::Object(root))
    }
}

impl HelcimCardBatchesQuery {
    fn query_params(&self) -> Vec<(&str, String)> {
        let mut query = Vec::new();
        if let Some(batch_number) = self.batch_number {
            query.push(("batchNumber", batch_number.to_string()));
        }
        if let Some(terminal_id) = self.terminal_id {
            query.push(("terminalId", terminal_id.to_string()));
        }
        if self.collect_stats {
            query.push(("collect-stats", "true".to_string()));
        }
        query
    }
}

impl HelcimCardTransactionsQuery {
    fn query_params(&self) -> Vec<(&str, String)> {
        let mut query = Vec::new();
        if let Some(date_from) = self.date_from {
            query.push(("dateFrom", date_from.format("%Y-%m-%d").to_string()));
        }
        if let Some(date_to) = self.date_to {
            query.push(("dateTo", date_to.format("%Y-%m-%d").to_string()));
        }
        if let Some(batch_id) = self
            .card_batch_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            query.push(("cardBatchId", batch_id.to_string()));
        }
        if let Some(invoice_number) = self
            .invoice_number
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            query.push(("invoiceNumber", invoice_number.to_string()));
        }
        if let Some(limit) = self.limit {
            query.push(("limit", limit.to_string()));
        }
        if let Some(page) = self.page {
            query.push(("page", page.to_string()));
        }
        query
    }
}

impl HelcimDevicesQuery {
    fn query_params(&self) -> Vec<(&str, String)> {
        let mut query = Vec::new();
        if let Some(code) = self
            .code
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            query.push(("code", code.to_string()));
        }
        if let Some(limit) = self.limit {
            query.push(("limit", limit.clamp(1, 100).to_string()));
        }
        if let Some(page) = self.page {
            query.push(("page", page.max(0).to_string()));
        }
        query
    }
}

pub fn extract_fee_details(payload: &Value) -> HelcimFeeDetails {
    const FEE_FIELDS: &[&str] = &[
        "merchantFee",
        "merchant_fee",
        "processingFee",
        "processing_fee",
        "transactionFee",
        "transaction_fee",
        "feeAmount",
        "fee_amount",
        "fee",
        "fees",
    ];
    const NET_FIELDS: &[&str] = &["netAmount", "net_amount", "net"];

    let fee = first_decimal_field(payload, FEE_FIELDS);
    let net = first_decimal_field(payload, NET_FIELDS);
    let net_amount = net.as_ref().map(|(_, amount)| *amount);
    let merchant_fee = fee.as_ref().map(|(_, amount)| *amount);
    let source_field = fee.map(|(field, _)| field);
    let net_source_field = net.map(|(field, _)| field);
    let card_batch_id = first_string_field(payload, &["cardBatchId", "card_batch_id"]);

    HelcimFeeDetails {
        merchant_fee,
        net_amount,
        card_batch_id,
        source_field,
        net_source_field,
    }
}

pub fn parse_card_batch_snapshot(payload: &Value) -> Option<HelcimCardBatchSnapshot> {
    let provider_batch_id = first_string_field(
        payload,
        &["cardBatchId", "card_batch_id", "batchId", "batch_id", "id"],
    )?;
    Some(HelcimCardBatchSnapshot {
        provider_batch_id,
        status: first_string_field(payload, &["status", "batchStatus", "batch_status"]).or_else(
            || {
                first_bool_field(payload, &["closed"]).map(|closed| {
                    if closed {
                        "closed".to_string()
                    } else {
                        "open".to_string()
                    }
                })
            },
        ),
        currency: first_string_field(payload, &["currency"]),
        opened_at: first_timestamp_field(
            payload,
            &["openedAt", "opened_at", "openDate", "dateCreated"],
        ),
        closed_at: first_timestamp_field(
            payload,
            &["closedAt", "closed_at", "closedDate", "dateClosed"],
        ),
        settled_at: first_timestamp_field(payload, &["settledAt", "settled_at", "settlementDate"]),
        expected_deposit_at: first_timestamp_field(
            payload,
            &["expectedDepositAt", "expected_deposit_at", "depositDate"],
        ),
        gross_amount: first_decimal_field(
            payload,
            &[
                "grossAmount",
                "gross_amount",
                "grossSales",
                "gross_sales",
                "totalAmount",
                "totalSales",
            ],
        )
        .map(|(_, amount)| amount),
        fee_amount: first_decimal_field(
            payload,
            &[
                "feeAmount",
                "fee_amount",
                "totalFees",
                "total_fees",
                "merchantFee",
            ],
        )
        .map(|(_, amount)| amount),
        net_amount: first_decimal_field(
            payload,
            &["depositAmount", "deposit_amount", "netAmount", "net_amount"],
        )
        .map(|(_, amount)| amount),
        transaction_count: first_i32_field(
            payload,
            &[
                "transactionCount",
                "transaction_count",
                "count",
                "countTotal",
            ],
        ),
        raw_payload: payload.clone(),
    })
}

pub fn parse_card_batch_snapshots(payload: &Value) -> Vec<HelcimCardBatchSnapshot> {
    match payload {
        Value::Array(values) => values
            .iter()
            .filter_map(parse_card_batch_snapshot)
            .collect(),
        Value::Object(map) => {
            for key in ["cardBatches", "batches", "data", "items", "results"] {
                if let Some(Value::Array(values)) = map.get(key) {
                    return values
                        .iter()
                        .filter_map(parse_card_batch_snapshot)
                        .collect();
                }
            }
            parse_card_batch_snapshot(payload).into_iter().collect()
        }
        _ => Vec::new(),
    }
}

pub fn parse_batch_transaction_snapshot(
    payload: &Value,
    fallback_batch_id: Option<&str>,
) -> Option<HelcimBatchTransactionSnapshot> {
    let provider_batch_id = first_string_field(
        payload,
        &["cardBatchId", "card_batch_id", "batchId", "batch_id"],
    )
    .or_else(|| {
        fallback_batch_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })?;
    let provider_transaction_id = first_string_field(
        payload,
        &[
            "transactionId",
            "transaction_id",
            "cardTransactionId",
            "card_transaction_id",
            "id",
        ],
    )?;
    let fee_details = extract_fee_details(payload);
    Some(HelcimBatchTransactionSnapshot {
        provider_batch_id,
        provider_transaction_id,
        transaction_type: first_string_field(
            payload,
            &["transactionType", "transaction_type", "type"],
        ),
        status: first_string_field(
            payload,
            &["status", "transactionStatus", "transaction_status"],
        ),
        currency: first_string_field(payload, &["currency"]),
        occurred_at: first_timestamp_field(
            payload,
            &[
                "occurredAt",
                "occurred_at",
                "createdAt",
                "created_at",
                "dateCreated",
            ],
        ),
        settled_at: first_timestamp_field(payload, &["settledAt", "settled_at", "settlementDate"]),
        gross_amount: first_decimal_field(payload, &["amount", "grossAmount", "gross_amount"])
            .map(|(_, amount)| amount),
        fee_amount: fee_details.merchant_fee,
        net_amount: fee_details.net_amount,
        raw_payload: payload.clone(),
    })
}

pub fn parse_batch_transaction_snapshots(
    payload: &Value,
    fallback_batch_id: Option<&str>,
) -> Vec<HelcimBatchTransactionSnapshot> {
    match payload {
        Value::Array(values) => values
            .iter()
            .filter_map(|value| parse_batch_transaction_snapshot(value, fallback_batch_id))
            .collect(),
        Value::Object(map) => {
            for key in [
                "transactions",
                "cardTransactions",
                "data",
                "items",
                "results",
            ] {
                if let Some(Value::Array(values)) = map.get(key) {
                    return values
                        .iter()
                        .filter_map(|value| {
                            parse_batch_transaction_snapshot(value, fallback_batch_id)
                        })
                        .collect();
                }
            }
            parse_batch_transaction_snapshot(payload, fallback_batch_id)
                .into_iter()
                .collect()
        }
        _ => Vec::new(),
    }
}

pub fn invoice_number_from_payload(payload: &Value) -> Option<String> {
    first_string_field(payload, &["invoiceNumber", "invoice_number"])
}

fn first_decimal_field(payload: &Value, fields: &[&str]) -> Option<(String, Decimal)> {
    match payload {
        Value::Object(map) => {
            for field in fields {
                if let Some(value) = map.get(*field).and_then(decimal_from_value) {
                    return Some(((*field).to_string(), value.round_dp(2)));
                }
            }
            for value in map.values() {
                if let Some(found) = first_decimal_field(value, fields) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(values) => values
            .iter()
            .find_map(|value| first_decimal_field(value, fields)),
        _ => None,
    }
}

fn first_string_field(payload: &Value, fields: &[&str]) -> Option<String> {
    match payload {
        Value::Object(map) => {
            for field in fields {
                if let Some(value) = map.get(*field).and_then(value_to_string) {
                    return Some(value);
                }
            }
            for value in map.values() {
                if let Some(found) = first_string_field(value, fields) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(values) => values
            .iter()
            .find_map(|value| first_string_field(value, fields)),
        _ => None,
    }
}

fn first_i32_field(payload: &Value, fields: &[&str]) -> Option<i32> {
    match payload {
        Value::Object(map) => {
            for field in fields {
                if let Some(value) = map.get(*field).and_then(i32_from_value) {
                    return Some(value);
                }
            }
            for value in map.values() {
                if let Some(found) = first_i32_field(value, fields) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(values) => values
            .iter()
            .find_map(|value| first_i32_field(value, fields)),
        _ => None,
    }
}

fn first_bool_field(payload: &Value, fields: &[&str]) -> Option<bool> {
    match payload {
        Value::Object(map) => {
            for field in fields {
                if let Some(value) = map.get(*field).and_then(bool_from_value) {
                    return Some(value);
                }
            }
            for value in map.values() {
                if let Some(found) = first_bool_field(value, fields) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(values) => values
            .iter()
            .find_map(|value| first_bool_field(value, fields)),
        _ => None,
    }
}

fn first_timestamp_field(payload: &Value, fields: &[&str]) -> Option<DateTime<Utc>> {
    match payload {
        Value::Object(map) => {
            for field in fields {
                if let Some(value) = map.get(*field).and_then(timestamp_from_value) {
                    return Some(value);
                }
            }
            for value in map.values() {
                if let Some(found) = first_timestamp_field(value, fields) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(values) => values
            .iter()
            .find_map(|value| first_timestamp_field(value, fields)),
        _ => None,
    }
}

fn decimal_from_value(value: &Value) -> Option<Decimal> {
    let raw = match value {
        Value::Number(number) => number.to_string(),
        Value::String(value) => value.trim().trim_start_matches('$').to_string(),
        _ => return None,
    };
    Decimal::from_str_exact(&raw).ok()
}

fn i32_from_value(value: &Value) -> Option<i32> {
    match value {
        Value::Number(number) => number.as_i64().and_then(|value| i32::try_from(value).ok()),
        Value::String(value) => value.trim().parse::<i32>().ok(),
        _ => None,
    }
}

fn bool_from_value(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::Number(number) => number.as_i64().map(|value| value != 0),
        Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn timestamp_from_value(value: &Value) -> Option<DateTime<Utc>> {
    let raw = value_to_string(value)?;
    if raw.starts_with("0000-00-00") {
        return None;
    }
    DateTime::parse_from_rfc3339(&raw)
        .map(|value| value.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            NaiveDateTime::parse_from_str(&raw, "%Y-%m-%d %H:%M:%S")
                .ok()
                .and_then(|value| {
                    chrono_tz::America::Edmonton
                        .from_local_datetime(&value)
                        .single()
                        .map(|value| value.with_timezone(&Utc))
                })
        })
        .or_else(|| {
            NaiveDate::parse_from_str(&raw, "%Y-%m-%d")
                .ok()
                .and_then(|value| value.and_hms_opt(0, 0, 0))
                .and_then(|value| {
                    chrono_tz::America::Edmonton
                        .from_local_datetime(&value)
                        .single()
                        .map(|value| value.with_timezone(&Utc))
                })
        })
}

fn helcim_request_semaphore() -> &'static Semaphore {
    static SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Semaphore::new(HELCIM_MAX_CONCURRENT_REQUESTS))
}

fn helcim_rate_state() -> &'static Mutex<HelcimRateState> {
    static STATE: OnceLock<Mutex<HelcimRateState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HelcimRateState::new()))
}

async fn acquire_helcim_request_permit(context: &str) -> Result<SemaphorePermit<'static>, String> {
    let permit = helcim_request_semaphore()
        .acquire()
        .await
        .map_err(|_| format!("{context} could not acquire the Helcim request limiter"))?;

    let now = Instant::now();
    let mut state = helcim_rate_state().lock().await;
    state.refresh_windows(now);
    if let Some(blocked_until) = state.blocked_until {
        let retry_after = blocked_until
            .duration_since(now)
            .as_secs()
            .saturating_add(1);
        return Err(format!(
            "{context} paused by Helcim rate limiting; retry after {retry_after} seconds"
        ));
    }
    if let Some((0, observed_at)) = state.provider_minute_remaining {
        let retry_after = Duration::from_secs(60)
            .saturating_sub(now.duration_since(observed_at))
            .as_secs()
            .saturating_add(1);
        return Err(format!(
            "{context} paused because Helcim reports no minute quota remaining; retry after {retry_after} seconds"
        ));
    }
    if let Some((0, observed_at)) = state.provider_hour_remaining {
        let retry_after = Duration::from_secs(60 * 60)
            .saturating_sub(now.duration_since(observed_at))
            .as_secs()
            .saturating_add(1);
        return Err(format!(
            "{context} paused because Helcim reports no hourly quota remaining; retry after {retry_after} seconds"
        ));
    }
    if state.minute_requests.len() >= HELCIM_MINUTE_REQUEST_LIMIT as usize {
        let oldest = *state
            .minute_requests
            .front()
            .expect("minute request window is non-empty at its limit");
        let retry_after = Duration::from_secs(60)
            .saturating_sub(now.duration_since(oldest))
            .as_secs()
            .saturating_add(1);
        return Err(format!(
            "{context} paused before exceeding Helcim's 100 requests/minute limit; retry after {retry_after} seconds"
        ));
    }
    if state.hour_requests.len() >= HELCIM_HOUR_REQUEST_LIMIT as usize {
        let oldest = *state
            .hour_requests
            .front()
            .expect("hour request window is non-empty at its limit");
        let retry_after = Duration::from_secs(60 * 60)
            .saturating_sub(now.duration_since(oldest))
            .as_secs()
            .saturating_add(1);
        return Err(format!(
            "{context} paused before exceeding Helcim's 3000 requests/hour limit; retry after {retry_after} seconds"
        ));
    }
    state.minute_requests.push_back(now);
    state.hour_requests.push_back(now);
    if let Some((remaining, observed_at)) = state.provider_minute_remaining {
        state.provider_minute_remaining = Some((remaining.saturating_sub(1), observed_at));
    }
    if let Some((remaining, observed_at)) = state.provider_hour_remaining {
        state.provider_hour_remaining = Some((remaining.saturating_sub(1), observed_at));
    }
    drop(state);
    Ok(permit)
}

fn parse_quota_header<T>(headers: &reqwest::header::HeaderMap, name: &str) -> Option<T>
where
    T: FromStr,
{
    headers.get(name)?.to_str().ok()?.trim().parse::<T>().ok()
}

fn helcim_quota_headers(headers: &reqwest::header::HeaderMap) -> HelcimQuotaHeaders {
    HelcimQuotaHeaders {
        retry_after_seconds: parse_quota_header(headers, "retry-after"),
        minute_remaining: parse_quota_header(headers, "minute-limit-remaining"),
        hour_remaining: parse_quota_header(headers, "hour-limit-remaining"),
    }
}

async fn observe_helcim_quota_headers(
    headers: &reqwest::header::HeaderMap,
    status: reqwest::StatusCode,
) -> HelcimQuotaHeaders {
    let quota = helcim_quota_headers(headers);
    let now = Instant::now();
    let mut state = helcim_rate_state().lock().await;
    state.refresh_windows(now);
    if let Some(remaining) = quota.minute_remaining {
        state.provider_minute_remaining = Some((remaining.min(HELCIM_MINUTE_REQUEST_LIMIT), now));
    }
    if let Some(remaining) = quota.hour_remaining {
        state.provider_hour_remaining = Some((remaining.min(HELCIM_HOUR_REQUEST_LIMIT), now));
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_after_seconds = quota.retry_after_seconds.unwrap_or_else(|| {
            if quota.hour_remaining == Some(0) {
                60 * 60
            } else {
                60
            }
        });
        let candidate = now + Duration::from_secs(retry_after_seconds);
        state.blocked_until = Some(
            state
                .blocked_until
                .map_or(candidate, |current| current.max(candidate)),
        );
    }
    quota
}

async fn send_request_with_retry<F, Fut>(
    context: &str,
    make_request: F,
) -> Result<reqwest::Response, String>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = reqwest::Result<reqwest::Response>>,
{
    let mut last_error = String::new();
    for attempt in 0..=HELCIM_MAX_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(helcim_retry_delay(attempt - 1)).await;
            tracing::info!(attempt, context, "Retrying Helcim request");
        }
        let _permit = acquire_helcim_request_permit(context).await?;
        let response = match make_request().await {
            Ok(r) => r,
            Err(e) => {
                if e.is_timeout() || e.is_connect() {
                    last_error = format!("{context} network error: {e}");
                    continue;
                }
                return Err(format!("{context} failed: {e}"));
            }
        };
        let status = response.status();
        let quota = observe_helcim_quota_headers(response.headers(), status).await;
        if !status.is_success() {
            let raw_text = response.text().await.unwrap_or_default();
            if is_retryable_helcim_error(status, Some(&raw_text)) && attempt < HELCIM_MAX_RETRIES {
                last_error = response_error_message_sync(context, status, &raw_text, &quota);
                continue;
            }
            return Err(response_error_message_sync(
                context, status, &raw_text, &quota,
            ));
        }
        return Ok(response);
    }
    Err(format!("{context} failed after retries: {last_error}"))
}

pub async fn fetch_card_transaction(
    http: &reqwest::Client,
    config: &HelcimConfig,
    transaction_id: &str,
) -> Result<HelcimCardTransaction, String> {
    let token = config
        .api_token()
        .ok_or_else(|| "Helcim API token is not saved in Backoffice Settings.".to_string())?;
    let url = format!(
        "{}/card-transactions/{transaction_id}",
        config.api_base_url()
    );
    let response = send_request_with_retry("Helcim transaction lookup", || {
        http.get(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header("api-token", token)
            .send()
    })
    .await?;
    response
        .json::<HelcimCardTransaction>()
        .await
        .map_err(|e| e.to_string())
}

pub async fn get_customers(
    http: &reqwest::Client,
    config: &HelcimConfig,
    query: &[(&str, String)],
) -> Result<Value, String> {
    send_get_request(http, config, "customers/", query).await
}

/// Ensure a POS customer exists in Helcim before a terminal purchase starts.
/// Terminal purchases accept only a Helcim customerCode; creating the profile
/// first is what gives Helcim the contact name shown in its dashboard.
pub async fn ensure_customer_profile(
    http: &reqwest::Client,
    config: &HelcimConfig,
    customer_code: &str,
    contact_name: &str,
    phone: Option<&str>,
) -> Result<String, String> {
    let query = [("customerCode", customer_code.to_string())];
    let existing = get_customers(http, config, &query).await?;
    let has_existing = existing
        .as_array()
        .map(|rows| !rows.is_empty())
        .or_else(|| {
            existing
                .get("customers")
                .and_then(Value::as_array)
                .map(|rows| !rows.is_empty())
        })
        .unwrap_or(false);
    if has_existing {
        return Ok(customer_code.to_string());
    }

    let token = config
        .api_token()
        .ok_or_else(|| "Helcim API token is not saved in Backoffice Settings.".to_string())?;
    let mut body = serde_json::Map::new();
    body.insert(
        "customerCode".to_string(),
        Value::String(customer_code.to_string()),
    );
    body.insert(
        "contactName".to_string(),
        Value::String(contact_name.to_string()),
    );
    if let Some(phone) = phone.map(str::trim).filter(|value| !value.is_empty()) {
        body.insert("cellPhone".to_string(), Value::String(phone.to_string()));
    }
    let _permit = acquire_helcim_request_permit("Helcim customer creation").await?;
    let response = http
        .post(format!("{}/customers", config.api_base_url()))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("api-token", token)
        .json(&Value::Object(body))
        .send()
        .await
        .map_err(|e| format!("Helcim customer request failed: {e}"))?;
    let status = response.status();
    let quota = observe_helcim_quota_headers(response.headers(), status).await;
    if !status.is_success() {
        let raw_text = response.text().await.unwrap_or_default();
        return Err(response_error_message_sync(
            "Helcim customer creation",
            status,
            &raw_text,
            &quota,
        ));
    }
    Ok(customer_code.to_string())
}

pub async fn get_customer_cards(
    http: &reqwest::Client,
    config: &HelcimConfig,
    customer_id: i64,
    card_token: Option<String>,
) -> Result<Value, String> {
    let path = format!("customers/{customer_id}/cards");
    let query = card_token
        .map(|token| vec![("cardToken", token)])
        .unwrap_or_default();
    send_get_request(http, config, &path, &query).await
}

pub async fn list_card_terminals(
    http: &reqwest::Client,
    config: &HelcimConfig,
) -> Result<Value, String> {
    send_get_request(http, config, "card-terminals/", &[]).await
}

pub async fn list_devices(
    http: &reqwest::Client,
    config: &HelcimConfig,
    query: &HelcimDevicesQuery,
) -> Result<Value, String> {
    send_get_request(http, config, "devices/", &query.query_params()).await
}

pub async fn get_device(
    http: &reqwest::Client,
    config: &HelcimConfig,
    code: &str,
) -> Result<Value, String> {
    let code = normalize_device_code(code)?;
    let path = format!("devices/{code}");
    send_get_request(http, config, &path, &[]).await
}

pub async fn ping_device(
    http: &reqwest::Client,
    config: &HelcimConfig,
    code: &str,
) -> Result<Value, String> {
    let code = normalize_device_code(code)?;
    let token = config
        .api_token()
        .ok_or_else(|| "Helcim API token is not saved in Backoffice Settings.".to_string())?;
    let url = format!("{}/devices/{code}/ping", config.api_base_url());
    let response = send_request_with_retry("Helcim device ping", || {
        http.get(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header("api-token", token)
            .send()
    })
    .await?;
    response
        .json::<Value>()
        .await
        .or_else(|_| Ok(serde_json::json!({ "status": "accepted" })))
}

pub async fn list_card_batches(
    http: &reqwest::Client,
    config: &HelcimConfig,
    query: &HelcimCardBatchesQuery,
) -> Result<Vec<HelcimCardBatchSnapshot>, String> {
    let body = send_get_request(http, config, "card-batches/", &query.query_params()).await?;
    Ok(parse_card_batch_snapshots(&body))
}

pub async fn fetch_card_batch(
    http: &reqwest::Client,
    config: &HelcimConfig,
    card_batch_id: &str,
) -> Result<HelcimCardBatchSnapshot, String> {
    let batch_id = card_batch_id.trim();
    if batch_id.is_empty() {
        return Err("cardBatchId is required".to_string());
    }
    let path = format!("card-batches/{batch_id}");
    let body = send_get_request(
        http,
        config,
        &path,
        &[("collect-stats", "true".to_string())],
    )
    .await?;
    parse_card_batch_snapshot(&body)
        .ok_or_else(|| format!("Helcim card batch {batch_id} response did not include a batch id"))
}

pub async fn list_card_transactions(
    http: &reqwest::Client,
    config: &HelcimConfig,
    query: &HelcimCardTransactionsQuery,
) -> Result<Vec<HelcimBatchTransactionSnapshot>, String> {
    let body = send_get_request(http, config, "card-transactions/", &query.query_params()).await?;
    Ok(parse_batch_transaction_snapshots(
        &body,
        query.card_batch_id.as_deref(),
    ))
}

pub async fn list_card_transactions_for_batch(
    http: &reqwest::Client,
    config: &HelcimConfig,
    card_batch_id: &str,
    limit: Option<i32>,
    page: Option<i32>,
) -> Result<Vec<HelcimBatchTransactionSnapshot>, String> {
    list_card_transactions(
        http,
        config,
        &HelcimCardTransactionsQuery {
            date_from: None,
            date_to: None,
            card_batch_id: Some(card_batch_id.to_string()),
            invoice_number: None,
            limit,
            page,
        },
    )
    .await
}

pub async fn delete_customer_card(
    http: &reqwest::Client,
    config: &HelcimConfig,
    customer_id: i64,
    card_id: i64,
) -> Result<(), String> {
    let token = config
        .api_token()
        .ok_or_else(|| "Helcim API token is not saved in Backoffice Settings.".to_string())?;
    let url = format!(
        "{}/customers/{customer_id}/cards/{card_id}",
        config.api_base_url()
    );
    let _response = send_request_with_retry("Helcim delete customer card", || {
        http.delete(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header("api-token", token)
            .send()
    })
    .await?;
    Ok(())
}

pub async fn set_customer_card_default(
    http: &reqwest::Client,
    config: &HelcimConfig,
    customer_id: i64,
    card_id: i64,
) -> Result<Value, String> {
    let token = config
        .api_token()
        .ok_or_else(|| "Helcim API token is not saved in Backoffice Settings.".to_string())?;
    let url = format!(
        "{}/customers/{customer_id}/cards/{card_id}/default",
        config.api_base_url()
    );
    let response = send_request_with_retry("Helcim set customer card default", || {
        http.patch(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header("api-token", token)
            .send()
    })
    .await?;
    response.json::<Value>().await.map_err(|e| e.to_string())
}

pub fn simulated_card_transaction(
    transaction_id: impl Into<String>,
    amount_cents: i64,
    currency: impl Into<String>,
    status: impl Into<String>,
) -> HelcimCardTransaction {
    let transaction_id = transaction_id.into();
    HelcimCardTransaction {
        transaction_id: Value::String(transaction_id.clone()),
        status: Some(status.into()),
        amount: Value::String(cents_to_decimal_string(amount_cents)),
        currency: Some(currency.into().to_uppercase()),
        card_type: Some("VISA".to_string()),
        approval_code: Some("SIMOK".to_string()),
        card_number: Some("4242424242424242".to_string()),
        invoice_number: Some(transaction_id),
        warning: None,
        extra: serde_json::Map::new(),
    }
}

pub fn build_purchase_request_payload(
    amount_cents: i64,
    currency: impl Into<String>,
    invoice_number: impl Into<String>,
    customer_code: Option<String>,
) -> HelcimPurchaseRequest {
    HelcimPurchaseRequest {
        currency: currency.into().to_uppercase(),
        transaction_amount: cents_to_decimal_string(amount_cents),
        invoice_number: invoice_number.into(),
        customer_code,
    }
}

pub fn build_terminal_refund_request_payload(
    amount_cents: i64,
    original_transaction_id: i64,
) -> HelcimTerminalRefundRequest {
    HelcimTerminalRefundRequest {
        transaction_amount: cents_to_decimal_string(amount_cents),
        original_transaction_id,
    }
}

fn terminal_purchase_request_body(request: &HelcimPurchaseRequest) -> Result<String, String> {
    let currency = serde_json::to_string(&request.currency).map_err(|e| e.to_string())?;
    let invoice_number =
        serde_json::to_string(&request.invoice_number).map_err(|e| e.to_string())?;
    let customer_code = request
        .customer_code
        .as_deref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| e.to_string())?;
    let customer_code_field = customer_code
        .map(|value| format!(",\"customerCode\":{value}"))
        .unwrap_or_default();
    Ok(format!(
        r#"{{"currency":{currency},"transactionAmount":{},"invoiceNumber":{invoice_number}{customer_code_field}}}"#,
        request.transaction_amount,
    ))
}

fn terminal_refund_request_body(request: &HelcimTerminalRefundRequest) -> Result<String, String> {
    Ok(format!(
        r#"{{"transactionAmount":{},"originalTransactionId":{}}}"#,
        request.transaction_amount, request.original_transaction_id
    ))
}

pub async fn process_card_token_purchase(
    http: &reqwest::Client,
    config: &HelcimConfig,
    request: HelcimCardPurchaseRequest,
    idempotency_key: &str,
) -> Result<HelcimCardTransaction, HelcimPaymentRequestError> {
    send_payment_request(http, config, "payment/purchase", &request, idempotency_key).await
}

pub async fn process_card_refund(
    http: &reqwest::Client,
    config: &HelcimConfig,
    request: HelcimCardRefundRequest,
    idempotency_key: &str,
) -> Result<HelcimCardTransaction, HelcimPaymentRequestError> {
    send_payment_request(http, config, "payment/refund", &request, idempotency_key).await
}

pub async fn process_card_reverse(
    http: &reqwest::Client,
    config: &HelcimConfig,
    request: HelcimCardReverseRequest,
    idempotency_key: &str,
) -> Result<HelcimCardTransaction, HelcimPaymentRequestError> {
    send_payment_request(http, config, "payment/reverse", &request, idempotency_key).await
}

pub async fn start_terminal_purchase(
    http: &reqwest::Client,
    config: &HelcimConfig,
    device_code: &str,
    request: HelcimPurchaseRequest,
    _idempotency_key: &str,
) -> Result<HelcimAcceptedPurchaseResponse, HelcimTerminalRequestError> {
    let device_code =
        normalize_device_code(device_code).map_err(|message| HelcimTerminalRequestError {
            status: None,
            message,
            raw_text: None,
            outcome_unknown: false,
        })?;
    let token = config
        .api_token()
        .ok_or_else(|| HelcimTerminalRequestError {
            status: None,
            message: "Helcim API token is not saved in Backoffice Settings.".to_string(),
            raw_text: None,
            outcome_unknown: false,
        })?;
    let url = format!(
        "{}/devices/{device_code}/payment/purchase",
        config.api_base_url()
    );
    let body =
        terminal_purchase_request_body(&request).map_err(|message| HelcimTerminalRequestError {
            status: None,
            message,
            raw_text: None,
            outcome_unknown: false,
        })?;
    let _permit = acquire_helcim_request_permit("Helcim terminal purchase")
        .await
        .map_err(|message| HelcimTerminalRequestError {
            status: None,
            message,
            raw_text: None,
            outcome_unknown: false,
        })?;
    let response = http
        .post(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("api-token", token)
        .body(body)
        .send()
        .await
        .map_err(|error| HelcimTerminalRequestError {
            status: None,
            message: format!(
                "Helcim terminal purchase outcome is unknown after a network error: {error}. Do not start another card payment; use Recover payment."
            ),
            raw_text: None,
            outcome_unknown: true,
        })?;

    let status = response.status();
    let quota = observe_helcim_quota_headers(response.headers(), status).await;
    if status != reqwest::StatusCode::ACCEPTED {
        let raw_text = response.text().await.unwrap_or_default();
        return Err(HelcimTerminalRequestError {
            status: Some(status),
            message: response_error_message_sync(
                "Helcim terminal purchase",
                status,
                &raw_text,
                &quota,
            ),
            raw_text: Some(raw_text),
            outcome_unknown: status.is_server_error(),
        });
    }

    Ok(response
        .json::<HelcimAcceptedPurchaseResponse>()
        .await
        .unwrap_or(HelcimAcceptedPurchaseResponse {
            status: Some("accepted".to_string()),
            payment_id: None,
            transaction_id: None,
            audit_reference: None,
        }))
}

pub async fn start_terminal_refund(
    http: &reqwest::Client,
    config: &HelcimConfig,
    device_code: &str,
    request: HelcimTerminalRefundRequest,
    _idempotency_key: &str,
) -> Result<HelcimAcceptedPurchaseResponse, HelcimTerminalRequestError> {
    let device_code =
        normalize_device_code(device_code).map_err(|message| HelcimTerminalRequestError {
            status: None,
            message,
            raw_text: None,
            outcome_unknown: false,
        })?;
    let token = config
        .api_token()
        .ok_or_else(|| HelcimTerminalRequestError {
            status: None,
            message: "Helcim API token is not saved in Backoffice Settings.".to_string(),
            raw_text: None,
            outcome_unknown: false,
        })?;
    let url = format!(
        "{}/devices/{device_code}/payment/refund",
        config.api_base_url()
    );
    let body =
        terminal_refund_request_body(&request).map_err(|message| HelcimTerminalRequestError {
            status: None,
            message,
            raw_text: None,
            outcome_unknown: false,
        })?;
    let _permit = acquire_helcim_request_permit("Helcim terminal refund")
        .await
        .map_err(|message| HelcimTerminalRequestError {
            status: None,
            message,
            raw_text: None,
            outcome_unknown: false,
        })?;
    let response = http
        .post(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("api-token", token)
        .body(body)
        .send()
        .await
        .map_err(|error| HelcimTerminalRequestError {
            status: None,
            message: format!(
                "Helcim terminal refund outcome is unknown after a network error: {error}. Do not start another refund; recover the original attempt."
            ),
            raw_text: None,
            outcome_unknown: true,
        })?;
    let status = response.status();
    let quota = observe_helcim_quota_headers(response.headers(), status).await;
    if status != reqwest::StatusCode::ACCEPTED {
        let raw_text = response.text().await.unwrap_or_default();
        return Err(HelcimTerminalRequestError {
            status: Some(status),
            message: response_error_message_sync(
                "Helcim terminal refund",
                status,
                &raw_text,
                &quota,
            ),
            raw_text: Some(raw_text),
            outcome_unknown: status.is_server_error(),
        });
    }
    Ok(response
        .json::<HelcimAcceptedPurchaseResponse>()
        .await
        .unwrap_or(HelcimAcceptedPurchaseResponse {
            status: Some("accepted".to_string()),
            payment_id: None,
            transaction_id: None,
            audit_reference: None,
        }))
}

pub async fn initialize_helcim_pay(
    http: &reqwest::Client,
    config: &HelcimConfig,
    request: HelcimPayInitializeRequest,
) -> Result<HelcimPayInitializeResponse, String> {
    let token = config
        .api_token()
        .ok_or_else(|| "Helcim API token is not saved in Backoffice Settings.".to_string())?;
    let url = format!("{}/helcim-pay/initialize", config.api_base_url());
    let response = send_request_with_retry("HelcimPay.js initialization", || {
        http.post(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header("api-token", token)
            .json(&request)
            .send()
    })
    .await?;
    response
        .json::<HelcimPayInitializeResponse>()
        .await
        .map_err(|e| e.to_string())
}

fn is_retryable_helcim_error(status: reqwest::StatusCode, body_hint: Option<&str>) -> bool {
    // A 429 is a provider throttle, not a transient transport failure. Retrying
    // immediately multiplies the pressure and commonly turns a clear provider
    // response into a delayed 502. Let the caller surface it and retry later.
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return false;
    }
    if status.is_server_error() {
        return true;
    }
    if let Some(hint) = body_hint {
        let lower = hint.to_ascii_lowercase();
        if lower.contains("timeout") || lower.contains("temporarily unavailable") {
            return true;
        }
    }
    false
}

fn helcim_retry_delay(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_millis(HELCIM_BASE_RETRY_DELAY_MS * 2_u64.pow(attempt))
}

/// Helcim Payment API idempotency keys must be 25-36 URL-safe characters.
/// Keep ROS's descriptive database key for local replay, but derive a stable
/// provider-safe UUID whenever the local key is outside Helcim's contract.
pub fn provider_idempotency_key(local_key: &str) -> String {
    let trimmed = local_key.trim();
    let valid_length = (25..=36).contains(&trimmed.len());
    let valid_chars = trimmed
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    let valid_uuid = uuid::Uuid::parse_str(trimmed).is_ok();
    if valid_length && valid_chars && valid_uuid {
        trimmed.to_string()
    } else {
        uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, trimmed.as_bytes()).to_string()
    }
}

/// Whether an existing Payment API attempt is still young enough for ROS to
/// safely run its complete same-key retry sequence before Helcim clears the
/// idempotency key. New attempts do not need this gate; callers use it only
/// when replaying an outcome-unknown request.
pub fn payment_idempotency_retry_is_safe(created_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    let age = now.signed_duration_since(created_at);
    let safe_replay_seconds = HELCIM_PAYMENT_IDEMPOTENCY_WINDOW_SECONDS
        - HELCIM_PAYMENT_IDEMPOTENCY_RETRY_RESERVE_SECONDS;
    age >= chrono::Duration::zero() && age < chrono::Duration::seconds(safe_replay_seconds)
}

async fn send_payment_request<T: Serialize + ?Sized>(
    http: &reqwest::Client,
    config: &HelcimConfig,
    path: &str,
    request: &T,
    idempotency_key: &str,
) -> Result<HelcimCardTransaction, HelcimPaymentRequestError> {
    let token = config
        .api_token()
        .ok_or_else(|| HelcimPaymentRequestError {
            status: None,
            message: "Helcim API token is not saved in Backoffice Settings.".to_string(),
            outcome_unknown: false,
        })?;
    let url = format!("{}/{}", config.api_base_url(), path);
    let provider_idempotency_key = provider_idempotency_key(idempotency_key);

    let mut last_error = String::new();
    let mut request_may_have_reached_provider = false;
    for attempt in 0..=HELCIM_MAX_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(helcim_retry_delay(attempt - 1)).await;
            tracing::info!(attempt, "Retrying Helcim payment request");
        }
        let _permit = match acquire_helcim_request_permit("Helcim payment request").await {
            Ok(permit) => permit,
            Err(message) => {
                return Err(HelcimPaymentRequestError {
                    status: None,
                    message,
                    outcome_unknown: request_may_have_reached_provider,
                });
            }
        };
        let response = match http
            .post(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header("api-token", token)
            .header("idempotency-key", &provider_idempotency_key)
            .json(request)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let current_outcome_unknown = !e.is_builder();
                let outcome_unknown = request_may_have_reached_provider || current_outcome_unknown;
                if current_outcome_unknown && attempt < HELCIM_MAX_RETRIES {
                    request_may_have_reached_provider = true;
                    last_error = format!("Helcim payment request network error: {e}");
                    continue;
                }
                return Err(HelcimPaymentRequestError {
                    status: None,
                    message: format!("Helcim payment request failed: {e}"),
                    outcome_unknown,
                });
            }
        };
        let status = response.status();
        let quota = observe_helcim_quota_headers(response.headers(), status).await;
        if !status.is_success() {
            let raw_text = response.text().await.unwrap_or_default();
            if is_retryable_helcim_error(status, Some(&raw_text)) && attempt < HELCIM_MAX_RETRIES {
                request_may_have_reached_provider = true;
                last_error = response_error_message_sync(
                    "Helcim payment request",
                    status,
                    &raw_text,
                    &quota,
                );
                continue;
            }
            return Err(HelcimPaymentRequestError {
                status: Some(status),
                message: response_error_message_sync(
                    "Helcim payment request",
                    status,
                    &raw_text,
                    &quota,
                ),
                outcome_unknown: request_may_have_reached_provider || status.is_server_error(),
            });
        }
        return response
            .json::<HelcimCardTransaction>()
            .await
            .map_err(|error| HelcimPaymentRequestError {
                status: Some(status),
                message: format!(
                    "Helcim payment response could not be decoded; preserve this attempt for recovery: {error}"
                ),
                outcome_unknown: true,
            });
    }
    Err(HelcimPaymentRequestError {
        status: None,
        message: format!("Helcim payment request failed after retries: {last_error}"),
        outcome_unknown: true,
    })
}

async fn send_get_request(
    http: &reqwest::Client,
    config: &HelcimConfig,
    path: &str,
    query: &[(&str, String)],
) -> Result<Value, String> {
    let token = config
        .api_token()
        .ok_or_else(|| "Helcim API token is not saved in Backoffice Settings.".to_string())?;
    let url = format!("{}/{}", config.api_base_url(), path);

    let mut last_error = String::new();
    for attempt in 0..=HELCIM_MAX_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(helcim_retry_delay(attempt - 1)).await;
            tracing::info!(attempt, "Retrying Helcim GET request");
        }
        let _permit = acquire_helcim_request_permit("Helcim GET request").await?;
        let response = match http
            .get(&url)
            .query(query)
            .header(reqwest::header::ACCEPT, "application/json")
            .header("api-token", token)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                if e.is_timeout() || e.is_connect() {
                    last_error = format!("Helcim GET request network error: {e}");
                    continue;
                }
                return Err(format!("Helcim GET request failed: {e}"));
            }
        };
        let status = response.status();
        let quota = observe_helcim_quota_headers(response.headers(), status).await;
        if !status.is_success() {
            let raw_text = response.text().await.unwrap_or_default();
            if is_retryable_helcim_error(status, Some(&raw_text)) && attempt < HELCIM_MAX_RETRIES {
                last_error =
                    response_error_message_sync("Helcim GET request", status, &raw_text, &quota);
                continue;
            }
            return Err(response_error_message_sync(
                "Helcim GET request",
                status,
                &raw_text,
                &quota,
            ));
        }
        return response.json::<Value>().await.map_err(|e| e.to_string());
    }
    Err(format!(
        "Helcim GET request failed after retries: {last_error}"
    ))
}

fn response_error_message_sync(
    context: &str,
    status: reqwest::StatusCode,
    raw_text: &str,
    quota: &HelcimQuotaHeaders,
) -> String {
    let is_html =
        raw_text.trim().starts_with("<!DOCTYPE html>") || raw_text.trim().starts_with("<html");
    let message = redact_provider_text(raw_text);
    let mut detail = format!("{context} returned HTTP {status}");
    if is_html {
        detail.push_str(" (received HTML response; check your API base URL or WAF/IP settings)");
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        detail.push_str("; Helcim rate limit reached");
    }
    if let Some(retry_after_seconds) = quota.retry_after_seconds {
        detail.push_str(&format!("; retry after {retry_after_seconds} seconds"));
    }
    if let Some(minute_remaining) = quota.minute_remaining {
        detail.push_str(&format!("; minute quota remaining {minute_remaining}"));
    }
    if let Some(hour_remaining) = quota.hour_remaining {
        detail.push_str(&format!("; hour quota remaining {hour_remaining}"));
    }
    if !message.trim().is_empty() {
        detail.push_str(&format!(": {message}"));
    }
    detail
}

pub fn normalize_device_code(code: &str) -> Result<String, String> {
    let code = code.trim().to_ascii_uppercase();
    if code.len() != 4 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Helcim device code must be exactly 4 alphanumeric characters.".to_string());
    }
    Ok(code)
}

fn helcim_field_is_sensitive(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();

    matches!(
        normalized.as_str(),
        "cardnumber"
            | "carddata"
            | "cardtoken"
            | "cvv"
            | "cvc"
            | "pan"
            | "primaryaccountnumber"
            | "expiry"
            | "expirydate"
            | "secrettoken"
            | "checkouttoken"
            | "track1"
            | "track2"
            | "trackdata"
            | "magstripe"
            | "emv"
            | "rawemv"
            | "rawemvdata"
            | "ksn"
            | "pinblock"
    ) || normalized.contains("cardtoken")
        || normalized.contains("cardnumber")
        || normalized.contains("secret")
        || normalized.contains("cvv")
        || normalized.contains("cvc")
        || normalized.contains("trackdata")
        || normalized.contains("magstripe")
        || normalized.contains("rawemv")
        || normalized.contains("pinblock")
}

fn redact_sensitive_text_fragments(message: &str) -> String {
    let mut redacted = String::with_capacity(message.len());
    let mut digits = String::new();

    for character in message.chars() {
        if character.is_ascii_digit() {
            digits.push(character);
            continue;
        }

        flush_digit_run(&mut redacted, &mut digits);
        redacted.push(character);
    }

    flush_digit_run(&mut redacted, &mut digits);
    redacted
}

fn flush_digit_run(output: &mut String, digits: &mut String) {
    if digits.is_empty() {
        return;
    }
    if digits.len() >= 12 && digits.len() <= 19 && luhn_check(digits) {
        output.push_str("[REDACTED]");
    } else {
        output.push_str(digits);
    }
    digits.clear();
}

fn luhn_check(value: &str) -> bool {
    let mut sum = 0;
    let mut double = false;

    for digit in value.chars().rev().filter_map(|c| c.to_digit(10)) {
        let mut contribution = digit;
        if double {
            contribution *= 2;
            if contribution > 9 {
                contribution -= 9;
            }
        }
        sum += contribution;
        double = !double;
    }

    sum > 0 && sum % 10 == 0
}

pub fn normalize_accepted_purchase(
    terminal_id: impl Into<String>,
    amount_cents: i64,
    currency: impl Into<String>,
    idempotency_key: impl Into<String>,
    response: HelcimAcceptedPurchaseResponse,
) -> HelcimPendingAttempt {
    HelcimPendingAttempt {
        provider: HELCIM_PROVIDER_KEY,
        status: "pending",
        amount_cents,
        currency: currency.into().to_lowercase(),
        terminal_id: terminal_id.into(),
        idempotency_key: idempotency_key.into(),
        provider_payment_id: response.payment_id,
        provider_transaction_id: response.transaction_id,
        raw_audit_reference: response.audit_reference.or(response.status),
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_truthy(key: &str) -> bool {
    std::env::var(key)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn cents_to_decimal_string(amount_cents: i64) -> String {
    let sign = if amount_cents < 0 { "-" } else { "" };
    let abs = amount_cents.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

fn mask_suffix(value: &str) -> String {
    let suffix: String = value
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("...{suffix}")
}

#[derive(Debug, serde::Serialize)]
pub struct HelcimHealth {
    pub configured: bool,
    pub reachable: bool,
    pub latency_ms: u64,
    pub message: String,
}

pub async fn health_check(http: &reqwest::Client) -> HelcimHealth {
    let start = std::time::Instant::now();
    let config = HelcimConfig::from_env();
    if !config.enabled() {
        return HelcimHealth {
            configured: false,
            reachable: false,
            latency_ms: 0,
            message: "Helcim not configured (HELCIM_API_TOKEN unset and simulator disabled)"
                .to_string(),
        };
    }
    if config.simulator_enabled() {
        return HelcimHealth {
            configured: true,
            reachable: true,
            latency_ms: 0,
            message: "Helcim simulator mode is active".to_string(),
        };
    }
    match test_connection(http, &config).await {
        Ok(_) => HelcimHealth {
            configured: true,
            reachable: true,
            latency_ms: start.elapsed().as_millis() as u64,
            message: "Helcim API is reachable and authenticated".to_string(),
        },
        Err(e) => HelcimHealth {
            configured: true,
            reachable: false,
            latency_ms: start.elapsed().as_millis() as u64,
            message: e,
        },
    }
}

pub async fn test_connection(
    http: &reqwest::Client,
    config: &HelcimConfig,
) -> Result<Value, String> {
    send_get_request(http, config, "connection-test", &[]).await
}

fn api_base_host(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string()
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.trim().to_string()).filter(|value| !value.is_empty()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn helcim_env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    #[tokio::test]
    async fn health_check_returns_not_configured_when_token_and_simulator_missing() {
        let _guard = helcim_env_lock();
        let previous_token = std::env::var("HELCIM_API_TOKEN").ok();
        let previous_sim = std::env::var("HELCIM_SIMULATOR_ENABLED").ok();
        let previous_strict = std::env::var("RIVERSIDE_STRICT_PRODUCTION").ok();
        std::env::remove_var("HELCIM_API_TOKEN");
        std::env::remove_var("HELCIM_SIMULATOR_ENABLED");
        std::env::remove_var("RIVERSIDE_STRICT_PRODUCTION");
        let health = health_check(&reqwest::Client::new()).await;
        assert!(!health.configured);
        assert!(!health.reachable);
        assert_eq!(health.latency_ms, 0);
        assert!(
            health.message.contains("not configured"),
            "unexpected message: {}",
            health.message
        );
        if let Some(v) = previous_token {
            std::env::set_var("HELCIM_API_TOKEN", v);
        }
        if let Some(v) = previous_sim {
            std::env::set_var("HELCIM_SIMULATOR_ENABLED", v);
        }
        if let Some(v) = previous_strict {
            std::env::set_var("RIVERSIDE_STRICT_PRODUCTION", v);
        }
    }

    #[tokio::test]
    async fn health_check_returns_reachable_when_simulator_enabled() {
        let _guard = helcim_env_lock();
        let previous_token = std::env::var("HELCIM_API_TOKEN").ok();
        let previous_sim = std::env::var("HELCIM_SIMULATOR_ENABLED").ok();
        let previous_strict = std::env::var("RIVERSIDE_STRICT_PRODUCTION").ok();
        std::env::remove_var("HELCIM_API_TOKEN");
        std::env::set_var("HELCIM_SIMULATOR_ENABLED", "true");
        std::env::remove_var("RIVERSIDE_STRICT_PRODUCTION");
        let health = health_check(&reqwest::Client::new()).await;
        assert!(health.configured);
        assert!(health.reachable);
        assert_eq!(health.latency_ms, 0);
        assert!(
            health.message.contains("simulator"),
            "unexpected message: {}",
            health.message
        );
        if let Some(v) = previous_token {
            std::env::set_var("HELCIM_API_TOKEN", v);
        } else {
            std::env::remove_var("HELCIM_API_TOKEN");
        }
        if let Some(v) = previous_sim {
            std::env::set_var("HELCIM_SIMULATOR_ENABLED", v);
        } else {
            std::env::remove_var("HELCIM_SIMULATOR_ENABLED");
        }
        if let Some(v) = previous_strict {
            std::env::set_var("RIVERSIDE_STRICT_PRODUCTION", v);
        } else {
            std::env::remove_var("RIVERSIDE_STRICT_PRODUCTION");
        }
    }

    #[test]
    fn custom_api_hosts_require_explicit_nonproduction_opt_in() {
        let _guard = helcim_env_lock();
        let previous_strict = std::env::var("RIVERSIDE_STRICT_PRODUCTION").ok();
        let previous_allow = std::env::var("HELCIM_ALLOW_CUSTOM_API_BASE_URL").ok();

        std::env::remove_var("RIVERSIDE_STRICT_PRODUCTION");
        std::env::remove_var("HELCIM_ALLOW_CUSTOM_API_BASE_URL");
        assert!(validate_helcim_api_base_url("https://sandbox.example.test/v2").is_err());

        std::env::set_var("HELCIM_ALLOW_CUSTOM_API_BASE_URL", "true");
        assert_eq!(
            validate_helcim_api_base_url("http://127.0.0.1:9876/v2").unwrap(),
            "http://127.0.0.1:9876/v2"
        );
        assert!(validate_helcim_api_base_url("http://example.test/v2").is_err());
        assert_eq!(
            validate_helcim_api_base_url("https://sandbox.example.test/v2").unwrap(),
            "https://sandbox.example.test/v2"
        );

        std::env::set_var("RIVERSIDE_STRICT_PRODUCTION", "true");
        assert!(validate_helcim_api_base_url("https://sandbox.example.test/v2").is_err());
        assert_eq!(
            validate_helcim_api_base_url(DEFAULT_HELCIM_API_BASE_URL).unwrap(),
            DEFAULT_HELCIM_API_BASE_URL
        );

        if let Some(value) = previous_strict {
            std::env::set_var("RIVERSIDE_STRICT_PRODUCTION", value);
        } else {
            std::env::remove_var("RIVERSIDE_STRICT_PRODUCTION");
        }
        if let Some(value) = previous_allow {
            std::env::set_var("HELCIM_ALLOW_CUSTOM_API_BASE_URL", value);
        } else {
            std::env::remove_var("HELCIM_ALLOW_CUSTOM_API_BASE_URL");
        }
    }

    #[test]
    fn invalid_explicit_api_override_disables_live_credentials() {
        let _guard = helcim_env_lock();
        let previous_token = std::env::var("HELCIM_API_TOKEN").ok();
        let previous_base = std::env::var("HELCIM_API_BASE_URL").ok();
        let previous_allow = std::env::var("HELCIM_ALLOW_CUSTOM_API_BASE_URL").ok();
        let previous_strict = std::env::var("RIVERSIDE_STRICT_PRODUCTION").ok();

        std::env::set_var("HELCIM_API_TOKEN", "test-live-token");
        std::env::set_var("HELCIM_API_BASE_URL", "http://untrusted.example/v2");
        std::env::remove_var("HELCIM_ALLOW_CUSTOM_API_BASE_URL");
        std::env::remove_var("RIVERSIDE_STRICT_PRODUCTION");

        let config = HelcimConfig::from_env();
        assert_eq!(config.api_base_url(), DEFAULT_HELCIM_API_BASE_URL);
        assert!(config.api_token().is_none());
        assert!(config
            .status()
            .missing_config
            .iter()
            .any(|message| message.contains("API host is invalid")));

        for (name, previous) in [
            ("HELCIM_API_TOKEN", previous_token),
            ("HELCIM_API_BASE_URL", previous_base),
            ("HELCIM_ALLOW_CUSTOM_API_BASE_URL", previous_allow),
            ("RIVERSIDE_STRICT_PRODUCTION", previous_strict),
        ] {
            if let Some(value) = previous {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }
    use serde_json::json;

    #[test]
    fn normalizes_four_character_device_codes() {
        assert_eq!(normalize_device_code(" ab12 ").unwrap(), "AB12");
        assert!(normalize_device_code("ABC").is_err());
        assert!(normalize_device_code("ABCDE").is_err());
        assert!(normalize_device_code("AB-1").is_err());
    }

    #[test]
    fn extracts_explicit_fee_and_net_fields_from_helcim_payload() {
        let details = extract_fee_details(&json!({
            "transactionId": 123,
            "amount": "100.00",
            "cardBatchId": 456,
            "processingFee": "2.91",
            "netAmount": "97.09"
        }));

        assert_eq!(details.merchant_fee, Some(Decimal::new(291, 2)));
        assert_eq!(details.net_amount, Some(Decimal::new(9709, 2)));
        assert_eq!(details.card_batch_id.as_deref(), Some("456"));
        assert_eq!(details.source_field.as_deref(), Some("processingFee"));
        assert_eq!(details.net_source_field.as_deref(), Some("netAmount"));
    }

    #[test]
    fn card_transaction_exposes_provider_transaction_type() {
        let mut transaction = simulated_card_transaction("123", 10_000, "USD", "approved");
        transaction
            .extra
            .insert("type".to_string(), json!("purchase"));
        assert_eq!(transaction.transaction_type().as_deref(), Some("purchase"));
    }

    #[test]
    fn does_not_estimate_fee_when_api_payload_has_no_fee_field() {
        let details = extract_fee_details(&json!({
            "transactionId": 123,
            "amount": "100.00",
            "cardBatchId": 456
        }));

        assert_eq!(details.merchant_fee, None);
        assert_eq!(details.net_amount, None);
        assert_eq!(details.card_batch_id.as_deref(), Some("456"));
        assert_eq!(details.net_source_field, None);
    }

    #[test]
    fn parses_batch_snapshot_from_known_fields() {
        let batch = parse_card_batch_snapshot(&json!({
            "id": 456,
            "closed": true,
            "dateCreated": "2026-05-01 12:00:00",
            "dateClosed": "2026-05-01T22:00:00Z",
            "totalSales": "100.00",
            "feeAmount": "2.91",
            "netAmount": "97.09",
            "countTotal": 2
        }))
        .expect("batch should parse");

        assert_eq!(batch.provider_batch_id, "456");
        assert_eq!(batch.status.as_deref(), Some("closed"));
        assert_eq!(batch.gross_amount, Some(Decimal::new(10000, 2)));
        assert_eq!(batch.fee_amount, Some(Decimal::new(291, 2)));
        assert_eq!(batch.net_amount, Some(Decimal::new(9709, 2)));
        assert_eq!(batch.transaction_count, Some(2));
        assert!(batch.opened_at.is_some());
        assert!(batch.closed_at.is_some());
    }

    #[test]
    fn parses_batch_snapshot_from_helcim_batch_screen_fields() {
        let batch = parse_card_batch_snapshot(&json!({
            "cardBatchId": 7,
            "batchStatus": "settled",
            "closedAt": "2026-07-08T20:01:00Z",
            "grossSales": "2935.22",
            "totalFees": "41.21",
            "depositAmount": "2894.01",
            "transactionCount": 4
        }))
        .expect("batch should parse");

        assert_eq!(batch.provider_batch_id, "7");
        assert_eq!(batch.status.as_deref(), Some("settled"));
        assert_eq!(batch.gross_amount, Some(Decimal::new(293522, 2)));
        assert_eq!(batch.fee_amount, Some(Decimal::new(4121, 2)));
        assert_eq!(batch.net_amount, Some(Decimal::new(289401, 2)));
        assert_eq!(batch.transaction_count, Some(4));
        assert!(batch.closed_at.is_some());
    }

    #[test]
    fn does_not_treat_batch_net_sales_as_deposit_evidence() {
        let batch = parse_card_batch_snapshot(&json!({
            "id": 456,
            "closed": true,
            "totalSales": "100.00",
            "netSales": "75.00",
            "totalRefunds": "25.00"
        }))
        .expect("batch should parse");

        assert_eq!(batch.gross_amount, Some(Decimal::new(10000, 2)));
        assert_eq!(batch.net_amount, None);
    }

    #[test]
    fn parses_batch_transaction_without_inferred_fee_or_net() {
        let transaction = parse_batch_transaction_snapshot(
            &json!({
                "transactionId": 123,
                "amount": "100.00",
                "status": "approved",
                "createdAt": "2026-05-01"
            }),
            Some("456"),
        )
        .expect("transaction should parse");

        assert_eq!(transaction.provider_batch_id, "456");
        assert_eq!(transaction.provider_transaction_id, "123");
        assert_eq!(transaction.gross_amount, Some(Decimal::new(10000, 2)));
        assert_eq!(transaction.fee_amount, None);
        assert_eq!(transaction.net_amount, None);
        assert!(transaction.occurred_at.is_some());
    }

    #[test]
    fn parses_batch_transactions_from_collection_with_mixed_id_types() {
        let transactions = parse_batch_transaction_snapshots(
            &json!({
                "cardTransactions": [
                    {
                        "transactionId": 123,
                        "cardBatchId": 456,
                        "amount": "100.00",
                        "feeAmount": "2.50",
                        "netAmount": "97.50"
                    },
                    {
                        "transactionId": "TX-789",
                        "amount": "40.00"
                    }
                ]
            }),
            Some("fallback-batch"),
        );

        assert_eq!(transactions.len(), 2);
        assert_eq!(transactions[0].provider_transaction_id, "123");
        assert_eq!(transactions[0].provider_batch_id, "456");
        assert_eq!(transactions[0].fee_amount, Some(Decimal::new(250, 2)));
        assert_eq!(transactions[0].net_amount, Some(Decimal::new(9750, 2)));
        assert_eq!(transactions[1].provider_transaction_id, "TX-789");
        assert_eq!(transactions[1].provider_batch_id, "fallback-batch");
        assert_eq!(transactions[1].fee_amount, None);
        assert_eq!(transactions[1].net_amount, None);
    }

    #[test]
    fn redacts_sensitive_provider_payload_fields_without_removing_safe_card_metadata() {
        let payload = json!({
            "transactionId": 123,
            "cardNumber": "4111111111111111",
            "cardToken": "tok_123",
            "cardF6L4": "4111111111",
            "trackData": "%B4111111111111111^CARD/TEST^",
            "nested": {
                "cvv": "123",
                "transactionAmount": "10.00"
            }
        });

        let redacted = redact_provider_payload(&payload);

        assert_eq!(redacted["cardNumber"], "[REDACTED]");
        assert_eq!(redacted["cardToken"], "[REDACTED]");
        assert_eq!(redacted["trackData"], "[REDACTED]");
        assert_eq!(redacted["nested"]["cvv"], "[REDACTED]");
        assert_eq!(redacted["cardF6L4"], "4111111111");
        assert_eq!(redacted["nested"]["transactionAmount"], "10.00");
    }

    #[test]
    fn redacts_provider_error_text_pan_runs() {
        let redacted =
            redact_provider_text("Helcim error body card=4111111111111111 status=declined");

        assert_eq!(
            redacted,
            "Helcim error body card=[REDACTED] status=declined"
        );
    }

    #[test]
    fn terminal_purchase_body_serializes_amount_as_json_number() {
        let request = build_purchase_request_payload(1099, "usd", "ROS-123", None);
        let body = terminal_purchase_request_body(&request).expect("purchase body");
        let value: Value = serde_json::from_str(&body).expect("valid json");

        assert_eq!(value["currency"], "USD");
        assert!(value["transactionAmount"].is_number());
        assert_eq!(value["transactionAmount"].to_string(), "10.99");
        assert_eq!(value["invoiceNumber"], "ROS-123");
    }

    #[test]
    fn extracts_invoice_number_from_nested_provider_payload() {
        let payload = json!({
            "cardTransactions": [
                {
                    "transactionId": "123",
                    "invoiceNumber": "ROS-abc",
                    "amount": "12.34"
                }
            ]
        });

        assert_eq!(
            invoice_number_from_payload(&payload).as_deref(),
            Some("ROS-abc")
        );
    }

    #[test]
    fn card_transaction_query_uses_provider_invoice_filter() {
        let query = HelcimCardTransactionsQuery {
            date_from: None,
            date_to: None,
            card_batch_id: None,
            invoice_number: Some(" ROS-attempt-1 ".to_string()),
            limit: Some(1000),
            page: Some(2),
        };
        let params = query.query_params();

        assert!(params
            .iter()
            .any(|(key, value)| *key == "invoiceNumber" && value == "ROS-attempt-1"));
    }

    #[test]
    fn timezone_free_helcim_timestamp_uses_mountain_time() {
        let parsed = timestamp_from_value(&json!("2026-07-11 10:48:28"))
            .expect("Helcim timestamp should parse");

        assert_eq!(parsed.to_rfc3339(), "2026-07-11T16:48:28+00:00");
    }

    #[test]
    fn terminal_refund_body_serializes_amount_as_json_number() {
        let request = build_terminal_refund_request_payload(1099, 12345);
        let body = terminal_refund_request_body(&request).expect("refund body");
        let value: Value = serde_json::from_str(&body).expect("valid json");

        assert!(value["transactionAmount"].is_number());
        assert_eq!(value["transactionAmount"].to_string(), "10.99");
        assert_eq!(value["originalTransactionId"], 12345);
    }

    #[test]
    fn provider_idempotency_key_normalizes_long_ros_keys_deterministically() {
        let local = "helcim-card-refund-11111111-1111-4111-8111-111111111111";
        let first = provider_idempotency_key(local);
        let second = provider_idempotency_key(local);

        assert_eq!(first, second);
        assert_eq!(first.len(), 36);
        assert!(uuid::Uuid::parse_str(&first).is_ok());
    }

    #[test]
    fn provider_idempotency_key_preserves_valid_provider_key() {
        let provider_key = "11111111-1111-4111-8111-111111111111";
        assert_eq!(provider_idempotency_key(provider_key), provider_key);
    }

    #[test]
    fn payment_idempotency_replay_reserves_the_full_retry_budget() {
        let now = Utc::now();
        assert!(payment_idempotency_retry_is_safe(
            now - chrono::Duration::seconds(119),
            now,
        ));
        assert!(!payment_idempotency_retry_is_safe(
            now - chrono::Duration::seconds(120),
            now,
        ));
        assert!(!payment_idempotency_retry_is_safe(
            now + chrono::Duration::seconds(1),
            now,
        ));
    }

    #[test]
    fn parses_helcim_quota_headers() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("retry-after", "12".parse().unwrap());
        headers.insert("minute-limit-remaining", "41".parse().unwrap());
        headers.insert("hour-limit-remaining", "2042".parse().unwrap());

        assert_eq!(
            helcim_quota_headers(&headers),
            HelcimQuotaHeaders {
                retry_after_seconds: Some(12),
                minute_remaining: Some(41),
                hour_remaining: Some(2042),
            }
        );
    }

    #[test]
    fn rate_limit_error_includes_provider_quota_evidence() {
        let message = response_error_message_sync(
            "Helcim payment request",
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            r#"{"errors":"slow down"}"#,
            &HelcimQuotaHeaders {
                retry_after_seconds: Some(8),
                minute_remaining: Some(0),
                hour_remaining: Some(2870),
            },
        );

        assert!(message.contains("retry after 8 seconds"));
        assert!(message.contains("minute quota remaining 0"));
        assert!(message.contains("hour quota remaining 2870"));
    }

    fn test_card_purchase_request() -> HelcimCardPurchaseRequest {
        HelcimCardPurchaseRequest {
            ip_address: "127.0.0.1".to_string(),
            ecommerce: true,
            currency: "USD".to_string(),
            amount: "10.00".to_string(),
            customer_code: Some("ROS-TEST".to_string()),
            invoice_number: Some("ROS-TEST-INVOICE".to_string()),
            card_data: HelcimCardData {
                card_token: "test-token-reference".to_string(),
            },
        }
    }

    #[tokio::test]
    async fn payment_api_definite_4xx_is_not_an_unknown_outcome() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/payment/purchase"))
            .respond_with(ResponseTemplate::new(400).set_body_string("invalid request"))
            .expect(1)
            .mount(&mock)
            .await;
        let config = HelcimConfig {
            api_token: Some("test-token".to_string()),
            terminal_1_device_code: None,
            terminal_2_device_code: None,
            api_base_url: mock.uri(),
        };

        let error = process_card_token_purchase(
            &reqwest::Client::new(),
            &config,
            test_card_purchase_request(),
            "payment-api-local-key",
        )
        .await
        .expect_err("400 response must be definitive");

        assert_eq!(error.status, Some(reqwest::StatusCode::BAD_REQUEST));
        assert!(!error.outcome_unknown);
    }

    #[tokio::test]
    async fn payment_api_exhausted_5xx_reuses_one_key_and_stays_unknown() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/payment/purchase"))
            .respond_with(ResponseTemplate::new(500).set_body_string("provider unavailable"))
            .expect((HELCIM_MAX_RETRIES + 1) as u64)
            .mount(&mock)
            .await;
        let config = HelcimConfig {
            api_token: Some("test-token".to_string()),
            terminal_1_device_code: None,
            terminal_2_device_code: None,
            api_base_url: mock.uri(),
        };

        let error = process_card_token_purchase(
            &reqwest::Client::new(),
            &config,
            test_card_purchase_request(),
            "payment-api-local-key",
        )
        .await
        .expect_err("exhausted 500 responses must stay unresolved");

        assert_eq!(
            error.status,
            Some(reqwest::StatusCode::INTERNAL_SERVER_ERROR)
        );
        assert!(error.outcome_unknown);
        let requests = mock.received_requests().await.expect("received requests");
        assert_eq!(requests.len(), (HELCIM_MAX_RETRIES + 1) as usize);
        let expected_key = provider_idempotency_key("payment-api-local-key");
        assert!(requests.iter().all(|request| {
            request
                .headers
                .get("idempotency-key")
                .and_then(|value| value.to_str().ok())
                == Some(expected_key.as_str())
        }));
    }

    #[tokio::test]
    async fn terminal_purchase_dispatches_once_without_payment_api_idempotency_header() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/devices/AB12/payment/purchase"))
            .respond_with(ResponseTemplate::new(500).set_body_string("provider unavailable"))
            .expect(1)
            .mount(&mock)
            .await;
        let config = HelcimConfig {
            api_token: Some("test-token".to_string()),
            terminal_1_device_code: Some("AB12".to_string()),
            terminal_2_device_code: None,
            api_base_url: mock.uri(),
        };

        let error = start_terminal_purchase(
            &reqwest::Client::new(),
            &config,
            "AB12",
            build_purchase_request_payload(1_000, "USD", "ROS-TEST", None),
            "local-attempt-key",
        )
        .await
        .expect_err("500 response must stay unresolved");

        assert!(error.outcome_unknown);
        let requests = mock.received_requests().await.expect("received requests");
        assert_eq!(requests.len(), 1);
        assert!(requests[0].headers.get("idempotency-key").is_none());
    }

    #[tokio::test]
    async fn terminal_refund_dispatches_once_without_payment_api_idempotency_header() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/devices/AB12/payment/refund"))
            .respond_with(ResponseTemplate::new(500).set_body_string("provider unavailable"))
            .expect(1)
            .mount(&mock)
            .await;
        let config = HelcimConfig {
            api_token: Some("test-token".to_string()),
            terminal_1_device_code: Some("AB12".to_string()),
            terminal_2_device_code: None,
            api_base_url: mock.uri(),
        };

        let error = start_terminal_refund(
            &reqwest::Client::new(),
            &config,
            "AB12",
            build_terminal_refund_request_payload(1_000, 42),
            "local-attempt-key",
        )
        .await
        .expect_err("500 response must stay unresolved");

        assert!(error.outcome_unknown);
        let requests = mock.received_requests().await.expect("received requests");
        assert_eq!(requests.len(), 1);
        assert!(requests[0].headers.get("idempotency-key").is_none());
    }

    #[test]
    fn card_return_action_reverses_only_full_open_batch_charge() {
        assert_eq!(
            card_return_action(Some("open"), 10_000, 10_000, 0).expect("full reverse"),
            HelcimCardReturnAction::Reverse
        );
        assert!(card_return_action(Some("open"), 10_000, 5_000, 0).is_err());
        assert!(card_return_action(Some("open"), 10_000, 5_000, 5_000).is_err());
    }

    #[test]
    fn card_return_action_refunds_closed_batch_and_fails_without_status() {
        assert_eq!(
            card_return_action(Some("closed"), 10_000, 2_500, 0).expect("closed batch refund"),
            HelcimCardReturnAction::Refund
        );
        assert_eq!(
            card_return_action(Some("settled"), 10_000, 2_500, 0).expect("settled batch refund"),
            HelcimCardReturnAction::Refund
        );
        assert!(card_return_action(None, 10_000, 2_500, 0).is_err());
        assert!(card_return_action(Some("unknown"), 10_000, 2_500, 0).is_err());
    }
}
