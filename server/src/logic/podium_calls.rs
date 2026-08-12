//! Podium call webhooks -> durable call activity linked to shared conversations.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::logic::podium::normalize_phone_e164;
use crate::logic::podium_contacts::{self, CustomerIdentityMatch};

const CALL_EVENT_TYPES: &[&str] = &[
    "call.received",
    "call.completed",
    "call.missed",
    "call.voicemail_left",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PodiumCallWebhookOutcome {
    Processed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PodiumCallEventApiRow {
    pub id: Uuid,
    pub conversation_id: Option<Uuid>,
    pub provider_call_uid: String,
    pub event_type: String,
    pub direction: String,
    pub contact_phone_e164: Option<String>,
    pub contact_name: Option<String>,
    pub duration_seconds: Option<i32>,
    pub has_voicemail: bool,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct ParsedCallEvent {
    provider_event_uid: String,
    provider_call_uid: String,
    provider_conversation_uid: Option<String>,
    provider_contact_uid: Option<String>,
    event_type: String,
    direction: String,
    contact_phone_e164: Option<String>,
    contact_name: Option<String>,
    duration_seconds: Option<i32>,
    has_voicemail: bool,
    occurred_at: DateTime<Utc>,
}

fn text_at(value: &Value, paths: &[&str]) -> Option<String> {
    paths.iter().find_map(|path| {
        value
            .pointer(path)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    })
}

fn integer_at(value: &Value, paths: &[&str]) -> Option<i64> {
    paths.iter().find_map(|path| {
        let candidate = value.pointer(path)?;
        candidate
            .as_i64()
            .or_else(|| {
                candidate
                    .as_u64()
                    .and_then(|number| i64::try_from(number).ok())
            })
            .or_else(|| candidate.as_str()?.trim().parse::<i64>().ok())
    })
}

fn timestamp_at(value: &Value, paths: &[&str]) -> Option<DateTime<Utc>> {
    text_at(value, paths).and_then(|raw| {
        DateTime::parse_from_rfc3339(&raw)
            .ok()
            .map(|timestamp| timestamp.with_timezone(&Utc))
    })
}

fn call_event_type(value: &Value) -> Option<String> {
    text_at(
        value,
        &[
            "/metadata/eventType",
            "/metadata/event_type",
            "/eventType",
            "/event_type",
            "/event",
        ],
    )
    .map(|event_type| event_type.to_ascii_lowercase())
    .filter(|event_type| CALL_EVENT_TYPES.contains(&event_type.as_str()))
}

fn normalized_direction(value: &Value, event_type: &str) -> String {
    let explicit = text_at(
        value,
        &["/data/direction", "/data/call/direction", "/direction"],
    )
    .map(|direction| direction.to_ascii_lowercase());
    match explicit.as_deref() {
        Some("inbound" | "incoming") => "inbound".to_string(),
        Some("outbound" | "outgoing") => "outbound".to_string(),
        _ if matches!(
            event_type,
            "call.received" | "call.missed" | "call.voicemail_left"
        ) =>
        {
            "inbound".to_string()
        }
        _ => "unknown".to_string(),
    }
}

fn payload_hash_uid(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn parse_call_event(value: &Value) -> Option<ParsedCallEvent> {
    let event_type = call_event_type(value)?;
    let provider_event_uid = text_at(
        value,
        &[
            "/metadata/eventUid",
            "/metadata/event_uid",
            "/eventUid",
            "/event_uid",
        ],
    )
    .unwrap_or_else(|| payload_hash_uid(value));
    let provider_call_uid = text_at(
        value,
        &[
            "/data/call/uid",
            "/data/callUid",
            "/data/call_uid",
            "/data/uid",
            "/call/uid",
            "/callUid",
            "/call_uid",
        ],
    )
    .unwrap_or_else(|| provider_event_uid.clone());
    let direction = normalized_direction(value, &event_type);
    let from_phone = text_at(
        value,
        &[
            "/data/from/phoneNumber",
            "/data/fromPhoneNumber",
            "/data/from_phone_number",
            "/data/caller/phoneNumber",
            "/data/callerNumber",
            "/data/caller_number",
            "/from/phoneNumber",
            "/fromPhoneNumber",
        ],
    );
    let to_phone = text_at(
        value,
        &[
            "/data/to/phoneNumber",
            "/data/toPhoneNumber",
            "/data/to_phone_number",
            "/data/callee/phoneNumber",
            "/data/calleeNumber",
            "/data/callee_number",
            "/to/phoneNumber",
            "/toPhoneNumber",
        ],
    );
    let contact_phone = text_at(
        value,
        &[
            "/data/contact/phoneNumber",
            "/data/contactPhoneNumber",
            "/data/customerPhoneNumber",
            "/data/phoneNumber",
            "/data/conversation/channel/identifier",
            "/conversation/channel/identifier",
        ],
    );
    let raw_customer_phone = if direction == "outbound" {
        to_phone.or(contact_phone).or(from_phone)
    } else {
        from_phone.or(contact_phone).or(to_phone)
    };
    let contact_phone_e164 = raw_customer_phone.as_deref().and_then(normalize_phone_e164);
    let started_at = timestamp_at(
        value,
        &[
            "/data/startedAt",
            "/data/started_at",
            "/data/call/startedAt",
            "/data/call/started_at",
        ],
    );
    let ended_at = timestamp_at(
        value,
        &[
            "/data/completedAt",
            "/data/completed_at",
            "/data/endedAt",
            "/data/ended_at",
            "/data/call/completedAt",
            "/data/call/endedAt",
        ],
    );
    let duration_seconds = integer_at(
        value,
        &[
            "/data/durationSeconds",
            "/data/duration_seconds",
            "/data/call/durationSeconds",
            "/data/call/duration_seconds",
            "/data/duration",
        ],
    )
    .or_else(|| {
        started_at
            .as_ref()
            .zip(ended_at.as_ref())
            .map(|(started, ended)| ended.timestamp() - started.timestamp())
    })
    .filter(|seconds| *seconds >= 0)
    .and_then(|seconds| i32::try_from(seconds).ok());

    Some(ParsedCallEvent {
        provider_event_uid,
        provider_call_uid,
        provider_conversation_uid: text_at(
            value,
            &[
                "/data/conversation/uid",
                "/data/conversationUid",
                "/data/conversation_uid",
                "/conversation/uid",
                "/conversationUid",
            ],
        ),
        provider_contact_uid: text_at(
            value,
            &[
                "/data/contact/uid",
                "/data/contactUid",
                "/data/contact_uid",
                "/contact/uid",
                "/contactUid",
            ],
        ),
        event_type: event_type.clone(),
        direction,
        contact_phone_e164,
        contact_name: text_at(
            value,
            &[
                "/data/contact/name",
                "/data/contactName",
                "/data/customerName",
                "/data/caller/name",
                "/contact/name",
            ],
        ),
        duration_seconds,
        has_voicemail: event_type == "call.voicemail_left"
            || text_at(
                value,
                &[
                    "/data/voicemail/url",
                    "/data/voicemailUrl",
                    "/data/voicemail_url",
                    "/data/recording/url",
                    "/data/recordingUrl",
                ],
            )
            .is_some(),
        occurred_at: started_at
            .or_else(|| {
                timestamp_at(
                    value,
                    &[
                        "/data/createdAt",
                        "/data/created_at",
                        "/createdAt",
                        "/created_at",
                    ],
                )
            })
            .or(ended_at)
            .unwrap_or_else(Utc::now),
    })
}

async fn customer_for_call(
    pool: &PgPool,
    parsed: &ParsedCallEvent,
) -> Result<Option<Uuid>, sqlx::Error> {
    if let Some(conversation_uid) = parsed.provider_conversation_uid.as_deref() {
        let linked_customer: Option<Uuid> = sqlx::query_scalar(
            r#"
            SELECT customer_id
            FROM podium_conversation
            WHERE podium_conversation_uid = $1
              AND customer_id IS NOT NULL
            LIMIT 1
            "#,
        )
        .bind(conversation_uid)
        .fetch_optional(pool)
        .await?
        .flatten();
        if linked_customer.is_some() {
            return Ok(linked_customer);
        }
    }
    if let Some(contact_uid) = parsed.provider_contact_uid.as_deref() {
        let mapped_customer: Option<Uuid> = sqlx::query_scalar(
            r#"
            SELECT customer_id
            FROM podium_contact_sync_state
            WHERE provider_contact_uid = $1
            LIMIT 1
            "#,
        )
        .bind(contact_uid)
        .fetch_optional(pool)
        .await?;
        if mapped_customer.is_some() {
            return Ok(mapped_customer);
        }
    }
    let Some(phone) = parsed.contact_phone_e164.as_deref() else {
        return Ok(None);
    };
    match podium_contacts::match_customer_identity(pool, Some(phone), None).await? {
        CustomerIdentityMatch::Unique(customer_id) => Ok(Some(customer_id)),
        CustomerIdentityMatch::None | CustomerIdentityMatch::Ambiguous(_) => Ok(None),
    }
}

pub async fn apply_call_webhook(
    pool: &PgPool,
    value: &Value,
) -> Result<PodiumCallWebhookOutcome, sqlx::Error> {
    let Some(parsed) = parse_call_event(value) else {
        return Ok(PodiumCallWebhookOutcome::Skipped);
    };
    let customer_id = customer_for_call(pool, &parsed).await?;
    let mut tx = pool.begin().await?;

    let mut conversation: Option<(Uuid, Option<Uuid>)> =
        if let Some(conversation_uid) = parsed.provider_conversation_uid.as_deref() {
            sqlx::query_as(
                r#"
            SELECT id, customer_id
            FROM podium_conversation
            WHERE podium_conversation_uid = $1
            LIMIT 1
            "#,
            )
            .bind(conversation_uid)
            .fetch_optional(&mut *tx)
            .await?
        } else {
            None
        };
    if conversation.is_none() && (customer_id.is_some() || parsed.contact_phone_e164.is_some()) {
        conversation = sqlx::query_as(
            r#"
            SELECT id, customer_id
            FROM podium_conversation
            WHERE channel = 'sms'
              AND (
                  ($1::uuid IS NOT NULL AND customer_id = $1)
                  OR ($2::text IS NOT NULL AND contact_phone_e164 = $2)
              )
            ORDER BY
                CASE WHEN $1::uuid IS NOT NULL AND customer_id = $1 THEN 0 ELSE 1 END,
                last_message_at DESC
            LIMIT 1
            "#,
        )
        .bind(customer_id)
        .bind(parsed.contact_phone_e164.as_deref())
        .fetch_optional(&mut *tx)
        .await?;
    }

    let conversation_id = if let Some((conversation_id, _)) = conversation {
        sqlx::query(
            r#"
            UPDATE podium_conversation
            SET customer_id = COALESCE(customer_id, $2),
                podium_conversation_uid = COALESCE(podium_conversation_uid, $3),
                contact_phone_e164 = COALESCE(contact_phone_e164, $4),
                last_message_at = GREATEST(last_message_at, $5)
            WHERE id = $1
            "#,
        )
        .bind(conversation_id)
        .bind(customer_id)
        .bind(parsed.provider_conversation_uid.as_deref())
        .bind(parsed.contact_phone_e164.as_deref())
        .bind(parsed.occurred_at)
        .execute(&mut *tx)
        .await?;
        Some(conversation_id)
    } else if customer_id.is_some() || parsed.contact_phone_e164.is_some() {
        Some(
            sqlx::query_scalar(
                r#"
                INSERT INTO podium_conversation (
                    customer_id, channel, podium_conversation_uid,
                    contact_phone_e164, last_message_at, sync_source
                )
                VALUES ($1, 'sms', $2, $3, $4, 'webhook')
                RETURNING id
                "#,
            )
            .bind(customer_id)
            .bind(parsed.provider_conversation_uid.as_deref())
            .bind(parsed.contact_phone_e164.as_deref())
            .bind(parsed.occurred_at)
            .fetch_one(&mut *tx)
            .await?,
        )
    } else {
        None
    };

    sqlx::query(
        r#"
        INSERT INTO podium_call_event (
            conversation_id, customer_id, provider_event_uid, provider_call_uid,
            provider_conversation_uid, event_type, direction, contact_phone_e164,
            contact_name, duration_seconds, has_voicemail, occurred_at, raw_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (provider_event_uid) DO UPDATE SET
            conversation_id = COALESCE(EXCLUDED.conversation_id, podium_call_event.conversation_id),
            customer_id = COALESCE(EXCLUDED.customer_id, podium_call_event.customer_id),
            provider_call_uid = EXCLUDED.provider_call_uid,
            provider_conversation_uid = COALESCE(
                EXCLUDED.provider_conversation_uid,
                podium_call_event.provider_conversation_uid
            ),
            event_type = EXCLUDED.event_type,
            direction = EXCLUDED.direction,
            contact_phone_e164 = COALESCE(
                EXCLUDED.contact_phone_e164,
                podium_call_event.contact_phone_e164
            ),
            contact_name = COALESCE(EXCLUDED.contact_name, podium_call_event.contact_name),
            duration_seconds = COALESCE(
                EXCLUDED.duration_seconds,
                podium_call_event.duration_seconds
            ),
            has_voicemail = EXCLUDED.has_voicemail OR podium_call_event.has_voicemail,
            occurred_at = LEAST(EXCLUDED.occurred_at, podium_call_event.occurred_at),
            raw_payload = EXCLUDED.raw_payload,
            updated_at = NOW()
        "#,
    )
    .bind(conversation_id)
    .bind(customer_id)
    .bind(&parsed.provider_event_uid)
    .bind(&parsed.provider_call_uid)
    .bind(parsed.provider_conversation_uid.as_deref())
    .bind(&parsed.event_type)
    .bind(&parsed.direction)
    .bind(parsed.contact_phone_e164.as_deref())
    .bind(parsed.contact_name.as_deref())
    .bind(parsed.duration_seconds)
    .bind(parsed.has_voicemail)
    .bind(parsed.occurred_at)
    .bind(value)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    if conversation_id.is_none() {
        tracing::warn!(
            target = "podium_calls",
            provider_call_uid = %parsed.provider_call_uid,
            "Stored Podium call event without a matchable conversation"
        );
    }
    Ok(PodiumCallWebhookOutcome::Processed)
}

pub async fn list_call_events_for_conversation(
    pool: &PgPool,
    conversation_id: Uuid,
) -> Result<Vec<PodiumCallEventApiRow>, sqlx::Error> {
    sqlx::query_as::<_, PodiumCallEventApiRow>(
        r#"
        WITH ranked AS (
            SELECT
                id,
                conversation_id,
                provider_call_uid,
                event_type,
                direction,
                contact_phone_e164,
                contact_name,
                duration_seconds,
                has_voicemail,
                occurred_at,
                ROW_NUMBER() OVER (
                    PARTITION BY provider_call_uid
                    ORDER BY
                        CASE event_type
                            WHEN 'call.voicemail_left' THEN 4
                            WHEN 'call.missed' THEN 3
                            WHEN 'call.completed' THEN 2
                            ELSE 1
                        END DESC,
                        occurred_at DESC,
                        updated_at DESC
                ) AS lifecycle_rank
            FROM podium_call_event
            WHERE conversation_id = $1
        )
        SELECT
            id,
            conversation_id,
            provider_call_uid,
            event_type,
            direction,
            contact_phone_e164,
            contact_name,
            duration_seconds,
            has_voicemail,
            occurred_at
        FROM ranked
        WHERE lifecycle_rank = 1
        ORDER BY occurred_at ASC
        "#,
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_call_payload_into_stable_display_fields() {
        let parsed = parse_call_event(&json!({
            "metadata": {
                "eventType": "call.completed",
                "eventUid": "event-1"
            },
            "data": {
                "uid": "call-1",
                "direction": "inbound",
                "from": { "phoneNumber": "+17165551212" },
                "contact": { "uid": "contact-1", "name": "Chris Customer" },
                "conversation": { "uid": "conversation-1" },
                "startedAt": "2026-08-12T14:00:00Z",
                "completedAt": "2026-08-12T14:02:05Z"
            }
        }))
        .expect("call payload");

        assert_eq!(parsed.provider_event_uid, "event-1");
        assert_eq!(parsed.provider_call_uid, "call-1");
        assert_eq!(parsed.direction, "inbound");
        assert_eq!(parsed.contact_phone_e164.as_deref(), Some("+17165551212"));
        assert_eq!(parsed.contact_name.as_deref(), Some("Chris Customer"));
        assert_eq!(parsed.duration_seconds, Some(125));
    }

    #[test]
    fn missed_and_voicemail_events_default_to_inbound() {
        for event_type in ["call.missed", "call.voicemail_left", "call.received"] {
            let parsed = parse_call_event(&json!({
                "metadata": { "eventType": event_type, "eventUid": event_type },
                "data": { "uid": format!("{event_type}-uid") }
            }))
            .expect("call payload");
            assert_eq!(parsed.direction, "inbound");
        }
    }

    #[test]
    fn ignores_non_call_webhooks() {
        assert!(parse_call_event(&json!({
            "metadata": { "eventType": "message.received" },
            "data": { "uid": "message-1" }
        }))
        .is_none());
    }
}
