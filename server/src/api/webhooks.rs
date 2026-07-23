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
const HELCIM_WEBHOOK_PROCESSING_LEASE_SECONDS: i64 = 180;
const HELCIM_WEBHOOK_PROCESSING_TIMEOUT_SECONDS: u64 = 150;
const HELCIM_WEBHOOK_PROCESSING_CLAIM_KEY: &str = "__ros_internal_helcim_processing_claim_v1";
const HELCIM_WEBHOOK_PROCESSING_CLAIM_OWNER: &str = "riverside-os-helcim-webhook-v1";
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
    payload_hash: String,
    claimed: bool,
    reclaimed: bool,
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

fn helcim_payload_without_processing_claim(mut payload: Value) -> Value {
    if let Value::Object(object) = &mut payload {
        object.remove(HELCIM_WEBHOOK_PROCESSING_CLAIM_KEY);
    }
    payload
}

fn helcim_payload_uses_reserved_processing_claim(payload: &Value) -> bool {
    payload.get(HELCIM_WEBHOOK_PROCESSING_CLAIM_KEY).is_some()
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HelcimEventDisposition {
    Process,
    DuplicateFinal,
    Processing,
    Retry,
}

fn helcim_event_disposition(event: &HelcimEventLogRow) -> HelcimEventDisposition {
    if event.claimed {
        HelcimEventDisposition::Process
    } else if helcim_event_is_final(&event.processing_status) {
        HelcimEventDisposition::DuplicateFinal
    } else if event.processing_status == "received" {
        HelcimEventDisposition::Processing
    } else {
        HelcimEventDisposition::Retry
    }
}

fn helcim_active_processing_status() -> StatusCode {
    StatusCode::SERVICE_UNAVAILABLE
}

#[cfg(test)]
fn helcim_processing_claim_is_eligible(
    processing_status: &str,
    claimed_at_epoch: Option<i64>,
    received_at_epoch: i64,
    now_epoch: i64,
) -> bool {
    processing_status == "failed"
        || (processing_status == "received"
            && claimed_at_epoch.unwrap_or(received_at_epoch)
                <= now_epoch - HELCIM_WEBHOOK_PROCESSING_LEASE_SECONDS)
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
    if helcim_payload_uses_reserved_processing_claim(payload) {
        return Err(sqlx::Error::Protocol(
            "Helcim payload uses a reserved ROS processing field".to_string(),
        ));
    }
    let payload_hash = helcim_payload_hash(body);
    // The conflict update is the processing lease. PostgreSQL locks the unique
    // webhook row while evaluating this predicate, so exactly one delivery can
    // claim a failed event or a received event whose prior worker exceeded the
    // bounded processing window. Final events and active leases remain no-ops.
    let claimed = sqlx::query_as::<_, HelcimEventLogRow>(
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
        VALUES (
            'helcim',
            $1,
            $2,
            $3,
            TRUE,
            $4,
            $5::jsonb || jsonb_build_object(
                $7::text,
                jsonb_build_object(
                    'claimed_at_epoch', EXTRACT(EPOCH FROM now())::bigint,
                    'owner', $8::text
                )
            ),
            'received'
        )
        ON CONFLICT (webhook_id) WHERE webhook_id IS NOT NULL DO UPDATE
        SET processing_status = 'received',
            error_message = NULL,
            payload_json = helcim_event_log.payload_json || jsonb_build_object(
                $7::text,
                jsonb_build_object(
                    'claimed_at_epoch', EXTRACT(EPOCH FROM now())::bigint,
                    'owner', $8::text
                )
            )
        WHERE helcim_event_log.payload_hash = EXCLUDED.payload_hash
          AND (
              NOT (helcim_event_log.payload_json ? ($7::text))
              OR helcim_event_log.payload_json
                    -> ($7::text) ->> 'owner' = $8::text
          )
          AND (
              helcim_event_log.processing_status = 'failed'
              OR (
                  helcim_event_log.processing_status = 'received'
                  AND COALESCE(
                      CASE
                          WHEN jsonb_typeof(
                              helcim_event_log.payload_json
                                  -> ($7::text) -> 'claimed_at_epoch'
                          ) = 'number'
                          THEN (
                              helcim_event_log.payload_json
                                  -> ($7::text) ->> 'claimed_at_epoch'
                          )::numeric
                      END,
                      EXTRACT(EPOCH FROM helcim_event_log.received_at)
                  ) <= EXTRACT(EPOCH FROM now()) - $6::bigint
              )
          )
        RETURNING
            id,
            processing_status,
            payload_hash,
            TRUE AS claimed,
            (xmax <> 0) AS reclaimed
        "#,
    )
    .bind(&verification.webhook_id)
    .bind(event_type)
    .bind(verification.webhook_timestamp)
    .bind(&payload_hash)
    .bind(helcim::redact_provider_payload(payload))
    .bind(HELCIM_WEBHOOK_PROCESSING_LEASE_SECONDS)
    .bind(HELCIM_WEBHOOK_PROCESSING_CLAIM_KEY)
    .bind(HELCIM_WEBHOOK_PROCESSING_CLAIM_OWNER)
    .fetch_optional(db)
    .await?;

    if let Some(event) = claimed {
        return Ok(event);
    }

    // ON CONFLICT ... DO UPDATE ... WHERE returns no row when an active or
    // final event is deliberately left untouched. Fetch it in a new statement
    // so a concurrent inserter's committed row is visible under READ COMMITTED.
    sqlx::query_as::<_, HelcimEventLogRow>(
        r#"
        SELECT
            id,
            processing_status,
            payload_hash,
            FALSE AS claimed,
            FALSE AS reclaimed
        FROM helcim_event_log
        WHERE webhook_id = $1
          AND provider = 'helcim'
        "#,
    )
    .bind(&verification.webhook_id)
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
            error_message = $2,
            payload_json = payload_json - $3::text
        WHERE id = $1
          AND processing_status = 'received'
        "#,
    )
    .bind(event_id)
    .bind(error_message)
    .bind(HELCIM_WEBHOOK_PROCESSING_CLAIM_KEY)
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
            match_type = 'none',
            payload_json = payload_json - $2::text
        WHERE id = $1
        "#,
    )
    .bind(event_id)
    .bind(HELCIM_WEBHOOK_PROCESSING_CLAIM_KEY)
    .execute(db)
    .await?;
    tracing::debug!(target = "helcim_webhook", event_type = %event_type, "stored unhandled Helcim event");
    Ok(())
}

async fn run_helcim_webhook_processing<F>(
    processing: F,
) -> Result<HelcimProcessingOutcome, sqlx::Error>
where
    F: std::future::Future<Output = Result<HelcimProcessingOutcome, sqlx::Error>>,
{
    tokio::time::timeout(
        std::time::Duration::from_secs(HELCIM_WEBHOOK_PROCESSING_TIMEOUT_SECONDS),
        processing,
    )
    .await
    .map_err(|_| {
        sqlx::Error::Protocol(format!(
            "Helcim webhook processing exceeded {HELCIM_WEBHOOK_PROCESSING_TIMEOUT_SECONDS} seconds"
        ))
    })?
}

pub async fn replay_helcim_event(
    state: &AppState,
    event_id: Uuid,
) -> Result<HelcimReplayOutcome, sqlx::Error> {
    let row: Option<(String, Value)> = sqlx::query_as(
        r#"
        UPDATE helcim_event_log
        SET processing_status = 'received',
            error_message = NULL,
            payload_json = payload_json || jsonb_build_object(
                $2::text,
                jsonb_build_object(
                    'claimed_at_epoch', EXTRACT(EPOCH FROM now())::bigint,
                    'owner', $3::text
                )
            )
        WHERE id = $1
          AND provider = 'helcim'
          AND processing_status = 'failed'
          AND NOT (payload_json ? ($2::text))
        RETURNING event_type, payload_json - $2::text
        "#,
    )
    .bind(event_id)
    .bind(HELCIM_WEBHOOK_PROCESSING_CLAIM_KEY)
    .bind(HELCIM_WEBHOOK_PROCESSING_CLAIM_OWNER)
    .fetch_optional(&state.db)
    .await?;
    let Some((event_type, value)) = row else {
        let current_status: Option<String> = sqlx::query_scalar(
            "SELECT processing_status FROM helcim_event_log WHERE id = $1 AND provider = 'helcim'",
        )
        .bind(event_id)
        .fetch_optional(&state.db)
        .await?;
        return match current_status {
            Some(_) => Err(sqlx::Error::Protocol(
                "Only failed Helcim events can be replayed.".to_string(),
            )),
            None => Err(sqlx::Error::RowNotFound),
        };
    };
    let value = helcim_payload_without_processing_claim(value);

    match helcim_webhook_action(&event_type) {
        HelcimWebhookAction::CardTransaction => {
            let Some(transaction_id) = helcim_webhook_event_id(&value) else {
                let message = "missing Helcim transaction id";
                let _ = mark_helcim_event_failed(&state.db, event_id, message).await;
                return Err(sqlx::Error::Protocol(message.to_string()));
            };
            match run_helcim_webhook_processing(handle_helcim_card_transaction(
                state,
                event_id,
                &transaction_id,
                &value,
            ))
            .await
            {
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
            match run_helcim_webhook_processing(handle_helcim_terminal_cancel(
                state, event_id, &value,
            ))
            .await
            {
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

    let incoming_payload_hash = helcim_payload_hash(body.as_ref());
    if event.payload_hash != incoming_payload_hash {
        tracing::warn!(
            target = "helcim_webhook",
            event_id = %event.id,
            webhook_id = %verification.webhook_id,
            "refusing Helcim webhook id reused with a different payload"
        );
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "ok": false,
                "error": "webhook id payload mismatch",
            })),
        )
            .into_response();
    }

    match helcim_event_disposition(&event) {
        HelcimEventDisposition::Process => {
            if event.reclaimed {
                tracing::info!(
                    target = "helcim_webhook",
                    event_id = %event.id,
                    webhook_id = %verification.webhook_id,
                    "reclaimed Helcim webhook for processing"
                );
            }
        }
        HelcimEventDisposition::DuplicateFinal => {
            return Json(json!({
                "ok": true,
                "duplicate": true,
                "processing_status": event.processing_status,
            }))
            .into_response();
        }
        HelcimEventDisposition::Processing => {
            // Do not positively acknowledge an in-flight delivery. If the
            // original worker disappeared, Helcim must retain its retry chain
            // long enough for the bounded lease to become reclaimable.
            return (
                helcim_active_processing_status(),
                Json(json!({
                    "ok": false,
                    "retry": true,
                    "processing_status": event.processing_status,
                })),
            )
                .into_response();
        }
        HelcimEventDisposition::Retry => {
            tracing::error!(
                target = "helcim_webhook",
                event_id = %event.id,
                processing_status = %event.processing_status,
                "Helcim webhook was not claimed from a retryable state"
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    match helcim_webhook_action(event_type) {
        HelcimWebhookAction::CardTransaction => {
            let Some(transaction_id) = helcim_webhook_event_id(&value) else {
                let _ =
                    mark_helcim_event_failed(&state.db, event.id, "missing Helcim transaction id")
                        .await;
                return StatusCode::BAD_REQUEST.into_response();
            };
            match run_helcim_webhook_processing(handle_helcim_card_transaction(
                &state,
                event.id,
                &transaction_id,
                &value,
            ))
            .await
            {
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
            match run_helcim_webhook_processing(handle_helcim_terminal_cancel(
                &state, event.id, &value,
            ))
            .await
            {
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

fn helcim_attempt_reference_is_return(raw_audit_reference: Option<&str>) -> bool {
    raw_audit_reference.is_some_and(|reference| {
        let normalized = reference.to_ascii_lowercase();
        normalized.contains("refund") || normalized.contains("reverse")
    })
}

fn helcim_provider_transaction_is_return(transaction_type: Option<&str>) -> Option<bool> {
    match transaction_type
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "purchase" | "sale" => Some(false),
        "refund" | "return" | "reverse" | "reversal" => Some(true),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HelcimRosInvoiceCorrelation {
    None,
    Attempt(Uuid),
    Invalid,
}

fn helcim_ros_invoice_correlation(invoice_number: Option<&str>) -> HelcimRosInvoiceCorrelation {
    let Some(invoice_number) = invoice_number
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return HelcimRosInvoiceCorrelation::None;
    };
    let Some(attempt_id) = invoice_number.strip_prefix("ROS-") else {
        return HelcimRosInvoiceCorrelation::None;
    };
    if attempt_id.len() != 32 || !attempt_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return HelcimRosInvoiceCorrelation::Invalid;
    }
    Uuid::parse_str(attempt_id)
        .map(HelcimRosInvoiceCorrelation::Attempt)
        .unwrap_or(HelcimRosInvoiceCorrelation::Invalid)
}

fn helcim_webhook_transaction_id_mismatch(
    requested_transaction_id: &str,
    fetched_transaction_id: Option<&str>,
) -> Option<String> {
    let requested_transaction_id = requested_transaction_id.trim();
    let Some(fetched_transaction_id) = fetched_transaction_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Some(
            "Helcim did not return the transaction ID requested by this webhook; automatic ledger binding was blocked."
                .to_string(),
        );
    };
    (fetched_transaction_id != requested_transaction_id).then(|| {
        "Helcim returned a transaction ID different from the webhook request; automatic ledger binding was blocked."
            .to_string()
    })
}

fn helcim_provider_result_mismatch_evidence(
    expected_amount_cents: i64,
    expected_currency: &str,
    expected_return: bool,
    provider_amount_cents: i64,
    provider_currency: Option<&str>,
    provider_transaction_type: Option<&str>,
) -> Option<String> {
    let mut mismatches = Vec::new();
    if expected_amount_cents.unsigned_abs() != provider_amount_cents.unsigned_abs() {
        mismatches.push(format!(
            "absolute amount expected {} cents but provider returned {} cents",
            expected_amount_cents.unsigned_abs(),
            provider_amount_cents.unsigned_abs()
        ));
    }

    let currency_matches = provider_currency.is_some_and(|currency| {
        currency
            .trim()
            .eq_ignore_ascii_case(expected_currency.trim())
    });
    if !currency_matches {
        mismatches.push(format!(
            "currency did not equal {}",
            expected_currency.trim().to_ascii_lowercase()
        ));
    }

    let provider_return = helcim_provider_transaction_is_return(provider_transaction_type);
    if provider_return != Some(expected_return) {
        let expected = if expected_return {
            "return"
        } else {
            "purchase"
        };
        let actual = match provider_return {
            Some(true) => "return",
            Some(false) => "purchase",
            None => "unknown",
        };
        mismatches.push(format!(
            "transaction purpose expected {expected} but provider returned {actual}"
        ));
    }

    (!mismatches.is_empty()).then(|| {
        format!(
            "Helcim provider result did not match ROS attempt evidence: {}. Automatic ledger binding was blocked.",
            mismatches.join("; ")
        )
    })
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
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    let provider_transaction_type = transaction.transaction_type();
    let normalized_status = transaction.normalized_status();
    let fetched_provider_transaction_id = transaction
        .transaction_id_string()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let transaction_id_mismatch = helcim_webhook_transaction_id_mismatch(
        transaction_id,
        fetched_provider_transaction_id.as_deref(),
    );
    let provider_transaction_id = fetched_provider_transaction_id
        .clone()
        .unwrap_or_else(|| transaction_id.trim().to_string());
    let invoice_number = transaction
        .invoice_number
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let audit_reference = transaction
        .audit_reference()
        .unwrap_or_else(|| format!("helcim:cardTransaction:{provider_transaction_id}"));
    let provider_status = transaction.provider_status();
    let provider_warning = transaction.warning.clone();
    let terminal_id = helcim_webhook_device_code(value).unwrap_or_default();

    let mut tx = state.db.begin().await?;
    let mut match_type = "provider_transaction_id";
    let provider_ids = vec![transaction_id_mismatch
        .as_ref()
        .map(|_| transaction_id.trim().to_string())
        .unwrap_or_else(|| provider_transaction_id.clone())];
    let mut direct_candidates: Vec<(
        Uuid,
        Option<Uuid>,
        i64,
        String,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        r#"
        SELECT id, checkout_client_id, amount_cents, currency, raw_audit_reference,
               provider_payment_id
        FROM payment_provider_attempts
        WHERE provider = 'helcim'
          AND (
              (
                  (
                      LOWER(COALESCE(raw_audit_reference, '')) LIKE '%refund%'
                      OR LOWER(COALESCE(raw_audit_reference, '')) LIKE '%reverse%'
                  )
                  AND provider_payment_id = ANY($1::text[])
              )
              OR (
                  LOWER(COALESCE(raw_audit_reference, '')) NOT LIKE '%refund%'
                  AND LOWER(COALESCE(raw_audit_reference, '')) NOT LIKE '%reverse%'
                  AND provider_transaction_id = ANY($1::text[])
              )
          )
        ORDER BY created_at ASC
        FOR UPDATE
        "#,
    )
    .bind(&provider_ids)
    .fetch_all(&mut *tx)
    .await?;

    let mut correlation_mismatch = transaction_id_mismatch;
    if correlation_mismatch.is_none() {
        match helcim_ros_invoice_correlation(invoice_number.as_deref()) {
            HelcimRosInvoiceCorrelation::None => {}
            HelcimRosInvoiceCorrelation::Invalid => {
                correlation_mismatch = Some(
                    "Helcim returned malformed ROS invoice correlation; automatic ledger binding was blocked."
                        .to_string(),
                );
            }
            HelcimRosInvoiceCorrelation::Attempt(invoice_attempt_id) => {
                if !direct_candidates.is_empty() {
                    if direct_candidates.len() != 1 || direct_candidates[0].0 != invoice_attempt_id
                    {
                        correlation_mismatch = Some(
                            "Helcim provider transaction and ROS invoice correlation identified different payment attempts; automatic ledger binding was blocked."
                                .to_string(),
                        );
                    }
                } else {
                    let invoice_candidate: Option<(
                        Uuid,
                        Option<Uuid>,
                        i64,
                        String,
                        Option<String>,
                        Option<String>,
                    )> = sqlx::query_as(
                        r#"
                    SELECT id, checkout_client_id, amount_cents, currency, raw_audit_reference,
                           provider_payment_id
                    FROM payment_provider_attempts
                    WHERE id = $1
                      AND provider = 'helcim'
                      AND (
                          status = 'pending'
                          OR (status = 'failed' AND error_code = 'outcome_unknown')
                      )
                      AND LOWER(COALESCE(raw_audit_reference, '')) NOT LIKE '%refund%'
                      AND LOWER(COALESCE(raw_audit_reference, '')) NOT LIKE '%reverse%'
                      AND NULLIF(TRIM(COALESCE(terminal_id, device_id, '')), '') IS NOT NULL
                      AND ($2 = '' OR terminal_id = $2 OR device_id = $2)
                    FOR UPDATE
                    "#,
                    )
                    .bind(invoice_attempt_id)
                    .bind(&terminal_id)
                    .fetch_optional(&mut *tx)
                    .await?;

                    if let Some(candidate) = invoice_candidate {
                        direct_candidates.push(candidate);
                        match_type = "ros_invoice";
                    } else {
                        correlation_mismatch = Some(
                            "Helcim ROS invoice correlation did not resolve to the matching active terminal purchase attempt; automatic ledger binding was blocked."
                                .to_string(),
                        );
                    }
                }
            }
        }
    }

    let evidence_mismatch = match direct_candidates.as_slice() {
        [] => None,
        [(_, _, expected_amount_cents, expected_currency, raw_audit_reference, _)] => {
            helcim_provider_result_mismatch_evidence(
                *expected_amount_cents,
                expected_currency,
                helcim_attempt_reference_is_return(raw_audit_reference.as_deref()),
                amount_cents,
                currency.as_deref(),
                provider_transaction_type.as_deref(),
            )
        }
        candidates => Some(format!(
            "Helcim provider identifiers matched {} ROS payment attempts; automatic ledger binding was blocked.",
            candidates.len()
        )),
    };
    let direct_mismatch = correlation_mismatch.or(evidence_mismatch);

    if let Some(error_message) = direct_mismatch {
        let candidate_ids: Vec<Uuid> = direct_candidates
            .iter()
            .map(|candidate| candidate.0)
            .collect();
        sqlx::query(
            r#"
            UPDATE payment_provider_attempts
            SET status = CASE
                    WHEN $3 IN ('approved', 'captured') THEN $3
                    WHEN status IN ('approved', 'captured') THEN status
                    ELSE 'pending'
                END,
                error_code = 'provider_result_mismatch',
                error_message = $2,
                completed_at = CASE
                    WHEN $3 IN ('approved', 'captured') THEN now()
                    WHEN status IN ('approved', 'captured') THEN completed_at
                    ELSE NULL
                END
            WHERE id = ANY($1::uuid[])
            "#,
        )
        .bind(&candidate_ids)
        .bind(&error_message)
        .bind(&normalized_status)
        .execute(&mut *tx)
        .await?;

        let mismatch_attempt_id = if candidate_ids.len() == 1 {
            Some(candidate_ids[0])
        } else {
            None
        };
        tracing::error!(
            target = "helcim_webhook",
            provider_transaction_id,
            candidate_count = candidate_ids.len(),
            evidence = %error_message,
            "blocked Helcim webhook result whose provider evidence did not match its ROS attempt"
        );
        mark_helcim_event_processed(
            &mut tx,
            event_id,
            Some(&provider_transaction_id),
            mismatch_attempt_id,
            None,
            "provider_result_mismatch",
            provider_status.as_deref(),
        )
        .await?;
        sqlx::query("UPDATE helcim_event_log SET error_message = $2 WHERE id = $1")
            .bind(event_id)
            .bind(&error_message)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(HelcimProcessingOutcome {
            updated: candidate_ids.len() as u64,
            provider_transaction_id: Some(provider_transaction_id),
            payment_provider_attempt_id: mismatch_attempt_id,
            payment_transaction_id: None,
            match_type: "provider_result_mismatch".to_string(),
        });
    }

    let mut matched_attempt_is_return = false;
    let mut attempt_row: Option<(Uuid, Option<Uuid>)> = None;
    let mut provider_payment_id: Option<String> = None;
    if let Some(candidate) = direct_candidates.first() {
        matched_attempt_is_return = helcim_attempt_reference_is_return(candidate.4.as_deref());
        let updated: Option<(Uuid, Option<Uuid>, Option<String>)> = sqlx::query_as(
            r#"
            UPDATE payment_provider_attempts
            SET status = $1,
                provider_transaction_id = CASE WHEN $6 THEN provider_transaction_id ELSE $2 END,
                provider_payment_id = CASE WHEN $6 THEN $2 ELSE provider_payment_id END,
                raw_audit_reference = CASE WHEN $6 THEN raw_audit_reference ELSE $3 END,
                error_code = CASE WHEN $1 = 'failed' THEN COALESCE($4, 'declined') ELSE NULL END,
                error_message = CASE WHEN $1 = 'failed' THEN COALESCE($5, 'Helcim payment was declined.') ELSE NULL END,
                completed_at = now()
            WHERE id = $7
            RETURNING id, checkout_client_id, provider_payment_id
            "#,
        )
        .bind(&normalized_status)
        .bind(&provider_transaction_id)
        .bind(&audit_reference)
        .bind(provider_status.clone())
        .bind(provider_warning.clone())
        .bind(matched_attempt_is_return)
        .bind(candidate.0)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some((id, checkout_client_id, stored_provider_payment_id)) = updated {
            attempt_row = Some((id, checkout_client_id));
            provider_payment_id = stored_provider_payment_id;
        }
    }

    // Helcim's cardTransaction webhook does not document a device code. A
    // terminal+amount fallback without one would search every ROS terminal and
    // could bind an unrelated Helcim payment. New ROS Hardware requests carry
    // the strict ROS invoice correlation above, so leave an event unmatched
    // unless the webhook actually supplies authoritative terminal evidence.
    if direct_candidates.is_empty() && !terminal_id.is_empty() {
        match_type = "terminal_amount";
        let provider_is_purchase =
            helcim_provider_transaction_is_return(provider_transaction_type.as_deref())
                == Some(false);
        if let Some(provider_currency) = currency.as_deref().filter(|_| provider_is_purchase) {
            if let Some(candidate_id) = find_safe_helcim_terminal_fallback_candidate(
                &mut tx,
                &terminal_id,
                Some(amount_cents),
                Some(provider_currency),
                matches!(normalized_status.as_str(), "approved" | "captured"),
                true,
            )
            .await?
            {
                let updated: Option<(Uuid, Option<Uuid>, Option<String>)> = sqlx::query_as(
                    r#"
                    UPDATE payment_provider_attempts
                    SET status = $1,
                        provider_transaction_id = $2,
                        raw_audit_reference = $3,
                        error_code = CASE WHEN $1 = 'failed' THEN COALESCE($4, 'declined') ELSE NULL END,
                        error_message = CASE WHEN $1 = 'failed' THEN COALESCE($5, 'Helcim payment was declined.') ELSE NULL END,
                        completed_at = now()
                    WHERE id = $6
                    RETURNING id, checkout_client_id, provider_payment_id
                    "#,
                )
                .bind(&normalized_status)
                .bind(&provider_transaction_id)
                .bind(&audit_reference)
                .bind(provider_status.clone())
                .bind(provider_warning.clone())
                .bind(candidate_id)
                .fetch_optional(&mut *tx)
                .await?;
                if let Some((id, checkout_client_id, stored_provider_payment_id)) = updated {
                    attempt_row = Some((id, checkout_client_id));
                    provider_payment_id = stored_provider_payment_id;
                }
            }
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

    if !matched_attempt_is_return
        && (normalized_status == "approved" || normalized_status == "captured")
        && final_payment_transaction_id.is_none()
    {
        if let Some(client_id) = checkout_client_id {
            let txn: Option<(Uuid, String, Decimal, Decimal, Uuid, String)> = sqlx::query_as(
                "SELECT id, display_id, total_price, rounding_adjustment, operator_id, status FROM transactions WHERE checkout_client_id = $1 ORDER BY created_at DESC LIMIT 1"
            )
            .bind(client_id)
            .fetch_optional(&mut *tx)
            .await?;

            if let Some((
                tid,
                display_id,
                total_price,
                rounding_adjustment,
                operator_id,
                txn_status,
            )) = txn
            {
                let payment_txn_id = Uuid::new_v4();
                let payment_amount = Decimal::from(amount_cents) / Decimal::from(100);

                // If staff recorded the approved terminal payment as Manual
                // Card after the checkout disappeared, convert that exact
                // allocated payment instead of creating a duplicate movement.
                let manual_payment_ids: Vec<Uuid> = sqlx::query_scalar(
                    r#"
                    SELECT pt.id
                    FROM payment_transactions pt
                    WHERE pt.payment_method = 'card_manual'
                      AND pt.amount = $1
                      AND (
                          pt.metadata->>'checkout_transaction_id' = $2
                          OR pt.metadata->>'checkout_display_id' = $3
                      )
                      AND EXISTS (
                          SELECT 1
                          FROM payment_allocations pa
                          WHERE pa.transaction_id = pt.id
                      )
                    ORDER BY pt.created_at DESC
                    LIMIT 2
                    "#,
                )
                .bind(payment_amount)
                .bind(tid.to_string())
                .bind(&display_id)
                .fetch_all(&mut *tx)
                .await?;

                if manual_payment_ids.len() == 1 {
                    let manual_payment_id = manual_payment_ids[0];
                    sqlx::query(
                        r#"
                        UPDATE payment_transactions
                        SET payment_method = 'card_terminal',
                            status = 'approved',
                            payment_provider = 'helcim',
                            provider_payment_id = $2,
                            provider_transaction_id = $3,
                            provider_status = $4,
                            metadata = (
                                COALESCE(metadata, '{}'::jsonb)
                                - ARRAY['card_last4', 'offline_card_entry_type']::text[]
                            ) || $5::jsonb
                        WHERE id = $1
                        "#,
                    )
                    .bind(manual_payment_id)
                    .bind(&provider_payment_id)
                    .bind(&provider_transaction_id)
                    .bind(provider_status.clone())
                    .bind(serde_json::json!({
                        "payment_provider_attempt_id": attempt_id,
                        "helcim_transaction_id": provider_transaction_id.clone(),
                        "helcim_payment_id": provider_payment_id.clone(),
                        "audit_reference": audit_reference.clone(),
                        "manual_card_replaced": true,
                    }))
                    .execute(&mut *tx)
                    .await?;
                    sqlx::query(
                        r#"
                        UPDATE payment_allocations
                        SET metadata = (
                                COALESCE(metadata, '{}'::jsonb)
                                - ARRAY['card_last4', 'offline_card_entry_type']::text[]
                            ) || $2::jsonb
                        WHERE transaction_id = $1
                        "#,
                    )
                    .bind(manual_payment_id)
                    .bind(serde_json::json!({
                        "tender_family": "credit_card",
                        "payment_provider_attempt_id": attempt_id,
                        "helcim_transaction_id": provider_transaction_id.clone(),
                        "helcim_payment_id": provider_payment_id.clone(),
                        "manual_card_replaced": true,
                    }))
                    .execute(&mut *tx)
                    .await?;
                    final_payment_transaction_id = Some(manual_payment_id);
                    match_type = "manual_card_replaced";
                }

                if final_payment_transaction_id.is_some() {
                    // The existing payment allocation already identifies the
                    // completed sale; do not create a second payment row.
                    mark_helcim_event_processed(
                        &mut tx,
                        event_id,
                        Some(&provider_transaction_id),
                        attempt_id,
                        final_payment_transaction_id,
                        match_type,
                        provider_status.as_deref(),
                    )
                    .await?;
                    tx.commit().await?;
                    return Ok(HelcimProcessingOutcome {
                        updated: 1,
                        provider_transaction_id: Some(provider_transaction_id),
                        payment_provider_attempt_id: attempt_id,
                        payment_transaction_id: final_payment_transaction_id,
                        match_type: match_type.to_string(),
                    });
                }

                if txn_status != "processing" {
                    mark_helcim_event_processed(
                        &mut tx,
                        event_id,
                        Some(&provider_transaction_id),
                        attempt_id,
                        None,
                        "completed_sale_without_manual_payment",
                        provider_status.as_deref(),
                    )
                    .await?;
                    tx.commit().await?;
                    return Ok(HelcimProcessingOutcome {
                        updated: 1,
                        provider_transaction_id: Some(provider_transaction_id),
                        payment_provider_attempt_id: attempt_id,
                        payment_transaction_id: None,
                        match_type: "completed_sale_without_manual_payment".to_string(),
                    });
                }

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
    purchase_result_only: bool,
) -> Result<Option<Uuid>, sqlx::Error> {
    let pending_candidates: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM payment_provider_attempts
        WHERE provider = 'helcim'
          AND status = 'pending'
          AND ($1 = '' OR terminal_id = $1 OR device_id = $1)
          AND ($2::bigint IS NULL OR amount_cents = $2)
          AND ($3::text IS NULL OR currency = $3)
          AND created_at >= now() - ($4::bigint * interval '1 minute')
          AND (
              NOT $5
              OR (
                  LOWER(COALESCE(raw_audit_reference, '')) NOT LIKE '%refund%'
                  AND LOWER(COALESCE(raw_audit_reference, '')) NOT LIKE '%reverse%'
                  AND LOWER(COALESCE(raw_audit_reference, '')) NOT LIKE 'helcim-pay-js%'
                  AND LOWER(COALESCE(raw_audit_reference, '')) NOT LIKE '%cardtoken%'
                  AND NULLIF(TRIM(COALESCE(terminal_id, device_id, '')), '') IS NOT NULL
                  AND NULLIF(TRIM(COALESCE(provider_transaction_id, '')), '') IS NULL
              )
          )
        ORDER BY created_at ASC
        LIMIT 2
        "#,
    )
    .bind(terminal_id)
    .bind(amount_cents)
    .bind(currency)
    .bind(HELCIM_WEBHOOK_FALLBACK_MAX_AGE_MINUTES)
    .bind(purchase_result_only)
    .fetch_all(&mut **tx)
    .await?;

    let candidates = if pending_candidates.is_empty() && allow_failed_recovery {
        sqlx::query_scalar(
            r#"
            SELECT id
            FROM payment_provider_attempts
            WHERE provider = 'helcim'
              AND status = 'failed'
              AND ($1 = '' OR terminal_id = $1 OR device_id = $1)
              AND ($2::bigint IS NULL OR amount_cents = $2)
              AND ($3::text IS NULL OR currency = $3)
              AND created_at >= now() - ($4::bigint * interval '1 minute')
              AND (
                  NOT $5
                  OR (
                      error_code IN ('outcome_unknown', 'terminal_pending_timeout')
                      AND LOWER(COALESCE(raw_audit_reference, '')) NOT LIKE '%refund%'
                      AND LOWER(COALESCE(raw_audit_reference, '')) NOT LIKE '%reverse%'
                      AND LOWER(COALESCE(raw_audit_reference, '')) NOT LIKE 'helcim-pay-js%'
                      AND LOWER(COALESCE(raw_audit_reference, '')) NOT LIKE '%cardtoken%'
                      AND NULLIF(TRIM(COALESCE(terminal_id, device_id, '')), '') IS NOT NULL
                      AND NULLIF(TRIM(COALESCE(provider_transaction_id, '')), '') IS NULL
                  )
              )
            ORDER BY created_at DESC
            LIMIT 2
            "#,
        )
        .bind(terminal_id)
        .bind(amount_cents)
        .bind(currency)
        .bind(HELCIM_WEBHOOK_FALLBACK_MAX_AGE_MINUTES)
        .bind(purchase_result_only)
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
                WHEN $6::text IS NULL THEN payload_json - $7::text
                ELSE (payload_json - $7::text)
                    || jsonb_build_object('_ros_provider_status', $6::text)
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
    .bind(HELCIM_WEBHOOK_PROCESSING_CLAIM_KEY)
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
    fn helcim_claimed_events_enter_processing_path() {
        let new_event = HelcimEventLogRow {
            id: Uuid::new_v4(),
            processing_status: "received".to_string(),
            payload_hash: "hash".to_string(),
            claimed: true,
            reclaimed: false,
        };
        let duplicate_in_flight = HelcimEventLogRow {
            id: Uuid::new_v4(),
            processing_status: "received".to_string(),
            payload_hash: "hash".to_string(),
            claimed: false,
            reclaimed: false,
        };
        let reclaimed_failed = HelcimEventLogRow {
            id: Uuid::new_v4(),
            processing_status: "received".to_string(),
            payload_hash: "hash".to_string(),
            claimed: true,
            reclaimed: true,
        };
        let duplicate_processed = HelcimEventLogRow {
            id: Uuid::new_v4(),
            processing_status: "processed".to_string(),
            payload_hash: "hash".to_string(),
            claimed: false,
            reclaimed: false,
        };
        let duplicate_ignored = HelcimEventLogRow {
            id: Uuid::new_v4(),
            processing_status: "ignored".to_string(),
            payload_hash: "hash".to_string(),
            claimed: false,
            reclaimed: false,
        };
        let unclaimed_failed = HelcimEventLogRow {
            id: Uuid::new_v4(),
            processing_status: "failed".to_string(),
            payload_hash: "hash".to_string(),
            claimed: false,
            reclaimed: false,
        };

        assert_eq!(
            helcim_event_disposition(&new_event),
            HelcimEventDisposition::Process
        );
        assert_eq!(
            helcim_event_disposition(&duplicate_in_flight),
            HelcimEventDisposition::Processing
        );
        assert_eq!(
            helcim_event_disposition(&reclaimed_failed),
            HelcimEventDisposition::Process
        );
        assert_eq!(
            helcim_event_disposition(&duplicate_processed),
            HelcimEventDisposition::DuplicateFinal
        );
        assert_eq!(
            helcim_event_disposition(&duplicate_ignored),
            HelcimEventDisposition::DuplicateFinal
        );
        assert_eq!(
            helcim_event_disposition(&unclaimed_failed),
            HelcimEventDisposition::Retry
        );
    }

    #[test]
    fn helcim_processing_timeout_expires_before_lease() {
        assert!(
            HELCIM_WEBHOOK_PROCESSING_TIMEOUT_SECONDS
                < HELCIM_WEBHOOK_PROCESSING_LEASE_SECONDS as u64
        );
    }

    #[test]
    fn helcim_failed_event_is_immediately_reclaimable() {
        assert!(helcim_processing_claim_is_eligible(
            "failed",
            Some(1_000),
            1_000,
            1_001,
        ));
    }

    #[test]
    fn helcim_stale_received_event_is_reclaimable_after_lease() {
        let now = 10_000;
        assert!(helcim_processing_claim_is_eligible(
            "received",
            Some(now - HELCIM_WEBHOOK_PROCESSING_LEASE_SECONDS),
            now - HELCIM_WEBHOOK_PROCESSING_LEASE_SECONDS,
            now,
        ));
        assert!(!helcim_processing_claim_is_eligible(
            "received",
            Some(now - HELCIM_WEBHOOK_PROCESSING_LEASE_SECONDS + 1),
            now - HELCIM_WEBHOOK_PROCESSING_LEASE_SECONDS,
            now,
        ));
    }

    #[test]
    fn helcim_active_processing_lease_returns_retryable_status() {
        assert_eq!(
            helcim_active_processing_status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[test]
    fn helcim_processing_claim_is_internal_and_removed_before_business_parsing() {
        let payload = json!({
            "type": "cardTransaction",
            "id": "123",
            (HELCIM_WEBHOOK_PROCESSING_CLAIM_KEY): {
                "claimed_at_epoch": 1_000,
                "owner": HELCIM_WEBHOOK_PROCESSING_CLAIM_OWNER,
            },
        });

        assert!(helcim_payload_uses_reserved_processing_claim(&payload));
        let cleaned = helcim_payload_without_processing_claim(payload);
        assert!(!helcim_payload_uses_reserved_processing_claim(&cleaned));
        assert_eq!(helcim_webhook_event_id(&cleaned).as_deref(), Some("123"));
        assert_eq!(cleaned["type"], "cardTransaction");
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
    fn helcim_provider_evidence_accepts_exact_purchase_and_return_results() {
        assert_eq!(
            helcim_provider_result_mismatch_evidence(
                1_234,
                "usd",
                false,
                -1_234,
                Some("USD"),
                Some("purchase"),
            ),
            None
        );
        assert_eq!(
            helcim_provider_result_mismatch_evidence(
                1_234,
                "usd",
                true,
                -1_234,
                Some("usd"),
                Some("refund"),
            ),
            None
        );
        assert!(helcim_attempt_reference_is_return(Some(
            "helcim:cardReverse:123"
        )));
        assert!(!helcim_attempt_reference_is_return(Some(
            "helcim:cardTransaction:456"
        )));
    }

    #[test]
    fn helcim_provider_evidence_blocks_amount_currency_and_purpose_mismatches() {
        let mismatch = helcim_provider_result_mismatch_evidence(
            1_234,
            "usd",
            false,
            9_999,
            Some("cad"),
            Some("refund"),
        )
        .expect("mismatched provider evidence is blocked");

        assert!(mismatch.contains("absolute amount expected 1234 cents"));
        assert!(mismatch.contains("currency did not equal usd"));
        assert!(mismatch.contains("purpose expected purchase but provider returned return"));
        assert!(mismatch.contains("Automatic ledger binding was blocked"));
    }

    #[test]
    fn helcim_provider_evidence_requires_currency_and_known_transaction_type() {
        let mismatch =
            helcim_provider_result_mismatch_evidence(1_234, "usd", false, 1_234, None, None)
                .expect("missing provider identity evidence is blocked");

        assert!(mismatch.contains("currency did not equal usd"));
        assert!(mismatch.contains("provider returned unknown"));
    }

    #[test]
    fn helcim_ros_invoice_only_correlates_exact_attempt_uuid_format() {
        let attempt_id = Uuid::parse_str("4b1c7a4f-3a1e-43dc-bb10-bfcb20c7b1e2").unwrap();

        assert_eq!(
            helcim_ros_invoice_correlation(Some("ROS-4b1c7a4f3a1e43dcbb10bfcb20c7b1e2")),
            HelcimRosInvoiceCorrelation::Attempt(attempt_id)
        );
        assert_eq!(
            helcim_ros_invoice_correlation(Some("provider-payment-id-123")),
            HelcimRosInvoiceCorrelation::None
        );
        assert_eq!(
            helcim_ros_invoice_correlation(Some("ROS-not-an-attempt-id")),
            HelcimRosInvoiceCorrelation::Invalid
        );
    }

    #[test]
    fn helcim_fetched_transaction_id_must_equal_webhook_request() {
        assert_eq!(
            helcim_webhook_transaction_id_mismatch("123456", Some("123456")),
            None
        );
        assert!(
            helcim_webhook_transaction_id_mismatch("123456", Some("654321"))
                .expect("different fetched transaction ID is blocked")
                .contains("different")
        );
        assert!(helcim_webhook_transaction_id_mismatch("123456", None)
            .expect("missing fetched transaction ID is blocked")
            .contains("did not return"));
    }

    #[test]
    fn helcim_card_webhook_fallback_requires_no_provider_id_owner() {
        let source = include_str!("webhooks.rs");
        let handler = source
            .split("async fn handle_helcim_card_transaction")
            .nth(1)
            .expect("card transaction handler source")
            .split("fn helcim_card_transaction_event_match_type")
            .next()
            .expect("bounded card transaction handler source");
        let direct_lookup = handler
            .find("direct_candidates: Vec<")
            .expect("direct provider ownership lookup");
        let fallback_gate = handler
            .rfind("if direct_candidates.is_empty()")
            .expect("fallback is gated on no direct owner");
        let invoice_correlation = handler
            .find("helcim_ros_invoice_correlation(invoice_number.as_deref())")
            .expect("strict ROS invoice correlation");
        let fallback_call = handler
            .find("find_safe_helcim_terminal_fallback_candidate")
            .expect("terminal fallback call");
        let direct_id_lookup = &handler[direct_lookup..invoice_correlation];
        let invoice_binding = &handler[invoice_correlation..fallback_gate];

        assert!(direct_lookup < fallback_gate);
        assert!(direct_lookup < invoice_correlation);
        assert!(invoice_correlation < fallback_gate);
        assert!(fallback_gate < fallback_call);
        assert!(
            handler[fallback_gate..fallback_call].contains("&& !terminal_id.is_empty()"),
            "cardTransaction fallback must not search all terminals when Helcim omits deviceCode"
        );
        assert!(handler[..fallback_gate].contains("provider_result_mismatch"));
        assert!(handler.contains("if !matched_attempt_is_return"));
        assert!(!direct_id_lookup.contains("invoice_number.clone()"));
        assert!(invoice_binding.contains("status = 'pending'"));
        assert!(invoice_binding.contains("error_code = 'outcome_unknown'"));
        assert!(invoice_binding.contains("$2 = '' OR terminal_id = $2 OR device_id = $2"));
        assert!(invoice_binding
            .contains("NULLIF(TRIM(COALESCE(terminal_id, device_id, '')), '') IS NOT NULL"));
        assert!(invoice_binding.contains("NOT LIKE '%refund%'"));
        assert!(invoice_binding.contains("direct_candidates[0].0 != invoice_attempt_id"));
        assert!(!handler.contains("let provider_payment_id = provider_transaction_id.clone()"));
        assert!(handler.contains("ELSE provider_payment_id END"));

        let fallback = source
            .split("async fn find_safe_helcim_terminal_fallback_candidate")
            .nth(1)
            .expect("terminal fallback helper source")
            .split("async fn mark_helcim_event_processed")
            .next()
            .expect("bounded terminal fallback helper source");
        assert!(fallback.contains("error_code IN ('outcome_unknown', 'terminal_pending_timeout')"));
        assert!(fallback.contains("NOT LIKE 'helcim-pay-js%'"));
        assert!(fallback.contains("NOT LIKE '%cardtoken%'"));
        assert!(
            fallback.contains("NULLIF(TRIM(COALESCE(provider_transaction_id, '')), '') IS NULL")
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
