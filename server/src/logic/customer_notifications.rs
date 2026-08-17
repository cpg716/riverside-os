use chrono::Utc;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::permissions::CUSTOMERS_HUB_EDIT;
use crate::logic::notifications::{
    delete_app_notification_by_dedupe, fan_out_notification_to_staff_ids,
    insert_app_notification_deduped, staff_ids_with_permission,
};

#[derive(Debug, Clone, Copy)]
pub enum CustomerNotificationKind {
    ReadyForPickup,
    AlterationReady,
    AppointmentConfirmation,
    AppointmentReminder,
    AppointmentCancellation,
    Receipt,
    UnknownSenderWelcome,
    ReviewInvite,
}

impl CustomerNotificationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadyForPickup => "ready_for_pickup",
            Self::AlterationReady => "alteration_ready",
            Self::AppointmentConfirmation => "appointment_confirmation",
            Self::AppointmentReminder => "appointment_reminder",
            Self::AppointmentCancellation => "appointment_cancellation",
            Self::Receipt => "receipt",
            Self::UnknownSenderWelcome => "unknown_sender_welcome",
            Self::ReviewInvite => "review_invite",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum CustomerNotificationChannel {
    Sms,
    Email,
    Both,
}

impl CustomerNotificationChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sms => "sms",
            Self::Email => "email",
            Self::Both => "both",
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn record_customer_notification(
    pool: &PgPool,
    customer_id: Uuid,
    entity_type: &str,
    entity_id: Uuid,
    kind: CustomerNotificationKind,
    channel: CustomerNotificationChannel,
    body_preview: Option<&str>,
    delivery_error: Option<&str>,
    metadata: Value,
) -> Result<Uuid, sqlx::Error> {
    let delivery_status = if delivery_error.is_some() {
        "failed"
    } else {
        "delivered"
    };
    record_customer_notification_with_status(
        pool,
        customer_id,
        entity_type,
        entity_id,
        kind,
        channel,
        body_preview,
        delivery_status,
        delivery_error,
        metadata,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn record_customer_notification_with_status(
    pool: &PgPool,
    customer_id: Uuid,
    entity_type: &str,
    entity_id: Uuid,
    kind: CustomerNotificationKind,
    channel: CustomerNotificationChannel,
    body_preview: Option<&str>,
    delivery_status: &str,
    delivery_error: Option<&str>,
    metadata: Value,
) -> Result<Uuid, sqlx::Error> {
    let metadata = metadata
        .as_object()
        .cloned()
        .map(|mut object| {
            if let Some(preview) = body_preview.map(str::trim).filter(|s| !s.is_empty()) {
                object.insert("body_preview".to_string(), json!(preview.chars().take(500).collect::<String>()));
            }
            Value::Object(object)
        })
        .unwrap_or_else(|| {
            json!({
                "body_preview": body_preview.unwrap_or_default().chars().take(500).collect::<String>()
            })
        });

    let mut tx = pool.begin().await?;
    let notification_id = sqlx::query_scalar(
        r#"
        INSERT INTO customer_notification_queue (
            entity_type,
            entity_id,
            customer_id,
            kind,
            status,
            delivery_method,
            delivery_status,
            delivery_error,
            metadata,
            sent_at
        )
        VALUES ($1, $2, $3, $4, 'sent', $5, $6, $7, $8, NOW())
        RETURNING id
        "#,
    )
    .bind(entity_type)
    .bind(entity_id)
    .bind(customer_id)
    .bind(kind.as_str())
    .bind(channel.as_str())
    .bind(delivery_status)
    .bind(delivery_error)
    .bind(metadata)
    .fetch_one(&mut *tx)
    .await?;

    let resolved_notification_ids = if delivery_status == "delivered" {
        sqlx::query_scalar(
            r#"
            UPDATE customer_notification_queue
            SET reviewed_at = COALESCE(reviewed_at, NOW()),
                review_note = COALESCE(
                    review_note,
                    'Resolved automatically after a successful delivery.'
                ),
                updated_at = NOW()
            WHERE id <> $1
              AND customer_id = $2
              AND entity_type = $3
              AND entity_id = $4
              AND kind = $5
              AND delivery_method = $6
              AND delivery_status = 'failed'
              AND reviewed_at IS NULL
            RETURNING id
            "#,
        )
        .bind(notification_id)
        .bind(customer_id)
        .bind(entity_type)
        .bind(entity_id)
        .bind(kind.as_str())
        .bind(channel.as_str())
        .fetch_all(&mut *tx)
        .await?
    } else {
        Vec::new()
    };

    tx.commit().await?;

    if delivery_status == "failed" {
        if let Err(error) = emit_customer_contact_failure_alert(
            pool,
            notification_id,
            customer_id,
            channel,
            delivery_error.unwrap_or("Customer message delivery failed."),
        )
        .await
        {
            tracing::error!(
                %error,
                %notification_id,
                %customer_id,
                "Could not create customer contact failure alert"
            );
        }
    } else if delivery_status == "delivered" {
        clear_customer_contact_failure_alerts(pool, &resolved_notification_ids).await;
    }

    Ok(notification_id)
}

async fn clear_customer_contact_failure_alerts(pool: &PgPool, notification_ids: &[Uuid]) {
    for notification_id in notification_ids {
        let dedupe_key = format!("customer_contact_delivery_failed:{notification_id}");
        if let Err(error) = delete_app_notification_by_dedupe(pool, &dedupe_key).await {
            tracing::error!(
                %error,
                %notification_id,
                "Could not clear resolved customer contact failure alert"
            );
        }
    }
}

fn customer_notification_channel(method: &str) -> Option<CustomerNotificationChannel> {
    match method {
        "sms" => Some(CustomerNotificationChannel::Sms),
        "email" => Some(CustomerNotificationChannel::Email),
        "both" => Some(CustomerNotificationChannel::Both),
        _ => None,
    }
}

/// Persist a queued notification's provider result and keep its recovery alert in sync.
pub async fn mark_customer_notification_delivery_result(
    pool: &PgPool,
    notification_id: Uuid,
    delivery_method: &str,
    delivery_status: &str,
    delivery_error: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let prior: Option<(Uuid, String, Uuid, String, String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT customer_id, entity_type, entity_id, kind, delivery_method, delivery_status
        FROM customer_notification_queue
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(notification_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((customer_id, entity_type, entity_id, kind, prior_method, prior_status)) = prior
    else {
        tx.rollback().await?;
        return Ok(false);
    };
    let effective_method = if customer_notification_channel(delivery_method).is_some() {
        delivery_method
    } else {
        prior_method.as_str()
    };
    let marked: bool = sqlx::query_scalar("SELECT mark_notification_sent($1, $2, $3, $4)")
        .bind(notification_id)
        .bind(effective_method)
        .bind(delivery_status)
        .bind(delivery_error)
        .fetch_one(&mut *tx)
        .await?;
    if !marked {
        tx.rollback().await?;
        return Ok(false);
    }

    let mut resolved_notification_ids = Vec::new();
    if delivery_status == "delivered" {
        if prior_status.as_deref() == Some("failed") {
            sqlx::query(
                r#"
                UPDATE customer_notification_queue
                SET reviewed_at = COALESCE(reviewed_at, NOW()),
                    review_note = COALESCE(
                        review_note,
                        'Resolved automatically after a successful delivery.'
                    ),
                    updated_at = NOW()
                WHERE id = $1
                "#,
            )
            .bind(notification_id)
            .execute(&mut *tx)
            .await?;
            resolved_notification_ids.push(notification_id);
        }
        let older_ids: Vec<Uuid> = sqlx::query_scalar(
            r#"
            UPDATE customer_notification_queue
            SET reviewed_at = COALESCE(reviewed_at, NOW()),
                review_note = COALESCE(
                    review_note,
                    'Resolved automatically after a successful delivery.'
                ),
                updated_at = NOW()
            WHERE id <> $1
              AND customer_id = $2
              AND entity_type = $3
              AND entity_id = $4
              AND kind = $5
              AND delivery_method = $6
              AND delivery_status = 'failed'
              AND reviewed_at IS NULL
            RETURNING id
            "#,
        )
        .bind(notification_id)
        .bind(customer_id)
        .bind(entity_type)
        .bind(entity_id)
        .bind(kind)
        .bind(effective_method)
        .fetch_all(&mut *tx)
        .await?;
        resolved_notification_ids.extend(older_ids);
    }
    tx.commit().await?;

    if delivery_status == "failed" {
        if let Some(channel) = customer_notification_channel(effective_method) {
            if let Err(error) = emit_customer_contact_failure_alert(
                pool,
                notification_id,
                customer_id,
                channel,
                delivery_error.unwrap_or("Customer message delivery failed."),
            )
            .await
            {
                tracing::error!(
                    %error,
                    %notification_id,
                    %customer_id,
                    "Could not create customer contact failure alert"
                );
            }
        }
    } else if delivery_status == "delivered" {
        clear_customer_contact_failure_alerts(pool, &resolved_notification_ids).await;
    }

    Ok(true)
}

async fn emit_customer_contact_failure_alert(
    pool: &PgPool,
    notification_id: Uuid,
    customer_id: Uuid,
    channel: CustomerNotificationChannel,
    reason: &str,
) -> Result<(), sqlx::Error> {
    let recipients = staff_ids_with_permission(pool, CUSTOMERS_HUB_EDIT).await?;
    if recipients.is_empty() {
        return Ok(());
    }
    let customer_name: Option<String> = sqlx::query_scalar(
        r#"
        SELECT NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '')
        FROM customers
        WHERE id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await?
    .flatten();
    let customer_name = customer_name.unwrap_or_else(|| "Customer".to_string());
    let channel_label = match channel {
        CustomerNotificationChannel::Sms => "phone",
        CustomerNotificationChannel::Email => "email",
        CustomerNotificationChannel::Both => "phone or email",
    };
    let body = format!(
        "A customer message failed by {channel_label}. Verify {customer_name}'s contact details, update the customer profile, then retry the delivery. {}",
        reason.trim()
    );
    let deep_link = json!({
        "type": "customers",
        "subsection": "all",
        "customer_id": customer_id.to_string(),
        "hub_tab": "profile",
        "notification_queue_id": notification_id.to_string(),
    });
    let audience = json!({
        "mode": "permission",
        "key": CUSTOMERS_HUB_EDIT,
    });
    let dedupe_key = format!("customer_contact_delivery_failed:{notification_id}");
    let Some(app_notification_id) = insert_app_notification_deduped(
        pool,
        "customer_contact_delivery_failed",
        &format!("Update contact details for {customer_name}"),
        &body,
        deep_link,
        "customer_interactions",
        audience,
        Some(&dedupe_key),
    )
    .await?
    else {
        return Ok(());
    };
    fan_out_notification_to_staff_ids(pool, app_notification_id, &recipients).await
}

pub async fn mark_latest_notification_failed_for_customer(
    pool: &PgPool,
    customer_id: Uuid,
    channel: CustomerNotificationChannel,
    reason: &str,
) -> Result<u64, sqlx::Error> {
    let notification_id: Option<Uuid> = sqlx::query_scalar(
        r#"
        UPDATE customer_notification_queue
        SET delivery_status = 'failed',
            delivery_error = $3,
            updated_at = NOW()
        WHERE id = (
            SELECT id
            FROM customer_notification_queue
            WHERE customer_id = $1
              AND status = 'sent'
              AND reviewed_at IS NULL
              AND delivery_status IS DISTINCT FROM 'failed'
              AND ($2 = 'both' OR delivery_method IN ($2, 'both'))
            ORDER BY COALESCE(sent_at, created_at) DESC
            LIMIT 1
        )
        RETURNING id
        "#,
    )
    .bind(customer_id)
    .bind(channel.as_str())
    .bind(reason)
    .fetch_optional(pool)
    .await?;
    if let Some(notification_id) = notification_id {
        if let Err(error) =
            emit_customer_contact_failure_alert(pool, notification_id, customer_id, channel, reason)
                .await
        {
            tracing::error!(
                %error,
                %notification_id,
                %customer_id,
                "Could not create customer contact failure alert"
            );
        }
        Ok(1)
    } else {
        Ok(0)
    }
}

pub async fn mark_latest_notification_failed_for_email(
    pool: &PgPool,
    email: &str,
    reason: &str,
) -> Result<u64, sqlx::Error> {
    let updated: Option<(Uuid, Uuid)> = sqlx::query_as(
        r#"
        UPDATE customer_notification_queue
        SET delivery_status = 'failed',
            delivery_error = $2,
            updated_at = NOW()
        WHERE id = (
            SELECT cnq.id
            FROM customer_notification_queue cnq
            JOIN customers c ON c.id = cnq.customer_id
            WHERE lower(trim(c.email)) = lower(trim($1))
              AND cnq.status = 'sent'
              AND cnq.reviewed_at IS NULL
              AND cnq.delivery_status IS DISTINCT FROM 'failed'
              AND cnq.delivery_method IN ('email', 'both')
            ORDER BY COALESCE(cnq.sent_at, cnq.created_at) DESC
            LIMIT 1
        )
        RETURNING id, customer_id
        "#,
    )
    .bind(email.trim())
    .bind(reason)
    .fetch_optional(pool)
    .await?;
    if let Some((notification_id, customer_id)) = updated {
        if let Err(error) = emit_customer_contact_failure_alert(
            pool,
            notification_id,
            customer_id,
            CustomerNotificationChannel::Email,
            reason,
        )
        .await
        {
            tracing::error!(
                %error,
                %notification_id,
                %customer_id,
                "Could not create customer contact failure alert"
            );
        }
        Ok(1)
    } else {
        Ok(0)
    }
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

fn webhook_event(value: &Value) -> String {
    text_at(
        value,
        &[
            "/metadata/eventType",
            "/metadata/event_type",
            "/event",
            "/eventType",
            "/event_type",
            "/type",
            "/data/event",
            "/data/eventType",
            "/data/event_type",
            "/data/type",
        ],
    )
    .unwrap_or_default()
    .to_ascii_lowercase()
}

fn webhook_channel(value: &Value) -> CustomerNotificationChannel {
    let channel = text_at(
        value,
        &[
            "/data/channel/type",
            "/channel/type",
            "/data/conversation/channel/type",
            "/conversation/channel/type",
        ],
    )
    .unwrap_or_default()
    .to_ascii_lowercase();
    if channel.contains("email") {
        CustomerNotificationChannel::Email
    } else {
        CustomerNotificationChannel::Sms
    }
}

fn webhook_identifier(value: &Value) -> Option<String> {
    text_at(
        value,
        &[
            "/data/channel/identifier",
            "/channel/identifier",
            "/data/conversation/channel/identifier",
            "/conversation/channel/identifier",
            "/data/contact/phone",
            "/data/contact/email",
            "/contact/phone",
            "/contact/email",
        ],
    )
}

fn webhook_failure_reason(value: &Value) -> Option<String> {
    text_at(
        value,
        &[
            "/data/failureReason",
            "/data/failure_reason",
            "/data/items/0/failureReason",
            "/failureReason",
            "/failure_reason",
            "/items/0/failureReason",
            "/data/deliveryStatus",
            "/deliveryStatus",
        ],
    )
}

fn webhook_message_id(value: &Value) -> Option<String> {
    text_at(
        value,
        &[
            "/data/uid",
            "/uid",
            "/data/messageUid",
            "/messageUid",
            "/data/conversationItemUid",
            "/conversationItemUid",
            "/data/items/0/uid",
            "/items/0/uid",
        ],
    )
}

async fn find_customer_for_identifier(
    pool: &PgPool,
    identifier: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    let identifier = identifier.trim();
    if identifier.contains('@') {
        return sqlx::query_scalar(
            "SELECT id FROM customers WHERE lower(trim(email)) = lower(trim($1)) ORDER BY created_at DESC LIMIT 1",
        )
        .bind(identifier)
        .fetch_optional(pool)
        .await;
    }

    let digits: String = identifier.chars().filter(|c| c.is_ascii_digit()).collect();
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

pub async fn apply_podium_failure_webhook(
    pool: &PgPool,
    value: &Value,
) -> Result<bool, sqlx::Error> {
    let event = webhook_event(value);
    let delivery_status = text_at(
        value,
        &[
            "/data/deliveryStatus",
            "/deliveryStatus",
            "/data/status",
            "/status",
            "/data/items/0/deliveryStatus",
        ],
    )
    .unwrap_or_default()
    .to_ascii_lowercase();
    if matches!(delivery_status.as_str(), "delivered" | "delivery_succeeded") {
        let Some(message_id) = webhook_message_id(value) else {
            return Ok(false);
        };
        let notification_result = sqlx::query(
            r#"
            UPDATE customer_notification_queue
            SET delivery_status = 'delivered',
                delivery_error = NULL,
                reviewed_at = CASE
                    WHEN delivery_status = 'failed' THEN COALESCE(reviewed_at, NOW())
                    ELSE reviewed_at
                END,
                review_note = CASE
                    WHEN delivery_status = 'failed' THEN COALESCE(
                        review_note,
                        'Resolved automatically after provider confirmed delivery.'
                    )
                    ELSE review_note
                END,
                updated_at = NOW()
            WHERE metadata ->> 'provider_message_id' = $1
            "#,
        )
        .bind(&message_id)
        .execute(pool)
        .await?;
        let transaction_result = sqlx::query(
            r#"
            UPDATE transactions
            SET podium_review_invite_status = 'delivered',
                review_invite_last_error = NULL
            WHERE podium_review_message_id = $1
              AND podium_review_invite_status = 'sent'
            "#,
        )
        .bind(&message_id)
        .execute(pool)
        .await?;
        return Ok(
            notification_result.rows_affected() > 0 || transaction_result.rows_affected() > 0
        );
    }
    let failed = event.contains("failed")
        || delivery_status.contains("failed")
        || delivery_status.contains("undeliver");
    if !failed {
        return Ok(false);
    }

    let reason = webhook_failure_reason(value)
        .unwrap_or_else(|| "Provider reported the message failed.".to_string());
    let channel = webhook_channel(value);
    if let Some(message_id) = webhook_message_id(value) {
        let failed_notifications: Vec<(Uuid, Uuid, String)> = sqlx::query_as(
            r#"
            UPDATE customer_notification_queue
            SET delivery_status = 'failed',
                delivery_error = $2,
                updated_at = NOW()
            WHERE metadata ->> 'provider_message_id' = $1
              AND delivery_status IS DISTINCT FROM 'failed'
            RETURNING id, customer_id, delivery_method
            "#,
        )
        .bind(&message_id)
        .bind(&reason)
        .fetch_all(pool)
        .await?;
        let transaction_result = sqlx::query(
            r#"
            UPDATE transactions
            SET podium_review_invite_status = 'failed',
                review_invite_sent_at = NULL,
                review_invite_last_error = $2,
                review_invite_last_attempt_at = NOW()
            WHERE podium_review_message_id = $1
              AND podium_review_invite_status IN ('sent', 'delivered')
            "#,
        )
        .bind(&message_id)
        .bind(&reason)
        .execute(pool)
        .await?;
        for (notification_id, customer_id, delivery_method) in &failed_notifications {
            let failed_channel = match delivery_method.as_str() {
                "email" => CustomerNotificationChannel::Email,
                "both" => CustomerNotificationChannel::Both,
                _ => CustomerNotificationChannel::Sms,
            };
            if let Err(error) = emit_customer_contact_failure_alert(
                pool,
                *notification_id,
                *customer_id,
                failed_channel,
                &reason,
            )
            .await
            {
                tracing::error!(
                    %error,
                    %notification_id,
                    %customer_id,
                    "Could not create customer contact failure alert"
                );
            }
        }
        if !failed_notifications.is_empty() || transaction_result.rows_affected() > 0 {
            return Ok(true);
        }
    }
    let Some(identifier) = webhook_identifier(value) else {
        return Ok(false);
    };
    let Some(customer_id) = find_customer_for_identifier(pool, &identifier).await? else {
        return Ok(false);
    };
    let updated =
        mark_latest_notification_failed_for_customer(pool, customer_id, channel, &reason).await?;
    Ok(updated > 0)
}

pub fn now_metadata() -> Value {
    json!({ "recorded_at": Utc::now() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn podium_failure_event_uses_documented_metadata_envelope() {
        let value = json!({
            "data": {
                "conversation": {
                    "channel": { "identifier": "+18015551212", "type": "phone" }
                },
                "failureReason": "landline"
            },
            "metadata": { "eventType": "message.failed", "eventUid": "event-1" }
        });

        assert_eq!(webhook_event(&value), "message.failed");
        assert_eq!(webhook_identifier(&value).as_deref(), Some("+18015551212"));
        assert_eq!(webhook_failure_reason(&value).as_deref(), Some("landline"));
        assert_eq!(webhook_message_id(&value).as_deref(), None);
    }

    #[test]
    fn podium_failure_event_accepts_snake_case_metadata() {
        let value = json!({
            "metadata": { "event_type": "message.failed", "event_uid": "event-1" }
        });

        assert_eq!(webhook_event(&value), "message.failed");
    }

    #[test]
    fn podium_failure_extracts_exact_message_id() {
        let value = json!({
            "data": { "uid": "message-123", "failureReason": "landline" },
            "metadata": { "eventType": "message.failed" }
        });
        assert_eq!(webhook_message_id(&value).as_deref(), Some("message-123"));
    }
}
