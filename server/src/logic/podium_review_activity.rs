//! Podium review lifecycle webhooks -> Operations review feed and Inbox activity.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

const REVIEW_EVENT_TYPES: &[&str] = &[
    "review.created",
    "review.updated",
    "review.response_created",
    "review.response_updated",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PodiumReviewWebhookOutcome {
    Processed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PodiumReviewActivityRow {
    pub id: Uuid,
    pub provider_review_uid: String,
    pub last_event_type: String,
    pub transaction_id: Option<Uuid>,
    pub display_id: Option<String>,
    pub customer_id: Option<Uuid>,
    pub customer_code: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub conversation_id: Option<Uuid>,
    pub author_name: Option<String>,
    pub rating: Option<i16>,
    pub review_body: Option<String>,
    pub review_url: Option<String>,
    pub site_name: Option<String>,
    pub is_recommendation: bool,
    pub needs_response: bool,
    pub published_at: DateTime<Utc>,
    pub last_activity_at: DateTime<Utc>,
    pub response_count: i64,
    pub latest_response_body: Option<String>,
    pub latest_response_author_name: Option<String>,
    pub latest_response_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
struct ParsedReview {
    provider_review_uid: String,
    review_invitation_uids: Vec<String>,
    author_name: Option<String>,
    rating: Option<i16>,
    review_body: Option<String>,
    review_url: Option<String>,
    site_name: Option<String>,
    site_review_id: Option<String>,
    is_recommendation: bool,
    needs_response: bool,
    published_at: DateTime<Utc>,
    provider_updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
struct ParsedResponse {
    provider_review_uid: Option<String>,
    provider_response_uid: String,
    body: Option<String>,
    author_name: Option<String>,
    source: Option<String>,
    is_deleted: bool,
    like_count: Option<i32>,
    published_at: DateTime<Utc>,
}

fn text_at(value: &Value, paths: &[&str]) -> Option<String> {
    paths.iter().find_map(|path| {
        value
            .pointer(path)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    })
}

fn bool_at(value: &Value, paths: &[&str]) -> Option<bool> {
    paths
        .iter()
        .find_map(|path| value.pointer(path).and_then(Value::as_bool))
}

fn integer_at(value: &Value, paths: &[&str]) -> Option<i64> {
    paths.iter().find_map(|path| {
        let candidate = value.pointer(path)?;
        candidate
            .as_i64()
            .or_else(|| {
                candidate
                    .as_u64()
                    .and_then(|number| i64::try_from(number).ok())
            })
            .or_else(|| candidate.as_str()?.trim().parse::<i64>().ok())
    })
}

fn timestamp_at(value: &Value, paths: &[&str]) -> Option<DateTime<Utc>> {
    text_at(value, paths).and_then(|raw| {
        DateTime::parse_from_rfc3339(&raw)
            .ok()
            .map(|timestamp| timestamp.with_timezone(&Utc))
    })
}

fn event_type(value: &Value) -> Option<String> {
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
    .map(|event_type| event_type.to_ascii_lowercase())
    .filter(|event_type| REVIEW_EVENT_TYPES.contains(&event_type.as_str()))
}

fn payload_hash_uid(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn has_review_shape(value: &Value) -> bool {
    [
        "/data/review/body",
        "/data/review/rating",
        "/data/needsResponse",
        "/data/author/name",
        "/review/body",
        "/needsResponse",
    ]
    .iter()
    .any(|path| value.pointer(path).is_some())
}

fn explicit_review_uid(value: &Value) -> Option<String> {
    text_at(
        value,
        &[
            "/data/reviewUid",
            "/data/review_uid",
            "/data/review/uid",
            "/reviewUid",
            "/review_uid",
            "/metadata/reviewUid",
            "/metadata/review_uid",
            "/metadata/resourceUid",
            "/metadata/resource_uid",
        ],
    )
}

fn review_invitation_uids(value: &Value) -> Vec<String> {
    [
        "/data/attributions",
        "/attributions",
        "/data/review/attributions",
    ]
    .iter()
    .filter_map(|path| value.pointer(path).and_then(Value::as_array))
    .flatten()
    .filter_map(|attribution| {
        text_at(
            attribution,
            &["/reviewInvitationUid", "/review_invitation_uid"],
        )
    })
    .collect()
}

fn parse_review(value: &Value, event_type: &str) -> Option<ParsedReview> {
    if event_type.starts_with("review.response_") && !has_review_shape(value) {
        return None;
    }
    let provider_review_uid = explicit_review_uid(value)
        .or_else(|| text_at(value, &["/data/uid", "/data/id", "/uid", "/id"]))?;
    let published_at = timestamp_at(
        value,
        &[
            "/data/createdAt",
            "/data/created_at",
            "/createdAt",
            "/created_at",
        ],
    )
    .unwrap_or_else(Utc::now);
    let provider_updated_at = timestamp_at(
        value,
        &[
            "/data/updatedAt",
            "/data/updated_at",
            "/updatedAt",
            "/updated_at",
        ],
    );
    let rating = integer_at(
        value,
        &[
            "/data/review/rating",
            "/review/rating",
            "/data/rating",
            "/rating",
        ],
    )
    .filter(|rating| (1..=5).contains(rating))
    .and_then(|rating| i16::try_from(rating).ok());

    Some(ParsedReview {
        provider_review_uid,
        review_invitation_uids: review_invitation_uids(value),
        author_name: text_at(
            value,
            &[
                "/data/author/name",
                "/author/name",
                "/data/authorName",
                "/authorName",
            ],
        ),
        rating,
        review_body: text_at(
            value,
            &["/data/review/body", "/review/body", "/data/body", "/body"],
        ),
        review_url: text_at(
            value,
            &["/data/review/url", "/review/url", "/data/url", "/url"],
        ),
        site_name: text_at(
            value,
            &[
                "/data/review/siteName",
                "/review/siteName",
                "/data/siteName",
                "/siteName",
            ],
        ),
        site_review_id: text_at(
            value,
            &[
                "/data/review/siteReviewId",
                "/review/siteReviewId",
                "/data/siteReviewId",
                "/siteReviewId",
            ],
        ),
        is_recommendation: bool_at(
            value,
            &[
                "/data/isRecommendation",
                "/isRecommendation",
                "/data/is_recommendation",
            ],
        )
        .unwrap_or(false),
        needs_response: bool_at(
            value,
            &[
                "/data/needsResponse",
                "/needsResponse",
                "/data/needs_response",
            ],
        )
        .unwrap_or(false),
        published_at,
        provider_updated_at,
    })
}

fn parse_response(value: &Value, event_type: &str) -> Option<ParsedResponse> {
    if !event_type.starts_with("review.response_") {
        return None;
    }
    let provider_response_uid = text_at(
        value,
        &[
            "/data/response/uid",
            "/response/uid",
            "/data/responseUid",
            "/responseUid",
            "/data/uid",
            "/uid",
        ],
    )
    .or_else(|| {
        text_at(
            value,
            &[
                "/metadata/eventUid",
                "/metadata/event_uid",
                "/eventUid",
                "/event_uid",
            ],
        )
    })
    .unwrap_or_else(|| payload_hash_uid(value));
    let published_at = timestamp_at(
        value,
        &[
            "/data/response/publishDate",
            "/response/publishDate",
            "/data/publishDate",
            "/publishDate",
            "/data/updatedAt",
            "/updatedAt",
        ],
    )
    .unwrap_or_else(Utc::now);

    Some(ParsedResponse {
        provider_review_uid: explicit_review_uid(value).or_else(|| {
            has_review_shape(value)
                .then(|| text_at(value, &["/data/uid", "/uid"]))
                .flatten()
        }),
        provider_response_uid,
        body: text_at(
            value,
            &[
                "/data/response/body",
                "/response/body",
                "/data/body",
                "/body",
            ],
        ),
        author_name: text_at(
            value,
            &[
                "/data/response/siteAuthorName",
                "/response/siteAuthorName",
                "/data/siteAuthorName",
                "/siteAuthorName",
            ],
        ),
        source: text_at(
            value,
            &[
                "/data/response/source",
                "/response/source",
                "/data/source",
                "/source",
            ],
        ),
        is_deleted: bool_at(
            value,
            &[
                "/data/response/isDeleted",
                "/response/isDeleted",
                "/data/isDeleted",
                "/isDeleted",
            ],
        )
        .unwrap_or(false),
        like_count: integer_at(
            value,
            &[
                "/data/response/likeCount",
                "/response/likeCount",
                "/data/likeCount",
                "/likeCount",
            ],
        )
        .filter(|count| *count >= 0)
        .and_then(|count| i32::try_from(count).ok()),
        published_at,
    })
}

async fn existing_review_context(
    pool: &PgPool,
    provider_review_uid: &str,
) -> Result<Option<(Option<Uuid>, Option<Uuid>, Option<Uuid>)>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT transaction_id, customer_id, conversation_id
        FROM podium_review
        WHERE provider_review_uid = $1
        "#,
    )
    .bind(provider_review_uid)
    .fetch_optional(pool)
    .await
}

async fn linked_transaction(
    pool: &PgPool,
    invitation_uids: &[String],
) -> Result<Option<(Uuid, Option<Uuid>)>, sqlx::Error> {
    if invitation_uids.is_empty() {
        return Ok(None);
    }
    sqlx::query_as(
        r#"
        SELECT id, customer_id
        FROM transactions
        WHERE podium_review_invite_id = ANY($1)
        ORDER BY review_invite_sent_at DESC NULLS LAST, booked_at DESC
        LIMIT 1
        "#,
    )
    .bind(invitation_uids)
    .fetch_optional(pool)
    .await
}

async fn latest_customer_conversation(
    pool: &PgPool,
    customer_id: Option<Uuid>,
) -> Result<Option<Uuid>, sqlx::Error> {
    let Some(customer_id) = customer_id else {
        return Ok(None);
    };
    sqlx::query_scalar(
        r#"
        SELECT id
        FROM podium_conversation
        WHERE customer_id = $1
        ORDER BY last_message_at DESC
        LIMIT 1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await
}

pub async fn apply_review_webhook(
    pool: &PgPool,
    value: &Value,
) -> Result<PodiumReviewWebhookOutcome, sqlx::Error> {
    let Some(event_type) = event_type(value) else {
        return Ok(PodiumReviewWebhookOutcome::Skipped);
    };
    let parsed_review = parse_review(value, &event_type);
    let parsed_response = parse_response(value, &event_type);
    let mut review_id: Option<Uuid> = None;
    let mut conversation_id = None;
    let mut activity_at = None;
    let mut tx = pool.begin().await?;

    if let Some(review) = parsed_review.as_ref() {
        let existing = existing_review_context(pool, &review.provider_review_uid).await?;
        let linked = linked_transaction(pool, &review.review_invitation_uids).await?;
        let transaction_id = linked
            .as_ref()
            .map(|(transaction_id, _)| *transaction_id)
            .or_else(|| {
                existing
                    .as_ref()
                    .and_then(|(transaction_id, _, _)| *transaction_id)
            });
        let customer_id = linked
            .as_ref()
            .and_then(|(_, customer_id)| *customer_id)
            .or_else(|| {
                existing
                    .as_ref()
                    .and_then(|(_, customer_id, _)| *customer_id)
            });
        conversation_id = existing
            .as_ref()
            .and_then(|(_, _, conversation_id)| *conversation_id)
            .or(latest_customer_conversation(pool, customer_id).await?);
        let last_activity_at = review.provider_updated_at.unwrap_or(review.published_at);
        activity_at = Some(last_activity_at);
        let invitation_uid = review.review_invitation_uids.first().map(String::as_str);
        review_id = Some(
            sqlx::query_scalar(
                r#"
                INSERT INTO podium_review (
                    provider_review_uid, review_invitation_uid, transaction_id, customer_id,
                    conversation_id, author_name, rating, review_body, review_url, site_name,
                    site_review_id, is_recommendation, needs_response, last_event_type,
                    published_at, provider_updated_at, last_activity_at, raw_payload
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                    $15, $16, $17, $18
                )
                ON CONFLICT (provider_review_uid) DO UPDATE SET
                    review_invitation_uid = COALESCE(
                        EXCLUDED.review_invitation_uid,
                        podium_review.review_invitation_uid
                    ),
                    transaction_id = COALESCE(EXCLUDED.transaction_id, podium_review.transaction_id),
                    customer_id = COALESCE(EXCLUDED.customer_id, podium_review.customer_id),
                    conversation_id = COALESCE(EXCLUDED.conversation_id, podium_review.conversation_id),
                    author_name = COALESCE(EXCLUDED.author_name, podium_review.author_name),
                    rating = COALESCE(EXCLUDED.rating, podium_review.rating),
                    review_body = COALESCE(EXCLUDED.review_body, podium_review.review_body),
                    review_url = COALESCE(EXCLUDED.review_url, podium_review.review_url),
                    site_name = COALESCE(EXCLUDED.site_name, podium_review.site_name),
                    site_review_id = COALESCE(EXCLUDED.site_review_id, podium_review.site_review_id),
                    is_recommendation = CASE
                        WHEN EXCLUDED.last_activity_at >= podium_review.last_activity_at
                        THEN EXCLUDED.is_recommendation
                        ELSE podium_review.is_recommendation
                    END,
                    needs_response = CASE
                        WHEN EXCLUDED.last_activity_at >= podium_review.last_activity_at
                        THEN EXCLUDED.needs_response
                        ELSE podium_review.needs_response
                    END,
                    last_event_type = CASE
                        WHEN EXCLUDED.last_activity_at >= podium_review.last_activity_at
                        THEN EXCLUDED.last_event_type
                        ELSE podium_review.last_event_type
                    END,
                    published_at = LEAST(EXCLUDED.published_at, podium_review.published_at),
                    provider_updated_at = GREATEST(
                        EXCLUDED.provider_updated_at,
                        podium_review.provider_updated_at
                    ),
                    last_activity_at = GREATEST(
                        EXCLUDED.last_activity_at,
                        podium_review.last_activity_at
                    ),
                    raw_payload = CASE
                        WHEN EXCLUDED.last_activity_at >= podium_review.last_activity_at
                        THEN EXCLUDED.raw_payload
                        ELSE podium_review.raw_payload
                    END,
                    updated_at = NOW()
                RETURNING id
                "#,
            )
            .bind(&review.provider_review_uid)
            .bind(invitation_uid)
            .bind(transaction_id)
            .bind(customer_id)
            .bind(conversation_id)
            .bind(review.author_name.as_deref())
            .bind(review.rating)
            .bind(review.review_body.as_deref())
            .bind(review.review_url.as_deref())
            .bind(review.site_name.as_deref())
            .bind(review.site_review_id.as_deref())
            .bind(review.is_recommendation)
            .bind(review.needs_response)
            .bind(&event_type)
            .bind(review.published_at)
            .bind(review.provider_updated_at)
            .bind(last_activity_at)
            .bind(value)
            .fetch_one(&mut *tx)
            .await?,
        );
        sqlx::query(
            r#"
            UPDATE podium_review_response
            SET review_id = $1, updated_at = NOW()
            WHERE provider_review_uid = $2
              AND review_id IS NULL
            "#,
        )
        .bind(review_id)
        .bind(&review.provider_review_uid)
        .execute(&mut *tx)
        .await?;
    }

    if let Some(response) = parsed_response.as_ref() {
        let response_review_id = if let Some(review_id) = review_id {
            Some(review_id)
        } else if let Some(provider_review_uid) = response.provider_review_uid.as_deref() {
            sqlx::query_scalar("SELECT id FROM podium_review WHERE provider_review_uid = $1")
                .bind(provider_review_uid)
                .fetch_optional(&mut *tx)
                .await?
        } else {
            None
        };
        sqlx::query(
            r#"
            INSERT INTO podium_review_response (
                review_id, provider_review_uid, provider_response_uid, body, author_name,
                source, is_deleted, like_count, published_at, raw_payload
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (provider_response_uid) DO UPDATE SET
                review_id = COALESCE(EXCLUDED.review_id, podium_review_response.review_id),
                provider_review_uid = COALESCE(
                    EXCLUDED.provider_review_uid,
                    podium_review_response.provider_review_uid
                ),
                body = COALESCE(EXCLUDED.body, podium_review_response.body),
                author_name = COALESCE(EXCLUDED.author_name, podium_review_response.author_name),
                source = COALESCE(EXCLUDED.source, podium_review_response.source),
                is_deleted = EXCLUDED.is_deleted,
                like_count = COALESCE(EXCLUDED.like_count, podium_review_response.like_count),
                published_at = EXCLUDED.published_at,
                raw_payload = EXCLUDED.raw_payload,
                updated_at = NOW()
            "#,
        )
        .bind(response_review_id)
        .bind(response.provider_review_uid.as_deref())
        .bind(&response.provider_response_uid)
        .bind(response.body.as_deref())
        .bind(response.author_name.as_deref())
        .bind(response.source.as_deref())
        .bind(response.is_deleted)
        .bind(response.like_count)
        .bind(response.published_at)
        .bind(value)
        .execute(&mut *tx)
        .await?;

        if let Some(response_review_id) = response_review_id {
            let linked_conversation_id: Option<Uuid> = sqlx::query_scalar(
                r#"
                UPDATE podium_review
                SET needs_response = CASE
                        WHEN $4 >= last_activity_at THEN $2
                        ELSE needs_response
                    END,
                    last_event_type = CASE
                        WHEN $4 >= last_activity_at THEN $3
                        ELSE last_event_type
                    END,
                    last_activity_at = GREATEST(last_activity_at, $4),
                    updated_at = NOW()
                WHERE id = $1
                RETURNING conversation_id
                "#,
            )
            .bind(response_review_id)
            .bind(response.is_deleted)
            .bind(&event_type)
            .bind(response.published_at)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
            conversation_id = conversation_id.or(linked_conversation_id);
            activity_at = Some(
                activity_at
                    .map(|timestamp| timestamp.max(response.published_at))
                    .unwrap_or(response.published_at),
            );
        }
    }

    if let (Some(conversation_id), Some(activity_at)) = (conversation_id, activity_at) {
        sqlx::query(
            r#"
            UPDATE podium_conversation
            SET last_message_at = GREATEST(last_message_at, $2)
            WHERE id = $1
            "#,
        )
        .bind(conversation_id)
        .bind(activity_at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    if parsed_review.is_none()
        && parsed_response.is_some_and(|response| response.provider_review_uid.is_none())
    {
        tracing::warn!(
            target = "podium_reviews",
            event_type,
            "Stored Podium review response without a provider review UID"
        );
    }
    Ok(PodiumReviewWebhookOutcome::Processed)
}

const REVIEW_ACTIVITY_SELECT: &str = r#"
    SELECT
        pr.id,
        pr.provider_review_uid,
        pr.last_event_type,
        pr.transaction_id,
        t.display_id,
        pr.customer_id,
        c.customer_code,
        c.first_name,
        c.last_name,
        pr.conversation_id,
        pr.author_name,
        pr.rating,
        pr.review_body,
        pr.review_url,
        pr.site_name,
        pr.is_recommendation,
        pr.needs_response,
        pr.published_at,
        pr.last_activity_at,
        (
            SELECT COUNT(*)::bigint
            FROM podium_review_response response_count
            WHERE response_count.review_id = pr.id
              AND response_count.is_deleted = FALSE
        ) AS response_count,
        latest_response.body AS latest_response_body,
        latest_response.author_name AS latest_response_author_name,
        latest_response.published_at AS latest_response_at
    FROM podium_review pr
    LEFT JOIN transactions t ON t.id = pr.transaction_id
    LEFT JOIN customers c ON c.id = pr.customer_id
    LEFT JOIN LATERAL (
        SELECT response.body, response.author_name, response.published_at
        FROM podium_review_response response
        WHERE response.review_id = pr.id
          AND response.is_deleted = FALSE
        ORDER BY response.published_at DESC, response.updated_at DESC
        LIMIT 1
    ) latest_response ON TRUE
"#;

pub async fn list_reviews_for_conversation(
    pool: &PgPool,
    conversation_id: Uuid,
) -> Result<Vec<PodiumReviewActivityRow>, sqlx::Error> {
    let sql = format!(
        "{REVIEW_ACTIVITY_SELECT} WHERE pr.conversation_id = $1 ORDER BY pr.last_activity_at ASC"
    );
    sqlx::query_as::<_, PodiumReviewActivityRow>(&sql)
        .bind(conversation_id)
        .fetch_all(pool)
        .await
}

pub async fn list_reviews_for_operations(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<PodiumReviewActivityRow>, sqlx::Error> {
    let sql = format!("{REVIEW_ACTIVITY_SELECT} ORDER BY pr.last_activity_at DESC LIMIT $1");
    sqlx::query_as::<_, PodiumReviewActivityRow>(&sql)
        .bind(limit.clamp(1, 200))
        .fetch_all(pool)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_documented_review_object_and_attribution() {
        let payload = json!({
            "metadata": { "eventType": "review.created", "eventUid": "event-1" },
            "data": {
                "uid": "review-1",
                "author": { "name": "Chris Customer" },
                "review": {
                    "body": "Wonderful service",
                    "url": "https://example.com/review-1",
                    "rating": 5,
                    "siteName": "Google"
                },
                "createdAt": "2026-08-12T15:00:00Z",
                "attributions": [{ "reviewInvitationUid": "invite-1" }],
                "needsResponse": true
            }
        });
        let parsed = parse_review(&payload, "review.created").expect("review");
        assert_eq!(parsed.provider_review_uid, "review-1");
        assert_eq!(parsed.rating, Some(5));
        assert_eq!(parsed.review_invitation_uids, vec!["invite-1"]);
        assert!(parsed.needs_response);
    }

    #[test]
    fn parses_documented_review_response_object() {
        let payload = json!({
            "metadata": { "eventType": "review.response_created" },
            "data": {
                "reviewUid": "review-1",
                "response": {
                    "uid": "response-1",
                    "body": "Thank you!",
                    "publishDate": "2026-08-12T16:00:00Z",
                    "siteAuthorName": "Riverside Men's Shop",
                    "isDeleted": false
                }
            }
        });
        let parsed = parse_response(&payload, "review.response_created").expect("response");
        assert_eq!(parsed.provider_review_uid.as_deref(), Some("review-1"));
        assert_eq!(parsed.provider_response_uid, "response-1");
        assert_eq!(parsed.body.as_deref(), Some("Thank you!"));
    }

    #[test]
    fn ignores_non_review_activity() {
        assert!(event_type(&json!({
            "metadata": { "eventType": "review.invite_link_updated" }
        }))
        .is_none());
    }
}
