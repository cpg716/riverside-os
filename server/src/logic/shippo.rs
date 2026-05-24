//! Shippo integration logic for shipping rates and label purchasing.

use chrono::{Duration, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::str::FromStr;
use std::time::Duration as StdDuration;

const SHIPPO_MAX_RETRIES: u32 = 3;
const SHIPPO_BASE_RETRY_DELAY_MS: u64 = 500;

fn shippo_retry_delay(attempt: u32) -> StdDuration {
    StdDuration::from_millis(SHIPPO_BASE_RETRY_DELAY_MS * 2_u64.pow(attempt))
}

pub const RATE_QUOTE_TTL_MINUTES: i64 = 15;
const SHIPPO_API_VERSION: &str = "2018-02-08";
const SHIPPO_TOKEN_MISSING_SETTINGS_MESSAGE: &str =
    "Shippo API token is not saved in Backoffice Settings.";

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
    pub shippo_carrier_account_object_id: Option<String>,
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
    pub shippo_carrier_account_object_id: Option<String>,
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
            shippo_carrier_account_object_id: None,
            estimated_days: Some("2-3".into()),
        },
        NormalizedRate {
            amount_usd: dec!(12.75),
            carrier: "USPS".into(),
            service_name: "Priority Mail Express".into(),
            shippo_rate_object_id: None,
            shippo_carrier_account_object_id: None,
            estimated_days: Some("1-2".into()),
        },
        NormalizedRate {
            amount_usd: dec!(10.00),
            carrier: "UPS".into(),
            service_name: "Ground".into(),
            shippo_rate_object_id: None,
            shippo_carrier_account_object_id: None,
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
    is_return: bool,
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
    if let Some(obj) = body.as_object_mut() {
        if let Some(customs) = customs_id {
            obj.insert("customs_declaration".to_string(), json!(customs));
        }
        if is_return {
            obj.insert("extra".to_string(), json!({ "is_return": true }));
        }
    }

    let mut last_error = String::new();
    let v: serde_json::Value = 'retry: loop {
        for attempt in 0..=SHIPPO_MAX_RETRIES {
            if attempt > 0 {
                tokio::time::sleep(shippo_retry_delay(attempt - 1)).await;
                tracing::info!(attempt, "Retrying Shippo fetch_live_rates");
            }
            let resp = match http
                .post("https://api.goshippo.com/shipments/")
                .header("Authorization", format!("ShippoToken {token}"))
                .header("SHIPPO-API-VERSION", SHIPPO_API_VERSION)
                .json(&body)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    if e.is_timeout() || e.is_connect() {
                        last_error = format!("Shippo network error: {e}");
                        continue;
                    }
                    return Err(ShippoError::Api(e.to_string()));
                }
            };
            let status = resp.status();
            if status.is_success() {
                break 'retry resp.json::<serde_json::Value>().await.map_err(|e| ShippoError::Api(e.to_string()))?;
            }
            let text = resp.text().await.unwrap_or_default();
            if status.is_server_error() && attempt < SHIPPO_MAX_RETRIES {
                last_error = format!("Shippo HTTP {status}: {text}");
                continue;
            }
            tracing::warn!(status = %status, "shippo shipment create failed");
            return Err(ShippoError::Api(format!("HTTP {status}: {text}")));
        }
        return Err(ShippoError::Api(format!("Shippo fetch_live_rates failed after retries: {last_error}")));
    };

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
        let carrier_account = r
            .get("carrier_account")
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
            shippo_carrier_account_object_id: carrier_account,
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
    is_return: bool,
) -> Result<Vec<RateWithQuoteId>, sqlx::Error> {
    let expires_at = Utc::now() + Duration::minutes(RATE_QUOTE_TTL_MINUTES);
    let ship_json = serde_json::to_value(ship_to).unwrap_or_else(|_| json!({}));
    let mut out = Vec::with_capacity(rates.len());

    for rate in rates {
        let meta = json!({
            "stub": stub,
            "ship_to": ship_json,
            "is_return": is_return,
            "shippo_carrier_account_object_id": rate.shippo_carrier_account_object_id
        });
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
            shippo_carrier_account_object_id: rate.shippo_carrier_account_object_id.clone(),
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

#[allow(clippy::too_many_arguments)]
pub async fn store_shipping_rates(
    pool: &PgPool,
    http: &reqwest::Client,
    to: &ShippingAddressInput,
    parcel_override: Option<&ParcelInput>,
    parcels_override: Option<&[ParcelInput]>,
    customs_declaration_object_id: Option<&str>,
    is_return: bool,
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
                SHIPPO_TOKEN_MISSING_SETTINGS_MESSAGE.into(),
            ));
        }
        let token = shippo_api_token_from_env()
            .ok_or_else(|| ShippoError::Api(SHIPPO_TOKEN_MISSING_SETTINGS_MESSAGE.into()))?;
        let rates = fetch_live_rates(
            http,
            &token,
            &eff.store.from_address,
            to,
            &parcels,
            customs_declaration_object_id,
            is_return,
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

    let rates = persist_rate_quotes(pool, &normalized, stub, to, is_return)
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
                shippo_carrier_account_object_id: r.shippo_carrier_account_object_id,
                estimated_days: r.estimated_days,
            })
            .collect(),
        stub,
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn pos_shipping_rates(
    pool: &PgPool,
    http: &reqwest::Client,
    to: &ShippingAddressInput,
    parcel_override: Option<&ParcelInput>,
    parcels_override: Option<&[ParcelInput]>,
    customs_declaration_object_id: Option<&str>,
    is_return: bool,
    force_stub: bool,
) -> Result<StoreShippingRatesResult, ShippoError> {
    store_shipping_rates(
        pool,
        http,
        to,
        parcel_override,
        parcels_override,
        customs_declaration_object_id,
        is_return,
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

#[derive(Debug, Clone, Serialize)]
pub struct ShippoAddressValidationResult {
    pub object_id: Option<String>,
    pub is_complete: Option<bool>,
    pub validation_results: Value,
    pub normalized: ShippoAddressFields,
}

pub async fn test_shippo_connection(
    http: &reqwest::Client,
    from: &ShippoAddressFields,
) -> Result<ShippoConnectionTestResult, ShippoError> {
    let validated = validate_address(http, from).await?;
    Ok(ShippoConnectionTestResult {
        object_id: validated.object_id,
        is_complete: validated.is_complete,
        validation_results: validated.validation_results,
    })
}

pub async fn validate_address(
    http: &reqwest::Client,
    address: &ShippoAddressFields,
) -> Result<ShippoAddressValidationResult, ShippoError> {
    let token = shippo_api_token_from_env()
        .ok_or_else(|| ShippoError::Api(SHIPPO_TOKEN_MISSING_SETTINGS_MESSAGE.into()))?;
    if address.street1.trim().is_empty()
        || address.city.trim().is_empty()
        || address.state.trim().is_empty()
        || address.zip.trim().is_empty()
    {
        return Err(ShippoError::InvalidAddress(
            "street1, city, state, and ZIP are required before Shippo address validation.".into(),
        ));
    }

    let mut body = address_to_shippo_json(address);
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
    Ok(ShippoAddressValidationResult {
        object_id: v
            .get("object_id")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        is_complete: v.get("is_complete").and_then(|x| x.as_bool()),
        validation_results: v
            .get("validation_results")
            .cloned()
            .unwrap_or_else(|| json!({})),
        normalized: ShippoAddressFields {
            name: string_field_or(&v, "name", &address.name),
            company: optional_string_field(&v, "company").or_else(|| address.company.clone()),
            street1: string_field_or(&v, "street1", &address.street1),
            street2: optional_string_field(&v, "street2").or_else(|| address.street2.clone()),
            city: string_field_or(&v, "city", &address.city),
            state: string_field_or(&v, "state", &address.state),
            zip: string_field_or(&v, "zip", &address.zip),
            country: string_field_or(&v, "country", &address.country),
            phone: string_field_or(&v, "phone", &address.phone),
            email: optional_string_field(&v, "email").or_else(|| address.email.clone()),
            is_residential: v
                .get("is_residential")
                .and_then(|x| x.as_bool())
                .or(address.is_residential),
        },
    })
}

fn string_field_or(v: &Value, field: &str, fallback: &str) -> String {
    optional_string_field(v, field).unwrap_or_else(|| fallback.to_string())
}

fn optional_string_field(v: &Value, field: &str) -> Option<String> {
    v.get(field)
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
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
        .ok_or_else(|| ShippoError::Api(SHIPPO_TOKEN_MISSING_SETTINGS_MESSAGE.into()))?;
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

#[derive(Debug, Clone, Serialize)]
pub struct ShippoManifestResult {
    pub object_id: Option<String>,
    pub status: Option<String>,
    pub document_url: Option<String>,
    pub raw_response: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShippoPickupResult {
    pub object_id: Option<String>,
    pub status: Option<String>,
    pub confirmation_code: Option<String>,
    pub raw_response: Value,
}

fn first_document_url(v: &Value) -> Option<String> {
    v.get("documents")
        .and_then(|docs| docs.as_array())
        .and_then(|docs| docs.first())
        .and_then(|doc| {
            doc.as_str()
                .map(str::to_string)
                .or_else(|| doc.get("href").and_then(|x| x.as_str()).map(str::to_string))
                .or_else(|| doc.get("url").and_then(|x| x.as_str()).map(str::to_string))
        })
        .filter(|s| !s.trim().is_empty())
}

pub async fn create_manifest(
    http: &reqwest::Client,
    carrier_account: &str,
    shipment_date: &str,
    transactions: &[String],
    from: &ShippoAddressFields,
) -> Result<ShippoManifestResult, ShippoError> {
    let token = shippo_api_token_from_env()
        .ok_or_else(|| ShippoError::Api(SHIPPO_TOKEN_MISSING_SETTINGS_MESSAGE.into()))?;
    let carrier_account = carrier_account.trim();
    if carrier_account.is_empty() {
        return Err(ShippoError::InvalidAddress(
            "carrier account is required to create a manifest".into(),
        ));
    }
    if transactions.is_empty() {
        return Err(ShippoError::InvalidAddress(
            "at least one label transaction is required to create a manifest".into(),
        ));
    }

    let body = json!({
        "carrier_account": carrier_account,
        "shipment_date": shipment_date,
        "address_from": address_to_shippo_json(from),
        "transactions": transactions,
        "async": false,
    });
    let resp = http
        .post("https://api.goshippo.com/manifests/")
        .header("Authorization", format!("ShippoToken {token}"))
        .header("SHIPPO-API-VERSION", SHIPPO_API_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| ShippoError::Api(e.to_string()))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        tracing::warn!(status = %status, "shippo manifest create failed");
        return Err(ShippoError::Api(format!("HTTP {status}: {text}")));
    }

    let v: Value = resp
        .json::<Value>()
        .await
        .map_err(|e| ShippoError::Api(e.to_string()))?;
    Ok(ShippoManifestResult {
        object_id: v
            .get("object_id")
            .and_then(|x| x.as_str())
            .map(str::to_string),
        status: v.get("status").and_then(|x| x.as_str()).map(str::to_string),
        document_url: first_document_url(&v),
        raw_response: v,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PickupLocationInput {
    pub requested_start_time: String,
    pub requested_end_time: String,
    pub building_location_type: String,
    #[serde(default)]
    pub building_type: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
}

pub async fn create_pickup(
    http: &reqwest::Client,
    carrier_account: &str,
    transactions: &[String],
    from: &ShippoAddressFields,
    pickup: &PickupLocationInput,
) -> Result<ShippoPickupResult, ShippoError> {
    let token = shippo_api_token_from_env()
        .ok_or_else(|| ShippoError::Api(SHIPPO_TOKEN_MISSING_SETTINGS_MESSAGE.into()))?;
    let carrier_account = carrier_account.trim();
    if carrier_account.is_empty() {
        return Err(ShippoError::InvalidAddress(
            "carrier account is required to schedule pickup".into(),
        ));
    }
    if transactions.is_empty() {
        return Err(ShippoError::InvalidAddress(
            "at least one label transaction is required to schedule pickup".into(),
        ));
    }
    if pickup.requested_start_time.trim().is_empty()
        || pickup.requested_end_time.trim().is_empty()
        || pickup.building_location_type.trim().is_empty()
    {
        return Err(ShippoError::InvalidAddress(
            "pickup window and location are required".into(),
        ));
    }

    let mut location = json!({
        "building_location_type": pickup.building_location_type.trim(),
        "address": address_to_shippo_json(from),
    });
    if let Some(obj) = location.as_object_mut() {
        if let Some(building_type) = pickup
            .building_type
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            obj.insert("building_type".to_string(), json!(building_type));
        }
        if let Some(instructions) = pickup
            .instructions
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            obj.insert("instructions".to_string(), json!(instructions));
        }
    }
    let body = json!({
        "carrier_account": carrier_account,
        "location": location,
        "transactions": transactions,
        "requested_start_time": pickup.requested_start_time.trim(),
        "requested_end_time": pickup.requested_end_time.trim(),
    });
    let resp = http
        .post("https://api.goshippo.com/pickups/")
        .header("Authorization", format!("ShippoToken {token}"))
        .header("SHIPPO-API-VERSION", SHIPPO_API_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| ShippoError::Api(e.to_string()))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        tracing::warn!(status = %status, "shippo pickup create failed");
        return Err(ShippoError::Api(format!("HTTP {status}: {text}")));
    }

    let v: Value = resp
        .json::<Value>()
        .await
        .map_err(|e| ShippoError::Api(e.to_string()))?;
    Ok(ShippoPickupResult {
        object_id: v
            .get("object_id")
            .and_then(|x| x.as_str())
            .map(str::to_string),
        status: v.get("status").and_then(|x| x.as_str()).map(str::to_string),
        confirmation_code: v
            .get("confirmation_code")
            .and_then(|x| x.as_str())
            .map(str::to_string),
        raw_response: v,
    })
}

pub fn normalize_label_file_type(label_file_type: Option<&str>) -> Result<String, ShippoError> {
    let normalized = label_file_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("PDF")
        .replace('-', "_")
        .to_ascii_uppercase();
    match normalized.as_str() {
        "PDF" | "PDF_4X6" | "PNG" | "ZPLII" => Ok(normalized),
        _ => Err(ShippoError::InvalidAddress(
            "Unsupported label style. Choose PDF, PDF_4X6, PNG, or ZPLII.".into(),
        )),
    }
}

pub async fn purchase_transaction_for_rate(
    http: &reqwest::Client,
    rate_object_id: &str,
    label_file_type: Option<&str>,
) -> Result<PurchasedLabel, ShippoError> {
    let token = shippo_api_token_from_env()
        .ok_or_else(|| ShippoError::Api(SHIPPO_TOKEN_MISSING_SETTINGS_MESSAGE.into()))?;
    if rate_object_id.trim().is_empty() {
        return Err(ShippoError::InvalidAddress(
            "no Shippo rate on file — refresh live rates and apply a quote (stub quotes cannot buy labels)"
                .into(),
        ));
    }

    let label_file_type = normalize_label_file_type(label_file_type)?;

    let body = json!({
        "rate": rate_object_id.trim(),
        "label_file_type": label_file_type,
        "async": false,
    });

    let mut last_error = String::new();
    let v: serde_json::Value = 'retry: loop {
        for attempt in 0..=SHIPPO_MAX_RETRIES {
            if attempt > 0 {
                tokio::time::sleep(shippo_retry_delay(attempt - 1)).await;
                tracing::info!(attempt, "Retrying Shippo purchase transaction");
            }
            let resp = match http
                .post("https://api.goshippo.com/transactions/")
                .header("Authorization", format!("ShippoToken {token}"))
                .header("SHIPPO-API-VERSION", SHIPPO_API_VERSION)
                .json(&body)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    if e.is_timeout() || e.is_connect() {
                        last_error = format!("Shippo network error: {e}");
                        continue;
                    }
                    return Err(ShippoError::Api(e.to_string()));
                }
            };
            let status = resp.status();
            if status.is_success() {
                break 'retry resp.json::<serde_json::Value>().await.map_err(|e| ShippoError::Api(e.to_string()))?;
            }
            let text = resp.text().await.unwrap_or_default();
            if status.is_server_error() && attempt < SHIPPO_MAX_RETRIES {
                last_error = format!("Shippo HTTP {status}: {text}");
                continue;
            }
            tracing::warn!(status = %status, "shippo transaction create failed");
            return Err(ShippoError::Api(format!("HTTP {status}: {text}")));
        }
        return Err(ShippoError::Api(format!("Shippo purchase failed after retries: {last_error}")));
    };

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

#[derive(Debug, serde::Serialize)]
pub struct ShippoHealth {
    pub configured: bool,
    pub reachable: bool,
    pub latency_ms: u64,
    pub message: String,
}

pub async fn health_check(http: &reqwest::Client) -> ShippoHealth {
    let start = std::time::Instant::now();
    let Some(token) = shippo_api_token_from_env() else {
        return ShippoHealth {
            configured: false,
            reachable: false,
            latency_ms: 0,
            message: "Shippo not configured (SHIPPO_API_TOKEN unset)".to_string(),
        };
    };
    let res = match http
        .get("https://api.goshippo.com/shipments/")
        .header("Authorization", format!("ShippoToken {token}"))
        .header("SHIPPO-API-VERSION", SHIPPO_API_VERSION)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return ShippoHealth {
                configured: true,
                reachable: false,
                latency_ms: start.elapsed().as_millis() as u64,
                message: format!("Shippo health check network error: {e}"),
            };
        }
    };
    let status = res.status();
    if status.as_u16() == 200 || status.as_u16() == 401 {
        ShippoHealth {
            configured: true,
            reachable: true,
            latency_ms: start.elapsed().as_millis() as u64,
            message: "Shippo API is reachable".to_string(),
        }
    } else {
        ShippoHealth {
            configured: true,
            reachable: false,
            latency_ms: start.elapsed().as_millis() as u64,
            message: format!("Shippo returned HTTP {}", status),
        }
    }
}
