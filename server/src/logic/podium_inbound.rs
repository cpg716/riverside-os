//! Inbound Podium webhook → CRM conversation rows, optional customer match, optional welcome SMS.

use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::auth::permissions::NOTIFICATIONS_VIEW;
use crate::logic::notifications::staff_ids_with_permission;
use crate::logic::podium::{
    load_store_podium_config, normalize_phone_e164, send_podium_sms_message_tracked,
    PodiumTokenCache,
};
use crate::logic::podium_contacts::{self, CustomerIdentityMatch};
use crate::logic::podium_messaging;

fn extract_text(value: &Value, paths: &[&str]) -> Option<String> {
    for p in paths {
        if let Some(s) = value.pointer(p).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn extract_message_uid(value: &Value) -> Option<String> {
    extract_text(
        value,
        &[
            "/data/uid",
            "/data/id",
            "/uid",
            "/id",
            "/message/uid",
            "/data/message/uid",
        ],
    )
}

fn extract_conversation_uid(value: &Value) -> Option<String> {
    extract_text(
        value,
        &[
            "/data/conversationUid",
            "/conversationUid",
            "/data/conversation/uid",
            "/conversation/uid",
        ],
    )
}

fn extract_phone_raw(value: &Value) -> Option<String> {
    extract_text(
        value,
        &[
            "/data/from/phoneNumber",
            "/data/phoneNumber",
            "/fromPhone",
            "/phoneNumber",
            "/data/contact/phoneNumber",
            "/sender/phoneNumber",
        ],
    )
    .or_else(|| {
        let channel_type = extract_text(
            value,
            &[
                "/data/conversation/channel/type",
                "/conversation/channel/type",
            ],
        )
        .unwrap_or_default()
        .to_ascii_lowercase();
        extract_text(
            value,
            &[
                "/data/conversation/channel/identifier",
                "/conversation/channel/identifier",
            ],
        )
        .filter(|identifier| {
            !identifier.contains('@')
                && (channel_type.is_empty()
                    || channel_type.contains("phone")
                    || channel_type.contains("sms"))
        })
    })
}

fn extract_email_raw(value: &Value) -> Option<String> {
    extract_text(
        value,
        &[
            "/data/from/email",
            "/data/email",
            "/fromEmail",
            "/email",
            "/data/contact/email",
            "/sender/email",
        ],
    )
    .or_else(|| {
        let channel_type = extract_text(
            value,
            &[
                "/data/conversation/channel/type",
                "/conversation/channel/type",
            ],
        )
        .unwrap_or_default()
        .to_ascii_lowercase();
        extract_text(
            value,
            &[
                "/data/conversation/channel/identifier",
                "/conversation/channel/identifier",
            ],
        )
        .filter(|identifier| identifier.contains('@') || channel_type.contains("email"))
    })
}

fn detect_channel(value: &Value, has_phone: bool, has_email: bool) -> &'static str {
    let ch = extract_text(
        value,
        &[
            "/data/conversation/channel/type",
            "/conversation/channel/type",
            "/channel",
            "/data/channel",
            "/type",
        ],
    )
    .unwrap_or_default();
    let c = ch.to_ascii_lowercase();
    if c.contains("email") || (!has_phone && has_email) {
        "email"
    } else {
        "sms"
    }
}

/// `true` when Podium indicates a staff/system outbound message (e.g. `message.sent`), not the customer.
fn podium_webhook_is_outbound(value: &Value) -> bool {
    let classify = |s: &str| -> Option<bool> {
        let l = s.to_ascii_lowercase();
        if l.contains("message.sent") || l.contains("message.failed") || l == "sent" {
            return Some(true);
        }
        if l.contains("message.received") {
            return Some(false);
        }
        None
    };
    for ptr in [
        "/type",
        "/event",
        "/eventType",
        "/event_type",
        "/data/type",
        "/data/event",
        "/data/eventType",
        "/data/event_type",
        "/metadata/eventType",
        "/metadata/event_type",
    ] {
        if let Some(s) = value.pointer(ptr).and_then(|v| v.as_str()) {
            if let Some(out) = classify(s) {
                return out;
            }
        }
    }
    if let Some(s) = value
        .pointer("/data/items/0/sourceType")
        .and_then(|v| v.as_str())
    {
        match s.to_ascii_lowercase().as_str() {
            "outbound" => return true,
            "inbound" => return false,
            _ => {}
        }
    }
    for ptr in ["/data/direction", "/data/message/direction", "/direction"] {
        if let Some(s) = value.pointer(ptr).and_then(|v| v.as_str()) {
            match s.to_ascii_lowercase().as_str() {
                "outbound" => return true,
                "inbound" => return false,
                _ => {}
            }
        }
    }
    false
}

/// Display name for Podium Web / app senders (not ROS `staff` rows).
fn extract_podium_outbound_sender_name(value: &Value) -> Option<String> {
    let paths = [
        "/data/sender/name",
        "/data/sender/displayName",
        "/data/user/name",
        "/data/user/displayName",
        "/data/author/name",
        "/data/employee/name",
        "/data/agent/name",
        "/data/staffMember/name",
        "/data/staff/name",
        "/data/fromUser/name",
        "/data/createdBy/name",
        "/sender/name",
        "/data/message/sender/name",
    ];
    for p in paths {
        if let Some(s) = extract_text(value, &[p]) {
            let t = s.trim();
            if (2..=200).contains(&t.len()) {
                return Some(t.to_string());
            }
        }
    }
    if let (Some(a), Some(b)) = (
        extract_text(value, &["/data/sender/firstName"]),
        extract_text(value, &["/data/sender/lastName"]),
    ) {
        let n = format!("{} {}", a.trim(), b.trim()).trim().to_string();
        if n.len() >= 2 {
            return Some(n);
        }
    }
    None
}

fn extract_podium_sender_uid(value: &Value) -> Option<String> {
    extract_text(
        value,
        &[
            "/data/senderUid",
            "/senderUid",
            "/data/sender/uid",
            "/sender/uid",
            "/data/message/senderUid",
            "/data/message/sender/uid",
        ],
    )
}

pub(crate) fn is_sms_opt_out_command(body: &str) -> bool {
    matches!(
        body.trim().to_ascii_uppercase().as_str(),
        "STOP" | "STOPALL" | "UNSUBSCRIBE" | "CANCEL" | "END" | "QUIT" | "OPT OUT"
    )
}

async fn message_uid_exists(pool: &PgPool, uid: &str) -> Result<bool, sqlx::Error> {
    let v: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(SELECT 1 FROM podium_message WHERE podium_message_uid = $1)"#,
    )
    .bind(uid)
    .fetch_one(pool)
    .await?;
    Ok(v)
}

async fn insert_conversation_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    customer_id: Option<Uuid>,
    channel: &str,
    podium_uid: Option<String>,
    phone: Option<String>,
    email: Option<String>,
) -> Result<Uuid, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        INSERT INTO podium_conversation (
            customer_id, channel, podium_conversation_uid, contact_phone_e164, contact_email
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        "#,
    )
    .bind(customer_id)
    .bind(channel)
    .bind(podium_uid.as_ref())
    .bind(phone.as_ref())
    .bind(email.as_ref())
    .fetch_one(&mut **tx)
    .await
}

async fn try_apply_name_capture(pool: &PgPool, customer_id: Uuid, body: &str) {
    let pending: Option<bool> =
        sqlx::query_scalar("SELECT podium_name_capture_pending FROM customers WHERE id = $1")
            .bind(customer_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();

    if pending != Some(true) {
        return;
    }

    let words: Vec<&str> = body
        .split_whitespace()
        .filter(|w| w.len() < 80)
        .take(6)
        .collect();
    if words.len() >= 2 {
        let first = words[0].trim();
        let last = words[1].trim();
        if first.len() >= 2 && last.len() >= 2 {
            let _ = sqlx::query(
                r#"
                UPDATE customers SET
                    first_name = $2,
                    last_name = $3,
                    podium_name_capture_pending = false
                WHERE id = $1
                "#,
            )
            .bind(customer_id)
            .bind(first)
            .bind(last)
            .execute(pool)
            .await;
        }
    }
}

fn truncate_body_preview(body: &str) -> String {
    let mut s = body.trim().to_string();
    if s.len() > 280 {
        s.truncate(280);
        s.push('…');
    }
    s
}

fn podium_inbox_deep_link(
    customer_id: Option<Uuid>,
    conversation_id: Uuid,
    channel: &str,
) -> Value {
    let mut link = json!({
        "type": "podium_inbox",
        "conversation_id": conversation_id.to_string(),
        "message_channel": channel,
    });
    if let Some(customer_id) = customer_id {
        link["customer_id"] = Value::String(customer_id.to_string());
    }
    link
}

/// After `podium_webhook_delivery` ledger insert: thread rows + notification fan-out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PodiumInboundIngestOutcome {
    Processed,
    Skipped,
}

pub async fn ingest_from_webhook(
    pool: &PgPool,
    http: &reqwest::Client,
    token_cache: &Arc<Mutex<PodiumTokenCache>>,
    value: &Value,
) -> Result<PodiumInboundIngestOutcome, sqlx::Error> {
    let body = match extract_text(
        value,
        &[
            "/body",
            "/text",
            "/data/body",
            "/message/body",
            "/data/message/body",
            "/data/text",
        ],
    ) {
        Some(b) => b,
        None => {
            tracing::debug!(target = "podium_inbound", event = "no_body_skipping_ingest");
            return Ok(PodiumInboundIngestOutcome::Skipped);
        }
    };

    let is_outbound = podium_webhook_is_outbound(value);
    let podium_sender_name = if is_outbound {
        extract_podium_outbound_sender_name(value)
    } else {
        None
    };
    let podium_sender_uid = if is_outbound {
        extract_podium_sender_uid(value)
    } else {
        None
    };

    let phone_raw = extract_phone_raw(value);
    let email_raw = extract_email_raw(value);
    let e164 = phone_raw.as_deref().and_then(normalize_phone_e164);
    let email = email_raw
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());

    let channel = detect_channel(value, e164.is_some(), email.is_some());
    let is_opt_out = !is_outbound && channel == "sms" && is_sms_opt_out_command(&body);

    if e164.is_none() && email.is_none() {
        tracing::warn!(target = "podium_inbound", event = "no_contact_skipping");
        return Ok(PodiumInboundIngestOutcome::Skipped);
    }

    let msg_uid = extract_message_uid(value);
    let conv_uid = extract_conversation_uid(value);

    if let Some(ref uid) = msg_uid {
        match message_uid_exists(pool, uid).await {
            Ok(true) => return Ok(PodiumInboundIngestOutcome::Skipped),
            Ok(false) => {}
            Err(e) => {
                tracing::error!(error = %e, "podium_inbound msg dedupe");
                return Err(e);
            }
        }
    }

    let linked_customer: Option<Uuid> = if let Some(ref uid) = conv_uid {
        sqlx::query_scalar(
            r#"
            SELECT customer_id
            FROM podium_conversation
            WHERE podium_conversation_uid = $1
              AND customer_id IS NOT NULL
            LIMIT 1
            "#,
        )
        .bind(uid)
        .fetch_optional(pool)
        .await?
        .flatten()
    } else {
        None
    };
    let identity_match = if let Some(customer_id) = linked_customer {
        CustomerIdentityMatch::Unique(customer_id)
    } else {
        podium_contacts::match_customer_identity(
            pool,
            e164.as_deref().or(phone_raw.as_deref()),
            email.as_deref(),
        )
        .await?
    };
    let customer_id: Option<Uuid> = match &identity_match {
        CustomerIdentityMatch::Unique(customer_id) => Some(*customer_id),
        CustomerIdentityMatch::None | CustomerIdentityMatch::Ambiguous(_) => None,
    };

    if customer_id.is_none() {
        if let Some(ref uid) = conv_uid {
            let identifier = if channel == "email" {
                email.as_deref()
            } else {
                e164.as_deref().or(phone_raw.as_deref())
            };
            podium_messaging::record_unmatched_webhook_identity(
                pool,
                value,
                uid,
                channel,
                identifier,
                &identity_match,
            )
            .await?;
        }
        tracing::warn!(
            target = "podium_inbound",
            event = "unlinked_customer_identity",
            uid = ?msg_uid,
            channel,
            "Storing Podium message without adding or choosing a Riverside customer"
        );
    } else if let Some(cid) = customer_id {
        if !is_outbound {
            try_apply_name_capture(pool, cid, &body).await;
        }
    }

    let notification_customer_name = if is_outbound || customer_id.is_none() {
        None
    } else {
        let (first_name, last_name): (String, String) =
            sqlx::query_as("SELECT first_name, last_name FROM customers WHERE id = $1")
                .bind(customer_id.expect("customer checked above"))
                .fetch_one(pool)
                .await?;
        let full_name = format!("{} {}", first_name.trim(), last_name.trim())
            .trim()
            .to_string();
        Some(if full_name.is_empty() {
            "Customer".to_string()
        } else {
            full_name
        })
    };

    if is_opt_out && customer_id.is_some() {
        let customer_id = customer_id.expect("customer checked above");
        podium_contacts::apply_sms_opt_out(pool, customer_id, msg_uid.as_deref(), value).await?;
        tracing::info!(
            target = "podium_inbound",
            customer_id = %customer_id,
            "Customer opted out of SMS using an exact recognized command"
        );
    }

    let mut tx = match pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "podium_inbound tx begin");
            return Err(e);
        }
    };

    let conv_id = if let Some(ref cu) = conv_uid {
        let existing: Option<Uuid> = match sqlx::query_scalar(
            r#"SELECT id FROM podium_conversation WHERE podium_conversation_uid = $1"#,
        )
        .bind(cu)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(error = %e, "podium conversation lookup");
                let _ = tx.rollback().await;
                return Err(e);
            }
        };

        if let Some(id) = existing {
            if let Err(e) = sqlx::query(
                r#"
                UPDATE podium_conversation
                SET last_message_at = NOW(),
                    customer_id = COALESCE(customer_id, $2)
                WHERE id = $1
                "#,
            )
            .bind(id)
            .bind(customer_id)
            .execute(&mut *tx)
            .await
            {
                tracing::error!(error = %e, "podium conversation touch");
                let _ = tx.rollback().await;
                return Err(e);
            }
            id
        } else {
            match insert_conversation_tx(
                &mut tx,
                customer_id,
                channel,
                Some(cu.clone()),
                e164.clone(),
                email.clone(),
            )
            .await
            {
                Ok(id) => id,
                Err(e) => {
                    tracing::error!(error = %e, "insert podium_conversation");
                    let _ = tx.rollback().await;
                    return Err(e);
                }
            }
        }
    } else {
        let existing: Option<Uuid> = match sqlx::query_scalar(
            r#"
            SELECT id FROM podium_conversation
            WHERE channel = $1
              AND (
                ($2::uuid IS NOT NULL AND customer_id = $2)
                OR (
                    $2::uuid IS NULL
                    AND customer_id IS NULL
                    AND (
                        ($1 = 'sms' AND contact_phone_e164 = $3)
                        OR ($1 = 'email' AND contact_email = $4)
                    )
                )
              )
            ORDER BY last_message_at DESC
            LIMIT 1
            "#,
        )
        .bind(channel)
        .bind(customer_id)
        .bind(e164.as_deref().or(phone_raw.as_deref()))
        .bind(email.as_deref())
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(error = %e, "podium conversation by customer");
                let _ = tx.rollback().await;
                return Err(e);
            }
        };

        match existing {
            Some(id) => {
                if let Err(e) = sqlx::query(
                    r#"UPDATE podium_conversation SET last_message_at = NOW() WHERE id = $1"#,
                )
                .bind(id)
                .execute(&mut *tx)
                .await
                {
                    tracing::error!(error = %e, "podium conversation touch");
                    let _ = tx.rollback().await;
                    return Err(e);
                }
                id
            }
            None => match insert_conversation_tx(
                &mut tx,
                customer_id,
                channel,
                None,
                e164.clone(),
                email.clone(),
            )
            .await
            {
                Ok(id) => id,
                Err(e) => {
                    tracing::error!(error = %e, "insert podium_conversation");
                    let _ = tx.rollback().await;
                    return Err(e);
                }
            },
        }
    };

    let msg_direction = if is_outbound { "outbound" } else { "inbound" };
    let mapped_staff_id: Option<Uuid> = if let Some(uid) = podium_sender_uid.as_deref() {
        match sqlx::query_scalar(
            "SELECT id FROM staff WHERE podium_user_uid = $1 AND is_active = TRUE LIMIT 1",
        )
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(id) => id,
            Err(e) => {
                tracing::warn!(error = %e, podium_sender_uid = %uid, "podium sender staff lookup failed");
                None
            }
        }
    } else {
        None
    };

    if let Err(e) = sqlx::query(
        r#"
        INSERT INTO podium_message (
            conversation_id, direction, channel, body, podium_message_uid, raw_payload,
            podium_sender_name, podium_sender_uid, staff_id
        )
        VALUES ($1, $6, $2, $3, $4, $5, $7, $8, $9)
        "#,
    )
    .bind(conv_id)
    .bind(channel)
    .bind(&body)
    .bind(msg_uid.as_ref())
    .bind(value)
    .bind(msg_direction)
    .bind(podium_sender_name.as_deref())
    .bind(podium_sender_uid.as_deref())
    .bind(mapped_staff_id)
    .execute(&mut *tx)
    .await
    {
        tracing::error!(error = %e, "insert podium_message");
        let _ = tx.rollback().await;
        return Err(e);
    }

    let should_send_unknown_welcome =
        if customer_id.is_none() && !is_outbound && !is_opt_out && channel == "sms" {
            sqlx::query_scalar::<_, i64>(
                r#"
            SELECT COUNT(*)
            FROM podium_message
            WHERE conversation_id = $1
              AND direction = 'inbound'
            "#,
            )
            .bind(conv_id)
            .fetch_one(&mut *tx)
            .await?
                == 1
        } else {
            false
        };

    if let Err(e) = tx.commit().await {
        tracing::error!(error = %e, "podium_inbound commit");
        return Err(e);
    }

    if should_send_unknown_welcome {
        let pool_c = pool.clone();
        let http_c = http.clone();
        let cache_c = Arc::clone(token_cache);
        let to_phone = e164.clone().or_else(|| phone_raw.clone());
        let welcome_conversation_id = conv_id;
        tokio::spawn(async move {
            if let Some(ref ph) = to_phone {
                let tpl = load_store_podium_config(&pool_c)
                    .await
                    .ok()
                    .filter(|c| c.sms_features.unknown_sender_welcome)
                    .map(|c| c.templates.merged_defaults().unknown_sender_welcome)
                    .unwrap_or_default();
                let tpl_t = tpl.trim();
                if !tpl_t.is_empty() {
                    match send_podium_sms_message_tracked(&pool_c, &http_c, &cache_c, ph, tpl_t)
                        .await
                    {
                        Ok(send_result) => {
                            if let Err(e) =
                                podium_messaging::record_outbound_message_for_conversation(
                                    &pool_c,
                                    welcome_conversation_id,
                                    "sms",
                                    tpl_t,
                                    None,
                                    "automated",
                                    send_result.provider_message_id.as_deref(),
                                    Some(&send_result.raw_response),
                                )
                                .await
                            {
                                tracing::error!(error = %e, conversation_id = %welcome_conversation_id, "record welcome SMS to podium_message");
                            }
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "podium welcome sms skipped");
                        }
                    }
                }
            }
        });
    }

    if !is_outbound {
        let bundle_kind = if channel == "email" {
            "podium_email_bundle"
        } else {
            "podium_sms_bundle"
        };
        let channel_label = if channel == "email" {
            "Podium email"
        } else {
            "Podium SMS"
        };
        let customer_name = notification_customer_name
            .as_deref()
            .unwrap_or("Unknown sender");
        let bundle_prefix = format!("{channel_label} from {customer_name}");

        let dedupe = customer_id
            .map(|customer_id| format!("podium_inbound:{customer_id}"))
            .unwrap_or_else(|| format!("podium_inbound_conversation:{conv_id}"));
        let item_deep = podium_inbox_deep_link(customer_id, conv_id, channel);

        if let Ok(nid) = crate::logic::notifications::upsert_bundle_item(
            pool,
            bundle_kind,
            &bundle_prefix,
            "New message",
            &truncate_body_preview(&body),
            item_deep,
            "podium_inbound",
            json!({}),
            &dedupe,
        )
        .await
        {
            if let Ok(staff) = staff_ids_with_permission(pool, NOTIFICATIONS_VIEW).await {
                let _ = crate::logic::notifications::fan_out_notification_to_staff_ids(
                    pool, nid, &staff,
                )
                .await;
            }
        }
    }
    Ok(PodiumInboundIngestOutcome::Processed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documented_phone_message_envelope_is_classified() {
        let value = serde_json::json!({
            "data": {
                "conversation": {
                    "channel": { "identifier": "+18015551212", "type": "phone" },
                    "uid": "conversation-1"
                },
                "uid": "message-1"
            },
            "metadata": { "eventType": "message.received", "eventUid": "event-1" }
        });

        assert_eq!(extract_phone_raw(&value).as_deref(), Some("+18015551212"));
        assert_eq!(extract_email_raw(&value), None);
        assert_eq!(detect_channel(&value, true, false), "sms");
        assert!(!podium_webhook_is_outbound(&value));
    }

    #[test]
    fn snake_case_message_envelope_is_classified() {
        let value = serde_json::json!({
            "data": {
                "conversation": {
                    "channel": { "identifier": "+18015551212", "type": "phone" },
                    "uid": "conversation-1"
                },
                "uid": "message-1"
            },
            "metadata": { "event_type": "message.received", "event_uid": "event-1" }
        });

        assert!(!podium_webhook_is_outbound(&value));
    }

    #[test]
    fn documented_email_message_envelope_is_classified() {
        let value = serde_json::json!({
            "data": {
                "conversation": {
                    "channel": { "identifier": "customer@example.com", "type": "email" }
                }
            },
            "metadata": { "eventType": "message.sent" }
        });

        assert_eq!(extract_phone_raw(&value), None);
        assert_eq!(
            extract_email_raw(&value).as_deref(),
            Some("customer@example.com")
        );
        assert_eq!(detect_channel(&value, false, true), "email");
        assert!(podium_webhook_is_outbound(&value));
    }

    #[test]
    fn documented_failed_message_is_outbound() {
        let value = serde_json::json!({
            "data": {
                "conversation": {
                    "channel": { "identifier": "+18015551212", "type": "phone" }
                },
                "failureReason": "landline"
            },
            "metadata": { "eventType": "message.failed", "eventUid": "event-1" }
        });

        assert!(podium_webhook_is_outbound(&value));
    }

    #[test]
    fn sms_opt_out_requires_an_exact_recognized_command() {
        assert!(is_sms_opt_out_command(" STOP "));
        assert!(is_sms_opt_out_command("opt out"));
        assert!(!is_sms_opt_out_command("Please stop by tomorrow"));
        assert!(!is_sms_opt_out_command("Do not stop my order"));
    }

    #[test]
    fn inbound_notification_targets_the_exact_podium_conversation() {
        let customer_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let link = podium_inbox_deep_link(Some(customer_id), conversation_id, "sms");

        assert_eq!(link["type"], "podium_inbox");
        assert_eq!(link["customer_id"], customer_id.to_string());
        assert_eq!(link["conversation_id"], conversation_id.to_string());
        assert_eq!(link["message_channel"], "sms");
    }

    #[test]
    fn unknown_sender_notification_targets_the_thread_without_inventing_a_customer() {
        let conversation_id = Uuid::new_v4();
        let link = podium_inbox_deep_link(None, conversation_id, "sms");

        assert_eq!(link["type"], "podium_inbox");
        assert!(link.get("customer_id").is_none());
        assert_eq!(link["conversation_id"], conversation_id.to_string());
    }
}
