//! Shippo integration logic for shipping rates and label purchasing.

use chrono::{Duration, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::str::FromStr;

pub const RATE_QUOTE_TTL_MINUTES: i64 = 15;
const SHIPPO_API_VERSION: &str = "2018-02-08";

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
    #[serde(default)]
    pub company: Option<String>,
    pub street1: String,
    #[serde(default)]
    pub street2: Option<String>,
    pub city: String,
    pub state: String,
    pub zip: String,
    pub country: String,
    pub phone: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub is_residential: Option<bool>,
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
    #[serde(default)]
    pub company: Option<String>,
    pub street1: String,
    #[serde(default)]
    pub street2: Option<String>,
    pub city: String,
    pub state: String,
    pub zip: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub is_residential: Option<bool>,
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
    let mut v = json!({
        "name": a.name,
        "street1": a.street1,
        "street2": a.street2.clone().unwrap_or_default(),
        "city": a.city,
        "state": a.state,
        "zip": a.zip,
        "country": country,
        "phone": a.phone,
    });
    if let Some(obj) = v.as_object_mut() {
        if let Some(company) = a
            .company
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            obj.insert("company".to_string(), json!(company));
        }
        if let Some(email) = a.email.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            obj.insert("email".to_string(), json!(email));
        }
        if let Some(is_residential) = a.is_residential {
            obj.insert("is_residential".to_string(), json!(is_residential));
        }
    }
    v
}

fn input_to_shippo_json(a: &ShippingAddressInput) -> Value {
    let mut v = json!({
        "name": a.name,
        "street1": a.street1,
        "street2": a.street2.clone().unwrap_or_default(),
        "city": a.city,
        "state": a.state,
        "zip": a.zip,
        "country": a.country_or_us(),
    });
    if let Some(obj) = v.as_object_mut() {
        if let Some(company) = a
            .company
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            obj.insert("company".to_string(), json!(company));
        }
        if let Some(phone) = a.phone.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            obj.insert("phone".to_string(), json!(phone));
        }
        if let Some(email) = a.email.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            obj.insert("email".to_string(), json!(email));
        }
        if let Some(is_residential) = a.is_residential {
            obj.insert("is_residential".to_string(), json!(is_residential));
        }
    }
    v
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

fn parcels_json(
    cfg: &DefaultParcel,
    override_parcel: Option<&ParcelInput>,
    override_parcels: Option<&[ParcelInput]>,
) -> Vec<Value> {
    override_parcels
        .filter(|items| !items.is_empty())
        .map(|items| {
            items
                .iter()
                .map(|parcel| parcel_json(cfg, Some(parcel)))
                .collect()
        })
        .unwrap_or_else(|| vec![parcel_json(cfg, override_parcel)])
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
    parcels: &[Value],
    customs_declaration_object_id: Option<&str>,
) -> Result<Vec<NormalizedRate>, ShippoError> {
    if from.street1.trim().is_empty()
        || from.city.trim().is_empty()
        || from.state.trim().is_empty()
        || from.zip.trim().is_empty()
    {
        return Err(ShippoError::InvalidAddress(
            "Configure ship-from address in Settings before live Shippo rates".into(),
        ));
    }

    let is_international = to.country_or_us() != "US";
    let customs_id = customs_declaration_object_id
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if is_international && customs_id.is_none() {
        return Err(ShippoError::InvalidAddress(
            "International Shippo shipments require a customs declaration before rates can be requested.".into(),
        ));
    }

    let mut body = json!({
        "address_from": address_to_shippo_json(from),
        "address_to": input_to_shippo_json(to),
        "parcels": parcels,
        "async": false,
    });
    if let (Some(obj), Some(customs)) = (body.as_object_mut(), customs_id) {
        obj.insert("customs_declaration".to_string(), json!(customs));
    }

    let resp = http
        .post("https://api.goshippo.com/shipments/")
        .header("Authorization", format!("ShippoToken {token}"))
        .header("SHIPPO-API-VERSION", SHIPPO_API_VERSION)
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
    parcels_override: Option<&[ParcelInput]>,
    customs_declaration_object_id: Option<&str>,
    force_stub: bool,
) -> Result<StoreShippingRatesResult, ShippoError> {
    to.validate()?;

    let eff = load_effective_shippo_config(pool).await?;
    let _ = prune_expired_rate_quotes(pool).await;

    let parcels = parcels_json(&eff.store.default_parcel, parcel_override, parcels_override);

    let use_live = !force_stub && eff.store.enabled && eff.store.live_rates_enabled;

    let (normalized, stub) = if use_live {
        if !eff.api_token_configured {
            return Err(ShippoError::Api(
                "Shippo API token is required when live rates are enabled".into(),
            ));
        }
        let token = shippo_api_token_from_env().ok_or_else(|| {
            ShippoError::Api("Shippo API token is required when live rates are enabled".into())
        })?;
        let rates = fetch_live_rates(
            http,
            &token,
            &eff.store.from_address,
            to,
            &parcels,
            customs_declaration_object_id,
        )
        .await?;
        if rates.is_empty() {
            return Err(ShippoError::Api(
                "Shippo returned no rates for this shipment".into(),
            ));
        }
        (rates, false)
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
    parcels_override: Option<&[ParcelInput]>,
    customs_declaration_object_id: Option<&str>,
    force_stub: bool,
) -> Result<StoreShippingRatesResult, ShippoError> {
    store_shipping_rates(
        pool,
        http,
        to,
        parcel_override,
        parcels_override,
        customs_declaration_object_id,
        force_stub,
    )
    .await
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

#[derive(Debug, Clone, Serialize)]
pub struct ShippoConnectionTestResult {
    pub object_id: Option<String>,
    pub is_complete: Option<bool>,
    pub validation_results: Value,
}

pub async fn test_shippo_connection(
    http: &reqwest::Client,
    from: &ShippoAddressFields,
) -> Result<ShippoConnectionTestResult, ShippoError> {
    let token = shippo_api_token_from_env()
        .ok_or_else(|| ShippoError::Api("Shippo API token is not configured".into()))?;
    if from.street1.trim().is_empty()
        || from.city.trim().is_empty()
        || from.state.trim().is_empty()
        || from.zip.trim().is_empty()
    {
        return Err(ShippoError::InvalidAddress(
            "Configure ship-from address before testing Shippo.".into(),
        ));
    }

    let mut body = address_to_shippo_json(from);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("validate".to_string(), json!(true));
    }
    let resp = http
        .post("https://api.goshippo.com/addresses/")
        .header("Authorization", format!("ShippoToken {token}"))
        .header("SHIPPO-API-VERSION", SHIPPO_API_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| ShippoError::Api(e.to_string()))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        tracing::warn!(status = %status, "shippo address test failed");
        return Err(ShippoError::Api(format!("HTTP {status}: {text}")));
    }

    let v: Value = resp
        .json::<Value>()
        .await
        .map_err(|e| ShippoError::Api(e.to_string()))?;
    Ok(ShippoConnectionTestResult {
        object_id: v
            .get("object_id")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        is_complete: v.get("is_complete").and_then(|x| x.as_bool()),
        validation_results: v
            .get("validation_results")
            .cloned()
            .unwrap_or_else(|| json!({})),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct ShippoRefundResult {
    pub object_id: Option<String>,
    pub status: Option<String>,
    pub transaction: Option<String>,
}

pub async fn request_label_refund(
    http: &reqwest::Client,
    transaction_object_id: &str,
) -> Result<ShippoRefundResult, ShippoError> {
    let token = shippo_api_token_from_env()
        .ok_or_else(|| ShippoError::Api("Shippo API token is not configured".into()))?;
    let transaction = transaction_object_id.trim();
    if transaction.is_empty() {
        return Err(ShippoError::InvalidAddress(
            "Shippo transaction id is required to request a label refund.".into(),
        ));
    }

    let resp = http
        .post("https://api.goshippo.com/refunds/")
        .header("Authorization", format!("ShippoToken {token}"))
        .header("SHIPPO-API-VERSION", SHIPPO_API_VERSION)
        .json(&json!({
            "transaction": transaction,
            "async": false,
        }))
        .send()
        .await
        .map_err(|e| ShippoError::Api(e.to_string()))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        tracing::warn!(status = %status, "shippo label refund failed");
        return Err(ShippoError::Api(format!("HTTP {status}: {text}")));
    }

    let v: Value = resp
        .json::<Value>()
        .await
        .map_err(|e| ShippoError::Api(e.to_string()))?;
    Ok(ShippoRefundResult {
        object_id: v
            .get("object_id")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        status: v
            .get("status")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        transaction: v
            .get("transaction")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
    })
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
        .header("SHIPPO-API-VERSION", SHIPPO_API_VERSION)
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
