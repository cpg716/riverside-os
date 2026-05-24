use base64::Engine;
use hmac::{Hmac, Mac};
use reqwest::header::AUTHORIZATION;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::logic::integration_credentials;

const NUORDER_MAX_RETRIES: u32 = 3;
const NUORDER_BASE_RETRY_DELAY_MS: u64 = 500;

fn nuorder_retry_delay(attempt: u32) -> Duration {
    Duration::from_millis(NUORDER_BASE_RETRY_DELAY_MS * 2_u64.pow(attempt))
}

type HmacSha1 = Hmac<Sha1>;

#[derive(Debug, Clone)]
pub struct NuorderCredentials {
    pub consumer_key: String,
    pub consumer_secret: String,
    pub user_token: String,
    pub user_secret: String,
}

pub struct NuorderClient {
    http: reqwest::Client,
    creds: NuorderCredentials,
    semaphore: Arc<Semaphore>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NuorderProduct {
    pub id: String,
    pub name: String,
    pub style_number: Option<String>,
    pub brand_name: Option<String>,
    pub description: Option<String>,
    pub wholesale_price: Option<rust_decimal::Decimal>,
    pub retail_price: Option<rust_decimal::Decimal>,
    pub image_urls: Vec<String>,
    pub variants: Vec<NuorderVariant>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NuorderVariant {
    pub id: String,
    pub upc: Option<String>,
    pub color: Option<String>,
    pub size: Option<String>,
    pub available_to_sell: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NuorderOrder {
    pub id: String,
    pub order_number: String,
    pub status: String,
    pub items: Vec<NuorderOrderItem>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NuorderOrderItem {
    pub product_id: String,
    pub variant_id: String,
    pub sku: String,
    pub quantity: i32,
    pub wholesale_price: rust_decimal::Decimal,
}

impl NuorderClient {
    pub fn new(creds: NuorderCredentials) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            http,
            creds,
            semaphore: Arc::new(Semaphore::new(5)), // NuORDER strict 5-concurrent limit
        }
    }

    /// Helper to sign OAuth 1.0 requests.
    fn get_oauth_header(&self, method: &str, url: &str) -> String {
        let nonce = Uuid::new_v4().to_string();
        let timestamp = chrono::Utc::now().timestamp().to_string();

        let mut params = [
            ("oauth_consumer_key", self.creds.consumer_key.as_str()),
            ("oauth_nonce", nonce.as_str()),
            ("oauth_signature_method", "HMAC-SHA1"),
            ("oauth_timestamp", timestamp.as_str()),
            ("oauth_token", self.creds.user_token.as_str()),
            ("oauth_version", "1.0"),
        ];
        params.sort_by(|a, b| a.0.cmp(b.0));

        let param_str = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
            .collect::<Vec<_>>()
            .join("&");

        let base_str = format!(
            "{}&{}&{}",
            method.to_uppercase(),
            urlencoding::encode(url),
            urlencoding::encode(&param_str)
        );

        let signing_key = format!(
            "{}&{}",
            urlencoding::encode(&self.creds.consumer_secret),
            urlencoding::encode(&self.creds.user_secret)
        );

        let mut mac = HmacSha1::new_from_slice(signing_key.as_bytes())
            .expect("HMAC can take key of any size");
        mac.update(base_str.as_bytes());
        let signature =
            base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());

        format!(
            "OAuth oauth_consumer_key=\"{}\", oauth_nonce=\"{}\", oauth_signature=\"{}\", oauth_signature_method=\"HMAC-SHA1\", oauth_timestamp=\"{}\", oauth_token=\"{}\", oauth_version=\"1.0\"",
            self.creds.consumer_key,
            nonce,
            urlencoding::encode(&signature),
            timestamp,
            self.creds.user_token
        )
    }

    pub async fn fetch_products(&self) -> anyhow::Result<Vec<NuorderProduct>> {
        let mut last_error = String::new();
        for attempt in 0..=NUORDER_MAX_RETRIES {
            if attempt > 0 {
                tokio::time::sleep(nuorder_retry_delay(attempt - 1)).await;
                tracing::info!(attempt, "Retrying NuORDER fetch_products");
            }
            let _permit = self.semaphore.acquire().await?;
            let url = "https://api.nuorder.com/api/v1/products";
            let auth = self.get_oauth_header("GET", url);

            let resp = match self.http.get(url).header(AUTHORIZATION, &auth).send().await {
                Ok(r) => r,
                Err(e) => {
                    if e.is_timeout() || e.is_connect() {
                        last_error = format!("NuORDER network error: {e}");
                        continue;
                    }
                    return Err(e.into());
                }
            };

            let status = resp.status();
            if status.is_success() {
                let products = resp.json::<Vec<NuorderProduct>>().await?;
                return Ok(products);
            }

            let body = resp.text().await.unwrap_or_default();
            if status.is_server_error() && attempt < NUORDER_MAX_RETRIES {
                last_error = format!("NuORDER HTTP {status}: {body}");
                continue;
            }
            anyhow::bail!("NuORDER API error: {status} — {body}");
        }
        anyhow::bail!("NuORDER fetch_products failed after retries: {last_error}")
    }

    pub async fn fetch_approved_orders(&self) -> anyhow::Result<Vec<NuorderOrder>> {
        let mut last_error = String::new();
        for attempt in 0..=NUORDER_MAX_RETRIES {
            if attempt > 0 {
                tokio::time::sleep(nuorder_retry_delay(attempt - 1)).await;
                tracing::info!(attempt, "Retrying NuORDER fetch_approved_orders");
            }
            let _permit = self.semaphore.acquire().await?;
            let url = "https://api.nuorder.com/api/v1/orders?status=Approved";
            let auth = self.get_oauth_header("GET", url);

            let resp = match self.http.get(url).header(AUTHORIZATION, &auth).send().await {
                Ok(r) => r,
                Err(e) => {
                    if e.is_timeout() || e.is_connect() {
                        last_error = format!("NuORDER network error: {e}");
                        continue;
                    }
                    return Err(e.into());
                }
            };

            let status = resp.status();
            if status.is_success() {
                let orders = resp.json::<Vec<NuorderOrder>>().await?;
                return Ok(orders);
            }

            let body = resp.text().await.unwrap_or_default();
            if status.is_server_error() && attempt < NUORDER_MAX_RETRIES {
                last_error = format!("NuORDER HTTP {status}: {body}");
                continue;
            }
            anyhow::bail!("NuORDER API error: {status} — {body}");
        }
        anyhow::bail!("NuORDER fetch_approved_orders failed after retries: {last_error}")
    }

    pub async fn update_inventory(&self, sku: &str, ats: i32) -> anyhow::Result<()> {
        let mut last_error = String::new();
        for attempt in 0..=NUORDER_MAX_RETRIES {
            if attempt > 0 {
                tokio::time::sleep(nuorder_retry_delay(attempt - 1)).await;
                tracing::info!(attempt, sku, "Retrying NuORDER update_inventory");
            }
            let _permit = self.semaphore.acquire().await?;
            let url = format!("https://api.nuorder.com/api/v1/inventory/{sku}");
            let auth = self.get_oauth_header("PUT", &url);

            let body = serde_json::json!({
                "available_to_sell": ats
            });

            let resp = match self
                .http
                .put(&url)
                .header(AUTHORIZATION, &auth)
                .json(&body)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    if e.is_timeout() || e.is_connect() {
                        last_error = format!("NuORDER network error: {e}");
                        continue;
                    }
                    return Err(e.into());
                }
            };

            let status = resp.status();
            if status.is_success() {
                return Ok(());
            }

            let body = resp.text().await.unwrap_or_default();
            if status.is_server_error() && attempt < NUORDER_MAX_RETRIES {
                last_error = format!("NuORDER HTTP {status}: {body}");
                continue;
            }
            anyhow::bail!("NuORDER Inventory update error: {status} — {body}");
        }
        anyhow::bail!("NuORDER update_inventory failed after retries: {last_error}")
    }

    /// Lightweight health check: attempts to list products with a small page.
    pub async fn health_check(&self) -> crate::logic::nuorder::NuorderHealth {
        let start = std::time::Instant::now();
        let _permit = match self.semaphore.acquire().await {
            Ok(p) => p,
            Err(_) => {
                return crate::logic::nuorder::NuorderHealth {
                    reachable: false,
                    latency_ms: 0,
                    message: "Could not acquire NuORDER rate-limit semaphore".to_string(),
                };
            }
        };
        let url = "https://api.nuorder.com/api/v1/products?page=1&per_page=1";
        let auth = self.get_oauth_header("GET", url);
        match self.http.get(url).header(AUTHORIZATION, &auth).send().await {
            Ok(resp) if resp.status().is_success() => crate::logic::nuorder::NuorderHealth {
                reachable: true,
                latency_ms: start.elapsed().as_millis() as u64,
                message: "NuORDER API is reachable".to_string(),
            },
            Ok(resp) => crate::logic::nuorder::NuorderHealth {
                reachable: false,
                latency_ms: start.elapsed().as_millis() as u64,
                message: format!("NuORDER returned HTTP {}", resp.status()),
            },
            Err(e) => crate::logic::nuorder::NuorderHealth {
                reachable: false,
                latency_ms: start.elapsed().as_millis() as u64,
                message: format!("NuORDER health check failed: {e}"),
            },
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub struct NuorderHealth {
    pub reachable: bool,
    pub latency_ms: u64,
    pub message: String,
}

pub async fn nuorder_client_from_pool(pool: &PgPool) -> anyhow::Result<NuorderClient> {
    let values = integration_credentials::load_integration_credentials(
        pool,
        "nuorder",
        &[
            "consumer_key",
            "consumer_secret",
            "user_token",
            "user_secret",
        ],
    )
    .await?;

    let consumer_key = values.get("consumer_key").cloned().unwrap_or_default();
    let consumer_secret = values.get("consumer_secret").cloned().unwrap_or_default();
    let user_token = values.get("user_token").cloned().unwrap_or_default();
    let user_secret = values.get("user_secret").cloned().unwrap_or_default();

    if consumer_key.is_empty()
        || consumer_secret.is_empty()
        || user_token.is_empty()
        || user_secret.is_empty()
    {
        anyhow::bail!("Missing NuORDER credentials");
    }

    Ok(NuorderClient::new(NuorderCredentials {
        consumer_key,
        consumer_secret,
        user_token,
        user_secret,
    }))
}
