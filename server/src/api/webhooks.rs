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
use chrono::{DateTime, Duration, TimeZone, Utc};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use std::sync::Arc;

use crate::api::AppState;
use crate::logic::corecard;
use crate::logic::helcim;
use crate::logic::podium_inbound;
use crate::logic::podium_webhook::{
    podium_inbound_crm_ingest_enabled, record_podium_webhook_delivery,
    verify_podium_webhook_headers, PodiumWebhookDisposition, PodiumWebhookVerifyError,
};

const HELCIM_WEBHOOK_FALLBACK_MAX_AGE_MINUTES: i64 = 10;

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

const HELCIM_WEBHOOK_FRESHNESS_WINDOW: Duration = Duration::minutes(10);

#[derive(Debug, Clone)]
struct HelcimWebhookVerification {
    webhook_id: String,
    webhook_timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HelcimWebhookAction {
    CardTransaction,
    TerminalCancel,
    Ignore,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct HelcimEventLogRow {
    id: Uuid,
    processing_status: String,
    created: bool,
}

#[derive(Debug, Clone)]
struct HelcimProcessingOutcome {
    updated: u64,
    provider_transaction_id: Option<String>,
    payment_provider_attempt_id: Option<Uuid>,
    payment_transaction_id: Option<Uuid>,
    match_type: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct HelcimReplayOutcome {
    pub ok: bool,
    pub processing_status: String,
    pub updated: u64,
    pub provider_transaction_id: Option<String>,
    pub payment_provider_attempt_id: Option<Uuid>,
    pub payment_transaction_id: Option<Uuid>,
    pub match_type: String,
    pub ignored: bool,
}

fn verify_helcim_webhook(
    headers: &HeaderMap,
    body: &[u8],
    now: DateTime<Utc>,
) -> Result<HelcimWebhookVerification, StatusCode> {
    let verifier_token = std::env::var("HELCIM_WEBHOOK_SECRET")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    verify_helcim_webhook_with_token(headers, body, now, &verifier_token)
}

fn verify_helcim_webhook_with_token(
    headers: &HeaderMap,
    body: &[u8],
    now: DateTime<Utc>,
    verifier_token: &str,
) -> Result<HelcimWebhookVerification, StatusCode> {
    let token_bytes = BASE64_STANDARD
        .decode(verifier_token.trim())
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
    let parsed_timestamp =
        parse_helcim_webhook_timestamp(webhook_timestamp).ok_or(StatusCode::BAD_REQUEST)?;
    let age = now.signed_duration_since(parsed_timestamp);
    if age > HELCIM_WEBHOOK_FRESHNESS_WINDOW || age < -HELCIM_WEBHOOK_FRESHNESS_WINDOW {
        return Err(StatusCode::BAD_REQUEST);
    }
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
        Ok(HelcimWebhookVerification {
            webhook_id: webhook_id.to_string(),
            webhook_timestamp: parsed_timestamp,
        })
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn parse_helcim_webhook_timestamp(value: &str) -> Option<DateTime<Utc>> {
    let trimmed = value.trim();
    if let Ok(epoch) = trimmed.parse::<i64>() {
        let (seconds, nanos) = if epoch.abs() >= 1_000_000_000_000 {
            (
                epoch / 1000,
                (epoch % 1000).unsigned_abs() as u32 * 1_000_000,
            )
        } else {
            (epoch, 0)
        };
        return Utc.timestamp_opt(seconds, nanos).single();
    }
    DateTime::parse_from_rfc3339(trimmed)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn helcim_payload_hash(body: &[u8]) -> String {
    hex::encode(Sha256::digest(body))
}

fn helcim_webhook_action(event_type: &str) -> HelcimWebhookAction {
    match event_type {
        "cardTransaction" => HelcimWebhookAction::CardTransaction,
        "terminalCancel" => HelcimWebhookAction::TerminalCancel,
        _ => HelcimWebhookAction::Ignore,
    }
}

fn helcim_event_is_final(status: &str) -> bool {
    matches!(status, "processed" | "ignored")
}

fn helcim_event_should_process(event: &HelcimEventLogRow) -> bool {
    event.created
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

async fn record_helcim_event(
    db: &PgPool,
    verification: &HelcimWebhookVerification,
    event_type: &str,
    body: &[u8],
    payload: &Value,
) -> Result<HelcimEventLogRow, sqlx::Error> {
    // xmax = 0 identifies the inserted row; conflict returns the existing row
    // so duplicate deliveries do not enter the mutation path.
    sqlx::query_as::<_, HelcimEventLogRow>(
        r#"
        INSERT INTO helcim_event_log (
            provider,
            webhook_id,
            event_type,
            webhook_timestamp,
            signature_valid,
            payload_hash,
            payload_json,
            processing_status
        )
        VALUES ('helcim', $1, $2, $3, TRUE, $4, $5, 'received')
        ON CONFLICT (webhook_id) WHERE webhook_id IS NOT NULL DO UPDATE
        SET webhook_id = helcim_event_log.webhook_id
        RETURNING id, processing_status, (xmax = 0) AS created
        "#,
    )
    .bind(&verification.webhook_id)
    .bind(event_type)
    .bind(verification.webhook_timestamp)
    .bind(helcim_payload_hash(body))
    .bind(helcim::redact_provider_payload(payload))
    .fetch_one(db)
    .await
}

async fn mark_helcim_event_failed(
    db: &PgPool,
    event_id: Uuid,
    error_message: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE helcim_event_log
        SET processing_status = 'failed',
            error_message = $2
        WHERE id = $1
        "#,
    )
    .bind(event_id)
    .bind(error_message)
    .execute(db)
    .await?;
    Ok(())
}

async fn mark_helcim_event_ignored(
    db: &PgPool,
    event_id: Uuid,
    event_type: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE helcim_event_log
        SET processing_status = 'ignored',
            error_message = NULL,
            match_type = 'none'
        WHERE id = $1
        "#,
    )
    .bind(event_id)
    .execute(db)
    .await?;
    tracing::debug!(target = "helcim_webhook", event_type = %event_type, "stored unhandled Helcim event");
    Ok(())
}

pub async fn replay_helcim_event(
    state: &AppState,
    event_id: Uuid,
) -> Result<HelcimReplayOutcome, sqlx::Error> {
    let row: Option<(String, String, Value)> = sqlx::query_as(
        r#"
        SELECT event_type, processing_status, payload_json
        FROM helcim_event_log
        WHERE id = $1
          AND provider = 'helcim'
        "#,
    )
    .bind(event_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((event_type, processing_status, value)) = row else {
        return Err(sqlx::Error::RowNotFound);
    };
    if processing_status != "failed" {
        return Err(sqlx::Error::Protocol(
            "Only failed Helcim events can be replayed.".to_string(),
        ));
    }

    sqlx::query(
        r#"
        UPDATE helcim_event_log
        SET processing_status = 'received',
            error_message = NULL
        WHERE id = $1
        "#,
    )
    .bind(event_id)
    .execute(&state.db)
    .await?;

    match helcim_webhook_action(&event_type) {
        HelcimWebhookAction::CardTransaction => {
            let transaction_id = helcim_webhook_event_id(&value).ok_or_else(|| {
                sqlx::Error::Protocol("missing Helcim transaction id".to_string())
            })?;
            match handle_helcim_card_transaction(state, event_id, &transaction_id, &value).await {
                Ok(outcome) => Ok(HelcimReplayOutcome {
                    ok: true,
                    processing_status: "processed".to_string(),
                    updated: outcome.updated,
                    provider_transaction_id: outcome.provider_transaction_id,
                    payment_provider_attempt_id: outcome.payment_provider_attempt_id,
                    payment_transaction_id: outcome.payment_transaction_id,
                    match_type: outcome.match_type,
                    ignored: false,
                }),
                Err(error) => {
                    let message = error.to_string();
                    let _ = mark_helcim_event_failed(&state.db, event_id, &message).await;
                    Err(error)
                }
            }
        }
        HelcimWebhookAction::TerminalCancel => {
            match handle_helcim_terminal_cancel(state, event_id, &value).await {
                Ok(outcome) => Ok(HelcimReplayOutcome {
                    ok: true,
                    processing_status: "processed".to_string(),
                    updated: outcome.updated,
                    provider_transaction_id: outcome.provider_transaction_id,
                    payment_provider_attempt_id: outcome.payment_provider_attempt_id,
                    payment_transaction_id: outcome.payment_transaction_id,
                    match_type: outcome.match_type,
                    ignored: false,
                }),
                Err(error) => {
                    let message = error.to_string();
                    let _ = mark_helcim_event_failed(&state.db, event_id, &message).await;
                    Err(error)
                }
            }
        }
        HelcimWebhookAction::Ignore => {
            mark_helcim_event_ignored(&state.db, event_id, &event_type).await?;
            Ok(HelcimReplayOutcome {
                ok: true,
                processing_status: "ignored".to_string(),
                updated: 0,
                provider_transaction_id: None,
                payment_provider_attempt_id: None,
                payment_transaction_id: None,
                match_type: "none".to_string(),
                ignored: true,
            })
        }
    }
}

async fn post_helcim_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let verification = match verify_helcim_webhook(&headers, body.as_ref(), Utc::now()) {
        Ok(verification) => verification,
        Err(status) => {
            tracing::warn!(target = "helcim_webhook", status = ?status, "verification failed");
            return status.into_response();
        }
    };

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
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown");

    let event = match record_helcim_event(
        &state.db,
        &verification,
        event_type,
        body.as_ref(),
        &value,
    )
    .await
    {
        Ok(event) => event,
        Err(error) => {
            tracing::error!(target = "helcim_webhook", error = %error, "event persistence failed");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if !helcim_event_should_process(&event) || helcim_event_is_final(&event.processing_status) {
        return Json(json!({
            "ok": true,
            "duplicate": true,
            "processing_status": event.processing_status,
        }))
        .into_response();
    }

    match helcim_webhook_action(event_type) {
        HelcimWebhookAction::CardTransaction => {
            let Some(transaction_id) = helcim_webhook_event_id(&value) else {
                let _ =
                    mark_helcim_event_failed(&state.db, event.id, "missing Helcim transaction id")
                        .await;
                return StatusCode::BAD_REQUEST.into_response();
            };
            match handle_helcim_card_transaction(&state, event.id, &transaction_id, &value).await {
                Ok(outcome) => Json(json!({
                    "ok": true,
                    "updated": outcome.updated,
                    "processing_status": "processed",
                    "provider_transaction_id": outcome.provider_transaction_id,
                    "payment_provider_attempt_id": outcome.payment_provider_attempt_id,
                    "payment_transaction_id": outcome.payment_transaction_id,
                    "match_type": outcome.match_type,
                }))
                .into_response(),
                Err(error) => {
                    let error_message = error.to_string();
                    if let Err(mark_error) =
                        mark_helcim_event_failed(&state.db, event.id, &error_message).await
                    {
                        tracing::error!(target = "helcim_webhook", error = %mark_error, event_id = %event.id, "failed to mark Helcim event failed");
                    }
                    tracing::error!(target = "helcim_webhook", error = %error, transaction_id = %transaction_id, "card transaction handling failed");
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
        HelcimWebhookAction::TerminalCancel => {
            match handle_helcim_terminal_cancel(&state, event.id, &value).await {
                Ok(outcome) => Json(json!({
                    "ok": true,
                    "updated": outcome.updated,
                    "processing_status": "processed",
                    "payment_provider_attempt_id": outcome.payment_provider_attempt_id,
                    "match_type": outcome.match_type,
                }))
                .into_response(),
                Err(error) => {
                    let error_message = error.to_string();
                    if let Err(mark_error) =
                        mark_helcim_event_failed(&state.db, event.id, &error_message).await
                    {
                        tracing::error!(target = "helcim_webhook", error = %mark_error, event_id = %event.id, "failed to mark Helcim event failed");
                    }
                    tracing::error!(target = "helcim_webhook", error = %error, "terminal cancel handling failed");
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
        HelcimWebhookAction::Ignore => {
            match mark_helcim_event_ignored(&state.db, event.id, event_type).await {
                Ok(()) => Json(json!({
                    "ok": true,
                    "ignored": true,
                    "processing_status": "ignored",
                }))
                .into_response(),
                Err(error) => {
                    tracing::error!(target = "helcim_webhook", error = %error, event_id = %event.id, "failed to mark Helcim event ignored");
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
    }
}

async fn handle_helcim_card_transaction(
    state: &AppState,
    event_id: Uuid,
    transaction_id: &str,
    value: &Value,
) -> Result<HelcimProcessingOutcome, sqlx::Error> {
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
    let terminal_id = helcim_webhook_device_code(value).unwrap_or_default();

    let mut tx = state.db.begin().await?;
    let mut match_type = "provider_transaction_id";
    let mut attempt_id: Option<Uuid> = sqlx::query_scalar(
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
              AND provider_transaction_id = $2
            ORDER BY created_at ASC
            LIMIT 1
        )
        RETURNING id
        "#
    )
        .bind(&normalized_status)
        .bind(&provider_transaction_id)
        .bind(&provider_payment_id)
        .bind(&audit_reference)
        .bind(transaction.provider_status())
        .bind(transaction.warning.clone())
        .fetch_optional(&mut *tx)
        .await?;

    if attempt_id.is_none() {
        match_type = "terminal_amount";
        if let Some(candidate_id) = find_safe_helcim_terminal_fallback_candidate(
            &mut tx,
            &terminal_id,
            Some(amount_cents),
            Some(&currency),
        )
        .await?
        {
            attempt_id = sqlx::query_scalar(
            r#"
            UPDATE payment_provider_attempts
            SET status = $1,
                provider_transaction_id = $2,
                provider_payment_id = $3,
                raw_audit_reference = $4,
                error_code = CASE WHEN $1 = 'failed' THEN COALESCE($5, 'declined') ELSE error_code END,
                error_message = CASE WHEN $1 = 'failed' THEN COALESCE($6, 'Helcim payment was declined.') ELSE error_message END,
                completed_at = now()
            WHERE id = $7
            RETURNING id
            "#
        )
            .bind(&normalized_status)
            .bind(&provider_transaction_id)
            .bind(&provider_payment_id)
            .bind(&audit_reference)
            .bind(transaction.provider_status())
            .bind(transaction.warning)
            .bind(candidate_id)
            .fetch_optional(&mut *tx)
            .await?;
        }
    }

    if attempt_id.is_none() {
        match_type = "none";
    }

    let payment_transaction_id: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM payment_transactions
        WHERE payment_provider = 'helcim'
          AND provider_transaction_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(&provider_transaction_id)
    .fetch_optional(&mut *tx)
    .await?;

    mark_helcim_event_processed(
        &mut tx,
        event_id,
        Some(&provider_transaction_id),
        attempt_id,
        payment_transaction_id,
        match_type,
    )
    .await?;
    tx.commit().await?;

    Ok(HelcimProcessingOutcome {
        updated: u64::from(attempt_id.is_some()),
        provider_transaction_id: Some(provider_transaction_id),
        payment_provider_attempt_id: attempt_id,
        payment_transaction_id,
        match_type: match_type.to_string(),
    })
}

async fn handle_helcim_terminal_cancel(
    state: &AppState,
    event_id: Uuid,
    value: &Value,
) -> Result<HelcimProcessingOutcome, sqlx::Error> {
    let device_code = helcim_webhook_device_code(value).unwrap_or_default();
    let amount_cents = helcim_webhook_amount_cents(value);
    let currency = helcim_webhook_currency(value);
    let audit = value
        .get("data")
        .and_then(|data| data.get("cancelledAt"))
        .and_then(Value::as_str)
        .map(|cancelled_at| format!("helcim:terminalCancel:{device_code}:{cancelled_at}"))
        .unwrap_or_else(|| format!("helcim:terminalCancel:{device_code}"));
    let mut tx = state.db.begin().await?;
    let attempt_id: Option<Uuid> = if let Some(candidate_id) =
        find_safe_helcim_terminal_fallback_candidate(
            &mut tx,
            &device_code,
            amount_cents,
            currency.as_deref(),
        )
        .await?
    {
        sqlx::query_scalar(
            r#"
            UPDATE payment_provider_attempts
            SET status = 'canceled',
                error_code = 'terminal_cancel',
                error_message = 'Canceled on Helcim terminal.',
                raw_audit_reference = $1,
                completed_at = now()
            WHERE id = $2
            RETURNING id
            "#,
        )
        .bind(audit)
        .bind(candidate_id)
        .fetch_optional(&mut *tx)
        .await?
    } else {
        None
    };
    let match_type = if attempt_id.is_none() {
        "none"
    } else if amount_cents.is_some() {
        "terminal_amount"
    } else {
        "terminal"
    };
    mark_helcim_event_processed(&mut tx, event_id, None, attempt_id, None, match_type).await?;
    tx.commit().await?;
    Ok(HelcimProcessingOutcome {
        updated: u64::from(attempt_id.is_some()),
        provider_transaction_id: None,
        payment_provider_attempt_id: attempt_id,
        payment_transaction_id: None,
        match_type: match_type.to_string(),
    })
}

async fn find_safe_helcim_terminal_fallback_candidate(
    tx: &mut Transaction<'_, Postgres>,
    terminal_id: &str,
    amount_cents: Option<i64>,
    currency: Option<&str>,
) -> Result<Option<Uuid>, sqlx::Error> {
    let candidates: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM payment_provider_attempts
        WHERE provider = 'helcim'
          AND status = 'pending'
          AND terminal_id = $1
          AND ($2::bigint IS NULL OR amount_cents = $2)
          AND ($3::text IS NULL OR currency = $3)
          AND created_at >= now() - ($4::bigint * interval '1 minute')
        ORDER BY created_at ASC
        LIMIT 2
        "#,
    )
    .bind(terminal_id)
    .bind(amount_cents)
    .bind(currency)
    .bind(HELCIM_WEBHOOK_FALLBACK_MAX_AGE_MINUTES)
    .fetch_all(&mut **tx)
    .await?;

    let Some(candidate_id) = candidates.first().copied() else {
        return Ok(None);
    };
    if candidates.len() > 1 {
        tracing::warn!(
            target = "helcim_webhook",
            terminal_id,
            candidate_count = candidates.len(),
            "refusing ambiguous Helcim terminal fallback match"
        );
        return Ok(None);
    }

    let unsafe_match_exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM payment_provider_attempts candidate
            WHERE candidate.id = $1
              AND (
                EXISTS (
                    SELECT 1
                    FROM payment_provider_attempts newer
                    WHERE newer.provider = 'helcim'
                      AND newer.terminal_id = candidate.terminal_id
                      AND newer.created_at > candidate.created_at
                )
                OR EXISTS (
                    SELECT 1
                    FROM payment_provider_attempts older_expired
                    WHERE older_expired.provider = 'helcim'
                      AND older_expired.status = 'expired'
                      AND older_expired.terminal_id = candidate.terminal_id
                      AND older_expired.created_at < candidate.created_at
                      AND ($2::bigint IS NULL OR older_expired.amount_cents = $2)
                      AND ($3::text IS NULL OR older_expired.currency = $3)
                )
              )
        )
        "#,
    )
    .bind(candidate_id)
    .bind(amount_cents)
    .bind(currency)
    .fetch_one(&mut **tx)
    .await?;

    if unsafe_match_exists {
        tracing::warn!(
            target = "helcim_webhook",
            terminal_id,
            candidate_id = %candidate_id,
            "refusing stale Helcim terminal fallback match"
        );
        return Ok(None);
    }

    Ok(Some(candidate_id))
}

async fn mark_helcim_event_processed(
    tx: &mut Transaction<'_, Postgres>,
    event_id: Uuid,
    provider_transaction_id: Option<&str>,
    payment_provider_attempt_id: Option<Uuid>,
    payment_transaction_id: Option<Uuid>,
    match_type: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE helcim_event_log
        SET processing_status = 'processed',
            error_message = NULL,
            provider_transaction_id = COALESCE($2, provider_transaction_id),
            payment_provider_attempt_id = $3,
            payment_transaction_id = $4,
            match_type = $5
        WHERE id = $1
        "#,
    )
    .bind(event_id)
    .bind(provider_transaction_id)
    .bind(payment_provider_attempt_id)
    .bind(payment_transaction_id)
    .bind(match_type)
    .execute(&mut **tx)
    .await?;
    Ok(())
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

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/podium", post(post_podium_webhook))
        .route("/helcim", post(post_helcim_webhook))
        .route("/corecard", post(post_corecard_webhook))
}

pub fn integrations_router() -> Router<AppState> {
    Router::new().route("/corecard/webhooks", post(post_corecard_webhook))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn signed_helcim_headers(
        webhook_id: &str,
        timestamp: DateTime<Utc>,
        body: &[u8],
        token: &[u8],
    ) -> HeaderMap {
        let token_b64 = BASE64_STANDARD.encode(token);
        let timestamp_text = timestamp.timestamp().to_string();
        let body_text = std::str::from_utf8(body).expect("test body is utf8");
        let signed_content = format!("{webhook_id}.{timestamp_text}.{body_text}");
        let mut mac = Hmac::<Sha256>::new_from_slice(token).expect("hmac key");
        mac.update(signed_content.as_bytes());
        let signature = BASE64_STANDARD.encode(mac.finalize().into_bytes());

        let mut headers = HeaderMap::new();
        headers.insert("webhook-id", HeaderValue::from_str(webhook_id).unwrap());
        headers.insert(
            "webhook-timestamp",
            HeaderValue::from_str(&timestamp_text).unwrap(),
        );
        headers.insert(
            "webhook-signature",
            HeaderValue::from_str(&format!("v1,{signature}")).unwrap(),
        );
        headers.insert("x-test-token", HeaderValue::from_str(&token_b64).unwrap());
        headers
    }

    #[test]
    fn helcim_signature_accepts_valid_recent_event() {
        let body = br#"{"type":"cardTransaction","id":"123"}"#;
        let now = Utc::now();
        let headers = signed_helcim_headers("evt-1", now, body, b"secret");
        let token = BASE64_STANDARD.encode(b"secret");

        let verified =
            verify_helcim_webhook_with_token(&headers, body, now, &token).expect("valid webhook");

        assert_eq!(verified.webhook_id, "evt-1");
    }

    #[test]
    fn helcim_signature_rejects_invalid_signature() {
        let body = br#"{"type":"cardTransaction","id":"123"}"#;
        let now = Utc::now();
        let mut headers = signed_helcim_headers("evt-1", now, body, b"secret");
        headers.insert(
            "webhook-signature",
            HeaderValue::from_static("v1,not-a-valid-signature"),
        );
        let token = BASE64_STANDARD.encode(b"secret");

        let err = verify_helcim_webhook_with_token(&headers, body, now, &token).unwrap_err();

        assert_eq!(err, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn helcim_signature_rejects_stale_timestamp() {
        let body = br#"{"type":"cardTransaction","id":"123"}"#;
        let now = Utc::now();
        let headers = signed_helcim_headers("evt-1", now - Duration::minutes(30), body, b"secret");
        let token = BASE64_STANDARD.encode(b"secret");

        let err = verify_helcim_webhook_with_token(&headers, body, now, &token).unwrap_err();

        assert_eq!(err, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn helcim_unknown_event_is_ignored_action() {
        assert_eq!(
            helcim_webhook_action("batchSettled"),
            HelcimWebhookAction::Ignore
        );
    }

    #[test]
    fn helcim_final_statuses_are_idempotent_skip_states() {
        assert!(helcim_event_is_final("processed"));
        assert!(helcim_event_is_final("ignored"));
        assert!(!helcim_event_is_final("failed"));
        assert!(!helcim_event_is_final("received"));
    }

    #[test]
    fn helcim_only_newly_created_event_enters_processing_path() {
        let new_event = HelcimEventLogRow {
            id: Uuid::new_v4(),
            processing_status: "received".to_string(),
            created: true,
        };
        let duplicate_in_flight = HelcimEventLogRow {
            id: Uuid::new_v4(),
            processing_status: "received".to_string(),
            created: false,
        };
        let duplicate_failed = HelcimEventLogRow {
            id: Uuid::new_v4(),
            processing_status: "failed".to_string(),
            created: false,
        };

        assert!(helcim_event_should_process(&new_event));
        assert!(!helcim_event_should_process(&duplicate_in_flight));
        assert!(!helcim_event_should_process(&duplicate_failed));
    }

    #[test]
    fn helcim_payload_redaction_removes_card_data() {
        let payload = json!({
            "type": "cardTransaction",
            "data": {
                "cardNumber": "4111111111111111",
                "cardToken": "tok_123",
                "transactionAmount": "10.00"
            }
        });

        let redacted = helcim::redact_provider_payload(&payload);

        assert_eq!(redacted["data"]["cardNumber"], "[REDACTED]");
        assert_eq!(redacted["data"]["cardToken"], "[REDACTED]");
        assert_eq!(redacted["data"]["transactionAmount"], "10.00");
    }

    #[test]
    fn helcim_payload_hash_is_stable() {
        let body = br#"{"type":"terminalCancel"}"#;
        assert_eq!(helcim_payload_hash(body), helcim_payload_hash(body));
    }
}
