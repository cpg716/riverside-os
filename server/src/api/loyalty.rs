//! Loyalty program management API.
//!
//! - Settings (view/update threshold + reward amount)
//! - Monthly eligible customer list
//! - Admin point adjustment (requires badge + PIN)
//! - Redeem reward: deduct threshold pts, apply up to reward $ toward sale,
//!   optionally load remainder onto a loyalty gift card. Optional Podium SMS/email
//!   when staff requests at redemption time (`notify_customer_sms` / `notify_customer_email`).

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{Duration, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use std::sync::Arc;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    staff_has_permission, LOYALTY_ADJUST_POINTS, LOYALTY_PROGRAM_SETTINGS,
};
use crate::auth::pins::{self, log_staff_access};
use crate::logic::messaging::MessagingService;
use crate::middleware;

#[derive(Debug, Error)]
pub enum LoyaltyError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("{0}")]
    InvalidPayload(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
}

impl IntoResponse for LoyaltyError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            LoyaltyError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            LoyaltyError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            LoyaltyError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            LoyaltyError::Database(e) => {
                tracing::error!(error = %e, "Database error in loyalty");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

fn map_loyalty_perm(e: (StatusCode, axum::Json<serde_json::Value>)) -> LoyaltyError {
    let (st, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match st {
        StatusCode::UNAUTHORIZED => LoyaltyError::Unauthorized(msg),
        StatusCode::FORBIDDEN => LoyaltyError::Forbidden(msg),
        _ => LoyaltyError::InvalidPayload(msg),
    }
}

async fn require_loyalty_program_settings(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), LoyaltyError> {
    middleware::require_staff_with_permission(state, headers, LOYALTY_PROGRAM_SETTINGS)
        .await
        .map(|_| ())
        .map_err(map_loyalty_perm)
}

async fn require_staff_or_pos_session(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), LoyaltyError> {
    middleware::require_staff_or_pos_register_session(state, headers)
        .await
        .map(|_| ())
        .map_err(|(st, j)| map_loyalty_perm((st, j)))
}

// ── Settings ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, FromRow)]
pub struct LoyaltySettings {
    pub loyalty_point_threshold: i32,
    pub loyalty_reward_amount: Decimal,
    pub points_per_dollar: i32,
}

async fn get_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<LoyaltySettings>, LoyaltyError> {
    require_loyalty_program_settings(&state, &headers).await?;
    loyalty_settings_from_db(&state).await
}

async fn loyalty_settings_from_db(state: &AppState) -> Result<Json<LoyaltySettings>, LoyaltyError> {
    let row = sqlx::query_as::<_, (i32, Decimal)>(
        "SELECT loyalty_point_threshold, loyalty_reward_amount FROM store_settings WHERE id = 1",
    )
    .fetch_one(&state.db)
    .await?;

    Ok(Json(LoyaltySettings {
        loyalty_point_threshold: row.0,
        loyalty_reward_amount: row.1,
        points_per_dollar: crate::logic::loyalty::POINTS_PER_DOLLAR,
    }))
}

/// Threshold / reward for POS redeem UI (no `loyalty.program_settings` required).
async fn get_program_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<LoyaltySettings>, LoyaltyError> {
    require_staff_or_pos_session(&state, &headers).await?;
    loyalty_settings_from_db(&state).await
}

#[derive(Debug, Deserialize)]
pub struct PatchSettingsRequest {
    #[serde(default)]
    pub loyalty_point_threshold: Option<i32>,
    #[serde(default)]
    pub loyalty_reward_amount: Option<Decimal>,
}

async fn patch_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PatchSettingsRequest>,
) -> Result<Json<LoyaltySettings>, LoyaltyError> {
    require_loyalty_program_settings(&state, &headers).await?;
    if let Some(t) = body.loyalty_point_threshold {
        if t <= 0 {
            return Err(LoyaltyError::InvalidPayload(
                "loyalty_point_threshold must be positive".to_string(),
            ));
        }
        sqlx::query("UPDATE store_settings SET loyalty_point_threshold = $1 WHERE id = 1")
            .bind(t)
            .execute(&state.db)
            .await?;
    }
    if let Some(a) = body.loyalty_reward_amount {
        if a <= Decimal::ZERO {
            return Err(LoyaltyError::InvalidPayload(
                "loyalty_reward_amount must be positive".to_string(),
            ));
        }
        sqlx::query("UPDATE store_settings SET loyalty_reward_amount = $1 WHERE id = 1")
            .bind(a)
            .execute(&state.db)
            .await?;
    }
    get_settings(State(state), headers).await
}

// ── Monthly eligible ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct MonthlyEligibleQuery {
    #[serde(default)]
    pub year: Option<i32>,
    #[serde(default)]
    pub month: Option<i32>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct EligibleCustomerRow {
    pub id: Uuid,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address_line1: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub zip: Option<String>,
    pub loyalty_points: i32,
}

async fn monthly_eligible(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(_q): Query<MonthlyEligibleQuery>,
) -> Result<Json<Vec<EligibleCustomerRow>>, LoyaltyError> {
    require_staff_or_pos_session(&state, &headers).await?;
    let threshold: i32 =
        sqlx::query_scalar("SELECT loyalty_point_threshold FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let rows = sqlx::query_as::<_, EligibleCustomerRow>(
        r#"
        SELECT
            id, first_name, last_name, email, phone,
            address_line1, city, state, postal_code AS zip,
            loyalty_points
        FROM customers
        WHERE loyalty_points >= $1
          AND is_active = TRUE
        ORDER BY loyalty_points DESC, last_name, first_name
        "#,
    )
    .bind(threshold)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

// ── Admin point adjustment ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct AdjustPointsRequest {
    pub customer_id: Uuid,
    pub delta_points: i32,
    pub reason: String,
    pub manager_cashier_code: String,
    #[serde(default)]
    pub manager_pin: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AdjustPointsResponse {
    pub new_balance: i32,
    pub delta_points: i32,
}

async fn adjust_points(
    State(state): State<AppState>,
    Json(body): Json<AdjustPointsRequest>,
) -> Result<Json<AdjustPointsResponse>, LoyaltyError> {
    if body.reason.trim().is_empty() {
        return Err(LoyaltyError::InvalidPayload(
            "reason is required".to_string(),
        ));
    }
    if body.delta_points == 0 {
        return Err(LoyaltyError::InvalidPayload(
            "delta_points cannot be zero".to_string(),
        ));
    }

    let admin = pins::authenticate_pos_staff(
        &state.db,
        &body.manager_cashier_code,
        body.manager_pin.as_deref(),
    )
    .await
    .map_err(|_| {
        LoyaltyError::Unauthorized("Valid manager cashier code and PIN required".to_string())
    })?;
    let eff =
        crate::auth::permissions::effective_permissions_for_staff(&state.db, admin.id, admin.role)
            .await?;
    if !staff_has_permission(&eff, LOYALTY_ADJUST_POINTS) {
        return Err(LoyaltyError::Forbidden(
            "loyalty.adjust_points permission required".to_string(),
        ));
    }

    let mut tx = state.db.begin().await?;

    let new_balance: i32 = sqlx::query_scalar(
        r#"
        UPDATE customers
        SET loyalty_points = GREATEST(0, loyalty_points + $1)
        WHERE id = $2
        RETURNING loyalty_points
        "#,
    )
    .bind(body.delta_points)
    .bind(body.customer_id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO loyalty_point_ledger
            (customer_id, delta_points, balance_after, reason, created_by_staff_id, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(body.customer_id)
    .bind(body.delta_points)
    .bind(new_balance)
    .bind(body.reason.trim())
    .bind(admin.id)
    .bind(json!({ "adjustment_kind": "manual_adjust", "admin_id": admin.id }))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "loyalty_points_adjust",
        json!({
            "customer_id": body.customer_id,
            "delta_points": body.delta_points,
            "new_balance": new_balance,
            "reason": body.reason,
        }),
    )
    .await;

    Ok(Json(AdjustPointsResponse {
        new_balance,
        delta_points: body.delta_points,
    }))
}

// ── Redeem reward ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RedeemRewardRequest {
    pub customer_id: Uuid,
    /// Amount to apply directly to the current sale ($0 – $50).
    pub apply_to_sale: Decimal,
    /// If `apply_to_sale` < reward_amount, scan a card code to load the remainder.
    #[serde(default)]
    pub remainder_card_code: Option<String>,
    #[serde(default)]
    pub session_id: Option<Uuid>,
    #[serde(default)]
    pub order_id: Option<Uuid>,
    /// Staff opt-in: send Podium SMS after successful redeem (customer SMS opt-in rules apply).
    #[serde(default)]
    pub notify_customer_sms: bool,
    /// Staff opt-in: send Podium email after successful redeem (customer email opt-in rules apply).
    #[serde(default)]
    pub notify_customer_email: bool,
}

#[derive(Debug, Serialize)]
pub struct RedeemRewardResponse {
    pub points_deducted: i32,
    pub new_balance: i32,
    pub applied_to_sale: Decimal,
    pub remainder_loaded: Decimal,
    /// Card ID if a remainder was loaded onto a new/existing card.
    pub remainder_card_id: Option<Uuid>,
}

async fn redeem_reward(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RedeemRewardRequest>,
) -> Result<Json<RedeemRewardResponse>, LoyaltyError> {
    require_staff_or_pos_session(&state, &headers).await?;

    // Load settings.
    let (threshold, reward_amount): (i32, Decimal) = sqlx::query_as(
        "SELECT loyalty_point_threshold, loyalty_reward_amount FROM store_settings WHERE id = 1",
    )
    .fetch_one(&state.db)
    .await?;

    if body.apply_to_sale < Decimal::ZERO {
        return Err(LoyaltyError::InvalidPayload(
            "apply_to_sale cannot be negative".to_string(),
        ));
    }
    if body.apply_to_sale > reward_amount {
        return Err(LoyaltyError::InvalidPayload(format!(
            "apply_to_sale cannot exceed reward amount (${reward_amount})"
        )));
    }

    let remainder = reward_amount - body.apply_to_sale;
    if remainder > Decimal::ZERO && body.remainder_card_code.is_none() {
        return Err(LoyaltyError::InvalidPayload(
            "remainder_card_code is required when apply_to_sale < reward_amount".to_string(),
        ));
    }

    let mut tx = state.db.begin().await?;

    // Verify and deduct points atomically.
    let new_balance: i32 = sqlx::query_scalar(
        r#"
        UPDATE customers
        SET loyalty_points = loyalty_points - $1
        WHERE id = $2 AND loyalty_points >= $1
        RETURNING loyalty_points
        "#,
    )
    .bind(threshold)
    .bind(body.customer_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        LoyaltyError::InvalidPayload(format!(
            "Customer does not have enough points (need {threshold})"
        ))
    })?;

    sqlx::query(
        r#"
        INSERT INTO loyalty_point_ledger
            (customer_id, delta_points, balance_after, reason, order_id, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(body.customer_id)
    .bind(-threshold)
    .bind(new_balance)
    .bind("reward_redemption")
    .bind(body.order_id)
    .bind(json!({
        "reward_amount": reward_amount,
        "applied_to_sale": body.apply_to_sale,
        "remainder": remainder,
        "notify_customer_sms": body.notify_customer_sms,
        "notify_customer_email": body.notify_customer_email,
    }))
    .execute(&mut *tx)
    .await?;

    // Load remainder onto a loyalty gift card if needed.
    let mut remainder_card_id: Option<Uuid> = None;
    if remainder > Decimal::ZERO {
        let code = body
            .remainder_card_code
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                LoyaltyError::InvalidPayload(
                    "remainder_card_code is required when redemption leaves a remainder balance"
                        .to_string(),
                )
            })?;
        let expires_at = Utc::now() + Duration::days(365);

        // Try to load on existing active card first, otherwise issue new one.
        let existing: Option<(Uuid, Decimal)> = sqlx::query_as(
            "SELECT id, current_balance FROM gift_cards WHERE code = $1 AND card_status = 'active'::gift_card_status FOR UPDATE",
        )
        .bind(code)
        .fetch_optional(&mut *tx)
        .await?;

        let card_id = if let Some((eid, old_bal)) = existing {
            let new_bal = old_bal + remainder;
            sqlx::query("UPDATE gift_cards SET current_balance = $1, expires_at = GREATEST(expires_at, $2) WHERE id = $3")
                .bind(new_bal)
                .bind(expires_at)
                .bind(eid)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "INSERT INTO gift_card_events (gift_card_id, event_kind, amount, balance_after, order_id, session_id) VALUES ($1, 'loaded', $2, $3, $4, $5)",
            )
            .bind(eid)
            .bind(remainder)
            .bind(new_bal)
            .bind(body.order_id)
            .bind(body.session_id)
            .execute(&mut *tx)
            .await?;
            eid
        } else {
            let new_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO gift_cards
                    (code, card_kind, card_status, current_balance, original_value,
                     is_liability, expires_at, customer_id, issued_session_id, issued_order_id)
                VALUES ($1, 'loyalty_reward', 'active', $2, $2, FALSE, $3, $4, $5, $6)
                RETURNING id
                "#,
            )
            .bind(code)
            .bind(remainder)
            .bind(expires_at)
            .bind(body.customer_id)
            .bind(body.session_id)
            .bind(body.order_id)
            .fetch_one(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO gift_card_events (gift_card_id, event_kind, amount, balance_after, order_id, session_id) VALUES ($1, 'issued', $2, $2, $3, $4)",
            )
            .bind(new_id)
            .bind(remainder)
            .bind(body.order_id)
            .bind(body.session_id)
            .execute(&mut *tx)
            .await?;
            new_id
        };

        remainder_card_id = Some(card_id);

        // Record in issuances log.
        sqlx::query(
            r#"
            INSERT INTO loyalty_reward_issuances
                (customer_id, points_deducted, reward_amount, applied_to_sale, remainder_card_id, order_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(body.customer_id)
        .bind(threshold)
        .bind(reward_amount)
        .bind(body.apply_to_sale)
        .bind(card_id)
        .bind(body.order_id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO loyalty_reward_issuances
                (customer_id, points_deducted, reward_amount, applied_to_sale, order_id)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(body.customer_id)
        .bind(threshold)
        .bind(reward_amount)
        .bind(body.apply_to_sale)
        .bind(body.order_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    if body.notify_customer_sms || body.notify_customer_email {
        let pool = state.db.clone();
        let http = state.http_client.clone();
        let cache = Arc::clone(&state.podium_token_cache);
        let cid = body.customer_id;
        let ns = body.notify_customer_sms;
        let ne = body.notify_customer_email;
        let ra = reward_amount;
        let ats = body.apply_to_sale;
        let rem = remainder;
        let nb = new_balance;
        let th = threshold;
        tokio::spawn(async move {
            if let Err(e) = MessagingService::notify_loyalty_reward_redeemed(
                &pool, &http, &cache, cid, ns, ne, ra, ats, rem, nb, th,
            )
            .await
            {
                tracing::error!(error = %e, customer_id = %cid, "loyalty redeem Podium notify failed");
            }
        });
    }

    Ok(Json(RedeemRewardResponse {
        points_deducted: threshold,
        new_balance,
        applied_to_sale: body.apply_to_sale,
        remainder_loaded: remainder,
        remainder_card_id,
    }))
}

// ── Ledger (per customer) ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct LedgerQuery {
    pub customer_id: Uuid,
}

#[derive(Debug, Serialize, FromRow)]
pub struct LedgerRow {
    pub id: Uuid,
    pub delta_points: i32,
    pub balance_after: i32,
    pub reason: String,
    pub order_id: Option<Uuid>,
    pub created_at: chrono::DateTime<Utc>,
}

async fn customer_ledger(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<LedgerQuery>,
) -> Result<Json<Vec<LedgerRow>>, LoyaltyError> {
    require_staff_or_pos_session(&state, &headers).await?;

    let rows = sqlx::query_as::<_, LedgerRow>(
        r#"
        SELECT id, delta_points, balance_after, reason, order_id, created_at
        FROM loyalty_point_ledger
        WHERE customer_id = $1
        ORDER BY created_at DESC
        LIMIT 200
        "#,
    )
    .bind(q.customer_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/settings", get(get_settings).patch(patch_settings))
        .route("/program-summary", get(get_program_summary))
        .route("/monthly-eligible", get(monthly_eligible))
        .route("/adjust-points", post(adjust_points))
        .route("/redeem-reward", post(redeem_reward))
        .route("/ledger", get(customer_ledger))
}
