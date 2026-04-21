use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::{redaction::log_corecard_payload, CoreCardConfig, CoreCardError};

#[derive(Debug, Default)]
pub struct CoreCardTokenCache {
    pub access_token: Option<String>,
    pub expires_at: Option<chrono::DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct CoreCardTokenResponse {
    access_token: String,
    #[allow(dead_code)]
    token_type: Option<String>,
    expires_in: Option<i64>,
}

pub async fn ensure_access_token(
    http_client: &reqwest::Client,
    config: &CoreCardConfig,
    token_cache: &Arc<Mutex<CoreCardTokenCache>>,
) -> Result<Option<String>, CoreCardError> {
    if !config.is_configured() {
        return Ok(None);
    }

    {
        let cache = token_cache.lock().await;
        if let (Some(token), Some(expires_at)) = (&cache.access_token, cache.expires_at) {
            if expires_at > Utc::now() + Duration::seconds(30) {
                return Ok(Some(token.clone()));
            }
        }
    }

    let Some(token_url) = config.token_url() else {
        return Err(CoreCardError::NotConfigured);
    };

    let payload = json!({
        "grant_type": "client_credentials",
        "client_id": config.client_id.as_deref().unwrap_or_default(),
        "client_secret": config.client_secret.as_deref().unwrap_or_default(),
        "region": config.region,
        "environment": config.environment,
    });
    log_corecard_payload(config, "outbound", "auth.token", &payload);

    let response = http_client
        .post(token_url)
        .timeout(std::time::Duration::from_secs(config.timeout_secs))
        .json(&payload)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        tracing::warn!(status = %status, body = %body, "corecard token request failed");
        return Err(CoreCardError::Auth(format!(
            "token endpoint returned {status}"
        )));
    }

    let parsed: CoreCardTokenResponse = response.json().await?;
    let expires_at = Utc::now() + Duration::seconds(parsed.expires_in.unwrap_or(900).max(60));

    {
        let mut cache = token_cache.lock().await;
        cache.access_token = Some(parsed.access_token.clone());
        cache.expires_at = Some(expires_at);
    }

    Ok(Some(parsed.access_token))
}
