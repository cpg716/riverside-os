use base64::Engine;
use hmac::{Hmac, Mac};
use reqwest::header::AUTHORIZATION;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use std::sync::Arc;
use tokio::sync::Semaphore;
use uuid::Uuid;

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
        Self {
            http: reqwest::Client::new(),
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
        let _permit = self.semaphore.acquire().await?;
        let url = "https://api.nuorder.com/api/v1/products";
        let auth = self.get_oauth_header("GET", url);

        let resp = self
            .http
            .get(url)
            .header(AUTHORIZATION, auth)
            .send()
            .await?;

        if !resp.status().is_success() {
            anyhow::bail!("NuORDER API error: {}", resp.status());
        }

        let products = resp.json::<Vec<NuorderProduct>>().await?;
        Ok(products)
    }

    pub async fn fetch_approved_orders(&self) -> anyhow::Result<Vec<NuorderOrder>> {
        let _permit = self.semaphore.acquire().await?;
        // nuorder often filters by status
        let url = "https://api.nuorder.com/api/v1/orders?status=Approved";
        let auth = self.get_oauth_header("GET", url);

        let resp = self
            .http
            .get(url)
            .header(AUTHORIZATION, auth)
            .send()
            .await?;

        if !resp.status().is_success() {
            anyhow::bail!("NuORDER API error: {}", resp.status());
        }

        let orders = resp.json::<Vec<NuorderOrder>>().await?;
        Ok(orders)
    }

    pub async fn update_inventory(&self, sku: &str, ats: i32) -> anyhow::Result<()> {
        let _permit = self.semaphore.acquire().await?;
        let url = format!("https://api.nuorder.com/api/v1/inventory/{sku}");
        let auth = self.get_oauth_header("PUT", &url);

        let body = serde_json::json!({
            "available_to_sell": ats
        });

        let resp = self
            .http
            .put(&url)
            .header(AUTHORIZATION, auth)
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            anyhow::bail!("NuORDER Inventory update error: {}", resp.status());
        }

        Ok(())
    }
}
