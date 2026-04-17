//! Alteration work orders (tailoring / fittings).

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::types::Json as SqlxJson;
use sqlx::FromRow;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::ALTERATIONS_MANAGE;
use crate::auth::pins::AuthenticatedStaff;
use crate::logic::messaging::MessagingService;
use crate::middleware;

#[derive(Debug, Serialize, FromRow)]
pub struct AlterationOrderRow {
    pub id: Uuid,
    pub customer_id: Uuid,
    pub customer_first_name: Option<String>,
    pub customer_last_name: Option<String>,
    pub customer_code: Option<String>,
    pub wedding_member_id: Option<Uuid>,
    pub status: String,
    pub due_at: Option<DateTime<Utc>>,
    pub notes: Option<String>,
    pub linked_transaction_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ListAlterationsQuery {
    pub status: Option<String>,
    pub customer_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct CreateAlterationBody {
    pub customer_id: Uuid,
    pub wedding_member_id: Option<Uuid>,
    pub due_at: Option<DateTime<Utc>>,
    pub notes: Option<String>,
    pub linked_transaction_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct PatchAlterationBody {
    pub status: Option<String>,
    pub due_at: Option<DateTime<Utc>>,
    pub notes: Option<String>,
}

#[derive(Debug, thiserror::Error)]
enum AlterationError {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("not found")]
    NotFound,
}

impl IntoResponse for AlterationError {
    fn into_response(self) -> Response {
        let (code, msg) = match self {
            AlterationError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AlterationError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            AlterationError::NotFound => (StatusCode::NOT_FOUND, "Not found".to_string()),
            AlterationError::Db(e) => {
                tracing::error!(error = %e, "alterations database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal error".to_string(),
                )
            }
        };
        (code, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_alterations).post(create_alteration))
        .route("/{id}", patch(patch_alteration))
}

async fn require_manage(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthenticatedStaff, AlterationError> {
    middleware::require_staff_with_permission(state, headers, ALTERATIONS_MANAGE)
        .await
        .map_err(|(_c, axum::Json(v))| {
            AlterationError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("not authorized")
                    .to_string(),
            )
        })
}

async fn list_alterations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListAlterationsQuery>,
) -> Result<Json<Vec<AlterationOrderRow>>, AlterationError> {
    let _staff = require_manage(&state, &headers).await?;

    let st = q
        .status
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let rows = if let Some(cid) = q.customer_id {
        if let Some(ref status) = st {
            sqlx::query_as::<_, AlterationOrderRow>(
                r#"
                SELECT a.id, a.customer_id, c.first_name as customer_first_name, c.last_name as customer_last_name, 
                       c.customer_code, a.wedding_member_id, a.status::text AS status,
                       a.due_at, a.notes, a.linked_transaction_id, a.created_at, a.updated_at
                FROM alteration_orders a
                LEFT JOIN customers c ON a.customer_id = c.id
                WHERE a.customer_id = $1 AND a.status::text = $2
                ORDER BY a.created_at DESC
                LIMIT 200
                "#,
            )
            .bind(cid)
            .bind(status)
            .fetch_all(&state.db)
            .await?
        } else {
            sqlx::query_as::<_, AlterationOrderRow>(
                r#"
                SELECT a.id, a.customer_id, c.first_name as customer_first_name, c.last_name as customer_last_name, 
                       c.customer_code, a.wedding_member_id, a.status::text AS status,
                       a.due_at, a.notes, a.linked_transaction_id, a.created_at, a.updated_at
                FROM alteration_orders a
                LEFT JOIN customers c ON a.customer_id = c.id
                WHERE a.customer_id = $1
                ORDER BY a.created_at DESC
                LIMIT 200
                "#,
            )
            .bind(cid)
            .fetch_all(&state.db)
            .await?
        }
    } else if let Some(ref status) = st {
        sqlx::query_as::<_, AlterationOrderRow>(
            r#"
            SELECT a.id, a.customer_id, c.first_name as customer_first_name, c.last_name as customer_last_name, 
                   c.customer_code, a.wedding_member_id, a.status::text AS status,
                   a.due_at, a.notes, a.linked_transaction_id, a.created_at, a.updated_at
            FROM alteration_orders a
            LEFT JOIN customers c ON a.customer_id = c.id
            WHERE a.status::text = $1
            ORDER BY a.created_at DESC
            LIMIT 200
            "#,
        )
        .bind(status)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, AlterationOrderRow>(
            r#"
            SELECT a.id, a.customer_id, c.first_name as customer_first_name, c.last_name as customer_last_name, 
                   c.customer_code, a.wedding_member_id, a.status::text AS status,
                   a.due_at, a.notes, a.linked_transaction_id, a.created_at, a.updated_at
            FROM alteration_orders a
            LEFT JOIN customers c ON a.customer_id = c.id
            ORDER BY a.created_at DESC
            LIMIT 200
            "#,
        )
        .fetch_all(&state.db)
        .await?
    };

    Ok(Json(rows))
}

async fn create_alteration(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateAlterationBody>,
) -> Result<Json<AlterationOrderRow>, AlterationError> {
    let _staff = require_manage(&state, &headers).await?;

    let ok: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)")
        .bind(body.customer_id)
        .fetch_one(&state.db)
        .await?;
    if !ok {
        return Err(AlterationError::BadRequest(
            "customer not found".to_string(),
        ));
    }

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO alteration_orders (
            customer_id, wedding_member_id, due_at, notes, linked_transaction_id
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        "#,
    )
    .bind(body.customer_id)
    .bind(body.wedding_member_id)
    .bind(body.due_at)
    .bind(
        body.notes
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty()),
    )
    .bind(body.linked_transaction_id)
    .fetch_one(&state.db)
    .await?;

    let row = sqlx::query_as::<_, AlterationOrderRow>(
        r#"
        SELECT a.id, a.customer_id, c.first_name as customer_first_name, c.last_name as customer_last_name, 
               c.customer_code, a.wedding_member_id, a.status::text AS status,
               a.due_at, a.notes, a.linked_transaction_id, a.created_at, a.updated_at
        FROM alteration_orders a
        LEFT JOIN customers c ON a.customer_id = c.id
        WHERE a.id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AlterationError::NotFound)?;

    Ok(Json(row))
}

async fn patch_alteration(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchAlterationBody>,
) -> Result<Json<AlterationOrderRow>, AlterationError> {
    let staff = require_manage(&state, &headers).await?;

    let prev_status: Option<String> =
        sqlx::query_scalar("SELECT status::text FROM alteration_orders WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;

    if prev_status.is_none() {
        return Err(AlterationError::NotFound);
    }

    let will_change = body.status.is_some() || body.due_at.is_some() || body.notes.is_some();
    if !will_change {
        return Err(AlterationError::BadRequest(
            "no fields to update".to_string(),
        ));
    }

    if let Some(ref s) = body.status {
        let t = s.trim();
        if !t.is_empty() {
            sqlx::query("UPDATE alteration_orders SET status = $1::alteration_status, updated_at = now() WHERE id = $2")
                .bind(t)
                .bind(id)
                .execute(&state.db)
                .await?;
        }
    }

    if body.due_at.is_some() {
        sqlx::query("UPDATE alteration_orders SET due_at = $1, updated_at = now() WHERE id = $2")
            .bind(body.due_at)
            .bind(id)
            .execute(&state.db)
            .await?;
    }

    if let Some(ref n) = body.notes {
        sqlx::query("UPDATE alteration_orders SET notes = $1, updated_at = now() WHERE id = $2")
            .bind(n)
            .bind(id)
            .execute(&state.db)
            .await?;
    }

    let row = sqlx::query_as::<_, AlterationOrderRow>(
        r#"
        SELECT a.id, a.customer_id, c.first_name as customer_first_name, c.last_name as customer_last_name, 
               c.customer_code, a.wedding_member_id, a.status::text AS status,
               a.due_at, a.notes, a.linked_transaction_id, a.created_at, a.updated_at
        FROM alteration_orders a
        LEFT JOIN customers c ON a.customer_id = c.id
        WHERE a.id = $1
        "#,
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;

    if row.status == "ready" && prev_status.as_deref() != Some("ready") {
        let pool = state.db.clone();
        let http = state.http_client.clone();
        let podium_cache = state.podium_token_cache.clone();
        let cid = row.customer_id;
        let aid = row.id;
        tokio::spawn(async move {
            if let Err(e) =
                MessagingService::trigger_alteration_ready(&pool, &http, &podium_cache, cid, aid)
                    .await
            {
                tracing::warn!(error = %e, "alteration ready messaging failed");
            }
        });
    }

    let detail = json!({
        "status": body.status,
        "due_at": body.due_at.map(|d| d.to_rfc3339()),
        "notes_set": body.notes.is_some(),
    });
    sqlx::query(
        r#"
        INSERT INTO alteration_activity (alteration_id, staff_id, action, detail)
        VALUES ($1, $2, 'patch', $3)
        "#,
    )
    .bind(id)
    .bind(staff.id)
    .bind(SqlxJson(detail))
    .execute(&state.db)
    .await?;

    Ok(Json(row))
}
