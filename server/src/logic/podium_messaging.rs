//! List / record Podium CRM messages (`podium_conversation`, `podium_message`).

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

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
    pub snippet: Option<String>,
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
