pub mod auth;
pub mod models;
pub mod redaction;
pub mod service;

use thiserror::Error;

pub use auth::CoreCardTokenCache;
pub use models::*;
pub use redaction::{mask_account_identifier, redact_corecard_json, CoreCardRedactionMode};
pub use service::*;

#[derive(Debug, Clone)]
pub struct CoreCardConfig {
    pub base_url: String,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub region: String,
    pub environment: String,
    pub timeout_secs: u64,
    pub log_payloads: bool,
    pub redaction_mode: CoreCardRedactionMode,
    pub webhook_secret: Option<String>,
    pub webhook_allow_unsigned: bool,
    pub repair_poll_secs: u64,
    pub snapshot_retention_days: u32,
}

impl CoreCardConfig {
    pub fn from_env() -> Self {
        let base_url = std::env::var("RIVERSIDE_CORECARD_BASE_URL")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_default();

        let client_id = std::env::var("RIVERSIDE_CORECARD_CLIENT_ID")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let client_secret = std::env::var("RIVERSIDE_CORECARD_CLIENT_SECRET")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let region = std::env::var("RIVERSIDE_CORECARD_REGION")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "us".to_string());

        let environment = std::env::var("RIVERSIDE_CORECARD_ENVIRONMENT")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "sandbox".to_string());

        let timeout_secs = std::env::var("RIVERSIDE_CORECARD_TIMEOUT_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|s| *s > 0)
            .unwrap_or(15);

        let log_payloads = matches!(
            std::env::var("RIVERSIDE_CORECARD_LOG_PAYLOADS")
                .ok()
                .as_deref()
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("1" | "true" | "yes" | "on")
        );

        let redaction_mode = CoreCardRedactionMode::from_env();
        let webhook_secret = std::env::var("RIVERSIDE_CORECARD_WEBHOOK_SECRET")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let webhook_allow_unsigned = matches!(
            std::env::var("RIVERSIDE_CORECARD_WEBHOOK_ALLOW_UNSIGNED")
                .ok()
                .as_deref()
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("1" | "true" | "yes" | "on")
        );
        let repair_poll_secs = std::env::var("RIVERSIDE_CORECARD_REPAIR_POLL_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|s| *s >= 60)
            .unwrap_or(15 * 60);
        let snapshot_retention_days = std::env::var("RIVERSIDE_CORECARD_SNAPSHOT_RETENTION_DAYS")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .filter(|s| *s >= 7)
            .unwrap_or(30);

        Self {
            base_url,
            client_id,
            client_secret,
            region,
            environment,
            timeout_secs,
            log_payloads,
            redaction_mode,
            webhook_secret,
            webhook_allow_unsigned,
            repair_poll_secs,
            snapshot_retention_days,
        }
    }

    pub fn is_configured(&self) -> bool {
        !self.base_url.is_empty()
            && self.client_id.as_deref().is_some()
            && self.client_secret.as_deref().is_some()
    }

    pub fn token_url(&self) -> Option<String> {
        if self.base_url.is_empty() {
            None
        } else {
            Some(format!("{}/oauth/token", self.base_url))
        }
    }

    pub fn account_summary_url(&self, account_id: &str) -> Option<String> {
        if self.base_url.is_empty() {
            None
        } else {
            Some(format!(
                "{}/accounts/{}/summary",
                self.base_url,
                urlencoding::encode(account_id)
            ))
        }
    }

    pub fn account_programs_url(&self, account_id: &str) -> Option<String> {
        if self.base_url.is_empty() {
            None
        } else {
            Some(format!(
                "{}/accounts/{}/programs",
                self.base_url,
                urlencoding::encode(account_id)
            ))
        }
    }

    fn transaction_endpoint_url(&self, operation: &str) -> Option<String> {
        if self.base_url.is_empty() {
            None
        } else {
            Some(format!("{}/transactions/{}", self.base_url, operation))
        }
    }

    pub fn purchase_url(&self) -> Option<String> {
        self.transaction_endpoint_url("purchase")
    }

    pub fn payment_url(&self) -> Option<String> {
        self.transaction_endpoint_url("payment")
    }

    pub fn refund_url(&self) -> Option<String> {
        self.transaction_endpoint_url("refund")
    }

    pub fn reversal_url(&self) -> Option<String> {
        self.transaction_endpoint_url("reversal")
    }

    pub fn account_balances_url(&self, account_id: &str) -> Option<String> {
        if self.base_url.is_empty() {
            None
        } else {
            Some(format!(
                "{}/accounts/{}/balances",
                self.base_url,
                urlencoding::encode(account_id)
            ))
        }
    }

    pub fn account_transactions_url(&self, account_id: &str) -> Option<String> {
        if self.base_url.is_empty() {
            None
        } else {
            Some(format!(
                "{}/accounts/{}/transactions",
                self.base_url,
                urlencoding::encode(account_id)
            ))
        }
    }
}

#[derive(Debug, Error)]
pub enum CoreCardError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("corecard integration is not configured")]
    NotConfigured,
    #[error("corecard auth failed: {0}")]
    Auth(String),
    #[error("corecard request failed: {0}")]
    Api(String),
    #[error("linked account not found")]
    AccountNotFound,
    #[error("{0}")]
    InvalidRequest(String),
    #[error("{message}")]
    HostFailure {
        code: CoreCardFailureCode,
        message: String,
        retryable: bool,
    },
}

impl CoreCardError {
    pub fn host_failure(
        code: CoreCardFailureCode,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self::HostFailure {
            code,
            message: message.into(),
            retryable,
        }
    }

    pub fn as_host_failure(&self) -> Option<CoreCardHostFailure> {
        match self {
            Self::HostFailure {
                code,
                message,
                retryable,
            } => Some(CoreCardHostFailure {
                code: code.clone(),
                message: message.clone(),
                retryable: *retryable,
            }),
            _ => None,
        }
    }
}
