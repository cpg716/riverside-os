use serde::{Deserialize, Serialize};

pub const HELCIM_PROVIDER_KEY: &str = "helcim";
pub const DEFAULT_HELCIM_API_BASE_URL: &str = "https://api.helcim.com/v2";

#[derive(Debug, Clone)]
pub struct HelcimConfig {
    api_token: Option<String>,
    device_code: Option<String>,
    api_base_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimConfigStatus {
    pub enabled: bool,
    pub device_configured: bool,
    pub device_code_suffix: Option<String>,
    pub api_base_host: String,
    pub missing_config: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimPurchaseRequest {
    pub currency: String,
    #[serde(rename = "transactionAmount")]
    pub transaction_amount: String,
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

impl HelcimConfig {
    pub fn from_env() -> Self {
        let api_token = non_empty_env("HELCIM_API_TOKEN");
        let device_code = non_empty_env("HELCIM_DEVICE_CODE");
        let api_base_url = non_empty_env("HELCIM_API_BASE_URL")
            .unwrap_or_else(|| DEFAULT_HELCIM_API_BASE_URL.to_string());

        Self {
            api_token,
            device_code,
            api_base_url: api_base_url.trim_end_matches('/').to_string(),
        }
    }

    pub fn enabled(&self) -> bool {
        self.api_token.is_some() && self.device_code.is_some()
    }

    pub fn device_code(&self) -> Option<&str> {
        self.device_code.as_deref()
    }

    pub fn api_token(&self) -> Option<&str> {
        self.api_token.as_deref()
    }

    pub fn api_base_url(&self) -> &str {
        &self.api_base_url
    }

    pub fn status(&self) -> HelcimConfigStatus {
        let mut missing_config = Vec::new();
        if self.api_token.is_none() {
            missing_config.push("HELCIM_API_TOKEN is not configured".to_string());
        }
        if self.device_code.is_none() {
            missing_config.push("HELCIM_DEVICE_CODE is not configured".to_string());
        }

        HelcimConfigStatus {
            enabled: self.enabled(),
            device_configured: self.device_code.is_some(),
            device_code_suffix: self.device_code.as_deref().map(mask_suffix),
            api_base_host: api_base_host(&self.api_base_url),
            missing_config,
        }
    }
}

pub fn build_purchase_request_payload(
    amount_cents: i64,
    currency: impl Into<String>,
) -> HelcimPurchaseRequest {
    HelcimPurchaseRequest {
        currency: currency.into().to_uppercase(),
        transaction_amount: cents_to_decimal_string(amount_cents),
    }
}

pub fn normalize_accepted_purchase(
    config: &HelcimConfig,
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
        terminal_id: config.device_code().unwrap_or_default().to_string(),
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
