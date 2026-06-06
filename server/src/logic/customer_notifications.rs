use chrono::Utc;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, Copy)]
pub enum CustomerNotificationKind {
    ReadyForPickup,
    AlterationReady,
    AppointmentConfirmation,
    AppointmentReminder,
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

    sqlx::query_scalar(
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
    .fetch_one(pool)
    .await
}

pub async fn mark_latest_notification_failed_for_customer(
    pool: &PgPool,
    customer_id: Uuid,
    channel: CustomerNotificationChannel,
    reason: &str,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
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
        "#,
    )
    .bind(customer_id)
    .bind(channel.as_str())
    .bind(reason)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn mark_latest_notification_failed_for_email(
    pool: &PgPool,
    email: &str,
    reason: &str,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
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
        "#,
    )
    .bind(email.trim())
    .bind(reason)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
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
    text_at(value, &["/event", "/type", "/data/event", "/data/type"])
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
    let failed = event.contains("failed")
        || delivery_status.contains("failed")
        || delivery_status.contains("undeliver");
    if !failed {
        return Ok(false);
    }

    let reason = webhook_failure_reason(value)
        .unwrap_or_else(|| "Provider reported the message failed.".to_string());
    let channel = webhook_channel(value);
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
