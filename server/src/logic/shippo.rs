//! Shippo integration logic for shipping rates and label purchasing.

use chrono::{Duration, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::str::FromStr;

pub const RATE_QUOTE_TTL_MINUTES: i64 = 15;

#[derive(Debug, thiserror::Error)]
pub enum ShippoError {
    #[error("API error: {0}")]
    Api(String),
    #[error("Invalid address: {0}")]
    InvalidAddress(String),
    #[error("Parse error: {0}")]
    Parse(String),
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ShippoAddressFields {
    pub name: String,
    pub street1: String,
    pub street2: Option<String>,
    pub city: String,
    pub state: String,
    pub zip: String,
    pub country: String,
    pub phone: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DefaultParcel {
    pub length_in: Decimal,
    pub width_in: Decimal,
    pub height_in: Decimal,
    pub weight_oz: Decimal,
}

impl Default for DefaultParcel {
    fn default() -> Self {
        Self {
            length_in: Decimal::from(12),
            width_in: Decimal::from(9),
            height_in: Decimal::from(3),
            weight_oz: Decimal::from(16),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct StoreShippoConfig {
    pub enabled: bool,
    pub live_rates_enabled: bool,
    pub from_address: ShippoAddressFields,
    pub default_parcel: DefaultParcel,
}

impl StoreShippoConfig {
    pub fn load_from_json(v: Value) -> Self {
        serde_json::from_value(v).unwrap_or_default()
    }
}

pub struct EffectiveShippoConfig {
    pub store: StoreShippoConfig,
    pub api_token_configured: bool,
}

pub fn shippo_api_token_from_env() -> Option<String> {
    std::env::var("SHIPPO_API_TOKEN")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

pub fn shippo_webhook_secret_from_env() -> Option<String> {
    std::env::var("SHIPPO_WEBHOOK_SECRET")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

pub async fn load_effective_shippo_config(
    pool: &PgPool,
) -> Result<EffectiveShippoConfig, sqlx::Error> {
    let raw: Value = sqlx::query_scalar("SELECT shippo_config FROM store_settings WHERE id = 1")
        .fetch_one(pool)
        .await?;
    let store = StoreShippoConfig::load_from_json(raw);
    Ok(EffectiveShippoConfig {
        store,
        api_token_configured: shippo_api_token_from_env().is_some(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShippingAddressInput {
    pub name: String,
    pub street1: String,
    pub city: String,
    pub state: String,
    pub zip: String,
    #[serde(default)]
    pub country: String,
}

impl ShippingAddressInput {
    pub fn validate(&self) -> Result<(), ShippoError> {
        if self.street1.trim().is_empty()
            || self.city.trim().is_empty()
            || self.state.trim().is_empty()
            || self.zip.trim().is_empty()
        {
            return Err(ShippoError::InvalidAddress(
                "name, street1, city, state, zip required".into(),
            ));
        }
        Ok(())
    }

    fn country_or_us(&self) -> String {
        let c = self.country.trim();
        if c.is_empty() {
            "US".to_string()
        } else {
            c.to_uppercase()
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ParcelInput {
    pub length_in: Option<Decimal>,
    pub width_in: Option<Decimal>,
    pub height_in: Option<Decimal>,
    pub weight_oz: Option<Decimal>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NormalizedRate {
    pub amount_usd: Decimal,
    pub carrier: String,
    pub service_name: String,
    pub shippo_rate_object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_days: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RateWithQuoteId {
    pub rate_quote_id: uuid::Uuid,
    pub amount_usd: Decimal,
    pub carrier: String,
    pub service_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_days: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StoreShippingRatesResult {
    pub rates: Vec<RateWithQuoteId>,
    pub stub: bool,
}

fn address_to_shippo_json(a: &ShippoAddressFields) -> Value {
    let country = if a.country.trim().is_empty() {
        "US"
    } else {
        a.country.trim()
    };
    json!({
        "name": a.name,
        "street1": a.street1,
        "city": a.city,
        "state": a.state,
        "zip": a.zip,
        "country": country,
        "phone": a.phone,
    })
}

fn input_to_shippo_json(a: &ShippingAddressInput) -> Value {
    json!({
        "name": a.name,
        "street1": a.street1,
        "city": a.city,
        "state": a.state,
        "zip": a.zip,
        "country": a.country_or_us(),
    })
}

fn parcel_json(cfg: &DefaultParcel, override_parcel: Option<&ParcelInput>) -> Value {
    let p = override_parcel;
    let length = p
        .and_then(|x| x.length_in.map(|d| d.to_string()))
        .unwrap_or_else(|| cfg.length_in.to_string());
    let width = p
        .and_then(|x| x.width_in.map(|d| d.to_string()))
        .unwrap_or_else(|| cfg.width_in.to_string());
    let height = p
        .and_then(|x| x.height_in.map(|d| d.to_string()))
        .unwrap_or_else(|| cfg.height_in.to_string());
    let weight = p
        .and_then(|x| x.weight_oz.map(|d| d.to_string()))
        .unwrap_or_else(|| cfg.weight_oz.to_string());
    json!({
        "length": length,
        "width": width,
        "height": height,
        "distance_unit": "in",
        "weight": weight,
        "mass_unit": "oz",
    })
}

fn parse_decimal_amount(s: &str) -> Result<Decimal, ShippoError> {
    Decimal::from_str(s.trim()).map_err(|e| ShippoError::Parse(e.to_string()))
}

pub fn stub_normalized_rates() -> Vec<NormalizedRate> {
    use rust_decimal_macros::dec;
    vec![
        NormalizedRate {
            amount_usd: dec!(8.50),
            carrier: "USPS".into(),
            service_name: "Priority Mail".into(),
            shippo_rate_object_id: None,
            estimated_days: Some("2-3".into()),
        },
        NormalizedRate {
            amount_usd: dec!(12.75),
            carrier: "USPS".into(),
            service_name: "Priority Mail Express".into(),
            shippo_rate_object_id: None,
            estimated_days: Some("1-2".into()),
        },
        NormalizedRate {
            amount_usd: dec!(10.00),
            carrier: "UPS".into(),
            service_name: "Ground".into(),
            shippo_rate_object_id: None,
            estimated_days: Some("3-5".into()),
        },
    ]
}

async fn fetch_live_rates(
    http: &reqwest::Client,
    token: &str,
    from: &ShippoAddressFields,
    to: &ShippingAddressInput,
    parcel: &Value,
) -> Result<Vec<NormalizedRate>, ShippoError> {
    if from.street1.trim().is_empty()
        || from.city.trim().is_empty()
        || from.state.trim().is_empty()
        || from.zip.trim().is_empty()
    {
        return Err(ShippoError::InvalidAddress(
            "Configure ship-from address in Settings before live Shippio rates".into(),
        ));
    }

    let body = json!({
        "address_from": address_to_shippo_json(from),
        "address_to": input_to_shippo_json(to),
        "parcels": [parcel],
        "async": false,
    });

    let resp = http
        .post("https://api.goshippo.com/shipments/")
        .header("Authorization", format!("ShippoToken {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| ShippoError::Api(e.to_string()))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        tracing::warn!(status = %status, "shippo shipment create failed");
        return Err(ShippoError::Api(format!("HTTP {status}: {text}")));
    }

    let v: serde_json::Value = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| ShippoError::Api(e.to_string()))?;

    let rates = v
        .get("rates")
        .and_then(|r| r.as_array())
        .ok_or_else(|| ShippoError::Api("missing rates array in Shippo response".into()))?;

    let mut out = Vec::new();
    for r in rates {
        let amount_s = match r.get("amount") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            _ => {
                return Err(ShippoError::Api("rate missing amount".into()));
            }
        };
        let amount_usd = parse_decimal_amount(&amount_s)?;
        let carrier = r
            .get("provider")
            .and_then(|x| x.as_str())
            .unwrap_or("Carrier")
            .to_string();
        let service_name = r
            .get("servicelevel")
            .and_then(|s| s.get("name"))
            .and_then(|x| x.as_str())
            .unwrap_or("Standard")
            .to_string();
        let oid = r
            .get("object_id")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let est = r
            .get("estimated_days")
            .and_then(|x| x.as_i64())
            .map(|d| format!("{d}"));
        out.push(NormalizedRate {
            amount_usd,
            carrier,
            service_name,
            shippo_rate_object_id: oid,
            estimated_days: est,
        });
    }

    out.sort_by(|a, b| a.amount_usd.cmp(&b.amount_usd));
    Ok(out)
}

pub async fn persist_rate_quotes(
    pool: &PgPool,
    rates: &[NormalizedRate],
    stub: bool,
    ship_to: &ShippingAddressInput,
) -> Result<Vec<RateWithQuoteId>, sqlx::Error> {
    let expires_at = Utc::now() + Duration::minutes(RATE_QUOTE_TTL_MINUTES);
    let ship_json = serde_json::to_value(ship_to).unwrap_or_else(|_| json!({}));
    let mut out = Vec::with_capacity(rates.len());

    for rate in rates {
        let meta = json!({ "stub": stub, "ship_to": ship_json });
        let id: uuid::Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO store_shipping_rate_quote (
                expires_at, amount_usd, carrier, service_name, shippo_rate_object_id, metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
            "#,
        )
        .bind(expires_at)
        .bind(rate.amount_usd)
        .bind(&rate.carrier)
        .bind(&rate.service_name)
        .bind(&rate.shippo_rate_object_id)
        .bind(meta)
        .fetch_one(pool)
        .await?;

        out.push(RateWithQuoteId {
            rate_quote_id: id,
            amount_usd: rate.amount_usd,
            carrier: rate.carrier.clone(),
            service_name: rate.service_name.clone(),
            estimated_days: rate.estimated_days.clone(),
        });
    }

    Ok(out)
}

pub async fn prune_expired_rate_quotes(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM store_shipping_rate_quote WHERE expires_at < NOW()")
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn store_shipping_rates(
    pool: &PgPool,
    http: &reqwest::Client,
    to: &ShippingAddressInput,
    parcel_override: Option<&ParcelInput>,
    force_stub: bool,
) -> Result<StoreShippingRatesResult, ShippoError> {
    to.validate()?;

    let eff = load_effective_shippo_config(pool).await?;
    let _ = prune_expired_rate_quotes(pool).await;

    let parcel = parcel_json(&eff.store.default_parcel, parcel_override);

    let use_live = !force_stub
        && eff.store.enabled
        && eff.store.live_rates_enabled
        && eff.api_token_configured;

    let (normalized, stub) = if use_live {
        let token = shippo_api_token_from_env().ok_or_else(|| {
            ShippoError::Api("SHIPPO_API_TOKEN missing despite live_rates_enabled".into())
        })?;
        match fetch_live_rates(http, &token, &eff.store.from_address, to, &parcel).await {
            Ok(r) if !r.is_empty() => (r, false),
            Ok(_) => (stub_normalized_rates(), true),
            Err(e) => {
                tracing::warn!(error = %e, "shippo live rates failed; falling back to stub");
                (stub_normalized_rates(), true)
            }
        }
    } else {
        (stub_normalized_rates(), true)
    };

    let rates = persist_rate_quotes(pool, &normalized, stub, to)
        .await
        .map_err(|e| ShippoError::Api(e.to_string()))?;
    Ok(StoreShippingRatesResult {
        rates: rates
            .into_iter()
            .map(|r| RateWithQuoteId {
                rate_quote_id: r.rate_quote_id,
                amount_usd: r.amount_usd,
                carrier: r.carrier,
                service_name: r.service_name,
                estimated_days: r.estimated_days,
            })
            .collect(),
        stub,
    })
}

pub async fn pos_shipping_rates(
    pool: &PgPool,
    http: &reqwest::Client,
    to: &ShippingAddressInput,
    parcel_override: Option<&ParcelInput>,
    force_stub: bool,
) -> Result<StoreShippingRatesResult, ShippoError> {
    store_shipping_rates(pool, http, to, parcel_override, force_stub).await
}

#[derive(Debug, Clone, Serialize)]
pub struct PurchasedLabel {
    pub shippo_transaction_object_id: String,
    pub shippo_shipment_object_id: Option<String>,
    pub tracking_number: Option<String>,
    pub tracking_url_provider: Option<String>,
    pub shipping_label_url: Option<String>,
    pub label_cost_usd: Option<Decimal>,
}

pub async fn purchase_transaction_for_rate(
    http: &reqwest::Client,
    rate_object_id: &str,
) -> Result<PurchasedLabel, ShippoError> {
    let token = shippo_api_token_from_env()
        .ok_or_else(|| ShippoError::Api("SHIPPO_API_TOKEN not configured".into()))?;
    if rate_object_id.trim().is_empty() {
        return Err(ShippoError::InvalidAddress(
            "no Shippo rate on file — refresh live rates and apply a quote (stub quotes cannot buy labels)"
                .into(),
        ));
    }

    let body = json!({
        "rate": rate_object_id.trim(),
        "label_file_type": "PDF",
        "async": false,
    });

    let resp = http
        .post("https://api.goshippo.com/transactions/")
        .header("Authorization", format!("ShippoToken {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| ShippoError::Api(e.to_string()))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        tracing::warn!(status = %status, "shippo transaction create failed");
        return Err(ShippoError::Api(format!("HTTP {status}: {text}")));
    }

    let v: serde_json::Value = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| ShippoError::Api(e.to_string()))?;

    let st = v.get("status").and_then(|x| x.as_str()).unwrap_or("");
    if st == "ERROR" {
        let msgs = v.get("messages").map(|m| m.to_string()).unwrap_or_default();
        return Err(ShippoError::Api(format!("Shippo transaction: {msgs}")));
    }

    let transaction_oid = v
        .get("object_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| ShippoError::Api("transaction missing object_id".into()))?
        .to_string();

    let tracking_number = v
        .get("tracking_number")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty());

    let tracking_url_provider = v
        .get("tracking_url_provider")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty());

    let shipping_label_url = v
        .get("label_url")
        .or_else(|| v.get("commercial_invoice_url"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());

    let shippo_shipment_object_id = v
        .get("rate")
        .and_then(|r| r.get("shipment"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    let label_cost_usd = v
        .get("rate")
        .and_then(|r| r.get("amount"))
        .and_then(|a| a.as_str())
        .and_then(|s| parse_decimal_amount(s).ok());

    Ok(PurchasedLabel {
        shippo_transaction_object_id: transaction_oid,
        shippo_shipment_object_id,
        tracking_number,
        tracking_url_provider,
        shipping_label_url,
        label_cost_usd,
    })
}
