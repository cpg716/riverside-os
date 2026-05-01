//! Stripe Terminal handshake: create a `card_present` PaymentIntent for the physical reader.

use crate::auth::permissions::SETTINGS_ADMIN;
use crate::logic::{helcim, stripe_vault};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;
use stripe::{CancelPaymentIntent, CreatePaymentIntent, Currency, PaymentIntent, PaymentIntentId};
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::middleware;

#[derive(Debug, Error)]
pub enum PaymentError {
    #[error("Stripe API error: {0}")]
    StripeError(String),
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("Too many payment intent requests; try again shortly")]
    RateLimited,
}

fn map_pay_session(e: (StatusCode, axum::Json<serde_json::Value>)) -> PaymentError {
    let (st, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match st {
        StatusCode::UNAUTHORIZED => PaymentError::Unauthorized(msg),
        StatusCode::FORBIDDEN => PaymentError::Forbidden(msg),
        _ => PaymentError::InvalidPayload(msg),
    }
}

impl IntoResponse for PaymentError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            PaymentError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            PaymentError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            PaymentError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            PaymentError::RateLimited => (
                StatusCode::TOO_MANY_REQUESTS,
                "Too many payment intent requests; try again shortly".to_string(),
            ),
            PaymentError::StripeError(e) => {
                tracing::error!(error = %e, "Stripe error in payments");
                (
                    StatusCode::BAD_GATEWAY,
                    "Failed to communicate with payment processor".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateIntentRequest {
    pub amount_due: Decimal,
    /// If true, uses 'card' instead of 'card_present' for MOTO / phone orders.
    pub moto: Option<bool>,
    /// Link to a ROS customer for card vaulting / retrieval.
    pub customer_id: Option<Uuid>,
    /// Securely use a vaulted card for off-session / quick-pay.
    pub payment_method_id: Option<String>,
    /// Attempt an unlinked credit (negative intent).
    pub is_credit: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct CreateIntentResponse {
    pub intent_id: String,
    pub client_secret: String,
    pub amount_cents: i64,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/intent", post(create_payment_intent))
        .route("/intent/cancel", post(cancel_payment_intent))
        .route("/config", get(get_payments_config))
        .route("/providers/helcim/status", get(get_helcim_provider_status))
        .route("/customers/{id}/payment-methods", get(get_vaulted_methods))
        .route(
            "/customers/{id}/setup-intent",
            post(create_vault_setup_intent),
        )
        .route(
            "/customers/{id}/payment-methods/{pm_id}",
            delete(delete_vaulted_method),
        )
        .route(
            "/customers/{id}/payment-methods/record",
            post(record_vaulted_method),
        )
}

async fn get_payments_config(
    State(_state): State<AppState>,
    _headers: HeaderMap,
) -> Result<Json<serde_json::Value>, PaymentError> {
    let public_key = std::env::var("STRIPE_PUBLIC_KEY").unwrap_or_default();
    Ok(Json(json!({ "stripe_public_key": public_key })))
}

async fn get_helcim_provider_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<helcim::HelcimConfigStatus>, PaymentError> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;

    Ok(Json(helcim::HelcimConfig::from_env().status()))
}

async fn get_vaulted_methods(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<Vec<stripe_vault::VaultedPaymentMethod>>, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;

    let methods = stripe_vault::list_vaulted_methods(&state.db, &state.stripe_client, customer_id)
        .await
        .map_err(|e| PaymentError::StripeError(e.to_string()))?;

    Ok(Json(methods))
}

async fn create_vault_setup_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;

    let secret = stripe_vault::create_setup_intent(&state.db, &state.stripe_client, customer_id)
        .await
        .map_err(|e| PaymentError::StripeError(e.to_string()))?;

    Ok(Json(json!({ "client_secret": secret })))
}

async fn delete_vaulted_method(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((customer_id, pm_id)): Path<(Uuid, String)>,
) -> Result<StatusCode, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;

    stripe_vault::delete_vaulted_method(&state.db, &state.stripe_client, customer_id, &pm_id)
        .await
        .map_err(|e| PaymentError::StripeError(e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct RecordVaultedMethodRequest {
    pub stripe_payment_method_id: String,
    pub brand: String,
    pub last4: String,
    pub exp_month: i32,
    pub exp_year: i32,
}

async fn record_vaulted_method(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(payload): Json<RecordVaultedMethodRequest>,
) -> Result<Json<serde_json::Value>, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;

    let id = stripe_vault::record_vaulted_method(
        &state.db,
        customer_id,
        &payload.stripe_payment_method_id,
        &payload.brand,
        &payload.last4,
        payload.exp_month,
        payload.exp_year,
    )
    .await
    .map_err(|e| PaymentError::StripeError(e.to_string()))?;

    Ok(Json(json!({ "id": id })))
}

async fn create_payment_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateIntentRequest>,
) -> Result<Json<CreateIntentResponse>, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;

    if state.payment_intent_max_per_minute > 0 {
        let mut w = state.payment_intent_minute.lock().await;
        let now = std::time::Instant::now();
        if now.duration_since(w.window_start) >= Duration::from_secs(60) {
            w.window_start = now;
            w.count = 0;
        }
        if w.count >= state.payment_intent_max_per_minute {
            return Err(PaymentError::RateLimited);
        }
        w.count += 1;
    }

    if payload.amount_due <= Decimal::ZERO && !payload.is_credit.unwrap_or(false) {
        return Err(PaymentError::InvalidPayload(
            "Amount must be greater than zero for standard payments".to_string(),
        ));
    }

    let cents_decimal = payload.amount_due * Decimal::from(100);
    let amount_cents = cents_decimal.to_i64().ok_or_else(|| {
        PaymentError::InvalidPayload("Amount is too large or malformed".to_string())
    })?;

    let mut create_intent = CreatePaymentIntent::new(amount_cents, Currency::USD);

    if payload.moto.unwrap_or(false) {
        create_intent.payment_method_types = Some(vec!["card".to_string()]);
        // For MOTO, we often want to save the card for future use
        if payload.customer_id.is_some() {
            create_intent.setup_future_usage =
                Some(stripe::PaymentIntentSetupFutureUsage::OffSession);
        }
    } else if payload.payment_method_id.is_some() {
        // Saved card: don't restrict to card_present
        create_intent.payment_method_types = Some(vec!["card".to_string()]);
    } else {
        create_intent.payment_method_types = Some(vec!["card_present".to_string()]);
    }

    if let Some(pm_id) = payload.payment_method_id {
        create_intent.payment_method = Some(
            pm_id
                .parse()
                .map_err(|_| PaymentError::StripeError("invalid payment method id".into()))?,
        );
        // Off-session confirmation if using a saved card directly from POS
        create_intent.confirm = Some(true);
        create_intent.off_session = Some(stripe::PaymentIntentOffSession::Exists(true));
    }

    // Link Stripe customer if we have one for this ROS customer
    if let Some(cid) = payload.customer_id {
        let stripe_cust_id: Option<String> = sqlx::query_scalar::<_, Option<String>>(
            "SELECT stripe_customer_id FROM customers WHERE id = $1",
        )
        .bind(cid)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| PaymentError::StripeError(e.to_string()))?
        .flatten();

        if let Some(scid) = stripe_cust_id {
            create_intent.customer = Some(
                scid.parse()
                    .map_err(|_| PaymentError::StripeError("invalid stripe customer id".into()))?,
            );
        }
    }

    let intent = PaymentIntent::create(&state.stripe_client, create_intent)
        .await
        .map_err(|e| PaymentError::StripeError(e.to_string()))?;

    Ok(Json(CreateIntentResponse {
        intent_id: intent.id.to_string(),
        client_secret: intent.client_secret.unwrap_or_default(),
        amount_cents,
    }))
}

#[derive(Debug, Deserialize)]
pub struct CancelIntentRequest {
    pub intent_id: String,
}

/// Voids a **uncaptured** Terminal `PaymentIntent` when staff removes the card tender from the ledger
/// before completing the sale. Succeeded / canceled intents return an error from Stripe (surfaced as 400).
async fn cancel_payment_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CancelIntentRequest>,
) -> Result<Json<serde_json::Value>, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;

    let id = payload.intent_id.trim();
    if id.is_empty() || id == "offline_simulation" {
        return Ok(Json(json!({ "status": "skipped" })));
    }
    if !id.starts_with("pi_") {
        return Err(PaymentError::InvalidPayload(
            "intent_id must be a Stripe PaymentIntent id (pi_...)".to_string(),
        ));
    }

    let pi_id: PaymentIntentId = id
        .parse()
        .map_err(|_| PaymentError::StripeError("invalid intent id".into()))?;
    PaymentIntent::cancel(&state.stripe_client, &pi_id, CancelPaymentIntent::default())
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, intent_id = %id, "payment intent cancel");
            PaymentError::InvalidPayload(format!("Could not void authorization: {e}"))
        })?;

    Ok(Json(json!({ "status": "cancelled" })))
}
