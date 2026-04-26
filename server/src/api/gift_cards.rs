//! Gift card management API.
//!
//! Issue/activate cards (purchased, loyalty-load, donated), list inventory,
//! and look up a card by code for the POS.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use sqlx::QueryBuilder;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::GIFT_CARDS_MANAGE;
use crate::logic::gift_card_ops;
use crate::middleware;

#[derive(Debug, Error)]
pub enum GiftCardError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("{0}")]
    InvalidPayload(String),
    #[error("Not found")]
    NotFound,
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
}

impl IntoResponse for GiftCardError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            GiftCardError::NotFound => (StatusCode::NOT_FOUND, "Gift card not found".to_string()),
            GiftCardError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            GiftCardError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            GiftCardError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            GiftCardError::Database(e) => {
                tracing::error!(error = %e, "Database error in gift cards");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

async fn require_gift_cards_manage(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), GiftCardError> {
    middleware::require_staff_with_permission(state, headers, GIFT_CARDS_MANAGE)
        .await
        .map(|_| ())
        .map_err(map_gc_perm)
}

fn map_gc_perm(e: (StatusCode, axum::Json<serde_json::Value>)) -> GiftCardError {
    let (st, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match st {
        StatusCode::UNAUTHORIZED => GiftCardError::Unauthorized(msg),
        StatusCode::FORBIDDEN => GiftCardError::Forbidden(msg),
        _ => GiftCardError::InvalidPayload(msg),
    }
}

async fn require_gift_card_lookup(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), GiftCardError> {
    middleware::require_staff_or_pos_register_session(state, headers)
        .await
        .map(|_| ())
        .map_err(map_gc_perm)
}

#[derive(Debug, Serialize, FromRow)]
pub struct GiftCardRow {
    pub id: Uuid,
    pub code: String,
    pub card_kind: String,
    pub card_status: String,
    pub current_balance: Decimal,
    pub original_value: Decimal,
    pub is_liability: bool,
    pub expires_at: DateTime<Utc>,
    pub customer_id: Option<Uuid>,
    pub customer_name: Option<String>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ListGiftCardsQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub search: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub open_only: Option<bool>,
    pub sort: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct GiftCardSummary {
    pub open_cards_count: i64,
    pub active_liability_balance: Decimal,
    pub loyalty_cards_count: i64,
    pub donated_cards_count: i64,
}

async fn list_gift_cards(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListGiftCardsQuery>,
) -> Result<Json<Vec<GiftCardRow>>, GiftCardError> {
    require_gift_cards_manage(&state, &headers).await?;
    let limit = q.limit.unwrap_or(100);
    let offset = q.offset.unwrap_or(0);
    let search = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let kind = q.kind.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let status = q.status.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let open_only = q.open_only.unwrap_or(false);
    let sort = q.sort.as_deref().unwrap_or("created_desc");

    let mut qb = QueryBuilder::<sqlx::Postgres>::new(
        r#"
        SELECT
            gc.id, gc.code, gc.card_kind::text, gc.card_status::text,
            gc.current_balance, gc.original_value, gc.is_liability,
            gc.expires_at, gc.customer_id,
            CASE WHEN c.id IS NOT NULL
                 THEN TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))
                 ELSE NULL END AS customer_name,
            gc.notes, gc.created_at
        FROM gift_cards gc
        LEFT JOIN customers c ON c.id = gc.customer_id
        WHERE 1=1
        "#,
    );

    if let Some(search) = search {
        let like = format!("%{search}%");
        qb.push(" AND (gc.code ILIKE ");
        qb.push_bind(like.clone());
        qb.push(" OR c.first_name ILIKE ");
        qb.push_bind(like.clone());
        qb.push(" OR c.last_name ILIKE ");
        qb.push_bind(like.clone());
        qb.push(" OR COALESCE(gc.notes, '') ILIKE ");
        qb.push_bind(like);
        qb.push(") ");
    }

    if let Some(kind) = kind {
        qb.push(" AND gc.card_kind::text = ");
        qb.push_bind(kind);
    }

    if let Some(status) = status {
        qb.push(" AND gc.card_status::text = ");
        qb.push_bind(status);
    }

    if open_only {
        qb.push(" AND gc.card_status = 'active'::gift_card_status AND gc.current_balance > 0 ");
    }

    match sort {
        "recent_activity" => qb.push(" ORDER BY gc.created_at DESC, gc.current_balance DESC "),
        "balance_desc" => qb.push(" ORDER BY gc.current_balance DESC, gc.created_at DESC "),
        _ => qb.push(" ORDER BY gc.created_at DESC "),
    };

    qb.push(" LIMIT ");
    qb.push_bind(limit);
    qb.push(" OFFSET ");
    qb.push_bind(offset);

    let rows: Vec<GiftCardRow> = qb.build_query_as().fetch_all(&state.db).await?;

    Ok(Json(rows))
}

async fn get_gift_card_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<GiftCardSummary>, GiftCardError> {
    require_gift_cards_manage(&state, &headers).await?;
    let row = sqlx::query_as::<_, GiftCardSummary>(
        r#"
        SELECT
            COUNT(*) FILTER (
                WHERE gc.card_status = 'active'::gift_card_status
                  AND gc.current_balance > 0
            )::bigint AS open_cards_count,
            COALESCE(
                SUM(gc.current_balance) FILTER (
                    WHERE gc.is_liability = TRUE
                      AND gc.card_status = 'active'::gift_card_status
                      AND gc.current_balance > 0
                ),
                0
            )::numeric(14,2) AS active_liability_balance,
            COUNT(*) FILTER (WHERE gc.card_kind = 'loyalty_reward'::gift_card_kind)::bigint AS loyalty_cards_count,
            COUNT(*) FILTER (WHERE gc.card_kind = 'donated_giveaway'::gift_card_kind)::bigint AS donated_cards_count
        FROM gift_cards gc
        "#,
    )
    .fetch_one(&state.db)
    .await?;
    Ok(Json(row))
}

async fn list_gift_cards_open(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<GiftCardRow>>, GiftCardError> {
    require_gift_card_lookup(&state, &headers).await?;
    let rows = sqlx::query_as::<_, GiftCardRow>(
        r#"
        SELECT
            gc.id, gc.code, gc.card_kind::text, gc.card_status::text,
            gc.current_balance, gc.original_value, gc.is_liability,
            gc.expires_at, gc.customer_id,
            CASE WHEN c.id IS NOT NULL
                 THEN TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))
                 ELSE NULL END AS customer_name,
            gc.notes, gc.created_at
        FROM gift_cards gc
        LEFT JOIN customers c ON c.id = gc.customer_id
        WHERE gc.card_status = 'active'::gift_card_status
          AND gc.current_balance > 0
        ORDER BY gc.current_balance DESC
        LIMIT 200
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn get_gift_card_by_code(
    State(state): State<AppState>,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Result<Json<GiftCardRow>, GiftCardError> {
    require_gift_card_lookup(&state, &headers).await?;
    let row = sqlx::query_as::<_, GiftCardRow>(
        r#"
        SELECT
            gc.id, gc.code, gc.card_kind::text, gc.card_status::text,
            gc.current_balance, gc.original_value, gc.is_liability,
            gc.expires_at, gc.customer_id,
            CASE WHEN c.id IS NOT NULL
                 THEN TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))
                 ELSE NULL END AS customer_name,
            gc.notes, gc.created_at
        FROM gift_cards gc
        LEFT JOIN customers c ON c.id = gc.customer_id
        WHERE gc.code = $1
        "#,
    )
    .bind(code.trim())
    .fetch_optional(&state.db)
    .await?;

    row.map(Json).ok_or(GiftCardError::NotFound)
}

// ── Register purchased-card load ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PosLoadPurchasedRequest {
    pub code: String,
    pub amount: Decimal,
    #[serde(default)]
    pub customer_id: Option<Uuid>,
    #[serde(default)]
    pub session_id: Option<Uuid>,
}

async fn pos_load_purchased(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PosLoadPurchasedRequest>,
) -> Result<Json<GiftCardRow>, GiftCardError> {
    let auth = middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_gc_perm)?;
    let id = gift_card_ops::pos_load_purchased_card(
        &state.db,
        &body.code,
        body.amount,
        body.customer_id,
        body.session_id,
    )
    .await
    .map_err(|e| GiftCardError::InvalidPayload(e.to_string()))?;

    let operator_staff_id = match auth {
        middleware::StaffOrPosSession::Staff(staff) => Some(staff.id),
        middleware::StaffOrPosSession::PosSession { .. } => None,
    };
    gift_card_ops::notify_sales_support_direct_pos_load(
        &state.db,
        &body.code,
        body.amount,
        body.session_id,
        operator_staff_id,
    )
    .await?;

    get_card_row(&state.db, id).await
}

// ── Issue: loyalty reward load ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct IssueLoyaltyLoadRequest {
    pub code: String,
    pub amount: Decimal,
    #[serde(default)]
    pub customer_id: Option<Uuid>,
    #[serde(default)]
    pub session_id: Option<Uuid>,
    #[serde(default)]
    pub transaction_id: Option<Uuid>,
    #[serde(default)]
    pub notes: Option<String>,
}

async fn issue_loyalty_load(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<IssueLoyaltyLoadRequest>,
) -> Result<Json<GiftCardRow>, GiftCardError> {
    require_gift_card_lookup(&state, &headers).await?;
    let code = body.code.trim().to_string();
    if code.is_empty() {
        return Err(GiftCardError::InvalidPayload(
            "code is required".to_string(),
        ));
    }
    if body.amount <= Decimal::ZERO {
        return Err(GiftCardError::InvalidPayload(
            "amount must be positive".to_string(),
        ));
    }

    // 1-year expiry for loyalty rewards.
    let expires_at = Utc::now() + Duration::days(365);

    let mut tx = state.db.begin().await?;

    let existing: Option<(Uuid, Decimal)> = sqlx::query_as(
        "SELECT id, current_balance FROM gift_cards WHERE code = $1 AND card_status = 'active'::gift_card_status FOR UPDATE"
    )
    .bind(&code)
    .fetch_optional(&mut *tx)
    .await?;

    let id = if let Some((existing_id, balance)) = existing {
        let new_balance = balance + body.amount;
        sqlx::query(
            "UPDATE gift_cards SET current_balance = $1, expires_at = GREATEST(expires_at, $2) WHERE id = $3"
        )
        .bind(new_balance)
        .bind(expires_at)
        .bind(existing_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO gift_card_events
                (gift_card_id, event_kind, amount, balance_after, transaction_id, session_id)
            VALUES ($1, 'loaded', $2, $3, $4, $5)
            "#,
        )
        .bind(existing_id)
        .bind(body.amount)
        .bind(new_balance)
        .bind(body.transaction_id)
        .bind(body.session_id)
        .execute(&mut *tx)
        .await?;

        existing_id
    } else {
        let new_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO gift_cards
                (code, card_kind, card_status, current_balance, original_value,
                 is_liability, expires_at, customer_id, issued_session_id, issued_order_id, notes)
            VALUES ($1, 'loyalty_reward', 'active', $2, $2, FALSE, $3, $4, $5, $6, $7)
            RETURNING id
            "#,
        )
        .bind(&code)
        .bind(body.amount)
        .bind(expires_at)
        .bind(body.customer_id)
        .bind(body.session_id)
        .bind(body.transaction_id)
        .bind(body.notes.as_deref())
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO gift_card_events
                (gift_card_id, event_kind, amount, balance_after, transaction_id, session_id)
            VALUES ($1, 'issued', $2, $2, $3, $4)
            "#,
        )
        .bind(new_id)
        .bind(body.amount)
        .bind(body.transaction_id)
        .bind(body.session_id)
        .execute(&mut *tx)
        .await?;

        new_id
    };

    tx.commit().await?;

    get_card_row(&state.db, id).await
}

// ── Issue: donated / giveaway card ────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct IssueDonatedRequest {
    pub code: String,
    pub amount: Decimal,
    #[serde(default)]
    pub customer_id: Option<Uuid>,
    #[serde(default)]
    pub notes: Option<String>,
}

async fn issue_donated(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<IssueDonatedRequest>,
) -> Result<Json<GiftCardRow>, GiftCardError> {
    require_gift_cards_manage(&state, &headers).await?;
    let code = body.code.trim().to_string();
    if code.is_empty() {
        return Err(GiftCardError::InvalidPayload(
            "code is required".to_string(),
        ));
    }
    if body.amount <= Decimal::ZERO {
        return Err(GiftCardError::InvalidPayload(
            "amount must be positive".to_string(),
        ));
    }

    // 1-year expiry for donated/giveaway cards.
    let expires_at = Utc::now() + Duration::days(365);

    let mut tx = state.db.begin().await?;

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO gift_cards
            (code, card_kind, card_status, current_balance, original_value,
             is_liability, expires_at, customer_id, notes)
        VALUES ($1, 'donated_giveaway', 'active', $2, $2, FALSE, $3, $4, $5)
        RETURNING id
        "#,
    )
    .bind(&code)
    .bind(body.amount)
    .bind(expires_at)
    .bind(body.customer_id)
    .bind(body.notes.as_deref())
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO gift_card_events
            (gift_card_id, event_kind, amount, balance_after)
        VALUES ($1, 'issued', $2, $2)
        "#,
    )
    .bind(id)
    .bind(body.amount)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    get_card_row(&state.db, id).await
}

// ── Void card (back-office admin) ─────────────────────────────────────────────

async fn void_gift_card(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<GiftCardRow>, GiftCardError> {
    require_gift_cards_manage(&state, &headers).await?;

    let mut tx = state.db.begin().await?;

    let affected = sqlx::query(
        "UPDATE gift_cards SET card_status = 'void'::gift_card_status WHERE id = $1 AND card_status != 'void'::gift_card_status",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if affected == 0 {
        return Err(GiftCardError::NotFound);
    }

    sqlx::query(
        r#"
        INSERT INTO gift_card_events (gift_card_id, event_kind, amount, balance_after)
        SELECT id, 'voided', -current_balance, 0 FROM gift_cards WHERE id = $1
        "#,
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    get_card_row(&state.db, id).await
}

// ── Event history ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, FromRow)]
pub struct GiftCardEvent {
    pub id: Uuid,
    pub event_kind: String,
    pub amount: Decimal,
    pub balance_after: Decimal,
    pub transaction_id: Option<Uuid>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
}

async fn get_card_events(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<GiftCardEvent>>, GiftCardError> {
    require_gift_cards_manage(&state, &headers).await?;
    let rows = sqlx::query_as::<_, GiftCardEvent>(
        r#"
        SELECT id, event_kind, amount, balance_after, transaction_id, notes, created_at
        FROM gift_card_events
        WHERE gift_card_id = $1
        ORDER BY created_at DESC
        "#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn get_gift_card_events_by_code(
    State(state): State<AppState>,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<GiftCardEvent>>, GiftCardError> {
    require_gift_card_lookup(&state, &headers).await?;
    let id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM gift_cards WHERE code = $1")
        .bind(code.trim())
        .fetch_optional(&state.db)
        .await?;
    let Some(card_id) = id else {
        return Err(GiftCardError::NotFound);
    };
    let rows = sqlx::query_as::<_, GiftCardEvent>(
        r#"
        SELECT id, event_kind, amount, balance_after, transaction_id, notes, created_at
        FROM gift_card_events
        WHERE gift_card_id = $1
        ORDER BY created_at DESC
        LIMIT 300
        "#,
    )
    .bind(card_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

// ── Shared helper ─────────────────────────────────────────────────────────────

async fn get_card_row(pool: &sqlx::PgPool, id: Uuid) -> Result<Json<GiftCardRow>, GiftCardError> {
    let row = sqlx::query_as::<_, GiftCardRow>(
        r#"
        SELECT
            gc.id, gc.code, gc.card_kind::text, gc.card_status::text,
            gc.current_balance, gc.original_value, gc.is_liability,
            gc.expires_at, gc.customer_id,
            CASE WHEN c.id IS NOT NULL
                 THEN TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))
                 ELSE NULL END AS customer_name,
            gc.notes, gc.created_at
        FROM gift_cards gc
        LEFT JOIN customers c ON c.id = gc.customer_id
        WHERE gc.id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    row.map(Json).ok_or(GiftCardError::NotFound)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_gift_cards))
        .route("/summary", get(get_gift_card_summary))
        .route("/open", get(list_gift_cards_open))
        .route("/code/{code}/events", get(get_gift_card_events_by_code))
        .route("/code/{code}", get(get_gift_card_by_code))
        .route("/pos-load-purchased", post(pos_load_purchased))
        .route("/issue-loyalty-load", post(issue_loyalty_load))
        .route("/issue-donated", post(issue_donated))
        .route("/{id}/void", post(void_gift_card))
        .route("/{id}/events", get(get_card_events))
}
