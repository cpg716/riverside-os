//! Unauthenticated inbound webhooks (Podium, etc.).

use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
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

use rust_decimal::Decimal;
use std::{collections::HashMap, sync::Arc};

use crate::api::AppState;
use crate::logic::helcim;
use crate::logic::podium_inbound;
use crate::logic::podium_webhook::{
    podium_inbound_crm_ingest_enabled, record_podium_webhook_delivery,
    record_podium_webhook_failure, verify_podium_webhook_headers, PodiumWebhookDisposition,
    PodiumWebhookVerifyError,
};

const HELCIM_WEBHOOK_FALLBACK_MAX_AGE_MINUTES: i64 = 10;
const SHIPPO_WEBHOOK_SIGNATURE_HEADER: &str = "shippo-auth-signature";

async fn get_edge_probe(Query(params): Query<HashMap<String, String>>) -> impl IntoResponse {
    let nonce = params.get("nonce").map(String::as_str).unwrap_or("").trim();
    if nonce.len() < 8 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "error": "missing probe nonce",
            })),
        )
            .into_response();
    }

    Json(json!({
        "ok": true,
        "component": "riverside-edge-probe",
        "nonce": nonce,
        "version": env!("CARGO_PKG_VERSION"),
    }))
    .into_response()
}

fn verify_shippo_webhook(
    headers: &HeaderMap,
    body: &[u8],
    token_param: Option<&str>,
) -> StatusCode {
    let Some(secret) = crate::logic::shippo::shippo_webhook_secret_from_env() else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };

    if let Some(sig_header) = headers
        .get(SHIPPO_WEBHOOK_SIGNATURE_HEADER)
        .and_then(|v| v.to_str().ok())
    {
        let mut timestamp: Option<&str> = None;
        let mut signature: Option<&str> = None;
        for part in sig_header.split(',') {
            let mut pieces = part.trim().splitn(2, '=');
            match (pieces.next(), pieces.next()) {
                (Some("t"), Some(value)) => timestamp = Some(value),
                (Some("v1"), Some(value)) => signature = Some(value),
                _ => {}
            }
        }
        let Some(timestamp) = timestamp else {
            return StatusCode::BAD_REQUEST;
        };
        let Some(signature) = signature else {
            return StatusCode::BAD_REQUEST;
        };
        let Ok(provided) = hex::decode(signature) else {
            return StatusCode::BAD_REQUEST;
        };
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac key");
        mac.update(format!("{timestamp}.").as_bytes());
        mac.update(body);
        let expected = mac.finalize().into_bytes();
        if expected.as_slice().ct_eq(provided.as_slice()).into() {
            return StatusCode::OK;
        }
        return StatusCode::UNAUTHORIZED;
    }

    match token_param {
        Some(token) if token.as_bytes().ct_eq(secret.as_bytes()).into() => StatusCode::OK,
        Some(_) => StatusCode::UNAUTHORIZED,
        None => StatusCode::BAD_REQUEST,
    }
}

fn shippo_tracking_status_to_ros(status: Option<&str>) -> Option<&'static str> {
    match status.unwrap_or("").trim().to_ascii_uppercase().as_str() {
        "DELIVERED" => Some("delivered"),
        "TRANSIT" | "PRE_TRANSIT" | "UNKNOWN" => Some("in_transit"),
        "FAILURE" | "RETURNED" => Some("exception"),
        _ => None,
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct ShippoTrackingStatus {
    status: Option<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct ShippoWebhookData {
    transaction: Option<String>,
    object_id: Option<String>,
    tracking_number: Option<String>,
    tracking_status: Option<ShippoTrackingStatus>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct ShippoWebhookPayload {
    event: String,
    data: Option<ShippoWebhookData>,
}

#[derive(Debug, serde::Deserialize)]
struct PodiumWebhookPayload {
    id: String,
    event: String,
    data: Option<serde_json::Value>,
}

#[derive(Debug, serde::Deserialize)]
struct HelcimWebhookPayload {
    #[serde(rename = "type")]
    event_type: String,
    data: Option<serde_json::Value>,
}

async fn post_shippo_webhook(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let verify = verify_shippo_webhook(
        &headers,
        body.as_ref(),
        params.get("token").map(String::as_str),
    );
    if verify != StatusCode::OK {
        tracing::warn!(target = "shippo_webhook", status = %verify, "shippo webhook verification failed");
        return verify.into_response();
    }

    let payload: ShippoWebhookPayload = match serde_json::from_slice(body.as_ref()) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(target = "shippo_webhook", error = %error, "Shippo webhook strict validation failed");
            return StatusCode::BAD_REQUEST.into_response();
        }
    };

    let event = payload.event.as_str();
    let (transaction_id, tracking_number, status) = if let Some(ref data) = payload.data {
        (
            data.transaction.as_deref().or(data.object_id.as_deref()),
            data.tracking_number.as_deref(),
            data.tracking_status
                .as_ref()
                .and_then(|ts| ts.status.as_deref()),
        )
    } else {
        (None, None, None)
    };
    let ros_status = shippo_tracking_status_to_ros(status);

    let row: Option<(Uuid,)> = match (transaction_id, tracking_number) {
        (Some(tx), _) => {
            sqlx::query_as(
                "SELECT id FROM shipment WHERE shippo_transaction_object_id = $1 LIMIT 1",
            )
            .bind(tx)
            .fetch_optional(&state.db)
            .await
        }
        (None, Some(tracking)) => {
            sqlx::query_as("SELECT id FROM shipment WHERE tracking_number = $1 LIMIT 1")
                .bind(tracking)
                .fetch_optional(&state.db)
                .await
        }
        _ => Ok(None),
    }
    .unwrap_or_else(|error| {
        tracing::error!(target = "shippo_webhook", error = %error, "shippo webhook lookup failed");
        None
    });

    let Some((shipment_id,)) = row else {
        tracing::info!(
            target = "shippo_webhook",
            event,
            "shippo webhook had no matching ROS shipment"
        );
        return Json(json!({ "ok": true, "matched": false })).into_response();
    };

    let update_result = sqlx::query(
        r#"
        UPDATE shipment
        SET
            status = COALESCE($2::shipment_status, status),
            tracking_number = COALESCE($3, tracking_number),
            updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(shipment_id)
    .bind(ros_status)
    .bind(tracking_number)
    .execute(&state.db)
    .await;
    if let Err(error) = update_result {
        tracing::error!(target = "shippo_webhook", error = %error, "shippo webhook update failed");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let _ = sqlx::query(
        r#"
        INSERT INTO shipment_event (shipment_id, kind, message, metadata)
        VALUES ($1, 'shippo_webhook', $2, $3)
        "#,
    )
    .bind(shipment_id)
    .bind(format!("Shippo webhook received: {event}"))
    .bind(serde_json::json!({
        "event": event,
        "tracking_status": status,
        "tracking_number": tracking_number,
        "transaction": transaction_id,
        "payload": payload,
    }))
    .execute(&state.db)
    .await;

    Json(json!({ "ok": true, "matched": true, "shipment_id": shipment_id })).into_response()
}

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
            | PodiumWebhookVerifyError::InvalidTimestamp
            | PodiumWebhookVerifyError::StaleTimestamp => StatusCode::BAD_REQUEST,
        };
        tracing::warn!(target = "podium_webhook", event = "verify_failed", reason = %e);
        if let Err(record_error) =
            record_podium_webhook_failure(&state.db, raw, &e.to_string(), status.as_u16()).await
        {
            tracing::warn!(
                target = "podium_webhook",
                event = "failure_record_failed",
                error = %record_error
            );
        }
        return status.into_response();
    }

    let value: Value = match serde_json::from_slice(raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(target = "podium_webhook", event = "invalid_json", error = %e);
            if let Err(record_error) = record_podium_webhook_failure(
                &state.db,
                raw,
                "invalid json",
                StatusCode::BAD_REQUEST.as_u16(),
            )
            .await
            {
                tracing::warn!(
                    target = "podium_webhook",
                    event = "failure_record_failed",
                    error = %record_error
                );
            }
            return StatusCode::BAD_REQUEST.into_response();
        }
    };

    let _payload: PodiumWebhookPayload = match serde_json::from_value(value.clone()) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(target = "podium_webhook", event = "strict_validation_failed", error = %e);
            if let Err(record_error) = record_podium_webhook_failure(
                &state.db,
                raw,
                "strict validation failed",
                StatusCode::BAD_REQUEST.as_u16(),
            )
            .await
            {
                tracing::warn!(
                    target = "podium_webhook",
                    event = "failure_record_failed",
                    error = %record_error
                );
            }
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
            match crate::logic::customer_notifications::apply_podium_failure_webhook(
                &state.db, &value,
            )
            .await
            {
                Ok(true) => tracing::info!(
                    target = "podium_webhook",
                    event = "customer_notification_failure_applied"
                ),
                Ok(false) => {}
                Err(error) => tracing::warn!(
                    target = "podium_webhook",
                    event = "customer_notification_failure_apply_failed",
                    error = %error
                ),
            }
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

#[cfg(test)]
fn helcim_webhook_secret_configured() -> bool {
    std::env::var("HELCIM_WEBHOOK_SECRET")
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
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

    let _payload: HelcimWebhookPayload = match serde_json::from_value(value.clone()) {
        Ok(p) => p,
        Err(error) => {
            tracing::warn!(target = "helcim_webhook", error = %error, "strict validation failed");
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
    let provider_status = transaction.provider_status();
    let provider_warning = transaction.warning.clone();
    let terminal_id = helcim_webhook_device_code(value).unwrap_or_default();

    let mut tx = state.db.begin().await?;
    let mut match_type = "provider_transaction_id";
    let mut attempt_row: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
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
        RETURNING id, checkout_client_id
        "#
    )
        .bind(&normalized_status)
        .bind(&provider_transaction_id)
        .bind(&provider_payment_id)
        .bind(&audit_reference)
        .bind(provider_status.clone())
        .bind(provider_warning.clone())
        .fetch_optional(&mut *tx)
        .await?;

    if attempt_row.is_none() {
        match_type = "terminal_amount";
        if let Some(candidate_id) = find_safe_helcim_terminal_fallback_candidate(
            &mut tx,
            &terminal_id,
            Some(amount_cents),
            Some(&currency),
            matches!(normalized_status.as_str(), "approved" | "captured"),
        )
        .await?
        {
            attempt_row = sqlx::query_as(
            r#"
            UPDATE payment_provider_attempts
            SET status = $1,
                provider_transaction_id = $2,
                provider_payment_id = $3,
                raw_audit_reference = $4,
                error_code = CASE WHEN $1 = 'failed' THEN COALESCE($5, 'declined') ELSE NULL END,
                error_message = CASE WHEN $1 = 'failed' THEN COALESCE($6, 'Helcim payment was declined.') ELSE NULL END,
                completed_at = now()
            WHERE id = $7
            RETURNING id, checkout_client_id
            "#
        )
            .bind(&normalized_status)
            .bind(&provider_transaction_id)
            .bind(&provider_payment_id)
            .bind(&audit_reference)
            .bind(provider_status.clone())
            .bind(provider_warning.clone())
            .bind(candidate_id)
            .fetch_optional(&mut *tx)
            .await?;
        }
    }

    let attempt_id = attempt_row.map(|r| r.0);
    let checkout_client_id = attempt_row.and_then(|r| r.1);

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

    let mut final_payment_transaction_id = payment_transaction_id;

    if (normalized_status == "approved" || normalized_status == "captured")
        && final_payment_transaction_id.is_none()
    {
        if let Some(client_id) = checkout_client_id {
            let txn: Option<(Uuid, Decimal, Decimal, Uuid)> = sqlx::query_as(
                "SELECT id, total_price, rounding_adjustment, operator_id FROM transactions WHERE checkout_client_id = $1 AND status = 'processing'"
            )
            .bind(client_id)
            .fetch_optional(&mut *tx)
            .await?;

            if let Some((tid, total_price, rounding_adjustment, operator_id)) = txn {
                let payment_txn_id = Uuid::new_v4();
                let payment_amount = Decimal::from(amount_cents) / Decimal::from(100);

                let insert_result = sqlx::query(
                    r#"
                    INSERT INTO payment_transactions (
                        id, category, payment_method, amount, status, occurred_at,
                        merchant_fee, net_amount, metadata,
                        payment_provider, provider_payment_id, provider_transaction_id, provider_status
                    )
                    VALUES (
                        $1, 'retail_sale', 'card_terminal', $2, 'approved', now(),
                        0, $2, $3,
                        'helcim', $4, $5, $6
                    )
                    "#
                )
                .bind(payment_txn_id)
                .bind(payment_amount)
                .bind(serde_json::json!({
                    "helcim_transaction_id": provider_transaction_id.clone(),
                    "helcim_payment_id": provider_payment_id.clone(),
                    "audit_reference": audit_reference.clone()
                }))
                .bind(&provider_payment_id)
                .bind(&provider_transaction_id)
                .bind(provider_status.clone())
                .execute(&mut *tx)
                .await;

                let recovered_payment_txn_id = match insert_result {
                    Ok(_) => payment_txn_id,
                    Err(sqlx::Error::Database(db_err))
                        if db_err.constraint()
                            == Some("payment_transactions_provider_transaction_uidx") =>
                    {
                        sqlx::query_scalar(
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
                        .fetch_one(&mut *tx)
                        .await?
                    }
                    Err(error) => return Err(error),
                };

                sqlx::query(
                    r#"
                    INSERT INTO payment_allocations (transaction_id, target_transaction_id, amount_allocated)
                    SELECT $1, $2, $3
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM payment_allocations
                        WHERE transaction_id = $1
                          AND target_transaction_id = $2
                    )
                    "#
                )
                .bind(recovered_payment_txn_id)
                .bind(tid)
                .bind(payment_amount)
                .execute(&mut *tx)
                .await?;

                let balance_due = (total_price + rounding_adjustment - payment_amount).round_dp(2);
                let is_fully_paid = balance_due.is_zero();

                let all_takeaway: bool = sqlx::query_scalar(
                    "SELECT COALESCE(BOOL_AND(fulfillment = 'takeaway'), true) FROM transaction_lines WHERE transaction_id = $1"
                )
                .bind(tid)
                .fetch_one(&mut *tx)
                .await?;

                let final_status = if is_fully_paid && all_takeaway {
                    crate::models::DbOrderStatus::Fulfilled
                } else {
                    crate::models::DbOrderStatus::Open
                };

                sqlx::query(
                    r#"
                    UPDATE transactions
                    SET status = $1::order_status,
                        amount_paid = $2,
                        balance_due = $3,
                        fulfilled_at = CASE WHEN $1::order_status = 'fulfilled'::order_status THEN CURRENT_TIMESTAMP ELSE NULL END
                    WHERE id = $4
                    "#
                )
                .bind(final_status)
                .bind(payment_amount)
                .bind(balance_due)
                .bind(tid)
                .execute(&mut *tx)
                .await?;

                let _ = crate::auth::pins::log_staff_access(
                    &state.db,
                    operator_id,
                    "checkout_webhook_recovery",
                    serde_json::json!({
                        "transaction_id": tid,
                        "amount_paid": payment_amount,
                        "total_price": total_price,
                    }),
                )
                .await;

                final_payment_transaction_id = Some(recovered_payment_txn_id);
            }
        }
    }

    let final_match_type = helcim_card_transaction_event_match_type(
        attempt_id,
        final_payment_transaction_id,
        match_type,
    );

    mark_helcim_event_processed(
        &mut tx,
        event_id,
        Some(&provider_transaction_id),
        attempt_id,
        final_payment_transaction_id,
        final_match_type,
        Some(&normalized_status),
    )
    .await?;
    tx.commit().await?;

    Ok(HelcimProcessingOutcome {
        updated: u64::from(attempt_id.is_some()),
        provider_transaction_id: Some(provider_transaction_id),
        payment_provider_attempt_id: attempt_id,
        payment_transaction_id: final_payment_transaction_id,
        match_type: final_match_type.to_string(),
    })
}

fn helcim_card_transaction_event_match_type(
    attempt_id: Option<Uuid>,
    payment_transaction_id: Option<Uuid>,
    fallback_match_type: &'static str,
) -> &'static str {
    if attempt_id.is_none() && payment_transaction_id.is_some() {
        "provider_transaction_id_payment"
    } else {
        fallback_match_type
    }
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
            false,
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
    mark_helcim_event_processed(&mut tx, event_id, None, attempt_id, None, match_type, None)
        .await?;
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
    allow_failed_recovery: bool,
) -> Result<Option<Uuid>, sqlx::Error> {
    let pending_candidates: Vec<Uuid> = sqlx::query_scalar(
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

    let candidates = if pending_candidates.is_empty() && allow_failed_recovery {
        sqlx::query_scalar(
            r#"
            SELECT id
            FROM payment_provider_attempts
            WHERE provider = 'helcim'
              AND status = 'failed'
              AND terminal_id = $1
              AND ($2::bigint IS NULL OR amount_cents = $2)
              AND ($3::text IS NULL OR currency = $3)
              AND created_at >= now() - ($4::bigint * interval '1 minute')
            ORDER BY created_at DESC
            LIMIT 2
            "#,
        )
        .bind(terminal_id)
        .bind(amount_cents)
        .bind(currency)
        .bind(HELCIM_WEBHOOK_FALLBACK_MAX_AGE_MINUTES)
        .fetch_all(&mut **tx)
        .await?
    } else {
        pending_candidates
    };

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
    provider_status: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE helcim_event_log
        SET processing_status = 'processed',
            error_message = NULL,
            provider_transaction_id = COALESCE($2, provider_transaction_id),
            payment_provider_attempt_id = $3,
            payment_transaction_id = $4,
            match_type = $5,
            payload_json = CASE
                WHEN $6::text IS NULL THEN payload_json
                ELSE payload_json || jsonb_build_object('_ros_provider_status', $6::text)
            END
        WHERE id = $1
        "#,
    )
    .bind(event_id)
    .bind(provider_transaction_id)
    .bind(payment_provider_attempt_id)
    .bind(payment_transaction_id)
    .bind(match_type)
    .bind(provider_status)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct FalWebhookPayload {
    request_id: String,
    status: String,
    payload: Option<serde_json::Value>,
    error: Option<String>,
}

fn extract_image_url(payload: &serde_json::Value) -> Option<String> {
    if let Some(images) = payload.get("images").and_then(|i| i.as_array()) {
        if let Some(first_image) = images.first() {
            if let Some(url) = first_image.get("url").and_then(|u| u.as_str()) {
                return Some(url.to_string());
            }
        }
    }
    if let Some(image) = payload.get("image") {
        if let Some(url) = image.get("url").and_then(|u| u.as_str()) {
            return Some(url.to_string());
        }
    }
    if let Some(url) = payload.get("url").and_then(|u| u.as_str()) {
        return Some(url.to_string());
    }
    None
}

async fn post_fal_webhook(
    State(state): State<AppState>,
    Json(payload): Json<FalWebhookPayload>,
) -> impl IntoResponse {
    let request_id = &payload.request_id;
    let status = &payload.status;

    tracing::info!(
        request_id = %request_id,
        status = %status,
        "Received Fal.ai webhook callback"
    );

    let job_row: Option<(Uuid, String, Uuid)> = match sqlx::query_as(
        r#"
        SELECT id, job_type, target_id
        FROM fal_generation_jobs
        WHERE pending_job_id = $1
        "#,
    )
    .bind(request_id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(row) => row,
        Err(e) => {
            tracing::error!(request_id = %request_id, error = %e, "Failed to look up Fal generation job");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let (job_id, job_type, target_id) = match job_row {
        Some(row) => row,
        None => {
            tracing::warn!(request_id = %request_id, "No matching Fal generation job found");
            return StatusCode::NOT_FOUND.into_response();
        }
    };

    if status == "COMPLETED" {
        let image_url = if let Some(ref p) = payload.payload {
            extract_image_url(p)
        } else {
            None
        };

        match image_url {
            Some(url) => {
                let download_payload = serde_json::json!({
                    "job_id": job_id,
                    "image_url": url,
                    "job_type": job_type,
                    "target_id": target_id
                });

                if let Ok(queue) = crate::jobs::JobQueue::from_env() {
                    let job = crate::jobs::Job::new(
                        crate::jobs::JobType::DownloadFalAsset,
                        download_payload,
                    );
                    if let Err(e) = queue.enqueue(job).await {
                        tracing::error!(job_id = %job_id, error = %e, "Failed to enqueue Fal download job");
                        let _ = sqlx::query(
                            "UPDATE fal_generation_jobs SET status = 'failed', error_message = $1 WHERE id = $2"
                        )
                        .bind(&format!("Failed to enqueue download task: {e}"))
                        .bind(job_id)
                        .execute(&state.db)
                        .await;
                    }
                } else {
                    let err = "Failed to initialize JobQueue from env";
                    tracing::error!(job_id = %job_id, error = %err);
                    let _ = sqlx::query(
                        "UPDATE fal_generation_jobs SET status = 'failed', error_message = $1 WHERE id = $2"
                    )
                    .bind(err)
                    .bind(job_id)
                    .execute(&state.db)
                    .await;
                }
            }
            None => {
                let err_msg = "Fal.ai webhook completed but no image URL was found in the payload"
                    .to_string();
                tracing::error!(job_id = %job_id, error = %err_msg);
                let _ = sqlx::query(
                    "UPDATE fal_generation_jobs SET status = 'failed', error_message = $1 WHERE id = $2"
                )
                .bind(&err_msg)
                .bind(job_id)
                .execute(&state.db)
                .await;
            }
        }
    } else {
        let err_msg = payload
            .error
            .clone()
            .unwrap_or_else(|| "Unknown Fal.ai generation failure".to_string());
        tracing::error!(job_id = %job_id, error = %err_msg, "Fal.ai job execution failed");
        let _ = sqlx::query(
            "UPDATE fal_generation_jobs SET status = 'failed', error_message = $1 WHERE id = $2",
        )
        .bind(&err_msg)
        .bind(job_id)
        .execute(&state.db)
        .await;
    }

    StatusCode::OK.into_response()
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/edge-probe", get(get_edge_probe))
        .route("/podium", post(post_podium_webhook))
        .route("/card-events", post(post_helcim_webhook))
        .route("/helcim", post(post_helcim_webhook))
        .route("/shippo", post(post_shippo_webhook))
        .route("/fal", post(post_fal_webhook))
}

pub fn integrations_router() -> Router<AppState> {
    Router::new().route("/shippo/webhook", post(post_shippo_webhook))
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
    fn helcim_webhook_secret_configured_reflects_runtime_env() {
        std::env::remove_var("HELCIM_WEBHOOK_SECRET");
        assert!(!helcim_webhook_secret_configured());

        std::env::set_var("HELCIM_WEBHOOK_SECRET", "   ");
        assert!(!helcim_webhook_secret_configured());

        std::env::set_var("HELCIM_WEBHOOK_SECRET", "configured");
        assert!(helcim_webhook_secret_configured());

        std::env::remove_var("HELCIM_WEBHOOK_SECRET");
    }

    #[test]
    fn helcim_missing_secret_is_not_successfully_acknowledged() {
        std::env::remove_var("HELCIM_WEBHOOK_SECRET");
        let body = br#"{"type":"cardTransaction","id":"123"}"#;
        let mut headers = HeaderMap::new();
        headers.insert("webhook-id", HeaderValue::from_static("evt-missing-secret"));
        headers.insert(
            "webhook-timestamp",
            HeaderValue::from_str(&Utc::now().timestamp().to_string()).unwrap(),
        );
        headers.insert("webhook-signature", HeaderValue::from_static("v1,unused"));

        let err = verify_helcim_webhook(&headers, body, Utc::now()).unwrap_err();

        assert_eq!(err, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(!err.is_success());
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
    fn helcim_card_transaction_match_type_keeps_existing_ros_payment_linked() {
        assert_eq!(
            helcim_card_transaction_event_match_type(None, Some(Uuid::new_v4()), "none",),
            "provider_transaction_id_payment"
        );
        assert_eq!(
            helcim_card_transaction_event_match_type(
                Some(Uuid::new_v4()),
                Some(Uuid::new_v4()),
                "terminal_amount",
            ),
            "terminal_amount"
        );
        assert_eq!(
            helcim_card_transaction_event_match_type(None, None, "none"),
            "none"
        );
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
