// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use super::helpers::require_customer_access;
use super::CustomerError;
use crate::api::AppState;
use crate::auth::permissions::CUSTOMERS_DUPLICATE_REVIEW;
use crate::logic::customer_duplicate_candidates::find_duplicate_candidates;
use crate::middleware;
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct DuplicateCandidatesQuery {
    pub email: Option<String>,
    pub phone: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub exclude_customer_id: Option<Uuid>,
    #[serde(default = "default_dup_limit")]
    pub limit: i64,
}

fn default_dup_limit() -> i64 {
    20
}

#[derive(Debug, Serialize, FromRow)]
pub struct DuplicateQueueListRow {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub customer_a_id: Uuid,
    pub customer_b_id: Uuid,
    pub customer_a_code: String,
    pub customer_b_code: String,
    pub customer_a_display: String,
    pub customer_b_display: String,
    pub score: Decimal,
    pub reason: String,
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct DismissDuplicateQueueBody {
    pub id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct EnqueueDuplicateReviewBody {
    pub customer_a_id: Uuid,
    pub customer_b_id: Uuid,
    #[serde(default)]
    pub reason: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/duplicate-candidates", get(get_duplicate_candidates))
        .route("/duplicate-review-queue", get(list_duplicate_review_queue))
        .route(
            "/duplicate-review-queue/dismiss",
            axum::routing::post(post_duplicate_review_queue_dismiss),
        )
        .route(
            "/duplicate-review-queue/enqueue",
            axum::routing::post(post_duplicate_review_queue_enqueue),
        )
}

pub async fn get_duplicate_candidates(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DuplicateCandidatesQuery>,
) -> Result<
    Json<Vec<crate::logic::customer_duplicate_candidates::DuplicateCandidateRow>>,
    CustomerError,
> {
    require_customer_access(&state, &headers).await?;
    let rows = find_duplicate_candidates(
        &state.db,
        q.email.as_deref(),
        q.phone.as_deref(),
        q.first_name.as_deref(),
        q.last_name.as_deref(),
        q.exclude_customer_id,
        q.limit,
    )
    .await?;
    Ok(Json(rows))
}

pub async fn list_duplicate_review_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<DuplicateQueueListRow>>, CustomerError> {
    middleware::require_staff_with_permission(&state, &headers, CUSTOMERS_DUPLICATE_REVIEW)
        .await
        .map_err(|(_, axum::Json(v))| {
            CustomerError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("not authorized")
                    .to_string(),
            )
        })?;
    let rows = sqlx::query_as::<_, DuplicateQueueListRow>(
        r#"
        SELECT
            q.id,
            q.created_at,
            q.customer_a_id,
            q.customer_b_id,
            ca.customer_code AS customer_a_code,
            cb.customer_code AS customer_b_code,
            COALESCE(
                NULLIF(TRIM(CONCAT_WS(' ', ca.first_name, ca.last_name)), ''),
                NULLIF(TRIM(COALESCE(ca.company_name, '')), ''),
                ca.customer_code
            ) AS customer_a_display,
            COALESCE(
                NULLIF(TRIM(CONCAT_WS(' ', cb.first_name, cb.last_name)), ''),
                NULLIF(TRIM(COALESCE(cb.company_name, '')), ''),
                cb.customer_code
            ) AS customer_b_display,
            q.score,
            q.reason,
            q.status
        FROM customer_duplicate_review_queue q
        JOIN customers ca ON ca.id = q.customer_a_id
        JOIN customers cb ON cb.id = q.customer_b_id
        WHERE q.status = 'pending'
        ORDER BY q.created_at DESC
        LIMIT 200
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

pub async fn post_duplicate_review_queue_enqueue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<EnqueueDuplicateReviewBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    middleware::require_staff_with_permission(&state, &headers, CUSTOMERS_DUPLICATE_REVIEW)
        .await
        .map_err(|(_, axum::Json(v))| {
            CustomerError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("not authorized")
                    .to_string(),
            )
        })?;
    let (a, b) = if body.customer_a_id < body.customer_b_id {
        (body.customer_a_id, body.customer_b_id)
    } else {
        (body.customer_b_id, body.customer_a_id)
    };
    if a == b {
        return Err(CustomerError::BadRequest(
            "Choose two different customers.".to_string(),
        ));
    }
    let pending: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM customer_duplicate_review_queue
            WHERE customer_a_id = $1 AND customer_b_id = $2 AND status = 'pending'
        )
        "#,
    )
    .bind(a)
    .bind(b)
    .fetch_one(&state.db)
    .await?;
    if pending {
        return Ok(Json(json!({ "status": "already_queued" })));
    }
    let reason = body.reason.trim().to_string();
    sqlx::query(
        r#"
        INSERT INTO customer_duplicate_review_queue (
            customer_a_id, customer_b_id, score, reason, status
        )
        VALUES ($1, $2, 0, $3, 'pending')
        "#,
    )
    .bind(a)
    .bind(b)
    .bind(if reason.is_empty() {
        "manual_queue".to_string()
    } else {
        reason
    })
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "status": "queued" })))
}

pub async fn post_duplicate_review_queue_dismiss(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<DismissDuplicateQueueBody>,
) -> Result<Json<serde_json::Value>, CustomerError> {
    middleware::require_staff_with_permission(&state, &headers, CUSTOMERS_DUPLICATE_REVIEW)
        .await
        .map_err(|(_, axum::Json(v))| {
            CustomerError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("not authorized")
                    .to_string(),
            )
        })?;
    let r = sqlx::query(
        r#"
        UPDATE customer_duplicate_review_queue
        SET status = 'dismissed'
        WHERE id = $1 AND status = 'pending'
        "#,
    )
    .bind(body.id)
    .execute(&state.db)
    .await?;
    if r.rows_affected() == 0 {
        return Err(CustomerError::NotFound);
    }
    Ok(Json(json!({ "status": "dismissed" })))
}
