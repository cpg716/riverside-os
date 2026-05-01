//! Unauthenticated inbound webhooks (Podium, etc.).

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use stripe::Webhook;
use subtle::ConstantTimeEq;

use std::sync::Arc;

use crate::api::AppState;
use crate::logic::corecard;
use crate::logic::helcim;
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

fn verify_helcim_webhook(headers: &HeaderMap, body: &[u8]) -> Result<(), StatusCode> {
    let verifier_token = std::env::var("HELCIM_WEBHOOK_SECRET")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    let token_bytes = BASE64_STANDARD
        .decode(verifier_token)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let webhook_id = headers
        .get("webhook-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(StatusCode::BAD_REQUEST)?;
    let webhook_timestamp = headers
        .get("webhook-timestamp")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(StatusCode::BAD_REQUEST)?;
    let signature_header = headers
        .get("webhook-signature")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(StatusCode::BAD_REQUEST)?;
    let body_text = std::str::from_utf8(body).map_err(|_| StatusCode::BAD_REQUEST)?;
    let signed_content = format!("{webhook_id}.{webhook_timestamp}.{body_text}");

    let mut mac = Hmac::<Sha256>::new_from_slice(&token_bytes)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    mac.update(signed_content.as_bytes());
    let expected = BASE64_STANDARD.encode(mac.finalize().into_bytes());

    let matched = signature_header.split_whitespace().any(|candidate| {
        let Some((version, signature)) = candidate.split_once(',') else {
            return false;
        };
        version == "v1" && signature.as_bytes().ct_eq(expected.as_bytes()).into()
    });

    if matched {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn helcim_webhook_event_id(value: &Value) -> Option<String> {
    value.get("id").and_then(|id| match id {
        Value::String(value) => Some(value.trim().to_string()).filter(|value| !value.is_empty()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

fn helcim_webhook_device_code(value: &Value) -> Option<String> {
    value
        .get("data")
        .and_then(|data| data.get("deviceCode"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn helcim_webhook_amount_cents(value: &Value) -> Option<i64> {
    let amount = value
        .get("data")
        .and_then(|data| data.get("transactionAmount"))?;
    let text = match amount {
        Value::Number(number) => number.to_string(),
        Value::String(value) => value.trim().to_string(),
        _ => return None,
    };
    let decimal = rust_decimal::Decimal::from_str_exact(&text).ok()?;
    (decimal * rust_decimal::Decimal::from(100))
        .round_dp(0)
        .to_string()
        .parse::<i64>()
        .ok()
}

fn helcim_webhook_currency(value: &Value) -> Option<String> {
    value
        .get("data")
        .and_then(|data| data.get("currency"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| value.len() == 3)
        .map(str::to_ascii_lowercase)
}

async fn post_helcim_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(status) = verify_helcim_webhook(&headers, body.as_ref()) {
        tracing::warn!(target = "helcim_webhook", status = ?status, "verification failed");
        return status.into_response();
    }

    let value: Value = match serde_json::from_slice(body.as_ref()) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(target = "helcim_webhook", error = %error, "invalid json");
            return StatusCode::BAD_REQUEST.into_response();
        }
    };
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();

    match event_type {
        "cardTransaction" => {
            let Some(transaction_id) = helcim_webhook_event_id(&value) else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            match handle_helcim_card_transaction(&state, &transaction_id).await {
                Ok(updated) => {
                    Json(serde_json::json!({ "ok": true, "updated": updated })).into_response()
                }
                Err(error) => {
                    tracing::error!(target = "helcim_webhook", error = %error, transaction_id = %transaction_id, "card transaction handling failed");
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
        "terminalCancel" => match handle_helcim_terminal_cancel(&state, &value).await {
            Ok(updated) => {
                Json(serde_json::json!({ "ok": true, "updated": updated })).into_response()
            }
            Err(error) => {
                tracing::error!(target = "helcim_webhook", error = %error, "terminal cancel handling failed");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        _ => {
            tracing::debug!(target = "helcim_webhook", event_type = %event_type, "unhandled event type");
            Json(serde_json::json!({ "ok": true, "ignored": true })).into_response()
        }
    }
}

async fn handle_helcim_card_transaction(
    state: &AppState,
    transaction_id: &str,
) -> Result<u64, sqlx::Error> {
    let config = helcim::HelcimConfig::from_env();
    let transaction = helcim::fetch_card_transaction(&state.http_client, &config, transaction_id)
        .await
        .map_err(sqlx::Error::Protocol)?;
    let Some(amount_cents) = transaction.amount_cents() else {
        return Err(sqlx::Error::Protocol(
            "Helcim transaction missing valid amount".to_string(),
        ));
    };
    let currency = transaction
        .currency
        .as_deref()
        .unwrap_or("usd")
        .trim()
        .to_ascii_lowercase();
    let normalized_status = transaction.normalized_status();
    let provider_transaction_id = transaction
        .transaction_id_string()
        .unwrap_or_else(|| transaction_id.to_string());
    let provider_payment_id = transaction
        .invoice_number
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| provider_transaction_id.clone());
    let audit_reference = transaction
        .audit_reference()
        .unwrap_or_else(|| format!("helcim:cardTransaction:{provider_transaction_id}"));
    let terminal_id = config.device_code().unwrap_or_default().to_string();
    let result = sqlx::query(
        r#"
        UPDATE payment_provider_attempts
        SET status = $1,
            provider_transaction_id = $2,
            provider_payment_id = $3,
            raw_audit_reference = $4,
            error_code = CASE WHEN $1 = 'failed' THEN COALESCE($5, 'declined') ELSE error_code END,
            error_message = CASE WHEN $1 = 'failed' THEN COALESCE($6, 'Helcim payment was declined.') ELSE error_message END,
            completed_at = now()
        WHERE id = (
            SELECT id
            FROM payment_provider_attempts
            WHERE provider = 'helcim'
              AND status = 'pending'
              AND terminal_id = $7
              AND amount_cents = $8
              AND currency = $9
            ORDER BY created_at ASC
            LIMIT 1
        )
        "#
    )
        .bind(&normalized_status)
        .bind(&provider_transaction_id)
        .bind(&provider_payment_id)
        .bind(&audit_reference)
        .bind(transaction.provider_status())
        .bind(transaction.warning)
        .bind(terminal_id)
        .bind(amount_cents)
        .bind(currency)
        .execute(&state.db)
        .await?;
    Ok(result.rows_affected())
}

async fn handle_helcim_terminal_cancel(
    state: &AppState,
    value: &Value,
) -> Result<u64, sqlx::Error> {
    let device_code = helcim_webhook_device_code(value)
        .or_else(|| {
            helcim::HelcimConfig::from_env()
                .device_code()
                .map(str::to_string)
        })
        .unwrap_or_default();
    let amount_cents = helcim_webhook_amount_cents(value);
    let currency = helcim_webhook_currency(value);
    let query = r#"
        UPDATE payment_provider_attempts
        SET status = 'canceled',
            error_code = 'terminal_cancel',
            error_message = 'Canceled on Helcim terminal.',
            raw_audit_reference = $1,
            completed_at = now()
        WHERE id = (
            SELECT id
            FROM payment_provider_attempts
            WHERE provider = 'helcim'
              AND status = 'pending'
              AND terminal_id = $2
              AND ($3::bigint IS NULL OR amount_cents = $3)
              AND ($4::text IS NULL OR currency = $4)
            ORDER BY created_at ASC
            LIMIT 1
        )
        "#;
    let audit = value
        .get("data")
        .and_then(|data| data.get("cancelledAt"))
        .and_then(Value::as_str)
        .map(|cancelled_at| format!("helcim:terminalCancel:{device_code}:{cancelled_at}"))
        .unwrap_or_else(|| format!("helcim:terminalCancel:{device_code}"));
    let query = sqlx::query(query)
        .bind(audit)
        .bind(device_code)
        .bind(amount_cents)
        .bind(currency);
    let result = query.execute(&state.db).await?;
    Ok(result.rows_affected())
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

fn verify_corecard_webhook_headers(
    config: &corecard::CoreCardConfig,
    headers: &HeaderMap,
) -> Result<Option<String>, StatusCode> {
    let supplied_secret = headers
        .get("x-riverside-corecard-webhook-secret")
        .or_else(|| headers.get("x-corecard-webhook-secret"))
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match config.webhook_secret.as_deref() {
        Some(secret) => {
            if supplied_secret == Some(secret) || bearer == Some(secret) {
                Ok(Some("shared_secret".to_string()))
            } else {
                Err(StatusCode::UNAUTHORIZED)
            }
        }
        None if config.webhook_allow_unsigned => Ok(Some("unsigned_allowed".to_string())),
        None => Err(StatusCode::BAD_REQUEST),
    }
}

async fn post_corecard_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let verification_result =
        match verify_corecard_webhook_headers(&state.corecard_config, &headers) {
            Ok(result) => result,
            Err(status) => return status.into_response(),
        };

    let value: Value = match serde_json::from_slice(body.as_ref()) {
        Ok(v) => v,
        Err(error) => {
            tracing::warn!(target = "corecard_webhook", error = %error, "invalid corecard webhook json");
            return StatusCode::BAD_REQUEST.into_response();
        }
    };

    match corecard::log_and_process_webhook_event(
        &state.db,
        &state.corecard_config,
        &value,
        verification_result.is_some(),
        verification_result.as_deref(),
    )
    .await
    {
        Ok(result) => Json(serde_json::json!({
            "ok": true,
            "event_id": result.event_id,
            "processing_status": result.processing_status,
            "duplicate": result.duplicate,
            "related_rms_record_id": result.related_rms_record_id,
        }))
        .into_response(),
        Err(error) => {
            tracing::error!(target = "corecard_webhook", error = %error, "corecard webhook processing failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
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
        .route("/helcim", post(post_helcim_webhook))
        .route("/corecard", post(post_corecard_webhook))
}

pub fn integrations_router() -> Router<AppState> {
    Router::new().route("/corecard/webhooks", post(post_corecard_webhook))
}
