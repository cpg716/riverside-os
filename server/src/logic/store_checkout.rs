//! Public storefront checkout orchestration.
//!
//! The checkout session is the web cart authority. Provider adapters create or
//! verify payments, but ROS owns totals, tax, coupon, inventory reservation, and
//! transaction finalization.

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use stripe::{CreatePaymentIntent, Currency, PaymentIntent, PaymentIntentId, PaymentIntentStatus};
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::logic::helcim;
use crate::logic::store_cart_resolve::{self, LineQty};
use crate::logic::store_catalog;
use crate::logic::store_promotions;
use crate::logic::store_tax::{self, WebFulfillmentMode};
use crate::models::DbOrderFulfillmentMethod;

#[derive(Debug, Error)]
pub enum StoreCheckoutError {
    #[error("Invalid checkout: {0}")]
    Invalid(String),
    #[error("Payment provider unavailable: {0}")]
    Provider(String),
    #[error("Checkout session not found")]
    NotFound,
    #[error("Checkout session is not ready for payment")]
    NotReady,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("Stripe API error: {0}")]
    Stripe(String),
}

#[derive(Debug, Clone, Deserialize)]
pub struct StoreCheckoutLineInput {
    pub variant_id: Uuid,
    #[serde(default = "default_qty")]
    pub qty: i32,
}

fn default_qty() -> i32 {
    1
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StoreCheckoutContact {
    pub email: String,
    pub name: String,
    #[serde(default)]
    pub phone: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StoreCheckoutShipTo {
    pub name: String,
    pub street1: String,
    pub city: String,
    pub state: String,
    pub zip: String,
    #[serde(default = "default_country")]
    pub country: String,
}

fn default_country() -> String {
    "US".to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateCheckoutSessionInput {
    #[serde(default)]
    pub cart_id: Option<Uuid>,
    pub contact: StoreCheckoutContact,
    #[serde(default)]
    pub customer_id: Option<Uuid>,
    #[serde(default)]
    pub lines: Vec<StoreCheckoutLineInput>,
    #[serde(default)]
    pub coupon_code: Option<String>,
    pub fulfillment_method: DbOrderFulfillmentMethod,
    #[serde(default)]
    pub ship_to: Option<StoreCheckoutShipTo>,
    #[serde(default)]
    pub shipping_rate_quote_id: Option<Uuid>,
    pub selected_provider: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub medium: Option<String>,
    #[serde(default)]
    pub campaign_slug: Option<String>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreatePaymentInput {
    pub provider: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConfirmPaymentInput {
    pub provider: String,
    pub provider_payment_id: String,
    #[serde(default)]
    pub raw_data_response: Option<Value>,
    #[serde(default)]
    pub helcim_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderReadiness {
    pub provider: String,
    pub enabled: bool,
    pub label: String,
    pub detail: String,
    pub missing_config: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckoutConfigResponse {
    pub web_checkout_enabled: bool,
    pub default_provider: String,
    pub providers: Vec<ProviderReadiness>,
    pub stripe_public_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckoutSessionResponse {
    pub id: Uuid,
    pub status: String,
    pub selected_provider: String,
    pub subtotal_usd: String,
    pub discount_usd: String,
    pub tax_usd: String,
    pub shipping_usd: String,
    pub total_usd: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub finalized_transaction_id: Option<Uuid>,
    pub lines: Value,
    pub coupon_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaymentStartResponse {
    pub checkout_session_id: Uuid,
    pub provider: String,
    pub status: String,
    pub amount_cents: i64,
    pub provider_payment_id: Option<String>,
    pub client_secret: Option<String>,
    pub checkout_token: Option<String>,
    pub hosted_payment_url: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HelcimPayInitializeResponse {
    #[serde(rename = "checkoutToken")]
    checkout_token: String,
    #[serde(rename = "secretToken")]
    secret_token: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaymentConfirmResponse {
    pub checkout_session_id: Uuid,
    pub provider: String,
    pub status: String,
    pub transaction_id: Option<Uuid>,
    pub transaction_display_id: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct CheckoutSessionRow {
    id: Uuid,
    status: String,
    selected_provider: Option<String>,
    customer_id: Option<Uuid>,
    contact: Value,
    fulfillment_method: DbOrderFulfillmentMethod,
    ship_to: Option<Value>,
    shipping_rate_quote_id: Option<Uuid>,
    lines_snapshot: Value,
    coupon_id: Option<Uuid>,
    coupon_code: Option<String>,
    coupon_snapshot: Option<Value>,
    subtotal_usd: Decimal,
    discount_usd: Decimal,
    tax_usd: Decimal,
    shipping_usd: Decimal,
    total_usd: Decimal,
    finalized_transaction_id: Option<Uuid>,
    expires_at: chrono::DateTime<chrono::Utc>,
}

fn env_truthy(key: &str) -> bool {
    matches!(
        std::env::var(key)
            .ok()
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

fn looks_placeholder(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.is_empty()
        || lower.contains("dummy")
        || lower.contains("placeholder")
        || lower.contains("replace_me")
}

fn stripe_ready() -> ProviderReadiness {
    let secret = std::env::var("STRIPE_SECRET_KEY").unwrap_or_default();
    let public = std::env::var("STRIPE_PUBLIC_KEY").unwrap_or_default();
    let secret_configured = secret.trim().starts_with("sk_") && !looks_placeholder(&secret);
    let public_configured = public.trim().starts_with("pk_") && !looks_placeholder(&public);
    let mut missing_config = Vec::new();
    if !secret_configured {
        missing_config.push("STRIPE_SECRET_KEY is not configured".to_string());
    }
    if !public_configured {
        missing_config.push("STRIPE_PUBLIC_KEY is not configured".to_string());
    }

    ProviderReadiness {
        provider: "stripe".to_string(),
        enabled: secret_configured && public_configured,
        label: "Stripe".to_string(),
        detail: if secret_configured && public_configured {
            "Stripe web card checkout is ready.".to_string()
        } else {
            "Stripe needs public and secret keys before web checkout can accept cards.".to_string()
        },
        missing_config,
    }
}

fn helcim_ready() -> ProviderReadiness {
    let api_token = std::env::var("HELCIM_API_TOKEN").unwrap_or_default();
    let api_configured = !looks_placeholder(&api_token);
    let web_enabled = env_truthy("HELCIM_WEB_CHECKOUT_ENABLED");
    let mut missing_config = Vec::new();
    if !api_configured {
        missing_config.push("HELCIM_API_TOKEN is not configured".to_string());
    }
    if !web_enabled {
        missing_config.push("HELCIM_WEB_CHECKOUT_ENABLED is not enabled".to_string());
    }

    ProviderReadiness {
        provider: "helcim".to_string(),
        enabled: api_configured && web_enabled,
        label: "Helcim".to_string(),
        detail: if api_configured && web_enabled {
            "HelcimPay.js web checkout is ready.".to_string()
        } else {
            "HelcimPay.js needs HELCIM_API_TOKEN and HELCIM_WEB_CHECKOUT_ENABLED before public customers can use it.".to_string()
        },
        missing_config,
    }
}

pub async fn checkout_config(pool: &PgPool) -> Result<CheckoutConfigResponse, StoreCheckoutError> {
    let default_provider: Option<String> =
        sqlx::query_scalar("SELECT active_card_provider FROM store_settings WHERE id = 1")
            .fetch_optional(pool)
            .await?;
    let stripe = stripe_ready();
    let helcim = helcim_ready();
    let web_checkout_enabled =
        env_truthy("RIVERSIDE_STORE_WEB_CHECKOUT_ENABLED") || stripe.enabled || helcim.enabled;
    let public_key = std::env::var("STRIPE_PUBLIC_KEY")
        .ok()
        .filter(|key| key.trim().starts_with("pk_") && !looks_placeholder(key));

    Ok(CheckoutConfigResponse {
        web_checkout_enabled,
        default_provider: default_provider.unwrap_or_else(|| "stripe".to_string()),
        providers: vec![stripe, helcim],
        stripe_public_key: public_key,
    })
}

fn normalized_provider(provider: &str) -> Result<String, StoreCheckoutError> {
    let provider = provider.trim().to_ascii_lowercase();
    if provider == "stripe" || provider == "helcim" {
        Ok(provider)
    } else {
        Err(StoreCheckoutError::Invalid(
            "payment provider must be stripe or helcim".to_string(),
        ))
    }
}

fn validate_contact(contact: &StoreCheckoutContact) -> Result<(), StoreCheckoutError> {
    if contact.name.trim().len() < 2 {
        return Err(StoreCheckoutError::Invalid(
            "checkout contact name is required".to_string(),
        ));
    }
    let email = contact.email.trim();
    if email.len() < 3 || !email.contains('@') {
        return Err(StoreCheckoutError::Invalid(
            "valid email is required for checkout".to_string(),
        ));
    }
    Ok(())
}

fn money_to_cents(amount: Decimal) -> Result<i64, StoreCheckoutError> {
    (amount.round_dp(2) * Decimal::from(100))
        .to_i64()
        .ok_or_else(|| StoreCheckoutError::Invalid("amount is too large".to_string()))
}

fn decimal_str(value: Decimal) -> String {
    value.round_dp(2).to_string()
}

pub async fn create_session(
    state: &AppState,
    input: CreateCheckoutSessionInput,
) -> Result<CheckoutSessionResponse, StoreCheckoutError> {
    validate_contact(&input.contact)?;
    let selected_provider = normalized_provider(&input.selected_provider)?;

    let provider_ready = checkout_config(&state.db)
        .await?
        .providers
        .into_iter()
        .find(|p| p.provider == selected_provider)
        .ok_or_else(|| StoreCheckoutError::Invalid("payment provider not found".to_string()))?;
    if !provider_ready.enabled {
        return Err(StoreCheckoutError::Provider(provider_ready.detail));
    }

    let pairs = store_cart_resolve::merge_cart_input(
        input
            .lines
            .into_iter()
            .map(|line| LineQty {
                variant_id: line.variant_id,
                qty: line.qty,
            })
            .collect(),
    )
    .map_err(|msg| StoreCheckoutError::Invalid(msg.to_string()))?;
    if pairs.is_empty() {
        return Err(StoreCheckoutError::Invalid(
            "cart must include at least one item".to_string(),
        ));
    }

    let ids: Vec<Uuid> = pairs.iter().map(|(id, _)| *id).collect();
    let offer_map = store_catalog::map_web_variants_by_id(&state.db, &ids).await?;
    if offer_map.len() != pairs.len() {
        return Err(StoreCheckoutError::Invalid(
            "one or more cart items are no longer available online".to_string(),
        ));
    }

    let mut subtotal = Decimal::ZERO;
    let mut line_json = Vec::new();
    for (variant_id, qty) in &pairs {
        let offer = offer_map.get(variant_id).ok_or_else(|| {
            StoreCheckoutError::Invalid("one or more cart items are unavailable".to_string())
        })?;
        if offer.available_stock < *qty {
            return Err(StoreCheckoutError::Invalid(format!(
                "{} has only {} available",
                offer.product_name, offer.available_stock
            )));
        }
        let line_total = offer.unit_price * Decimal::from(*qty);
        subtotal += line_total;
        line_json.push(json!({
            "variant_id": offer.variant_id,
            "product_id": offer.product_id,
            "product_slug": offer.product_slug,
            "product_name": offer.product_name,
            "sku": offer.sku,
            "variation_label": offer.variation_label,
            "qty": qty,
            "unit_price": decimal_str(offer.unit_price),
            "unit_cost": decimal_str(offer.unit_cost),
            "line_total": decimal_str(line_total),
        }));
    }
    subtotal = subtotal.round_dp(2);

    let mut discount = Decimal::ZERO;
    let mut coupon_id = None;
    let mut coupon_code = None;
    let mut coupon_snapshot = None;
    if let Some(code) = input
        .coupon_code
        .as_deref()
        .map(str::trim)
        .filter(|code| !code.is_empty())
    {
        let applied = store_promotions::apply_coupon_code(&state.db, code, subtotal)
            .await
            .map_err(|err| StoreCheckoutError::Invalid(err.to_string()))?;
        discount = applied.discount_amount.round_dp(2);
        coupon_id = Some(applied.coupon_id);
        coupon_code = Some(applied.code.clone());
        coupon_snapshot = Some(json!({
            "coupon_id": applied.coupon_id,
            "code": applied.code,
            "kind": applied.kind,
            "discount_amount": decimal_str(discount),
            "free_shipping": applied.free_shipping,
        }));
    }

    let mut ship_to_json = None;
    let mut shipping_amount = Decimal::ZERO;
    if input.fulfillment_method == DbOrderFulfillmentMethod::Ship {
        let quote_id = input.shipping_rate_quote_id.ok_or_else(|| {
            StoreCheckoutError::Invalid("shipping checkout requires a selected rate".to_string())
        })?;
        let row: Option<(Decimal, Value)> = sqlx::query_as(
            r#"
            SELECT amount_usd, metadata
            FROM store_shipping_rate_quote
            WHERE id = $1 AND expires_at > NOW()
            "#,
        )
        .bind(quote_id)
        .fetch_optional(&state.db)
        .await?;
        let (amount, metadata) = row.ok_or_else(|| {
            StoreCheckoutError::Invalid("shipping quote expired; refresh rates".to_string())
        })?;
        shipping_amount = amount.round_dp(2);
        ship_to_json = metadata.get("ship_to").cloned().or_else(|| {
            input
                .ship_to
                .as_ref()
                .and_then(|ship_to| serde_json::to_value(ship_to).ok())
        });
        if ship_to_json.is_none() {
            return Err(StoreCheckoutError::Invalid(
                "shipping quote is missing address snapshot".to_string(),
            ));
        }
    }

    let tax_state = if input.fulfillment_method == DbOrderFulfillmentMethod::Pickup {
        "NY".to_string()
    } else {
        input
            .ship_to
            .as_ref()
            .map(|ship_to| ship_to.state.trim().to_uppercase())
            .filter(|state| state.len() == 2)
            .unwrap_or_else(|| {
                ship_to_json
                    .as_ref()
                    .and_then(|value| value.get("state").and_then(Value::as_str))
                    .unwrap_or("NY")
                    .trim()
                    .to_uppercase()
            })
    };
    let taxable_subtotal = (subtotal - discount).max(Decimal::ZERO).round_dp(2);
    let tax_mode = if input.fulfillment_method == DbOrderFulfillmentMethod::Pickup {
        WebFulfillmentMode::StorePickup
    } else {
        WebFulfillmentMode::Ship
    };
    let tax = store_tax::web_tax_preview(&state.db, tax_mode, &tax_state, taxable_subtotal)
        .await
        .map_err(|err| StoreCheckoutError::Invalid(err.to_string()))?
        .tax_estimated
        .round_dp(2);

    let total = (taxable_subtotal + tax + shipping_amount).round_dp(2);
    if total <= Decimal::ZERO {
        return Err(StoreCheckoutError::Invalid(
            "checkout total must be greater than zero".to_string(),
        ));
    }

    let idempotency_key = input
        .idempotency_key
        .filter(|key| !key.trim().is_empty())
        .unwrap_or_else(|| format!("store-checkout-{}", Uuid::new_v4()));
    let normalized_email = input.contact.email.trim().to_lowercase();
    let resolved_customer_id = match input.customer_id {
        Some(customer_id) => Some(customer_id),
        None if normalized_email.is_empty() => None,
        None => {
            sqlx::query_scalar::<_, Uuid>(
                r#"
            SELECT id
            FROM customers
            WHERE lower(btrim(email)) = $1
            ORDER BY created_at DESC
            LIMIT 1
            "#,
            )
            .bind(&normalized_email)
            .fetch_optional(&state.db)
            .await?
        }
    };
    let contact = serde_json::to_value(&input.contact).unwrap_or_else(|_| json!({}));
    let lines_value = Value::Array(line_json);

    let row = sqlx::query_as::<_, CheckoutSessionRow>(
        r#"
        INSERT INTO store_checkout_session (
            guest_cart_id, customer_id, contact, fulfillment_method, ship_to,
            shipping_rate_quote_id, lines_snapshot, coupon_id, coupon_code,
            coupon_snapshot, subtotal_usd, discount_usd, tax_usd, shipping_usd,
            total_usd, selected_provider, source, medium, campaign_slug,
            checkout_started_at, status, idempotency_key
        )
        VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12, $13, $14,
            $15, $16, $17, $18, $19,
            now(), 'draft', $20
        )
        ON CONFLICT (idempotency_key) DO UPDATE
        SET contact = EXCLUDED.contact,
            customer_id = COALESCE(store_checkout_session.customer_id, EXCLUDED.customer_id),
            fulfillment_method = EXCLUDED.fulfillment_method,
            ship_to = EXCLUDED.ship_to,
            shipping_rate_quote_id = EXCLUDED.shipping_rate_quote_id,
            lines_snapshot = EXCLUDED.lines_snapshot,
            coupon_id = EXCLUDED.coupon_id,
            coupon_code = EXCLUDED.coupon_code,
            coupon_snapshot = EXCLUDED.coupon_snapshot,
            subtotal_usd = EXCLUDED.subtotal_usd,
            discount_usd = EXCLUDED.discount_usd,
            tax_usd = EXCLUDED.tax_usd,
            shipping_usd = EXCLUDED.shipping_usd,
            total_usd = EXCLUDED.total_usd,
            selected_provider = EXCLUDED.selected_provider,
            source = EXCLUDED.source,
            medium = EXCLUDED.medium,
            campaign_slug = EXCLUDED.campaign_slug,
            checkout_started_at = COALESCE(store_checkout_session.checkout_started_at, now()),
            status = CASE
                WHEN store_checkout_session.status IN ('paid', 'payment_pending') THEN store_checkout_session.status
                ELSE 'draft'
            END,
            updated_at = now()
        RETURNING id, status, selected_provider, customer_id, contact, fulfillment_method, ship_to,
                  shipping_rate_quote_id, lines_snapshot, coupon_id, coupon_code,
                  coupon_snapshot, subtotal_usd, discount_usd, tax_usd,
                  shipping_usd, total_usd, finalized_transaction_id, expires_at
        "#,
    )
    .bind(input.cart_id)
    .bind(resolved_customer_id)
    .bind(contact)
    .bind(input.fulfillment_method)
    .bind(ship_to_json)
    .bind(input.shipping_rate_quote_id)
    .bind(lines_value)
    .bind(coupon_id)
    .bind(&coupon_code)
    .bind(coupon_snapshot)
    .bind(subtotal)
    .bind(discount)
    .bind(tax)
    .bind(shipping_amount)
    .bind(total)
    .bind(&selected_provider)
    .bind(input.source.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()))
    .bind(input.medium.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()))
    .bind(input.campaign_slug.map(|value| value.trim().to_lowercase()).filter(|value| !value.is_empty()))
    .bind(idempotency_key)
    .fetch_one(&state.db)
    .await?;

    Ok(session_response(row))
}

pub async fn load_session(
    pool: &PgPool,
    session_id: Uuid,
) -> Result<CheckoutSessionResponse, StoreCheckoutError> {
    let row = load_session_row(pool, session_id).await?;
    Ok(session_response(row))
}

fn session_response(row: CheckoutSessionRow) -> CheckoutSessionResponse {
    CheckoutSessionResponse {
        id: row.id,
        status: row.status,
        selected_provider: row
            .selected_provider
            .unwrap_or_else(|| "stripe".to_string()),
        subtotal_usd: decimal_str(row.subtotal_usd),
        discount_usd: decimal_str(row.discount_usd),
        tax_usd: decimal_str(row.tax_usd),
        shipping_usd: decimal_str(row.shipping_usd),
        total_usd: decimal_str(row.total_usd),
        expires_at: row.expires_at,
        finalized_transaction_id: row.finalized_transaction_id,
        lines: row.lines_snapshot,
        coupon_code: row.coupon_code,
    }
}

async fn load_session_row(
    pool: &PgPool,
    session_id: Uuid,
) -> Result<CheckoutSessionRow, StoreCheckoutError> {
    sqlx::query_as::<_, CheckoutSessionRow>(
        r#"
        SELECT id, status, selected_provider, customer_id, contact, fulfillment_method, ship_to,
               shipping_rate_quote_id, lines_snapshot, coupon_id, coupon_code,
               coupon_snapshot, subtotal_usd, discount_usd, tax_usd,
               shipping_usd, total_usd, finalized_transaction_id, expires_at
        FROM store_checkout_session
        WHERE id = $1
        "#,
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or(StoreCheckoutError::NotFound)
}

pub async fn create_payment(
    state: &AppState,
    session_id: Uuid,
    input: CreatePaymentInput,
) -> Result<PaymentStartResponse, StoreCheckoutError> {
    let provider = normalized_provider(&input.provider)?;
    let row = load_session_row(&state.db, session_id).await?;
    if row.status == "paid" {
        return Ok(PaymentStartResponse {
            checkout_session_id: row.id,
            provider,
            status: "paid".to_string(),
            amount_cents: money_to_cents(row.total_usd)?,
            provider_payment_id: None,
            client_secret: None,
            checkout_token: None,
            hosted_payment_url: None,
            message: Some("Checkout session is already paid.".to_string()),
        });
    }
    if row.status != "draft" && row.status != "payment_pending" {
        return Err(StoreCheckoutError::NotReady);
    }
    if row.expires_at < chrono::Utc::now() {
        sqlx::query("UPDATE store_checkout_session SET status = 'expired' WHERE id = $1")
            .bind(row.id)
            .execute(&state.db)
            .await?;
        return Err(StoreCheckoutError::Invalid(
            "checkout session expired".to_string(),
        ));
    }

    let provider_ready = checkout_config(&state.db)
        .await?
        .providers
        .into_iter()
        .find(|p| p.provider == provider)
        .ok_or_else(|| StoreCheckoutError::Invalid("payment provider not found".to_string()))?;
    if !provider_ready.enabled {
        return Err(StoreCheckoutError::Provider(provider_ready.detail));
    }

    if provider == "helcim" {
        let config = helcim::HelcimConfig::from_env();
        let token = config.api_token().ok_or_else(|| {
            StoreCheckoutError::Provider("Helcim API token is not configured.".to_string())
        })?;
        let url = format!("{}/helcim-pay/initialize", config.api_base_url());
        let response = state
            .http_client
            .post(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header("api-token", token)
            .json(&json!({
                "paymentType": "purchase",
                "amount": decimal_str(row.total_usd),
                "currency": "USD",
                "paymentMethod": "cc",
                "confirmationScreen": false,
                "displayContactFields": 1,
            }))
            .send()
            .await
            .map_err(|err| StoreCheckoutError::Provider(err.to_string()))?;
        if !response.status().is_success() {
            let status = response.status();
            let message = response
                .text()
                .await
                .unwrap_or_else(|_| "HelcimPay.js initialization failed".to_string());
            return Err(StoreCheckoutError::Provider(format!(
                "HelcimPay.js returned HTTP {status}: {message}"
            )));
        }
        let init = response
            .json::<HelcimPayInitializeResponse>()
            .await
            .map_err(|err| StoreCheckoutError::Provider(err.to_string()))?;
        let amount_cents = money_to_cents(row.total_usd)?;
        sqlx::query(
            r#"
            INSERT INTO store_checkout_payment_attempt (
                checkout_session_id, provider, status, amount_cents, currency,
                provider_payment_id, provider_status, client_secret, raw_audit_reference
            )
            VALUES ($1, 'helcim', 'pending', $2, 'usd', $3, 'initialized', $4, 'helcim-pay-js')
            "#,
        )
        .bind(row.id)
        .bind(amount_cents)
        .bind(&init.checkout_token)
        .bind(&init.secret_token)
        .execute(&state.db)
        .await?;

        sqlx::query(
            r#"
        UPDATE store_checkout_session
        SET status = 'payment_pending', selected_provider = 'helcim', payment_started_at = COALESCE(payment_started_at, now())
        WHERE id = $1
            "#,
        )
        .bind(row.id)
        .execute(&state.db)
        .await?;

        return Ok(PaymentStartResponse {
            checkout_session_id: row.id,
            provider,
            status: "payment_pending".to_string(),
            amount_cents,
            provider_payment_id: Some(init.checkout_token.clone()),
            client_secret: None,
            checkout_token: Some(init.checkout_token),
            hosted_payment_url: None,
            message: None,
        });
    }

    let amount_cents = money_to_cents(row.total_usd)?;
    let mut intent = CreatePaymentIntent::new(amount_cents, Currency::USD);
    intent.payment_method_types = Some(vec!["card".to_string()]);

    let stripe_intent = PaymentIntent::create(&state.stripe_client, intent)
        .await
        .map_err(|err| StoreCheckoutError::Stripe(err.to_string()))?;
    let provider_payment_id = stripe_intent.id.to_string();
    let client_secret = stripe_intent.client_secret.unwrap_or_default();

    sqlx::query(
        r#"
        UPDATE store_checkout_session
        SET status = 'payment_pending', selected_provider = $2, payment_started_at = COALESCE(payment_started_at, now())
        WHERE id = $1
        "#,
    )
    .bind(row.id)
    .bind(&provider)
    .execute(&state.db)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO store_checkout_payment_attempt (
            checkout_session_id, provider, status, amount_cents, currency,
            provider_payment_id, provider_status, client_secret
        )
        VALUES ($1, 'stripe', 'pending', $2, 'usd', $3, $4, $5)
        "#,
    )
    .bind(row.id)
    .bind(amount_cents)
    .bind(&provider_payment_id)
    .bind(stripe_intent.status.as_str())
    .bind(&client_secret)
    .execute(&state.db)
    .await?;

    Ok(PaymentStartResponse {
        checkout_session_id: row.id,
        provider,
        status: "payment_pending".to_string(),
        amount_cents,
        provider_payment_id: Some(provider_payment_id),
        client_secret: Some(client_secret),
        checkout_token: None,
        hosted_payment_url: None,
        message: None,
    })
}

pub async fn confirm_payment(
    state: &AppState,
    session_id: Uuid,
    input: ConfirmPaymentInput,
) -> Result<PaymentConfirmResponse, StoreCheckoutError> {
    let provider = normalized_provider(&input.provider)?;
    let row = load_session_row(&state.db, session_id).await?;
    if row.status == "paid" {
        let display_id = match row.finalized_transaction_id {
            Some(id) => {
                sqlx::query_scalar("SELECT display_id FROM transactions WHERE id = $1")
                    .bind(id)
                    .fetch_optional(&state.db)
                    .await?
            }
            None => None,
        };
        return Ok(PaymentConfirmResponse {
            checkout_session_id: row.id,
            provider,
            status: "paid".to_string(),
            transaction_id: row.finalized_transaction_id,
            transaction_display_id: display_id,
        });
    }
    if provider == "helcim" {
        let (transaction_id, display_id) = confirm_helcim_payment(&state.db, row, &input).await?;
        return Ok(PaymentConfirmResponse {
            checkout_session_id: session_id,
            provider,
            status: "paid".to_string(),
            transaction_id: Some(transaction_id),
            transaction_display_id: Some(display_id),
        });
    }

    let intent_id: PaymentIntentId = input
        .provider_payment_id
        .parse()
        .map_err(|_| StoreCheckoutError::Invalid("invalid Stripe payment id".to_string()))?;
    let intent = PaymentIntent::retrieve(&state.stripe_client, &intent_id, &[])
        .await
        .map_err(|err| StoreCheckoutError::Stripe(err.to_string()))?;

    sqlx::query(
        r#"
        UPDATE store_checkout_payment_attempt
        SET provider_status = $3,
            status = CASE
                WHEN $3 = 'succeeded' THEN 'captured'
                WHEN $3 = 'canceled' THEN 'canceled'
                WHEN $3 = 'processing' THEN 'pending'
                ELSE status
            END,
            completed_at = CASE WHEN $3 IN ('succeeded', 'canceled') THEN now() ELSE completed_at END
        WHERE checkout_session_id = $1 AND provider = 'stripe' AND provider_payment_id = $2
        "#,
    )
    .bind(row.id)
    .bind(&input.provider_payment_id)
    .bind(intent.status.as_str())
    .execute(&state.db)
    .await?;

    if intent.status != PaymentIntentStatus::Succeeded {
        return Ok(PaymentConfirmResponse {
            checkout_session_id: row.id,
            provider,
            status: intent.status.as_str().to_string(),
            transaction_id: None,
            transaction_display_id: None,
        });
    }

    let (transaction_id, display_id) = finalize_paid_checkout(
        &state.db,
        row.id,
        "stripe",
        &input.provider_payment_id,
        intent.status.as_str(),
    )
    .await?;

    Ok(PaymentConfirmResponse {
        checkout_session_id: row.id,
        provider,
        status: "paid".to_string(),
        transaction_id: Some(transaction_id),
        transaction_display_id: Some(display_id),
    })
}

async fn confirm_helcim_payment(
    pool: &PgPool,
    row: CheckoutSessionRow,
    input: &ConfirmPaymentInput,
) -> Result<(Uuid, String), StoreCheckoutError> {
    let raw_data = input.raw_data_response.as_ref().ok_or_else(|| {
        StoreCheckoutError::Invalid("Helcim response data is required".to_string())
    })?;
    let helcim_hash = input
        .helcim_hash
        .as_deref()
        .map(str::trim)
        .filter(|hash| !hash.is_empty())
        .ok_or_else(|| {
            StoreCheckoutError::Invalid("Helcim response hash is required".to_string())
        })?;

    let secret: Option<String> = sqlx::query_scalar(
        r#"
        SELECT client_secret
        FROM store_checkout_payment_attempt
        WHERE checkout_session_id = $1
          AND provider = 'helcim'
          AND provider_payment_id = $2
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(row.id)
    .bind(&input.provider_payment_id)
    .fetch_optional(pool)
    .await?;
    let secret = secret.ok_or_else(|| {
        StoreCheckoutError::Invalid("Helcim checkout attempt not found".to_string())
    })?;

    let encoded = serde_json::to_string(raw_data)
        .map_err(|_| StoreCheckoutError::Invalid("invalid Helcim response".to_string()))?;
    let mut hasher = Sha256::new();
    hasher.update(format!("{encoded}{secret}").as_bytes());
    let expected = format!("{:x}", hasher.finalize());
    if !expected.eq_ignore_ascii_case(helcim_hash) {
        return Err(StoreCheckoutError::Invalid(
            "Helcim response hash did not validate".to_string(),
        ));
    }

    let status = raw_data
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    if !status.starts_with("APPROV") {
        return Err(StoreCheckoutError::Invalid(format!(
            "Helcim payment was not approved ({status})"
        )));
    }
    let amount: Decimal = raw_data
        .get("amount")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreCheckoutError::Invalid("Helcim amount is missing".to_string()))?
        .parse()
        .map_err(|_| StoreCheckoutError::Invalid("Helcim amount is invalid".to_string()))?;
    if amount.round_dp(2) != row.total_usd.round_dp(2) {
        return Err(StoreCheckoutError::Invalid(
            "Helcim amount does not match checkout total".to_string(),
        ));
    }

    let provider_transaction_id = raw_data
        .get("transactionId")
        .and_then(Value::as_str)
        .unwrap_or(&input.provider_payment_id)
        .to_string();
    sqlx::query(
        r#"
        UPDATE store_checkout_payment_attempt
        SET status = 'captured',
            provider_status = $3,
            provider_transaction_id = $4,
            raw_audit_reference = $5,
            completed_at = now()
        WHERE checkout_session_id = $1
          AND provider = 'helcim'
          AND provider_payment_id = $2
        "#,
    )
    .bind(row.id)
    .bind(&input.provider_payment_id)
    .bind(status)
    .bind(&provider_transaction_id)
    .bind(raw_data.to_string())
    .execute(pool)
    .await?;

    finalize_paid_checkout(pool, row.id, "helcim", &provider_transaction_id, "approved").await
}

async fn finalize_paid_checkout(
    pool: &PgPool,
    session_id: Uuid,
    provider: &str,
    provider_payment_id: &str,
    provider_status: &str,
) -> Result<(Uuid, String), StoreCheckoutError> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query_as::<_, CheckoutSessionRow>(
        r#"
        SELECT id, status, selected_provider, customer_id, contact, fulfillment_method, ship_to,
               shipping_rate_quote_id, lines_snapshot, coupon_id, coupon_code,
               coupon_snapshot, subtotal_usd, discount_usd, tax_usd,
               shipping_usd, total_usd, finalized_transaction_id, expires_at
        FROM store_checkout_session
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(session_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(StoreCheckoutError::NotFound)?;

    if let Some(existing_id) = row.finalized_transaction_id {
        let display_id: String =
            sqlx::query_scalar("SELECT display_id FROM transactions WHERE id = $1")
                .bind(existing_id)
                .fetch_one(&mut *tx)
                .await?;
        tx.commit().await?;
        return Ok((existing_id, display_id));
    }
    if row.status != "payment_pending" && row.status != "draft" {
        return Err(StoreCheckoutError::NotReady);
    }

    let metadata = json!({
        "source": "online_store",
        "store_checkout_session_id": row.id,
        "payment_provider": provider,
        "provider_payment_id": provider_payment_id,
        "checkout_contact": row.contact,
    });
    let ship_to = row.ship_to.clone().map(sqlx::types::Json);
    let (transaction_id, display_id): (Uuid, String) = sqlx::query_as(
        r#"
        INSERT INTO transactions (
            customer_id, total_price, amount_paid, balance_due, booked_at,
            fulfillment_method, ship_to, shipping_amount_usd, sale_channel,
            metadata
        )
        VALUES (
            $1, $2, $2, 0, CURRENT_TIMESTAMP,
            $3, $4, $5, 'web', $6
        )
        RETURNING id, display_id
        "#,
    )
    .bind(row.customer_id)
    .bind(row.total_usd)
    .bind(row.fulfillment_method)
    .bind(ship_to)
    .bind(row.shipping_usd)
    .bind(metadata)
    .fetch_one(&mut *tx)
    .await?;

    insert_transaction_lines(&mut tx, transaction_id, &row).await?;
    insert_payment_ledger(
        &mut tx,
        transaction_id,
        row.total_usd,
        provider,
        provider_payment_id,
        provider_status,
        row.id,
    )
    .await?;

    if let Some(coupon_id) = row.coupon_id {
        sqlx::query(
            r#"
            INSERT INTO order_coupon_redemptions (order_id, coupon_id, discount_amount)
            VALUES ($1, $2, $3)
            ON CONFLICT (order_id, coupon_id) DO NOTHING
            "#,
        )
        .bind(transaction_id)
        .bind(coupon_id)
        .bind(row.discount_usd)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE store_coupons SET uses_count = uses_count + 1 WHERE id = $1")
            .bind(coupon_id)
            .execute(&mut *tx)
            .await?;
    }

    if let Some(quote_id) = row.shipping_rate_quote_id {
        sqlx::query("DELETE FROM store_shipping_rate_quote WHERE id = $1")
            .bind(quote_id)
            .execute(&mut *tx)
            .await?;
    }

    sqlx::query(
        r#"
        UPDATE store_checkout_session
        SET status = 'paid', finalized_transaction_id = $2, paid_at = COALESCE(paid_at, now())
        WHERE id = $1
        "#,
    )
    .bind(row.id)
    .bind(transaction_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok((transaction_id, display_id))
}

async fn insert_transaction_lines(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
    row: &CheckoutSessionRow,
) -> Result<(), StoreCheckoutError> {
    let lines = row.lines_snapshot.as_array().ok_or_else(|| {
        StoreCheckoutError::Invalid("checkout session line snapshot is invalid".to_string())
    })?;
    let taxable_base = (row.subtotal_usd - row.discount_usd).max(Decimal::ZERO);
    for (idx, line) in lines.iter().enumerate() {
        let product_id = value_uuid(line, "product_id")?;
        let variant_id = value_uuid(line, "variant_id")?;
        let qty = line.get("qty").and_then(Value::as_i64).unwrap_or(0) as i32;
        if qty <= 0 {
            return Err(StoreCheckoutError::Invalid(
                "checkout line quantity is invalid".to_string(),
            ));
        }
        let unit_price = value_decimal(line, "unit_price")?;
        let unit_cost = value_decimal(line, "unit_cost")?;
        let line_total = value_decimal(line, "line_total")?;
        let tax = if taxable_base > Decimal::ZERO && row.tax_usd > Decimal::ZERO {
            (row.tax_usd * (line_total / row.subtotal_usd.max(Decimal::new(1, 0))))
                .round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
        } else {
            Decimal::ZERO
        };
        let size_specs = json!({
            "source": "online_store",
            "product_name": line.get("product_name").and_then(Value::as_str).unwrap_or(""),
            "sku": line.get("sku").and_then(Value::as_str).unwrap_or(""),
            "variation_label": line.get("variation_label").and_then(Value::as_str),
            "coupon": row.coupon_snapshot,
        });
        sqlx::query(
            r#"
            INSERT INTO transaction_lines (
                transaction_id, product_id, variant_id, fulfillment, quantity,
                unit_price, unit_cost, state_tax, local_tax, size_specs,
                is_fulfilled, fulfilled_at, line_display_id
            )
            VALUES ($1, $2, $3, 'takeaway', $4, $5, $6, $7, 0, $8, false, NULL, $9)
            "#,
        )
        .bind(transaction_id)
        .bind(product_id)
        .bind(variant_id)
        .bind(qty)
        .bind(unit_price)
        .bind(unit_cost)
        .bind(tax)
        .bind(size_specs)
        .bind(format!("WEB-{}-{}", transaction_id, idx + 1))
        .execute(&mut **tx)
        .await?;

        sqlx::query(
            "UPDATE product_variants SET reserved_stock = reserved_stock + $2 WHERE id = $1",
        )
        .bind(variant_id)
        .bind(qty)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn insert_payment_ledger(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: Uuid,
    amount: Decimal,
    provider: &str,
    provider_payment_id: &str,
    provider_status: &str,
    checkout_session_id: Uuid,
) -> Result<(), StoreCheckoutError> {
    let metadata = json!({
        "source": "online_store",
        "store_checkout_session_id": checkout_session_id,
    });
    let payment_tx_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO payment_transactions (
            category, payment_method, amount, metadata, stripe_intent_id,
            payment_provider, provider_payment_id, provider_status
        )
        VALUES ('retail_sale', 'card', $1, $2, $3, $4, $3, $5)
        RETURNING id
        "#,
    )
    .bind(amount)
    .bind(metadata.clone())
    .bind(provider_payment_id)
    .bind(provider)
    .bind(provider_status)
    .fetch_one(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO payment_allocations (
            transaction_id, target_transaction_id, amount_allocated, metadata
        )
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(payment_tx_id)
    .bind(transaction_id)
    .bind(amount)
    .bind(metadata)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

fn value_uuid(value: &Value, key: &str) -> Result<Uuid, StoreCheckoutError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| StoreCheckoutError::Invalid(format!("missing {key}")))?
        .parse()
        .map_err(|_| StoreCheckoutError::Invalid(format!("invalid {key}")))
}

fn value_decimal(value: &Value, key: &str) -> Result<Decimal, StoreCheckoutError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| StoreCheckoutError::Invalid(format!("missing {key}")))?
        .parse()
        .map_err(|_| StoreCheckoutError::Invalid(format!("invalid {key}")))
}
