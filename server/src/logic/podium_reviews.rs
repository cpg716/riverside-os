//! Podium post-sale review invite tracking.

use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

use crate::logic::notifications::{admin_staff_ids, staff_ids_with_permission, upsert_bundle_item};

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
}

/// Persist cashier choice at end of receipt flow. Stub invite when not skipped and policy allows.
pub async fn apply_post_sale_review_choice(
    pool: &PgPool,
    transaction_id: Uuid,
    skip_invite: bool,
) -> Result<(), ReviewInviteError> {
    let policy = load_store_review_policy(pool).await?;

    let mut tx = pool.begin().await?;

    type OrderReviewGateRow = (
        Option<Uuid>,
        Option<chrono::DateTime<chrono::Utc>>,
        Option<chrono::DateTime<chrono::Utc>>,
        String,
    );
    let row: Option<OrderReviewGateRow> = sqlx::query_as(
        r#"
        SELECT customer_id, review_invite_suppressed_at, review_invite_sent_at, display_id
        FROM transactions WHERE id = $1 FOR UPDATE
        "#,
    )
    .bind(transaction_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((customer_id, suppressed_at, sent_at, display_id)) = row else {
        return Err(ReviewInviteError::NotFound);
    };

    if skip_invite {
        if suppressed_at.is_none() {
            sqlx::query(
                r#"UPDATE transactions SET review_invite_suppressed_at = NOW() WHERE id = $1"#,
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

    if customer_id.is_none() {
        tx.commit().await?;
        return Ok(());
    }

    sqlx::query(
        r#"
        UPDATE transactions
        SET review_invite_sent_at = NOW(),
            podium_review_invite_id = COALESCE(podium_review_invite_id, 'ros_stub_pending_podium_api')
        WHERE id = $1
        "#,
    )
    .bind(transaction_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

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
            o.podium_review_invite_id
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
