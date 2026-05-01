use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::str::FromStr;

pub const HELCIM_PROVIDER_KEY: &str = "helcim";
pub const DEFAULT_HELCIM_API_BASE_URL: &str = "https://api.helcim.com/v2";
pub const SIMULATOR_DEVICE_CODE: &str = "SIM1";

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
    pub simulator_enabled: bool,
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

#[derive(Debug, Clone, Deserialize)]
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
        (self.api_token.is_some() && self.device_code.is_some()) || self.simulator_enabled()
    }

    pub fn device_code(&self) -> Option<&str> {
        self.device_code.as_deref().or_else(|| {
            if self.simulator_enabled() {
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
        if !simulator_enabled {
            if self.api_token.is_none() {
                missing_config.push("HELCIM_API_TOKEN is not configured".to_string());
            }
            if self.device_code.is_none() {
                missing_config.push("HELCIM_DEVICE_CODE is not configured".to_string());
            }
        }

        HelcimConfigStatus {
            enabled: self.enabled(),
            device_configured: self.device_code().is_some(),
            simulator_enabled,
            device_code_suffix: self.device_code().map(mask_suffix),
            api_base_host: api_base_host(&self.api_base_url),
            missing_config,
        }
    }
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

pub async fn fetch_card_transaction(
    http: &reqwest::Client,
    config: &HelcimConfig,
    transaction_id: &str,
) -> Result<HelcimCardTransaction, String> {
    let token = config
        .api_token()
        .ok_or_else(|| "HELCIM_API_TOKEN is not configured".to_string())?;
    let url = format!(
        "{}/card-transactions/{transaction_id}",
        config.api_base_url()
    );
    let response = http
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("api-token", token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Helcim transaction lookup returned HTTP {}",
            response.status()
        ));
    }
    response
        .json::<HelcimCardTransaction>()
        .await
        .map_err(|e| e.to_string())
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
