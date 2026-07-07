//! Register session API: till open / current session (Z-register Phase 1).

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use std::str::FromStr;
use thiserror::Error;
use uuid::Uuid;

use rust_decimal_macros::dec;

use crate::api::AppState;
use crate::auth::permissions::{
    REGISTER_OPEN_DRAWER, REGISTER_REPORTS, REGISTER_SESSION_ATTACH, REGISTER_SHIFT_HANDOFF,
};
use crate::auth::pins::{self, is_valid_staff_credential, log_staff_access, AuthenticatedStaff};
use crate::auth::pos_session;
use crate::middleware;

/// Discrepancy magnitude above which closing notes are mandatory (Nexo-style audit).
pub const DISCREPANCY_NOTE_THRESHOLD_USD: Decimal = dec!(5.00);

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Cashier code '{0}' is invalid or inactive")]
    InvalidCashier(String),
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("Register lane {register_lane} already has an open session")]
    RegisterLaneInUse { register_lane: i16 },
    #[error("Multiple register sessions are open; pick one")]
    RegisterSelectionRequired { sessions: Vec<OpenSessionSummary> },
    #[error("No active session found")]
    NoActiveSession,
    #[error("Session not found or not open for this operation")]
    SessionNotFound,
    #[error("Register session is already closed")]
    SessionAlreadyClosed,
    #[error("{0}")]
    NotAuthorized(String),
    #[error("{0}")]
    Forbidden(String),
}

impl IntoResponse for SessionError {
    fn into_response(self) -> Response {
        match self {
            SessionError::Database(e) => {
                tracing::error!(error = %e, "Database error in sessions");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "Internal server error" })),
                )
                    .into_response()
            }
            SessionError::InvalidCashier(code) => {
                (StatusCode::UNAUTHORIZED, Json(json!({ "error": code }))).into_response()
            }
            SessionError::InvalidPayload(m) => {
                (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response()
            }
            SessionError::RegisterLaneInUse { register_lane } => (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "register_lane_in_use",
                    "register_lane": register_lane,
                })),
            )
                .into_response(),
            SessionError::RegisterSelectionRequired { sessions } => (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "register_selection_required",
                    "open_sessions": sessions,
                })),
            )
                .into_response(),
            SessionError::NoActiveSession => (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "No active session found" })),
            )
                .into_response(),
            SessionError::SessionNotFound => (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "Session not found or not open for this operation" })),
            )
                .into_response(),
            SessionError::SessionAlreadyClosed => (
                StatusCode::CONFLICT,
                Json(json!({ "error": "Register session is already closed" })),
            )
                .into_response(),
            SessionError::NotAuthorized(m) => {
                (StatusCode::UNAUTHORIZED, Json(json!({ "error": m }))).into_response()
            }
            SessionError::Forbidden(m) => {
                (StatusCode::FORBIDDEN, Json(json!({ "error": m }))).into_response()
            }
        }
    }
}

fn map_session_gate_err(e: (StatusCode, axum::Json<serde_json::Value>)) -> SessionError {
    let (st, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match st {
        StatusCode::UNAUTHORIZED => SessionError::NotAuthorized(msg),
        StatusCode::FORBIDDEN => SessionError::Forbidden(msg),
        _ => SessionError::InvalidPayload(msg),
    }
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    matches!(
        error,
        sqlx::Error::Database(db_error)
            if db_error.code().as_deref() == Some("23505")
    )
}

fn station_key_from_request(
    headers: &HeaderMap,
    body_station_key: Option<&str>,
) -> Result<String, SessionError> {
    let station_key = body_station_key
        .or_else(|| {
            headers
                .get(pos_session::HEADER_STATION_KEY)
                .and_then(|value| value.to_str().ok())
        })
        .unwrap_or("")
        .trim();
    if !(8..=128).contains(&station_key.len()) {
        return Err(SessionError::InvalidPayload(
            "station_key is required for Register session tokens".to_string(),
        ));
    }
    Ok(station_key.to_string())
}

async fn upsert_station_pos_token(
    db: &sqlx::PgPool,
    session_id: Uuid,
    station_key: &str,
) -> Result<String, SessionError> {
    let token = pos_session::new_pos_api_token();
    upsert_station_pos_token_value(db, session_id, station_key, token).await
}

async fn upsert_station_pos_token_value(
    db: &sqlx::PgPool,
    session_id: Uuid,
    station_key: &str,
    token: String,
) -> Result<String, SessionError> {
    sqlx::query(
        r#"
        INSERT INTO register_session_station_tokens (
            register_session_id, station_key, pos_api_token
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (register_session_id, station_key)
        DO UPDATE SET
            pos_api_token = EXCLUDED.pos_api_token,
            last_used_at = now()
        "#,
    )
    .bind(session_id)
    .bind(station_key)
    .bind(&token)
    .execute(db)
    .await?;
    sqlx::query(
        r#"
        UPDATE register_sessions
        SET pos_api_token = $2
        WHERE id = $1 AND is_open = true
        "#,
    )
    .bind(session_id)
    .bind(&token)
    .execute(db)
    .await?;
    Ok(token)
}

fn default_register_lane() -> i16 {
    1
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenSessionSummary {
    pub session_id: Uuid,
    pub register_lane: i16,
    pub register_ordinal: i64,
    pub cashier_name: String,
    pub opened_at: DateTime<Utc>,
    pub till_close_group_id: Uuid,
    pub lifecycle_status: String,
}

#[derive(Debug, Deserialize)]
pub struct OpenSessionRequest {
    pub cashier_code: String,
    /// Required when `staff.pin_hash` is set (hashed PIN).
    #[serde(default)]
    pub pin: Option<String>,
    pub opening_float: Decimal,
    /// Physical register number (1–99). Must be unused among open sessions.
    #[serde(default = "default_register_lane")]
    pub register_lane: i16,
    /// When `register_lane > 1`, required: open Register #1 session id to join its till shift.
    #[serde(default)]
    pub primary_session_id: Option<Uuid>,
    #[serde(default)]
    pub station_key: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TendersByLane {
    pub register_lane: i16,
    pub tenders: Vec<TenderTotal>,
}

#[derive(Debug, Serialize)]
pub struct SessionResponse {
    pub session_id: Uuid,
    /// Physical lane label (Register #1, #2, …).
    pub register_lane: i16,
    /// Monotonic opened-order sequence for display (e.g. "Session #1032").
    pub register_ordinal: i64,
    pub lifecycle_status: String,
    /// Display name for **register primary** (`COALESCE(shift_primary, opened_by)`).
    pub cashier_name: String,
    pub cashier_avatar_key: String,
    pub cashier_code: String,
    pub role: crate::models::DbStaffRole,
    /// Staff who opened the drawer (POS token issuer).
    pub opened_by_staff_id: Uuid,
    /// When set, register primary is this staff; `None` means primary is `opened_by`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shift_primary_staff_id: Option<Uuid>,
    /// Resolved primary for tasks / actor context on this terminal.
    pub register_primary_staff_id: Uuid,
    pub opening_float: Decimal,
    pub opened_at: DateTime<Utc>,
    pub till_close_group_id: Uuid,
    /// IANA TZ from `store_settings.receipt_config` — matches receipt / thermal timestamp formatting.
    pub receipt_timezone: String,
    /// Returned on open / re-issue only; never on `GET /current`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos_api_token: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TenderTotal {
    pub payment_method: String,
    pub total_amount: Decimal,
    pub tx_count: i64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CashAdjustmentLine {
    pub id: Uuid,
    pub direction: String,
    pub amount: Decimal,
    pub category: Option<String>,
    pub reason: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ManualDrawerOpenLine {
    pub id: Uuid,
    pub staff_id: Uuid,
    pub staff_name: String,
    pub reason: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct OverrideSummaryRow {
    pub reason: String,
    pub line_count: i64,
    pub total_delta: Decimal,
}

#[derive(Debug, Serialize, FromRow)]
pub struct InventoryActivityLine {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub tx_type: String,
    pub sku: String,
    pub product_name: String,
    pub category_name: Option<String>,
    pub quantity_delta: i32,
    pub unit_cost: Option<Decimal>,
    pub value_delta: Decimal,
    pub reference_table: Option<String>,
    pub reference_id: Option<Uuid>,
    pub notes: Option<String>,
    pub staff_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReconciliationResponse {
    pub report_type: &'static str,
    /// Unique session ID for the reconciliation report.
    pub session_id: Uuid,
    pub qbo_activity_date: NaiveDate,
    pub qbo_journal: Option<crate::logic::qbo_journal::JournalProposal>,
    pub qbo_journal_error: Option<String>,
    pub opening_float: Decimal,
    pub net_cash_adjustments: Decimal,
    pub total_rounding_adjustments: Decimal,
    pub expected_cash: Decimal,
    /// All lanes in the till shift (Z) or single lane (X).
    pub tenders: Vec<TenderTotal>,
    /// Per-lane tender breakdown (Z: each open lane; X: one row).
    pub tenders_by_lane: Vec<TendersByLane>,
    pub cash_adjustments: Vec<CashAdjustmentLine>,
    pub manual_drawer_opens: Vec<ManualDrawerOpenLine>,
    pub override_summary: Vec<OverrideSummaryRow>,
    pub transactions: Vec<TransactionLine>,
    pub inventory_activity: Vec<InventoryActivityLine>,
    pub unresolved_helcim_attempts: Vec<HelcimCloseReviewAttempt>,
}

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct HelcimCloseReviewAttempt {
    pub id: Uuid,
    pub register_session_id: Uuid,
    pub register_lane: i16,
    pub status: String,
    pub amount_cents: i64,
    pub selected_terminal_key: Option<String>,
    pub review_reason: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TransactionLine {
    pub payment_transaction_id: Uuid,
    pub register_session_id: Uuid,
    pub register_lane: i16,
    pub created_at: DateTime<Utc>,
    pub payment_method: String,
    pub amount: Decimal,
    pub check_number: Option<String>,
    pub ledger_transaction_id: Option<Uuid>,
    pub transaction_display_id: Option<String>,
    pub transaction_status: Option<String>,
    pub transaction_total: Option<Decimal>,
    pub transaction_paid: Option<Decimal>,
    pub transaction_balance_due: Option<Decimal>,
    pub customer_name: String,
    pub items: Vec<TransactionAuditItem>,
    pub override_reasons: Vec<String>,
    pub override_details: Vec<OverrideDetail>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TransactionAuditItem {
    pub name: String,
    pub sku: String,
    pub quantity: i32,
    pub unit_price: Decimal,
    pub original_unit_price: Option<Decimal>,
    pub overridden_unit_price: Option<Decimal>,
    pub fulfillment: String,
    pub is_internal: bool,
    pub line_kind: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct OverrideDetail {
    pub reason: String,
    pub original_unit_price: Option<Decimal>,
    pub overridden_unit_price: Option<Decimal>,
    pub delta_amount: Option<Decimal>,
}

#[derive(Debug, Deserialize)]
pub struct CashAdjustmentRequest {
    pub direction: String,
    pub amount: Decimal,
    pub reason: String,
    pub category: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ManualDrawerOpenRequest {
    pub cashier_code: String,
    pub pin: String,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct CloseSessionRequest {
    pub actual_cash: Decimal,
    pub cash_deposit_date: Option<NaiveDate>,
    pub cash_deposit_amount: Option<Decimal>,
    pub closing_notes: Option<String>,
    pub closing_comments: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HelcimCloseReviewRequest {
    pub action: String,
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BeginReconcileRequest {
    /// Set to `true` when staff enters the blind-count / Z flow (optional audit step).
    #[serde(default)]
    pub active: bool,
    /// Cashier code of the staff member initiating reconciliation.
    pub cashier_code: String,
}

#[derive(Debug, Serialize)]
pub struct CloseSessionResponse {
    pub status: &'static str,
    pub discrepancy: Decimal,
}

#[derive(Debug, FromRow)]
struct TenderAggregateRow {
    payment_method: String,
    total_amount: Option<Decimal>,
    tx_count: Option<i64>,
}

#[derive(Debug, FromRow)]
struct LaneTenderAggRow {
    register_lane: i16,
    payment_method: String,
    total_amount: Option<Decimal>,
    tx_count: Option<i64>,
}

#[derive(Debug, FromRow)]
struct TransactionLineRow {
    payment_transaction_id: Uuid,
    register_session_id: Uuid,
    register_lane: i16,
    created_at: DateTime<Utc>,
    payment_method: String,
    amount: Decimal,
    check_number: Option<String>,
    ledger_transaction_id: Option<Uuid>,
    transaction_display_id: Option<String>,
    transaction_status: Option<String>,
    transaction_total: Option<Decimal>,
    transaction_paid: Option<Decimal>,
    transaction_balance_due: Option<Decimal>,
    customer_name: String,
    items_json: serde_json::Value,
    override_reasons: Vec<String>,
    override_details_json: serde_json::Value,
}

#[derive(Debug, FromRow)]
struct CurrentSessionRow {
    id: Uuid,
    opened_by: Uuid,
    shift_primary_staff_id: Option<Uuid>,
    opening_float: Decimal,
    opened_at: DateTime<Utc>,
    register_lane: i16,
    till_close_group_id: Uuid,
    cashier_name: String,
    cashier_avatar_key: String,
    cashier_code: String,
    role: crate::models::DbStaffRole,
    lifecycle_status: String,
    session_ordinal: i64,
    register_primary_staff_id: Uuid,
}

#[derive(Debug, FromRow)]
struct InsertedSessionRow {
    id: Uuid,
    opened_at: DateTime<Utc>,
    session_ordinal: i64,
}

#[derive(Debug, Deserialize)]
pub struct IssuePosTokenRequest {
    pub cashier_code: String,
    #[serde(default)]
    pub pin: Option<String>,
    #[serde(default)]
    pub station_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ShiftPrimaryRequest {
    pub cashier_code: String,
    #[serde(default)]
    pub pin: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct IssuePosTokenResponse {
    pub pos_api_token: String,
}

async fn load_receipt_timezone(db: &sqlx::PgPool) -> String {
    match sqlx::query_scalar::<_, Option<String>>(
        r#"
        SELECT NULLIF(BTRIM(receipt_config->>'timezone'), '')
        FROM store_settings
        WHERE id = 1
        LIMIT 1
        "#,
    )
    .fetch_optional(db)
    .await
    {
        Ok(Some(Some(t))) if !t.is_empty() => t,
        _ => "America/New_York".to_string(),
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/current", get(get_current_session))
        .route("/list-open", get(list_open_sessions))
        .route("/open", post(open_session))
        .route("/{session_id}/attach", post(post_session_attach))
        .route("/{session_id}/shift-primary", post(post_shift_primary))
        .route("/{session_id}/pos-api-token", post(issue_pos_api_token))
        .route("/{session_id}/reconciliation", get(get_reconciliation))
        .route("/{session_id}/adjustments", post(post_cash_adjustment))
        .route("/{session_id}/drawer-opens", post(post_manual_drawer_open))
        .route("/{session_id}/begin-reconcile", post(begin_reconcile))
        .route(
            "/{session_id}/helcim-close-review/{attempt_id}",
            post(post_helcim_close_review),
        )
        .route("/{session_id}/close", post(close_session))
}

async fn get_current_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SessionResponse>, SessionError> {
    let receipt_timezone = load_receipt_timezone(&state.db).await;
    let auth = middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_session_gate_err)?;

    match auth {
        middleware::StaffOrPosSession::PosSession { session_id } => {
            let row = fetch_current_session_row(&state.db, session_id).await?;
            let Some(r) = row else {
                return Err(SessionError::NoActiveSession);
            };
            Ok(Json(session_response_from_row(r, None, receipt_timezone)))
        }
        middleware::StaffOrPosSession::Staff(_) => {
            let rows: Vec<CurrentSessionRow> = sqlx::query_as(
                r#"
                SELECT
                    rs.id,
                    rs.opened_by,
                    rs.shift_primary_staff_id,
                    rs.opening_float,
                    rs.opened_at,
                    rs.register_lane,
                    rs.till_close_group_id,
                    s_reg.full_name AS cashier_name,
                    s_reg.avatar_key AS cashier_avatar_key,
                    s_reg.cashier_code,
                    s_reg.role,
                    rs.lifecycle_status,
                    rs.session_ordinal,
                    s_reg.id AS register_primary_staff_id
                FROM register_sessions rs
                JOIN staff s_reg ON s_reg.id = COALESCE(rs.shift_primary_staff_id, rs.opened_by)
                WHERE rs.is_open = true
                ORDER BY rs.register_lane ASC, rs.opened_at ASC
                "#,
            )
            .fetch_all(&state.db)
            .await?;

            match rows.len() {
                0 => Err(SessionError::NoActiveSession),
                1 => Ok(Json(session_response_from_row(
                    rows.into_iter().next().expect("one row"),
                    None,
                    receipt_timezone,
                ))),
                // Return only the first session (lane 1) for staff auth to avoid 409
                // when multiple lanes are open. This allows Back Office staff to access
                // the primary register without being forced to pick one.
                _ => Ok(Json(session_response_from_row(
                    rows.into_iter().next().expect("at least one row"),
                    None,
                    receipt_timezone,
                ))),
            }
        }
    }
}

async fn fetch_current_session_row(
    db: &sqlx::PgPool,
    session_id: Uuid,
) -> Result<Option<CurrentSessionRow>, SessionError> {
    sqlx::query_as(
        r#"
        SELECT
            rs.id,
            rs.opened_by,
            rs.shift_primary_staff_id,
            rs.opening_float,
            rs.opened_at,
            rs.register_lane,
            rs.till_close_group_id,
            s_reg.full_name AS cashier_name,
            s_reg.avatar_key AS cashier_avatar_key,
            s_reg.cashier_code,
            s_reg.role,
            rs.lifecycle_status,
            rs.session_ordinal,
            s_reg.id AS register_primary_staff_id
        FROM register_sessions rs
        JOIN staff s_reg ON s_reg.id = COALESCE(rs.shift_primary_staff_id, rs.opened_by)
        WHERE rs.id = $1 AND rs.is_open = true
        "#,
    )
    .bind(session_id)
    .fetch_optional(db)
    .await
    .map_err(SessionError::Database)
}

fn open_summary_from_current_row(r: &CurrentSessionRow) -> OpenSessionSummary {
    OpenSessionSummary {
        session_id: r.id,
        register_lane: r.register_lane,
        register_ordinal: r.session_ordinal,
        cashier_name: r.cashier_name.clone(),
        opened_at: r.opened_at,
        till_close_group_id: r.till_close_group_id,
        lifecycle_status: r.lifecycle_status.clone(),
    }
}

async fn list_open_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<OpenSessionSummary>>, SessionError> {
    middleware::require_staff_with_permission(&state, &headers, REGISTER_SESSION_ATTACH)
        .await
        .map_err(map_session_gate_err)?;

    let rows: Vec<CurrentSessionRow> = sqlx::query_as(
        r#"
        SELECT
            rs.id,
            rs.opened_by,
            rs.shift_primary_staff_id,
            rs.opening_float,
            rs.opened_at,
            rs.register_lane,
            rs.till_close_group_id,
            s_reg.full_name AS cashier_name,
            s_reg.avatar_key AS cashier_avatar_key,
            s_reg.cashier_code,
            s_reg.role,
            rs.lifecycle_status,
            rs.session_ordinal,
            s_reg.id AS register_primary_staff_id
        FROM register_sessions rs
        JOIN staff s_reg ON s_reg.id = COALESCE(rs.shift_primary_staff_id, rs.opened_by)
        WHERE rs.is_open = true
        ORDER BY rs.register_lane ASC, rs.opened_at ASC
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.iter()
            .map(open_summary_from_current_row)
            .collect::<Vec<_>>(),
    ))
}

async fn post_session_attach(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<IssuePosTokenResponse>, SessionError> {
    let station_key = station_key_from_request(&headers, None)?;
    middleware::require_staff_with_permission(&state, &headers, REGISTER_SESSION_ATTACH)
        .await
        .map_err(map_session_gate_err)?;

    let open_session_exists: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(SELECT 1 FROM register_sessions WHERE id = $1 AND is_open = true)"#,
    )
    .bind(session_id)
    .fetch_one(&state.db)
    .await?;

    if !open_session_exists {
        return Err(SessionError::SessionNotFound);
    }
    let token = upsert_station_pos_token(&state.db, session_id, &station_key).await?;

    Ok(Json(IssuePosTokenResponse {
        pos_api_token: token,
    }))
}

fn session_response_from_row(
    r: CurrentSessionRow,
    pos_api_token: Option<String>,
    receipt_timezone: String,
) -> SessionResponse {
    SessionResponse {
        session_id: r.id,
        register_lane: r.register_lane,
        register_ordinal: r.session_ordinal,
        lifecycle_status: r.lifecycle_status,
        cashier_name: r.cashier_name,
        cashier_avatar_key: r.cashier_avatar_key,
        cashier_code: r.cashier_code,
        role: r.role,
        opened_by_staff_id: r.opened_by,
        shift_primary_staff_id: r.shift_primary_staff_id,
        register_primary_staff_id: r.register_primary_staff_id,
        opening_float: r.opening_float,
        opened_at: r.opened_at,
        till_close_group_id: r.till_close_group_id,
        receipt_timezone,
        pos_api_token,
    }
}

async fn try_authenticated_staff_headers(
    state: &AppState,
    headers: &HeaderMap,
) -> Option<AuthenticatedStaff> {
    let code = headers
        .get("x-riverside-staff-code")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();
    if code.is_empty() {
        return None;
    }
    let pin = headers
        .get("x-riverside-staff-pin")
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    pins::authenticate_pos_staff(&state.db, code, pin)
        .await
        .ok()
}

async fn post_shift_primary(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<ShiftPrimaryRequest>,
) -> Result<Json<SessionResponse>, SessionError> {
    middleware::require_pos_session_secret_or_permission(
        &state,
        &headers,
        session_id,
        REGISTER_SHIFT_HANDOFF,
    )
    .await
    .map_err(map_session_gate_err)?;

    #[derive(FromRow)]
    struct ShiftCtx {
        opened_by: Uuid,
        shift_primary_staff_id: Option<Uuid>,
    }

    let ctx: Option<ShiftCtx> = sqlx::query_as(
        r#"
        SELECT opened_by, shift_primary_staff_id
        FROM register_sessions
        WHERE id = $1 AND is_open = true
        "#,
    )
    .bind(session_id)
    .fetch_optional(&state.db)
    .await?;

    let Some(ctx) = ctx else {
        return Err(SessionError::SessionNotFound);
    };

    let from_primary = ctx.shift_primary_staff_id.unwrap_or(ctx.opened_by);

    let actor_id = match try_authenticated_staff_headers(&state, &headers).await {
        Some(s) => s.id,
        None => from_primary,
    };

    let code = body.cashier_code.trim();
    if !is_valid_staff_credential(code) {
        return Err(SessionError::InvalidPayload(
            "Staff code must be exactly 4 digits".to_string(),
        ));
    }
    let target = pins::authenticate_pos_staff(&state.db, code, body.pin.as_deref())
        .await
        .map_err(|_| SessionError::InvalidCashier(code.to_string()))?;

    let new_shift: Option<Uuid> = if target.id == ctx.opened_by {
        None
    } else {
        Some(target.id)
    };

    let n = sqlx::query(
        r#"
        UPDATE register_sessions
        SET shift_primary_staff_id = $1
        WHERE id = $2 AND is_open = true
        "#,
    )
    .bind(new_shift)
    .bind(session_id)
    .execute(&state.db)
    .await?
    .rows_affected();

    if n == 0 {
        return Err(SessionError::SessionNotFound);
    }

    let _ = log_staff_access(
        &state.db,
        actor_id,
        "register_shift_handoff",
        json!({
            "session_id": session_id,
            "from_register_primary_staff_id": from_primary,
            "to_register_primary_staff_id": target.id,
            "shift_primary_set_to": new_shift,
        }),
    )
    .await;

    let row: Option<CurrentSessionRow> = sqlx::query_as(
        r#"
        SELECT
            rs.id,
            rs.opened_by,
            rs.shift_primary_staff_id,
            rs.opening_float,
            rs.opened_at,
            rs.register_lane,
            rs.till_close_group_id,
            s_reg.full_name AS cashier_name,
            s_reg.avatar_key AS cashier_avatar_key,
            s_reg.cashier_code,
            s_reg.role,
            rs.lifecycle_status,
            rs.session_ordinal,
            s_reg.id AS register_primary_staff_id
        FROM register_sessions rs
        JOIN staff s_reg ON s_reg.id = COALESCE(rs.shift_primary_staff_id, rs.opened_by)
        WHERE rs.id = $1 AND rs.is_open = true
        "#,
    )
    .bind(session_id)
    .fetch_optional(&state.db)
    .await?;

    let Some(r) = row else {
        return Err(SessionError::SessionNotFound);
    };

    let receipt_timezone = load_receipt_timezone(&state.db).await;
    Ok(Json(session_response_from_row(r, None, receipt_timezone)))
}

async fn open_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<OpenSessionRequest>,
) -> Result<Json<SessionResponse>, SessionError> {
    let station_key = station_key_from_request(&headers, payload.station_key.as_deref())?;
    let lane = payload.register_lane;
    if !(1..=4).contains(&lane) {
        return Err(SessionError::InvalidPayload(
            "register_lane must be 1 (Main), 2 (iPad), 3 (Back Office), or 4 (Smartphone)"
                .to_string(),
        ));
    }

    let lane_taken: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM register_sessions
            WHERE is_open = true AND register_lane = $1
        )
        "#,
    )
    .bind(lane)
    .fetch_one(&state.db)
    .await?;

    if lane_taken {
        return Err(SessionError::RegisterLaneInUse {
            register_lane: lane,
        });
    }

    let code = payload.cashier_code.trim();
    if !is_valid_staff_credential(code) {
        return Err(SessionError::InvalidPayload(
            "Staff code must be exactly 4 digits".to_string(),
        ));
    }
    let staff = pins::authenticate_pos_staff(&state.db, code, payload.pin.as_deref())
        .await
        .map_err(|_| SessionError::InvalidCashier(code.to_string()))?;

    let (till_close_group_id, opening_float_stored) = if lane == 1 {
        if payload.opening_float < Decimal::ZERO {
            return Err(SessionError::InvalidPayload(
                "opening_float cannot be negative".to_string(),
            ));
        }
        (Uuid::new_v4(), payload.opening_float)
    } else {
        let primary = payload.primary_session_id.ok_or_else(|| {
            SessionError::InvalidPayload(
                "primary_session_id is required when opening register lane greater than 1"
                    .to_string(),
            )
        })?;
        let row: Option<(Uuid, i16)> = sqlx::query_as(
            r#"
            SELECT till_close_group_id, register_lane
            FROM register_sessions
            WHERE id = $1 AND is_open = true
            "#,
        )
        .bind(primary)
        .fetch_optional(&state.db)
        .await?;
        let Some((gid, primary_lane)) = row else {
            return Err(SessionError::InvalidPayload(
                "primary_session_id must refer to an open register session".to_string(),
            ));
        };
        if primary_lane != 1 {
            return Err(SessionError::InvalidPayload(
                "primary_session_id must be Register lane 1 (cash drawer)".to_string(),
            ));
        }
        if payload.opening_float != Decimal::ZERO {
            return Err(SessionError::InvalidPayload(
                "opening_float must be 0 for satellite registers (lane > 1)".to_string(),
            ));
        }
        (gid, Decimal::ZERO)
    };

    let _ = log_staff_access(
        &state.db,
        staff.id,
        "register_open",
        json!({
            "opening_float": opening_float_stored,
            "register_lane": lane,
            "till_close_group_id": till_close_group_id,
        }),
    )
    .await;

    let token = pos_session::new_pos_api_token();

    let inserted: InsertedSessionRow = sqlx::query_as(
        r#"
        INSERT INTO register_sessions (
            opened_by, opening_float, is_open, lifecycle_status, pos_api_token, register_lane,
            till_close_group_id
        )
        VALUES ($1, $2, true, 'open', $3, $4, $5)
        RETURNING id, opened_at, session_ordinal
        "#,
    )
    .bind(staff.id)
    .bind(opening_float_stored)
    .bind(&token)
    .bind(lane)
    .bind(till_close_group_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if is_unique_violation(&e) {
            SessionError::RegisterLaneInUse {
                register_lane: lane,
            }
        } else {
            SessionError::Database(e)
        }
    })?;
    let token = upsert_station_pos_token_value(&state.db, inserted.id, &station_key, token).await?;

    let receipt_timezone = load_receipt_timezone(&state.db).await;

    // Automatic creation for satellite lanes 2, 3, and 4 when opening lane 1
    if lane == 1 {
        for satellite_lane in [2, 3, 4] {
            let satellite_token = pos_session::new_pos_api_token();
            let _: (Uuid,) = sqlx::query_as(
                r#"
                INSERT INTO register_sessions (
                    opened_by, opening_float, is_open, lifecycle_status, pos_api_token, register_lane,
                    till_close_group_id
                )
                VALUES ($1, $2, true, 'open', $3, $4, $5)
                RETURNING id
                "#,
            )
            .bind(staff.id)
            .bind(dec!(0.00))
            .bind(&satellite_token)
            .bind(satellite_lane as i16)
            .bind(till_close_group_id)
            .fetch_one(&state.db)
            .await
            .map_err(|e| {
                if is_unique_violation(&e) {
                    SessionError::RegisterLaneInUse {
                        register_lane: satellite_lane as i16,
                    }
                } else {
                    SessionError::Database(e)
                }
            })?;
        }
    }

    Ok(Json(SessionResponse {
        session_id: inserted.id,
        register_lane: lane,
        register_ordinal: inserted.session_ordinal,
        lifecycle_status: "open".to_string(),
        cashier_name: staff.full_name,
        cashier_avatar_key: staff.avatar_key,
        cashier_code: code.to_string(),
        role: staff.role,
        opened_by_staff_id: staff.id,
        shift_primary_staff_id: None,
        register_primary_staff_id: staff.id,
        opening_float: opening_float_stored,
        opened_at: inserted.opened_at,
        till_close_group_id,
        receipt_timezone,
        pos_api_token: Some(token),
    }))
}

async fn issue_pos_api_token(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
    Json(payload): Json<IssuePosTokenRequest>,
) -> Result<Json<IssuePosTokenResponse>, SessionError> {
    let station_key = station_key_from_request(&headers, payload.station_key.as_deref())?;
    let code = payload.cashier_code.trim();
    if !is_valid_staff_credential(code) {
        return Err(SessionError::InvalidPayload(
            "Staff code must be exactly 4 digits".to_string(),
        ));
    }
    let staff = pins::authenticate_pos_staff(&state.db, code, payload.pin.as_deref())
        .await
        .map_err(|_| SessionError::InvalidCashier(code.to_string()))?;

    let opened_by: Option<Uuid> = sqlx::query_scalar(
        r#"SELECT opened_by FROM register_sessions WHERE id = $1 AND is_open = true"#,
    )
    .bind(session_id)
    .fetch_optional(&state.db)
    .await?;

    let Some(opened_by) = opened_by else {
        return Err(SessionError::SessionNotFound);
    };

    if opened_by != staff.id {
        return Err(SessionError::InvalidPayload(
            "only the staff member who opened this register session may issue a POS API token"
                .to_string(),
        ));
    }

    let token = upsert_station_pos_token(&state.db, session_id, &station_key).await?;

    Ok(Json(IssuePosTokenResponse {
        pos_api_token: token,
    }))
}

async fn get_reconciliation(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<ReconciliationResponse>, SessionError> {
    middleware::require_pos_session_secret_or_permission(
        &state,
        &headers,
        session_id,
        REGISTER_REPORTS,
    )
    .await
    .map_err(map_session_gate_err)?;
    build_reconciliation(&state.db, session_id, "z_report")
        .await
        .map(Json)
}

fn tenders_by_lane_from_agg(rows: Vec<LaneTenderAggRow>) -> Vec<TendersByLane> {
    use std::collections::BTreeMap;
    let mut m: BTreeMap<i16, Vec<TenderTotal>> = BTreeMap::new();
    for r in rows {
        m.entry(r.register_lane).or_default().push(TenderTotal {
            payment_method: r.payment_method,
            total_amount: r.total_amount.unwrap_or(Decimal::ZERO),
            tx_count: r.tx_count.unwrap_or(0),
        });
    }
    m.into_iter()
        .map(|(register_lane, tenders)| TendersByLane {
            register_lane,
            tenders,
        })
        .collect()
}

async fn unresolved_helcim_attempts_for_sessions(
    db: &sqlx::PgPool,
    session_ids: &[Uuid],
) -> Result<Vec<HelcimCloseReviewAttempt>, SessionError> {
    sqlx::query_as::<_, HelcimCloseReviewAttempt>(
        r#"
        SELECT
            ppa.id,
            ppa.register_session_id,
            rs.register_lane,
            ppa.status,
            ppa.amount_cents,
            ppa.selected_terminal_key,
            CASE
                WHEN ppa.status = 'pending' THEN 'waiting_on_terminal'
                WHEN ppa.status IN ('approved', 'captured') THEN 'approved_not_recorded'
                ELSE 'outcome_needs_review'
            END AS review_reason,
            ppa.created_at
        FROM payment_provider_attempts ppa
        INNER JOIN register_sessions rs ON rs.id = ppa.register_session_id
        WHERE ppa.provider = 'helcim'
          AND ppa.register_session_id = ANY($1)
          AND (
              ppa.status = 'pending'
              OR ppa.status = 'expired'
              OR (
                  ppa.status IN ('approved', 'captured')
                  AND NOT EXISTS (
                      SELECT 1
                      FROM payment_transactions pt
                      WHERE COALESCE(pt.payment_provider, '') = 'helcim'
                        AND (
                            pt.metadata->>'payment_provider_attempt_id' = ppa.id::text
                            OR (
                                NULLIF(TRIM(COALESCE(ppa.provider_transaction_id, '')), '') IS NOT NULL
                                AND pt.provider_transaction_id = ppa.provider_transaction_id
                            )
                            OR (
                                NULLIF(TRIM(COALESCE(ppa.provider_payment_id, '')), '') IS NOT NULL
                                AND pt.provider_payment_id = ppa.provider_payment_id
                            )
                        )
                  )
              )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM helcim_terminal_recovery_actions hra
              WHERE hra.source_kind = 'payment_provider_attempt'
                AND hra.source_id = ppa.id
          )
        ORDER BY ppa.created_at ASC
        "#,
    )
    .bind(session_ids)
    .fetch_all(db)
    .await
    .map_err(SessionError::Database)
}

async fn unresolved_helcim_attempts_for_sessions_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    session_ids: &[Uuid],
) -> Result<Vec<HelcimCloseReviewAttempt>, SessionError> {
    sqlx::query_as::<_, HelcimCloseReviewAttempt>(
        r#"
        SELECT
            ppa.id,
            ppa.register_session_id,
            rs.register_lane,
            ppa.status,
            ppa.amount_cents,
            ppa.selected_terminal_key,
            CASE
                WHEN ppa.status = 'pending' THEN 'waiting_on_terminal'
                WHEN ppa.status IN ('approved', 'captured') THEN 'approved_not_recorded'
                ELSE 'outcome_needs_review'
            END AS review_reason,
            ppa.created_at
        FROM payment_provider_attempts ppa
        INNER JOIN register_sessions rs ON rs.id = ppa.register_session_id
        WHERE ppa.provider = 'helcim'
          AND ppa.register_session_id = ANY($1)
          AND (
              ppa.status = 'pending'
              OR ppa.status = 'expired'
              OR (
                  ppa.status IN ('approved', 'captured')
                  AND NOT EXISTS (
                      SELECT 1
                      FROM payment_transactions pt
                      WHERE COALESCE(pt.payment_provider, '') = 'helcim'
                        AND (
                            pt.metadata->>'payment_provider_attempt_id' = ppa.id::text
                            OR (
                                NULLIF(TRIM(COALESCE(ppa.provider_transaction_id, '')), '') IS NOT NULL
                                AND pt.provider_transaction_id = ppa.provider_transaction_id
                            )
                            OR (
                                NULLIF(TRIM(COALESCE(ppa.provider_payment_id, '')), '') IS NOT NULL
                                AND pt.provider_payment_id = ppa.provider_payment_id
                            )
                        )
                  )
              )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM helcim_terminal_recovery_actions hra
              WHERE hra.source_kind = 'payment_provider_attempt'
                AND hra.source_id = ppa.id
          )
        ORDER BY ppa.created_at ASC
        "#,
    )
    .bind(session_ids)
    .fetch_all(&mut **tx)
    .await
    .map_err(SessionError::Database)
}

fn unresolved_helcim_close_message(attempts: &[HelcimCloseReviewAttempt]) -> String {
    let approved = attempts
        .iter()
        .filter(|attempt| attempt.review_reason == "approved_not_recorded")
        .count();
    let pending = attempts
        .iter()
        .filter(|attempt| attempt.review_reason == "waiting_on_terminal")
        .count();
    let review = attempts
        .iter()
        .filter(|attempt| attempt.review_reason == "outcome_needs_review")
        .count();
    let mut parts = Vec::new();
    if approved > 0 {
        parts.push(format!(
            "{approved} approved Helcim payment{} not recorded in ROS",
            if approved == 1 { "" } else { "s" }
        ));
    }
    if pending > 0 {
        parts.push(format!(
            "{pending} Helcim terminal payment{} still waiting",
            if pending == 1 { "" } else { "s" }
        ));
    }
    if review > 0 {
        parts.push(format!(
            "{review} Helcim terminal outcome{} needing review",
            if review == 1 { "" } else { "s" }
        ));
    }
    format!(
        "Helcim payment review required before Z-close: {}. Resolve in the checkout or Payments Health so the Z report includes every card outcome.",
        parts.join(", ")
    )
}

fn normalize_helcim_close_review_action(value: &str) -> Result<String, SessionError> {
    match value.trim() {
        "reviewed"
        | "resolved_no_action"
        | "provider_charge_confirmed"
        | "duplicate_suspected"
        | "refund_required" => Ok(value.trim().to_string()),
        _ => Err(SessionError::InvalidPayload(
            "Unsupported card review action.".to_string(),
        )),
    }
}

async fn post_helcim_close_review(
    State(state): State<AppState>,
    Path((session_id, attempt_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(payload): Json<HelcimCloseReviewRequest>,
) -> Result<Json<serde_json::Value>, SessionError> {
    let auth = middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_session_gate_err)?;
    let authenticated_staff_id = match auth {
        middleware::StaffOrPosSession::Staff(staff) => Some(staff.id),
        middleware::StaffOrPosSession::PosSession {
            session_id: auth_session_id,
        } => {
            if auth_session_id != session_id {
                return Err(SessionError::InvalidPayload(
                    "Card review session does not match this register.".to_string(),
                ));
            }
            None
        }
    };

    let action = normalize_helcim_close_review_action(&payload.action)?;
    let note = payload
        .note
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if action != "reviewed" && note.is_none() {
        return Err(SessionError::InvalidPayload(
            "A note is required for this card review outcome.".to_string(),
        ));
    }

    #[derive(FromRow)]
    struct AttemptCtx {
        opened_by: Uuid,
        shift_primary_staff_id: Option<Uuid>,
    }

    let ctx: Option<AttemptCtx> = sqlx::query_as(
        r#"
        SELECT rs.opened_by, rs.shift_primary_staff_id
        FROM payment_provider_attempts ppa
        INNER JOIN register_sessions rs ON rs.id = ppa.register_session_id
        INNER JOIN register_sessions requested
            ON requested.till_close_group_id = rs.till_close_group_id
        WHERE ppa.id = $1
          AND ppa.provider = 'helcim'
          AND requested.id = $2
          AND requested.is_open = true
          AND rs.is_open = true
        "#,
    )
    .bind(attempt_id)
    .bind(session_id)
    .fetch_optional(&state.db)
    .await?;

    let Some(ctx) = ctx else {
        return Err(SessionError::InvalidPayload(
            "Card review item is not attached to this open till group.".to_string(),
        ));
    };

    let actor_staff_id = authenticated_staff_id
        .or(ctx.shift_primary_staff_id)
        .unwrap_or(ctx.opened_by);

    sqlx::query(
        r#"
        INSERT INTO helcim_terminal_recovery_actions (
            source_kind,
            source_id,
            action,
            note,
            actor_staff_id,
            metadata
        )
        VALUES ('payment_provider_attempt', $1, $2, $3, $4, $5)
        "#,
    )
    .bind(attempt_id)
    .bind(&action)
    .bind(note.as_deref())
    .bind(actor_staff_id)
    .bind(json!({
        "source": "pos_z_close",
        "register_session_id": session_id,
    }))
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "status": "recorded" })))
}

async fn build_reconciliation(
    db: &sqlx::PgPool,
    session_id: Uuid,
    report_type: &'static str,
) -> Result<ReconciliationResponse, SessionError> {
    let z_group = report_type == "z_report";

    let (drawer_session_id, payment_session_ids, response_session_id) = if z_group {
        let meta: Option<(Uuid, i16)> = sqlx::query_as(
            r#"
            SELECT till_close_group_id, register_lane
            FROM register_sessions
            WHERE id = $1 AND is_open = true
            "#,
        )
        .bind(session_id)
        .fetch_optional(db)
        .await?;

        let Some((till_gid, _lane)) = meta else {
            return Err(SessionError::SessionNotFound);
        };

        let group_rows: Vec<(Uuid, i16)> = sqlx::query_as(
            r#"
            SELECT id, register_lane
            FROM register_sessions
            WHERE till_close_group_id = $1 AND is_open = true
            ORDER BY register_lane ASC
            "#,
        )
        .bind(till_gid)
        .fetch_all(db)
        .await?;

        let primary_id = group_rows.iter().find(|(_, l)| *l == 1).map(|(id, _)| *id);
        let Some(primary_id) = primary_id else {
            return Err(SessionError::InvalidPayload(
                "till shift has no Register lane 1 session; open Register #1 first".to_string(),
            ));
        };

        let ids: Vec<Uuid> = group_rows.into_iter().map(|(id, _)| id).collect();
        (primary_id, ids, primary_id)
    } else {
        let ok: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM register_sessions WHERE id = $1 AND is_open = true)",
        )
        .bind(session_id)
        .fetch_one(db)
        .await?;
        if !ok {
            return Err(SessionError::SessionNotFound);
        }
        (session_id, vec![session_id], session_id)
    };

    let opening_float: Option<Decimal> = sqlx::query_scalar(
        r#"
        SELECT opening_float
        FROM register_sessions
        WHERE id = $1 AND is_open = true
        "#,
    )
    .bind(drawer_session_id)
    .fetch_optional(db)
    .await?;

    let opening_float = opening_float.ok_or(SessionError::SessionNotFound)?;

    let (paid_in, paid_out): (Decimal, Decimal) = sqlx::query_as(
        r#"
        SELECT
            COALESCE(SUM(amount) FILTER (WHERE direction = 'paid_in'), 0)::numeric,
            COALESCE(SUM(amount) FILTER (WHERE direction = 'paid_out'), 0)::numeric
        FROM register_cash_adjustments
        WHERE session_id = $1
        "#,
    )
    .bind(drawer_session_id)
    .fetch_one(db)
    .await?;

    let net_cash_adjustments = paid_in - paid_out;

    let tender_rows: Vec<TenderAggregateRow> = sqlx::query_as(
        r#"
        SELECT
            payment_method,
            SUM(amount) AS total_amount,
            COUNT(*)::bigint AS tx_count
        FROM payment_transactions
        WHERE session_id = ANY($1)
        GROUP BY payment_method
        ORDER BY payment_method
        "#,
    )
    .bind(&payment_session_ids)
    .fetch_all(db)
    .await?;

    let lane_tender_rows: Vec<LaneTenderAggRow> = sqlx::query_as(
        r#"
        SELECT
            rs.register_lane,
            pt.payment_method,
            SUM(pt.amount) AS total_amount,
            COUNT(*)::bigint AS tx_count
        FROM payment_transactions pt
        INNER JOIN register_sessions rs ON rs.id = pt.session_id
        WHERE pt.session_id = ANY($1)
        GROUP BY rs.register_lane, pt.payment_method
        ORDER BY rs.register_lane, pt.payment_method
        "#,
    )
    .bind(&payment_session_ids)
    .fetch_all(db)
    .await?;

    let tenders_by_lane = tenders_by_lane_from_agg(lane_tender_rows);

    let total_cash_sales: Decimal = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(amount), 0)
        FROM payment_transactions
        WHERE session_id = ANY($1) AND payment_method = 'cash'
        "#,
    )
    .bind(&payment_session_ids)
    .fetch_one(db)
    .await?;

    let tenders: Vec<TenderTotal> = tender_rows
        .into_iter()
        .map(|t| TenderTotal {
            payment_method: t.payment_method,
            total_amount: t.total_amount.unwrap_or(Decimal::ZERO),
            tx_count: t.tx_count.unwrap_or(0),
        })
        .collect();

    let cash_adjustments: Vec<CashAdjustmentLine> = sqlx::query_as(
        r#"
        SELECT id, direction, amount, category, reason, created_at
        FROM register_cash_adjustments
        WHERE session_id = $1
        ORDER BY created_at DESC
        LIMIT 100
        "#,
    )
    .bind(drawer_session_id)
    .fetch_all(db)
    .await?;

    let manual_drawer_opens: Vec<ManualDrawerOpenLine> = sqlx::query_as(
        r#"
        SELECT
            e.id,
            e.staff_id,
            COALESCE(NULLIF(TRIM(s.full_name), ''), s.cashier_code, 'Staff') AS staff_name,
            e.reason,
            e.created_at
        FROM register_drawer_open_events e
        INNER JOIN staff s ON s.id = e.staff_id
        WHERE e.session_id = $1
        ORDER BY e.created_at DESC
        LIMIT 100
        "#,
    )
    .bind(drawer_session_id)
    .fetch_all(db)
    .await?;

    let override_summary: Vec<OverrideSummaryRow> = sqlx::query_as(
        r#"
        SELECT
            COALESCE(NULLIF(TRIM(oi.size_specs->>'price_override_reason'), ''), '(unset)') AS reason,
            COUNT(*)::bigint AS line_count,
            COALESCE(
                SUM(
                    (
                        COALESCE((oi.size_specs->>'original_unit_price')::numeric, 0)
                        - COALESCE((oi.size_specs->>'overridden_unit_price')::numeric, 0)
                    ) * oi.quantity::numeric
                ),
                0
            )::numeric(14, 2) AS total_delta
        FROM payment_transactions pt
        INNER JOIN payment_allocations pa ON pa.transaction_id = pt.id
        INNER JOIN transaction_lines oi ON oi.transaction_id = pa.target_transaction_id
        WHERE pt.session_id = ANY($1)
          AND oi.size_specs ? 'price_override_reason'
        GROUP BY 1
        ORDER BY line_count DESC
        LIMIT 50
        "#,
    )
    .bind(&payment_session_ids)
    .fetch_all(db)
    .await?;

    let tx_rows: Vec<TransactionLineRow> = sqlx::query_as(
        r#"
        SELECT
            pt.id AS payment_transaction_id,
            pt.session_id AS register_session_id,
            rs.register_lane,
            pt.created_at,
            pt.payment_method,
            pt.amount,
            pt.check_number,
            pa.target_transaction_id AS ledger_transaction_id,
            o.display_id AS transaction_display_id,
            o.status::text AS transaction_status,
            o.total_price AS transaction_total,
            o.amount_paid AS transaction_paid,
            o.balance_due AS transaction_balance_due,
            COALESCE(
                NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''),
                'Walk-in'
            ) AS customer_name,
            COALESCE(
                jsonb_agg(
                    DISTINCT jsonb_build_object(
                        'name', COALESCE(NULLIF(TRIM(p.name), ''), pv.sku, 'Item'),
                        'sku', COALESCE(pv.sku, ''),
                        'quantity', oi.quantity,
                        'unit_price', oi.unit_price::text,
                        'original_unit_price', oi.size_specs ->> 'original_unit_price',
                        'overridden_unit_price', oi.size_specs ->> 'overridden_unit_price',
                        'fulfillment', oi.fulfillment::text,
                        'is_internal', COALESCE(oi.is_internal, false),
                        'line_kind', p.pos_line_kind::text
                    )
                ) FILTER (WHERE oi.id IS NOT NULL),
                '[]'::jsonb
            ) AS items_json,
            COALESCE(
                ARRAY_REMOVE(
                    ARRAY_AGG(DISTINCT (oi.size_specs ->> 'price_override_reason'))
                        FILTER (WHERE oi.size_specs ? 'price_override_reason'),
                    NULL
                ),
                ARRAY[]::text[]
            ) AS override_reasons,
            COALESCE(
                jsonb_agg(
                    DISTINCT jsonb_build_object(
                        'reason', oi.size_specs ->> 'price_override_reason',
                        'original_unit_price', oi.size_specs ->> 'original_unit_price',
                        'overridden_unit_price', oi.size_specs ->> 'overridden_unit_price',
                        'delta_amount',
                            CASE
                                WHEN (oi.size_specs ->> 'original_unit_price') IS NOT NULL
                                     AND (oi.size_specs ->> 'overridden_unit_price') IS NOT NULL
                                THEN (
                                    ((oi.size_specs ->> 'original_unit_price')::numeric) -
                                    ((oi.size_specs ->> 'overridden_unit_price')::numeric)
                                )::text
                                ELSE NULL
                            END
                    )
                ) FILTER (WHERE oi.size_specs ? 'price_override_reason'),
                '[]'::jsonb
            ) AS override_details_json
        FROM payment_transactions pt
        INNER JOIN register_sessions rs ON rs.id = pt.session_id
        LEFT JOIN payment_allocations pa ON pa.transaction_id = pt.id
        LEFT JOIN transactions o ON o.id = pa.target_transaction_id
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN transaction_lines oi ON oi.transaction_id = o.id
        LEFT JOIN products p ON p.id = oi.product_id
        LEFT JOIN product_variants pv ON pv.id = oi.variant_id
        WHERE pt.session_id = ANY($1)
        GROUP BY
            pt.id, pt.session_id, rs.register_lane, pt.created_at, pt.payment_method, pt.amount,
            pt.check_number,
            pa.target_transaction_id, o.display_id, o.status, o.total_price, o.amount_paid,
            o.balance_due, c.first_name, c.last_name
        ORDER BY pt.created_at DESC
        LIMIT 300
        "#,
    )
    .bind(&payment_session_ids)
    .fetch_all(db)
    .await?;

    let transactions = tx_rows
        .into_iter()
        .map(|row| TransactionLine {
            payment_transaction_id: row.payment_transaction_id,
            register_session_id: row.register_session_id,
            register_lane: row.register_lane,
            created_at: row.created_at,
            payment_method: row.payment_method,
            amount: row.amount,
            check_number: row.check_number,
            ledger_transaction_id: row.ledger_transaction_id,
            transaction_display_id: row.transaction_display_id,
            transaction_status: row.transaction_status,
            transaction_total: row.transaction_total,
            transaction_paid: row.transaction_paid,
            transaction_balance_due: row.transaction_balance_due,
            customer_name: row.customer_name,
            items: parse_transaction_audit_items(row.items_json),
            override_reasons: row.override_reasons,
            override_details: parse_override_details(row.override_details_json),
        })
        .collect();

    let total_rounding_adjustments: Decimal = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(agg.rounding_adjustment), 0)
        FROM (
            SELECT DISTINCT t.id, t.rounding_adjustment
            FROM transactions t
            INNER JOIN payment_allocations pa ON pa.target_transaction_id = t.id
            INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
            WHERE pt.session_id = ANY($1) AND pt.payment_method = 'cash' AND t.rounding_adjustment IS NOT NULL
        ) agg
        "#,
    )
    .bind(&payment_session_ids)
    .fetch_one(db)
    .await?;

    let expected_cash = opening_float + total_cash_sales + net_cash_adjustments;
    let unresolved_helcim_attempts =
        unresolved_helcim_attempts_for_sessions(db, &payment_session_ids).await?;
    let qbo_activity_date =
        crate::logic::register_day_activity::store_local_date_for_utc(db, Utc::now()).await?;
    let inventory_activity: Vec<InventoryActivityLine> = sqlx::query_as(
        r#"
        SELECT
            it.id,
            it.created_at,
            it.tx_type::text AS tx_type,
            COALESCE(NULLIF(TRIM(pv.sku), ''), 'SKU') AS sku,
            COALESCE(NULLIF(TRIM(p.name), ''), pv.sku, 'Item') AS product_name,
            c.name AS category_name,
            it.quantity_delta,
            it.unit_cost,
            ROUND(
                (COALESCE(it.unit_cost, 0) * it.quantity_delta::numeric),
                2
            )::numeric AS value_delta,
            it.reference_table,
            it.reference_id,
            it.notes,
            COALESCE(NULLIF(TRIM(s.full_name), ''), s.cashier_code) AS staff_name
        FROM inventory_transactions it
        INNER JOIN product_variants pv ON pv.id = it.variant_id
        INNER JOIN products p ON p.id = pv.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN staff s ON s.id = it.created_by
        WHERE (it.created_at AT TIME ZONE reporting.effective_store_timezone())::date = $1::date
          AND it.tx_type::text IN (
              'po_receipt',
              'adjustment',
              'damaged',
              'return_to_vendor',
              'physical_inventory'
          )
        ORDER BY it.created_at DESC, it.id DESC
        LIMIT 300
        "#,
    )
    .bind(qbo_activity_date)
    .fetch_all(db)
    .await?;
    let (qbo_journal, qbo_journal_error) =
        match crate::logic::qbo_journal::propose_daily_journal(db, qbo_activity_date).await {
            Ok(proposal) => (Some(proposal), None),
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    activity_date = %qbo_activity_date,
                    "QBO journal proposal unavailable for Z-report preview"
                );
                (None, Some(error.to_string()))
            }
        };

    Ok(ReconciliationResponse {
        report_type,
        session_id: response_session_id,
        qbo_activity_date,
        qbo_journal,
        qbo_journal_error,
        opening_float,
        net_cash_adjustments,
        total_rounding_adjustments,
        expected_cash,
        tenders,
        tenders_by_lane,
        cash_adjustments,
        manual_drawer_opens,
        override_summary,
        transactions,
        inventory_activity,
        unresolved_helcim_attempts,
    })
}

async fn post_cash_adjustment(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CashAdjustmentRequest>,
) -> Result<Json<serde_json::Value>, SessionError> {
    middleware::require_pos_session_secret_or_permission(
        &state,
        &headers,
        session_id,
        REGISTER_OPEN_DRAWER,
    )
    .await
    .map_err(map_session_gate_err)?;
    let dir = body.direction.trim().to_lowercase();
    if dir != "paid_in" && dir != "paid_out" {
        return Err(SessionError::InvalidPayload(
            "direction must be paid_in or paid_out".to_string(),
        ));
    }
    if body.amount <= Decimal::ZERO {
        return Err(SessionError::InvalidPayload(
            "amount must be positive".to_string(),
        ));
    }
    let reason = body.reason.trim();
    if reason.is_empty() {
        return Err(SessionError::InvalidPayload(
            "reason is required".to_string(),
        ));
    }
    let cat = body
        .category
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut tx = state.db.begin().await.map_err(SessionError::Database)?;

    let drawer_lane: i16 = sqlx::query_scalar(
        r#"
        SELECT register_lane
        FROM register_sessions
        WHERE id = $1 AND is_open = true AND lifecycle_status = 'open'
        FOR UPDATE
        "#,
    )
    .bind(session_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(SessionError::SessionNotFound)?;

    if drawer_lane != 1 {
        return Err(SessionError::InvalidPayload(
            "paid in/out must be recorded on Register #1 (cash drawer)".to_string(),
        ));
    }

    sqlx::query(
        r#"
        INSERT INTO register_cash_adjustments (session_id, direction, amount, category, reason)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(session_id)
    .bind(&dir)
    .bind(body.amount)
    .bind(cat)
    .bind(reason)
    .execute(&mut *tx)
    .await?;

    tx.commit().await.map_err(SessionError::Database)?;

    Ok(Json(json!({ "status": "recorded" })))
}

async fn post_manual_drawer_open(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    Json(body): Json<ManualDrawerOpenRequest>,
) -> Result<Json<serde_json::Value>, SessionError> {
    let code = body.cashier_code.trim();
    let pin = body.pin.trim();
    if !is_valid_staff_credential(code) || !is_valid_staff_credential(pin) {
        return Err(SessionError::NotAuthorized(
            "Invalid staff identity or Access PIN".to_string(),
        ));
    }

    let reason = body.reason.trim();
    if reason.is_empty() {
        return Err(SessionError::InvalidPayload(
            "reason is required".to_string(),
        ));
    }

    let staff = pins::authenticate_pos_staff(&state.db, code, Some(pin))
        .await
        .map_err(|_| SessionError::NotAuthorized("Invalid Access PIN".to_string()))?;

    let mut tx = state.db.begin().await.map_err(SessionError::Database)?;

    let drawer_lane: i16 = sqlx::query_scalar(
        r#"
        SELECT register_lane
        FROM register_sessions
        WHERE id = $1 AND is_open = true AND lifecycle_status = 'open'
        FOR UPDATE
        "#,
    )
    .bind(session_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(SessionError::SessionNotFound)?;

    if drawer_lane != 1 {
        return Err(SessionError::InvalidPayload(
            "manual drawer opens must be recorded on Register #1 (cash drawer)".to_string(),
        ));
    }

    sqlx::query(
        r#"
        INSERT INTO register_drawer_open_events (session_id, staff_id, reason)
        VALUES ($1, $2, $3)
        "#,
    )
    .bind(session_id)
    .bind(staff.id)
    .bind(reason)
    .execute(&mut *tx)
    .await?;

    tx.commit().await.map_err(SessionError::Database)?;

    let _ = log_staff_access(
        &state.db,
        staff.id,
        "register_manual_drawer_open",
        json!({ "session_id": session_id, "reason": reason }),
    )
    .await;

    Ok(Json(json!({
        "status": "recorded",
        "staff_id": staff.id,
        "staff_name": staff.full_name,
    })))
}

async fn begin_reconcile(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<BeginReconcileRequest>,
) -> Result<Json<serde_json::Value>, SessionError> {
    middleware::require_pos_session_secret_or_permission(
        &state,
        &headers,
        session_id,
        REGISTER_REPORTS,
    )
    .await
    .map_err(map_session_gate_err)?;

    let lane: i16 = sqlx::query_scalar(
        r#"SELECT register_lane FROM register_sessions WHERE id = $1 AND is_open = true"#,
    )
    .bind(session_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(SessionError::SessionNotFound)?;

    if lane != 1 {
        return Err(SessionError::InvalidPayload(
            "begin Z reconciliation from Register #1 (cash drawer) only".to_string(),
        ));
    }

    let till_gid: Uuid = sqlx::query_scalar(
        r#"SELECT till_close_group_id FROM register_sessions WHERE id = $1 AND is_open = true"#,
    )
    .bind(session_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(SessionError::SessionNotFound)?;

    if !body.active {
        sqlx::query(
            r#"
            UPDATE register_sessions
            SET lifecycle_status = 'open'
            WHERE till_close_group_id = $1 AND is_open = true AND lifecycle_status = 'reconciling'
            "#,
        )
        .bind(till_gid)
        .execute(&state.db)
        .await?;
        return Ok(Json(json!({ "status": "open" })));
    }

    // Require a valid cashier code to prevent unauthenticated session state changes.
    let code = body.cashier_code.trim();
    pins::authenticate_pos_staff(&state.db, code, None)
        .await
        .map_err(|_| SessionError::InvalidCashier(code.to_string()))?;

    let res = sqlx::query(
        r#"
        UPDATE register_sessions
        SET lifecycle_status = 'reconciling'
        WHERE till_close_group_id = $1 AND is_open = true AND lifecycle_status = 'open'
        "#,
    )
    .bind(till_gid)
    .execute(&state.db)
    .await?;

    if res.rows_affected() == 0 {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM register_sessions WHERE id = $1 AND is_open = true)",
        )
        .bind(session_id)
        .fetch_one(&state.db)
        .await?;
        if !exists {
            return Err(SessionError::SessionNotFound);
        }
    }

    Ok(Json(json!({ "status": "reconciling" })))
}

fn parse_override_details(value: serde_json::Value) -> Vec<OverrideDetail> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let reason = item
                .get("reason")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned)?;

            let parse_decimal = |key: &str| -> Option<Decimal> {
                item.get(key)
                    .and_then(|v| v.as_str())
                    .and_then(|s| Decimal::from_str(s).ok())
            };

            Some(OverrideDetail {
                reason,
                original_unit_price: parse_decimal("original_unit_price"),
                overridden_unit_price: parse_decimal("overridden_unit_price"),
                delta_amount: parse_decimal("delta_amount"),
            })
        })
        .collect()
}

fn parse_transaction_audit_items(value: serde_json::Value) -> Vec<TransactionAuditItem> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };

    items
        .iter()
        .map(|item| {
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("Item")
                .to_string();
            let sku = item
                .get("sku")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            let quantity = item
                .get("quantity")
                .and_then(|v| v.as_i64())
                .and_then(|v| i32::try_from(v).ok())
                .unwrap_or(1);
            let unit_price = item
                .get("unit_price")
                .and_then(|v| v.as_str())
                .and_then(|s| Decimal::from_str(s).ok())
                .unwrap_or(Decimal::ZERO);
            let parse_decimal = |key: &str| -> Option<Decimal> {
                item.get(key)
                    .and_then(|v| v.as_str())
                    .and_then(|s| Decimal::from_str(s).ok())
            };
            let fulfillment = item
                .get("fulfillment")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("takeaway")
                .to_string();
            let is_internal = item
                .get("is_internal")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let line_kind = item
                .get("line_kind")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);

            TransactionAuditItem {
                name,
                sku,
                quantity,
                unit_price,
                original_unit_price: parse_decimal("original_unit_price"),
                overridden_unit_price: parse_decimal("overridden_unit_price"),
                fulfillment,
                is_internal,
                line_kind,
            }
        })
        .collect()
}

async fn close_session(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
    Json(payload): Json<CloseSessionRequest>,
) -> Result<Json<CloseSessionResponse>, SessionError> {
    middleware::require_pos_session_secret_or_permission(
        &state,
        &headers,
        session_id,
        REGISTER_REPORTS,
    )
    .await
    .map_err(map_session_gate_err)?;
    if payload.actual_cash < Decimal::ZERO {
        return Err(SessionError::InvalidPayload(
            "actual_cash cannot be negative".to_string(),
        ));
    }

    let closer_from_headers = try_authenticated_staff_headers(&state, &headers)
        .await
        .map(|s| s.id);

    let weather = crate::logic::weather::fetch_weather_range(
        &state.http_client,
        &state.db,
        Utc::now().date_naive(),
        Utc::now().date_naive(),
    )
    .await
    .into_iter()
    .next();
    let weather_val = serde_json::to_value(weather).unwrap_or(serde_json::Value::Null);

    let mut tx = state.db.begin().await.map_err(SessionError::Database)?;

    #[derive(FromRow)]
    struct CloseClaimRow {
        register_lane: i16,
        till_close_group_id: Uuid,
        opened_by: Uuid,
        shift_primary_staff_id: Option<Uuid>,
    }

    let claim = sqlx::query_as::<_, CloseClaimRow>(
        r#"
        SELECT register_lane, till_close_group_id, opened_by, shift_primary_staff_id
        FROM register_sessions
        WHERE id = $1 AND is_open = true
        FOR UPDATE
        "#,
    )
    .bind(session_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(claim) = claim else {
        let _ = tx.rollback().await;
        return Err(SessionError::SessionAlreadyClosed);
    };

    if claim.register_lane != 1 {
        let _ = tx.rollback().await;
        return Err(SessionError::InvalidPayload(
            "close the till shift from Register #1 only; this closes all linked registers in the shift"
                .to_string(),
        ));
    }

    let till_gid = claim.till_close_group_id;
    let close_actor_id = closer_from_headers
        .or(claim.shift_primary_staff_id)
        .unwrap_or(claim.opened_by);

    let group_ids: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM register_sessions
        WHERE till_close_group_id = $1 AND is_open = true
        ORDER BY register_lane ASC
        FOR UPDATE
        "#,
    )
    .bind(till_gid)
    .fetch_all(&mut *tx)
    .await?;

    let unresolved_helcim_attempts =
        unresolved_helcim_attempts_for_sessions_in_tx(&mut tx, &group_ids).await?;
    if !unresolved_helcim_attempts.is_empty() {
        let _ = tx.rollback().await;
        return Err(SessionError::InvalidPayload(
            unresolved_helcim_close_message(&unresolved_helcim_attempts),
        ));
    }

    let recon = build_reconciliation(&state.db, session_id, "z_report").await?;
    let primary_id = recon.session_id;
    let expected_cash = recon.expected_cash;
    let discrepancy = payload.actual_cash - expected_cash;
    let abs_disc = discrepancy.abs();
    let default_cash_deposit_amount = {
        let counted_less_float = payload.actual_cash - recon.opening_float;
        if counted_less_float < dec!(0.00) {
            dec!(0.00)
        } else {
            counted_less_float
        }
    };
    let cash_deposit_amount = payload
        .cash_deposit_amount
        .unwrap_or(default_cash_deposit_amount);
    if cash_deposit_amount < dec!(0.00) {
        return Err(SessionError::InvalidPayload(
            "cash deposit amount cannot be negative".to_string(),
        ));
    }
    let cash_deposit_date = payload.cash_deposit_date.unwrap_or(recon.qbo_activity_date);

    let notes_trimmed = payload
        .closing_notes
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    if abs_disc > DISCREPANCY_NOTE_THRESHOLD_USD && notes_trimmed.is_none() {
        return Err(SessionError::InvalidPayload(format!(
            "closing notes are required when cash is over or short by more than ${}",
            DISCREPANCY_NOTE_THRESHOLD_USD.normalize()
        )));
    }

    let tenders_by_lane_val =
        serde_json::to_value(&recon.tenders_by_lane).unwrap_or(serde_json::Value::Null);
    let transactions_val =
        serde_json::to_value(&recon.transactions).unwrap_or(serde_json::Value::Null);
    let qbo_journal_val =
        serde_json::to_value(&recon.qbo_journal).unwrap_or(serde_json::Value::Null);
    let inventory_activity_val =
        serde_json::to_value(&recon.inventory_activity).unwrap_or(serde_json::Value::Null);

    let z_snapshot = json!({
        "report_type": "z_report",
        "session_id": primary_id,
        "till_close_group_id": till_gid,
        "closed_session_ids": group_ids,
        "opening_float": recon.opening_float,
        "net_cash_adjustments": recon.net_cash_adjustments,
        "expected_cash": expected_cash,
        "actual_cash": payload.actual_cash,
        "discrepancy": discrepancy,
        "cash_deposit_date": cash_deposit_date,
        "cash_deposit_amount": cash_deposit_amount,
        "tenders": recon.tenders,
        "tenders_by_lane": tenders_by_lane_val,
        "transactions": transactions_val,
        "qbo_activity_date": recon.qbo_activity_date,
        "qbo_journal": qbo_journal_val,
        "qbo_journal_error": recon.qbo_journal_error,
        "inventory_activity": inventory_activity_val,
        "cash_adjustments": recon.cash_adjustments,
        "manual_drawer_opens": recon.manual_drawer_opens,
        "override_summary": recon.override_summary,
        "closing_notes": notes_trimmed,
        "closing_comments": payload.closing_comments.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()),
        "closed_at": Utc::now(),
    });

    let purged_parked_sales = crate::logic::pos_parked_sales::purge_open_parked_for_sessions_in_tx(
        &mut tx,
        &group_ids,
        Some(close_actor_id),
    )
    .await
    .map_err(SessionError::Database)?;

    sqlx::query(
        r#"
        DELETE FROM register_session_station_tokens
        WHERE register_session_id IN (
            SELECT id
            FROM register_sessions
            WHERE till_close_group_id = $1 AND is_open = true
        )
        "#,
    )
    .bind(till_gid)
    .execute(&mut *tx)
    .await
    .map_err(SessionError::Database)?;

    let result = sqlx::query(
        r#"
        UPDATE register_sessions
        SET
            is_open = false,
            closed_at = CURRENT_TIMESTAMP,
            pos_api_token = NULL,
            expected_cash = $1,
            actual_cash = $2,
            discrepancy = $3,
            cash_over_short = $3,
            closing_notes = $4,
            closing_comments = $5,
            weather_snapshot = $6,
            z_report_json = $7,
            cash_deposit_date = $8,
            cash_deposit_amount = $9,
            lifecycle_status = 'closed'
        WHERE till_close_group_id = $10 AND is_open = true
        "#,
    )
    .bind(expected_cash)
    .bind(payload.actual_cash)
    .bind(discrepancy)
    .bind(notes_trimmed)
    .bind(payload.closing_comments.as_ref().map(|s| s.trim()))
    .bind(weather_val)
    .bind(&z_snapshot)
    .bind(cash_deposit_date)
    .bind(cash_deposit_amount)
    .bind(till_gid)
    .execute(&mut *tx)
    .await?;

    if result.rows_affected() == 0 {
        let _ = tx.rollback().await;
        return Err(SessionError::SessionAlreadyClosed);
    }

    tx.commit().await.map_err(SessionError::Database)?;

    let snapshot_pool = state.db.clone();
    let snapshot_till = till_gid;
    let snapshot_primary = primary_id;
    tokio::spawn(async move {
        let closed = Utc::now();
        let local_date = match crate::logic::register_day_activity::store_local_date_for_utc(
            &snapshot_pool,
            closed,
        )
        .await
        {
            Ok(d) => d,
            Err(e) => {
                tracing::error!(error = %e, "register EOD snapshot: store_local_date");
                let _ = crate::logic::notifications::broadcast_system_alert(
                    &snapshot_pool,
                    &format!("Register Z-close failed to resolve business date: {e}. Daily snapshot and QBO journal may be delayed."),
                ).await;
                return;
            }
        };
        match crate::logic::register_day_activity::fetch_register_day_summary(
            &snapshot_pool,
            None,
            Some(local_date),
            Some(local_date),
            None,
            crate::logic::report_basis::ReportBasis::Booked,
        )
        .await
        {
            Ok(mut summary) => {
                summary.from_eod_snapshot = false;
                if let Err(e) = crate::logic::register_day_activity::save_eod_snapshot(
                    &snapshot_pool,
                    local_date,
                    snapshot_till,
                    snapshot_primary,
                    &summary,
                )
                .await
                {
                    tracing::error!(error = %e, "register EOD snapshot: save");
                    let _ = crate::logic::notifications::broadcast_system_alert(
                        &snapshot_pool,
                        &format!("Register EOD snapshot save failed after Z-close ({local_date}): {e}. Report data may be incomplete."),
                    ).await;
                } else {
                    tracing::info!(
                        store_local_date = %local_date,
                        "register EOD snapshot saved after Z-close"
                    );
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "register EOD snapshot: build summary");
                let _ = crate::logic::notifications::broadcast_system_alert(
                    &snapshot_pool,
                    &format!("Register EOD summary build failed after Z-close ({local_date}): {e}. Report data may be incomplete."),
                ).await;
            }
        }

        match crate::logic::qbo_journal::ensure_pending_daily_journal(&snapshot_pool, local_date)
            .await
        {
            Ok(staging_id) => tracing::info!(
                store_local_date = %local_date,
                qbo_staging_id = %staging_id,
                "QBO pending journal ensured after Z-close"
            ),
            Err(e) => {
                tracing::error!(
                    error = %e,
                    store_local_date = %local_date,
                    "QBO pending journal after Z-close failed"
                );
                let _ = crate::logic::notifications::broadcast_system_alert(
                    &snapshot_pool,
                    &format!("QBO daily journal staging failed after Z-close ({local_date}): {e}. Manual review required."),
                ).await;
            }
        }

        // Auto-send daily financial report after close (if configured)
        crate::api::daily_reports::auto_send_daily_report(&snapshot_pool).await;
    });

    let _ = log_staff_access(
        &state.db,
        close_actor_id,
        "register_close",
        json!({
            "session_id": primary_id,
            "till_close_group_id": till_gid,
            "closed_session_ids": group_ids,
            "discrepancy_amount": discrepancy,
            "actual_cash": payload.actual_cash,
            "expected_cash": expected_cash,
            "purged_parked_sales": purged_parked_sales,
        }),
    )
    .await;

    if discrepancy != Decimal::ZERO {
        let pool = state.db.clone();
        let sid = primary_id;
        let disc_str = discrepancy.normalize().to_string();
        tokio::spawn(async move {
            if let Err(e) =
                crate::logic::notifications::emit_register_cash_discrepancy(&pool, sid, &disc_str)
                    .await
            {
                tracing::error!(error = %e, "emit_register_cash_discrepancy");
            }
        });
    }

    Ok(Json(CloseSessionResponse {
        status: "closed",
        discrepancy,
    }))
}
