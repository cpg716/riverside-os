//! Unauthenticated inbound webhooks (Podium, etc.).

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde_json::Value;
use stripe::Webhook;

use std::sync::Arc;

use crate::api::AppState;
use crate::logic::podium_inbound;
use crate::logic::podium_webhook::{
    podium_inbound_crm_ingest_enabled, record_podium_webhook_delivery,
    verify_podium_webhook_headers, PodiumWebhookDisposition, PodiumWebhookVerifyError,
};

async fn post_podium_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let raw = body.as_ref();
    if let Err(e) = verify_podium_webhook_headers(&headers, raw) {
        let status = match e {
            PodiumWebhookVerifyError::SecretRequired | PodiumWebhookVerifyError::BadSignature => {
                StatusCode::UNAUTHORIZED
            }
            PodiumWebhookVerifyError::MissingTimestamp
            | PodiumWebhookVerifyError::MissingSignature
            | PodiumWebhookVerifyError::StaleTimestamp => StatusCode::BAD_REQUEST,
        };
        tracing::warn!(target = "podium_webhook", event = "verify_failed", reason = %e);
        return status.into_response();
    }

    let value: Value = match serde_json::from_slice(raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(target = "podium_webhook", event = "invalid_json", error = %e);
            return StatusCode::BAD_REQUEST.into_response();
        }
    };

    match record_podium_webhook_delivery(&state.db, raw, &value).await {
        Ok(PodiumWebhookDisposition::Duplicate) => {
            tracing::debug!(target = "podium_webhook", event = "duplicate_delivery");
            StatusCode::OK.into_response()
        }
        Ok(PodiumWebhookDisposition::Accepted) => {
            tracing::info!(target = "podium_webhook", event = "delivery_accepted");
            if podium_inbound_crm_ingest_enabled() {
                let pool = state.db.clone();
                let http = state.http_client.clone();
                let cache: Arc<_> = Arc::clone(&state.podium_token_cache);
                let payload = value.clone();
                tokio::spawn(async move {
                    podium_inbound::ingest_from_webhook(&pool, &http, &cache, &payload).await;
                });
            }
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => {
            tracing::error!(target = "podium_webhook", event = "persist_failed", error = %e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn post_stripe_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let sig = headers
        .get("Stripe-Signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();

    let secret = std::env::var("STRIPE_WEBHOOK_SECRET").unwrap_or_default();
    if secret.is_empty() {
        tracing::error!("STRIPE_WEBHOOK_SECRET not set; rejecting webhook");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let event = match Webhook::construct_event(
        std::str::from_utf8(&body).unwrap_or_default(),
        sig,
        &secret,
    ) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(target = "stripe_webhook", event = "verify_failed", error = %e);
            return StatusCode::BAD_REQUEST.into_response();
        }
    };

    match event.type_ {
        stripe::EventType::PaymentIntentSucceeded => {
            if let stripe::EventObject::PaymentIntent(pi) = event.data.object {
                let intent_id = pi.id.to_string();
                let pool = state.db.clone();
                let stripe_client = state.stripe_client.clone();

                tokio::spawn(async move {
                    if let Err(e) = reconcile_stripe_intent(&pool, &stripe_client, &intent_id).await
                    {
                        tracing::error!(intent_id = %intent_id, error = %e, "Failed to reconcile stripe intent fee");
                    }
                });
            }
        }
        _ => {
            tracing::debug!(target = "stripe_webhook", event = "unhandled_type", type = ?event.type_);
        }
    }

    StatusCode::OK.into_response()
}

async fn reconcile_stripe_intent(
    pool: &sqlx::PgPool,
    client: &stripe::Client,
    intent_id: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // 1. Fetch Payment Intent to get latest charges
    let _pi = stripe::PaymentIntent::retrieve(client, &intent_id.parse()?, &[]).await?;

    // 2. Get the charges for this intent
    let mut params = stripe::ListCharges::new();
    params.payment_intent = Some(intent_id.parse()?);
    let charges = stripe::Charge::list(client, &params).await?;
    let Some(charge) = charges.data.first() else {
        return Ok(());
    };
    let Some(bt_ref) = charge.balance_transaction.as_ref() else {
        return Ok(());
    };

    // 3. Retrieve balance transaction for fees
    let bt = stripe::BalanceTransaction::retrieve(client, &bt_ref.id(), &[]).await?;

    let fee_cents = bt.fee; // This is the total fee in cents
    let fee_decimal = rust_decimal::Decimal::from(fee_cents) / rust_decimal::Decimal::from(100);

    // 4. Extract card metadata
    let mut card_brand = None;
    let mut card_last4 = None;
    if let Some(stripe::PaymentMethodDetails {
        card: Some(card), ..
    }) = &charge.payment_method_details
    {
        card_brand = Some(format!("{:?}", card.brand).to_lowercase());
        card_last4 = Some(card.last4.clone());
    }

    // 5. Update our transaction records
    sqlx::query(
        r#"
        UPDATE payment_transactions
        SET merchant_fee = $1,
            net_amount = amount - $1,
            card_brand = COALESCE(card_brand, $2),
            card_last4 = COALESCE(card_last4, $3)
        WHERE stripe_intent_id = $4
        "#,
    )
    .bind(fee_decimal)
    .bind(card_brand)
    .bind(card_last4)
    .bind(intent_id)
    .execute(pool)
    .await?;

    Ok(())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/podium", post(post_podium_webhook))
        .route("/stripe", post(post_stripe_webhook))
}
