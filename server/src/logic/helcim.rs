use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use std::str::FromStr;

use crate::logic::integration_credentials::{self, IntegrationCredentialError};

pub const HELCIM_PROVIDER_KEY: &str = "helcim";
pub const DEFAULT_HELCIM_API_BASE_URL: &str = "https://api.helcim.com/v2";
pub const SIMULATOR_DEVICE_CODE: &str = "SIM1";

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
    pub register_1_device_configured: bool,
    pub register_2_device_configured: bool,
    pub simulator_enabled: bool,
    pub webhook_secret_configured: bool,
    pub terminal_1_device_code_suffix: Option<String>,
    pub terminal_2_device_code_suffix: Option<String>,
    pub register_1_device_code_suffix: Option<String>,
    pub register_2_device_code_suffix: Option<String>,
    pub api_base_host: String,
    pub missing_config: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimPurchaseRequest {
    pub currency: String,
    #[serde(rename = "transactionAmount")]
    pub transaction_amount: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimTerminalRefundRequest {
    #[serde(rename = "transactionAmount")]
    pub transaction_amount: String,
    #[serde(rename = "originalTransactionId")]
    pub original_transaction_id: i64,
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
        let api_token = non_empty_env("HELCIM_API_TOKEN");
        let terminal_1_device_code = non_empty_env("HELCIM_TERMINAL_1_DEVICE_CODE")
            .or_else(|| non_empty_env("HELCIM_REGISTER_1_DEVICE_CODE"));
        let terminal_2_device_code = non_empty_env("HELCIM_TERMINAL_2_DEVICE_CODE")
            .or_else(|| non_empty_env("HELCIM_REGISTER_2_DEVICE_CODE"));
        let api_base_url = non_empty_env("HELCIM_API_BASE_URL")
            .unwrap_or_else(|| DEFAULT_HELCIM_API_BASE_URL.to_string());

        Self {
            api_token,
            terminal_1_device_code,
            terminal_2_device_code,
            api_base_url: api_base_url.trim_end_matches('/').to_string(),
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
        if !simulator_enabled && self.api_token.is_none() {
            missing_config.push("HELCIM_API_TOKEN is not configured".to_string());
        }

        HelcimConfigStatus {
            enabled: self.enabled(),
            api_token_configured: self.api_token.is_some(),
            terminal_1_device_configured: self.device_code_for_terminal_key("terminal_1").is_some(),
            terminal_2_device_configured: self.device_code_for_terminal_key("terminal_2").is_some(),
            register_1_device_configured: self.device_code_for_register_lane(1).is_some(),
            register_2_device_configured: self.device_code_for_register_lane(2).is_some(),
            simulator_enabled,
            webhook_secret_configured: non_empty_env("HELCIM_WEBHOOK_SECRET").is_some(),
            terminal_1_device_code_suffix: self
                .device_code_for_terminal_key("terminal_1")
                .map(mask_suffix),
            terminal_2_device_code_suffix: self
                .device_code_for_terminal_key("terminal_2")
                .map(mask_suffix),
            register_1_device_code_suffix: self.device_code_for_register_lane(1).map(mask_suffix),
            register_2_device_code_suffix: self.device_code_for_register_lane(2).map(mask_suffix),
            api_base_host: api_base_host(&self.api_base_url),
            missing_config,
        }
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
    let net_amount = first_decimal_field(payload, NET_FIELDS).map(|(_, amount)| amount);
    let merchant_fee = fee.as_ref().map(|(_, amount)| *amount);
    let source_field = fee.map(|(field, _)| field);
    let card_batch_id = first_string_field(payload, &["cardBatchId", "card_batch_id"]);

    HelcimFeeDetails {
        merchant_fee,
        net_amount,
        card_batch_id,
        source_field,
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
            &["grossAmount", "gross_amount", "totalAmount", "totalSales"],
        )
        .map(|(_, amount)| amount),
        fee_amount: first_decimal_field(payload, &["feeAmount", "fee_amount", "merchantFee"])
            .map(|(_, amount)| amount),
        net_amount: first_decimal_field(payload, &["netAmount", "net_amount"])
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
                .map(|value| value.and_utc())
        })
        .or_else(|| {
            NaiveDate::parse_from_str(&raw, "%Y-%m-%d")
                .ok()
                .and_then(|value| value.and_hms_opt(0, 0, 0))
                .map(|value| value.and_utc())
        })
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

pub async fn get_customers(
    http: &reqwest::Client,
    config: &HelcimConfig,
    query: &[(&str, String)],
) -> Result<Value, String> {
    send_get_request(http, config, "customers/", query).await
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
    let code = normalized_device_code(code)?;
    let path = format!("devices/{code}");
    send_get_request(http, config, &path, &[]).await
}

pub async fn ping_device(
    http: &reqwest::Client,
    config: &HelcimConfig,
    code: &str,
) -> Result<Value, String> {
    let code = normalized_device_code(code)?;
    let token = config
        .api_token()
        .ok_or_else(|| "HELCIM_API_TOKEN is not configured".to_string())?;
    let url = format!("{}/devices/{code}/ping", config.api_base_url());
    let response = http
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("api-token", token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status() != reqwest::StatusCode::ACCEPTED && !response.status().is_success() {
        return Err(response_error_message("Helcim device ping", response).await);
    }
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
        .ok_or_else(|| "HELCIM_API_TOKEN is not configured".to_string())?;
    let url = format!(
        "{}/customers/{customer_id}/cards/{card_id}",
        config.api_base_url()
    );
    let response = http
        .delete(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("api-token", token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(response_error_message("Helcim delete customer card", response).await);
    }
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
        .ok_or_else(|| "HELCIM_API_TOKEN is not configured".to_string())?;
    let url = format!(
        "{}/customers/{customer_id}/cards/{card_id}/default",
        config.api_base_url()
    );
    let response = http
        .patch(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("api-token", token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(response_error_message("Helcim set customer card default", response).await);
    }
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
) -> HelcimPurchaseRequest {
    HelcimPurchaseRequest {
        currency: currency.into().to_uppercase(),
        transaction_amount: cents_to_decimal_string(amount_cents),
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

pub async fn process_card_token_purchase(
    http: &reqwest::Client,
    config: &HelcimConfig,
    request: HelcimCardPurchaseRequest,
    idempotency_key: &str,
) -> Result<HelcimCardTransaction, String> {
    send_payment_request(http, config, "payment/purchase", &request, idempotency_key).await
}

pub async fn process_card_refund(
    http: &reqwest::Client,
    config: &HelcimConfig,
    request: HelcimCardRefundRequest,
    idempotency_key: &str,
) -> Result<HelcimCardTransaction, String> {
    send_payment_request(http, config, "payment/refund", &request, idempotency_key).await
}

pub async fn process_card_reverse(
    http: &reqwest::Client,
    config: &HelcimConfig,
    request: HelcimCardReverseRequest,
    idempotency_key: &str,
) -> Result<HelcimCardTransaction, String> {
    send_payment_request(http, config, "payment/reverse", &request, idempotency_key).await
}

pub async fn start_terminal_refund(
    http: &reqwest::Client,
    config: &HelcimConfig,
    device_code: &str,
    request: HelcimTerminalRefundRequest,
    idempotency_key: &str,
) -> Result<HelcimAcceptedPurchaseResponse, String> {
    let token = config
        .api_token()
        .ok_or_else(|| "HELCIM_API_TOKEN is not configured".to_string())?;
    let url = format!(
        "{}/devices/{device_code}/payment/refund",
        config.api_base_url()
    );
    let response = http
        .post(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("api-token", token)
        .header("idempotency-key", idempotency_key)
        .json(&request)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status() != reqwest::StatusCode::ACCEPTED {
        return Err(response_error_message("Helcim terminal refund", response).await);
    }
    response
        .json::<HelcimAcceptedPurchaseResponse>()
        .await
        .map_err(|e| e.to_string())
}

pub async fn initialize_helcim_pay(
    http: &reqwest::Client,
    config: &HelcimConfig,
    request: HelcimPayInitializeRequest,
) -> Result<HelcimPayInitializeResponse, String> {
    let token = config
        .api_token()
        .ok_or_else(|| "HELCIM_API_TOKEN is not configured".to_string())?;
    let url = format!("{}/helcim-pay/initialize", config.api_base_url());
    let response = http
        .post(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("api-token", token)
        .json(&request)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(response_error_message("HelcimPay.js initialization", response).await);
    }
    response
        .json::<HelcimPayInitializeResponse>()
        .await
        .map_err(|e| e.to_string())
}

async fn send_payment_request<T: Serialize + ?Sized>(
    http: &reqwest::Client,
    config: &HelcimConfig,
    path: &str,
    request: &T,
    idempotency_key: &str,
) -> Result<HelcimCardTransaction, String> {
    let token = config
        .api_token()
        .ok_or_else(|| "HELCIM_API_TOKEN is not configured".to_string())?;
    let url = format!("{}/{}", config.api_base_url(), path);
    let response = http
        .post(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("api-token", token)
        .header("idempotency-key", idempotency_key)
        .json(request)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(response_error_message("Helcim payment request", response).await);
    }
    response
        .json::<HelcimCardTransaction>()
        .await
        .map_err(|e| e.to_string())
}

async fn send_get_request(
    http: &reqwest::Client,
    config: &HelcimConfig,
    path: &str,
    query: &[(&str, String)],
) -> Result<Value, String> {
    let token = config
        .api_token()
        .ok_or_else(|| "HELCIM_API_TOKEN is not configured".to_string())?;
    let url = format!("{}/{}", config.api_base_url(), path);
    let response = http
        .get(&url)
        .query(query)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("api-token", token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(response_error_message("Helcim GET request", response).await);
    }
    response.json::<Value>().await.map_err(|e| e.to_string())
}

async fn response_error_message(context: &str, response: reqwest::Response) -> String {
    let status = response.status();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let minute_remaining = response
        .headers()
        .get("minute-limit-remaining")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let hourly_remaining = response
        .headers()
        .get("hour-limit-remaining")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let message = response.text().await.unwrap_or_default();
    let mut detail = format!("{context} returned HTTP {status}");
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        detail.push_str("; Helcim rate limit reached");
    }
    if let Some(value) = retry_after {
        detail.push_str(&format!("; retry-after={value}"));
    }
    if let Some(value) = minute_remaining {
        detail.push_str(&format!("; minute-limit-remaining={value}"));
    }
    if let Some(value) = hourly_remaining {
        detail.push_str(&format!("; hour-limit-remaining={value}"));
    }
    if !message.trim().is_empty() {
        detail.push_str(&format!(": {message}"));
    }
    detail
}

fn normalized_device_code(code: &str) -> Result<String, String> {
    let code = code.trim().to_ascii_uppercase();
    if code.is_empty() || code.len() > 4 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Helcim device code must be 1 to 4 alphanumeric characters".to_string());
    }
    Ok(code)
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
    use serde_json::json;

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
}
