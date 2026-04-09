//! Stripe Terminal handshake: create a `card_present` PaymentIntent for the physical reader.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;
use stripe::{CancelPaymentIntent, CreatePaymentIntent, Currency, PaymentIntent};
use thiserror::Error;

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
    if st == StatusCode::UNAUTHORIZED {
        PaymentError::Unauthorized(msg)
    } else {
        PaymentError::InvalidPayload(msg)
    }
}

impl IntoResponse for PaymentError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            PaymentError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            PaymentError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
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

    if payload.amount_due <= Decimal::ZERO {
        return Err(PaymentError::InvalidPayload(
            "Amount must be greater than zero".to_string(),
        ));
    }

    let cents_decimal = payload.amount_due * Decimal::from(100);
    let amount_cents = cents_decimal.to_i64().ok_or_else(|| {
        PaymentError::InvalidPayload("Amount is too large or malformed".to_string())
    })?;

    let mut create_intent = CreatePaymentIntent::new(amount_cents, Currency::USD);
    create_intent.payment_method_types = Some(vec!["card_present".to_string()]);

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
            "intent_id must be a Stripe PaymentIntent id (pi_…)".to_string(),
        ));
    }

    PaymentIntent::cancel(&state.stripe_client, id, CancelPaymentIntent::default())
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, intent_id = %id, "payment intent cancel");
            PaymentError::InvalidPayload(format!("Could not void authorization: {e}"))
        })?;

    Ok(Json(json!({ "status": "cancelled" })))
}
