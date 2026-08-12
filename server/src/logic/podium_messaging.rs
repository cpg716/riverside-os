//! List / record Podium CRM messages (`podium_conversation`, `podium_message`).

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::logic::podium::{self, PodiumTokenCache};
use crate::logic::podium_contacts::{self, CustomerIdentityMatch};

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PodiumMessageApiRow {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub podium_conversation_uid: Option<String>,
    pub direction: String,
    pub channel: String,
    pub body: String,
    pub staff_id: Option<Uuid>,
    /// `staff.full_name` when `staff_id` is set (staff-sent outbound from ROS).
    pub staff_full_name: Option<String>,
    pub podium_sender_uid: Option<String>,
    /// Display name from Podium (webhook) when staff replied in Podium, not via ROS.
    pub podium_sender_name: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PodiumInboxRow {
    pub conversation_id: Uuid,
    pub podium_conversation_uid: Option<String>,
    pub customer_id: Option<Uuid>,
    pub customer_code: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub unmatched_id: Option<Uuid>,
    pub contact_identifier: Option<String>,
    pub channel: String,
    pub last_message_at: DateTime<Utc>,
    pub last_inbound_at: Option<DateTime<Utc>>,
    pub last_outbound_at: Option<DateTime<Utc>>,
    pub last_viewed_at: Option<DateTime<Utc>>,
    pub needs_reply: bool,
    pub unread: bool,
    pub closed: bool,
    pub provider_assignee_name: Option<String>,
    pub responder_staff_id: Option<Uuid>,
    pub responder_staff_name: Option<String>,
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PodiumConversationResponder {
    pub staff_id: Uuid,
    pub full_name: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PodiumReplyContext {
    pub conversation_id: Uuid,
    pub responder_staff_id: Option<Uuid>,
    pub responder_staff_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PodiumConversationAssignee {
    pub provider_user_uid: String,
    pub provider_name: String,
    pub staff_id: Option<Uuid>,
    pub staff_name: Option<String>,
    pub linked: bool,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PodiumAssignmentStaff {
    pub staff_id: Uuid,
    pub staff_name: String,
    pub provider_user_uid: String,
    pub provider_name: String,
}

#[derive(Debug, Error)]
pub enum PodiumConversationActionError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Provider(#[from] podium::PodiumError),
    #[error("conversation is not linked to a Podium conversation")]
    MissingProviderConversation,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PodiumMessagingHealth {
    pub credentials_configured: bool,
    pub sms_send_enabled: bool,
    pub location_uid_configured: bool,
    pub webhook_secret_configured: bool,
    pub inbound_ingest_enabled: bool,
    pub local_conversation_count: i64,
    pub local_message_count: i64,
    pub incomplete_history_count: i64,
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
    pub match_status: String,
    pub candidate_customer_ids: Vec<Uuid>,
    pub resolution_note: Option<String>,
    pub resolved_by_staff_id: Option<Uuid>,
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
            c.podium_conversation_uid,
            m.direction,
            m.channel,
            m.body,
            COALESCE(m.staff_id, podium_staff.id) AS staff_id,
            COALESCE(s.full_name, podium_staff.full_name) AS staff_full_name,
            m.podium_sender_uid,
            m.podium_sender_name,
            m.created_at
        FROM podium_message m
        JOIN podium_conversation c ON c.id = m.conversation_id
        LEFT JOIN staff s ON s.id = m.staff_id
        LEFT JOIN staff podium_staff
          ON m.staff_id IS NULL
         AND m.podium_sender_uid IS NOT NULL
         AND podium_staff.podium_user_uid = m.podium_sender_uid
         AND podium_staff.is_active = TRUE
        WHERE c.customer_id = $1
        ORDER BY m.created_at ASC
        "#,
    )
    .bind(customer_id)
    .fetch_all(pool)
    .await
}

pub async fn list_messages_for_conversation(
    pool: &PgPool,
    conversation_id: Uuid,
) -> Result<Vec<PodiumMessageApiRow>, sqlx::Error> {
    sqlx::query_as::<_, PodiumMessageApiRow>(
        r#"
        SELECT
            m.id,
            m.conversation_id,
            c.podium_conversation_uid,
            m.direction,
            m.channel,
            m.body,
            COALESCE(m.staff_id, podium_staff.id) AS staff_id,
            COALESCE(s.full_name, podium_staff.full_name) AS staff_full_name,
            m.podium_sender_uid,
            m.podium_sender_name,
            m.created_at
        FROM podium_message m
        JOIN podium_conversation c ON c.id = m.conversation_id
        LEFT JOIN staff s ON s.id = m.staff_id
        LEFT JOIN staff podium_staff
          ON m.staff_id IS NULL
         AND m.podium_sender_uid IS NOT NULL
         AND podium_staff.podium_user_uid = m.podium_sender_uid
         AND podium_staff.is_active = TRUE
        WHERE c.id = $1
        ORDER BY m.created_at ASC
        "#,
    )
    .bind(conversation_id)
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
        mark_conversation_synced(pool, &shell.podium_conversation_uid)
            .await
            .map_err(|err| err.to_string())?;
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
            pc.podium_conversation_uid,
            c.id AS customer_id,
            c.customer_code,
            c.first_name,
            c.last_name,
            unmatched.id AS unmatched_id,
            COALESCE(
                unmatched.identifier,
                pc.contact_phone_e164,
                pc.contact_email
            ) AS contact_identifier,
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
            (
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
                ), 'epoch'::timestamptz)
                OR EXISTS (
                    SELECT 1
                    FROM podium_call_event call_event
                    WHERE call_event.conversation_id = pc.id
                      AND call_event.direction <> 'outbound'
                      AND call_event.event_type IN ('call.missed', 'call.voicemail_left')
                      AND call_event.occurred_at > COALESCE((
                          SELECT MAX(pm.created_at)
                          FROM podium_message pm
                          WHERE pm.conversation_id = pc.id
                            AND pm.direction IN ('outbound', 'automated')
                      ), 'epoch'::timestamptz)
                )
                OR EXISTS (
                    SELECT 1
                    FROM podium_review review_activity
                    WHERE review_activity.conversation_id = pc.id
                      AND review_activity.needs_response = TRUE
                )
            ) AS needs_reply,
            (
                EXISTS (
                    SELECT 1
                    FROM podium_message unread_message
                    WHERE unread_message.conversation_id = pc.id
                      AND unread_message.direction = 'inbound'
                      AND unread_message.created_at > COALESCE(pc.last_viewed_at, 'epoch'::timestamptz)
                )
                OR EXISTS (
                    SELECT 1
                    FROM podium_call_event unread_call
                    WHERE unread_call.conversation_id = pc.id
                      AND unread_call.direction <> 'outbound'
                      AND unread_call.occurred_at > COALESCE(pc.last_viewed_at, 'epoch'::timestamptz)
                )
                OR EXISTS (
                    SELECT 1
                    FROM podium_review unread_review
                    WHERE unread_review.conversation_id = pc.id
                      AND unread_review.needs_response = TRUE
                      AND unread_review.last_activity_at > COALESCE(
                          pc.last_viewed_at,
                          'epoch'::timestamptz
                      )
                )
            ) AS unread,
            LOWER(COALESCE(pc.provider_status, '')) IN ('closed', 'archived') AS closed,
            pc.provider_assignee_name,
            CASE WHEN responder_staff.is_active = TRUE THEN responder_staff.id END AS responder_staff_id,
            CASE WHEN responder_staff.is_active = TRUE THEN responder_staff.full_name END AS responder_staff_name,
            (
                SELECT activity.preview
                FROM (
                    SELECT pm.body AS preview, pm.created_at
                    FROM podium_message pm
                    WHERE pm.conversation_id = pc.id
                    UNION ALL
                    SELECT
                        CASE call_event.event_type
                            WHEN 'call.voicemail_left' THEN 'Voicemail received'
                            WHEN 'call.missed' THEN 'Missed call'
                            WHEN 'call.received' THEN 'Incoming call'
                            WHEN 'call.completed' THEN CASE
                                WHEN call_event.direction = 'outbound' THEN 'Outgoing call completed'
                                ELSE 'Call completed'
                            END
                            ELSE 'Call activity'
                        END AS preview,
                        call_event.occurred_at AS created_at
                    FROM podium_call_event call_event
                    WHERE call_event.conversation_id = pc.id
                    UNION ALL
                    SELECT
                        CASE
                            WHEN review_activity.last_event_type LIKE 'review.response_%'
                                THEN 'Review response posted'
                            WHEN review_activity.rating IS NOT NULL
                                THEN CONCAT(
                                    'New ',
                                    review_activity.rating,
                                    '-star ',
                                    COALESCE(NULLIF(review_activity.site_name, ''), 'customer'),
                                    ' review'
                                )
                            ELSE 'New customer review'
                        END AS preview,
                        review_activity.last_activity_at AS created_at
                    FROM podium_review review_activity
                    WHERE review_activity.conversation_id = pc.id
                ) activity
                ORDER BY activity.created_at DESC
                LIMIT 1
            ) AS snippet
        FROM podium_conversation pc
        LEFT JOIN customers c ON c.id = pc.customer_id
        LEFT JOIN staff responder_staff ON responder_staff.id = pc.responder_staff_id
        LEFT JOIN podium_sync_unmatched_conversation unmatched
          ON unmatched.provider_conversation_uid = pc.podium_conversation_uid
         AND unmatched.resolved_at IS NULL
        ORDER BY pc.last_message_at DESC
        LIMIT $1
        "#,
    )
    .bind(lim)
    .fetch_all(pool)
    .await
}

pub async fn podium_reply_context(
    pool: &PgPool,
    conversation_id: Uuid,
    customer_id: Uuid,
    channel: &str,
) -> Result<Option<PodiumReplyContext>, sqlx::Error> {
    let channel = if channel == "email" { "email" } else { "sms" };
    sqlx::query_as::<_, PodiumReplyContext>(
        r#"
        SELECT
            pc.id AS conversation_id,
            CASE WHEN responder.is_active = TRUE THEN responder.id END AS responder_staff_id,
            CASE WHEN responder.is_active = TRUE THEN responder.full_name END AS responder_staff_name
        FROM podium_conversation pc
        LEFT JOIN staff responder ON responder.id = pc.responder_staff_id
        WHERE pc.id = $1
          AND pc.customer_id = $2
          AND pc.channel = $3
        "#,
    )
    .bind(conversation_id)
    .bind(customer_id)
    .bind(channel)
    .fetch_optional(pool)
    .await
}

pub async fn remember_conversation_responder(
    pool: &PgPool,
    conversation_id: Uuid,
    responder_staff_id: Uuid,
    selected_by_staff_id: Option<Uuid>,
) -> Result<Option<PodiumConversationResponder>, sqlx::Error> {
    sqlx::query_as::<_, PodiumConversationResponder>(
        r#"
        UPDATE podium_conversation pc
        SET responder_staff_id = responder.id,
            responder_verified_at = NOW(),
            responder_selected_by_staff_id = $3
        FROM staff responder
        WHERE pc.id = $1
          AND responder.id = $2
          AND responder.is_active = TRUE
        RETURNING responder.id AS staff_id, responder.full_name
        "#,
    )
    .bind(conversation_id)
    .bind(responder_staff_id)
    .bind(selected_by_staff_id)
    .fetch_optional(pool)
    .await
}

/// Shared unread conversation count used by the Podium Inbox navigation badge.
/// Keep this predicate aligned with `PodiumInboxRow.unread` and the active view.
pub async fn unread_messaging_inbox_count(pool: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM podium_conversation pc
        WHERE (
            EXISTS (
                SELECT 1
                FROM podium_message unread_message
                WHERE unread_message.conversation_id = pc.id
                  AND unread_message.direction = 'inbound'
                  AND unread_message.created_at > COALESCE(pc.last_viewed_at, 'epoch'::timestamptz)
            )
            OR EXISTS (
                SELECT 1
                FROM podium_call_event unread_call
                WHERE unread_call.conversation_id = pc.id
                  AND unread_call.direction <> 'outbound'
                  AND unread_call.occurred_at > COALESCE(pc.last_viewed_at, 'epoch'::timestamptz)
            )
            OR EXISTS (
                SELECT 1
                FROM podium_review unread_review
                WHERE unread_review.conversation_id = pc.id
                  AND unread_review.needs_response = TRUE
                  AND unread_review.last_activity_at > COALESCE(
                      pc.last_viewed_at,
                      'epoch'::timestamptz
                  )
            )
        )
          AND LOWER(COALESCE(pc.provider_status, '')) NOT IN ('closed', 'archived')
        "#,
    )
    .fetch_one(pool)
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

pub async fn set_conversations_read_state(
    pool: &PgPool,
    conversation_ids: &[Uuid],
    read: bool,
) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        UPDATE podium_conversation
        SET last_viewed_at = CASE WHEN $2 THEN NOW() ELSE NULL END
        WHERE id = ANY($1)
        RETURNING id
        "#,
    )
    .bind(conversation_ids)
    .bind(read)
    .fetch_all(pool)
    .await
}

pub async fn provider_uid_for_conversation(
    pool: &PgPool,
    conversation_id: Uuid,
) -> Result<String, PodiumConversationActionError> {
    let provider_uid = sqlx::query_scalar::<_, Option<String>>(
        "SELECT podium_conversation_uid FROM podium_conversation WHERE id = $1",
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?
    .flatten()
    .map(|uid| uid.trim().to_string())
    .filter(|uid| !uid.is_empty());

    provider_uid.ok_or(PodiumConversationActionError::MissingProviderConversation)
}

pub async fn list_assignment_staff(
    pool: &PgPool,
) -> Result<Vec<PodiumAssignmentStaff>, sqlx::Error> {
    sqlx::query_as::<_, PodiumAssignmentStaff>(
        r#"
        SELECT
            id AS staff_id,
            full_name AS staff_name,
            TRIM(podium_user_uid) AS provider_user_uid,
            COALESCE(NULLIF(TRIM(podium_display_name), ''), full_name) AS provider_name
        FROM staff
        WHERE is_active = TRUE
          AND NULLIF(TRIM(podium_user_uid), '') IS NOT NULL
        ORDER BY full_name ASC
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn assignment_staff_by_id(
    pool: &PgPool,
    staff_id: Uuid,
) -> Result<Option<PodiumAssignmentStaff>, sqlx::Error> {
    sqlx::query_as::<_, PodiumAssignmentStaff>(
        r#"
        SELECT
            id AS staff_id,
            full_name AS staff_name,
            TRIM(podium_user_uid) AS provider_user_uid,
            COALESCE(NULLIF(TRIM(podium_display_name), ''), full_name) AS provider_name
        FROM staff
        WHERE id = $1
          AND is_active = TRUE
          AND NULLIF(TRIM(podium_user_uid), '') IS NOT NULL
        "#,
    )
    .bind(staff_id)
    .fetch_optional(pool)
    .await
}

pub async fn assignment_staff_by_provider_uid(
    pool: &PgPool,
    provider_user_uid: &str,
) -> Result<Option<PodiumAssignmentStaff>, sqlx::Error> {
    sqlx::query_as::<_, PodiumAssignmentStaff>(
        r#"
        SELECT
            id AS staff_id,
            full_name AS staff_name,
            TRIM(podium_user_uid) AS provider_user_uid,
            COALESCE(NULLIF(TRIM(podium_display_name), ''), full_name) AS provider_name
        FROM staff
        WHERE is_active = TRUE
          AND TRIM(podium_user_uid) = $1
        "#,
    )
    .bind(provider_user_uid)
    .fetch_optional(pool)
    .await
}

pub async fn remember_conversation_assignee_name(
    pool: &PgPool,
    conversation_id: Uuid,
    assignee_name: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE podium_conversation SET provider_assignee_name = $2 WHERE id = $1")
        .bind(conversation_id)
        .bind(assignee_name)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_conversation_assignees(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    conversation_id: Uuid,
) -> Result<Vec<PodiumConversationAssignee>, PodiumConversationActionError> {
    let provider_uid = provider_uid_for_conversation(pool, conversation_id).await?;
    let provider_rows =
        podium::fetch_conversation_assignees(pool, http, token_cache, &provider_uid).await?;
    let mut provider_users = Vec::new();
    for row in provider_rows {
        let Some(uid) = text_at(&row, &["/uid", "/id", "/user/uid"]) else {
            continue;
        };
        let name = text_at(
            &row,
            &["/name", "/displayName", "/user/name", "/user/displayName"],
        )
        .or_else(|| {
            let first = text_at(&row, &["/firstName", "/user/firstName"]).unwrap_or_default();
            let last = text_at(&row, &["/lastName", "/user/lastName"]).unwrap_or_default();
            let full = format!("{} {}", first.trim(), last.trim())
                .trim()
                .to_string();
            (!full.is_empty()).then_some(full)
        })
        .unwrap_or_else(|| "Podium user".to_string());
        provider_users.push((uid, name));
    }

    let provider_uids: Vec<String> = provider_users.iter().map(|(uid, _)| uid.clone()).collect();
    let linked_staff: Vec<(String, Uuid, String)> = if provider_uids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            r#"
            SELECT podium_user_uid, id, full_name
            FROM staff
            WHERE podium_user_uid = ANY($1)
              AND is_active = TRUE
            "#,
        )
        .bind(&provider_uids)
        .fetch_all(pool)
        .await?
    };
    let mapped: HashMap<String, (Uuid, String)> = linked_staff
        .into_iter()
        .map(|(uid, staff_id, staff_name)| (uid, (staff_id, staff_name)))
        .collect();

    Ok(provider_users
        .into_iter()
        .map(|(provider_user_uid, provider_name)| {
            let staff = mapped.get(&provider_user_uid);
            PodiumConversationAssignee {
                provider_user_uid,
                provider_name,
                staff_id: staff.map(|(id, _)| *id),
                staff_name: staff.map(|(_, name)| name.clone()),
                linked: staff.is_some(),
            }
        })
        .collect())
}

pub async fn set_conversation_closed(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    conversation_id: Uuid,
    closed: bool,
) -> Result<(), PodiumConversationActionError> {
    let provider_uid = provider_uid_for_conversation(pool, conversation_id).await?;
    podium::update_conversation_closed(pool, http, token_cache, &provider_uid, closed).await?;
    sqlx::query("UPDATE podium_conversation SET provider_status = $2 WHERE id = $1")
        .bind(conversation_id)
        .bind(if closed { "closed" } else { "open" })
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
        local_message_count: i64,
        incomplete_history_count: i64,
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
        local_message_count,
        incomplete_history_count,
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
            (SELECT COUNT(*) FROM podium_message) AS local_message_count,
            (
                SELECT COUNT(*)
                FROM (
                    SELECT pc.last_synced_at
                    FROM podium_conversation pc
                    WHERE pc.podium_conversation_uid IS NOT NULL
                      AND trim(pc.podium_conversation_uid) <> ''
                    ORDER BY pc.last_message_at DESC
                    LIMIT 200
                ) recent_provider_conversations
                WHERE last_synced_at IS NULL
            ) AS incomplete_history_count,
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
        local_message_count,
        incomplete_history_count,
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
            match_status,
            candidate_customer_ids,
            resolution_note,
            resolved_by_staff_id,
            last_message_at,
            snippet,
            first_seen_at,
            last_seen_at
        FROM podium_sync_unmatched_conversation
        WHERE resolved_at IS NULL
        ORDER BY COALESCE(last_message_at, last_seen_at) DESC, last_seen_at DESC
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
    provider_message_uid: Option<&str>,
    provider_response: Option<&Value>,
) -> Result<(), sqlx::Error> {
    let dir = match direction {
        "automated" => "automated",
        _ => "outbound",
    };
    let ch = if channel == "email" { "email" } else { "sms" };
    let provider_conversation_uid = provider_response.and_then(|value| {
        text_at(
            value,
            &[
                "/conversation/uid",
                "/conversationUid",
                "/data/conversation/uid",
                "/data/conversationUid",
            ],
        )
    });
    let mut tx = pool.begin().await?;

    let conv_id: Uuid = {
        let existing_by_provider: Option<Uuid> =
            if let Some(uid) = provider_conversation_uid.as_deref() {
                sqlx::query_scalar(
                    "SELECT id FROM podium_conversation WHERE podium_conversation_uid = $1 LIMIT 1",
                )
                .bind(uid)
                .fetch_optional(&mut *tx)
                .await?
            } else {
                None
            };
        let existing: Option<Uuid> = if existing_by_provider.is_some() {
            existing_by_provider
        } else {
            sqlx::query_scalar(
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
            .await?
        };

        match existing {
            Some(id) => {
                sqlx::query(
                    r#"
                    UPDATE podium_conversation
                    SET last_message_at = NOW(),
                        customer_id = COALESCE(customer_id, $2),
                        podium_conversation_uid = COALESCE(podium_conversation_uid, $3),
                        contact_phone_e164 = COALESCE(contact_phone_e164, $4),
                        contact_email = COALESCE(contact_email, $5),
                        responder_staff_id = COALESCE(responder_staff_id, $6),
                        responder_verified_at = CASE
                            WHEN responder_staff_id IS NULL AND $6::uuid IS NOT NULL THEN NOW()
                            ELSE responder_verified_at
                        END,
                        responder_selected_by_staff_id = COALESCE(
                            responder_selected_by_staff_id,
                            $6
                        )
                    WHERE id = $1
                    "#,
                )
                .bind(id)
                .bind(customer_id)
                .bind(provider_conversation_uid.as_deref())
                .bind(phone_e164)
                .bind(email)
                .bind(staff_id)
                .execute(&mut *tx)
                .await?;
                id
            }
            None => {
                sqlx::query_scalar(
                    r#"
                    INSERT INTO podium_conversation (
                        customer_id, channel, podium_conversation_uid,
                        contact_phone_e164, contact_email, responder_staff_id,
                        responder_verified_at, responder_selected_by_staff_id
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::uuid IS NOT NULL THEN NOW() END, $6)
                    RETURNING id
                    "#,
                )
                .bind(customer_id)
                .bind(ch)
                .bind(provider_conversation_uid.as_deref())
                .bind(phone_e164)
                .bind(email)
                .bind(staff_id)
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
        ON CONFLICT (podium_message_uid)
        WHERE podium_message_uid IS NOT NULL AND trim(podium_message_uid) <> ''
        DO UPDATE SET
            staff_id = COALESCE(EXCLUDED.staff_id, podium_message.staff_id),
            raw_payload = COALESCE(EXCLUDED.raw_payload, podium_message.raw_payload)
        "#,
    )
    .bind(conv_id)
    .bind(dir)
    .bind(ch)
    .bind(&body)
    .bind(staff_id)
    .bind(provider_message_uid)
    .bind(provider_response)
    .execute(&mut *tx)
    .await?;

    if let Some(uid) = provider_conversation_uid.as_deref() {
        sqlx::query(
            r#"
            UPDATE podium_sync_unmatched_conversation
            SET resolved_customer_id = $2,
                resolved_at = NOW(),
                match_status = 'resolved',
                resolution_note = 'Resolved by exact outbound provider conversation identity'
            WHERE provider_conversation_uid = $1 AND resolved_at IS NULL
            "#,
        )
        .bind(uid)
        .bind(customer_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Persist a provider reply for a conversation that is not yet linked to a ROS customer.
pub async fn record_outbound_message_for_conversation(
    pool: &PgPool,
    conversation_id: Uuid,
    channel: &str,
    body: &str,
    staff_id: Option<Uuid>,
    direction: &str,
    provider_message_uid: Option<&str>,
    provider_response: Option<&Value>,
) -> Result<(), sqlx::Error> {
    let dir = match direction {
        "automated" => "automated",
        _ => "outbound",
    };
    let ch = if channel == "email" { "email" } else { "sms" };
    let provider_conversation_uid = provider_response.and_then(|value| {
        text_at(
            value,
            &[
                "/conversation/uid",
                "/conversationUid",
                "/data/conversation/uid",
                "/data/conversationUid",
            ],
        )
    });
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE podium_conversation
        SET last_message_at = NOW(),
            podium_conversation_uid = COALESCE(podium_conversation_uid, $2),
            responder_staff_id = COALESCE(responder_staff_id, $3),
            responder_verified_at = CASE
                WHEN responder_staff_id IS NULL AND $3::uuid IS NOT NULL THEN NOW()
                ELSE responder_verified_at
            END,
            responder_selected_by_staff_id = COALESCE(responder_selected_by_staff_id, $3)
        WHERE id = $1
        "#,
    )
    .bind(conversation_id)
    .bind(provider_conversation_uid.as_deref())
    .bind(staff_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO podium_message (
            conversation_id, direction, channel, body, staff_id, podium_message_uid,
            raw_payload, podium_sender_name
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
        ON CONFLICT (podium_message_uid)
        WHERE podium_message_uid IS NOT NULL AND trim(podium_message_uid) <> ''
        DO UPDATE SET
            staff_id = COALESCE(EXCLUDED.staff_id, podium_message.staff_id),
            raw_payload = COALESCE(EXCLUDED.raw_payload, podium_message.raw_payload)
        "#,
    )
    .bind(conversation_id)
    .bind(dir)
    .bind(ch)
    .bind(body)
    .bind(staff_id)
    .bind(provider_message_uid)
    .bind(provider_response)
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

fn sender_uid(value: &Value) -> Option<String> {
    text_at(
        value,
        &[
            "/senderUid",
            "/sender/uid",
            "/data/senderUid",
            "/data/sender/uid",
            "/data/message/senderUid",
            "/data/message/sender/uid",
        ],
    )
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
            "/text",
            "/sendBody",
            "/snippet",
            "/preview",
            "/message/body",
            "/message/text",
            "/lastMessage/body",
            "/lastMessage/sendBody",
            "/lastItem/body",
            "/lastItem/sendBody",
            "/items/0/body",
            "/items/0/sendBody",
            "/data/body",
            "/data/text",
            "/data/sendBody",
            "/data/snippet",
            "/data/preview",
            "/data/message/body",
            "/data/message/text",
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
    for pointer in ["/closed", "/data/closed", "/conversation/closed"] {
        if let Some(closed) = value.pointer(pointer).and_then(Value::as_bool) {
            return Some(if closed { "closed" } else { "open" }.to_string());
        }
    }
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
            "/metadata/event_type",
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

async fn find_customer_for_conversation(
    pool: &PgPool,
    provider_conversation_uid: &str,
    channel: &str,
    identifier: Option<&str>,
) -> Result<CustomerIdentityMatch, sqlx::Error> {
    let linked_customer: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT customer_id
        FROM podium_conversation
        WHERE podium_conversation_uid = $1
          AND customer_id IS NOT NULL
        LIMIT 1
        "#,
    )
    .bind(provider_conversation_uid)
    .fetch_optional(pool)
    .await?
    .flatten();
    if let Some(customer_id) = linked_customer {
        return Ok(CustomerIdentityMatch::Unique(customer_id));
    }

    let manually_resolved: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT resolved_customer_id
        FROM podium_sync_unmatched_conversation
        WHERE provider_conversation_uid = $1
          AND resolved_customer_id IS NOT NULL
          AND resolved_at IS NOT NULL
        LIMIT 1
        "#,
    )
    .bind(provider_conversation_uid)
    .fetch_optional(pool)
    .await?
    .flatten();
    if let Some(customer_id) = manually_resolved {
        return Ok(CustomerIdentityMatch::Unique(customer_id));
    }

    let (phone, email) = if channel == "email" {
        (None, identifier)
    } else {
        (identifier, None)
    };
    podium_contacts::match_customer_identity(pool, phone, email).await
}

fn match_metadata(
    identity_match: &CustomerIdentityMatch,
) -> (&'static str, Vec<Uuid>, &'static str) {
    match identity_match {
        CustomerIdentityMatch::None => (
            "unmatched",
            Vec::new(),
            "No active Riverside customer matched the normalized Podium identifier",
        ),
        CustomerIdentityMatch::Ambiguous(ids) => (
            "ambiguous",
            ids.clone(),
            "Multiple active Riverside customers share the normalized Podium identifier",
        ),
        CustomerIdentityMatch::Unique(_) => ("resolved", Vec::new(), "Matched uniquely"),
    }
}

enum SyncMessageOutcome {
    Inserted,
    Matched,
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
    let identity_match =
        find_customer_for_conversation(pool, &conv_uid, &channel, identifier.as_deref()).await?;
    let customer_id = match &identity_match {
        CustomerIdentityMatch::Unique(customer_id) => Some(*customer_id),
        CustomerIdentityMatch::None | CustomerIdentityMatch::Ambiguous(_) => None,
    };
    if customer_id.is_none() {
        record_unmatched_conversation(
            pool,
            conversation,
            None,
            &conv_uid,
            &channel,
            identifier.as_deref(),
            &identity_match,
        )
        .await?;
    }
    let provider_status = provider_status(conversation);
    let provider_assignee_name = provider_assignee_name(conversation);
    sqlx::query(
        r#"
        INSERT INTO podium_conversation (
            customer_id, channel, podium_conversation_uid, contact_phone_e164, contact_email,
            last_message_at, sync_source, provider_status, provider_assignee_name
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'api_sync', $7, $8)
        ON CONFLICT (podium_conversation_uid)
        WHERE podium_conversation_uid IS NOT NULL AND trim(podium_conversation_uid) <> ''
        DO UPDATE SET
            customer_id = COALESCE(podium_conversation.customer_id, EXCLUDED.customer_id),
            last_message_at = GREATEST(podium_conversation.last_message_at, EXCLUDED.last_message_at),
            last_synced_at = NULL,
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
    if let Some(customer_id) = customer_id {
        resolve_unmatched_conversation_by_provider_uid(
            pool,
            &conv_uid,
            customer_id,
            "Resolved by collision-safe API synchronization",
        )
        .await?;
        Ok(SyncConversationOutcome::Matched)
    } else {
        Ok(SyncConversationOutcome::Unmatched)
    }
}

async fn mark_conversation_synced(
    pool: &PgPool,
    provider_conversation_uid: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE podium_conversation
        SET last_synced_at = NOW(),
            sync_source = 'api_sync'
        WHERE podium_conversation_uid = $1
        "#,
    )
    .bind(provider_conversation_uid)
    .execute(pool)
    .await?;
    Ok(())
}

async fn record_unmatched_conversation(
    pool: &PgPool,
    conversation: &Value,
    message: Option<&Value>,
    conv_uid: &str,
    channel: &str,
    identifier: Option<&str>,
    identity_match: &CustomerIdentityMatch,
) -> Result<(), sqlx::Error> {
    let (match_status, candidate_customer_ids, resolution_note) = match_metadata(identity_match);
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
            provider_conversation_uid, channel, identifier, last_message_at, snippet, raw_payload,
            match_status, candidate_customer_ids, resolution_note
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (provider_conversation_uid)
        DO UPDATE SET
            channel = EXCLUDED.channel,
            identifier = COALESCE(EXCLUDED.identifier, podium_sync_unmatched_conversation.identifier),
            last_message_at = COALESCE(EXCLUDED.last_message_at, podium_sync_unmatched_conversation.last_message_at),
            snippet = COALESCE(EXCLUDED.snippet, podium_sync_unmatched_conversation.snippet),
            raw_payload = EXCLUDED.raw_payload,
            match_status = EXCLUDED.match_status,
            candidate_customer_ids = EXCLUDED.candidate_customer_ids,
            resolution_note = EXCLUDED.resolution_note,
            resolved_customer_id = NULL,
            resolved_at = NULL,
            resolved_by_staff_id = NULL,
            last_seen_at = NOW()
        "#,
    )
    .bind(conv_uid)
    .bind(channel)
    .bind(identifier)
    .bind(last_at)
    .bind(snippet.as_deref())
    .bind(conversation)
    .bind(match_status)
    .bind(candidate_customer_ids)
    .bind(resolution_note)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn record_unmatched_webhook_identity(
    pool: &PgPool,
    payload: &Value,
    provider_conversation_uid: &str,
    channel: &str,
    identifier: Option<&str>,
    identity_match: &CustomerIdentityMatch,
) -> Result<(), sqlx::Error> {
    record_unmatched_conversation(
        pool,
        payload,
        Some(payload),
        provider_conversation_uid,
        channel,
        identifier,
        identity_match,
    )
    .await
}

async fn resolve_unmatched_conversation_by_provider_uid(
    pool: &PgPool,
    provider_conversation_uid: &str,
    customer_id: Uuid,
    note: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE podium_sync_unmatched_conversation
        SET resolved_customer_id = $2,
            resolved_at = COALESCE(resolved_at, NOW()),
            match_status = 'resolved',
            candidate_customer_ids = '{}'::uuid[],
            resolution_note = $3
        WHERE provider_conversation_uid = $1
        "#,
    )
    .bind(provider_conversation_uid)
    .bind(customer_id)
    .bind(note)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn resolve_unmatched_conversation(
    pool: &PgPool,
    unmatched_id: Uuid,
    customer_id: Uuid,
    staff_id: Option<Uuid>,
) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let customer_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1 AND is_active = TRUE)",
    )
    .bind(customer_id)
    .fetch_one(&mut *tx)
    .await?;
    if !customer_exists {
        return Ok(false);
    }

    let unmatched: Option<(String, String, Value)> = sqlx::query_as(
        r#"
        SELECT provider_conversation_uid, channel, raw_payload
        FROM podium_sync_unmatched_conversation
        WHERE id = $1 AND resolved_at IS NULL
        FOR UPDATE
        "#,
    )
    .bind(unmatched_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((provider_conversation_uid, channel, raw_payload)) = unmatched else {
        return Ok(false);
    };

    let updated = sqlx::query(
        r#"
        UPDATE podium_sync_unmatched_conversation
        SET resolved_customer_id = $2,
            resolved_at = NOW(),
            match_status = 'resolved',
            candidate_customer_ids = '{}'::uuid[],
            resolution_note = 'Resolved manually by an authorized staff member',
            resolved_by_staff_id = $3
        WHERE id = $1
          AND resolved_at IS NULL
        "#,
    )
    .bind(unmatched_id)
    .bind(customer_id)
    .bind(staff_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        UPDATE podium_conversation
        SET customer_id = $2
        WHERE podium_conversation_uid = $1
        "#,
    )
    .bind(&provider_conversation_uid)
    .bind(customer_id)
    .execute(&mut *tx)
    .await?;
    if channel == "sms"
        && body_text(&raw_payload)
            .as_deref()
            .is_some_and(crate::logic::podium_inbound::is_sms_opt_out_command)
    {
        let provider_message_uid = message_uid(&raw_payload);
        podium_contacts::apply_sms_opt_out_conn(
            tx.as_mut(),
            customer_id,
            provider_message_uid.as_deref(),
            &raw_payload,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(updated.rows_affected() == 1)
}

async fn upsert_synced_message(
    pool: &PgPool,
    conversation: &Value,
    message: &Value,
) -> Result<SyncMessageOutcome, sqlx::Error> {
    let Some(conv_uid) = conversation_uid(conversation)
        .or_else(|| text_at(message, &["/conversation/uid", "/data/conversation/uid"]))
    else {
        return Err(sqlx::Error::Protocol(
            "Podium message is missing its conversation UID".to_string(),
        ));
    };
    let channel = channel_type(message);
    let identifier = channel_identifier(message).or_else(|| channel_identifier(conversation));
    let identity_match =
        find_customer_for_conversation(pool, &conv_uid, &channel, identifier.as_deref()).await?;
    let customer_id = match &identity_match {
        CustomerIdentityMatch::Unique(customer_id) => Some(*customer_id),
        CustomerIdentityMatch::None | CustomerIdentityMatch::Ambiguous(_) => None,
    };
    if customer_id.is_none() {
        record_unmatched_conversation(
            pool,
            conversation,
            Some(message),
            &conv_uid,
            &channel,
            identifier.as_deref(),
            &identity_match,
        )
        .await?;
    }
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
    let podium_sender_uid = sender_uid(message);
    let sender = text_at(
        message,
        &["/sender/name", "/sender/displayName", "/data/sender/name"],
    );
    let provider_status = provider_status(conversation);
    let provider_assignee_name = provider_assignee_name(conversation);
    let mut tx = pool.begin().await?;
    let conv_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO podium_conversation (
            customer_id, channel, podium_conversation_uid, contact_phone_e164, contact_email,
            last_message_at, sync_source, provider_status, provider_assignee_name
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'api_sync', $7, $8)
        ON CONFLICT (podium_conversation_uid)
        WHERE podium_conversation_uid IS NOT NULL AND trim(podium_conversation_uid) <> ''
        DO UPDATE SET
            customer_id = COALESCE(podium_conversation.customer_id, EXCLUDED.customer_id),
            last_message_at = GREATEST(podium_conversation.last_message_at, EXCLUDED.last_message_at),
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
    let mapped_staff_id: Option<Uuid> = if let Some(uid) = podium_sender_uid.as_deref() {
        sqlx::query_scalar(
            "SELECT id FROM staff WHERE podium_user_uid = $1 AND is_active = TRUE LIMIT 1",
        )
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await?
    } else {
        None
    };

    let inserted = sqlx::query_scalar::<_, Option<Uuid>>(
        r#"
        INSERT INTO podium_message (
            conversation_id, direction, channel, body, podium_message_uid, raw_payload,
            podium_sender_name, podium_sender_uid, staff_id, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (podium_message_uid)
        WHERE podium_message_uid IS NOT NULL AND trim(podium_message_uid) <> ''
        DO NOTHING
        RETURNING id
        "#,
    )
    .bind(conv_id)
    .bind(&direction)
    .bind(&channel)
    .bind(&body)
    .bind(msg_uid.as_ref())
    .bind(message)
    .bind(sender.as_deref())
    .bind(podium_sender_uid.as_deref())
    .bind(mapped_staff_id)
    .bind(created_at)
    .fetch_optional(&mut *tx)
    .await?;
    let was_inserted = inserted.flatten().is_some();
    if was_inserted
        && direction == "inbound"
        && channel == "sms"
        && crate::logic::podium_inbound::is_sms_opt_out_command(&body)
    {
        if let Some(customer_id) = customer_id {
            podium_contacts::apply_sms_opt_out_conn(
                tx.as_mut(),
                customer_id,
                msg_uid.as_deref(),
                message,
            )
            .await?;
        }
    }
    if let Some(customer_id) = customer_id {
        sqlx::query(
            r#"
            UPDATE podium_sync_unmatched_conversation
            SET resolved_customer_id = $2,
                resolved_at = COALESCE(resolved_at, NOW()),
                match_status = 'resolved',
                candidate_customer_ids = '{}'::uuid[],
                resolution_note = 'Resolved by collision-safe message synchronization'
            WHERE provider_conversation_uid = $1
            "#,
        )
        .bind(&conv_uid)
        .bind(customer_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(if was_inserted {
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
        podium::fetch_podium_conversations(pool, http, token_cache, limit.clamp(1, 500)).await?;
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
        match upsert_synced_conversation_shell(pool, &conversation).await {
            Ok(SyncConversationOutcome::Matched) => {
                result.conversations_matched += 1;
            }
            Ok(SyncConversationOutcome::Unmatched) => {
                result.conversations_unmatched += 1;
            }
            Err(err) => {
                result.errors.push(format!("{uid}: {err}"));
                continue;
            }
        }
        let embedded = embedded_messages(&conversation);
        let messages = if embedded.is_empty() {
            match podium::fetch_podium_conversation_messages(pool, http, token_cache, &uid, 50)
                .await
            {
                Ok(messages) => messages,
                Err(err) => {
                    result.errors.push(format!("{uid}: {err}"));
                    continue;
                }
            }
        } else {
            embedded
        };
        let mut history_complete = true;
        for message in messages {
            result.messages_seen += 1;
            match upsert_synced_message(pool, &conversation, &message).await {
                Ok(SyncMessageOutcome::Inserted) => {
                    result.messages_inserted += 1;
                }
                Ok(SyncMessageOutcome::Matched) => {}
                Err(err) => {
                    history_complete = false;
                    result.errors.push(format!("{uid}: {err}"));
                }
            }
        }
        if history_complete {
            if let Err(err) = mark_conversation_synced(pool, &uid).await {
                result.errors.push(format!("{uid}: {err}"));
            }
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
                COALESCE(s.full_name, podium_staff.full_name, pm.podium_sender_name) AS actor,
                pm.created_at AS occurred_at
            FROM podium_message pm
            JOIN podium_conversation pc ON pc.id = pm.conversation_id
            LEFT JOIN staff s ON s.id = pm.staff_id
            LEFT JOIN staff podium_staff
              ON pm.staff_id IS NULL
             AND pm.podium_sender_uid IS NOT NULL
             AND podium_staff.podium_user_uid = pm.podium_sender_uid
             AND podium_staff.is_active = TRUE
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_text_reads_documented_webhook_message_envelope() {
        let payload = serde_json::json!({
            "data": { "message": { "body": "STOP" } }
        });

        assert_eq!(body_text(&payload).as_deref(), Some("STOP"));
    }

    #[test]
    fn message_direction_accepts_snake_case_metadata() {
        let payload = serde_json::json!({
            "metadata": { "event_type": "message.received" }
        });

        assert_eq!(message_direction(&payload), "inbound");
    }

    #[test]
    fn provider_status_reads_documented_closed_flag() {
        assert_eq!(
            provider_status(&json!({ "closed": true })).as_deref(),
            Some("closed")
        );
        assert_eq!(
            provider_status(&json!({ "closed": false })).as_deref(),
            Some("open")
        );
    }
}
