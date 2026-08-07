//! Podium inbound webhooks: signature verification and idempotent receipt ledger.

use hmac::{Hmac, Mac};
use http::HeaderMap;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::logic::podium::PodiumTokenCache;

type HmacSha256 = Hmac<Sha256>;

/// When false (`RIVERSIDE_PODIUM_INBOUND_DISABLED=1`), verified webhooks append the delivery ledger only;
/// [`crate::logic::podium_inbound::ingest_from_webhook`] is skipped.
pub fn podium_inbound_crm_ingest_enabled() -> bool {
    !env_truthy("RIVERSIDE_PODIUM_INBOUND_DISABLED")
}

/// Settings readiness JSON field name (`inbound_inbox_preview_enabled`): legacy key; means CRM ingest + notifications.
pub fn podium_inbound_inbox_enabled() -> bool {
    podium_inbound_crm_ingest_enabled()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PodiumWebhookDisposition {
    /// New delivery recorded (may still skip inbox fan-out).
    Accepted(Uuid),
    /// Duplicate delivery id (Podium retry).
    Duplicate,
}

fn env_truthy(name: &str) -> bool {
    std::env::var(name)
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

/// When true and `RIVERSIDE_PODIUM_WEBHOOK_SECRET` is unset, accept unsigned webhooks (local dev only).
pub fn allow_unsigned_podium_webhook() -> bool {
    env_truthy("RIVERSIDE_PODIUM_WEBHOOK_ALLOW_UNSIGNED")
}

pub fn podium_webhook_secret_from_env() -> Option<String> {
    std::env::var("RIVERSIDE_PODIUM_WEBHOOK_SECRET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Debug, thiserror::Error)]
pub enum PodiumWebhookVerifyError {
    #[error("missing podium-timestamp header")]
    MissingTimestamp,
    #[error("missing podium-signature header")]
    MissingSignature,
    #[error("invalid podium-timestamp header")]
    InvalidTimestamp,
    #[error("invalid signature")]
    BadSignature,
    #[error("webhook timestamp skew too large")]
    StaleTimestamp,
    #[error("webhook secret required (set RIVERSIDE_PODIUM_WEBHOOK_SECRET or RIVERSIDE_PODIUM_WEBHOOK_ALLOW_UNSIGNED=true for local dev)")]
    SecretRequired,
}

fn header_first(headers: &HeaderMap, name: &'static str) -> Option<String> {
    headers
        .get(name)?
        .to_str()
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn parse_signature_hex(raw: &str) -> Option<[u8; 32]> {
    let t = raw.trim();
    let t = t.strip_prefix("sha256=").unwrap_or(t).trim();
    let bytes = hex::decode(t).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Some(out)
}

/// Verify `podium-timestamp` + `podium-signature` per Podium: HMAC-SHA256(secret, timestamp + "." + raw_body).
pub fn verify_podium_webhook_headers(
    headers: &HeaderMap,
    raw_body: &[u8],
) -> Result<(), PodiumWebhookVerifyError> {
    let secret = match podium_webhook_secret_from_env() {
        Some(s) => s,
        None => {
            if allow_unsigned_podium_webhook() {
                return Ok(());
            }
            return Err(PodiumWebhookVerifyError::SecretRequired);
        }
    };

    let ts = header_first(headers, "podium-timestamp")
        .ok_or(PodiumWebhookVerifyError::MissingTimestamp)?;
    let sig_raw = header_first(headers, "podium-signature")
        .ok_or(PodiumWebhookVerifyError::MissingSignature)?;

    let ts_i = ts
        .parse::<i64>()
        .map_err(|_| PodiumWebhookVerifyError::InvalidTimestamp)?;
    let ts_seconds = if ts_i.abs() > 10_000_000_000 {
        ts_i / 1000
    } else {
        ts_i
    };
    let now = chrono::Utc::now().timestamp();
    if (now - ts_seconds).abs() > 300 {
        return Err(PodiumWebhookVerifyError::StaleTimestamp);
    }

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| PodiumWebhookVerifyError::BadSignature)?;
    mac.update(ts.as_bytes());
    mac.update(b".");
    mac.update(raw_body);
    let expected = mac.finalize().into_bytes();

    let provided = parse_signature_hex(&sig_raw).ok_or(PodiumWebhookVerifyError::BadSignature)?;
    if bool::from(provided.as_slice().ct_eq(expected.as_slice())) {
        Ok(())
    } else {
        Err(PodiumWebhookVerifyError::BadSignature)
    }
}

fn payload_sha256_hex(body: &[u8]) -> String {
    let h = Sha256::digest(body);
    hex::encode(h)
}

/// Stable key for idempotency + inbox dedupe.
pub fn podium_webhook_idempotency_key(value: &Value, body: &[u8]) -> String {
    for ptr in [
        "/metadata/eventUid",
        "/uid",
        "/id",
        "/data/uid",
        "/data/id",
        "/message/uid",
    ] {
        if let Some(s) = value.pointer(ptr).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return format!("podium:{t}");
            }
        }
    }
    format!("podium:sha256:{}", payload_sha256_hex(body))
}

/// Insert ledger row; on conflict returns `Duplicate`. Optionally emits a preview `app_notification`.
pub async fn record_podium_webhook_delivery(
    pool: &PgPool,
    raw_body: &[u8],
    value: &Value,
) -> Result<PodiumWebhookDisposition, sqlx::Error> {
    let idem = podium_webhook_idempotency_key(value, raw_body);
    let sha_hex = payload_sha256_hex(raw_body);

    let new_id: Option<Uuid> = sqlx::query_scalar(
        r#"
        INSERT INTO podium_webhook_delivery (
            idempotency_key, payload_sha256_hex, raw_payload, processing_status, next_attempt_at
        )
        VALUES ($1, $2, $3, 'pending', NOW())
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
        "#,
    )
    .bind(&idem)
    .bind(&sha_hex)
    .bind(value)
    .fetch_optional(pool)
    .await?;

    let Some(new_id) = new_id else {
        return Ok(PodiumWebhookDisposition::Duplicate);
    };

    Ok(PodiumWebhookDisposition::Accepted(new_id))
}

#[derive(Debug, sqlx::FromRow)]
struct ClaimedPodiumWebhook {
    id: Uuid,
    raw_payload: Value,
    processing_attempts: i32,
}

async fn claim_podium_webhook(pool: &PgPool) -> Result<Option<ClaimedPodiumWebhook>, sqlx::Error> {
    sqlx::query_as(
        r#"
        WITH candidate AS (
            SELECT id
            FROM podium_webhook_delivery
            WHERE raw_payload IS NOT NULL
              AND processing_attempts < 8
              AND (
                  (processing_status = 'pending' AND next_attempt_at <= NOW())
                  OR (processing_status = 'processing' AND claimed_at < NOW() - INTERVAL '5 minutes')
              )
            ORDER BY next_attempt_at, received_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        UPDATE podium_webhook_delivery delivery
        SET processing_status = 'processing',
            processing_attempts = processing_attempts + 1,
            claimed_at = NOW(),
            last_error = NULL
        FROM candidate
        WHERE delivery.id = candidate.id
        RETURNING delivery.id, delivery.raw_payload, delivery.processing_attempts
        "#,
    )
    .fetch_optional(pool)
    .await
}

async fn finish_podium_webhook(
    pool: &PgPool,
    id: Uuid,
    outcome: crate::logic::podium_inbound::PodiumInboundIngestOutcome,
) -> Result<(), sqlx::Error> {
    let status = match outcome {
        crate::logic::podium_inbound::PodiumInboundIngestOutcome::Processed => "processed",
        crate::logic::podium_inbound::PodiumInboundIngestOutcome::Skipped => "skipped",
    };
    sqlx::query(
        r#"
        UPDATE podium_webhook_delivery
        SET processing_status = $2,
            processed_at = NOW(),
            claimed_at = NULL,
            last_error = NULL
        WHERE id = $1
        "#,
    )
    .bind(id)
    .bind(status)
    .execute(pool)
    .await?;
    Ok(())
}

async fn retry_podium_webhook(
    pool: &PgPool,
    delivery: &ClaimedPodiumWebhook,
    error: &sqlx::Error,
) -> Result<(), sqlx::Error> {
    let terminal = delivery.processing_attempts >= 8;
    let retry_seconds = 2_i64
        .pow(delivery.processing_attempts.clamp(1, 8) as u32)
        .min(300);
    sqlx::query(
        r#"
        UPDATE podium_webhook_delivery
        SET processing_status = CASE WHEN $2 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = CASE
                WHEN $2 THEN next_attempt_at
                ELSE NOW() + ($3 * INTERVAL '1 second')
            END,
            claimed_at = NULL,
            last_error = LEFT($4, 4000)
        WHERE id = $1
        "#,
    )
    .bind(delivery.id)
    .bind(terminal)
    .bind(retry_seconds)
    .bind(error.to_string())
    .execute(pool)
    .await?;
    if terminal {
        let message = format!(
            "Podium webhook {} failed after {} processing attempts and requires review.",
            delivery.id, delivery.processing_attempts
        );
        let _ = crate::logic::notifications::broadcast_system_alert_with_key(
            pool,
            &message,
            &format!("podium_webhook_failed:{}", delivery.id),
        )
        .await;
    }
    Ok(())
}

pub async fn process_pending_podium_webhooks(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    limit: usize,
) -> Result<u32, sqlx::Error> {
    let mut processed = 0_u32;
    for _ in 0..limit.clamp(1, 100) {
        let Some(delivery) = claim_podium_webhook(pool).await? else {
            break;
        };
        let process_result = async {
            crate::logic::podium_reviews::apply_review_invite_webhook(pool, &delivery.raw_payload)
                .await?;
            crate::logic::customer_notifications::apply_podium_failure_webhook(
                pool,
                &delivery.raw_payload,
            )
            .await?;
            if podium_inbound_crm_ingest_enabled() {
                crate::logic::podium_inbound::ingest_from_webhook(
                    pool,
                    http,
                    token_cache,
                    &delivery.raw_payload,
                )
                .await
            } else {
                Ok(crate::logic::podium_inbound::PodiumInboundIngestOutcome::Skipped)
            }
        }
        .await;
        match process_result {
            Ok(outcome) => {
                finish_podium_webhook(pool, delivery.id, outcome).await?;
                processed += 1;
            }
            Err(error) => retry_podium_webhook(pool, &delivery, &error).await?,
        }
    }
    Ok(processed)
}

pub async fn record_podium_webhook_failure(
    pool: &PgPool,
    raw_body: &[u8],
    reason: &str,
    http_status: u16,
) -> Result<(), sqlx::Error> {
    let sha_hex = payload_sha256_hex(raw_body);
    let raw_excerpt = String::from_utf8_lossy(raw_body)
        .chars()
        .take(512)
        .collect::<String>();
    sqlx::query(
        r#"
        INSERT INTO podium_webhook_failure (reason, http_status, payload_sha256_hex, raw_excerpt)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(reason)
    .bind(i32::from(http_status))
    .bind(sha_hex)
    .bind(raw_excerpt)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    #[test]
    fn verify_podium_signature_vector() {
        let secret = "whsec_test";
        let ts = format!("{}", chrono::Utc::now().timestamp());
        let body = br#"{"hello":"world"}"#;
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(ts.as_bytes());
        mac.update(b".");
        mac.update(body);
        let sig = hex::encode(mac.finalize().into_bytes());

        unsafe {
            std::env::set_var("RIVERSIDE_PODIUM_WEBHOOK_SECRET", secret);
            std::env::remove_var("RIVERSIDE_PODIUM_WEBHOOK_ALLOW_UNSIGNED");
        }

        let mut headers = HeaderMap::new();
        headers.insert(
            "podium-timestamp",
            HeaderValue::from_str(&ts).expect("timestamp"),
        );
        headers.insert(
            "podium-signature",
            HeaderValue::from_str(&sig).expect("signature"),
        );

        let r = verify_podium_webhook_headers(&headers, body);
        unsafe {
            std::env::remove_var("RIVERSIDE_PODIUM_WEBHOOK_SECRET");
        }
        assert!(r.is_ok(), "{r:?}");
    }

    #[test]
    fn idempotency_prefers_podium_event_uid() {
        let value = serde_json::json!({
            "data": { "uid": "message-1" },
            "metadata": { "eventUid": "event-1", "eventType": "message.failed" }
        });

        assert_eq!(
            podium_webhook_idempotency_key(&value, b"unused"),
            "podium:event-1"
        );
    }
}
