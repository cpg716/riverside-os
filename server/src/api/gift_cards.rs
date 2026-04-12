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

fn map_gc_perm(e: (StatusCode, axum::Json<serde_json::Value))) -> GiftCardError {
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

async fn require_gift_cards_manage(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), GiftCardError> {
    middleware::require_staff_with_permission(state, headers, GIFT_CARDS_MANAGE)
        .await
        .map(|_| ())
        .map_err(map_gc_perm)
}

/// Balance lookup at register: valid POS session token or authenticated staff (same gate as card-terminal intent).
async fn require_gift_card_lookup(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), GiftCardError> {
    middleware::require_staff_or_pos_register_session(state, headers)
        .await
        .map(|_| ())
        .map_err(|(st, j)| map_gc_perm((st, j)))
}

impl IntoResponse for GiftCardError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            GiftCardError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            GiftCardError::NotFound => (StatusCode::NOT_FOUND, "Not found".to_string()),
            GiftCardError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            GiftCardError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            GiftCardError::Database(e) => {
                tracing::error!(error = %e, "Database error in gift_cards");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

// ── Shared response type ──────────────────────────────────────────────────────

#[derive(Debug, Serialize, FromRow)]
pub struct GiftCardRow {
    pub id: Uuid,
    pub code: String,
    pub card_kind: String,
    pub card_status: String,
    pub current_balance: Decimal,
    pub original_value: Option<Decimal>,
    pub is_liability: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub customer_id: Option<Uuid>,
    pub customer_name: Option<String>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
}

// ── List ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ListGiftCardsQuery {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    /// Return only cards expiring within N days.
    #[serde(default)]
    pub expiring_within_days: Option<i64>,
    /// When true: active balance, not expired (register “open” list).
    #[serde(default)]
    pub open_only: Option<bool>,
    /// `recent_activity` = latest gift_card_events time (sold / loaded) first; else `created_at` desc.
    #[serde(default)]
    pub sort: Option<String>,
}

async fn list_gift_cards(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListGiftCardsQuery>,
) -> Result<Json<Vec<GiftCardRow>>, GiftCardError> {
    require_gift_cards_manage(&state, &headers).await?;
    let open_only = q.open_only.unwrap_or(false);
    let sort_recent = q.sort.as_deref() == Some("recent_activity");

    let rows = if sort_recent {
        sqlx::query_as::<_, GiftCardRow>(
            r#"
            SELECT
                gc.id,
                gc.code,
                gc.card_kind::text,
                gc.card_status::text,
                gc.current_balance,
                gc.original_value,
                gc.is_liability,
                gc.expires_at,
                gc.customer_id,
                CASE WHEN c.id IS NOT NULL
                     THEN TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))
                     ELSE NULL END AS customer_name,
                gc.notes,
                gc.created_at
            FROM gift_cards gc
            LEFT JOIN customers c ON c.id = gc.customer_id
            WHERE ($1::text IS NULL OR gc.card_kind::text = $1)
              AND ($2::text IS NULL OR gc.card_status::text = $2)
              AND ($3::bigint IS NULL OR gc.expires_at <= now() + ($3 * INTERVAL '1 day'))
              AND ($4::bool IS NOT TRUE OR (
                    gc.card_status = 'active'::gift_card_status
                    AND gc.current_balance > 0
                    AND (gc.expires_at IS NULL OR gc.expires_at > NOW())
                  ))
            ORDER BY (
                SELECT MAX(e.created_at) FROM gift_card_events e WHERE e.gift_card_id = gc.id
            ) DESC NULLS LAST, gc.created_at DESC
            LIMIT 500
            "#,
        )
        .bind(q.kind)
        .bind(q.status)
        .bind(q.expiring_within_days)
        .bind(open_only)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, GiftCardRow>(
            r#"
            SELECT
                gc.id,
                gc.code,
                gc.card_kind::text,
                gc.card_status::text,
                gc.current_balance,
                gc.original_value,
                gc.is_liability,
                gc.expires_at,
                gc.customer_id,
                CASE WHEN c.id IS NOT NULL
                     THEN TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))
                     ELSE NULL END AS customer_name,
                gc.notes,
                gc.created_at
            FROM gift_cards gc
            LEFT JOIN customers c ON c.id = gc.customer_id
            WHERE ($1::text IS NULL OR gc.card_kind::text = $1)
              AND ($2::text IS NULL OR gc.card_status::text = $2)
              AND ($3::bigint IS NULL OR gc.expires_at <= now() + ($3 * INTERVAL '1 day'))
              AND ($4::bool IS NOT TRUE OR (
                    gc.card_status = 'active'::gift_card_status
                    AND gc.current_balance > 0
                    AND (gc.expires_at IS NULL OR gc.expires_at > NOW())
                  ))
            ORDER BY gc.created_at DESC
            LIMIT 500
            ",
        )
        .bind(q.kind)
        .bind(q.status)
        .bind(q.expiring_within_days)
        .bind(open_only)
        .fetch_all(&state.db)
        .await?
    };

    Ok(Json(rows))
}

/// Open gift cards at register / Back Office: positive active balance, not expired — latest activity first.
async fn list_gift_cards_open(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<GiftCardRow>>, GiftCardError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(|(st, j)| map_gc_perm((st, j)))?;

    let rows = sqlx::query_as::<_, GiftCardRow>(
        r#"
        SELECT
            gc.id,
            gc.code,
            gc.card_kind::text,
            gc.card_status::text,
            gc.current_balance,
            gc.original_value,
            gc.is_liability,
            gc.expires_at,
            gc.customer_id,
            CASE WHEN c.id IS NOT NULL
                 THEN TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))
                 ELSE NULL END AS customer_name,
            gc.notes,
            gc.created_at
        FROM gift_cards gc
        LEFT JOIN customers c ON c.id = gc.customer_id
        WHERE gc.card_status = 'active'::gift_card_status
          AND gc.current_balance > 0
          AND (gc.expires_at IS NULL OR gc.expires_at > NOW())
        ORDER BY (
            SELECT MAX(e.created_at) FROM gift_card_events e WHERE e.gift_card_id = gc.id
        ) DESC NULLS LAST, gc.created_at DESC
        LIMIT 500
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

// ── Look up by code (POS scan) ─────────────────────────────────────────────────

async fn get_gift_card_by_code(
    State(state): State<AppState>,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Result<Json<GiftCardRow>, GiftCardError> {
    require_gift_card_lookup(&state, &headers).await?;
    let row = sqlx::query_as::<_, GiftCardRow>(
        r#"
        SELECT
            gc.id,
            gc.code,
            gc.card_kind::text,
            gc.card_status::text,
            gc.current_balance,
            gc.original_value,
            gc.is_liability,
            gc.expires_at,
            gc.customer_id,
            CASE WHEN c.id IS NOT NULL
                 THEN TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))
                 ELSE NULL END AS customer_name,
            gc.notes,
            gc.created_at
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

// ── Issue: purchased card (liability at sale) ─────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct IssuePurchasedRequest {
    pub code: String,
    pub amount: Decimal,
    #[serde(default)]
    pub customer_id: Option<Uuid>,
    #[serde(default)]
    pub session_id: Option<Uuid>,
    #[serde(default)]
    pub order_id: Option<Uuid>,
    #[serde(default)]
    pub notes: Option<String>,
}

// ── POS register: enter amount + scan code (purchased liability) ───────────────

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
    let operator_staff_id = match &auth {
        middleware::StaffOrPosSession::Staff(s) => Some(s.id),
        middleware::StaffOrPosSession::PosSession { .. } => None,
    };
    let session_id = match auth {
        middleware::StaffOrPosSession::PosSession { session_id } => Some(session_id),
        middleware::StaffOrPosSession::Staff(_) => body.session_id,
    };
    let code_trim = body.code.trim().to_string();
    let amount = body.amount;
    let id = gift_card_ops::pos_load_purchased_card(
        &state.db,
        &code_trim,
        amount,
        body.customer_id,
        session_id,
    )
    .await
    .map_err(|e| match e {
        gift_card_ops::GiftCardOpError::BadRequest(m) => GiftCardError::InvalidPayload(m),
        gift_card_ops::GiftCardOpError::Db(d) => GiftCardError::Database(d),
    })?;
    let response = get_card_row(&state.db, id).await?;
    let pool = state.db.clone();
    let code_notify = code_trim.to_ascii_uppercase();
    tokio::spawn(async move {
        if let Err(e) = gift_card_ops::notify_sales_support_direct_pos_load(
            &pool,
            &code_notify,
            amount,
            session_id,
            operator_staff_id,
        )
        .await
        {
            tracing::warn!(
                error = %e,
                "gift card direct load sales_support notify failed"
            );
        }
    });
    Ok(response)
}

async fn issue_purchased(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<IssuePurchasedRequest>,
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

    // 9-year expiry for purchased cards.
    let expires_at = Utc::now() + Duration::days(365 * 9);

    // FIX: Ensure we use the transaction 'tx' for ALL queries within this block to maintain atomicity.
    let mut tx = state.db.begin().await?;

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO gift_cards
            (code, card_kind, card_status, current_balance, original_value,
             is_liability, expires_at, customer_id, issued_session_id, issued_order_id, notes)
        VALUES ($1, 'purchased', 'active', $2, $2, TRUE, $3, $4, $5, $6, $7)
        RETURNING id
        "#,
    )
    .bind(&code)
    .bind(body.amount)
    .bind(expires_at)
    .bind(body.customer_id)
    .bind(body.session_id)
    .bind(body.order_id)
    .bind(body.notes.as_deref())
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO gift_card_events
            (gift_card_id, event_kind, amount, balance_after, order_id, session_id)
        VALUES ($1, 'issued', $2, $2, $3, $4)
        "#,
    )
    .bind(id)
    .bind(body.amount)
    .bind(body.order_id)
    .bind(body.session_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    get_card_row(&state.db, id).await
}

// ── Issue: loyalty load (scan a card, load $50 reward) ───────────────────────

#[derive(Debug, Deserialize)]
pub struct IssueLoyaltyLoadRequest {
    pub code: String,
    pub amount: Decimal,
    pub customer_id: Uuid,
    #[serde(default)]
    pub session_id: Option<Uuid>,
    #[serde(default)]
    pub order_id: Option<Uuid>,
    #[serde(default)]
    pub notes: Option<String>,
}

async fn issue_loyalty_load(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<IssueLoyaltyLoadRequest>,
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

    // 1-year expiry for loyalty cards.
    let expires_at = Utc::now() + Duration::days(365);

    // Check if this code already exists and is active — if so, add to its balance.
    let mut tx = state.db.begin().await?;

    let existing: Option<(Uuid, Decimal)> = sqlx::query_as(
        r#"
        SELECT id, current_balance
        FROM gift_cards
        WHERE code = $1 AND card_status = 'active'::gift_card_status
        FOR UPDATE
        "#,
    )
    .bind(&code)
    .fetch_optional(&mut *tx)
    .await?;

    let id = if let Some((existing_id, old_balance)) = existing {
        let new_balance = old_balance + body.amount;
        sqlx::query(
            r#"
            UPDATE gift_cards
            SET current_balance = $1, expires_at = GREATEST(expires_at, $2)
            WHERE id = $3
            "#,
        )
        .bind(new_balance)
        .bind(expires_at)
        .bind(existing_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO gift_card_events
                (gift_card_id, event_kind, amount, balance_after, order_id, session_id)
            VALUES ($1, 'loaded', $2, $3, $4, $5)
            "#,
        )
        .bind(existing_id)
        .bind(body.amount)
        .bind(new_balance)
        .bind(body.order_id)
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
        .bind(body.order_id)
        .bind(body.notes.as_deref())
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO gift_card_events
                (gift_card_id, event_kind, amount, balance_after, order_id, session_id)
            VALUES ($1, 'issued', $2, $2, $3, $4)
            "#,
        )
        .bind(new_id)
        .bind(body.amount)
        .bind(body.order_id)
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
    pub order_id: Option<Uuid>,
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
        SELECT id, event_kind, amount, balance_after, order_id, notes, created_at
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
        SELECT id, event_kind, amount, balance_after, order_id, notes, created_at
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
    Router::new
        .route("/", get(list_gift_cards))
        .route("/open", get(list_gift_cards_open))
        .route("/code/{code}/events", get(get_gift_card_events_by_code))
        .route("/code/{code}", get(get_gift_card_by_code))
        .route("/issue-purchased", post(issue_purchased))
        .route("/pos-load-purchased", post(pos_load_purchased))
        .route("/issue-loyalty-load", post(issue_loyalty_load))
        .route("/issue-donated", post(issue_donated))
        .route("/{id}/void", post(void_gift_card))
        .route("/{id}/events", get(get_card_events))
}
