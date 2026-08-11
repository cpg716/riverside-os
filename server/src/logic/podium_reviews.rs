//! Podium post-sale review invite tracking.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::logic::{
    ops_dev_center::{self, GuardedActionResult},
    podium::{self, PodiumTokenCache},
};

pub const REVIEW_INVITE_DELAY_DAYS: i64 = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct StoreReviewPolicy {
    #[serde(default = "default_true")]
    pub review_invites_enabled: bool,
    #[serde(default = "default_true")]
    pub send_review_invite_by_default: bool,
}

fn default_true() -> bool {
    true
}

impl Default for StoreReviewPolicy {
    fn default() -> Self {
        Self {
            review_invites_enabled: true,
            send_review_invite_by_default: true,
        }
    }
}

pub fn parse_review_policy(value: serde_json::Value) -> StoreReviewPolicy {
    serde_json::from_value(value).unwrap_or_default()
}

pub async fn load_store_review_policy(pool: &PgPool) -> Result<StoreReviewPolicy, sqlx::Error> {
    let raw: serde_json::Value =
        sqlx::query_scalar("SELECT review_policy FROM store_settings WHERE id = 1")
            .fetch_one(pool)
            .await?;
    Ok(parse_review_policy(raw))
}

pub async fn save_store_review_policy(
    pool: &PgPool,
    policy: &StoreReviewPolicy,
) -> Result<(), sqlx::Error> {
    let v = serde_json::to_value(policy).unwrap_or_default();
    sqlx::query("UPDATE store_settings SET review_policy = $1 WHERE id = 1")
        .bind(v)
        .execute(pool)
        .await?;
    Ok(())
}

#[derive(Debug, Error)]
pub enum ReviewInviteError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("order not found")]
    NotFound,
    #[error("podium error: {0}")]
    Podium(#[from] podium::PodiumError),
    #[error("review invite delivery failed: {0}")]
    Delivery(String),
}

type OrderReviewGateRow = (
    Option<Uuid>,
    Option<chrono::DateTime<chrono::Utc>>,
    Option<chrono::DateTime<chrono::Utc>>,
    Option<String>,
    Option<String>,
    String,
    String,
    Option<String>,
    Option<String>,
    bool,
    bool,
    bool,
    bool,
);

#[derive(Debug, Clone)]
pub struct ReviewInviteDelivery {
    pub channel: &'static str,
    pub provider_message_id: Option<String>,
}

pub async fn deliver_review_invite_link(
    pool: &PgPool,
    http: &reqwest::Client,
    podium_cache: &Arc<Mutex<PodiumTokenCache>>,
    phone: Option<&str>,
    email: Option<&str>,
    first_name: Option<&str>,
    transaction_ref: &str,
    invite: &podium::PodiumReviewInviteResult,
) -> Result<ReviewInviteDelivery, ReviewInviteError> {
    let review_url = invite
        .review_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ReviewInviteError::Delivery("Podium did not return a review URL.".to_string())
        })?;
    let config = podium::load_store_podium_config(pool).await?;
    let templates = config.review_templates.merged_defaults();
    let store_name: String = sqlx::query_scalar(
        r#"
        SELECT COALESCE(
            NULLIF(BTRIM(receipt_config->>'store_name'), ''),
            'Riverside Men''s Shop'
        )
        FROM store_settings
        WHERE id = 1
        "#,
    )
    .fetch_one(pool)
    .await?;
    let first_name = first_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("there");
    let vars = [
        ("first_name", first_name),
        ("transaction_ref", transaction_ref),
        ("review_url", review_url),
        ("store_name", store_name.as_str()),
    ];
    if let Some(phone) = phone.and_then(podium::normalize_phone_e164) {
        let body = podium::apply_template_placeholders(&templates.sms_body, &vars);
        let sent = podium::send_podium_sms_message_tracked(pool, http, podium_cache, &phone, &body)
            .await?;
        return Ok(ReviewInviteDelivery {
            channel: "sms",
            provider_message_id: sent.provider_message_id,
        });
    }
    if let Some(email) = email
        .map(str::trim)
        .filter(|address| podium::looks_like_email(address))
    {
        let subject = podium::apply_template_placeholders(&templates.email_subject, &vars);
        let body = podium::apply_template_placeholders(&templates.email_body, &vars);
        let sent = podium::send_podium_email_message_tracked(
            pool,
            http,
            podium_cache,
            email,
            &subject,
            &body,
        )
        .await?;
        return Ok(ReviewInviteDelivery {
            channel: "email",
            provider_message_id: sent.provider_message_id,
        });
    }
    Err(ReviewInviteError::Delivery(
        "Customer does not have a deliverable phone number or email address.".to_string(),
    ))
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewInviteChoiceResult {
    pub ok: bool,
    pub status: String,
    pub message: String,
    pub provider_id: Option<String>,
    pub review_url: Option<String>,
}

impl ReviewInviteChoiceResult {
    fn new(status: &str, message: &str) -> Self {
        Self {
            ok: true,
            status: status.to_string(),
            message: message.to_string(),
            provider_id: None,
            review_url: None,
        }
    }

    fn sent(provider_id: String, review_url: Option<String>) -> Self {
        Self {
            ok: true,
            status: "sent".to_string(),
            message: "Review request accepted for delivery.".to_string(),
            provider_id: Some(provider_id),
            review_url,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewInviteTestResult {
    pub ok: bool,
    pub status: String,
    pub channel: String,
    pub provider_id: Option<String>,
    pub provider_message_id: Option<String>,
    pub review_url: Option<String>,
}

/// Send one immediate, manager-authorized delivery test through Riverside's
/// configured Podium review and messaging path. Test sends do not create a
/// customer or Transaction and are recorded in the operations action audit.
pub async fn send_test_review_invite(
    pool: &PgPool,
    http: &reqwest::Client,
    podium_cache: &Arc<Mutex<PodiumTokenCache>>,
    actor_staff_id: Uuid,
    phone: &str,
    first_name: Option<&str>,
) -> Result<ReviewInviteTestResult, ReviewInviteError> {
    let policy = load_store_review_policy(pool).await?;
    if !policy.review_invites_enabled {
        return Err(ReviewInviteError::Delivery(
            "Review requests are disabled in store settings.".to_string(),
        ));
    }

    let normalized_phone = podium::normalize_phone_e164(phone).ok_or_else(|| {
        ReviewInviteError::Delivery("Enter a valid US or Canadian mobile number.".to_string())
    })?;
    let recipient_name = first_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("there");
    let phone_last_four = normalized_phone
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    let audit_payload = json!({
        "recipient_phone_last_four": phone_last_four,
        "recipient_first_name": recipient_name,
        "source": "operations_reviews",
    });
    let initiated = GuardedActionResult {
        ok: false,
        message: "Test review request initiated; provider result pending.".to_string(),
        data: json!({ "status": "initiated" }),
    };
    let audit = ops_dev_center::write_action_audit(
        pool,
        actor_staff_id,
        "review_test_invite_send",
        "Authorized delivery test from Operations > Reviews.",
        &audit_payload,
        &initiated,
    )
    .await?;

    let outcome: Result<
        (podium::PodiumReviewInviteResult, ReviewInviteDelivery),
        ReviewInviteError,
    > = async {
        let invite = podium::create_podium_review_invite(
            pool,
            http,
            podium_cache,
            Some(&normalized_phone),
            None,
        )
        .await?;
        let delivery = deliver_review_invite_link(
            pool,
            http,
            podium_cache,
            Some(&normalized_phone),
            None,
            Some(recipient_name),
            "TEST-REVIEW",
            &invite,
        )
        .await?;
        Ok((invite, delivery))
    }
    .await;

    match outcome {
        Ok((invite, delivery)) => {
            let result = ReviewInviteTestResult {
                ok: true,
                status: "sent".to_string(),
                channel: delivery.channel.to_string(),
                provider_id: invite.provider_id.clone(),
                provider_message_id: delivery.provider_message_id.clone(),
                review_url: invite.review_url.clone(),
            };
            if let Err(error) = sqlx::query(
                r#"
                UPDATE ops_action_audit
                SET result_ok = TRUE,
                    result_message = 'Test review request accepted for SMS delivery.',
                    result_json = $2
                WHERE id = $1
                "#,
            )
            .bind(audit.id)
            .bind(json!({
                "status": result.status,
                "channel": result.channel,
                "provider_id": result.provider_id,
                "provider_message_id": result.provider_message_id,
            }))
            .execute(pool)
            .await
            {
                // The provider mutation already succeeded. Preserve that result
                // for the caller so staff do not retry and create a duplicate.
                tracing::error!(
                    %error,
                    audit_id = %audit.id,
                    "test review request sent but audit finalization failed"
                );
            }
            Ok(result)
        }
        Err(error) => {
            let failure = error.to_string();
            if let Err(audit_error) = sqlx::query(
                r#"
                UPDATE ops_action_audit
                SET result_ok = FALSE,
                    result_message = LEFT($2, 1000),
                    result_json = jsonb_build_object('status', 'failed')
                WHERE id = $1
                "#,
            )
            .bind(audit.id)
            .bind(&failure)
            .execute(pool)
            .await
            {
                tracing::error!(
                    error = %audit_error,
                    audit_id = %audit.id,
                    "test review request failure audit could not be finalized"
                );
            }
            Err(error)
        }
    }
}

/// Persist cashier choice at end of receipt flow. Sends a Podium review invite only
/// for completed, fulfilled sales and enforces one invite per customer per 180 days.
pub async fn apply_post_sale_review_choice(
    pool: &PgPool,
    _http: &reqwest::Client,
    _podium_cache: &Arc<Mutex<PodiumTokenCache>>,
    transaction_id: Uuid,
    skip_invite: bool,
) -> Result<ReviewInviteChoiceResult, ReviewInviteError> {
    let policy = load_store_review_policy(pool).await?;

    let has_review_opt_out: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'customers'
              AND column_name = 'review_requests_opt_out'
        )
        "#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or(false);

    let review_opt_out_expr = if has_review_opt_out {
        "COALESCE(c.review_requests_opt_out, false) AS review_requests_opt_out"
    } else {
        "false AS review_requests_opt_out"
    };

    let mut tx = pool.begin().await?;

    let sql = format!(
        r#"
        SELECT
            t.customer_id,
            t.review_invite_suppressed_at,
            t.review_invite_sent_at,
            t.podium_review_invite_id,
            t.podium_review_invite_status,
            t.display_id,
            t.status::text,
            c.phone,
            c.email,
            {review_opt_out_expr},
            EXISTS (
                SELECT 1 FROM transaction_lines tl
                WHERE tl.transaction_id = t.id
                  AND COALESCE(tl.is_internal, false) = false
            ) AS has_reviewable_lines,
            NOT EXISTS (
                SELECT 1 FROM transaction_lines tl
                WHERE tl.transaction_id = t.id
                  AND COALESCE(tl.is_internal, false) = false
                  AND COALESCE(tl.is_fulfilled, false) = false
            ) AS all_reviewable_lines_fulfilled,
            EXISTS (
                SELECT 1 FROM transactions recent
                WHERE recent.customer_id = t.customer_id
                  AND recent.id <> t.id
                  AND recent.review_invite_sent_at > NOW() - INTERVAL '180 days'
                  AND recent.podium_review_invite_status IN ('sent', 'delivered')
            ) AS recent_customer_invite
        FROM transactions t
        LEFT JOIN customers c ON c.id = t.customer_id
        WHERE t.id = $1
        FOR UPDATE OF t
        "#
    );

    let row: Option<OrderReviewGateRow> = sqlx::query_as(&sql)
        .bind(transaction_id)
        .fetch_optional(&mut *tx)
        .await?;

    let Some((
        customer_id,
        suppressed_at,
        sent_at,
        _provider_id,
        invite_status,
        _display_id,
        status,
        phone,
        email,
        review_requests_opt_out,
        has_reviewable_lines,
        all_reviewable_lines_fulfilled,
        recent_customer_invite,
    )) = row
    else {
        return Err(ReviewInviteError::NotFound);
    };

    if skip_invite {
        if suppressed_at.is_none() {
            sqlx::query(
                r#"
            UPDATE transactions
            SET review_invite_suppressed_at = NOW(),
                podium_review_invite_id = COALESCE(podium_review_invite_id, 'ros_staff_skipped'),
                podium_review_invite_status = 'suppressed'
            WHERE id = $1
            "#,
            )
            .bind(transaction_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        return Ok(ReviewInviteChoiceResult::new(
            "suppressed",
            "Review request skipped for this sale.",
        ));
    }

    if !policy.review_invites_enabled {
        tx.commit().await?;
        return Ok(ReviewInviteChoiceResult::new(
            "disabled",
            "Review requests are turned off in store settings.",
        ));
    }

    if suppressed_at.is_some() || sent_at.is_some() {
        tx.commit().await?;
        return Ok(ReviewInviteChoiceResult::new(
            "already_saved",
            "Review request choice was already saved for this sale.",
        ));
    }
    if matches!(invite_status.as_deref(), Some("scheduled" | "sending")) {
        tx.commit().await?;
        return Ok(ReviewInviteChoiceResult::new(
            invite_status.as_deref().unwrap_or("scheduled"),
            "Review request is already scheduled.",
        ));
    }

    if review_requests_opt_out {
        sqlx::query(
            r#"
            UPDATE transactions
            SET review_invite_suppressed_at = NOW(),
                podium_review_invite_id = COALESCE(podium_review_invite_id, 'ros_skipped_customer_opt_out'),
                podium_review_invite_status = 'skipped_customer_opt_out'
            WHERE id = $1
            "#,
        )
        .bind(transaction_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(ReviewInviteChoiceResult::new(
            "skipped_customer_opt_out",
            "Review request skipped. This customer has opted out of review requests.",
        ));
    }

    if status != "fulfilled"
        || customer_id.is_none()
        || !has_reviewable_lines
        || !all_reviewable_lines_fulfilled
    {
        tx.commit().await?;
        return Ok(ReviewInviteChoiceResult::new(
            "not_ready",
            "Review request not sent. Riverside only asks after completed or picked-up sales.",
        ));
    }

    if recent_customer_invite {
        sqlx::query(
            r#"
            UPDATE transactions
            SET review_invite_suppressed_at = NOW(),
                podium_review_invite_id = COALESCE(podium_review_invite_id, 'ros_skipped_recent_180d'),
                podium_review_invite_status = 'skipped_recent_180d'
            WHERE id = $1
            "#,
        )
        .bind(transaction_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(ReviewInviteChoiceResult::new(
            "skipped_recent_180d",
            "Review request skipped. This customer was asked in the last 180 days.",
        ));
    }

    let has_review_phone = phone
        .as_deref()
        .and_then(podium::normalize_phone_e164)
        .is_some();
    let has_review_email = email
        .as_deref()
        .map(podium::looks_like_email)
        .unwrap_or(false);
    if !has_review_phone && !has_review_email {
        sqlx::query(
            r#"
            UPDATE transactions
            SET review_invite_suppressed_at = NOW(),
                podium_review_invite_id = COALESCE(podium_review_invite_id, 'ros_skipped_no_contact'),
                podium_review_invite_status = 'skipped_no_contact'
            WHERE id = $1
            "#,
        )
        .bind(transaction_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(ReviewInviteChoiceResult::new(
            "skipped_no_contact",
            "Review request skipped. Customer needs a phone number or email first.",
        ));
    }

    let scheduled_for: DateTime<Utc> =
        sqlx::query_scalar("SELECT review_invite_delivery_time(NOW())")
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query(
        r#"
        UPDATE transactions
        SET podium_review_invite_status = 'scheduled',
            review_invite_scheduled_for = $2,
            review_invite_claimed_at = NULL,
            review_invite_last_error = NULL,
            review_invite_attempts = 0
        WHERE id = $1
          AND review_invite_sent_at IS NULL
          AND review_invite_suppressed_at IS NULL
        "#,
    )
    .bind(transaction_id)
    .bind(scheduled_for)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(ReviewInviteChoiceResult::new(
        "scheduled",
        "Review request scheduled for five days after fulfillment.",
    ))
}

pub async fn schedule_latest_customer_review_invite(
    pool: &PgPool,
    http: &reqwest::Client,
    podium_cache: &Arc<Mutex<PodiumTokenCache>>,
    customer_id: Uuid,
) -> Result<ReviewInviteChoiceResult, ReviewInviteError> {
    let transaction_id: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT t.id
        FROM transactions t
        WHERE t.customer_id = $1
          AND t.status::text = 'fulfilled'
          AND EXISTS (
              SELECT 1 FROM transaction_lines tl
              WHERE tl.transaction_id = t.id
                AND COALESCE(tl.is_internal, false) = false
          )
          AND NOT EXISTS (
              SELECT 1 FROM transaction_lines tl
              WHERE tl.transaction_id = t.id
                AND COALESCE(tl.is_internal, false) = false
                AND COALESCE(tl.is_fulfilled, false) = false
          )
        ORDER BY COALESCE(t.fulfilled_at, t.booked_at) DESC
        LIMIT 1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await?;
    let Some(transaction_id) = transaction_id else {
        return Err(ReviewInviteError::Delivery(
            "Customer does not have an eligible fulfilled Transaction.".to_string(),
        ));
    };
    apply_post_sale_review_choice(pool, http, podium_cache, transaction_id, false).await
}

#[derive(Debug, sqlx::FromRow)]
struct ClaimedReviewInvite {
    transaction_id: Uuid,
}

#[derive(Debug, sqlx::FromRow)]
struct ReviewDeliveryRow {
    transaction_id: Uuid,
    customer_id: Option<Uuid>,
    display_id: String,
    first_name: Option<String>,
    phone: Option<String>,
    email: Option<String>,
    review_requests_opt_out: bool,
    has_reviewable_lines: bool,
    all_reviewable_lines_fulfilled: bool,
    recent_customer_invite: bool,
    podium_review_invite_id: Option<String>,
    podium_review_url: Option<String>,
}

async fn claim_due_review_invite(
    pool: &PgPool,
) -> Result<Option<ClaimedReviewInvite>, sqlx::Error> {
    sqlx::query_as(
        r#"
        WITH candidate AS (
            SELECT id
            FROM transactions
            WHERE review_invite_sent_at IS NULL
              AND review_invite_suppressed_at IS NULL
              AND review_invite_attempts < 5
              AND (
                  (podium_review_invite_status = 'scheduled' AND review_invite_scheduled_for <= NOW())
                  OR (
                      podium_review_invite_status = 'sending'
                      AND review_invite_claimed_at < NOW() - INTERVAL '15 minutes'
                  )
              )
            ORDER BY review_invite_scheduled_for, booked_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        UPDATE transactions transaction
        SET podium_review_invite_status = 'sending',
            review_invite_claimed_at = NOW(),
            review_invite_last_attempt_at = NOW(),
            review_invite_attempts = review_invite_attempts + 1,
            review_invite_last_error = NULL
        FROM candidate
        WHERE transaction.id = candidate.id
        RETURNING transaction.id AS transaction_id
        "#,
    )
    .fetch_optional(pool)
    .await
}

async fn load_review_delivery_row(
    pool: &PgPool,
    transaction_id: Uuid,
) -> Result<Option<ReviewDeliveryRow>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT
            t.id AS transaction_id,
            t.customer_id,
            t.display_id,
            c.first_name,
            c.phone,
            c.email,
            COALESCE(c.review_requests_opt_out, false) AS review_requests_opt_out,
            EXISTS (
                SELECT 1 FROM transaction_lines tl
                WHERE tl.transaction_id = t.id AND COALESCE(tl.is_internal, false) = false
            ) AS has_reviewable_lines,
            NOT EXISTS (
                SELECT 1 FROM transaction_lines tl
                WHERE tl.transaction_id = t.id
                  AND COALESCE(tl.is_internal, false) = false
                  AND COALESCE(tl.is_fulfilled, false) = false
            ) AS all_reviewable_lines_fulfilled,
            EXISTS (
                SELECT 1 FROM transactions recent
                WHERE recent.customer_id = t.customer_id
                  AND recent.id <> t.id
                  AND recent.review_invite_sent_at > NOW() - INTERVAL '180 days'
                  AND recent.podium_review_invite_status IN ('sent', 'delivered')
            ) AS recent_customer_invite,
            t.podium_review_invite_id,
            t.podium_review_url
        FROM transactions t
        LEFT JOIN customers c ON c.id = t.customer_id
        WHERE t.id = $1 AND t.status::text = 'fulfilled'
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(pool)
    .await
}

async fn suppress_claimed_review_invite(
    pool: &PgPool,
    transaction_id: Uuid,
    status: &str,
    provider_marker: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE transactions
        SET review_invite_suppressed_at = NOW(),
            review_invite_scheduled_for = NULL,
            review_invite_claimed_at = NULL,
            podium_review_invite_id = COALESCE(podium_review_invite_id, $3),
            podium_review_invite_status = $2
        WHERE id = $1 AND podium_review_invite_status = 'sending'
        "#,
    )
    .bind(transaction_id)
    .bind(status)
    .bind(provider_marker)
    .execute(pool)
    .await?;
    Ok(())
}

async fn fail_claimed_review_invite(
    pool: &PgPool,
    transaction_id: Uuid,
    error: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE transactions
        SET podium_review_invite_status = 'failed',
            review_invite_scheduled_for = NULL,
            review_invite_claimed_at = NULL,
            review_invite_last_error = LEFT($2, 4000)
        WHERE id = $1 AND podium_review_invite_status = 'sending'
        "#,
    )
    .bind(transaction_id)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}

async fn deliver_claimed_review_invite(
    pool: &PgPool,
    http: &reqwest::Client,
    podium_cache: &Arc<Mutex<PodiumTokenCache>>,
    transaction_id: Uuid,
) -> Result<ReviewInviteChoiceResult, ReviewInviteError> {
    let policy = load_store_review_policy(pool).await?;
    if !policy.review_invites_enabled {
        suppress_claimed_review_invite(
            pool,
            transaction_id,
            "skipped_policy_disabled",
            "ros_skipped_policy_disabled",
        )
        .await?;
        return Ok(ReviewInviteChoiceResult::new(
            "skipped_policy_disabled",
            "Review requests are disabled in store settings.",
        ));
    }

    let Some(row) = load_review_delivery_row(pool, transaction_id).await? else {
        suppress_claimed_review_invite(
            pool,
            transaction_id,
            "skipped_not_ready",
            "ros_skipped_not_ready",
        )
        .await?;
        return Ok(ReviewInviteChoiceResult::new(
            "skipped_not_ready",
            "Transaction is no longer eligible for a review request.",
        ));
    };
    if row.review_requests_opt_out {
        suppress_claimed_review_invite(
            pool,
            transaction_id,
            "skipped_customer_opt_out",
            "ros_skipped_customer_opt_out",
        )
        .await?;
        return Ok(ReviewInviteChoiceResult::new(
            "skipped_customer_opt_out",
            "Customer opted out of review requests.",
        ));
    }
    if row.customer_id.is_none() || !row.has_reviewable_lines || !row.all_reviewable_lines_fulfilled
    {
        suppress_claimed_review_invite(
            pool,
            transaction_id,
            "skipped_not_ready",
            "ros_skipped_not_ready",
        )
        .await?;
        return Ok(ReviewInviteChoiceResult::new(
            "skipped_not_ready",
            "Transaction is not eligible for a review request.",
        ));
    }
    if row.recent_customer_invite {
        suppress_claimed_review_invite(
            pool,
            transaction_id,
            "skipped_recent_180d",
            "ros_skipped_recent_180d",
        )
        .await?;
        return Ok(ReviewInviteChoiceResult::new(
            "skipped_recent_180d",
            "Customer received a review request in the last 180 days.",
        ));
    }

    let has_phone = row
        .phone
        .as_deref()
        .and_then(podium::normalize_phone_e164)
        .is_some();
    let has_email = row
        .email
        .as_deref()
        .map(podium::looks_like_email)
        .unwrap_or(false);
    if !has_phone && !has_email {
        suppress_claimed_review_invite(
            pool,
            transaction_id,
            "skipped_no_contact",
            "ros_skipped_no_contact",
        )
        .await?;
        return Ok(ReviewInviteChoiceResult::new(
            "skipped_no_contact",
            "Customer does not have a usable phone number or email address.",
        ));
    }

    let invite = if row.podium_review_url.is_some() {
        podium::PodiumReviewInviteResult {
            provider_id: row.podium_review_invite_id.clone(),
            review_url: row.podium_review_url.clone(),
            raw_response: json!({}),
        }
    } else {
        let created = podium::create_podium_review_invite(
            pool,
            http,
            podium_cache,
            row.phone.as_deref(),
            row.email.as_deref(),
        )
        .await?;
        sqlx::query(
            r#"
            UPDATE transactions
            SET podium_review_invite_id = $2,
                podium_review_url = $3
            WHERE id = $1 AND podium_review_invite_status = 'sending'
            "#,
        )
        .bind(transaction_id)
        .bind(created.provider_id.as_deref())
        .bind(created.review_url.as_deref())
        .execute(pool)
        .await?;
        created
    };

    let delivery = deliver_review_invite_link(
        pool,
        http,
        podium_cache,
        row.phone.as_deref(),
        row.email.as_deref(),
        row.first_name.as_deref(),
        &row.display_id,
        &invite,
    )
    .await?;
    let provider_id = invite
        .provider_id
        .clone()
        .unwrap_or_else(|| "podium_review_invite_sent".to_string());
    sqlx::query(
        r#"
        UPDATE transactions
        SET review_invite_sent_at = NOW(),
            review_invite_scheduled_for = NULL,
            review_invite_claimed_at = NULL,
            review_invite_last_error = NULL,
            review_invite_delivery_channel = $2,
            podium_review_message_id = $3,
            podium_review_invite_id = COALESCE(podium_review_invite_id, $4),
            podium_review_invite_status = 'sent'
        WHERE id = $1 AND podium_review_invite_status = 'sending'
        "#,
    )
    .bind(transaction_id)
    .bind(delivery.channel)
    .bind(delivery.provider_message_id.as_deref())
    .bind(&provider_id)
    .execute(pool)
    .await?;

    if let Some(customer_id) = row.customer_id {
        let channel = if delivery.channel == "email" {
            crate::logic::customer_notifications::CustomerNotificationChannel::Email
        } else {
            crate::logic::customer_notifications::CustomerNotificationChannel::Sms
        };
        let _ = crate::logic::customer_notifications::record_customer_notification_with_status(
            pool,
            customer_id,
            "transaction",
            row.transaction_id,
            crate::logic::customer_notifications::CustomerNotificationKind::ReviewInvite,
            channel,
            Some("Review request sent."),
            "pending",
            None,
            json!({
                "provider_id": provider_id,
                "provider_message_id": delivery.provider_message_id,
                "review_url": invite.review_url,
                "delivery_channel": delivery.channel,
                "scheduled_delay_days": REVIEW_INVITE_DELAY_DAYS,
            }),
        )
        .await;
    }
    tracing::info!(
        target: "podium_reviews",
        transaction_id = %transaction_id,
        display_id = %row.display_id,
        channel = %delivery.channel,
        "Delayed Podium review request sent"
    );
    Ok(ReviewInviteChoiceResult::sent(
        provider_id,
        invite.review_url,
    ))
}

pub async fn process_due_review_invites(
    pool: &PgPool,
    http: &reqwest::Client,
    podium_cache: &Arc<Mutex<PodiumTokenCache>>,
    limit: usize,
) -> Result<u32, sqlx::Error> {
    let mut processed = 0_u32;
    for _ in 0..limit.clamp(1, 50) {
        let Some(claimed) = claim_due_review_invite(pool).await? else {
            break;
        };
        match deliver_claimed_review_invite(pool, http, podium_cache, claimed.transaction_id).await
        {
            Ok(_) => processed += 1,
            Err(error) => {
                fail_claimed_review_invite(pool, claimed.transaction_id, &error.to_string())
                    .await?;
                tracing::warn!(
                    target: "podium_reviews",
                    transaction_id = %claimed.transaction_id,
                    error = %error,
                    "Delayed Podium review request failed"
                );
            }
        }
    }
    Ok(processed)
}

pub async fn reschedule_failed_review_invite(
    pool: &PgPool,
    transaction_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let scheduled_for: DateTime<Utc> =
        sqlx::query_scalar("SELECT review_invite_delivery_time(NOW())")
            .fetch_one(pool)
            .await?;
    let result = sqlx::query(
        r#"
        UPDATE transactions
        SET podium_review_invite_status = 'scheduled',
            review_invite_scheduled_for = $2,
            review_invite_claimed_at = NULL,
            review_invite_last_error = NULL,
            review_invite_attempts = 0
        WHERE id = $1
          AND podium_review_invite_status = 'failed'
          AND review_invite_suppressed_at IS NULL
        "#,
    )
    .bind(transaction_id)
    .bind(scheduled_for)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Cancel an invite only while it is still waiting for the delivery worker.
/// The conditional update and activity log share one transaction so a worker
/// claim wins cleanly instead of allowing a late or ambiguous cancellation.
pub async fn cancel_scheduled_review_invite(
    pool: &PgPool,
    transaction_id: Uuid,
    actor_staff_id: Uuid,
    reason: &str,
) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let candidate: Option<(Option<Uuid>, String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT customer_id, display_id, podium_review_invite_id
        FROM transactions
        WHERE id = $1
          AND podium_review_invite_status = 'scheduled'
          AND review_invite_sent_at IS NULL
          AND review_invite_suppressed_at IS NULL
        FOR UPDATE
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((customer_id, display_id, prior_provider_invite_id)) = candidate else {
        tx.rollback().await?;
        return Ok(false);
    };

    sqlx::query(
        r#"
        UPDATE transactions
        SET review_invite_suppressed_at = NOW(),
            review_invite_scheduled_for = NULL,
            review_invite_claimed_at = NULL,
            review_invite_last_error = NULL,
            podium_review_invite_id = 'ros_staff_cancelled',
            podium_review_url = NULL,
            podium_review_invite_status = 'cancelled'
        WHERE id = $1
          AND podium_review_invite_status = 'scheduled'
        "#,
    )
    .bind(transaction_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO transaction_activity_log (
            transaction_id, customer_id, event_kind, summary, metadata
        )
        VALUES ($1, $2, 'review_invite_cancelled', $3, $4)
        "#,
    )
    .bind(transaction_id)
    .bind(customer_id)
    .bind(format!(
        "Scheduled review request for {display_id} cancelled before delivery"
    ))
    .bind(json!({
        "cancelled_by_staff_id": actor_staff_id,
        "reason": reason,
        "prior_status": "scheduled",
        "prior_provider_invite_id": prior_provider_invite_id,
    }))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(true)
}

#[derive(Debug, serde::Serialize, sqlx::FromRow)]
pub struct ReviewInviteListRow {
    pub transaction_id: Uuid,
    pub display_id: String,
    pub customer_code: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub review_invite_sent_at: Option<chrono::DateTime<chrono::Utc>>,
    pub review_invite_suppressed_at: Option<chrono::DateTime<chrono::Utc>>,
    pub review_invite_scheduled_for: Option<chrono::DateTime<chrono::Utc>>,
    pub review_invite_last_attempt_at: Option<chrono::DateTime<chrono::Utc>>,
    pub review_invite_last_error: Option<String>,
    pub review_invite_delivery_channel: Option<String>,
    pub podium_review_invite_id: Option<String>,
    pub podium_review_message_id: Option<String>,
    pub podium_review_url: Option<String>,
    pub podium_review_invite_status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewInviteSyncResult {
    pub provider_rows_seen: usize,
    pub rows_updated: u64,
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

fn review_invite_webhook_event_type(value: &Value) -> String {
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
    .unwrap_or_default()
    .to_ascii_lowercase()
}

pub async fn apply_review_invite_webhook(
    pool: &PgPool,
    value: &Value,
) -> Result<bool, sqlx::Error> {
    let event_type = review_invite_webhook_event_type(value);
    if !event_type.starts_with("review.invite_link_") {
        return Ok(false);
    }
    let Some(provider_id) = text_at(
        value,
        &[
            "/data/uid",
            "/data/id",
            "/uid",
            "/id",
            "/data/inviteId",
            "/inviteId",
        ],
    ) else {
        return Ok(false);
    };
    let generated_link_only = text_at(value, &["/data/sender/sentThrough", "/sender/sentThrough"])
        .map(|sent_through| sent_through.eq_ignore_ascii_case("generated_link_only"))
        .unwrap_or(false);
    let status = (!generated_link_only)
        .then(|| text_at(value, &["/data/deliveryStatus", "/deliveryStatus"]))
        .flatten();
    let url = text_at(value, &["/data/shortUrl", "/data/url", "/shortUrl", "/url"]);
    let message_id = text_at(
        value,
        &["/data/conversationItemUid", "/conversationItemUid"],
    );
    let result = sqlx::query(
        r#"
        UPDATE transactions
        SET podium_review_invite_status = COALESCE($2, podium_review_invite_status),
            podium_review_url = COALESCE($3, podium_review_url),
            podium_review_message_id = COALESCE($4, podium_review_message_id)
        WHERE podium_review_invite_id = $1
        "#,
    )
    .bind(provider_id)
    .bind(status.as_deref())
    .bind(url.as_deref())
    .bind(message_id.as_deref())
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn sync_review_invites_from_podium(
    pool: &PgPool,
    http: &reqwest::Client,
    podium_cache: &Arc<Mutex<PodiumTokenCache>>,
    limit: i64,
) -> Result<ReviewInviteSyncResult, ReviewInviteError> {
    let rows = podium::fetch_podium_review_invites(pool, http, podium_cache, limit).await?;
    let mut updated = 0;
    for row in &rows {
        let Some(provider_id) = text_at(
            row,
            &[
                "/id",
                "/uid",
                "/inviteId",
                "/data/id",
                "/data/uid",
                "/data/inviteId",
            ],
        ) else {
            continue;
        };
        let generated_link_only =
            text_at(row, &["/sender/sentThrough", "/data/sender/sentThrough"])
                .map(|value| value.eq_ignore_ascii_case("generated_link_only"))
                .unwrap_or(false);
        let status = (!generated_link_only)
            .then(|| {
                text_at(
                    row,
                    &[
                        "/deliveryStatus",
                        "/data/deliveryStatus",
                        "/status",
                        "/state",
                        "/data/status",
                        "/data/state",
                    ],
                )
            })
            .flatten();
        let url = text_at(
            row,
            &[
                "/url",
                "/link",
                "/reviewUrl",
                "/shortUrl",
                "/data/url",
                "/data/link",
                "/data/reviewUrl",
                "/data/shortUrl",
            ],
        );
        let result = sqlx::query(
            r#"
            UPDATE transactions
            SET podium_review_invite_status = COALESCE($2, podium_review_invite_status),
                podium_review_url = COALESCE($3, podium_review_url)
            WHERE podium_review_invite_id = $1
            "#,
        )
        .bind(provider_id)
        .bind(status.as_deref())
        .bind(url.as_deref())
        .execute(pool)
        .await?;
        updated += result.rows_affected();
    }
    Ok(ReviewInviteSyncResult {
        provider_rows_seen: rows.len(),
        rows_updated: updated,
    })
}

pub async fn list_review_invite_rows(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<ReviewInviteListRow>, sqlx::Error> {
    let lim = limit.clamp(1, 200);
    sqlx::query_as::<_, ReviewInviteListRow>(
        r#"
        SELECT
            o.id AS transaction_id,
            o.display_id,
            c.customer_code,
            c.first_name,
            c.last_name,
            o.review_invite_sent_at,
            o.review_invite_suppressed_at,
            o.review_invite_scheduled_for,
            o.review_invite_last_attempt_at,
            o.review_invite_last_error,
            o.review_invite_delivery_channel,
            o.podium_review_invite_id,
            o.podium_review_message_id,
            o.podium_review_url,
            o.podium_review_invite_status
        FROM transactions o
        LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.podium_review_invite_status IS NOT NULL
           OR o.review_invite_sent_at IS NOT NULL
           OR o.review_invite_suppressed_at IS NOT NULL
        ORDER BY COALESCE(
            o.review_invite_sent_at,
            o.review_invite_suppressed_at,
            o.review_invite_scheduled_for,
            o.review_invite_last_attempt_at,
            o.booked_at
        ) DESC
        LIMIT $1
        "#,
    )
    .bind(lim)
    .fetch_all(pool)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_requests_use_the_evidence_based_five_day_delay() {
        assert_eq!(REVIEW_INVITE_DELAY_DAYS, 5);
        let source = include_str!("podium_reviews.rs");
        assert!(source.contains("review_invite_delivery_time(NOW())"));
        assert!(source.contains("podium_review_invite_status = 'scheduled'"));
        assert!(source.contains("provider_message_id"));
    }

    #[test]
    fn provider_delivery_status_is_preferred() {
        let row = json!({
            "deliveryStatus": "delivered",
            "status": "generated"
        });
        let status = text_at(
            &row,
            &[
                "/deliveryStatus",
                "/data/deliveryStatus",
                "/status",
                "/state",
            ],
        );
        assert_eq!(status.as_deref(), Some("delivered"));
    }

    #[test]
    fn generated_link_only_is_not_a_delivery_status() {
        let row = json!({
            "deliveryStatus": "generated",
            "sender": { "sentThrough": "generated_link_only" }
        });
        let generated_link_only = text_at(&row, &["/sender/sentThrough"])
            .map(|value| value.eq_ignore_ascii_case("generated_link_only"))
            .unwrap_or(false);
        assert!(generated_link_only);
    }

    #[test]
    fn review_webhook_accepts_snake_case_metadata() {
        let value = json!({
            "metadata": { "event_type": "review.invite_link_generated" }
        });

        assert_eq!(
            review_invite_webhook_event_type(&value),
            "review.invite_link_generated"
        );
    }
}
