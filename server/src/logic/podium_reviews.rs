//! Podium post-sale review invite tracking.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::logic::notifications::{admin_staff_ids, staff_ids_with_permission, upsert_bundle_item};
use crate::logic::podium::{self, PodiumTokenCache};

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
}

type OrderReviewGateRow = (
    Option<Uuid>,
    Option<chrono::DateTime<chrono::Utc>>,
    Option<chrono::DateTime<chrono::Utc>>,
    Option<String>,
    String,
    String,
    Option<String>,
    Option<String>,
    bool,
    bool,
    bool,
);

/// Persist cashier choice at end of receipt flow. Sends a Podium review invite only
/// for completed, fulfilled sales and enforces one invite per customer per 180 days.
pub async fn apply_post_sale_review_choice(
    pool: &PgPool,
    http: &reqwest::Client,
    podium_cache: &Arc<Mutex<PodiumTokenCache>>,
    transaction_id: Uuid,
    skip_invite: bool,
) -> Result<(), ReviewInviteError> {
    let policy = load_store_review_policy(pool).await?;

    let mut tx = pool.begin().await?;

    let row: Option<OrderReviewGateRow> = sqlx::query_as(
        r#"
        SELECT
            t.customer_id,
            t.review_invite_suppressed_at,
            t.review_invite_sent_at,
            t.podium_review_invite_id,
            t.display_id,
            t.status::text,
            c.phone,
            c.email,
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
            ) AS recent_customer_invite
        FROM transactions t
        LEFT JOIN customers c ON c.id = t.customer_id
        WHERE t.id = $1
        FOR UPDATE OF t
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((
        customer_id,
        suppressed_at,
        sent_at,
        provider_id,
        display_id,
        status,
        phone,
        email,
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
        return Ok(());
    }

    if !policy.review_invites_enabled {
        tx.commit().await?;
        return Ok(());
    }

    if suppressed_at.is_some() || sent_at.is_some() {
        tx.commit().await?;
        return Ok(());
    }

    if status != "fulfilled"
        || customer_id.is_none()
        || !has_reviewable_lines
        || !all_reviewable_lines_fulfilled
    {
        tx.commit().await?;
        return Ok(());
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
        return Ok(());
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
        return Ok(());
    }

    tx.commit().await?;

    let invite = podium::create_podium_review_invite(
        pool,
        http,
        podium_cache,
        phone.as_deref(),
        email.as_deref(),
    )
    .await?;
    let final_provider_id = invite
        .provider_id
        .as_deref()
        .or(provider_id.as_deref())
        .unwrap_or("podium_review_invite_sent")
        .to_string();

    sqlx::query(
        r#"
        UPDATE transactions
        SET review_invite_sent_at = NOW(),
            podium_review_invite_id = $2,
            podium_review_url = $3,
            podium_review_invite_status = 'sent'
        WHERE id = $1
          AND review_invite_sent_at IS NULL
          AND review_invite_suppressed_at IS NULL
        "#,
    )
    .bind(transaction_id)
    .bind(final_provider_id)
    .bind(invite.review_url.as_deref())
    .execute(pool)
    .await?;

    if let Ok(nid) = upsert_bundle_item(
        pool,
        "review_invite_sent",
        "Review follow-up",
        "Review invite ready",
        &format!(
            "{display_id} is marked for a customer review follow-up. Open Reviews to check status."
        ),
        json!({
            "type": "home",
            "subsection": "reviews",
            "transaction_id": transaction_id.to_string(),
        }),
        "podium_reviews",
        json!({}),
        "review_invites_daily_bundle",
    )
    .await
    {
        let admins = admin_staff_ids(pool).await.unwrap_or_default();
        let reviewers = staff_ids_with_permission(pool, crate::auth::permissions::REVIEWS_VIEW)
            .await
            .unwrap_or_default();
        let mut targets = [admins, reviewers].concat();
        targets.sort_unstable();
        targets.dedup();
        if !targets.is_empty() {
            let _ =
                crate::logic::notifications::fan_out_notification_to_staff_ids(pool, nid, &targets)
                    .await;
        }
    }

    Ok(())
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
    pub podium_review_invite_id: Option<String>,
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
        let status = text_at(row, &["/status", "/state", "/data/status", "/data/state"]);
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
            o.podium_review_invite_id,
            o.podium_review_url,
            o.podium_review_invite_status
        FROM transactions o
        LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.review_invite_sent_at IS NOT NULL
           OR o.review_invite_suppressed_at IS NOT NULL
        ORDER BY COALESCE(o.review_invite_sent_at, o.review_invite_suppressed_at, o.booked_at) DESC
        LIMIT $1
        "#,
    )
    .bind(lim)
    .fetch_all(pool)
    .await
}
