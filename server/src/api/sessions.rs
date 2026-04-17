//! Register session API: till open / current session (Z-register Phase 1).

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
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
    /// IANA TZ from `store_settings.receipt_config` — matches receipt / ZPL timestamp formatting.
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
pub struct OverrideSummaryRow {
    pub reason: String,
    pub line_count: i64,
    pub total_delta: Decimal,
}

#[derive(Debug, Serialize)]
pub struct ReconciliationResponse {
    pub report_type: &'static str,
    /// Unique session ID for the reconciliation report.
    pub session_id: Uuid,
    pub opening_float: Decimal,
    pub net_cash_adjustments: Decimal,
    pub expected_cash: Decimal,
    /// All lanes in the till shift (Z) or single lane (X).
    pub tenders: Vec<TenderTotal>,
    /// Per-lane tender breakdown (Z: each open lane; X: one row).
    pub tenders_by_lane: Vec<TendersByLane>,
    pub cash_adjustments: Vec<CashAdjustmentLine>,
    pub override_summary: Vec<OverrideSummaryRow>,
    pub transactions: Vec<TransactionLine>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TransactionLine {
    pub payment_transaction_id: Uuid,
    pub register_session_id: Uuid,
    pub register_lane: i16,
    pub created_at: DateTime<Utc>,
    pub payment_method: String,
    pub amount: Decimal,
    pub ledger_transaction_id: Option<Uuid>,
    pub customer_name: String,
    pub override_reasons: Vec<String>,
    pub override_details: Vec<OverrideDetail>,
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
pub struct CloseSessionRequest {
    pub actual_cash: Decimal,
    pub closing_notes: Option<String>,
    pub closing_comments: Option<String>,
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
    ledger_transaction_id: Option<Uuid>,
    customer_name: String,
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
        .route("/{session_id}/begin-reconcile", post(begin_reconcile))
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
    middleware::require_staff_with_permission(&state, &headers, REGISTER_SESSION_ATTACH)
        .await
        .map_err(map_session_gate_err)?;

    let tok = sqlx::query_scalar::<_, Option<String>>(
        r#"SELECT pos_api_token FROM register_sessions WHERE id = $1 AND is_open = true"#,
    )
    .bind(session_id)
    .fetch_optional(&state.db)
    .await?;

    let Some(Some(token)) = tok else {
        return Err(SessionError::SessionNotFound);
    };
    if token.is_empty() {
        return Err(SessionError::SessionNotFound);
    }

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
    Json(payload): Json<OpenSessionRequest>,
) -> Result<Json<SessionResponse>, SessionError> {
    let lane = payload.register_lane;
    if !(1..=3).contains(&lane) {
        return Err(SessionError::InvalidPayload(
            "register_lane must be 1 (Main), 2 (iPad), or 3 (Back Office)".to_string(),
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
    .await?;

    let receipt_timezone = load_receipt_timezone(&state.db).await;

    // Automatic creation for satellite lanes 2 and 3 when opening lane 1
    if lane == 1 {
        for satellite_lane in [2, 3] {
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
            .await?;
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
    Json(payload): Json<IssuePosTokenRequest>,
) -> Result<Json<IssuePosTokenResponse>, SessionError> {
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

    let token = pos_session::new_pos_api_token();
    let n = sqlx::query(
        r#"
        UPDATE register_sessions
        SET pos_api_token = $1
        WHERE id = $2 AND is_open = true
        "#,
    )
    .bind(&token)
    .bind(session_id)
    .execute(&state.db)
    .await?
    .rows_affected();

    if n == 0 {
        return Err(SessionError::SessionNotFound);
    }

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
            pa.target_transaction_id AS ledger_transaction_id,
            COALESCE(
                NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''),
                'Walk-in'
            ) AS customer_name,
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
        WHERE pt.session_id = ANY($1)
        GROUP BY
            pt.id, pt.session_id, rs.register_lane, pt.created_at, pt.payment_method, pt.amount,
            pa.target_transaction_id, c.first_name, c.last_name
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
            ledger_transaction_id: row.ledger_transaction_id,
            customer_name: row.customer_name,
            override_reasons: row.override_reasons,
            override_details: parse_override_details(row.override_details_json),
        })
        .collect();

    let expected_cash = opening_float + total_cash_sales + net_cash_adjustments;

    Ok(ReconciliationResponse {
        report_type,
        session_id: response_session_id,
        opening_float,
        net_cash_adjustments,
        expected_cash,
        tenders,
        tenders_by_lane,
        cash_adjustments,
        override_summary,
        transactions,
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

    let ok: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM register_sessions WHERE id = $1 AND is_open = true)",
    )
    .bind(session_id)
    .fetch_one(&state.db)
    .await?;

    if !ok {
        return Err(SessionError::SessionNotFound);
    }

    let drawer_lane: i16 = sqlx::query_scalar(
        r#"SELECT register_lane FROM register_sessions WHERE id = $1 AND is_open = true"#,
    )
    .bind(session_id)
    .fetch_optional(&state.db)
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
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "status": "recorded" })))
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

    let close_lane: i16 = sqlx::query_scalar(
        r#"SELECT register_lane FROM register_sessions WHERE id = $1 AND is_open = true"#,
    )
    .bind(session_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(SessionError::SessionAlreadyClosed)?;

    if close_lane != 1 {
        return Err(SessionError::InvalidPayload(
            "close the till shift from Register #1 only; this closes all linked registers in the shift"
                .to_string(),
        ));
    }

    let till_gid: Uuid = sqlx::query_scalar(
        r#"SELECT till_close_group_id FROM register_sessions WHERE id = $1 AND is_open = true"#,
    )
    .bind(session_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(SessionError::SessionAlreadyClosed)?;

    let group_ids: Vec<Uuid> = sqlx::query_scalar(
        r#"SELECT id FROM register_sessions WHERE till_close_group_id = $1 AND is_open = true"#,
    )
    .bind(till_gid)
    .fetch_all(&state.db)
    .await?;

    let recon = build_reconciliation(&state.db, session_id, "z_report").await?;
    let primary_id = recon.session_id;
    let expected_cash = recon.expected_cash;
    let discrepancy = payload.actual_cash - expected_cash;
    let abs_disc = discrepancy.abs();

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
        "tenders": recon.tenders,
        "tenders_by_lane": tenders_by_lane_val,
        "transactions": transactions_val,
        "cash_adjustments": recon.cash_adjustments,
        "override_summary": recon.override_summary,
        "closed_at": Utc::now(),
    });

    #[derive(FromRow)]
    struct SessionCloserRow {
        opened_by: Option<Uuid>,
    }

    let closer = sqlx::query_as::<_, SessionCloserRow>(
        r#"SELECT opened_by FROM register_sessions WHERE id = $1 AND is_open = true"#,
    )
    .bind(primary_id)
    .fetch_optional(&state.db)
    .await?;

    let Some(closer) = closer else {
        return Err(SessionError::SessionAlreadyClosed);
    };

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
            lifecycle_status = 'closed'
        WHERE till_close_group_id = $8 AND is_open = true
        "#,
    )
    .bind(expected_cash)
    .bind(payload.actual_cash)
    .bind(discrepancy)
    .bind(notes_trimmed)
    .bind(payload.closing_comments.as_ref().map(|s| s.trim()))
    .bind(weather_val)
    .bind(&z_snapshot)
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
                } else {
                    tracing::info!(
                        store_local_date = %local_date,
                        "register EOD snapshot saved after Z-close"
                    );
                }
            }
            Err(e) => tracing::error!(error = %e, "register EOD snapshot: build summary"),
        }
    });

    if let Err(e) = crate::logic::pos_parked_sales::purge_open_parked_for_sessions(
        &state.db,
        &group_ids,
        closer.opened_by,
    )
    .await
    {
        tracing::error!(
            error = %e,
            "failed to purge server parked sales after register close"
        );
    }

    if let Some(ob) = closer.opened_by {
        let _ = log_staff_access(
            &state.db,
            ob,
            "register_close",
            json!({
                "session_id": primary_id,
                "till_close_group_id": till_gid,
                "closed_session_ids": group_ids,
                "discrepancy_amount": discrepancy,
                "actual_cash": payload.actual_cash,
                "expected_cash": expected_cash,
            }),
        )
        .await;
    }

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
