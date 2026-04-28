//! Loyalty program management API.
//!
//! - Settings (view/update threshold + reward amount)
//! - Monthly eligible customer list
//! - Admin point adjustment (requires badge + PIN)
//! - Redeem reward: deduct threshold pts and issue the reward to a loyalty gift card.
//!   Optional Podium SMS/email
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
use serde_json::{json, Value};
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
    pub loyalty_letter_template: String,
}

async fn get_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<LoyaltySettings>, LoyaltyError> {
    require_loyalty_program_settings(&state, &headers).await?;
    loyalty_settings_from_db(&state).await
}

async fn loyalty_settings_from_db(state: &AppState) -> Result<Json<LoyaltySettings>, LoyaltyError> {
    let row = sqlx::query_as::<_, (i32, Decimal, String)>(
        "SELECT loyalty_point_threshold, loyalty_reward_amount, loyalty_letter_template FROM store_settings WHERE id = 1",
    )
    .fetch_one(&state.db)
    .await?;

    Ok(Json(LoyaltySettings {
        loyalty_point_threshold: row.0,
        loyalty_reward_amount: row.1,
        points_per_dollar: crate::logic::loyalty::POINTS_PER_DOLLAR,
        loyalty_letter_template: row.2,
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
    #[serde(default)]
    pub loyalty_letter_template: Option<String>,
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
    if let Some(template) = body.loyalty_letter_template {
        sqlx::query("UPDATE store_settings SET loyalty_letter_template = $1 WHERE id = 1")
            .bind(template.trim())
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
    pub effective_customer_id: Uuid,
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

    let effective_customer_id =
        crate::logic::customer_couple::resolve_effective_customer_id_tx(&mut tx, body.customer_id)
            .await?;

    let new_balance: i32 = sqlx::query_scalar(
        r#"
        UPDATE customers
        SET loyalty_points = GREATEST(0, loyalty_points + $1)
        WHERE id = $2
        RETURNING loyalty_points
        "#,
    )
    .bind(body.delta_points)
    .bind(effective_customer_id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO loyalty_point_ledger
            (customer_id, delta_points, balance_after, reason, created_by_staff_id, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(effective_customer_id)
    .bind(body.delta_points)
    .bind(new_balance)
    .bind(body.reason.trim())
    .bind(admin.id)
    .bind(json!({
        "adjustment_kind": "manual_adjust",
        "admin_id": admin.id,
        "selected_customer_id": body.customer_id,
        "effective_customer_id": effective_customer_id,
    }))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let _ = log_staff_access(
        &state.db,
        admin.id,
        "loyalty_points_adjust",
        json!({
            "customer_id": body.customer_id,
            "effective_customer_id": effective_customer_id,
            "delta_points": body.delta_points,
            "new_balance": new_balance,
            "reason": body.reason,
        }),
    )
    .await;

    Ok(Json(AdjustPointsResponse {
        new_balance,
        delta_points: body.delta_points,
        effective_customer_id,
    }))
}

// ── Redeem reward ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RedeemRewardRequest {
    pub customer_id: Uuid,
    /// Compatibility field. Must be `0.00`; loyalty redemptions issue to a loyalty gift card only.
    pub apply_to_sale: Decimal,
    /// Required: the loyalty gift card code that will receive the reward.
    #[serde(default)]
    pub remainder_card_code: Option<String>,
    #[serde(default)]
    pub session_id: Option<Uuid>,
    #[serde(default)]
    pub transaction_id: Option<Uuid>,
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
    pub effective_customer_id: Uuid,
    /// Always `0.00` in the issuance-only redemption contract.
    pub applied_to_sale: Decimal,
    pub remainder_loaded: Decimal,
    /// Card ID if a remainder was loaded onto a new/existing card.
    pub remainder_card_id: Option<Uuid>,
}

fn masked_loyalty_card_label(code: &str) -> String {
    let trimmed = code.trim();
    let suffix: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    if suffix.is_empty() {
        "a loyalty gift card".to_string()
    } else {
        format!("loyalty card ••••{suffix}")
    }
}

fn resolve_redemption_contract(
    apply_to_sale: Decimal,
    reward_amount: Decimal,
    remainder_card_code: Option<&str>,
) -> Result<(Decimal, String), LoyaltyError> {
    if apply_to_sale < Decimal::ZERO {
        return Err(LoyaltyError::InvalidPayload(
            "apply_to_sale cannot be negative".to_string(),
        ));
    }
    if apply_to_sale > reward_amount {
        return Err(LoyaltyError::InvalidPayload(format!(
            "apply_to_sale cannot exceed reward amount (${reward_amount})"
        )));
    }
    if apply_to_sale > Decimal::ZERO {
        return Err(LoyaltyError::InvalidPayload(
            "Loyalty rewards are issued to a loyalty gift card only. Use $0.00 here and finish the sale separately."
                .to_string(),
        ));
    }

    let code = remainder_card_code
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            LoyaltyError::InvalidPayload(
                "Scan or enter a loyalty gift card code before redeeming this reward.".to_string(),
            )
        })?;

    Ok((reward_amount, code.to_ascii_uppercase()))
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

    let (remainder, reward_card_code) = resolve_redemption_contract(
        body.apply_to_sale,
        reward_amount,
        body.remainder_card_code.as_deref(),
    )?;

    let mut tx = state.db.begin().await?;

    let effective_customer_id =
        crate::logic::customer_couple::resolve_effective_customer_id_tx(&mut tx, body.customer_id)
            .await?;

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
    .bind(effective_customer_id)
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
            (customer_id, delta_points, balance_after, reason, transaction_id, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(effective_customer_id)
    .bind(-threshold)
    .bind(new_balance)
    .bind("reward_redemption")
    .bind(body.transaction_id)
    .bind(json!({
        "reward_amount": reward_amount,
        "applied_to_sale": body.apply_to_sale,
        "remainder": remainder,
        "remainder_card_code": reward_card_code,
        "selected_customer_id": body.customer_id,
        "effective_customer_id": effective_customer_id,
        "notify_customer_sms": body.notify_customer_sms,
        "notify_customer_email": body.notify_customer_email,
    }))
    .execute(&mut *tx)
    .await?;

    // Load remainder onto a loyalty gift card if needed.
    let mut remainder_card_id: Option<Uuid> = None;
    if remainder > Decimal::ZERO {
        let expires_at = Utc::now() + Duration::days(365);

        // Try to load on existing active card first, otherwise issue new one.
        let existing: Option<(Uuid, Decimal, String)> = sqlx::query_as(
            "SELECT id, current_balance, card_kind::text FROM gift_cards WHERE code = $1 AND card_status = 'active'::gift_card_status FOR UPDATE",
        )
        .bind(&reward_card_code)
        .fetch_optional(&mut *tx)
        .await?;

        let card_id = if let Some((eid, old_bal, card_kind)) = existing {
            if !card_kind.eq_ignore_ascii_case("loyalty_reward") {
                return Err(LoyaltyError::InvalidPayload(
                    "This code belongs to a different gift card type. Use a loyalty reward card code instead."
                        .to_string(),
                ));
            }
            let new_bal = old_bal + remainder;
            sqlx::query("UPDATE gift_cards SET current_balance = $1, expires_at = GREATEST(expires_at, $2) WHERE id = $3")
                .bind(new_bal)
                .bind(expires_at)
                .bind(eid)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "INSERT INTO gift_card_events (gift_card_id, event_kind, amount, balance_after, transaction_id, session_id) VALUES ($1, 'loaded', $2, $3, $4, $5)",
            )
            .bind(eid)
            .bind(remainder)
            .bind(new_bal)
            .bind(body.transaction_id)
            .bind(body.session_id)
            .execute(&mut *tx)
            .await?;
            eid
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
            .bind(&reward_card_code)
            .bind(remainder)
            .bind(expires_at)
            .bind(effective_customer_id)
            .bind(body.session_id)
            .bind(body.transaction_id)
            .bind(Option::<&str>::None)
            .fetch_one(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO gift_card_events (gift_card_id, event_kind, amount, balance_after, transaction_id, session_id) VALUES ($1, 'issued', $2, $2, $3, $4)",
            )
            .bind(new_id)
            .bind(remainder)
            .bind(body.transaction_id)
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
                (customer_id, points_deducted, reward_amount, applied_to_sale, remainder_card_id, transaction_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(effective_customer_id)
        .bind(threshold)
        .bind(reward_amount)
        .bind(body.apply_to_sale)
        .bind(card_id)
        .bind(body.transaction_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    if body.notify_customer_sms || body.notify_customer_email {
        let pool = state.db.clone();
        let http = state.http_client.clone();
        let cache = Arc::clone(&state.podium_token_cache);
        let cid = effective_customer_id;
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
        effective_customer_id,
        applied_to_sale: body.apply_to_sale,
        remainder_loaded: remainder,
        remainder_card_id,
    }))
}

#[derive(Debug, Deserialize)]
pub struct LoyaltyCustomerSummaryQuery {
    pub customer_id: Uuid,
}

#[derive(Debug, Serialize)]
pub struct LoyaltyCustomerSummaryResponse {
    pub selected_customer_id: Uuid,
    pub selected_customer_name: String,
    pub effective_customer_id: Uuid,
    pub effective_customer_name: String,
    pub loyalty_points: i32,
    pub shared_with_linked_customer: bool,
}

async fn loyalty_customer_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<LoyaltyCustomerSummaryQuery>,
) -> Result<Json<LoyaltyCustomerSummaryResponse>, LoyaltyError> {
    require_staff_or_pos_session(&state, &headers).await?;

    let selected: (Uuid, String, Option<Uuid>) = sqlx::query_as(
        r#"
        SELECT
            id,
            NULLIF(TRIM(CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, ''))), '') AS display_name,
            couple_primary_id
        FROM customers
        WHERE id = $1
        "#,
    )
    .bind(q.customer_id)
    .fetch_one(&state.db)
    .await?;

    let effective_customer_id =
        crate::logic::customer_couple::resolve_effective_customer_id(&state.db, q.customer_id)
            .await?;

    let effective: (Uuid, String, i32) = sqlx::query_as(
        r#"
        SELECT
            id,
            NULLIF(TRIM(CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, ''))), '') AS display_name,
            loyalty_points
        FROM customers
        WHERE id = $1
        "#,
    )
    .bind(effective_customer_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(LoyaltyCustomerSummaryResponse {
        selected_customer_id: selected.0,
        selected_customer_name: selected.1,
        effective_customer_id: effective.0,
        effective_customer_name: effective.1,
        loyalty_points: effective.2,
        shared_with_linked_customer: effective_customer_id != q.customer_id,
    }))
}

// ── Ledger (per customer) ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct LedgerQuery {
    pub customer_id: Uuid,
}

#[derive(Debug, Serialize, FromRow)]
pub struct RawLedgerRow {
    pub id: Uuid,
    pub delta_points: i32,
    pub balance_after: i32,
    pub reason: String,
    pub transaction_id: Option<Uuid>,
    pub transaction_display_id: Option<String>,
    pub created_by_staff_name: Option<String>,
    pub metadata: Value,
    pub created_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct LedgerRow {
    pub id: Uuid,
    pub delta_points: i32,
    pub balance_after: i32,
    pub reason: String,
    pub transaction_id: Option<Uuid>,
    pub transaction_display_id: Option<String>,
    pub created_at: chrono::DateTime<Utc>,
    pub activity_label: String,
    pub activity_detail: String,
}

fn loyalty_activity_summary(row: &RawLedgerRow) -> (String, String) {
    let metadata = &row.metadata;
    let transaction_ref = row
        .transaction_display_id
        .as_deref()
        .map(|display| format!(" on {display}"))
        .unwrap_or_default();

    if metadata
        .get("adjustment_kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "manual_adjust")
    {
        let adjusted_by = row
            .created_by_staff_name
            .as_deref()
            .map(|name| format!("Adjusted by {name}. "))
            .unwrap_or_default();
        return (
            "Manual adjustment".to_string(),
            format!("{adjusted_by}Reason: {}.", row.reason.trim()),
        );
    }

    match row.reason.as_str() {
        "order_earn" => {
            let detail = metadata
                .get("product_subtotal")
                .and_then(Value::as_str)
                .map(|value| format!("Eligible purchase subtotal ${value}{transaction_ref}."))
                .unwrap_or_else(|| {
                    format!("Points earned from a completed purchase{transaction_ref}.")
                });
            ("Points earned".to_string(), detail)
        }
        "reward_redemption" => {
            let reward_amount = metadata
                .get("reward_amount")
                .and_then(Value::as_str)
                .unwrap_or("0.00");
            let card_label = metadata
                .get("remainder_card_code")
                .and_then(Value::as_str)
                .map(masked_loyalty_card_label)
                .unwrap_or_else(|| "a loyalty gift card".to_string());
            (
                "Reward issued".to_string(),
                format!("Issued ${reward_amount} to {card_label}{transaction_ref}."),
            )
        }
        "order_refund_clawback" => (
            "Points removed after full refund".to_string(),
            format!("A full refund reversed the original loyalty earn{transaction_ref}."),
        ),
        "order_return_clawback" => {
            let detail = metadata
                .get("returned_subtotal")
                .and_then(Value::as_str)
                .map(|value| {
                    format!("Returned subtotal ${value} reduced the original loyalty earn{transaction_ref}.")
                })
                .unwrap_or_else(|| format!("A return reduced the original loyalty earn{transaction_ref}."));
            ("Points removed after return".to_string(), detail)
        }
        _ => (
            row.reason.replace('_', " "),
            format!("Balance changed to {} points.", row.balance_after),
        ),
    }
}

async fn customer_ledger(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<LedgerQuery>,
) -> Result<Json<Vec<LedgerRow>>, LoyaltyError> {
    require_staff_or_pos_session(&state, &headers).await?;
    let effective_customer_id =
        crate::logic::customer_couple::resolve_effective_customer_id(&state.db, q.customer_id)
            .await?;

    let rows = sqlx::query_as::<_, RawLedgerRow>(
        r#"
        SELECT
            lpl.id,
            lpl.delta_points,
            lpl.balance_after,
            lpl.reason,
            lpl.transaction_id,
            t.display_id AS transaction_display_id,
            NULLIF(TRIM(s.full_name), '') AS created_by_staff_name,
            lpl.metadata,
            lpl.created_at
        FROM loyalty_point_ledger lpl
        LEFT JOIN transactions t ON t.id = lpl.transaction_id
        LEFT JOIN staff s ON s.id = lpl.created_by_staff_id
        WHERE lpl.customer_id = $1
        ORDER BY lpl.created_at DESC
        LIMIT 200
        "#,
    )
    .bind(effective_customer_id)
    .fetch_all(&state.db)
    .await?;
    let rows = rows
        .into_iter()
        .map(|row| {
            let (activity_label, activity_detail) = loyalty_activity_summary(&row);
            LedgerRow {
                id: row.id,
                delta_points: row.delta_points,
                balance_after: row.balance_after,
                reason: row.reason,
                transaction_id: row.transaction_id,
                transaction_display_id: row.transaction_display_id,
                created_at: row.created_at,
                activity_label,
                activity_detail,
            }
        })
        .collect();
    Ok(Json(rows))
}

#[derive(Debug, Serialize, FromRow)]
pub struct IssuanceRow {
    pub id: Uuid,
    pub customer_id: Uuid,
    pub card_id: Option<Uuid>,
    pub card_code: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub address_line1: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub zip: Option<String>,
    pub reward_amount: Decimal,
    pub points_deducted: i32,
    pub applied_to_sale: Decimal,
    pub created_at: chrono::DateTime<Utc>,
}

async fn get_recent_issuances(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<IssuanceRow>>, LoyaltyError> {
    require_staff_or_pos_session(&state, &headers).await?;

    let rows = sqlx::query_as::<_, IssuanceRow>(
        r#"
        SELECT
            lri.id, lri.customer_id, lri.remainder_card_id as card_id, 
            gc.code as card_code,
            c.first_name, c.last_name, c.address_line1, c.city, c.state, c.postal_code as zip,
            lri.reward_amount, lri.points_deducted, lri.applied_to_sale,
            lri.created_at
        FROM loyalty_reward_issuances lri
        JOIN customers c ON lri.customer_id = c.id
        LEFT JOIN gift_cards gc ON lri.remainder_card_id = gc.id
        ORDER BY lri.created_at DESC
        LIMIT 100
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/settings", get(get_settings).patch(patch_settings))
        .route("/program-summary", get(get_program_summary))
        .route("/customer-summary", get(loyalty_customer_summary))
        .route("/pipeline-stats", get(get_loyalty_pipeline_stats))
        .route("/monthly-eligible", get(monthly_eligible))
        .route("/recent-issuances", get(get_recent_issuances))
        .route("/adjust-points", post(adjust_points))
        .route("/redeem-reward", post(redeem_reward))
        .route("/ledger", get(customer_ledger))
}

#[derive(Debug, Serialize)]
pub struct LoyaltyPipelineStats {
    pub total_points_liability: i64,
    pub eligible_customers_count: i64,
    pub lifetime_rewards_issued: i64,
    pub active_30d_adjustments: i64,
}

async fn get_loyalty_pipeline_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<LoyaltyPipelineStats>, LoyaltyError> {
    require_staff_or_pos_session(&state, &headers).await?;

    let threshold: i32 =
        sqlx::query_scalar("SELECT loyalty_point_threshold FROM store_settings WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let stats = sqlx::query(
        r#"
        SELECT
            (SELECT COALESCE(SUM(loyalty_points), 0)::bigint FROM customers WHERE is_active = TRUE) as total_pts,
            (SELECT COUNT(*)::bigint FROM customers WHERE loyalty_points >= $1 AND is_active = TRUE) as eligible_count,
            (SELECT COUNT(*)::bigint FROM loyalty_reward_issuances) as total_issuances,
            (SELECT COUNT(*)::bigint FROM loyalty_point_ledger WHERE created_at > (now() - interval '30 days') AND reason = 'manual_adjust') as recent_adjustments
        "#,
    )
    .bind(threshold)
    .fetch_one(&state.db)
    .await?;

    use sqlx::Row;
    Ok(Json(LoyaltyPipelineStats {
        total_points_liability: stats.get::<Option<i64>, _>("total_pts").unwrap_or(0),
        eligible_customers_count: stats.get::<Option<i64>, _>("eligible_count").unwrap_or(0),
        lifetime_rewards_issued: stats.get::<Option<i64>, _>("total_issuances").unwrap_or(0),
        active_30d_adjustments: stats
            .get::<Option<i64>, _>("recent_adjustments")
            .unwrap_or(0),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redemption_contract_requires_zero_immediate_use() {
        let error = resolve_redemption_contract(
            Decimal::new(1000, 2),
            Decimal::new(5000, 2),
            Some("LOYAL-1234"),
        )
        .expect_err("non-zero immediate use should be blocked");

        assert!(error
            .to_string()
            .contains("issued to a loyalty gift card only"));
    }

    #[test]
    fn redemption_contract_requires_card_code() {
        let error = resolve_redemption_contract(Decimal::ZERO, Decimal::new(5000, 2), None)
            .expect_err("card code should be required");

        assert!(error
            .to_string()
            .contains("Scan or enter a loyalty gift card code"));
    }

    #[test]
    fn redemption_contract_normalizes_card_code_and_full_reward_remainder() {
        let (remainder, code) =
            resolve_redemption_contract(Decimal::ZERO, Decimal::new(5000, 2), Some(" loy-1234 "))
                .expect("issuance-only redemption should succeed");

        assert_eq!(remainder, Decimal::new(5000, 2));
        assert_eq!(code, "LOY-1234");
    }

    #[test]
    fn loyalty_activity_summary_formats_reward_issuance() {
        let row = RawLedgerRow {
            id: Uuid::nil(),
            delta_points: -500,
            balance_after: 0,
            reason: "reward_redemption".to_string(),
            transaction_id: Some(Uuid::nil()),
            transaction_display_id: Some("TXN-1001".to_string()),
            created_by_staff_name: None,
            metadata: json!({
                "reward_amount": "50.00",
                "remainder_card_code": "LOY-1234",
            }),
            created_at: Utc::now(),
        };

        let (label, detail) = loyalty_activity_summary(&row);
        assert_eq!(label, "Reward issued");
        assert!(detail.contains("$50.00"));
        assert!(detail.contains("••••1234"));
        assert!(detail.contains("TXN-1001"));
    }

    #[test]
    fn loyalty_activity_summary_formats_manual_adjustment() {
        let row = RawLedgerRow {
            id: Uuid::nil(),
            delta_points: 25,
            balance_after: 225,
            reason: "CSR goodwill".to_string(),
            transaction_id: None,
            transaction_display_id: None,
            created_by_staff_name: Some("Chris Garcia".to_string()),
            metadata: json!({ "adjustment_kind": "manual_adjust" }),
            created_at: Utc::now(),
        };

        let (label, detail) = loyalty_activity_summary(&row);
        assert_eq!(label, "Manual adjustment");
        assert!(detail.contains("Adjusted by Chris Garcia"));
        assert!(detail.contains("CSR goodwill"));
    }

    #[test]
    fn loyalty_activity_summary_formats_return_clawback() {
        let row = RawLedgerRow {
            id: Uuid::nil(),
            delta_points: -75,
            balance_after: 425,
            reason: "order_return_clawback".to_string(),
            transaction_id: Some(Uuid::nil()),
            transaction_display_id: Some("TXN-2002".to_string()),
            created_by_staff_name: None,
            metadata: json!({ "returned_subtotal": "15.00" }),
            created_at: Utc::now(),
        };

        let (label, detail) = loyalty_activity_summary(&row);
        assert_eq!(label, "Points removed after return");
        assert!(detail.contains("$15.00"));
        assert!(detail.contains("TXN-2002"));
    }
}
