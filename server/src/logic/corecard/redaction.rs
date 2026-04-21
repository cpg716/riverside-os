use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::CoreCardConfig;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CoreCardRedactionMode {
    Minimal,
    Standard,
    Strict,
}

impl CoreCardRedactionMode {
    pub fn from_env() -> Self {
        match std::env::var("RIVERSIDE_CORECARD_REDACTION")
            .ok()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("minimal") => Self::Minimal,
            Some("strict") => Self::Strict,
            _ => Self::Standard,
        }
    }
}

pub fn mask_account_identifier(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "Unavailable".to_string();
    }
    let last4: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    if last4.is_empty() {
        "Unavailable".to_string()
    } else {
        format!("••••{}", last4)
    }
}

fn key_should_mask(key: &str, mode: CoreCardRedactionMode) -> bool {
    let normalized = key.trim().to_ascii_lowercase();
    if normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("cvv")
        || normalized.contains("pan")
    {
        return true;
    }
    match mode {
        CoreCardRedactionMode::Minimal => false,
        CoreCardRedactionMode::Standard => {
            normalized.contains("account") || normalized.contains("card")
        }
        CoreCardRedactionMode::Strict => {
            normalized.contains("account")
                || normalized.contains("card")
                || normalized.contains("customer")
                || normalized.contains("number")
        }
    }
}

fn redact_scalar(key: Option<&str>, value: &Value, mode: CoreCardRedactionMode) -> Value {
    if let Some(k) = key {
        if key_should_mask(k, mode) {
            if let Some(text) = value.as_str() {
                return Value::String(mask_account_identifier(text));
            }
            if value.is_number() {
                return Value::String("***".to_string());
            }
        }
    }
    value.clone()
}

pub fn redact_corecard_json(value: &Value, mode: CoreCardRedactionMode) -> Value {
    match value {
        Value::Object(map) => {
            let mut redacted = Map::with_capacity(map.len());
            for (key, child) in map {
                let next = match child {
                    Value::Object(_) | Value::Array(_) => redact_corecard_json(child, mode),
                    _ => redact_scalar(Some(key), child, mode),
                };
                redacted.insert(key.clone(), next);
            }
            Value::Object(redacted)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact_corecard_json(item, mode))
                .collect(),
        ),
        _ => redact_scalar(None, value, mode),
    }
}

pub fn log_corecard_payload(
    config: &CoreCardConfig,
    direction: &str,
    endpoint: &str,
    payload: &Value,
) {
    if !config.log_payloads {
        tracing::debug!(direction, endpoint, "corecard payload logging disabled");
        return;
    }
    let redacted = redact_corecard_json(payload, config.redaction_mode);
    tracing::info!(direction, endpoint, payload = %redacted, "corecard payload");
}
