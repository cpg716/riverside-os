//! Podium inbound webhooks: signature verification and idempotent receipt ledger.

use hmac::{Hmac, Mac};
use http::HeaderMap;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use subtle::ConstantTimeEq;
use uuid::Uuid;

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
    Accepted,
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

    if let Ok(ts_i) = ts.parse::<i64>() {
        let now = chrono::Utc::now().timestamp();
        if (now - ts_i).abs() > 300 {
            return Err(PodiumWebhookVerifyError::StaleTimestamp);
        }
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
    for ptr in ["/uid", "/id", "/data/uid", "/data/id", "/message/uid"] {
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
        INSERT INTO podium_webhook_delivery (idempotency_key, payload_sha256_hex)
        VALUES ($1, $2)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
        "#,
    )
    .bind(&idem)
    .bind(&sha_hex)
    .fetch_optional(pool)
    .await?;

    if new_id.is_none() {
        return Ok(PodiumWebhookDisposition::Duplicate);
    }

    Ok(PodiumWebhookDisposition::Accepted)
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
}
