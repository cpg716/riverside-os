//! Unified, read-only customer communication activity across stored ROS channels.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

const DEFAULT_PAGE_SIZE: i64 = 100;
const MAX_PAGE_SIZE: i64 = 200;

#[derive(Debug, Clone)]
pub struct CustomerInteractionFilter {
    pub source: String,
    pub channel: String,
    pub direction: String,
    pub needs_attention: Option<bool>,
    pub search: String,
    pub before_at: Option<DateTime<Utc>>,
    pub before_key: Option<String>,
    pub limit: i64,
}

impl Default for CustomerInteractionFilter {
    fn default() -> Self {
        Self {
            source: "all".to_string(),
            channel: "all".to_string(),
            direction: "all".to_string(),
            needs_attention: None,
            search: String::new(),
            before_at: None,
            before_key: None,
            limit: DEFAULT_PAGE_SIZE,
        }
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct CustomerInteractionRow {
    pub interaction_key: String,
    pub source_id: Uuid,
    pub source: String,
    pub channel: String,
    pub direction: String,
    pub occurred_at: DateTime<Utc>,
    pub customer_id: Option<Uuid>,
    pub customer_code: Option<String>,
    pub customer_name: Option<String>,
    pub customer_first_name: Option<String>,
    pub customer_last_name: Option<String>,
    pub customer_phone: Option<String>,
    pub customer_email: Option<String>,
    pub contact: Option<String>,
    pub title: String,
    pub preview: Option<String>,
    pub actor: Option<String>,
    pub status: String,
    pub needs_attention: bool,
    pub unread: bool,
    pub conversation_id: Option<Uuid>,
    pub thread_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CustomerInteractionPage {
    pub rows: Vec<CustomerInteractionRow>,
    pub has_more: bool,
    pub next_before_at: Option<DateTime<Utc>>,
    pub next_before_key: Option<String>,
    pub manual_channels_available: bool,
}

pub async fn list_customer_interactions(
    pool: &PgPool,
    filter: CustomerInteractionFilter,
    include_manual_channels: bool,
) -> Result<CustomerInteractionPage, sqlx::Error> {
    let limit = filter.limit.clamp(1, MAX_PAGE_SIZE);
    let fetch_limit = limit + 1;
    let mut rows = sqlx::query_as::<_, CustomerInteractionRow>(
        r#"
        WITH notification_rows AS (
            SELECT
                CONCAT('notification:', cnq.id::text) AS interaction_key,
                cnq.id AS source_id,
                'notification'::text AS source,
                COALESCE(NULLIF(cnq.delivery_method, ''), 'automation') AS channel,
                'automated'::text AS direction,
                COALESCE(cnq.sent_at, cnq.scheduled_for, cnq.updated_at, cnq.created_at) AS occurred_at,
                cnq.customer_id,
                c.customer_code,
                NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
                c.first_name AS customer_first_name,
                c.last_name AS customer_last_name,
                c.phone AS customer_phone,
                c.email AS customer_email,
                NULLIF(CONCAT_WS(' · ', c.phone, c.email), '') AS contact,
                INITCAP(REPLACE(cnq.kind, '_', ' ')) AS title,
                LEFT(COALESCE(NULLIF(cnq.delivery_error, ''), NULLIF(cnq.override_reason, ''), cnq.metadata->>'message'), 500) AS preview,
                creator.full_name AS actor,
                CASE
                    WHEN cnq.status = 'failed' OR cnq.delivery_status = 'failed' THEN 'failed'
                    WHEN cnq.status = 'skipped' THEN 'skipped'
                    WHEN cnq.status IN ('pending', 'scheduled') OR cnq.delivery_status = 'pending' THEN 'pending'
                    WHEN cnq.status = 'sent' THEN 'sent'
                    ELSE cnq.status
                END AS status,
                (
                    cnq.status IN ('pending', 'scheduled', 'failed')
                    OR cnq.delivery_status IN ('pending', 'failed')
                ) AS needs_attention,
                cnq.reviewed_at IS NULL AS unread,
                NULL::uuid AS conversation_id,
                NULL::text AS thread_key
            FROM customer_notification_queue cnq
            LEFT JOIN customers c ON c.id = cnq.customer_id
            LEFT JOIN staff creator ON creator.id = cnq.created_by_staff_id
            WHERE NOT (cnq.status = 'sent' AND cnq.delivery_status = 'delivered')
        ),
        podium_rows AS (
            SELECT
                CONCAT('podium:', pm.id::text) AS interaction_key,
                pm.id AS source_id,
                'podium'::text AS source,
                pm.channel,
                pm.direction,
                pm.created_at AS occurred_at,
                pc.customer_id,
                c.customer_code,
                NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
                c.first_name AS customer_first_name,
                c.last_name AS customer_last_name,
                c.phone AS customer_phone,
                c.email AS customer_email,
                COALESCE(pc.contact_phone_e164, pc.contact_email) AS contact,
                CASE
                    WHEN pm.direction = 'inbound' THEN 'Customer text'
                    WHEN pm.direction = 'automated' THEN 'Automated text'
                    ELSE 'Staff text'
                END AS title,
                LEFT(NULLIF(pm.body, ''), 500) AS preview,
                COALESCE(sender.full_name, podium_sender.full_name, pm.podium_sender_name) AS actor,
                CASE
                    WHEN pm.direction = 'inbound'
                     AND pm.created_at > COALESCE(pc.last_viewed_at, 'epoch'::timestamptz)
                    THEN 'unread'
                    WHEN pm.direction = 'inbound' THEN 'received'
                    ELSE 'sent'
                END AS status,
                (
                    pm.direction = 'inbound'
                    AND pm.created_at > COALESCE((
                        SELECT MAX(reply.created_at)
                        FROM podium_message reply
                        WHERE reply.conversation_id = pm.conversation_id
                          AND reply.direction IN ('outbound', 'automated')
                    ), 'epoch'::timestamptz)
                ) AS needs_attention,
                (
                    pm.direction = 'inbound'
                    AND pm.created_at > COALESCE(pc.last_viewed_at, 'epoch'::timestamptz)
                ) AS unread,
                pc.id AS conversation_id,
                NULL::text AS thread_key
            FROM podium_message pm
            JOIN podium_conversation pc ON pc.id = pm.conversation_id
            LEFT JOIN customers c ON c.id = pc.customer_id
            LEFT JOIN staff sender ON sender.id = pm.staff_id
            LEFT JOIN staff podium_sender
              ON pm.staff_id IS NULL
             AND pm.podium_sender_uid IS NOT NULL
             AND podium_sender.podium_user_uid = pm.podium_sender_uid
             AND podium_sender.is_active = TRUE
            WHERE $1::bool
        ),
        mailbox_rows AS (
            SELECT
                CONCAT('mailbox:', mm.id::text) AS interaction_key,
                mm.id AS source_id,
                'mailbox'::text AS source,
                'email'::text AS channel,
                mm.direction,
                COALESCE(mm.received_at, mm.sent_at, mm.created_at) AS occurred_at,
                mm.customer_id,
                c.customer_code,
                NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
                c.first_name AS customer_first_name,
                c.last_name AS customer_last_name,
                c.phone AS customer_phone,
                c.email AS customer_email,
                CASE
                    WHEN mm.direction = 'inbound' THEN mm.from_email
                    ELSE NULLIF(mm.to_emails->>0, '')
                END AS contact,
                COALESCE(NULLIF(mm.subject, ''), 'Email') AS title,
                LEFT(
                    COALESCE(
                        NULLIF(mm.body_text, ''),
                        NULLIF(REGEXP_REPLACE(COALESCE(mm.body_html, ''), '<[^>]+>', ' ', 'g'), '')
                    ),
                    500
                ) AS preview,
                COALESCE(sender.full_name, mm.from_name) AS actor,
                CASE
                    WHEN mm.status = 'failed' THEN 'failed'
                    WHEN mm.direction = 'inbound' AND NOT mm.is_read THEN 'unread'
                    WHEN mm.direction = 'inbound' THEN 'received'
                    ELSE mm.status
                END AS status,
                (mm.status = 'failed' OR (mm.direction = 'inbound' AND NOT mm.is_read)) AS needs_attention,
                (mm.direction = 'inbound' AND NOT mm.is_read) AS unread,
                NULL::uuid AS conversation_id,
                mm.thread_key
            FROM mailbox_messages mm
            LEFT JOIN customers c ON c.id = mm.customer_id
            LEFT JOIN staff sender ON sender.id = mm.staff_id
            WHERE $1::bool
              AND mm.folder NOT IN ('ARCHIVED', 'TRASH')
        ),
        interaction_rows AS (
            SELECT * FROM notification_rows
            UNION ALL
            SELECT * FROM podium_rows
            UNION ALL
            SELECT * FROM mailbox_rows
        )
        SELECT *
        FROM interaction_rows
        WHERE ($2 = 'all' OR source = $2)
          AND ($3 = 'all' OR channel = $3 OR ($3 = 'sms' AND channel = 'both') OR ($3 = 'email' AND channel = 'both'))
          AND ($4 = 'all' OR direction = $4)
          AND ($5::bool IS NULL OR needs_attention = $5)
          AND (
              $6 = ''
              OR LOWER(CONCAT_WS(
                  ' ', customer_name, customer_code, contact, title, preview, actor, status, channel, direction
              )) LIKE CONCAT('%', LOWER($6), '%')
          )
          AND (
              $7::timestamptz IS NULL
              OR occurred_at < $7
              OR (occurred_at = $7 AND interaction_key < COALESCE($8, ''))
          )
        ORDER BY occurred_at DESC, interaction_key DESC
        LIMIT $9
        "#,
    )
    .bind(include_manual_channels)
    .bind(filter.source)
    .bind(filter.channel)
    .bind(filter.direction)
    .bind(filter.needs_attention)
    .bind(filter.search.trim())
    .bind(filter.before_at)
    .bind(filter.before_key)
    .bind(fetch_limit)
    .fetch_all(pool)
    .await?;

    let has_more = rows.len() as i64 > limit;
    if has_more {
        rows.truncate(limit as usize);
    }
    let next = rows.last();

    Ok(CustomerInteractionPage {
        next_before_at: next.map(|row| row.occurred_at),
        next_before_key: next.map(|row| row.interaction_key.clone()),
        rows,
        has_more,
        manual_channels_available: include_manual_channels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interaction_filter_defaults_to_a_bounded_page() {
        let filter = CustomerInteractionFilter::default();
        assert_eq!(filter.limit, DEFAULT_PAGE_SIZE);
        assert!(filter.limit <= MAX_PAGE_SIZE);
        assert_eq!(filter.source, "all");
        assert_eq!(filter.channel, "all");
        assert_eq!(filter.direction, "all");
    }
}
