//! List / record Podium CRM messages (`podium_conversation`, `podium_message`).

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::logic::podium::{self, PodiumTokenCache};

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PodiumMessageApiRow {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub direction: String,
    pub channel: String,
    pub body: String,
    pub staff_id: Option<Uuid>,
    /// `staff.full_name` when `staff_id` is set (staff-sent outbound from ROS).
    pub staff_full_name: Option<String>,
    /// Display name from Podium (webhook) when staff replied in Podium, not via ROS.
    pub podium_sender_name: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PodiumInboxRow {
    pub conversation_id: Uuid,
    pub customer_id: Uuid,
    pub customer_code: String,
    pub first_name: String,
    pub last_name: String,
    pub channel: String,
    pub last_message_at: DateTime<Utc>,
    pub last_inbound_at: Option<DateTime<Utc>>,
    pub last_outbound_at: Option<DateTime<Utc>>,
    pub last_viewed_at: Option<DateTime<Utc>>,
    pub needs_reply: bool,
    pub unread: bool,
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PodiumMessagingHealth {
    pub credentials_configured: bool,
    pub sms_send_enabled: bool,
    pub location_uid_configured: bool,
    pub webhook_secret_configured: bool,
    pub inbound_ingest_enabled: bool,
    pub local_conversation_count: i64,
    pub unmatched_conversation_count: i64,
    pub last_webhook_received_at: Option<DateTime<Utc>>,
    pub last_webhook_failure_at: Option<DateTime<Utc>>,
    pub last_webhook_failure_reason: Option<String>,
    pub last_message_at: Option<DateTime<Utc>>,
    pub last_outbound_at: Option<DateTime<Utc>>,
    pub last_sync_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PodiumUnmatchedConversationRow {
    pub id: Uuid,
    pub provider_conversation_uid: String,
    pub channel: String,
    pub identifier: Option<String>,
    pub last_message_at: Option<DateTime<Utc>>,
    pub snippet: Option<String>,
    pub first_seen_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PodiumSyncResult {
    pub conversations_seen: usize,
    pub conversations_matched: usize,
    pub conversations_unmatched: usize,
    pub messages_seen: usize,
    pub messages_inserted: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct CommunicationTimelineRow {
    pub id: String,
    pub source: String,
    pub direction: String,
    pub channel: String,
    pub title: String,
    pub body: Option<String>,
    pub actor: Option<String>,
    pub occurred_at: DateTime<Utc>,
}

pub async fn list_messages_for_customer(
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<Vec<PodiumMessageApiRow>, sqlx::Error> {
    sqlx::query_as::<_, PodiumMessageApiRow>(
        r#"
        SELECT
            m.id,
            m.conversation_id,
            m.direction,
            m.channel,
            m.body,
            m.staff_id,
            s.full_name AS staff_full_name,
            m.podium_sender_name,
            m.created_at
        FROM podium_message m
        JOIN podium_conversation c ON c.id = m.conversation_id
        LEFT JOIN staff s ON s.id = m.staff_id
        WHERE c.customer_id = $1
        ORDER BY m.created_at ASC
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await
}

pub async fn has_conversations_for_customer(
    pool: &PgPool,
    customer_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM podium_conversation
            WHERE customer_id = $1
        )
        "#,
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await
}

pub async fn hydrate_missing_messages_for_customer(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    customer_id: Uuid,
) -> Result<usize, String> {
    #[derive(sqlx::FromRow)]
    struct ConversationShell {
        podium_conversation_uid: String,
        channel: String,
        contact_phone_e164: Option<String>,
        contact_email: Option<String>,
        last_message_at: DateTime<Utc>,
    }

    let shells = sqlx::query_as::<_, ConversationShell>(
        r#"
        SELECT
            podium_conversation_uid,
            channel,
            contact_phone_e164,
            contact_email,
            last_message_at
        FROM podium_conversation pc
        WHERE pc.customer_id = $1
          AND pc.podium_conversation_uid IS NOT NULL
          AND trim(pc.podium_conversation_uid) <> ''
          AND NOT EXISTS (
              SELECT 1
              FROM podium_message pm
              WHERE pm.conversation_id = pc.id
          )
        ORDER BY pc.last_message_at DESC
        LIMIT 5
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await
    .map_err(|err| err.to_string())?;

    let mut inserted = 0usize;
    for shell in shells {
        let messages = podium::fetch_podium_conversation_messages(
            pool,
            http,
            token_cache,
            &shell.podium_conversation_uid,
            50,
        )
        .await
        .map_err(|err| err.to_string())?;
        let identifier = if shell.channel == "email" {
            shell.contact_email.as_deref()
        } else {
            shell.contact_phone_e164.as_deref()
        };
        let conversation = json!({
            "uid": shell.podium_conversation_uid,
            "channel": {
                "type": shell.channel,
                "identifier": identifier,
            },
            "lastItemAt": shell.last_message_at.to_rfc3339(),
        });
        for message in messages {
            if matches!(
                upsert_synced_message(pool, &conversation, &message)
                    .await
                    .map_err(|err| err.to_string())?,
                SyncMessageOutcome::Inserted
            ) {
                inserted += 1;
            }
        }
    }

    Ok(inserted)
}

pub async fn list_messaging_inbox(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<PodiumInboxRow>, sqlx::Error> {
    let lim = limit.clamp(1, 200);
    sqlx::query_as::<_, PodiumInboxRow>(
        r#"
        SELECT
            pc.id AS conversation_id,
            c.id AS customer_id,
            c.customer_code,
            c.first_name,
            c.last_name,
            pc.channel,
            pc.last_message_at,
            (
                SELECT MAX(pm.created_at)
                FROM podium_message pm
                WHERE pm.conversation_id = pc.id
                  AND pm.direction = 'inbound'
            ) AS last_inbound_at,
            (
                SELECT MAX(pm.created_at)
                FROM podium_message pm
                WHERE pm.conversation_id = pc.id
                  AND pm.direction IN ('outbound', 'automated')
            ) AS last_outbound_at,
            pc.last_viewed_at,
            COALESCE((
                SELECT MAX(pm.created_at)
                FROM podium_message pm
                WHERE pm.conversation_id = pc.id
                  AND pm.direction = 'inbound'
            ), 'epoch'::timestamptz) > COALESCE((
                SELECT MAX(pm.created_at)
                FROM podium_message pm
                WHERE pm.conversation_id = pc.id
                  AND pm.direction IN ('outbound', 'automated')
            ), 'epoch'::timestamptz) AS needs_reply,
            pc.last_message_at > COALESCE(pc.last_viewed_at, 'epoch'::timestamptz) AS unread,
            (
                SELECT pm.body
                FROM podium_message pm
                WHERE pm.conversation_id = pc.id
                ORDER BY pm.created_at DESC
                LIMIT 1
            ) AS snippet
        FROM podium_conversation pc
        JOIN customers c ON c.id = pc.customer_id
        WHERE pc.customer_id IS NOT NULL
        ORDER BY pc.last_message_at DESC
        LIMIT $1
        "#,
    )
    .bind(lim)
    .fetch_all(pool)
    .await
}

pub async fn mark_conversation_viewed(
    pool: &PgPool,
    conversation_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE podium_conversation SET last_viewed_at = NOW() WHERE id = $1")
        .bind(conversation_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn health(pool: &PgPool) -> Result<PodiumMessagingHealth, sqlx::Error> {
    let cfg = podium::load_store_podium_config(pool)
        .await
        .unwrap_or_default();
    let credentials_configured = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT COUNT(DISTINCT credential_key) = 3
        FROM integration_credentials
        WHERE integration_key = 'podium'
          AND credential_key IN ('client_id', 'client_secret', 'refresh_token')
          AND encrypted_value IS NOT NULL
        "#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or(false);
    #[derive(sqlx::FromRow)]
    struct PodiumMessagingHealthRow {
        local_conversation_count: i64,
        unmatched_conversation_count: i64,
        last_webhook_received_at: Option<DateTime<Utc>>,
        last_webhook_failure_at: Option<DateTime<Utc>>,
        last_webhook_failure_reason: Option<String>,
        last_message_at: Option<DateTime<Utc>>,
        last_outbound_at: Option<DateTime<Utc>>,
        last_sync_at: Option<DateTime<Utc>>,
    }

    let PodiumMessagingHealthRow {
        local_conversation_count,
        unmatched_conversation_count,
        last_webhook_received_at,
        last_webhook_failure_at,
        last_webhook_failure_reason,
        last_message_at,
        last_outbound_at,
        last_sync_at,
    } = sqlx::query_as(
        r#"
        SELECT
            (SELECT COUNT(*) FROM podium_conversation) AS local_conversation_count,
            (SELECT COUNT(*) FROM podium_sync_unmatched_conversation WHERE resolved_at IS NULL) AS unmatched_conversation_count,
            (SELECT MAX(received_at) FROM podium_webhook_delivery) AS last_webhook_received_at,
            (SELECT created_at FROM podium_webhook_failure ORDER BY created_at DESC LIMIT 1) AS last_webhook_failure_at,
            (SELECT reason FROM podium_webhook_failure ORDER BY created_at DESC LIMIT 1) AS last_webhook_failure_reason,
            (SELECT MAX(created_at) FROM podium_message) AS last_message_at,
            (SELECT MAX(created_at) FROM podium_message WHERE direction IN ('outbound', 'automated')) AS last_outbound_at,
            (SELECT MAX(last_synced_at) FROM podium_conversation) AS last_sync_at
        "#,
    )
    .fetch_one(pool)
    .await?;
    Ok(PodiumMessagingHealth {
        credentials_configured,
        sms_send_enabled: cfg.sms_send_enabled,
        location_uid_configured: !cfg.location_uid.trim().is_empty(),
        webhook_secret_configured: crate::logic::podium_webhook::podium_webhook_secret_from_env()
            .is_some(),
        inbound_ingest_enabled: crate::logic::podium_webhook::podium_inbound_crm_ingest_enabled(),
        local_conversation_count,
        unmatched_conversation_count,
        last_webhook_received_at,
        last_webhook_failure_at,
        last_webhook_failure_reason,
        last_message_at,
        last_outbound_at,
        last_sync_at,
    })
}

pub async fn list_unmatched_conversations(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<PodiumUnmatchedConversationRow>, sqlx::Error> {
    let lim = limit.clamp(1, 100);
    sqlx::query_as::<_, PodiumUnmatchedConversationRow>(
        r#"
        SELECT
            id,
            provider_conversation_uid,
            channel,
            identifier,
            last_message_at,
            snippet,
            first_seen_at,
            last_seen_at
        FROM podium_sync_unmatched_conversation
        WHERE resolved_at IS NULL
        ORDER BY last_seen_at DESC
        LIMIT $1
        "#,
    )
    .bind(lim)
    .fetch_all(pool)
    .await
}

/// After a successful Podium send: touch conversation + persist a row (`outbound` or `automated`).
#[allow(clippy::too_many_arguments)]
pub async fn record_outbound_message(
    pool: &PgPool,
    customer_id: Uuid,
    channel: &str,
    body: &str,
    staff_id: Option<Uuid>,
    phone_e164: Option<&str>,
    email: Option<&str>,
    direction: &str,
) -> Result<(), sqlx::Error> {
    let dir = match direction {
        "automated" => "automated",
        _ => "outbound",
    };
    let ch = if channel == "email" { "email" } else { "sms" };
    let mut tx = pool.begin().await?;

    let conv_id: Uuid = {
        let existing: Option<Uuid> = sqlx::query_scalar(
            r#"
            SELECT id FROM podium_conversation
            WHERE customer_id = $1 AND channel = $2
            ORDER BY last_message_at DESC
            LIMIT 1
            "#,
        )
        .bind(customer_id)
        .bind(ch)
        .fetch_optional(&mut *tx)
        .await?;

        match existing {
            Some(id) => {
                sqlx::query(
                    r#"UPDATE podium_conversation SET last_message_at = NOW() WHERE id = $1"#,
                )
                .bind(id)
                .execute(&mut *tx)
                .await?;
                id
            }
            None => {
                sqlx::query_scalar(
                    r#"
                    INSERT INTO podium_conversation (
                        customer_id, channel, podium_conversation_uid,
                        contact_phone_e164, contact_email
                    )
                    VALUES ($1, $2, NULL, $3, $4)
                    RETURNING id
                    "#,
                )
                .bind(customer_id)
                .bind(ch)
                .bind(phone_e164)
                .bind(email)
                .fetch_one(&mut *tx)
                .await?
            }
        }
    };

    sqlx::query(
        r#"
        INSERT INTO podium_message (
            conversation_id, direction, channel, body, staff_id, podium_message_uid, raw_payload, podium_sender_name
        )
        VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL)
        "#,
    )
    .bind(conv_id)
    .bind(dir)
    .bind(ch)
    .bind(body)
    .bind(staff_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

fn text_at(value: &Value, paths: &[&str]) -> Option<String> {
    paths.iter().find_map(|path| {
        value
            .pointer(path)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn timestamp_at(value: &Value, paths: &[&str]) -> Option<DateTime<Utc>> {
    text_at(value, paths).and_then(|raw| {
        DateTime::parse_from_rfc3339(&raw)
            .ok()
            .map(|dt| dt.with_timezone(&Utc))
    })
}

fn conversation_uid(value: &Value) -> Option<String> {
    text_at(
        value,
        &[
            "/uid",
            "/id",
            "/conversation/uid",
            "/data/uid",
            "/data/conversation/uid",
        ],
    )
}

fn message_uid(value: &Value) -> Option<String> {
    text_at(
        value,
        &["/uid", "/id", "/data/uid", "/data/id", "/message/uid"],
    )
}

fn channel_type(value: &Value) -> String {
    let raw = text_at(
        value,
        &[
            "/channel/type",
            "/conversation/channel/type",
            "/data/conversation/channel/type",
            "/data/channel/type",
        ],
    )
    .unwrap_or_else(|| "sms".to_string())
    .to_ascii_lowercase();
    if raw.contains("email") {
        "email".to_string()
    } else {
        "sms".to_string()
    }
}

fn channel_identifier(value: &Value) -> Option<String> {
    text_at(
        value,
        &[
            "/channel/identifier",
            "/conversation/channel/identifier",
            "/data/conversation/channel/identifier",
            "/data/channel/identifier",
        ],
    )
}

fn body_text(value: &Value) -> Option<String> {
    text_at(
        value,
        &[
            "/body",
            "/sendBody",
            "/snippet",
            "/preview",
            "/lastMessage/body",
            "/lastMessage/sendBody",
            "/lastItem/body",
            "/lastItem/sendBody",
            "/items/0/body",
            "/items/0/sendBody",
            "/data/body",
            "/data/sendBody",
            "/data/snippet",
            "/data/preview",
            "/data/lastMessage/body",
            "/data/lastMessage/sendBody",
            "/data/items/0/body",
            "/data/items/0/sendBody",
        ],
    )
}

fn conversation_last_at(value: &Value) -> Option<DateTime<Utc>> {
    timestamp_at(
        value,
        &[
            "/lastItemAt",
            "/lastMessage/createdAt",
            "/lastItem/createdAt",
            "/updatedAt",
            "/createdAt",
            "/startedAt",
            "/data/lastItemAt",
            "/data/lastMessage/createdAt",
            "/data/lastItem/createdAt",
            "/data/updatedAt",
            "/data/createdAt",
            "/data/startedAt",
        ],
    )
}

fn provider_status(value: &Value) -> Option<String> {
    text_at(
        value,
        &[
            "/status",
            "/state",
            "/data/status",
            "/data/state",
            "/conversation/status",
            "/conversation/state",
        ],
    )
}

fn provider_assignee_name(value: &Value) -> Option<String> {
    text_at(
        value,
        &[
            "/assignee/name",
            "/assignedTo/name",
            "/teamMember/name",
            "/data/assignee/name",
            "/data/assignedTo/name",
            "/conversation/assignee/name",
        ],
    )
}

fn message_direction(value: &Value) -> String {
    let raw = text_at(
        value,
        &[
            "/direction",
            "/sourceType",
            "/items/0/sourceType",
            "/data/direction",
            "/data/items/0/sourceType",
            "/metadata/eventType",
        ],
    )
    .unwrap_or_default()
    .to_ascii_lowercase();
    if raw.contains("inbound") || raw.contains("received") {
        "inbound".to_string()
    } else {
        "outbound".to_string()
    }
}

async fn find_customer_for_channel(
    pool: &PgPool,
    channel: &str,
    identifier: Option<&str>,
) -> Result<Option<Uuid>, sqlx::Error> {
    let Some(identifier) = identifier.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if channel == "email" || identifier.contains('@') {
        return sqlx::query_scalar(
            r#"
            SELECT id
            FROM customers
            WHERE lower(trim(email)) = lower(trim($1))
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )
        .bind(identifier)
        .fetch_optional(pool)
        .await;
    }
    let normalized = podium::normalize_phone_e164(identifier).unwrap_or_else(|| identifier.into());
    let digits: String = normalized.chars().filter(|c| c.is_ascii_digit()).collect();
    let tail = digits
        .chars()
        .rev()
        .take(10)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    if tail.len() < 10 {
        return Ok(None);
    }
    sqlx::query_scalar(
        r#"
        SELECT id
        FROM customers
        WHERE phone IS NOT NULL
          AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE '%' || $1
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(tail)
    .fetch_optional(pool)
    .await
}

enum SyncMessageOutcome {
    Inserted,
    Matched,
    Unmatched,
}

enum SyncConversationOutcome {
    Matched,
    Unmatched,
}

fn embedded_messages(conversation: &Value) -> Vec<Value> {
    for path in ["/messages", "/items", "/data/messages", "/data/items"] {
        if let Some(items) = conversation.pointer(path).and_then(Value::as_array) {
            return items.clone();
        }
    }
    Vec::new()
}

async fn upsert_synced_conversation_shell(
    pool: &PgPool,
    conversation: &Value,
) -> Result<SyncConversationOutcome, sqlx::Error> {
    let Some(conv_uid) = conversation_uid(conversation) else {
        return Ok(SyncConversationOutcome::Unmatched);
    };
    let channel = channel_type(conversation);
    let identifier = channel_identifier(conversation);
    let last_at = conversation_last_at(conversation).unwrap_or_else(Utc::now);
    let customer_id = find_customer_for_channel(pool, &channel, identifier.as_deref()).await?;
    let Some(customer_id) = customer_id else {
        record_unmatched_conversation(
            pool,
            conversation,
            None,
            &conv_uid,
            &channel,
            identifier.as_deref(),
        )
        .await?;
        return Ok(SyncConversationOutcome::Unmatched);
    };
    let provider_status = provider_status(conversation);
    let provider_assignee_name = provider_assignee_name(conversation);
    sqlx::query(
        r#"
        INSERT INTO podium_conversation (
            customer_id, channel, podium_conversation_uid, contact_phone_e164, contact_email,
            last_message_at, last_synced_at, sync_source, provider_status, provider_assignee_name
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'api_sync', $7, $8)
        ON CONFLICT (podium_conversation_uid)
        WHERE podium_conversation_uid IS NOT NULL AND trim(podium_conversation_uid) <> ''
        DO UPDATE SET
            customer_id = COALESCE(podium_conversation.customer_id, EXCLUDED.customer_id),
            last_message_at = GREATEST(podium_conversation.last_message_at, EXCLUDED.last_message_at),
            last_synced_at = NOW(),
            sync_source = 'api_sync',
            provider_status = COALESCE(EXCLUDED.provider_status, podium_conversation.provider_status),
            provider_assignee_name = COALESCE(EXCLUDED.provider_assignee_name, podium_conversation.provider_assignee_name)
        "#,
    )
    .bind(customer_id)
    .bind(&channel)
    .bind(&conv_uid)
    .bind(if channel == "sms" { identifier.as_deref() } else { None })
    .bind(if channel == "email" { identifier.as_deref() } else { None })
    .bind(last_at)
    .bind(provider_status.as_deref())
    .bind(provider_assignee_name.as_deref())
    .execute(pool)
    .await?;
    Ok(SyncConversationOutcome::Matched)
}

async fn record_unmatched_conversation(
    pool: &PgPool,
    conversation: &Value,
    message: Option<&Value>,
    conv_uid: &str,
    channel: &str,
    identifier: Option<&str>,
) -> Result<(), sqlx::Error> {
    let snippet = message
        .and_then(body_text)
        .or_else(|| body_text(conversation));
    let last_at = message
        .and_then(|m| {
            timestamp_at(
                m,
                &[
                    "/createdAt",
                    "/items/0/createdAt",
                    "/data/createdAt",
                    "/data/items/0/createdAt",
                ],
            )
        })
        .or_else(|| conversation_last_at(conversation));
    sqlx::query(
        r#"
        INSERT INTO podium_sync_unmatched_conversation (
            provider_conversation_uid, channel, identifier, last_message_at, snippet, raw_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (provider_conversation_uid)
        DO UPDATE SET
            channel = EXCLUDED.channel,
            identifier = COALESCE(EXCLUDED.identifier, podium_sync_unmatched_conversation.identifier),
            last_message_at = COALESCE(EXCLUDED.last_message_at, podium_sync_unmatched_conversation.last_message_at),
            snippet = COALESCE(EXCLUDED.snippet, podium_sync_unmatched_conversation.snippet),
            raw_payload = EXCLUDED.raw_payload,
            last_seen_at = NOW()
        "#,
    )
    .bind(conv_uid)
    .bind(channel)
    .bind(identifier)
    .bind(last_at)
    .bind(snippet.as_deref())
    .bind(conversation)
    .execute(pool)
    .await?;
    Ok(())
}

async fn upsert_synced_message(
    pool: &PgPool,
    conversation: &Value,
    message: &Value,
) -> Result<SyncMessageOutcome, sqlx::Error> {
    let Some(conv_uid) = conversation_uid(conversation)
        .or_else(|| text_at(message, &["/conversation/uid", "/data/conversation/uid"]))
    else {
        return Ok(SyncMessageOutcome::Unmatched);
    };
    let channel = channel_type(message);
    let identifier = channel_identifier(message).or_else(|| channel_identifier(conversation));
    let customer_id = find_customer_for_channel(pool, &channel, identifier.as_deref()).await?;
    let Some(customer_id) = customer_id else {
        record_unmatched_conversation(
            pool,
            conversation,
            Some(message),
            &conv_uid,
            &channel,
            identifier.as_deref(),
        )
        .await?;
        return Ok(SyncMessageOutcome::Unmatched);
    };
    let body = body_text(message).unwrap_or_default();
    let msg_uid = message_uid(message);
    let created_at = timestamp_at(
        message,
        &[
            "/createdAt",
            "/items/0/createdAt",
            "/data/createdAt",
            "/data/items/0/createdAt",
        ],
    )
    .unwrap_or_else(Utc::now);
    let last_at = timestamp_at(conversation, &["/lastItemAt", "/updatedAt", "/createdAt"])
        .unwrap_or(created_at);
    let direction = message_direction(message);
    let sender = text_at(
        message,
        &[
            "/sender/name",
            "/sender/displayName",
            "/contactName",
            "/data/sender/name",
        ],
    );
    let provider_status = provider_status(conversation);
    let provider_assignee_name = provider_assignee_name(conversation);
    let mut tx = pool.begin().await?;
    let conv_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO podium_conversation (
            customer_id, channel, podium_conversation_uid, contact_phone_e164, contact_email,
            last_message_at, last_synced_at, sync_source, provider_status, provider_assignee_name
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'api_sync', $7, $8)
        ON CONFLICT (podium_conversation_uid)
        WHERE podium_conversation_uid IS NOT NULL AND trim(podium_conversation_uid) <> ''
        DO UPDATE SET
            customer_id = COALESCE(podium_conversation.customer_id, EXCLUDED.customer_id),
            last_message_at = GREATEST(podium_conversation.last_message_at, EXCLUDED.last_message_at),
            last_synced_at = NOW(),
            provider_status = COALESCE(EXCLUDED.provider_status, podium_conversation.provider_status),
            provider_assignee_name = COALESCE(EXCLUDED.provider_assignee_name, podium_conversation.provider_assignee_name)
        RETURNING id
        "#,
    )
    .bind(customer_id)
    .bind(&channel)
    .bind(&conv_uid)
    .bind(if channel == "sms" { identifier.as_deref() } else { None })
    .bind(if channel == "email" { identifier.as_deref() } else { None })
    .bind(last_at)
    .bind(provider_status.as_deref())
    .bind(provider_assignee_name.as_deref())
    .fetch_one(&mut *tx)
    .await?;

    let inserted = sqlx::query_scalar::<_, Option<Uuid>>(
        r#"
        INSERT INTO podium_message (
            conversation_id, direction, channel, body, podium_message_uid, raw_payload,
            podium_sender_name, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (podium_message_uid)
        WHERE podium_message_uid IS NOT NULL AND trim(podium_message_uid) <> ''
        DO NOTHING
        RETURNING id
        "#,
    )
    .bind(conv_id)
    .bind(&direction)
    .bind(&channel)
    .bind(body)
    .bind(msg_uid.as_ref())
    .bind(message)
    .bind(sender.as_deref())
    .bind(created_at)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(if inserted.flatten().is_some() {
        SyncMessageOutcome::Inserted
    } else {
        SyncMessageOutcome::Matched
    })
}

pub async fn sync_recent_from_podium(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    limit: i64,
) -> Result<PodiumSyncResult, podium::PodiumError> {
    let conversations =
        podium::fetch_podium_conversations(pool, http, token_cache, limit.clamp(1, 100)).await?;
    let mut result = PodiumSyncResult {
        conversations_seen: conversations.len(),
        conversations_matched: 0,
        conversations_unmatched: 0,
        messages_seen: 0,
        messages_inserted: 0,
        errors: Vec::new(),
    };
    for conversation in conversations {
        let Some(uid) = conversation_uid(&conversation) else {
            result.errors.push("conversation missing uid".to_string());
            continue;
        };
        let messages = embedded_messages(&conversation);
        if messages.is_empty() {
            match upsert_synced_conversation_shell(pool, &conversation).await {
                Ok(SyncConversationOutcome::Matched) => {
                    result.conversations_matched += 1;
                    match podium::fetch_podium_conversation_messages(
                        pool,
                        http,
                        token_cache,
                        &uid,
                        50,
                    )
                    .await
                    {
                        Ok(provider_messages) => {
                            for message in provider_messages {
                                result.messages_seen += 1;
                                match upsert_synced_message(pool, &conversation, &message).await {
                                    Ok(SyncMessageOutcome::Inserted) => {
                                        result.messages_inserted += 1;
                                    }
                                    Ok(SyncMessageOutcome::Matched) => {}
                                    Ok(SyncMessageOutcome::Unmatched) => {}
                                    Err(err) => result.errors.push(format!("{uid}: {err}")),
                                }
                            }
                        }
                        Err(err) => result.errors.push(format!("{uid}: {err}")),
                    }
                }
                Ok(SyncConversationOutcome::Unmatched) => result.conversations_unmatched += 1,
                Err(err) => result.errors.push(format!("{uid}: {err}")),
            }
            continue;
        }
        let mut matched = false;
        for message in messages {
            result.messages_seen += 1;
            match upsert_synced_message(pool, &conversation, &message).await {
                Ok(SyncMessageOutcome::Inserted) => {
                    matched = true;
                    result.messages_inserted += 1;
                }
                Ok(SyncMessageOutcome::Matched) => {
                    matched = true;
                }
                Ok(SyncMessageOutcome::Unmatched) => {}
                Err(err) => result.errors.push(format!("{uid}: {err}")),
            }
        }
        if matched {
            result.conversations_matched += 1;
        } else {
            result.conversations_unmatched += 1;
        }
    }
    Ok(result)
}

pub async fn communication_timeline(
    pool: &PgPool,
    customer_id: Uuid,
    limit: i64,
) -> Result<Vec<CommunicationTimelineRow>, sqlx::Error> {
    let lim = limit.clamp(1, 100);
    sqlx::query_as::<_, CommunicationTimelineRow>(
        r#"
        SELECT *
        FROM (
            SELECT
                pm.id::text AS id,
                'podium' AS source,
                pm.direction AS direction,
                pm.channel AS channel,
                CASE
                    WHEN pm.direction = 'inbound' THEN 'Podium inbound'
                    WHEN pm.direction = 'automated' THEN 'Automated Podium message'
                    ELSE 'Podium reply'
                END AS title,
                pm.body AS body,
                COALESCE(s.full_name, pm.podium_sender_name) AS actor,
                pm.created_at AS occurred_at
            FROM podium_message pm
            JOIN podium_conversation pc ON pc.id = pm.conversation_id
            LEFT JOIN staff s ON s.id = pm.staff_id
            WHERE pc.customer_id = $1

            UNION ALL

            SELECT
                mm.id::text AS id,
                'mailbox' AS source,
                mm.direction AS direction,
                'email' AS channel,
                COALESCE(mm.subject, 'Email') AS title,
                COALESCE(mm.body_text, mm.body_html) AS body,
                COALESCE(s.full_name, mm.from_name) AS actor,
                COALESCE(mm.received_at, mm.sent_at, mm.created_at) AS occurred_at
            FROM mailbox_messages mm
            LEFT JOIN staff s ON s.id = mm.staff_id
            WHERE mm.customer_id = $1

            UNION ALL

            SELECT
                t.id::text AS id,
                'review' AS source,
                CASE
                    WHEN t.review_invite_suppressed_at IS NOT NULL THEN 'suppressed'
                    ELSE 'outbound'
                END AS direction,
                'review' AS channel,
                CASE
                    WHEN t.review_invite_suppressed_at IS NOT NULL THEN 'Review invite skipped'
                    ELSE 'Review invite sent'
                END AS title,
                t.display_id AS body,
                NULL::text AS actor,
                COALESCE(t.review_invite_sent_at, t.review_invite_suppressed_at) AS occurred_at
            FROM transactions t
            WHERE t.customer_id = $1
              AND (t.review_invite_sent_at IS NOT NULL OR t.review_invite_suppressed_at IS NOT NULL)
        ) rows
        ORDER BY occurred_at DESC
        LIMIT $2
        "#,
    )
    .bind(customer_id)
    .bind(lim)
    .fetch_all(pool)
    .await
}
