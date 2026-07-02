//! Helcim payment provider endpoints.

use crate::api::webhooks;
use crate::auth::permissions::{
    self, staff_has_permission, CUSTOMERS_HUB_EDIT, CUSTOMERS_HUB_VIEW, SETTINGS_ADMIN,
};
use crate::auth::pins::AuthenticatedStaff;
use crate::logic::helcim;
use crate::logic::integration_alerts;
use crate::logic::integration_credentials;
use crate::models::DbStaffRole;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{delete, get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Duration as ChronoDuration, NaiveDate, Utc};
use futures_core::stream::Stream;
use futures_util::stream;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Executor, PgPool, Postgres, Row};
use std::collections::{BTreeMap, BTreeSet};
use std::convert::Infallible;
use std::time::Duration as StdDuration;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::middleware;

const PAYMENTS_RECONCILE: &str = "payments.reconcile";
const PAYMENTS_VIEW: &str = "payments.view";
const PAYMENTS_RECONCILE_REVIEW: &str = "payments.reconcile.review";
const PAYMENTS_RECONCILE_RESOLVE: &str = "payments.reconcile.resolve";
const PAYMENTS_RECONCILE_LINK: &str = "payments.reconcile.link";
const PAYMENTS_DEPOSIT_REVIEW: &str = "payments.deposit.review";
const PAYMENTS_DEPOSIT_LINK: &str = "payments.deposit.link";
const PAYMENTS_DEPOSIT_ADJUST: &str = "payments.deposit.adjust";
const PAYMENTS_SYNC: &str = "payments.sync";
const PAYMENTS_TERMINAL_OVERRIDE: &str = "payments.terminal.override";
const HELCIM_TERMINAL_PENDING_TIMEOUT_MINUTES: i64 = 5;
const HELCIM_ATTEMPT_STREAM_MAX_SECONDS: u16 = 600;

#[derive(Debug, Error)]
pub enum PaymentError {
    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    Conflict(String),
    #[error("Provider API error: {0}")]
    ProviderError(String),
}

fn map_pay_session(e: (StatusCode, axum::Json<serde_json::Value>)) -> PaymentError {
    let (st, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match st {
        StatusCode::UNAUTHORIZED => PaymentError::Unauthorized(msg),
        StatusCode::FORBIDDEN => PaymentError::Forbidden(msg),
        _ => PaymentError::InvalidPayload(msg),
    }
}

fn map_credential_error(e: integration_credentials::IntegrationCredentialError) -> PaymentError {
    match e {
        integration_credentials::IntegrationCredentialError::Database(e) => {
            PaymentError::InvalidPayload(e.to_string())
        }
        integration_credentials::IntegrationCredentialError::InvalidPayload(message) => {
            PaymentError::InvalidPayload(message)
        }
    }
}

async fn require_payment_permission(
    state: &AppState,
    headers: &HeaderMap,
    permission: &'static str,
) -> Result<AuthenticatedStaff, PaymentError> {
    require_payment_permission_any(state, headers, permission, &[]).await
}

async fn require_payment_permission_any(
    state: &AppState,
    headers: &HeaderMap,
    permission: &'static str,
    fallback_permissions: &'static [&'static str],
) -> Result<AuthenticatedStaff, PaymentError> {
    let staff = middleware::require_authenticated_staff_headers(state, headers)
        .await
        .map_err(map_pay_session)?;
    let effective = permissions::effective_permissions_for_staff(&state.db, staff.id, staff.role)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "payments permission resolution failed");
            PaymentError::InvalidPayload("permission resolution failed".to_string())
        })?;
    let permitted = staff.role == DbStaffRole::Admin
        || staff_has_permission(&effective, permission)
        || fallback_permissions
            .iter()
            .any(|fallback| staff_has_permission(&effective, fallback));

    tracing::debug!(
        staff_id = %staff.id,
        staff_name = %staff.full_name,
        staff_role = ?staff.role,
        requested_permission = %permission,
        fallback_permissions = ?fallback_permissions,
        permitted = %permitted,
        "Payments permission check"
    );

    if !permitted {
        return Err(PaymentError::Forbidden(format!(
            "missing permission: {permission}"
        )));
    }
    Ok(staff)
}

async fn require_payment_permission_or_pos_staff(
    state: &AppState,
    headers: &HeaderMap,
    permission: &'static str,
    fallback_permissions: &'static [&'static str],
) -> Result<Option<AuthenticatedStaff>, PaymentError> {
    match require_payment_permission_any(state, headers, permission, fallback_permissions).await {
        Ok(staff) => Ok(Some(staff)),
        Err(permission_error) => {
            if !matches!(
                &permission_error,
                PaymentError::Forbidden(_) | PaymentError::Unauthorized(_)
            ) {
                return Err(permission_error);
            }
            match middleware::require_staff_or_pos_register_session(state, headers).await {
                Ok(middleware::StaffOrPosSession::Staff(staff)) => Ok(Some(staff)),
                Ok(middleware::StaffOrPosSession::PosSession { .. }) => {
                    tracing::info!(
                        requested_permission = %permission,
                        fallback_permissions = ?fallback_permissions,
                        "Payments POS staff fallback authorized"
                    );
                    Ok(None)
                }
                Err(_) => Err(permission_error),
            }
        }
    }
}

impl IntoResponse for PaymentError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            PaymentError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            PaymentError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            PaymentError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            PaymentError::Conflict(m) => (StatusCode::CONFLICT, m),
            PaymentError::ProviderError(e) => {
                let staff_message = staff_safe_provider_error(&e);
                tracing::error!(error = %staff_message, "Provider error in payments");
                (StatusCode::BAD_GATEWAY, staff_message)
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

fn staff_safe_provider_error(message: &str) -> String {
    let redacted = helcim::redact_provider_text(message);
    if redacted.trim().is_empty() {
        return "Payment provider request failed.".to_string();
    }
    redacted.chars().take(1000).collect()
}

fn persisted_provider_error(message: &str) -> String {
    helcim::redact_provider_text(message)
        .chars()
        .take(500)
        .collect()
}

fn helcim_terminal_purchase_error(
    status: reqwest::StatusCode,
    raw_text: &str,
    is_html: bool,
) -> PaymentError {
    if status == reqwest::StatusCode::CONFLICT {
        let mut message = helcim_terminal_not_listening_message(raw_text).unwrap_or_else(|| {
            "Helcim reported a terminal conflict. Check the terminal for an active payment, cancel on the terminal if needed, then use Check status before retrying.".to_string()
        });
        if !is_html {
            let detail = staff_safe_provider_error(raw_text);
            if !detail.trim().is_empty() {
                message.push_str(" Provider detail: ");
                message.push_str(&detail);
            }
        }
        return PaymentError::Conflict(message);
    }

    let error_hint = if is_html {
        " (received HTML response; check your API base URL or WAF/IP settings)"
    } else {
        ""
    };
    let mut message = format!("Helcim returned HTTP {}{error_hint}", status.as_u16());
    if !is_html {
        let detail = staff_safe_provider_error(raw_text);
        if !detail.trim().is_empty() {
            message.push_str(": ");
            message.push_str(&detail);
        }
    }
    PaymentError::ProviderError(message)
}

fn helcim_terminal_not_listening_message(raw_text: &str) -> Option<String> {
    for provider_message in helcim_provider_error_messages(raw_text) {
        let lower = provider_message.to_ascii_lowercase();
        if !lower.contains("not listening") {
            continue;
        }

        let device_code = extract_helcim_device_code(&provider_message);
        let terminal_label = device_code
            .as_deref()
            .map(|code| format!(" {code}"))
            .unwrap_or_default();
        return Some(format!(
            "Helcim terminal{terminal_label} is not listening. Wake the terminal, open or restart the Helcim app, confirm it is connected and signed in, then retry the payment. If this is the wrong terminal, update the Helcim terminal code in Settings."
        ));
    }
    None
}

fn helcim_provider_error_messages(raw_text: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<Value>(raw_text.trim()) else {
        return vec![raw_text.trim().to_string()];
    };

    let mut messages = Vec::new();
    if let Some(message) = value.get("message").and_then(Value::as_str) {
        messages.push(message.to_string());
    }
    if let Some(errors) = value.get("errors").and_then(Value::as_array) {
        messages.extend(errors.iter().filter_map(Value::as_str).map(str::to_string));
    }
    messages
}

fn extract_helcim_device_code(message: &str) -> Option<String> {
    let lower = message.to_ascii_lowercase();
    let prefix = "device with code ";
    let suffix = " not listening";
    let start = lower.find(prefix)? + prefix.len();
    let end = lower[start..].find(suffix)? + start;
    let code = message.get(start..end)?.trim();
    if code.is_empty() {
        None
    } else {
        Some(code.to_string())
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/config", get(get_payments_config))
        .route(
            "/providers/active",
            get(get_active_card_provider).patch(patch_active_card_provider),
        )
        .route("/providers/helcim/status", get(get_helcim_provider_status))
        .route("/providers/helcim/health", get(get_helcim_health))
        .route("/providers/helcim/config", patch(patch_helcim_config))
        .route("/providers/helcim/fees/status", get(get_helcim_fee_status))
        .route("/providers/helcim/fees/sync", post(sync_helcim_fees))
        .route(
            "/providers/helcim/settlements/status",
            get(get_helcim_settlement_status),
        )
        .route(
            "/providers/helcim/settlements/sync",
            post(sync_helcim_settlements),
        )
        .route(
            "/providers/helcim/operations/overview",
            get(get_helcim_operations_overview),
        )
        .route("/providers/helcim/batches", get(list_helcim_batches))
        .route(
            "/providers/helcim/batches/{id}",
            get(get_helcim_batch_detail),
        )
        .route(
            "/providers/helcim/batches/{id}/transactions",
            get(list_helcim_batch_transactions),
        )
        .route(
            "/providers/helcim/reconciliation/items",
            get(list_helcim_reconciliation_items),
        )
        .route(
            "/providers/helcim/reconciliation/items/{id}/status",
            patch(patch_helcim_reconciliation_item_status),
        )
        .route(
            "/providers/helcim/reconciliation/items/{id}/notes",
            post(add_helcim_reconciliation_item_note),
        )
        .route(
            "/providers/helcim/reconciliation/items/{id}/candidate-payments",
            get(list_helcim_reconciliation_candidate_payments),
        )
        .route(
            "/providers/helcim/reconciliation/items/{id}/link-payment",
            post(link_helcim_reconciliation_payment),
        )
        .route(
            "/providers/helcim/transactions",
            get(list_helcim_operations_transactions),
        )
        .route(
            "/providers/helcim/transactions/{id}",
            get(get_helcim_operations_transaction_detail),
        )
        .route("/providers/helcim/sync/runs", get(list_helcim_sync_runs))
        .route(
            "/providers/helcim/events/health",
            get(get_helcim_events_health),
        )
        .route(
            "/providers/helcim/events/{id}/replay",
            post(replay_helcim_event),
        )
        .route(
            "/providers/helcim/terminal/recovery-actions",
            post(create_helcim_terminal_recovery_action),
        )
        .route(
            "/providers/helcim/terminal/card-terminals",
            get(list_helcim_card_terminals),
        )
        .route(
            "/providers/helcim/terminal/devices",
            get(list_helcim_devices),
        )
        .route(
            "/providers/helcim/terminal/devices/{code}",
            get(get_helcim_device),
        )
        .route(
            "/providers/helcim/terminal/devices/{code}/ping",
            post(ping_helcim_device),
        )
        .route(
            "/providers/helcim/deposits",
            get(list_helcim_deposits).post(create_helcim_manual_deposit),
        )
        .route(
            "/providers/helcim/deposits/unmatched-batches",
            get(list_helcim_unmatched_deposit_batches),
        )
        .route(
            "/providers/helcim/deposits/unmatched-deposits",
            get(list_helcim_unmatched_deposits),
        )
        .route(
            "/providers/helcim/deposits/reconciliation/runs",
            post(run_helcim_deposit_reconciliation),
        )
        .route(
            "/providers/helcim/deposits/{id}",
            get(get_helcim_deposit_detail),
        )
        .route(
            "/providers/helcim/deposits/{id}/link-batches",
            post(link_helcim_deposit_batches),
        )
        .route(
            "/providers/helcim/deposits/{id}/notes",
            post(add_helcim_deposit_note),
        )
        .route(
            "/providers/helcim/deposits/{id}/review",
            patch(review_helcim_deposit),
        )
        .route(
            "/providers/helcim/deposits/{id}/reopen",
            post(reopen_helcim_deposit),
        )
        .route("/providers/helcim/purchase", post(start_helcim_purchase))
        .route(
            "/providers/helcim/terminal/refund",
            post(start_helcim_terminal_refund),
        )
        .route(
            "/providers/helcim/card-token/purchase",
            post(process_helcim_card_token_purchase),
        )
        .route(
            "/providers/helcim/card/refund",
            post(process_helcim_card_refund),
        )
        .route(
            "/providers/helcim/card/reverse",
            post(process_helcim_card_reverse),
        )
        .route(
            "/providers/helcim/helcim-pay/initialize",
            post(initialize_helcim_pay),
        )
        .route(
            "/providers/helcim/helcim-pay/confirm",
            post(confirm_helcim_pay),
        )
        .route("/providers/helcim/customers", get(list_helcim_customers))
        .route(
            "/providers/helcim/customers/{customer_id}/cards",
            get(list_helcim_customer_cards),
        )
        .route(
            "/providers/helcim/customers/{customer_id}/cards/{card_id}",
            delete(delete_helcim_customer_card),
        )
        .route(
            "/providers/helcim/customers/{customer_id}/cards/{card_id}/default",
            patch(set_helcim_customer_card_default).post(set_helcim_customer_card_default),
        )
        .route("/providers/helcim/attempts/{id}", get(get_helcim_attempt))
        .route(
            "/providers/helcim/attempts/{id}/stream",
            get(stream_helcim_attempt),
        )
        .route(
            "/providers/helcim/attempts/{id}/release",
            post(release_helcim_terminal_attempt),
        )
        .route(
            "/providers/helcim/attempts/{id}/simulate",
            post(simulate_helcim_attempt),
        )
}

#[derive(Debug, Clone, Serialize)]
pub struct ActiveCardProviderResponse {
    pub active_provider: String,
    pub helcim: helcim::HelcimConfigStatus,
    pub helcim_terminal_routing: HelcimTerminalRoutingStatus,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimTerminalRoutingStatus {
    pub terminals: Vec<HelcimTerminalStatus>,
    pub registers: Vec<HelcimRegisterTerminalRoute>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimTerminalStatus {
    pub key: String,
    pub label: String,
    pub configured: bool,
    pub device_code_suffix: Option<String>,
    pub in_use_by_register_lane: Option<i16>,
    pub active_attempt_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelcimRegisterTerminalRoute {
    pub register_lane: i16,
    pub default_terminal_key: Option<String>,
    pub allowed_terminal_keys: Vec<String>,
    pub choice_required: bool,
    pub non_default_override_requires_permission: bool,
}

#[derive(Debug, Deserialize)]
pub struct PatchActiveCardProviderRequest {
    pub active_provider: String,
}

#[derive(Debug, Deserialize)]
pub struct PatchHelcimConfigRequest {
    pub api_token: Option<String>,
    pub terminal_1_device_code: Option<String>,
    pub terminal_2_device_code: Option<String>,
    pub webhook_secret: Option<String>,
    pub api_base_url: Option<String>,
    pub simulator_enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct HelcimPurchaseRequestBody {
    pub amount_cents: i64,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
    #[serde(default)]
    pub selected_terminal_key: Option<String>,
    #[serde(default)]
    pub terminal_override_reason: Option<String>,
    #[serde(default)]
    pub checkout_client_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct HelcimTerminalRefundRequestBody {
    pub amount_cents: i64,
    pub original_transaction_id: i64,
    #[serde(default)]
    pub customer_present_confirmed: bool,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
    #[serde(default)]
    pub selected_terminal_key: Option<String>,
    #[serde(default)]
    pub terminal_override_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HelcimCardTokenPurchaseRequestBody {
    pub amount_cents: i64,
    pub card_token: String,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
    #[serde(default)]
    pub customer_code: Option<String>,
    #[serde(default)]
    pub invoice_number: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HelcimCardRefundRequestBody {
    pub amount_cents: i64,
    pub original_transaction_id: i64,
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HelcimCardReverseRequestBody {
    pub original_transaction_id: i64,
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HelcimPayInitializeRequestBody {
    pub amount_cents: i64,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
    #[serde(default)]
    pub customer_code: Option<String>,
    #[serde(default)]
    pub invoice_number: Option<String>,
    #[serde(default)]
    pub save_as_default: Option<bool>,
    #[serde(default)]
    pub hide_existing_payment_details: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct HelcimPayInitializeResponseBody {
    pub attempt: HelcimAttemptResponse,
    pub checkout_token: String,
}

#[derive(Debug, Deserialize)]
pub struct HelcimPayConfirmRequestBody {
    pub attempt_id: Uuid,
    pub checkout_token: String,
    pub data: Value,
    pub hash: String,
}

#[derive(Debug, Deserialize)]
pub struct HelcimCustomersQuery {
    #[serde(default)]
    pub customer_code: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub include_cards: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct HelcimCustomerCardsQuery {
    #[serde(default)]
    pub card_token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HelcimSimulateAttemptRequest {
    pub outcome: String,
}

#[derive(Debug, Deserialize)]
pub struct HelcimDevicesQuery {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub limit: Option<i32>,
    #[serde(default)]
    pub page: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct HelcimDeviceActionResponse {
    pub status: String,
    pub code: String,
    pub response: Value,
}

#[derive(Debug, Serialize)]
pub struct HelcimFeeStatusResponse {
    pub total_helcim_payments: i64,
    pub fees_synced: i64,
    pub ready_to_sync: i64,
    pub missing_transaction_id: i64,
    pub total_fees: String,
    pub net_amount: String,
}

#[derive(Debug, Serialize)]
pub struct HelcimFeeSyncResponse {
    pub scanned: i64,
    pub updated: i64,
    pub fees_unavailable: i64,
    pub skipped_missing_transaction_id: i64,
    pub errors: i64,
    pub total_fee_synced: String,
    pub total_net_synced: String,
}

#[derive(Debug, Deserialize)]
pub struct HelcimSettlementSyncRequest {
    #[serde(default)]
    pub date_from: Option<NaiveDate>,
    #[serde(default)]
    pub date_to: Option<NaiveDate>,
}

#[derive(Debug, Serialize)]
pub struct HelcimSettlementStatusResponse {
    pub batch_count: i64,
    pub batch_transaction_count: i64,
    pub matched_transaction_count: i64,
    pub unmatched_transaction_count: i64,
    pub open_item_count: i64,
    pub mismatch_count: i64,
    pub api_integration_active: bool,
    pub last_run_at: Option<DateTime<Utc>>,
    pub last_run: Option<HelcimSettlementRunSummary>,
}

#[derive(Debug, Serialize)]
pub struct HelcimSettlementRunSummary {
    pub id: Uuid,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub summary: Value,
    pub error_message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HelcimSettlementSyncResponse {
    pub run_id: Uuid,
    pub status: String,
    pub payments_scanned: i64,
    pub batches_upserted: i64,
    pub batch_transactions_upserted: i64,
    pub reconciliation_items_opened: i64,
    pub missing_batch_rows: i64,
    pub unmatched_processor_rows: i64,
    pub amount_mismatches: i64,
    pub status_mismatches: i64,
    pub fee_mismatches: i64,
    pub net_mismatches: i64,
    pub api_integration_active: bool,
    pub helcim_batches_fetched: i64,
    pub helcim_batch_transactions_fetched: i64,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct HelcimOperationsDateQuery {
    #[serde(default)]
    pub date_from: Option<NaiveDate>,
    #[serde(default)]
    pub date_to: Option<NaiveDate>,
}

#[derive(Debug, Deserialize, Default)]
pub struct HelcimOperationsListQuery {
    #[serde(default)]
    pub date_from: Option<NaiveDate>,
    #[serde(default)]
    pub date_to: Option<NaiveDate>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub item_type: Option<String>,
    #[serde(default)]
    pub batch_id: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub match_status: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct HelcimOperationsOverviewResponse {
    pub card_sales_gross: String,
    pub known_fees: Option<String>,
    pub known_net: Option<String>,
    pub fee_not_ready_count: i64,
    pub net_not_ready_count: i64,
    pub expected_deposit_from_batches: Option<String>,
    pub open_issue_count: i64,
    pub critical_issue_count: i64,
    pub last_settlement_sync: Option<HelcimSettlementRunSummary>,
    pub last_fee_sync: Option<DateTime<Utc>>,
    pub helcim_api_active: bool,
}

#[derive(Debug, Serialize)]
pub struct HelcimBatchListRow {
    pub id: Uuid,
    pub provider_batch_id: String,
    pub status: Option<String>,
    pub closed_at: Option<DateTime<Utc>>,
    pub settled_at: Option<DateTime<Utc>>,
    pub expected_deposit_at: Option<DateTime<Utc>>,
    pub gross_amount: Option<String>,
    pub fee_amount: Option<String>,
    pub net_amount: Option<String>,
    pub transaction_count: Option<i32>,
    pub issue_count: i64,
    pub fee_not_ready_count: i64,
    pub net_not_ready_count: i64,
    pub last_synced_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct HelcimBatchDetailResponse {
    pub batch: HelcimBatchListRow,
    pub critical_issue_count: i64,
    pub warning_issue_count: i64,
    pub info_issue_count: i64,
}

#[derive(Debug, Serialize)]
pub struct HelcimBatchTransactionRow {
    pub id: Uuid,
    pub provider_transaction_id: String,
    pub payment_transaction_id: Option<Uuid>,
    pub amount: Option<String>,
    pub status: Option<String>,
    pub fee_amount: Option<String>,
    pub net_amount: Option<String>,
    pub match_status: String,
    pub match_type: Option<String>,
    pub occurred_at: Option<DateTime<Utc>>,
    pub settled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct HelcimReconciliationItemRow {
    pub id: Uuid,
    pub item_type: String,
    pub issue_label: String,
    pub severity: String,
    pub status: String,
    pub amount: Option<String>,
    pub reference: Option<String>,
    pub provider_batch_id: Option<String>,
    pub provider_transaction_id: Option<String>,
    pub payment_transaction_id: Option<Uuid>,
    pub payment_provider_batch_id: Option<Uuid>,
    pub message: Option<String>,
    pub created_at: DateTime<Utc>,
    pub reviewed_at: Option<DateTime<Utc>>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub resolution_type: Option<String>,
    pub resolution_note: Option<String>,
    pub events: Vec<HelcimReconciliationItemEventRow>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HelcimReconciliationItemEventRow {
    pub id: Uuid,
    pub action: String,
    pub note: Option<String>,
    pub actor_staff_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct HelcimReconciliationStatusRequest {
    pub action: String,
    #[serde(default)]
    pub resolution_type: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HelcimReconciliationNoteRequest {
    pub note: String,
}

#[derive(Debug, Deserialize)]
pub struct HelcimReconciliationLinkRequest {
    pub payment_transaction_id: Uuid,
    pub note: String,
}

#[derive(Debug, Serialize)]
pub struct HelcimReconciliationActionResponse {
    pub item: HelcimReconciliationItemRow,
}

#[derive(Debug, Serialize)]
pub struct HelcimReconciliationCandidatePaymentRow {
    pub payment_transaction_id: Uuid,
    pub provider_transaction_id: Option<String>,
    pub amount: String,
    pub payment_date: DateTime<Utc>,
    pub payment_status: String,
    pub provider_status: Option<String>,
    pub provider_batch_id: Option<String>,
    pub warning_flags: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct HelcimOperationsTransactionRow {
    pub payment_transaction_id: Uuid,
    pub provider_transaction_id: Option<String>,
    pub amount: String,
    pub payment_date: DateTime<Utc>,
    pub payment_status: String,
    pub provider_status: Option<String>,
    pub batch_id: Option<Uuid>,
    pub provider_batch_id: Option<String>,
    pub batch_status: Option<String>,
    pub fee_amount: Option<String>,
    pub net_amount: Option<String>,
    pub fee_status: String,
    pub net_status: String,
    pub match_status: Option<String>,
    pub issue_count: i64,
}

#[derive(Debug, Serialize)]
pub struct HelcimOperationsTransactionDetailResponse {
    pub riverside_payment: Value,
    pub processor_payment: Option<Value>,
    pub batch: Option<Value>,
    pub fee_details: Value,
    pub issues: Vec<HelcimReconciliationItemRow>,
    pub timeline: Vec<HelcimPaymentTimelineRow>,
}

#[derive(Debug, Serialize)]
pub struct HelcimPaymentTimelineRow {
    pub occurred_at: DateTime<Utc>,
    pub label: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct HelcimEventsHealthResponse {
    pub recent_event_count: i64,
    pub failed_event_count: i64,
    pub ignored_event_count: i64,
    pub unmatched_event_count: i64,
    pub last_event_at: Option<DateTime<Utc>>,
    pub last_failed_message: Option<String>,
    pub last_failed_event_id: Option<Uuid>,
    pub webhook_delivery_status: String,
    pub webhook_delivery_label: String,
    pub webhook_delivery_detail: String,
    pub webhook_delivery_action: String,
    pub terminal_review_attempts: Vec<HelcimTerminalReviewAttemptRow>,
    pub terminal_review_events: Vec<HelcimTerminalReviewEventRow>,
}

#[derive(Debug, Serialize)]
pub struct HelcimTerminalReviewAttemptRow {
    pub id: Uuid,
    pub status: String,
    pub amount: String,
    pub currency: String,
    pub register_session_id: Option<Uuid>,
    pub register_lane: Option<i16>,
    pub device_id: Option<String>,
    pub terminal_id: Option<String>,
    pub selected_terminal_key: Option<String>,
    pub provider_payment_id: Option<String>,
    pub provider_transaction_id: Option<String>,
    pub error_message: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub label: String,
    pub detail: String,
    pub recovery_actions: Vec<HelcimTerminalRecoveryActionRow>,
}

#[derive(Debug, Serialize)]
pub struct HelcimTerminalReviewEventRow {
    pub id: Uuid,
    pub event_type: String,
    pub processing_status: String,
    pub received_at: DateTime<Utc>,
    pub error_message: Option<String>,
    pub provider_transaction_id: Option<String>,
    pub payment_provider_attempt_id: Option<Uuid>,
    pub payment_transaction_id: Option<Uuid>,
    pub match_type: Option<String>,
    pub label: String,
    pub detail: String,
    pub recovery_actions: Vec<HelcimTerminalRecoveryActionRow>,
}

#[derive(Debug, Serialize, Clone)]
pub struct HelcimTerminalRecoveryActionRow {
    pub id: Uuid,
    pub source_kind: String,
    pub source_id: Uuid,
    pub action: String,
    pub note: Option<String>,
    pub actor_staff_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub metadata: Value,
}

#[derive(Debug, Deserialize)]
pub struct HelcimTerminalRecoveryActionRequest {
    pub source_kind: String,
    pub source_id: Uuid,
    pub action: String,
    pub note: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Serialize)]
pub struct HelcimTerminalRecoveryActionResponse {
    pub action: HelcimTerminalRecoveryActionRow,
}

#[derive(Debug, Serialize)]
pub struct HelcimDepositRow {
    pub id: Uuid,
    pub source_system: String,
    pub source_reference: Option<String>,
    pub qbo_deposit_id: Option<String>,
    pub bank_feed_transaction_id: Option<String>,
    pub posted_at: DateTime<Utc>,
    pub amount: String,
    pub currency: String,
    pub status: String,
    pub linked_batch_count: i64,
    pub expected_amount: Option<String>,
    pub linked_amount: Option<String>,
    pub difference: Option<String>,
    pub open_issue_count: i64,
    pub reviewed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct HelcimDepositBatchLinkRow {
    pub id: Uuid,
    pub payment_provider_batch_id: Uuid,
    pub provider_batch_id: String,
    pub expected_net_amount: Option<String>,
    pub linked_amount: Option<String>,
    pub match_type: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub batch_status: Option<String>,
    pub expected_deposit_at: Option<DateTime<Utc>>,
    pub settled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HelcimDepositEventRow {
    pub id: Uuid,
    pub action: String,
    pub note: Option<String>,
    pub actor_staff_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct HelcimDepositIssueRow {
    pub id: Uuid,
    pub item_type: String,
    pub issue_label: String,
    pub severity: String,
    pub status: String,
    pub deposit_id: Option<Uuid>,
    pub payment_provider_batch_id: Option<Uuid>,
    pub provider_batch_id: Option<String>,
    pub amount: Option<String>,
    pub reference: Option<String>,
    pub message: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct HelcimDepositDetailResponse {
    pub deposit: HelcimDepositRow,
    pub linked_batches: Vec<HelcimDepositBatchLinkRow>,
    pub events: Vec<HelcimDepositEventRow>,
    pub issues: Vec<HelcimDepositIssueRow>,
}

#[derive(Debug, Deserialize)]
pub struct HelcimManualDepositRequest {
    pub posted_at: DateTime<Utc>,
    pub amount: String,
    #[serde(default)]
    pub source_system: Option<String>,
    #[serde(default)]
    pub source_reference: Option<String>,
    #[serde(default)]
    pub qbo_deposit_id: Option<String>,
    #[serde(default)]
    pub bank_feed_transaction_id: Option<String>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HelcimDepositLinkBatchesRequest {
    pub batch_ids: Vec<Uuid>,
    pub note: String,
}

#[derive(Debug, Deserialize)]
pub struct HelcimDepositNoteRequest {
    pub note: String,
}

#[derive(Debug, Deserialize)]
pub struct HelcimDepositReviewRequest {
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub accept_variance: bool,
}

#[derive(Debug, Serialize)]
pub struct HelcimDepositActionResponse {
    pub deposit: HelcimDepositDetailResponse,
}

#[derive(Debug, Serialize)]
pub struct HelcimDepositReconciliationRunResponse {
    pub run_id: Uuid,
    pub status: String,
    pub expected_batches_missing_actual: i64,
    pub actual_deposits_missing_expected: i64,
    pub amount_mismatches: i64,
    pub date_mismatches: i64,
    pub duplicate_references: i64,
    pub items_opened: i64,
}

#[derive(Debug, sqlx::FromRow)]
struct HelcimAttemptRow {
    pub id: Uuid,
    pub provider: String,
    pub status: String,
    pub amount_cents: i64,
    pub currency: String,
    pub register_session_id: Option<Uuid>,
    pub staff_id: Option<Uuid>,
    pub device_id: Option<String>,
    pub terminal_id: Option<String>,
    pub selected_terminal_key: Option<String>,
    pub terminal_route_source: Option<String>,
    pub terminal_override_staff_id: Option<Uuid>,
    pub terminal_override_reason: Option<String>,
    pub idempotency_key: String,
    pub provider_payment_id: Option<String>,
    pub provider_transaction_id: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub raw_audit_reference: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct HelcimAttemptResponse {
    pub id: Uuid,
    pub provider: String,
    pub status: String,
    pub amount_cents: i64,
    pub currency: String,
    pub register_session_id: Option<Uuid>,
    pub staff_id: Option<Uuid>,
    pub device_id: Option<String>,
    pub terminal_id: Option<String>,
    pub selected_terminal_key: Option<String>,
    pub terminal_route_source: Option<String>,
    pub terminal_override_staff_id: Option<Uuid>,
    pub terminal_override_reason: Option<String>,
    pub idempotency_key: String,
    pub provider_payment_id: Option<String>,
    pub provider_transaction_id: Option<String>,
    pub provider_auth_code: Option<String>,
    pub provider_card_type: Option<String>,
    pub card_brand: Option<String>,
    pub card_last4: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub safe_message: Option<String>,
    pub raw_audit_reference: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

impl HelcimAttemptResponse {
    fn from_row(
        row: HelcimAttemptRow,
        transaction: Option<helcim::HelcimCardTransaction>,
        safe_message: Option<String>,
    ) -> Self {
        let provider_auth_code = transaction
            .as_ref()
            .and_then(|transaction| transaction.approval_code.clone());
        let provider_card_type = transaction
            .as_ref()
            .and_then(|transaction| transaction.card_type.clone());
        let card_brand = transaction
            .as_ref()
            .and_then(helcim::HelcimCardTransaction::card_brand);
        let card_last4 = transaction
            .as_ref()
            .and_then(helcim::HelcimCardTransaction::card_last4);

        Self {
            id: row.id,
            provider: row.provider,
            status: row.status,
            amount_cents: row.amount_cents,
            currency: row.currency,
            register_session_id: row.register_session_id,
            staff_id: row.staff_id,
            device_id: row.device_id,
            terminal_id: row.terminal_id,
            selected_terminal_key: row.selected_terminal_key,
            terminal_route_source: row.terminal_route_source,
            terminal_override_staff_id: row.terminal_override_staff_id,
            terminal_override_reason: row.terminal_override_reason,
            idempotency_key: row.idempotency_key,
            provider_payment_id: row.provider_payment_id,
            provider_transaction_id: row.provider_transaction_id,
            provider_auth_code,
            provider_card_type,
            card_brand,
            card_last4,
            error_code: row.error_code,
            error_message: row.error_message,
            safe_message,
            raw_audit_reference: row.raw_audit_reference,
            created_at: row.created_at,
            updated_at: row.updated_at,
            completed_at: row.completed_at,
        }
    }
}

async fn load_active_card_provider(state: &AppState) -> Result<String, PaymentError> {
    let provider: Option<String> =
        sqlx::query_scalar("SELECT active_card_provider FROM store_settings WHERE id = 1")
            .fetch_optional(&state.db)
            .await
            .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    Ok(provider
        .filter(|provider| provider == helcim::HELCIM_PROVIDER_KEY)
        .unwrap_or_else(|| helcim::HELCIM_PROVIDER_KEY.to_string()))
}

async fn active_card_provider_response(
    state: &AppState,
) -> Result<ActiveCardProviderResponse, PaymentError> {
    helcim::apply_persisted_helcim_config_to_env(&state.db)
        .await
        .map_err(map_credential_error)?;
    let config = helcim::HelcimConfig::from_env();
    Ok(ActiveCardProviderResponse {
        active_provider: load_active_card_provider(state).await?,
        helcim: config.status(),
        helcim_terminal_routing: helcim_terminal_routing_status(&state.db, &config).await?,
    })
}

async fn register_lane_for_session(
    pool: &PgPool,
    register_session_id: Uuid,
) -> Result<i16, PaymentError> {
    sqlx::query_scalar(
        r#"
        SELECT register_lane
        FROM register_sessions
        WHERE id = $1 AND is_open = true
        "#,
    )
    .bind(register_session_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .ok_or_else(|| PaymentError::InvalidPayload("Register session is not open.".to_string()))
}

async fn lock_register_session_open_for_payment(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    register_session_id: Option<Uuid>,
) -> Result<(), PaymentError> {
    let Some(register_session_id) = register_session_id else {
        return Ok(());
    };

    let session_id: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM register_sessions
        WHERE id = $1
          AND is_open = true
          AND lifecycle_status = 'open'
        FOR UPDATE
        "#,
    )
    .bind(register_session_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    if session_id.is_none() {
        return Err(PaymentError::InvalidPayload(
            "Register session is not open.".to_string(),
        ));
    }

    Ok(())
}

fn is_provider_idempotency_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|db_error| db_error.constraint())
        == Some("uq_payment_provider_attempts_provider_idempotency")
}

#[derive(Debug, Clone)]
struct ResolvedHelcimTerminalRoute {
    terminal_key: String,
    terminal_id: String,
    route_source: String,
    override_staff_id: Option<Uuid>,
    override_reason: Option<String>,
}

fn helcim_register_terminal_route(register_lane: i16) -> Option<HelcimRegisterTerminalRoute> {
    match register_lane {
        1 => Some(HelcimRegisterTerminalRoute {
            register_lane,
            default_terminal_key: Some("terminal_1".to_string()),
            allowed_terminal_keys: vec!["terminal_1".to_string()],
            choice_required: false,
            non_default_override_requires_permission: true,
        }),
        2 => Some(HelcimRegisterTerminalRoute {
            register_lane,
            default_terminal_key: Some("terminal_2".to_string()),
            allowed_terminal_keys: vec!["terminal_2".to_string()],
            choice_required: false,
            non_default_override_requires_permission: true,
        }),
        3 | 4 => Some(HelcimRegisterTerminalRoute {
            register_lane,
            default_terminal_key: None,
            allowed_terminal_keys: vec!["terminal_1".to_string(), "terminal_2".to_string()],
            choice_required: true,
            non_default_override_requires_permission: false,
        }),
        _ => None,
    }
}

async fn helcim_terminal_routing_status(
    pool: &PgPool,
    config: &helcim::HelcimConfig,
) -> Result<HelcimTerminalRoutingStatus, PaymentError> {
    for terminal_id in ["terminal_1", "terminal_2"]
        .into_iter()
        .filter_map(|key| config.device_code_for_terminal_key(key))
    {
        expire_stale_helcim_terminal_attempts(pool, terminal_id).await?;
    }

    let pending_rows: Vec<(Option<String>, Option<i16>, Uuid)> = sqlx::query_as(
        r#"
        SELECT selected_terminal_key, rs.register_lane, ppa.id
        FROM payment_provider_attempts ppa
        LEFT JOIN register_sessions rs ON rs.id = ppa.register_session_id
        WHERE ppa.provider = 'helcim'
          AND ppa.status = 'pending'
          AND ppa.selected_terminal_key IN ('terminal_1', 'terminal_2')
        ORDER BY ppa.created_at ASC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let in_use_by_register: BTreeMap<String, (i16, Uuid)> = pending_rows
        .into_iter()
        .filter_map(|(key, lane, attempt_id)| Some((key?, (lane?, attempt_id))))
        .collect();
    let terminals = ["terminal_1", "terminal_2"]
        .into_iter()
        .map(|key| {
            let active = in_use_by_register.get(key);
            HelcimTerminalStatus {
                key: key.to_string(),
                label: match key {
                    "terminal_1" => "Terminal 1",
                    "terminal_2" => "Terminal 2",
                    _ => key,
                }
                .to_string(),
                configured: config.device_code_for_terminal_key(key).is_some(),
                device_code_suffix: config
                    .device_code_for_terminal_key(key)
                    .map(mask_terminal_suffix),
                in_use_by_register_lane: active.map(|(lane, _)| *lane),
                active_attempt_id: active.map(|(_, attempt_id)| *attempt_id),
            }
        })
        .collect();
    let registers = [1_i16, 2, 3, 4]
        .into_iter()
        .filter_map(helcim_register_terminal_route)
        .collect();
    Ok(HelcimTerminalRoutingStatus {
        terminals,
        registers,
    })
}

fn mask_terminal_suffix(value: &str) -> String {
    value
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn normalize_terminal_key(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase().replace('-', "_"))
}

fn clean_terminal_override_reason(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(255).collect())
}

async fn staff_can_override_terminal(
    state: &AppState,
    staff_id: Option<Uuid>,
) -> Result<bool, PaymentError> {
    let Some(staff_id) = staff_id else {
        return Ok(false);
    };
    let row: Option<(DbStaffRole,)> = sqlx::query_as("SELECT role FROM staff WHERE id = $1")
        .bind(staff_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    let Some((role,)) = row else {
        return Ok(false);
    };
    if role == DbStaffRole::Admin {
        return Ok(true);
    }
    let effective = permissions::effective_permissions_for_staff(&state.db, staff_id, role)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "terminal override permission resolution failed");
            PaymentError::InvalidPayload("permission resolution failed".to_string())
        })?;
    Ok(staff_has_permission(&effective, PAYMENTS_TERMINAL_OVERRIDE))
}

async fn resolve_helcim_terminal_for_register_with_selection(
    state: &AppState,
    pool: &PgPool,
    config: &helcim::HelcimConfig,
    register_session_id: Option<Uuid>,
    selected_terminal_key: Option<&str>,
    override_reason: Option<&str>,
    staff_id: Option<Uuid>,
) -> Result<ResolvedHelcimTerminalRoute, PaymentError> {
    let Some(register_session_id) = register_session_id else {
        return Err(PaymentError::InvalidPayload(
            "Register session is required for Helcim terminal payments.".to_string(),
        ));
    };
    let register_lane = register_lane_for_session(pool, register_session_id).await?;
    let route = helcim_register_terminal_route(register_lane).ok_or_else(|| {
        PaymentError::InvalidPayload(format!(
            "Helcim terminal payments are not configured for Register #{register_lane}."
        ))
    })?;
    let selected = normalize_terminal_key(selected_terminal_key);
    let terminal_key = if route.choice_required {
        selected.ok_or_else(|| {
            PaymentError::InvalidPayload(format!(
                "Choose Terminal 1 or Terminal 2 before starting a Register #{register_lane} Helcim payment."
            ))
        })?
    } else {
        selected.unwrap_or_else(|| route.default_terminal_key.clone().unwrap_or_default())
    };
    if !matches!(terminal_key.as_str(), "terminal_1" | "terminal_2") {
        return Err(PaymentError::InvalidPayload(format!(
            "Terminal selection is not allowed for Register #{register_lane}."
        )));
    }
    let is_default = route.default_terminal_key.as_deref() == Some(terminal_key.as_str());
    let is_allowed = route
        .allowed_terminal_keys
        .iter()
        .any(|key| key == &terminal_key);
    if !is_allowed && (route.choice_required || !route.non_default_override_requires_permission) {
        return Err(PaymentError::InvalidPayload(format!(
            "Terminal selection is not allowed for Register #{register_lane}."
        )));
    }
    let route_source = if route.choice_required {
        "required_choice"
    } else if is_default {
        "default"
    } else {
        "override"
    };
    let mut override_staff_id = None;
    let mut cleaned_reason = None;
    if route_source == "override" && route.non_default_override_requires_permission {
        if !staff_can_override_terminal(state, staff_id).await? {
            return Err(PaymentError::Forbidden(
                "Manager Access is required to use a non-default terminal.".to_string(),
            ));
        }
        override_staff_id = staff_id;
        cleaned_reason = clean_terminal_override_reason(override_reason);
    }
    let terminal_id = config
        .device_code_for_terminal_key(&terminal_key)
        .map(str::to_string)
        .ok_or_else(|| {
            PaymentError::InvalidPayload(format!(
                "{} is not configured in Settings.",
                if terminal_key == "terminal_1" {
                    "Terminal 1"
                } else {
                    "Terminal 2"
                }
            ))
        })?;
    Ok(ResolvedHelcimTerminalRoute {
        terminal_key,
        terminal_id,
        route_source: route_source.to_string(),
        override_staff_id,
        override_reason: cleaned_reason,
    })
}

fn clean_optional_secret(
    value: Option<String>,
    label: &str,
) -> Result<Option<String>, PaymentError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > 4096 {
        return Err(PaymentError::InvalidPayload(format!(
            "{label} is too long."
        )));
    }
    Ok(Some(trimmed.to_string()))
}

fn clean_optional_device_code(value: Option<String>) -> Result<Option<String>, PaymentError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > 255 {
        return Err(PaymentError::InvalidPayload(
            "Device code is too long.".to_string(),
        ));
    }
    Ok(Some(trimmed.to_string()))
}

fn clean_optional_api_base_url(value: Option<String>) -> Result<Option<String>, PaymentError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(None);
    }
    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|_| PaymentError::InvalidPayload("API host must be a valid URL.".to_string()))?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err(PaymentError::InvalidPayload(
            "API host must use http or https.".to_string(),
        ));
    }
    Ok(Some(trimmed.to_string()))
}

async fn patch_helcim_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PatchHelcimConfigRequest>,
) -> Result<Json<helcim::HelcimConfigStatus>, PaymentError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;

    let api_token = clean_optional_secret(payload.api_token, "API token")?;
    let terminal_1_device_code = clean_optional_device_code(payload.terminal_1_device_code)?;
    let terminal_2_device_code = clean_optional_device_code(payload.terminal_2_device_code)?;
    let webhook_secret = clean_optional_secret(payload.webhook_secret, "Signing secret")?;
    let api_base_url = clean_optional_api_base_url(payload.api_base_url)?;

    if api_token.is_none()
        && terminal_1_device_code.is_none()
        && terminal_2_device_code.is_none()
        && webhook_secret.is_none()
        && api_base_url.is_none()
        && payload.simulator_enabled.is_none()
    {
        return Err(PaymentError::InvalidPayload(
            "Enter at least one Helcim setting to save.".to_string(),
        ));
    }

    let mut values = Vec::new();
    if let Some(value) = api_token {
        values.push(("api_token", value));
    }
    if let Some(value) = terminal_1_device_code {
        values.push(("terminal_1_device_code", value));
    }
    if let Some(value) = terminal_2_device_code {
        values.push(("terminal_2_device_code", value));
    }
    if let Some(value) = webhook_secret {
        values.push(("webhook_secret", value));
    }
    if let Some(value) = api_base_url {
        values.push(("api_base_url", value));
    }
    if let Some(value) = payload.simulator_enabled {
        values.push(("simulator_enabled", value.to_string()));
    }

    integration_credentials::save_integration_credentials(
        &state.db,
        helcim::HELCIM_PROVIDER_KEY,
        values,
        Some(staff.id),
    )
    .await
    .map_err(map_credential_error)?;

    helcim::apply_persisted_helcim_config_to_env(&state.db)
        .await
        .map_err(map_credential_error)?;
    Ok(Json(helcim::HelcimConfig::from_env().status()))
}

async fn get_payments_config(
    State(_state): State<AppState>,
    _headers: HeaderMap,
) -> Result<Json<serde_json::Value>, PaymentError> {
    Ok(Json(json!({ "provider": helcim::HELCIM_PROVIDER_KEY })))
}

async fn get_active_card_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ActiveCardProviderResponse>, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;

    Ok(Json(active_card_provider_response(&state).await?))
}

async fn patch_active_card_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PatchActiveCardProviderRequest>,
) -> Result<Json<ActiveCardProviderResponse>, PaymentError> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;

    let provider = payload.active_provider.trim().to_ascii_lowercase();
    if provider != helcim::HELCIM_PROVIDER_KEY {
        return Err(PaymentError::InvalidPayload(
            "active_provider must be helcim".to_string(),
        ));
    }

    sqlx::query("UPDATE store_settings SET active_card_provider = $1 WHERE id = 1")
        .bind(&provider)
        .execute(&state.db)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    Ok(Json(active_card_provider_response(&state).await?))
}

async fn get_helcim_provider_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<helcim::HelcimConfigStatus>, PaymentError> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;

    helcim::apply_persisted_helcim_config_to_env(&state.db)
        .await
        .map_err(map_credential_error)?;
    Ok(Json(helcim::HelcimConfig::from_env().status()))
}

async fn get_helcim_health(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, PaymentError> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;

    helcim::apply_persisted_helcim_config_to_env(&state.db)
        .await
        .map_err(map_credential_error)?;
    let health = helcim::health_check(&state.http_client).await;
    Ok(Json(json!({
        "configured": health.configured,
        "reachable": health.reachable,
        "latency_ms": health.latency_ms,
        "message": health.message,
    })))
}

async fn get_helcim_fee_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HelcimFeeStatusResponse>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_VIEW).await?;

    #[derive(sqlx::FromRow)]
    struct Row {
        total_helcim_payments: i64,
        fees_synced: i64,
        ready_to_sync: i64,
        missing_transaction_id: i64,
        total_fees: Decimal,
        net_amount: Decimal,
    }

    let row: Row = sqlx::query_as(
        r#"
        SELECT
            COUNT(*)::bigint AS total_helcim_payments,
            COUNT(*) FILTER (
                WHERE COALESCE(merchant_fee, 0) <> 0
                   OR metadata->>'helcim_fee_sync_status' = 'applied'
            )::bigint AS fees_synced,
            COUNT(*) FILTER (
                WHERE NULLIF(TRIM(COALESCE(provider_transaction_id, '')), '') IS NOT NULL
                  AND (
                      COALESCE(metadata->>'helcim_fee_sync_status', '') <> 'applied'
                      OR COALESCE(metadata->>'helcim_net_sync_status', '') <> 'applied'
                  )
            )::bigint AS ready_to_sync,
            COUNT(*) FILTER (
                WHERE NULLIF(TRIM(COALESCE(provider_transaction_id, '')), '') IS NULL
            )::bigint AS missing_transaction_id,
            COALESCE(SUM(merchant_fee), 0)::numeric(14, 2) AS total_fees,
            COALESCE(SUM(net_amount), 0)::numeric(14, 2) AS net_amount
        FROM payment_transactions
        WHERE payment_provider = 'helcim'
        "#,
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    Ok(Json(HelcimFeeStatusResponse {
        total_helcim_payments: row.total_helcim_payments,
        fees_synced: row.fees_synced,
        ready_to_sync: row.ready_to_sync,
        missing_transaction_id: row.missing_transaction_id,
        total_fees: row.total_fees.round_dp(2).to_string(),
        net_amount: row.net_amount.round_dp(2).to_string(),
    }))
}

async fn sync_helcim_fees(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HelcimFeeSyncResponse>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_SYNC).await?;

    Ok(Json(
        run_helcim_fee_sync(&state.db, &state.http_client, None).await?,
    ))
}

pub async fn run_scheduled_helcim_fee_sync(
    pool: &PgPool,
    http_client: &reqwest::Client,
) -> Result<HelcimFeeSyncResponse, String> {
    let config = helcim::HelcimConfig::from_env();
    if !config.enabled() {
        tracing::info!("Helcim fee sync skipped; credentials are not configured yet");
        integration_alerts::record_integration_success(pool, "helcim_fee_sync")
            .await
            .map_err(|error| error.to_string())?;
        return Ok(HelcimFeeSyncResponse {
            scanned: 0,
            updated: 0,
            fees_unavailable: 0,
            skipped_missing_transaction_id: 0,
            errors: 0,
            total_fee_synced: "0.00".to_string(),
            total_net_synced: "0.00".to_string(),
        });
    }
    let date_from = Some((Utc::now() - ChronoDuration::days(7)).date_naive());
    match run_helcim_fee_sync(pool, http_client, date_from).await {
        Ok(response) => {
            integration_alerts::record_integration_success(pool, "helcim_fee_sync")
                .await
                .map_err(|error| error.to_string())?;
            Ok(response)
        }
        Err(error) => {
            let message = error.to_string();
            let _ =
                integration_alerts::record_integration_failure(pool, "helcim_fee_sync", &message)
                    .await;
            Err(message)
        }
    }
}

async fn run_helcim_fee_sync(
    pool: &PgPool,
    http_client: &reqwest::Client,
    date_from: Option<NaiveDate>,
) -> Result<HelcimFeeSyncResponse, PaymentError> {
    let config = helcim::HelcimConfig::from_env();
    if !config.enabled() {
        return Err(PaymentError::InvalidPayload(
            "Helcim is not fully configured.".to_string(),
        ));
    }
    if config.simulator_enabled() {
        return Ok(HelcimFeeSyncResponse {
            scanned: 0,
            updated: 0,
            fees_unavailable: 0,
            skipped_missing_transaction_id: 0,
            errors: 0,
            total_fee_synced: "0.00".to_string(),
            total_net_synced: "0.00".to_string(),
        });
    }

    #[derive(sqlx::FromRow)]
    struct PaymentRow {
        id: Uuid,
        provider_transaction_id: Option<String>,
        fee_sync_status: Option<String>,
        net_sync_status: Option<String>,
    }

    let rows: Vec<PaymentRow> = sqlx::query_as(
        r#"
        SELECT
            id,
            provider_transaction_id,
            metadata->>'helcim_fee_sync_status' AS fee_sync_status,
            metadata->>'helcim_net_sync_status' AS net_sync_status
        FROM payment_transactions
        WHERE payment_provider = 'helcim'
          AND ($1::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date >= $1)
          AND (
              COALESCE(metadata->>'helcim_fee_sync_status', '') <> 'applied'
              OR COALESCE(metadata->>'helcim_net_sync_status', '') <> 'applied'
          )
          AND COALESCE(provider_status, status, '') NOT IN ('failed', 'canceled', 'cancelled', 'declined')
        ORDER BY created_at ASC
        LIMIT 100
        "#,
    )
    .bind(date_from)
    .fetch_all(pool)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let mut scanned = 0_i64;
    let mut updated = 0_i64;
    let mut fees_unavailable = 0_i64;
    let mut skipped_missing_transaction_id = 0_i64;
    let mut errors = 0_i64;
    let mut total_fee_synced = Decimal::ZERO;
    let mut total_net_synced = Decimal::ZERO;

    for row in rows {
        scanned += 1;
        let Some(transaction_id) = row
            .provider_transaction_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
        else {
            skipped_missing_transaction_id += 1;
            continue;
        };
        if transaction_id.starts_with("helcim-sim-") {
            skipped_missing_transaction_id += 1;
            continue;
        }

        let transaction =
            match helcim::fetch_card_transaction(http_client, &config, &transaction_id).await {
                Ok(transaction) => transaction,
                Err(error) => {
                    errors += 1;
                    tracing::warn!(
                        target = "helcim",
                        payment_transaction_id = %row.id,
                        provider_transaction_id = %transaction_id,
                        error = %error,
                        "could not sync Helcim merchant fee"
                    );
                    continue;
                }
            };

        let fee_details = helcim::HelcimFeeDetails::from_card_transaction(&transaction);
        if fee_details.merchant_fee.is_none() && fee_details.net_amount.is_none() {
            fees_unavailable += 1;
            let mut metadata = json!({
                "helcim_fee_sync_at": chrono::Utc::now().to_rfc3339(),
                "helcim_card_batch_id": fee_details.card_batch_id,
            });
            if let Some(object) = metadata.as_object_mut() {
                if row.fee_sync_status.as_deref() != Some("applied") {
                    object.insert("helcim_fee_sync_status".to_string(), json!("unavailable"));
                }
                if row.net_sync_status.as_deref() != Some("applied") {
                    object.insert("helcim_net_sync_status".to_string(), json!("unavailable"));
                }
            }
            sqlx::query(
                r#"
                UPDATE payment_transactions
                SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                WHERE id = $1
                "#,
            )
            .bind(row.id)
            .bind(metadata)
            .execute(pool)
            .await
            .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
            continue;
        }

        let fee = if row.fee_sync_status.as_deref() == Some("applied") {
            None
        } else {
            fee_details.merchant_fee.map(|fee| fee.round_dp(2))
        };
        let net_amount = fee_details
            .net_amount
            .filter(|_| row.net_sync_status.as_deref() != Some("applied"))
            .map(|net_amount| net_amount.round_dp(2));
        let mut metadata = json!({
            "helcim_fee_sync_at": chrono::Utc::now().to_rfc3339(),
            "helcim_card_batch_id": fee_details.card_batch_id,
        });
        if let Some(object) = metadata.as_object_mut() {
            if fee.is_some() {
                object.insert("helcim_fee_sync_status".to_string(), json!("applied"));
                object.insert(
                    "helcim_fee_source_field".to_string(),
                    json!(fee_details.source_field),
                );
            }
            if net_amount.is_some() {
                object.insert("helcim_net_sync_status".to_string(), json!("applied"));
            } else {
                object.insert("helcim_net_sync_status".to_string(), json!("unavailable"));
            }
        }

        sqlx::query(
            r#"
            UPDATE payment_transactions
            SET merchant_fee = COALESCE($2, merchant_fee),
                net_amount = COALESCE($3, net_amount),
                metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
            WHERE id = $1
            "#,
        )
        .bind(row.id)
        .bind(fee)
        .bind(net_amount)
        .bind(metadata)
        .execute(pool)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

        updated += 1;
        if let Some(fee) = fee {
            total_fee_synced += fee;
        }
        if let Some(net_amount) = net_amount {
            total_net_synced += net_amount;
        }
    }

    Ok(HelcimFeeSyncResponse {
        scanned,
        updated,
        fees_unavailable,
        skipped_missing_transaction_id,
        errors,
        total_fee_synced: total_fee_synced.round_dp(2).to_string(),
        total_net_synced: total_net_synced.round_dp(2).to_string(),
    })
}

async fn get_helcim_settlement_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HelcimSettlementStatusResponse>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_VIEW).await?;

    #[derive(sqlx::FromRow)]
    struct CountsRow {
        batch_count: i64,
        batch_transaction_count: i64,
        matched_transaction_count: i64,
        unmatched_transaction_count: i64,
        open_item_count: i64,
        mismatch_count: i64,
    }

    let counts: CountsRow = sqlx::query_as(
        r#"
        SELECT
            (SELECT COUNT(*)::bigint FROM payment_provider_batches WHERE provider = 'helcim') AS batch_count,
            (SELECT COUNT(*)::bigint FROM payment_provider_batch_transactions WHERE provider = 'helcim') AS batch_transaction_count,
            (
                SELECT COUNT(*)::bigint
                FROM payment_provider_batch_transactions
                WHERE provider = 'helcim' AND match_status = 'matched'
            ) AS matched_transaction_count,
            (
                SELECT COUNT(*)::bigint
                FROM payment_provider_batch_transactions
                WHERE provider = 'helcim' AND match_status <> 'matched'
            ) AS unmatched_transaction_count,
            (
                SELECT COUNT(*)::bigint
                FROM payment_settlement_items
                WHERE provider = 'helcim' AND status = 'open'
            ) AS open_item_count,
            (
                SELECT COUNT(*)::bigint
                FROM payment_settlement_items
                WHERE provider = 'helcim'
                  AND status = 'open'
                  AND item_type IN ('amount_mismatch', 'status_mismatch', 'fee_mismatch', 'net_mismatch')
            ) AS mismatch_count
        "#,
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let last_run = sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            DateTime<Utc>,
            Option<DateTime<Utc>>,
            Value,
            Option<String>,
        ),
    >(
        r#"
        SELECT id, status, started_at, completed_at, summary, error_message
        FROM payment_settlement_runs
        WHERE provider = 'helcim'
        ORDER BY started_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .map(
        |(id, status, started_at, completed_at, summary, error_message)| {
            HelcimSettlementRunSummary {
                id,
                status,
                started_at,
                completed_at,
                summary,
                error_message,
            }
        },
    );

    let config = helcim::HelcimConfig::from_env();
    let api_integration_active = config.api_enabled() && !config.simulator_enabled();
    let last_run_at = last_run.as_ref().map(|run| run.started_at);

    Ok(Json(HelcimSettlementStatusResponse {
        batch_count: counts.batch_count,
        batch_transaction_count: counts.batch_transaction_count,
        matched_transaction_count: counts.matched_transaction_count,
        unmatched_transaction_count: counts.unmatched_transaction_count,
        open_item_count: counts.open_item_count,
        mismatch_count: counts.mismatch_count,
        api_integration_active,
        last_run_at,
        last_run,
    }))
}

async fn sync_helcim_settlements(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Option<Json<HelcimSettlementSyncRequest>>,
) -> Result<Json<HelcimSettlementSyncResponse>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_SYNC).await?;
    let payload = payload
        .map(|Json(payload)| payload)
        .unwrap_or(HelcimSettlementSyncRequest {
            date_from: None,
            date_to: None,
        });
    Ok(Json(
        run_helcim_settlement_sync(
            &state.db,
            &state.http_client,
            payload.date_from,
            payload.date_to,
        )
        .await?,
    ))
}

pub async fn run_scheduled_helcim_settlement_sync(
    pool: &PgPool,
    http_client: &reqwest::Client,
) -> Result<HelcimSettlementSyncResponse, String> {
    let date_from = Some((Utc::now() - ChronoDuration::days(7)).date_naive());
    match run_helcim_settlement_sync(pool, http_client, date_from, None).await {
        Ok(response) => {
            integration_alerts::record_integration_success(pool, "helcim_settlement_sync")
                .await
                .map_err(|error| error.to_string())?;
            Ok(response)
        }
        Err(error) => {
            let message = error.to_string();
            let _ = integration_alerts::record_integration_failure(
                pool,
                "helcim_settlement_sync",
                &message,
            )
            .await;
            Err(message)
        }
    }
}

async fn run_helcim_settlement_sync(
    pool: &PgPool,
    http_client: &reqwest::Client,
    date_from: Option<NaiveDate>,
    date_to: Option<NaiveDate>,
) -> Result<HelcimSettlementSyncResponse, PaymentError> {
    let config = helcim::HelcimConfig::from_env();
    let api_integration_active = config.api_enabled() && !config.simulator_enabled();
    let processor_data = if api_integration_active {
        Some(
            fetch_helcim_processor_settlement_data(http_client, &config, date_from, date_to)
                .await
                .map_err(PaymentError::ProviderError)?,
        )
    } else {
        None
    };

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let run_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO payment_settlement_runs (
            provider,
            scope,
            status,
            date_from,
            date_to,
            summary
        )
        VALUES (
            'helcim',
            'batch_sync',
            'running',
            $1,
            $2,
            jsonb_build_object(
                'source', $3::text,
                'api_integration_active', $4::boolean
            )
        )
        RETURNING id
        "#,
    )
    .bind(date_from)
    .bind(date_to)
    .bind(if api_integration_active {
        "helcim_api"
    } else {
        "local_payment_metadata"
    })
    .bind(api_integration_active)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let result =
        sync_helcim_settlement_rows(&mut tx, run_id, date_from, date_to, processor_data.as_ref())
            .await;

    match result {
        Ok(summary) => {
            let summary_json = json!({
                "payments_scanned": summary.payments_scanned,
                "batches_upserted": summary.batches_upserted,
                "batch_transactions_upserted": summary.batch_transactions_upserted,
                "reconciliation_items_opened": summary.reconciliation_items_opened,
                "missing_batch_rows": summary.missing_batch_rows,
                "unmatched_processor_rows": summary.unmatched_processor_rows,
                "amount_mismatches": summary.amount_mismatches,
                "status_mismatches": summary.status_mismatches,
                "fee_mismatches": summary.fee_mismatches,
                "net_mismatches": summary.net_mismatches,
                "helcim_batches_fetched": summary.helcim_batches_fetched,
                "helcim_batch_transactions_fetched": summary.helcim_batch_transactions_fetched,
                "source": if api_integration_active { "helcim_api" } else { "local_payment_metadata" },
                "api_integration_active": api_integration_active,
            });
            sqlx::query(
                r#"
                UPDATE payment_settlement_runs
                SET status = 'completed',
                    completed_at = now(),
                    summary = $2
                WHERE id = $1
                "#,
            )
            .bind(run_id)
            .bind(summary_json)
            .execute(&mut *tx)
            .await
            .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
            tx.commit()
                .await
                .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
            Ok(HelcimSettlementSyncResponse {
                run_id,
                status: "completed".to_string(),
                payments_scanned: summary.payments_scanned,
                batches_upserted: summary.batches_upserted,
                batch_transactions_upserted: summary.batch_transactions_upserted,
                reconciliation_items_opened: summary.reconciliation_items_opened,
                missing_batch_rows: summary.missing_batch_rows,
                unmatched_processor_rows: summary.unmatched_processor_rows,
                amount_mismatches: summary.amount_mismatches,
                status_mismatches: summary.status_mismatches,
                fee_mismatches: summary.fee_mismatches,
                net_mismatches: summary.net_mismatches,
                api_integration_active,
                helcim_batches_fetched: summary.helcim_batches_fetched,
                helcim_batch_transactions_fetched: summary.helcim_batch_transactions_fetched,
                message: if api_integration_active {
                    "Helcim API batch and transaction data synced into settlement records."
                        .to_string()
                } else {
                    "Helcim API integration is not active; sync promoted known local Helcim batch metadata and created reconciliation findings only."
                        .to_string()
                },
            })
        }
        Err(error) => {
            let _ = sqlx::query(
                r#"
                UPDATE payment_settlement_runs
                SET status = 'failed',
                    completed_at = now(),
                    error_message = $2
                WHERE id = $1
                "#,
            )
            .bind(run_id)
            .bind(error.to_string())
            .execute(&mut *tx)
            .await;
            let _ = tx.commit().await;
            Err(error)
        }
    }
}

async fn get_helcim_operations_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HelcimOperationsDateQuery>,
) -> Result<Json<HelcimOperationsOverviewResponse>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_VIEW).await?;

    #[derive(sqlx::FromRow)]
    struct OverviewRow {
        card_sales_gross: Decimal,
        known_fees: Option<Decimal>,
        known_net: Option<Decimal>,
        fee_not_ready_count: i64,
        net_not_ready_count: i64,
        expected_deposit_from_batches: Option<Decimal>,
        open_issue_count: i64,
        critical_issue_count: i64,
        last_fee_sync: Option<DateTime<Utc>>,
    }

    let row: OverviewRow = sqlx::query_as(
        r#"
        SELECT
            COALESCE((
                SELECT SUM(amount)
                FROM payment_transactions
                WHERE payment_provider = 'helcim'
                  AND status = 'success'
                  AND ($1::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date >= $1)
                  AND ($2::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date <= $2)
            ), 0)::numeric(14,2) AS card_sales_gross,
            (
                SELECT SUM(merchant_fee)
                FROM payment_transactions
                WHERE payment_provider = 'helcim'
                  AND metadata->>'helcim_fee_sync_status' = 'applied'
                  AND ($1::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date >= $1)
                  AND ($2::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date <= $2)
            )::numeric(14,2) AS known_fees,
            (
                SELECT SUM(net_amount)
                FROM payment_transactions
                WHERE payment_provider = 'helcim'
                  AND metadata->>'helcim_net_sync_status' = 'applied'
                  AND ($1::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date >= $1)
                  AND ($2::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date <= $2)
            )::numeric(14,2) AS known_net,
            (
                SELECT COUNT(*)::bigint
                FROM payment_transactions
                WHERE payment_provider = 'helcim'
                  AND COALESCE(metadata->>'helcim_fee_sync_status', '') <> 'applied'
                  AND ($1::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date >= $1)
                  AND ($2::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date <= $2)
            ) AS fee_not_ready_count,
            (
                SELECT COUNT(*)::bigint
                FROM payment_transactions
                WHERE payment_provider = 'helcim'
                  AND COALESCE(metadata->>'helcim_net_sync_status', '') <> 'applied'
                  AND ($1::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date >= $1)
                  AND ($2::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date <= $2)
            ) AS net_not_ready_count,
            (
                SELECT SUM(net_amount)
                FROM payment_provider_batches
                WHERE provider = 'helcim'
                  AND net_amount IS NOT NULL
                  AND ($1::date IS NULL OR (COALESCE(expected_deposit_at, settled_at, closed_at, last_synced_at) AT TIME ZONE 'America/New_York')::date >= $1)
                  AND ($2::date IS NULL OR (COALESCE(expected_deposit_at, settled_at, closed_at, last_synced_at) AT TIME ZONE 'America/New_York')::date <= $2)
            )::numeric(14,2) AS expected_deposit_from_batches,
            (
                SELECT COUNT(*)::bigint
                FROM payment_settlement_items
                WHERE provider = 'helcim'
                  AND status = 'open'
            ) AS open_issue_count,
            (
                SELECT COUNT(*)::bigint
                FROM payment_settlement_items
                WHERE provider = 'helcim'
                  AND status = 'open'
                  AND severity = 'critical'
            ) AS critical_issue_count,
            (
                SELECT MAX(NULLIF(metadata->>'helcim_fee_sync_at', '')::timestamptz)
                FROM payment_transactions
                WHERE payment_provider = 'helcim'
                  AND metadata ? 'helcim_fee_sync_at'
            ) AS last_fee_sync
        "#,
    )
    .bind(query.date_from)
    .bind(query.date_to)
    .fetch_one(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let last_settlement_sync = load_last_helcim_settlement_run(&state).await?;
    let config = helcim::HelcimConfig::from_env();

    Ok(Json(HelcimOperationsOverviewResponse {
        card_sales_gross: money_string(row.card_sales_gross),
        known_fees: money_option(row.known_fees),
        known_net: money_option(row.known_net),
        fee_not_ready_count: row.fee_not_ready_count,
        net_not_ready_count: row.net_not_ready_count,
        expected_deposit_from_batches: money_option(row.expected_deposit_from_batches),
        open_issue_count: row.open_issue_count,
        critical_issue_count: row.critical_issue_count,
        last_settlement_sync,
        last_fee_sync: row.last_fee_sync,
        helcim_api_active: config.api_enabled() && !config.simulator_enabled(),
    }))
}

async fn list_helcim_batches(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HelcimOperationsListQuery>,
) -> Result<Json<Vec<HelcimBatchListRow>>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_VIEW).await?;
    let rows = load_helcim_batch_rows(&state, None, &query).await?;
    Ok(Json(rows))
}

async fn get_helcim_batch_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<HelcimBatchDetailResponse>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_VIEW).await?;
    let query = HelcimOperationsListQuery {
        limit: Some(1),
        ..Default::default()
    };
    let mut rows = load_helcim_batch_rows(&state, Some(&id), &query).await?;
    let Some(batch) = rows.pop() else {
        return Err(PaymentError::InvalidPayload("Batch not found.".to_string()));
    };
    #[derive(sqlx::FromRow)]
    struct IssueCounts {
        critical_issue_count: i64,
        warning_issue_count: i64,
        info_issue_count: i64,
    }
    let counts: IssueCounts = sqlx::query_as(
        r#"
        SELECT
            COUNT(*) FILTER (WHERE severity = 'critical')::bigint AS critical_issue_count,
            COUNT(*) FILTER (WHERE severity = 'warning')::bigint AS warning_issue_count,
            COUNT(*) FILTER (WHERE severity = 'info')::bigint AS info_issue_count
        FROM payment_settlement_items
        WHERE provider = 'helcim'
          AND status = 'open'
          AND (payment_provider_batch_id = $1 OR provider_batch_id = $2)
        "#,
    )
    .bind(batch.id)
    .bind(&batch.provider_batch_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(Json(HelcimBatchDetailResponse {
        batch,
        critical_issue_count: counts.critical_issue_count,
        warning_issue_count: counts.warning_issue_count,
        info_issue_count: counts.info_issue_count,
    }))
}

async fn list_helcim_batch_transactions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Vec<HelcimBatchTransactionRow>>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_VIEW).await?;
    let (batch_uuid, provider_batch_id) = parse_batch_identifier(&id);
    let rows = sqlx::query(
        r#"
        SELECT
            btx.id,
            btx.provider_transaction_id,
            btx.payment_transaction_id,
            btx.gross_amount,
            btx.status,
            btx.fee_amount,
            btx.net_amount,
            btx.match_status,
            btx.match_type,
            btx.occurred_at,
            btx.settled_at
        FROM payment_provider_batch_transactions btx
        LEFT JOIN payment_provider_batches batch ON batch.id = btx.payment_provider_batch_id
        WHERE btx.provider = 'helcim'
          AND (($1::uuid IS NOT NULL AND btx.payment_provider_batch_id = $1)
            OR ($2::text IS NOT NULL AND (btx.provider_batch_id = $2 OR batch.provider_batch_id = $2)))
        ORDER BY COALESCE(btx.occurred_at, btx.last_synced_at) DESC
        LIMIT 500
        "#,
    )
    .bind(batch_uuid)
    .bind(provider_batch_id.as_deref())
    .fetch_all(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .into_iter()
    .map(|row| HelcimBatchTransactionRow {
        id: row.get("id"),
        provider_transaction_id: row.get("provider_transaction_id"),
        payment_transaction_id: row.get("payment_transaction_id"),
        amount: money_option(row.get("gross_amount")),
        status: row.get("status"),
        fee_amount: money_option(row.get("fee_amount")),
        net_amount: money_option(row.get("net_amount")),
        match_status: row.get("match_status"),
        match_type: row.get("match_type"),
        occurred_at: row.get("occurred_at"),
        settled_at: row.get("settled_at"),
    })
    .collect();
    Ok(Json(rows))
}

async fn list_helcim_reconciliation_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HelcimOperationsListQuery>,
) -> Result<Json<Vec<HelcimReconciliationItemRow>>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_VIEW).await?;
    let rows = load_helcim_reconciliation_items(&state, &query, None).await?;
    Ok(Json(rows))
}

async fn patch_helcim_reconciliation_item_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<HelcimReconciliationStatusRequest>,
) -> Result<Json<HelcimReconciliationActionResponse>, PaymentError> {
    let action = normalize_resolution_action(&payload.action)?;
    let staff = match action.as_str() {
        "reviewed" => {
            require_payment_permission_any(
                &state,
                &headers,
                PAYMENTS_RECONCILE_REVIEW,
                &[PAYMENTS_RECONCILE],
            )
            .await?
        }
        "resolved" | "ignored" | "reopened" => {
            require_payment_permission_any(
                &state,
                &headers,
                PAYMENTS_RECONCILE_RESOLVE,
                &[PAYMENTS_RECONCILE],
            )
            .await?
        }
        _ => unreachable!(),
    };
    let note = clean_required_note(payload.note.as_deref(), false)?;
    let resolution_type = clean_filter(payload.resolution_type.as_deref());

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    let before = load_settlement_item_state_for_update(&mut tx, id).await?;
    let severity = json_string(&before, "severity").unwrap_or_else(|| "warning".to_string());

    if action == "ignored" && note.is_none() {
        return Err(PaymentError::InvalidPayload(
            "A note is required to mark an issue expected.".to_string(),
        ));
    }
    if matches!(action.as_str(), "resolved" | "ignored")
        && matches!(severity.as_str(), "warning" | "critical")
        && note.is_none()
    {
        return Err(PaymentError::InvalidPayload(
            "A note is required to close a warning or critical issue.".to_string(),
        ));
    }

    match action.as_str() {
        "reviewed" => {
            sqlx::query(
                r#"
                UPDATE payment_settlement_items
                SET reviewed_by_staff_id = $2,
                    reviewed_at = now()
                WHERE id = $1 AND provider = 'helcim'
                "#,
            )
            .bind(id)
            .bind(staff.id)
            .execute(&mut *tx)
            .await
        }
        "resolved" => {
            sqlx::query(
                r#"
                UPDATE payment_settlement_items
                SET status = 'resolved',
                    resolved_by_staff_id = $2,
                    resolved_at = now(),
                    resolution_type = COALESCE($3, 'resolved'),
                    resolution_note = $4
                WHERE id = $1 AND provider = 'helcim'
                "#,
            )
            .bind(id)
            .bind(staff.id)
            .bind(resolution_type.as_deref())
            .bind(note.as_deref())
            .execute(&mut *tx)
            .await
        }
        "ignored" => {
            sqlx::query(
                r#"
                UPDATE payment_settlement_items
                SET status = 'ignored',
                    resolved_by_staff_id = $2,
                    resolved_at = now(),
                    resolution_type = COALESCE($3, 'expected'),
                    resolution_note = $4
                WHERE id = $1 AND provider = 'helcim'
                "#,
            )
            .bind(id)
            .bind(staff.id)
            .bind(resolution_type.as_deref())
            .bind(note.as_deref())
            .execute(&mut *tx)
            .await
        }
        "reopened" => {
            sqlx::query(
                r#"
                UPDATE payment_settlement_items
                SET status = 'open',
                    resolved_by_staff_id = NULL,
                    resolved_at = NULL,
                    resolution_type = NULL,
                    resolution_note = NULL
                WHERE id = $1 AND provider = 'helcim'
                "#,
            )
            .bind(id)
            .execute(&mut *tx)
            .await
        }
        _ => unreachable!(),
    }
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let after = load_settlement_item_state(&mut *tx, id).await?;
    insert_settlement_item_event(
        &mut tx,
        id,
        Some(staff.id),
        &action,
        note.as_deref(),
        before,
        after,
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(Json(HelcimReconciliationActionResponse {
        item: load_helcim_reconciliation_item_by_id(&state, id).await?,
    }))
}

async fn add_helcim_reconciliation_item_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<HelcimReconciliationNoteRequest>,
) -> Result<Json<HelcimReconciliationActionResponse>, PaymentError> {
    let staff = require_payment_permission_any(
        &state,
        &headers,
        PAYMENTS_RECONCILE_REVIEW,
        &[PAYMENTS_RECONCILE],
    )
    .await?;
    let note = clean_required_note(Some(&payload.note), true)?;
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    let before = load_settlement_item_state_for_update(&mut tx, id).await?;
    insert_settlement_item_event(
        &mut tx,
        id,
        Some(staff.id),
        "noted",
        note.as_deref(),
        before.clone(),
        before,
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(Json(HelcimReconciliationActionResponse {
        item: load_helcim_reconciliation_item_by_id(&state, id).await?,
    }))
}

async fn list_helcim_reconciliation_candidate_payments(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<HelcimReconciliationCandidatePaymentRow>>, PaymentError> {
    require_payment_permission_any(
        &state,
        &headers,
        PAYMENTS_RECONCILE_LINK,
        &[PAYMENTS_RECONCILE],
    )
    .await?;
    let item = load_settlement_item_state(&state.db, id).await?;
    let provider_transaction_id =
        json_string(&item, "provider_transaction_id").ok_or_else(|| {
            PaymentError::InvalidPayload("Issue has no processor reference to link.".to_string())
        })?;
    let processor = load_provider_batch_transaction(&state.db, &provider_transaction_id).await?;
    let processor_amount = processor
        .get("gross_amount")
        .and_then(value_decimal)
        .ok_or_else(|| {
            PaymentError::InvalidPayload(
                "Processor amount is not ready for payment linking.".to_string(),
            )
        })?;
    let occurred_at = processor
        .get("occurred_at")
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));

    let rows = sqlx::query(
        r#"
        SELECT
            pt.id,
            pt.provider_transaction_id,
            pt.amount,
            pt.created_at,
            pt.status,
            pt.provider_status,
            btx.provider_batch_id
        FROM payment_transactions pt
        LEFT JOIN payment_provider_batch_transactions btx
          ON btx.provider = 'helcim'
         AND btx.payment_transaction_id = pt.id
        WHERE pt.payment_provider = 'helcim'
          AND (NULLIF(TRIM(pt.provider_transaction_id), '') IS NULL OR pt.provider_transaction_id = $1)
          AND sign(pt.amount) = sign($2::numeric)
          AND ($3::timestamptz IS NULL OR pt.created_at BETWEEN ($3::timestamptz - interval '7 days') AND ($3::timestamptz + interval '7 days'))
        ORDER BY
            CASE WHEN pt.amount = $2::numeric THEN 0 ELSE 1 END,
            CASE WHEN NULLIF(TRIM(pt.provider_transaction_id), '') IS NULL THEN 0 ELSE 1 END,
            ABS(pt.amount - $2::numeric),
            pt.created_at DESC
        LIMIT 25
        "#,
    )
    .bind(&provider_transaction_id)
    .bind(processor_amount.round_dp(2))
    .bind(occurred_at)
    .fetch_all(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .into_iter()
    .map(|row| {
        let amount = row.get::<Decimal, _>("amount").round_dp(2);
        let provider_transaction_id_existing: Option<String> = row.get("provider_transaction_id");
        let mut warning_flags = Vec::new();
        if amount != processor_amount.round_dp(2) {
            warning_flags.push("Amount differs".to_string());
        }
        if provider_transaction_id_existing
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
        {
            warning_flags.push("Already has processor reference".to_string());
        }
        HelcimReconciliationCandidatePaymentRow {
            payment_transaction_id: row.get("id"),
            provider_transaction_id: provider_transaction_id_existing,
            amount: money_string(amount),
            payment_date: row.get("created_at"),
            payment_status: row.get("status"),
            provider_status: row.get("provider_status"),
            provider_batch_id: row.get("provider_batch_id"),
            warning_flags,
        }
    })
    .collect();
    Ok(Json(rows))
}

async fn link_helcim_reconciliation_payment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<HelcimReconciliationLinkRequest>,
) -> Result<Json<HelcimReconciliationActionResponse>, PaymentError> {
    let staff = require_payment_permission_any(
        &state,
        &headers,
        PAYMENTS_RECONCILE_LINK,
        &[PAYMENTS_RECONCILE],
    )
    .await?;
    let note = clean_required_note(Some(&payload.note), true)?;
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    let before = load_settlement_item_state_for_update(&mut tx, id).await?;
    let provider_transaction_id =
        json_string(&before, "provider_transaction_id").ok_or_else(|| {
            PaymentError::InvalidPayload("Issue has no processor reference to link.".to_string())
        })?;

    let processor = sqlx::query(
        r#"
        SELECT id, payment_transaction_id, gross_amount
        FROM payment_provider_batch_transactions
        WHERE provider = 'helcim'
          AND provider_transaction_id = $1
        FOR UPDATE
        "#,
    )
    .bind(&provider_transaction_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .ok_or_else(|| {
        PaymentError::InvalidPayload("Processor payment is not available to link.".to_string())
    })?;
    let existing_payment_id: Option<Uuid> = processor.get("payment_transaction_id");
    if existing_payment_id
        .filter(|existing| *existing != payload.payment_transaction_id)
        .is_some()
    {
        return Err(PaymentError::Conflict(
            "Processor payment is already linked to another Riverside payment.".to_string(),
        ));
    }
    let processor_amount: Decimal = processor
        .get::<Option<Decimal>, _>("gross_amount")
        .ok_or_else(|| PaymentError::InvalidPayload("Processor amount is not ready.".to_string()))?
        .round_dp(2);

    let payment = sqlx::query(
        r#"
        SELECT id, amount, payment_provider, provider_transaction_id
        FROM payment_transactions
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(payload.payment_transaction_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .ok_or_else(|| PaymentError::InvalidPayload("Riverside payment was not found.".to_string()))?;
    let payment_provider: Option<String> = payment.get("payment_provider");
    if payment_provider.as_deref() != Some("helcim") {
        return Err(PaymentError::InvalidPayload(
            "Only Helcim payments can be linked here.".to_string(),
        ));
    }
    let payment_amount = payment.get::<Decimal, _>("amount").round_dp(2);
    if payment_amount != processor_amount {
        return Err(PaymentError::InvalidPayload(
            "Payment amount does not match the processor amount.".to_string(),
        ));
    }
    let existing_provider_transaction_id: Option<String> = payment.get("provider_transaction_id");
    if existing_provider_transaction_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != provider_transaction_id)
        .is_some()
    {
        return Err(PaymentError::Conflict(
            "Riverside payment already has a different processor reference.".to_string(),
        ));
    }

    let linked_elsewhere: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM payment_provider_batch_transactions
            WHERE provider = 'helcim'
              AND payment_transaction_id = $1
              AND provider_transaction_id <> $2
        )
        "#,
    )
    .bind(payload.payment_transaction_id)
    .bind(&provider_transaction_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    if linked_elsewhere {
        return Err(PaymentError::Conflict(
            "Riverside payment is already linked to another processor payment.".to_string(),
        ));
    }

    sqlx::query(
        r#"
        UPDATE payment_provider_batch_transactions
        SET payment_transaction_id = $2,
            match_status = 'matched',
            match_type = 'manual_staff_link'
        WHERE provider = 'helcim'
          AND provider_transaction_id = $1
        "#,
    )
    .bind(&provider_transaction_id)
    .bind(payload.payment_transaction_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    sqlx::query(
        r#"
        UPDATE payment_transactions
        SET provider_transaction_id = $2
        WHERE id = $1
          AND payment_provider = 'helcim'
          AND NULLIF(TRIM(provider_transaction_id), '') IS NULL
        "#,
    )
    .bind(payload.payment_transaction_id)
    .bind(&provider_transaction_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    sqlx::query(
        r#"
        UPDATE payment_settlement_items
        SET status = 'resolved',
            resolved_by_staff_id = $2,
            resolved_at = now(),
            resolution_type = 'linked_payment',
            resolution_note = $3,
            payment_transaction_id = COALESCE(payment_transaction_id, $4)
        WHERE id = $1 AND provider = 'helcim'
        "#,
    )
    .bind(id)
    .bind(staff.id)
    .bind(note.as_deref())
    .bind(payload.payment_transaction_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let after = load_settlement_item_state(&mut *tx, id).await?;
    insert_settlement_item_event(
        &mut tx,
        id,
        Some(staff.id),
        "linked_payment",
        note.as_deref(),
        before,
        after,
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(Json(HelcimReconciliationActionResponse {
        item: load_helcim_reconciliation_item_by_id(&state, id).await?,
    }))
}

async fn list_helcim_operations_transactions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HelcimOperationsListQuery>,
) -> Result<Json<Vec<HelcimOperationsTransactionRow>>, PaymentError> {
    require_payment_permission_or_pos_staff(&state, &headers, PAYMENTS_VIEW, &[]).await?;
    let rows = load_helcim_transaction_rows(&state, &query, None).await?;
    Ok(Json(rows))
}

async fn get_helcim_operations_transaction_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<HelcimOperationsTransactionDetailResponse>, PaymentError> {
    require_payment_permission_or_pos_staff(&state, &headers, PAYMENTS_VIEW, &[]).await?;
    let payment_uuid = Uuid::parse_str(id.trim()).ok();
    let provider_transaction_id = payment_uuid
        .is_none()
        .then(|| id.trim().to_string())
        .filter(|value| !value.is_empty());

    let payment = sqlx::query(
        r#"
        SELECT
            pt.id,
            pt.created_at,
            pt.amount,
            pt.status,
            pt.payment_method,
            pt.payment_provider,
            pt.provider_payment_id,
            pt.provider_transaction_id,
            pt.provider_status,
            pt.provider_auth_code,
            pt.provider_card_type,
            pt.merchant_fee,
            pt.net_amount,
            pt.metadata,
            pt.session_id
        FROM payment_transactions pt
        WHERE pt.payment_provider = 'helcim'
          AND (($1::uuid IS NOT NULL AND pt.id = $1)
            OR ($2::text IS NOT NULL AND pt.provider_transaction_id = $2))
        LIMIT 1
        "#,
    )
    .bind(payment_uuid)
    .bind(provider_transaction_id.as_deref())
    .fetch_optional(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    let Some(payment) = payment else {
        return Err(PaymentError::InvalidPayload(
            "Payment not found.".to_string(),
        ));
    };
    let payment_id: Uuid = payment.get("id");
    let provider_tx: Option<String> = payment.get("provider_transaction_id");
    let fee_status = payment
        .get::<Value, _>("metadata")
        .get("helcim_fee_sync_status")
        .and_then(Value::as_str)
        .unwrap_or("not_ready")
        .to_string();
    let net_status = payment
        .get::<Value, _>("metadata")
        .get("helcim_net_sync_status")
        .and_then(Value::as_str)
        .unwrap_or("not_ready")
        .to_string();

    let processor = sqlx::query(
        r#"
        SELECT
            btx.id,
            btx.provider_batch_id,
            btx.provider_transaction_id,
            btx.transaction_type,
            btx.status,
            btx.currency,
            btx.occurred_at,
            btx.settled_at,
            btx.gross_amount,
            btx.fee_amount,
            btx.net_amount,
            btx.match_status,
            btx.match_type,
            btx.payment_provider_batch_id
        FROM payment_provider_batch_transactions btx
        WHERE btx.provider = 'helcim'
          AND (btx.payment_transaction_id = $1
            OR ($2::text IS NOT NULL AND btx.provider_transaction_id = $2))
        LIMIT 1
        "#,
    )
    .bind(payment_id)
    .bind(provider_tx.as_deref())
    .fetch_optional(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let batch_id = processor
        .as_ref()
        .and_then(|row| row.get::<Option<Uuid>, _>("payment_provider_batch_id"));
    let batch = if let Some(batch_id) = batch_id {
        sqlx::query(
            r#"
            SELECT id, provider_batch_id, status, closed_at, settled_at, expected_deposit_at,
                   gross_amount, fee_amount, net_amount, transaction_count, last_synced_at
            FROM payment_provider_batches
            WHERE id = $1
            "#,
        )
        .bind(batch_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
        .map(|row| {
            json!({
                "id": row.get::<Uuid, _>("id"),
                "provider_batch_id": row.get::<String, _>("provider_batch_id"),
                "status": row.get::<Option<String>, _>("status"),
                "closed_at": row.get::<Option<DateTime<Utc>>, _>("closed_at"),
                "settled_at": row.get::<Option<DateTime<Utc>>, _>("settled_at"),
                "expected_deposit_at": row.get::<Option<DateTime<Utc>>, _>("expected_deposit_at"),
                "gross_amount": money_option(row.get("gross_amount")),
                "fee_amount": money_option(row.get("fee_amount")),
                "net_amount": money_option(row.get("net_amount")),
                "transaction_count": row.get::<Option<i32>, _>("transaction_count"),
                "last_synced_at": row.get::<DateTime<Utc>, _>("last_synced_at"),
            })
        })
    } else {
        None
    };

    let issues = load_helcim_reconciliation_items(
        &state,
        &HelcimOperationsListQuery {
            limit: Some(100),
            ..Default::default()
        },
        Some(payment_id),
    )
    .await?;
    let timeline = load_helcim_payment_timeline(&state, payment_id, provider_tx.as_deref()).await?;

    Ok(Json(HelcimOperationsTransactionDetailResponse {
        riverside_payment: json!({
            "id": payment_id,
            "created_at": payment.get::<DateTime<Utc>, _>("created_at"),
            "amount": money_string(payment.get("amount")),
            "status": payment.get::<String, _>("status"),
            "payment_method": payment.get::<String, _>("payment_method"),
            "payment_provider": payment.get::<Option<String>, _>("payment_provider"),
            "provider_payment_id": payment.get::<Option<String>, _>("provider_payment_id"),
            "provider_transaction_id": provider_tx,
            "provider_status": payment.get::<Option<String>, _>("provider_status"),
            "provider_auth_code": payment.get::<Option<String>, _>("provider_auth_code"),
            "provider_card_type": payment.get::<Option<String>, _>("provider_card_type"),
            "session_id": payment.get::<Option<Uuid>, _>("session_id"),
        }),
        processor_payment: processor.map(|row| {
            json!({
                "id": row.get::<Uuid, _>("id"),
                "provider_batch_id": row.get::<String, _>("provider_batch_id"),
                "provider_transaction_id": row.get::<String, _>("provider_transaction_id"),
                "transaction_type": row.get::<Option<String>, _>("transaction_type"),
                "status": row.get::<Option<String>, _>("status"),
                "currency": row.get::<Option<String>, _>("currency"),
                "occurred_at": row.get::<Option<DateTime<Utc>>, _>("occurred_at"),
                "settled_at": row.get::<Option<DateTime<Utc>>, _>("settled_at"),
                "amount": money_option(row.get("gross_amount")),
                "fee_amount": money_option(row.get("fee_amount")),
                "net_amount": money_option(row.get("net_amount")),
                "match_status": row.get::<String, _>("match_status"),
                "match_type": row.get::<Option<String>, _>("match_type"),
            })
        }),
        batch,
        fee_details: json!({
            "fee_status": fee_status,
            "net_status": net_status,
            "fee_amount": if fee_status == "applied" { money_option(payment.get::<Option<Decimal>, _>("merchant_fee")) } else { None },
            "net_amount": if net_status == "applied" { money_option(payment.get::<Option<Decimal>, _>("net_amount")) } else { None },
        }),
        issues,
        timeline,
    }))
}

async fn list_helcim_sync_runs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HelcimOperationsListQuery>,
) -> Result<Json<Vec<HelcimSettlementRunSummary>>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_VIEW).await?;
    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            DateTime<Utc>,
            Option<DateTime<Utc>>,
            Value,
            Option<String>,
        ),
    >(
        r#"
        SELECT id, status, started_at, completed_at, summary, error_message
        FROM payment_settlement_runs
        WHERE provider = 'helcim'
        ORDER BY started_at DESC
        LIMIT $1
        "#,
    )
    .bind(clamp_limit(query.limit, 50, 200))
    .fetch_all(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .into_iter()
    .map(
        |(id, status, started_at, completed_at, summary, error_message)| {
            HelcimSettlementRunSummary {
                id,
                status,
                started_at,
                completed_at,
                summary,
                error_message,
            }
        },
    )
    .collect();
    Ok(Json(rows))
}

async fn get_helcim_events_health(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HelcimEventsHealthResponse>, PaymentError> {
    require_payment_permission_or_pos_staff(&state, &headers, PAYMENTS_VIEW, &[]).await?;
    #[derive(sqlx::FromRow)]
    struct HealthRow {
        recent_event_count: i64,
        failed_event_count: i64,
        ignored_event_count: i64,
        unmatched_event_count: i64,
        last_event_at: Option<DateTime<Utc>>,
        last_failed_message: Option<String>,
        last_failed_event_id: Option<Uuid>,
    }
    let row: HealthRow = sqlx::query_as(
        r#"
        SELECT
            COUNT(*) FILTER (WHERE received_at >= now() - interval '24 hours')::bigint AS recent_event_count,
            COUNT(*) FILTER (WHERE processing_status = 'failed')::bigint AS failed_event_count,
            COUNT(*) FILTER (WHERE processing_status = 'ignored')::bigint AS ignored_event_count,
            COUNT(*) FILTER (
                WHERE processing_status = 'processed'
                  AND COALESCE(match_type, 'none') = 'none'
                  AND event_type IN ('cardTransaction', 'terminalCancel')
                  AND received_at >= now() - interval '7 days'
            )::bigint AS unmatched_event_count,
            MAX(received_at) AS last_event_at,
            (
                SELECT error_message
                FROM helcim_event_log
                WHERE processing_status = 'failed'
                  AND error_message IS NOT NULL
                ORDER BY received_at DESC
                LIMIT 1
            ) AS last_failed_message,
            (
                SELECT id
                FROM helcim_event_log
                WHERE processing_status = 'failed'
                ORDER BY received_at DESC
                LIMIT 1
            ) AS last_failed_event_id
        FROM helcim_event_log
        WHERE provider = 'helcim'
        "#,
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let attempt_rows = sqlx::query(
        r#"
        SELECT
            ppa.id,
            ppa.status,
            ppa.amount_cents,
            ppa.currency,
            ppa.register_session_id,
            rs.register_lane,
            ppa.device_id,
            ppa.terminal_id,
            ppa.selected_terminal_key,
            ppa.provider_payment_id,
            ppa.provider_transaction_id,
            ppa.error_message,
            ppa.created_at,
            ppa.updated_at,
            ppa.completed_at
        FROM payment_provider_attempts ppa
        LEFT JOIN register_sessions rs ON rs.id = ppa.register_session_id
        WHERE ppa.provider = 'helcim'
          AND (
            ppa.status = 'pending'
            OR (ppa.status = 'expired' AND COALESCE(ppa.completed_at, ppa.updated_at) >= now() - interval '24 hours')
            OR (
                ppa.status IN ('approved', 'captured')
                AND COALESCE(ppa.completed_at, ppa.updated_at) >= now() - interval '24 hours'
                AND NOT EXISTS (
                    SELECT 1
                    FROM payment_transactions pt
                    WHERE pt.payment_provider = 'helcim'
                      AND (
                        pt.provider_transaction_id = ppa.provider_transaction_id
                        OR pt.provider_payment_id = ppa.provider_payment_id
                        OR pt.metadata->>'payment_provider_attempt_id' = ppa.id::text
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
        ORDER BY
            CASE
                WHEN ppa.status = 'pending' THEN 0
                WHEN ppa.status IN ('approved', 'captured') THEN 1
                WHEN ppa.status = 'expired' THEN 2
                ELSE 3
            END,
            ppa.created_at DESC
        LIMIT 25
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let event_rows = sqlx::query(
        r#"
        SELECT
            id,
            event_type,
            processing_status,
            received_at,
            error_message,
            provider_transaction_id,
            payment_provider_attempt_id,
            payment_transaction_id,
            match_type
        FROM helcim_event_log
        WHERE provider = 'helcim'
          AND (
            processing_status = 'failed'
            OR (
                processing_status = 'processed'
                AND COALESCE(match_type, 'none') = 'none'
                AND event_type IN ('cardTransaction', 'terminalCancel')
                AND received_at >= now() - interval '7 days'
            )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM helcim_terminal_recovery_actions hra
              WHERE hra.source_kind = 'helcim_event'
                AND hra.source_id = helcim_event_log.id
          )
        ORDER BY received_at DESC
        LIMIT 25
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let attempt_ids = attempt_rows
        .iter()
        .map(|attempt| attempt.get::<Uuid, _>("id"))
        .collect::<Vec<_>>();
    let event_ids = event_rows
        .iter()
        .map(|event| event.get::<Uuid, _>("id"))
        .collect::<Vec<_>>();
    let mut recovery_actions =
        load_helcim_terminal_recovery_actions(&state.db, &attempt_ids, &event_ids).await?;
    let helcim_status = helcim::HelcimConfig::from_env().status();
    let live_terminal_webhooks_expected =
        helcim_status.live_terminal_payments_ready && !helcim_status.simulator_enabled;
    let (
        webhook_delivery_status,
        webhook_delivery_label,
        webhook_delivery_detail,
        webhook_delivery_action,
    ) = if !live_terminal_webhooks_expected {
        (
            "not_required",
            "Webhook delivery not required",
            "Live Helcim terminal payments are not fully enabled, so webhook delivery is not required for this environment.",
            "Finish Helcim terminal setup before treating webhook delivery as a launch gate.",
        )
    } else if !helcim_status.webhook_secret_configured {
        (
            "not_configured",
            "Webhook signing secret missing",
            "Live terminal payments are enabled, but ROS cannot verify Helcim webhook deliveries until the signing secret is saved.",
            "Copy the verifier token from Helcim Webhooks into Settings -> Helcim Credentials.",
        )
    } else if row.last_event_at.is_none() {
        (
            "not_receiving",
            "No Helcim webhook deliveries received",
            "ROS has a webhook signing secret, but this server has not recorded any Helcim cardTransaction or terminalCancel delivery.",
            "In Helcim, set the public HTTPS delivery URL to /api/webhooks/helcim and enable cardTransaction plus terminalCancel.",
        )
    } else if row.failed_event_count > 0 {
        (
            "failed",
            "Helcim webhook delivery needs review",
            "ROS has received Helcim webhook deliveries, but at least one delivery failed processing.",
            "Open Payments Health, review the failed update, then replay only after the setup or data issue is corrected.",
        )
    } else if row.unmatched_event_count > 0 {
        (
            "unmatched",
            "Helcim webhook received but not attached",
            "ROS received signed Helcim events that could not be safely matched to a checkout attempt.",
            "Review Helcim Terminal Review before retrying or assuming the checkout is settled.",
        )
    } else {
        (
            "receiving",
            "Helcim webhook delivery active",
            "ROS has received signed Helcim webhook deliveries and has no failed or unmatched provider updates requiring review.",
            "No action needed.",
        )
    };

    let terminal_review_attempts = attempt_rows
        .into_iter()
        .map(|attempt| {
            let id: Uuid = attempt.get("id");
            let status: String = attempt.get("status");
            let amount_cents: i64 = attempt.get("amount_cents");
            let label = match status.as_str() {
                "pending" => "Terminal payment still waiting",
                "approved" | "captured" => "Provider approval not attached to checkout",
                "expired" => "Expired local terminal attempt",
                _ => "Terminal attempt needs review",
            }
            .to_string();
            let detail = match status.as_str() {
                "pending" => "This terminal attempt is still open in ROS. Do not start another card payment on the same terminal until the checkout or terminal status is clear.",
                "approved" | "captured" => "Provider approval exists for this attempt, but no ROS payment row was found. Review Helcim and the checkout before taking another payment.",
                "expired" => "ROS expired this local wait state. The provider outcome is not proven here, so review Helcim before retrying the card payment.",
                _ => "Review this terminal attempt before treating the checkout as settled.",
            }
            .to_string();
            HelcimTerminalReviewAttemptRow {
                id,
                status,
                amount: cents_to_decimal_string(amount_cents),
                currency: attempt.get("currency"),
                register_session_id: attempt.get("register_session_id"),
                register_lane: attempt.get("register_lane"),
                device_id: attempt.get("device_id"),
                terminal_id: attempt.get("terminal_id"),
                selected_terminal_key: attempt.get("selected_terminal_key"),
                provider_payment_id: attempt.get("provider_payment_id"),
                provider_transaction_id: attempt.get("provider_transaction_id"),
                error_message: attempt.get("error_message"),
                created_at: attempt.get("created_at"),
                updated_at: attempt.get("updated_at"),
                completed_at: attempt.get("completed_at"),
                label,
                detail,
                recovery_actions: recovery_actions
                    .remove(&("payment_provider_attempt".to_string(), id))
                    .unwrap_or_default(),
            }
        })
        .collect();

    let terminal_review_events = event_rows
        .into_iter()
        .map(|event| {
            let id: Uuid = event.get("id");
            let event_type: String = event.get("event_type");
            let processing_status: String = event.get("processing_status");
            let label = if processing_status == "failed" {
                "Payment update failed"
            } else if event_type == "cardTransaction" {
                "Provider event not attached to ROS checkout"
            } else if event_type == "terminalCancel" {
                "Terminal cancel not attached to ROS checkout"
            } else {
                "Provider event needs review"
            }
            .to_string();
            let detail = if processing_status == "failed" {
                "ROS recorded this webhook delivery but could not process it. Replay only after reviewing the error."
            } else if event_type == "cardTransaction" {
                "ROS recorded the signed Helcim provider event but did not attach it to a checkout. Review Helcim before assuming ROS recorded the payment."
            } else if event_type == "terminalCancel" {
                "ROS recorded the signed terminal cancel event but did not attach it to a pending checkout attempt."
            } else {
                "Review this provider event before taking follow-up payment action."
            }
            .to_string();
            HelcimTerminalReviewEventRow {
                id,
                event_type,
                processing_status,
                received_at: event.get("received_at"),
                error_message: event.get("error_message"),
                provider_transaction_id: event.get("provider_transaction_id"),
                payment_provider_attempt_id: event.get("payment_provider_attempt_id"),
                payment_transaction_id: event.get("payment_transaction_id"),
                match_type: event.get("match_type"),
                label,
                detail,
                recovery_actions: recovery_actions
                    .remove(&("helcim_event".to_string(), id))
                    .unwrap_or_default(),
            }
        })
        .collect();

    Ok(Json(HelcimEventsHealthResponse {
        recent_event_count: row.recent_event_count,
        failed_event_count: row.failed_event_count,
        ignored_event_count: row.ignored_event_count,
        unmatched_event_count: row.unmatched_event_count,
        last_event_at: row.last_event_at,
        last_failed_message: row.last_failed_message,
        last_failed_event_id: row.last_failed_event_id,
        webhook_delivery_status: webhook_delivery_status.to_string(),
        webhook_delivery_label: webhook_delivery_label.to_string(),
        webhook_delivery_detail: webhook_delivery_detail.to_string(),
        webhook_delivery_action: webhook_delivery_action.to_string(),
        terminal_review_attempts,
        terminal_review_events,
    }))
}

async fn replay_helcim_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(event_id): Path<Uuid>,
) -> Result<Json<webhooks::HelcimReplayOutcome>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_SYNC).await?;
    webhooks::replay_helcim_event(&state, event_id)
        .await
        .map(Json)
        .map_err(|error| PaymentError::InvalidPayload(error.to_string()))
}

async fn create_helcim_terminal_recovery_action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<HelcimTerminalRecoveryActionRequest>,
) -> Result<Json<HelcimTerminalRecoveryActionResponse>, PaymentError> {
    let source_kind = normalize_helcim_recovery_source_kind(&payload.source_kind)?;
    let action = normalize_helcim_recovery_action(&payload.action)?;
    let staff = match action.as_str() {
        "reviewed" | "noted" => {
            require_payment_permission_or_pos_staff(
                &state,
                &headers,
                PAYMENTS_RECONCILE_REVIEW,
                &[PAYMENTS_RECONCILE],
            )
            .await?
        }
        _ => {
            require_payment_permission_or_pos_staff(
                &state,
                &headers,
                PAYMENTS_RECONCILE_RESOLVE,
                &[PAYMENTS_RECONCILE],
            )
            .await?
        }
    };
    let note = clean_required_note(payload.note.as_deref(), action != "reviewed")?;
    ensure_helcim_recovery_source_exists(&state.db, &source_kind, payload.source_id).await?;

    let metadata = if payload.metadata.is_null() {
        json!({})
    } else {
        payload.metadata
    };

    let row = sqlx::query(
        r#"
        INSERT INTO helcim_terminal_recovery_actions (
            source_kind,
            source_id,
            action,
            note,
            actor_staff_id,
            metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, source_kind, source_id, action, note, actor_staff_id, created_at, metadata
        "#,
    )
    .bind(&source_kind)
    .bind(payload.source_id)
    .bind(&action)
    .bind(note.as_deref())
    .bind(staff.as_ref().map(|actor| actor.id))
    .bind(metadata)
    .fetch_one(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    Ok(Json(HelcimTerminalRecoveryActionResponse {
        action: helcim_terminal_recovery_action_from_row(&row),
    }))
}

fn normalize_helcim_recovery_source_kind(value: &str) -> Result<String, PaymentError> {
    match value.trim() {
        "payment_provider_attempt" => Ok("payment_provider_attempt".to_string()),
        "helcim_event" => Ok("helcim_event".to_string()),
        _ => Err(PaymentError::InvalidPayload(
            "Unsupported Helcim recovery source.".to_string(),
        )),
    }
}

fn normalize_helcim_recovery_action(value: &str) -> Result<String, PaymentError> {
    match value.trim() {
        "reviewed"
        | "noted"
        | "resolved_no_action"
        | "provider_charge_confirmed"
        | "duplicate_suspected"
        | "refund_required"
        | "replayed_webhook" => Ok(value.trim().to_string()),
        _ => Err(PaymentError::InvalidPayload(
            "Unsupported Helcim recovery action.".to_string(),
        )),
    }
}

async fn ensure_helcim_recovery_source_exists(
    db: &PgPool,
    source_kind: &str,
    source_id: Uuid,
) -> Result<(), PaymentError> {
    let exists: bool = match source_kind {
        "payment_provider_attempt" => {
            sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM payment_provider_attempts WHERE id = $1 AND provider = 'helcim')",
            )
            .bind(source_id)
            .fetch_one(db)
            .await
        }
        "helcim_event" => {
            sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM helcim_event_log WHERE id = $1 AND provider = 'helcim')",
            )
            .bind(source_id)
            .fetch_one(db)
            .await
        }
        _ => unreachable!(),
    }
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    if exists {
        Ok(())
    } else {
        Err(PaymentError::InvalidPayload(
            "Helcim recovery source was not found.".to_string(),
        ))
    }
}

async fn load_helcim_terminal_recovery_actions(
    db: &PgPool,
    attempt_ids: &[Uuid],
    event_ids: &[Uuid],
) -> Result<BTreeMap<(String, Uuid), Vec<HelcimTerminalRecoveryActionRow>>, PaymentError> {
    if attempt_ids.is_empty() && event_ids.is_empty() {
        return Ok(BTreeMap::new());
    }

    let rows = sqlx::query(
        r#"
        SELECT id, source_kind, source_id, action, note, actor_staff_id, created_at, metadata
        FROM helcim_terminal_recovery_actions
        WHERE (source_kind = 'payment_provider_attempt' AND source_id = ANY($1::uuid[]))
           OR (source_kind = 'helcim_event' AND source_id = ANY($2::uuid[]))
        ORDER BY created_at DESC
        "#,
    )
    .bind(attempt_ids)
    .bind(event_ids)
    .fetch_all(db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let mut actions: BTreeMap<(String, Uuid), Vec<HelcimTerminalRecoveryActionRow>> =
        BTreeMap::new();
    for row in rows {
        let action = helcim_terminal_recovery_action_from_row(&row);
        actions
            .entry((action.source_kind.clone(), action.source_id))
            .or_default()
            .push(action);
    }
    Ok(actions)
}

fn helcim_terminal_recovery_action_from_row(
    row: &sqlx::postgres::PgRow,
) -> HelcimTerminalRecoveryActionRow {
    HelcimTerminalRecoveryActionRow {
        id: row.get("id"),
        source_kind: row.get("source_kind"),
        source_id: row.get("source_id"),
        action: row.get("action"),
        note: row.get("note"),
        actor_staff_id: row.get("actor_staff_id"),
        created_at: row.get("created_at"),
        metadata: row.get("metadata"),
    }
}

async fn list_helcim_card_terminals(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, PaymentError> {
    require_payment_permission_or_pos_staff(&state, &headers, PAYMENTS_VIEW, &[]).await?;
    let config = helcim::HelcimConfig::from_env();
    helcim::list_card_terminals(&state.http_client, &config)
        .await
        .map(Json)
        .map_err(PaymentError::ProviderError)
}

async fn list_helcim_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HelcimDevicesQuery>,
) -> Result<Json<Value>, PaymentError> {
    require_payment_permission_or_pos_staff(&state, &headers, PAYMENTS_VIEW, &[]).await?;
    let config = helcim::HelcimConfig::from_env();
    let query = helcim::HelcimDevicesQuery {
        code: query.code,
        limit: query.limit,
        page: query.page,
    };
    helcim::list_devices(&state.http_client, &config, &query)
        .await
        .map(Json)
        .map_err(PaymentError::ProviderError)
}

async fn get_helcim_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Result<Json<Value>, PaymentError> {
    require_payment_permission_or_pos_staff(&state, &headers, PAYMENTS_VIEW, &[]).await?;
    let config = helcim::HelcimConfig::from_env();
    helcim::get_device(&state.http_client, &config, &code)
        .await
        .map(Json)
        .map_err(PaymentError::ProviderError)
}

async fn ping_helcim_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Result<Json<HelcimDeviceActionResponse>, PaymentError> {
    require_payment_permission_or_pos_staff(&state, &headers, PAYMENTS_SYNC, &[]).await?;
    let config = helcim::HelcimConfig::from_env();
    let normalized = code.trim().to_ascii_uppercase();
    let response = helcim::ping_device(&state.http_client, &config, &normalized)
        .await
        .map_err(PaymentError::ProviderError)?;
    Ok(Json(HelcimDeviceActionResponse {
        status: "accepted".to_string(),
        code: normalized,
        response,
    }))
}

async fn list_helcim_deposits(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HelcimOperationsListQuery>,
) -> Result<Json<Vec<HelcimDepositRow>>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_VIEW).await?;
    Ok(Json(load_helcim_deposit_rows(&state, None, &query).await?))
}

async fn create_helcim_manual_deposit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<HelcimManualDepositRequest>,
) -> Result<Json<HelcimDepositActionResponse>, PaymentError> {
    let staff = require_payment_permission(&state, &headers, PAYMENTS_DEPOSIT_ADJUST).await?;
    let amount = parse_money_input(&payload.amount)?;
    let source_system =
        clean_filter(payload.source_system.as_deref()).unwrap_or_else(|| "manual".to_string());
    let source_reference = clean_filter(payload.source_reference.as_deref());
    let qbo_deposit_id = clean_filter(payload.qbo_deposit_id.as_deref());
    let bank_feed_transaction_id = clean_filter(payload.bank_feed_transaction_id.as_deref());
    let currency = clean_filter(payload.currency.as_deref()).unwrap_or_else(|| "USD".to_string());
    let note = clean_required_note(payload.note.as_deref(), false)?;

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    let deposit_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO payment_actual_deposits (
            provider,
            source_system,
            source_reference,
            qbo_deposit_id,
            bank_feed_transaction_id,
            posted_at,
            amount,
            currency,
            status,
            raw_payload
        )
        VALUES ('helcim', $1, $2, $3, $4, $5, $6, $7, 'open', $8)
        RETURNING id
        "#,
    )
    .bind(&source_system)
    .bind(source_reference.as_deref())
    .bind(qbo_deposit_id.as_deref())
    .bind(bank_feed_transaction_id.as_deref())
    .bind(payload.posted_at)
    .bind(amount.round_dp(2))
    .bind(&currency)
    .bind(json!({
        "source": "manual_staff_entry",
        "qbo_deposit_id": qbo_deposit_id,
        "bank_feed_transaction_id": bank_feed_transaction_id,
    }))
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        if is_unique_violation(&e) {
            PaymentError::Conflict(
                "A deposit with that source reference already exists.".to_string(),
            )
        } else {
            PaymentError::InvalidPayload(e.to_string())
        }
    })?;
    let after = load_deposit_state(&mut *tx, deposit_id).await?;
    insert_deposit_event(
        &mut tx,
        deposit_id,
        Some(staff.id),
        "created",
        note.as_deref(),
        json!({}),
        after,
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(Json(HelcimDepositActionResponse {
        deposit: load_helcim_deposit_detail(&state, deposit_id).await?,
    }))
}

async fn get_helcim_deposit_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<HelcimDepositDetailResponse>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_VIEW).await?;
    Ok(Json(load_helcim_deposit_detail(&state, id).await?))
}

async fn link_helcim_deposit_batches(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<HelcimDepositLinkBatchesRequest>,
) -> Result<Json<HelcimDepositActionResponse>, PaymentError> {
    let staff = require_payment_permission(&state, &headers, PAYMENTS_DEPOSIT_LINK).await?;
    let note = clean_required_note(Some(&payload.note), true)?;
    if payload.batch_ids.is_empty() {
        return Err(PaymentError::InvalidPayload(
            "Select at least one expected batch.".to_string(),
        ));
    }
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    let before = load_deposit_state_for_update(&mut tx, id).await?;
    for batch_id in payload.batch_ids {
        let batch = sqlx::query(
            r#"
            SELECT id, provider_batch_id, net_amount
            FROM payment_provider_batches
            WHERE provider = 'helcim'
              AND id = $1
            "#,
        )
        .bind(batch_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
        .ok_or_else(|| PaymentError::InvalidPayload("Expected batch was not found.".to_string()))?;
        let provider_batch_id: String = batch.get("provider_batch_id");
        let expected_net_amount: Option<Decimal> = batch.get("net_amount");
        sqlx::query(
            r#"
            INSERT INTO payment_actual_deposit_batches (
                deposit_id,
                payment_provider_batch_id,
                provider_batch_id,
                expected_net_amount,
                linked_amount,
                match_type,
                status
            )
            VALUES ($1, $2, $3, $4, $4, 'manual', 'linked')
            ON CONFLICT (deposit_id, payment_provider_batch_id) DO NOTHING
            "#,
        )
        .bind(id)
        .bind(batch_id)
        .bind(&provider_batch_id)
        .bind(expected_net_amount.map(|value| value.round_dp(2)))
        .execute(&mut *tx)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    }
    refresh_deposit_match_status(&mut tx, id).await?;
    create_deposit_amount_item_if_needed(&mut tx, None, id).await?;
    let after = load_deposit_state(&mut *tx, id).await?;
    insert_deposit_event(
        &mut tx,
        id,
        Some(staff.id),
        "linked_batch",
        note.as_deref(),
        before,
        after,
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(Json(HelcimDepositActionResponse {
        deposit: load_helcim_deposit_detail(&state, id).await?,
    }))
}

async fn add_helcim_deposit_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<HelcimDepositNoteRequest>,
) -> Result<Json<HelcimDepositActionResponse>, PaymentError> {
    let staff = require_payment_permission(&state, &headers, PAYMENTS_DEPOSIT_REVIEW).await?;
    let note = clean_required_note(Some(&payload.note), true)?;
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    let before = load_deposit_state_for_update(&mut tx, id).await?;
    insert_deposit_event(
        &mut tx,
        id,
        Some(staff.id),
        "noted",
        note.as_deref(),
        before.clone(),
        before,
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(Json(HelcimDepositActionResponse {
        deposit: load_helcim_deposit_detail(&state, id).await?,
    }))
}

async fn review_helcim_deposit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<HelcimDepositReviewRequest>,
) -> Result<Json<HelcimDepositActionResponse>, PaymentError> {
    let staff = if payload.accept_variance {
        require_payment_permission(&state, &headers, PAYMENTS_DEPOSIT_ADJUST).await?
    } else {
        require_payment_permission(&state, &headers, PAYMENTS_DEPOSIT_REVIEW).await?
    };
    let note = clean_required_note(payload.note.as_deref(), payload.accept_variance)?;
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    let before = load_deposit_state_for_update(&mut tx, id).await?;
    let difference = deposit_difference(&mut *tx, id).await?;
    let status = if difference == Some(Decimal::ZERO) {
        "matched"
    } else if payload.accept_variance {
        "reviewed"
    } else {
        "needs_review"
    };
    sqlx::query(
        r#"
        UPDATE payment_actual_deposits
        SET status = $2,
            reviewed_by_staff_id = $3,
            reviewed_at = now()
        WHERE id = $1
          AND provider = 'helcim'
        "#,
    )
    .bind(id)
    .bind(status)
    .bind(staff.id)
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    if payload.accept_variance {
        sqlx::query(
            r#"
            UPDATE payment_deposit_reconciliation_items
            SET status = 'resolved',
                resolved_at = now()
            WHERE provider = 'helcim'
              AND deposit_id = $1
              AND status = 'open'
              AND item_type IN ('deposit_amount_mismatch', 'partial_deposit')
            "#,
        )
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    }
    let after = load_deposit_state(&mut *tx, id).await?;
    insert_deposit_event(
        &mut tx,
        id,
        Some(staff.id),
        if payload.accept_variance {
            "accepted_variance"
        } else {
            "reviewed"
        },
        note.as_deref(),
        before,
        after,
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(Json(HelcimDepositActionResponse {
        deposit: load_helcim_deposit_detail(&state, id).await?,
    }))
}

async fn reopen_helcim_deposit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<HelcimDepositActionResponse>, PaymentError> {
    let staff = require_payment_permission(&state, &headers, PAYMENTS_DEPOSIT_REVIEW).await?;
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    let before = load_deposit_state_for_update(&mut tx, id).await?;
    sqlx::query(
        r#"
        UPDATE payment_actual_deposits
        SET status = 'reopened',
            reviewed_by_staff_id = NULL,
            reviewed_at = NULL
        WHERE id = $1
          AND provider = 'helcim'
        "#,
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    let after = load_deposit_state(&mut *tx, id).await?;
    insert_deposit_event(&mut tx, id, Some(staff.id), "reopened", None, before, after).await?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(Json(HelcimDepositActionResponse {
        deposit: load_helcim_deposit_detail(&state, id).await?,
    }))
}

async fn list_helcim_unmatched_deposit_batches(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HelcimOperationsListQuery>,
) -> Result<Json<Vec<HelcimBatchListRow>>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_VIEW).await?;
    let rows = sqlx::query(
        r#"
        SELECT
            batch.id,
            batch.provider_batch_id,
            batch.status,
            batch.closed_at,
            batch.settled_at,
            batch.expected_deposit_at,
            batch.gross_amount,
            batch.fee_amount,
            batch.net_amount,
            batch.transaction_count,
            batch.last_synced_at,
            COALESCE(issues.issue_count, 0)::bigint AS issue_count,
            COALESCE(completeness.fee_not_ready_count, 0)::bigint AS fee_not_ready_count,
            COALESCE(completeness.net_not_ready_count, 0)::bigint AS net_not_ready_count
        FROM payment_provider_batches batch
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::bigint AS issue_count
            FROM payment_deposit_reconciliation_items item
            WHERE item.provider = 'helcim'
              AND item.status = 'open'
              AND item.payment_provider_batch_id = batch.id
        ) issues ON true
        LEFT JOIN LATERAL (
            SELECT
                COUNT(*) FILTER (WHERE btx.fee_amount IS NULL)::bigint AS fee_not_ready_count,
                COUNT(*) FILTER (WHERE btx.net_amount IS NULL)::bigint AS net_not_ready_count
            FROM payment_provider_batch_transactions btx
            WHERE btx.provider = 'helcim'
              AND btx.payment_provider_batch_id = batch.id
        ) completeness ON true
        WHERE batch.provider = 'helcim'
          AND batch.net_amount IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM payment_actual_deposit_batches link
            WHERE link.payment_provider_batch_id = batch.id
              AND link.status = 'linked'
          )
          AND ($1::date IS NULL OR (COALESCE(batch.expected_deposit_at, batch.settled_at, batch.closed_at, batch.last_synced_at) AT TIME ZONE 'America/New_York')::date >= $1)
          AND ($2::date IS NULL OR (COALESCE(batch.expected_deposit_at, batch.settled_at, batch.closed_at, batch.last_synced_at) AT TIME ZONE 'America/New_York')::date <= $2)
        ORDER BY COALESCE(batch.expected_deposit_at, batch.settled_at, batch.closed_at, batch.last_synced_at) DESC
        LIMIT $3
        "#,
    )
    .bind(query.date_from)
    .bind(query.date_to)
    .bind(clamp_limit(query.limit, 100, 500))
    .fetch_all(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .into_iter()
    .map(batch_row_from_pg)
    .collect();
    Ok(Json(rows))
}

async fn list_helcim_unmatched_deposits(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HelcimOperationsListQuery>,
) -> Result<Json<Vec<HelcimDepositRow>>, PaymentError> {
    require_payment_permission(&state, &headers, PAYMENTS_VIEW).await?;
    let rows = load_helcim_deposit_rows(&state, None, &query)
        .await?
        .into_iter()
        .filter(|row| row.linked_batch_count == 0)
        .collect();
    Ok(Json(rows))
}

async fn run_helcim_deposit_reconciliation(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Option<Json<HelcimSettlementSyncRequest>>,
) -> Result<Json<HelcimDepositReconciliationRunResponse>, PaymentError> {
    let staff = require_payment_permission(&state, &headers, PAYMENTS_DEPOSIT_REVIEW).await?;
    let payload = payload
        .map(|Json(payload)| payload)
        .unwrap_or(HelcimSettlementSyncRequest {
            date_from: None,
            date_to: None,
        });
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    let run_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO payment_deposit_reconciliation_runs (
            provider,
            status,
            date_from,
            date_to,
            requested_by_staff_id
        )
        VALUES ('helcim', 'running', $1, $2, $3)
        RETURNING id
        "#,
    )
    .bind(payload.date_from)
    .bind(payload.date_to)
    .bind(staff.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    let stats =
        create_deposit_reconciliation_items(&mut tx, run_id, payload.date_from, payload.date_to)
            .await?;
    sqlx::query(
        r#"
        UPDATE payment_deposit_reconciliation_runs
        SET status = 'completed',
            completed_at = now(),
            summary = $2
        WHERE id = $1
        "#,
    )
    .bind(run_id)
    .bind(json!({
        "expected_batches_missing_actual": stats.expected_batches_missing_actual,
        "actual_deposits_missing_expected": stats.actual_deposits_missing_expected,
        "amount_mismatches": stats.amount_mismatches,
        "date_mismatches": stats.date_mismatches,
        "duplicate_references": stats.duplicate_references,
        "items_opened": stats.items_opened,
    }))
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(Json(HelcimDepositReconciliationRunResponse {
        run_id,
        status: "completed".to_string(),
        expected_batches_missing_actual: stats.expected_batches_missing_actual,
        actual_deposits_missing_expected: stats.actual_deposits_missing_expected,
        amount_mismatches: stats.amount_mismatches,
        date_mismatches: stats.date_mismatches,
        duplicate_references: stats.duplicate_references,
        items_opened: stats.items_opened,
    }))
}

#[derive(Debug, Default)]
struct HelcimSettlementSyncStats {
    payments_scanned: i64,
    batches_upserted: i64,
    batch_transactions_upserted: i64,
    reconciliation_items_opened: i64,
    missing_batch_rows: i64,
    unmatched_processor_rows: i64,
    amount_mismatches: i64,
    status_mismatches: i64,
    fee_mismatches: i64,
    net_mismatches: i64,
    helcim_batches_fetched: i64,
    helcim_batch_transactions_fetched: i64,
}

#[derive(Debug, Default)]
struct HelcimProcessorSettlementData {
    batches: Vec<helcim::HelcimCardBatchSnapshot>,
    transactions: Vec<helcim::HelcimBatchTransactionSnapshot>,
}

async fn fetch_helcim_processor_settlement_data(
    http: &reqwest::Client,
    config: &helcim::HelcimConfig,
    date_from: Option<NaiveDate>,
    date_to: Option<NaiveDate>,
) -> Result<HelcimProcessorSettlementData, String> {
    const LIMIT: i32 = 1000;

    let mut discovered_transactions = Vec::new();
    let mut page = 1_i32;
    loop {
        let rows = helcim::list_card_transactions(
            http,
            config,
            &helcim::HelcimCardTransactionsQuery {
                date_from,
                date_to,
                card_batch_id: None,
                limit: Some(LIMIT),
                page: Some(page),
            },
        )
        .await?;
        let row_count = rows.len();
        discovered_transactions.extend(rows);
        if row_count < LIMIT as usize {
            break;
        }
        page += 1;
    }

    let batch_ids: BTreeSet<String> = discovered_transactions
        .iter()
        .map(|transaction| transaction.provider_batch_id.trim().to_string())
        .filter(|batch_id| !batch_id.is_empty())
        .collect();

    let mut batches = BTreeMap::new();
    let mut transactions = BTreeMap::new();
    for transaction in discovered_transactions {
        transactions.insert(transaction.provider_transaction_id.clone(), transaction);
    }

    for batch_id in batch_ids {
        let batch = helcim::fetch_card_batch(http, config, &batch_id).await?;
        batches.insert(batch.provider_batch_id.clone(), batch);

        let mut page = 1_i32;
        loop {
            let rows = helcim::list_card_transactions_for_batch(
                http,
                config,
                &batch_id,
                Some(LIMIT),
                Some(page),
            )
            .await?;
            let row_count = rows.len();
            for transaction in rows {
                transactions.insert(transaction.provider_transaction_id.clone(), transaction);
            }
            if row_count < LIMIT as usize {
                break;
            }
            page += 1;
        }
    }

    Ok(HelcimProcessorSettlementData {
        batches: batches.into_values().collect(),
        transactions: transactions.into_values().collect(),
    })
}

async fn sync_helcim_settlement_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    run_id: Uuid,
    date_from: Option<NaiveDate>,
    date_to: Option<NaiveDate>,
    processor_data: Option<&HelcimProcessorSettlementData>,
) -> Result<HelcimSettlementSyncStats, PaymentError> {
    #[derive(sqlx::FromRow)]
    struct PaymentRow {
        id: Uuid,
        provider_transaction_id: Option<String>,
        provider_status: Option<String>,
        status: String,
        amount: Decimal,
        merchant_fee: Decimal,
        net_amount: Decimal,
        fee_sync_status: Option<String>,
        net_sync_status: Option<String>,
        batch_id: Option<String>,
        created_at: DateTime<Utc>,
    }

    let payments: Vec<PaymentRow> = sqlx::query_as(
        r#"
        SELECT
            id,
            provider_transaction_id,
            provider_status,
            status,
            amount,
            merchant_fee,
            net_amount,
            metadata->>'helcim_fee_sync_status' AS fee_sync_status,
            metadata->>'helcim_net_sync_status' AS net_sync_status,
            metadata->>'helcim_card_batch_id' AS batch_id,
            created_at
        FROM payment_transactions
        WHERE payment_provider = 'helcim'
          AND ($1::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date >= $1)
          AND ($2::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date <= $2)
        ORDER BY created_at ASC, id ASC
        "#,
    )
    .bind(date_from)
    .bind(date_to)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let mut stats = HelcimSettlementSyncStats {
        payments_scanned: payments.len() as i64,
        ..Default::default()
    };

    if let Some(processor_data) = processor_data {
        stats.helcim_batches_fetched = processor_data.batches.len() as i64;
        stats.helcim_batch_transactions_fetched = processor_data.transactions.len() as i64;
        upsert_helcim_processor_settlement_data(tx, processor_data, &mut stats).await?;
    }

    for payment in payments {
        let provider_transaction_id = payment
            .provider_transaction_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let batch_id = payment
            .batch_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        let Some(provider_transaction_id) = provider_transaction_id else {
            stats.reconciliation_items_opened += insert_settlement_item(
                tx,
                run_id,
                "missing_provider_transaction_id",
                "warning",
                None,
                None,
                Some(payment.id),
                None,
                json!({}),
                json!({
                    "payment_transaction_id": payment.id,
                    "amount": payment.amount.to_string(),
                    "status": payment.status,
                }),
                "ROS Helcim payment is missing a provider transaction ID.",
            )
            .await?;
            continue;
        };

        if processor_data.is_some() {
            let exists: bool = sqlx::query_scalar(
                r#"
                SELECT EXISTS (
                    SELECT 1
                    FROM payment_provider_batch_transactions
                    WHERE provider = 'helcim'
                      AND provider_transaction_id = $1
                )
                "#,
            )
            .bind(&provider_transaction_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
            if !exists {
                stats.missing_batch_rows += 1;
                stats.reconciliation_items_opened += insert_settlement_item(
                    tx,
                    run_id,
                    "ros_payment_missing_processor_batch",
                    "warning",
                    batch_id.as_deref(),
                    Some(&provider_transaction_id),
                    Some(payment.id),
                    None,
                    json!({ "provider_transaction_id": provider_transaction_id }),
                    json!({
                        "payment_transaction_id": payment.id,
                        "amount": payment.amount.to_string(),
                        "provider_status": payment.provider_status,
                        "status": payment.status,
                        "local_batch_id": batch_id,
                    }),
                    "ROS Helcim payment was not found in the synced Helcim processor batch data.",
                )
                .await?;
            }
            continue;
        }

        let Some(batch_id) = batch_id else {
            stats.missing_batch_rows += 1;
            stats.reconciliation_items_opened += insert_settlement_item(
                tx,
                run_id,
                "missing_processor_batch_row",
                "warning",
                None,
                Some(&provider_transaction_id),
                Some(payment.id),
                None,
                json!({ "provider_transaction_id": provider_transaction_id }),
                json!({
                    "payment_transaction_id": payment.id,
                    "amount": payment.amount.to_string(),
                    "provider_status": payment.provider_status,
                    "status": payment.status,
                }),
                "ROS Helcim payment has no first-class processor batch membership yet.",
            )
            .await?;
            continue;
        };

        let batch_uuid: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO payment_provider_batches (
                provider,
                provider_batch_id,
                status,
                raw_payload,
                last_synced_at
            )
            VALUES (
                'helcim',
                $1,
                'observed',
                $2,
                now()
            )
            ON CONFLICT (provider, provider_batch_id)
            DO UPDATE SET
                status = COALESCE(payment_provider_batches.status, EXCLUDED.status),
                raw_payload = COALESCE(payment_provider_batches.raw_payload, '{}'::jsonb) || EXCLUDED.raw_payload,
                last_synced_at = now()
            RETURNING id
            "#,
        )
        .bind(&batch_id)
        .bind(json!({
            "source": "payment_transactions.metadata.helcim_card_batch_id",
            "helcim_batch_api_available": false,
        }))
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
        stats.batches_upserted += 1;

        let explicit_fee = payment
            .fee_sync_status
            .as_deref()
            .filter(|status| *status == "applied")
            .map(|_| payment.merchant_fee.round_dp(2));
        let explicit_net = payment
            .net_sync_status
            .as_deref()
            .filter(|status| *status == "applied")
            .map(|_| payment.net_amount.round_dp(2));

        sqlx::query(
            r#"
            INSERT INTO payment_provider_batch_transactions (
                provider,
                provider_batch_id,
                provider_transaction_id,
                payment_provider_batch_id,
                payment_transaction_id,
                status,
                occurred_at,
                gross_amount,
                fee_amount,
                net_amount,
                match_status,
                match_type,
                raw_payload,
                last_synced_at
            )
            VALUES (
                'helcim',
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                'matched',
                'provider_transaction_id',
                $10,
                now()
            )
            ON CONFLICT (provider, provider_transaction_id)
            DO UPDATE SET
                provider_batch_id = EXCLUDED.provider_batch_id,
                payment_provider_batch_id = EXCLUDED.payment_provider_batch_id,
                payment_transaction_id = COALESCE(payment_provider_batch_transactions.payment_transaction_id, EXCLUDED.payment_transaction_id),
                status = COALESCE(EXCLUDED.status, payment_provider_batch_transactions.status),
                occurred_at = COALESCE(payment_provider_batch_transactions.occurred_at, EXCLUDED.occurred_at),
                gross_amount = COALESCE(EXCLUDED.gross_amount, payment_provider_batch_transactions.gross_amount),
                fee_amount = COALESCE(EXCLUDED.fee_amount, payment_provider_batch_transactions.fee_amount),
                net_amount = COALESCE(EXCLUDED.net_amount, payment_provider_batch_transactions.net_amount),
                match_status = 'matched',
                match_type = 'provider_transaction_id',
                raw_payload = COALESCE(payment_provider_batch_transactions.raw_payload, '{}'::jsonb) || EXCLUDED.raw_payload,
                last_synced_at = now()
            "#,
        )
        .bind(&batch_id)
        .bind(&provider_transaction_id)
        .bind(batch_uuid)
        .bind(payment.id)
        .bind(payment.provider_status.as_deref())
        .bind(payment.created_at)
        .bind(payment.amount.round_dp(2))
        .bind(explicit_fee)
        .bind(explicit_net)
        .bind(json!({
            "source": "payment_transactions",
            "payment_transaction_id": payment.id,
            "fee_explicit": explicit_fee.is_some(),
            "net_explicit": explicit_net.is_some(),
        }))
        .execute(&mut **tx)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
        stats.batch_transactions_upserted += 1;
    }

    sqlx::query(
        r#"
        UPDATE payment_provider_batches batch
        SET
            gross_amount = totals.gross_amount,
            fee_amount = totals.fee_amount,
            net_amount = totals.net_amount,
            transaction_count = totals.transaction_count,
            last_synced_at = now()
        FROM (
            SELECT
                payment_provider_batch_id,
                COALESCE(SUM(gross_amount), 0)::numeric(12,2) AS gross_amount,
                SUM(fee_amount)::numeric(12,2) AS fee_amount,
                SUM(net_amount)::numeric(12,2) AS net_amount,
                COUNT(*)::integer AS transaction_count
            FROM payment_provider_batch_transactions
            WHERE provider = 'helcim'
              AND payment_provider_batch_id IS NOT NULL
            GROUP BY payment_provider_batch_id
        ) totals
        WHERE batch.id = totals.payment_provider_batch_id
          AND batch.provider = 'helcim'
        "#,
    )
    .execute(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    stats.reconciliation_items_opened +=
        create_existing_batch_transaction_findings(tx, run_id, &mut stats).await?;

    Ok(stats)
}

async fn upsert_helcim_processor_settlement_data(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    processor_data: &HelcimProcessorSettlementData,
    stats: &mut HelcimSettlementSyncStats,
) -> Result<(), PaymentError> {
    let mut batch_ids: BTreeMap<String, Uuid> = BTreeMap::new();
    for batch in &processor_data.batches {
        let redacted_raw_payload = helcim::redact_provider_payload(&batch.raw_payload);
        let batch_uuid: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO payment_provider_batches (
                provider,
                provider_batch_id,
                status,
                currency,
                opened_at,
                closed_at,
                settled_at,
                expected_deposit_at,
                gross_amount,
                fee_amount,
                net_amount,
                transaction_count,
                raw_payload,
                last_synced_at
            )
            VALUES (
                'helcim',
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                now()
            )
            ON CONFLICT (provider, provider_batch_id)
            DO UPDATE SET
                status = COALESCE(EXCLUDED.status, payment_provider_batches.status),
                currency = COALESCE(EXCLUDED.currency, payment_provider_batches.currency),
                opened_at = COALESCE(EXCLUDED.opened_at, payment_provider_batches.opened_at),
                closed_at = COALESCE(EXCLUDED.closed_at, payment_provider_batches.closed_at),
                settled_at = COALESCE(EXCLUDED.settled_at, payment_provider_batches.settled_at),
                expected_deposit_at = COALESCE(EXCLUDED.expected_deposit_at, payment_provider_batches.expected_deposit_at),
                gross_amount = COALESCE(EXCLUDED.gross_amount, payment_provider_batches.gross_amount),
                fee_amount = COALESCE(EXCLUDED.fee_amount, payment_provider_batches.fee_amount),
                net_amount = COALESCE(EXCLUDED.net_amount, payment_provider_batches.net_amount),
                transaction_count = COALESCE(EXCLUDED.transaction_count, payment_provider_batches.transaction_count),
                raw_payload = EXCLUDED.raw_payload,
                last_synced_at = now()
            RETURNING id
            "#,
        )
        .bind(&batch.provider_batch_id)
        .bind(batch.status.as_deref())
        .bind(batch.currency.as_deref())
        .bind(batch.opened_at)
        .bind(batch.closed_at)
        .bind(batch.settled_at)
        .bind(batch.expected_deposit_at)
        .bind(batch.gross_amount.map(|amount| amount.round_dp(2)))
        .bind(batch.fee_amount.map(|amount| amount.round_dp(2)))
        .bind(batch.net_amount.map(|amount| amount.round_dp(2)))
        .bind(batch.transaction_count)
        .bind(&redacted_raw_payload)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
        batch_ids.insert(batch.provider_batch_id.clone(), batch_uuid);
        stats.batches_upserted += 1;
    }

    for transaction in &processor_data.transactions {
        let redacted_raw_payload = helcim::redact_provider_payload(&transaction.raw_payload);
        let batch_uuid = if let Some(batch_uuid) = batch_ids.get(&transaction.provider_batch_id) {
            *batch_uuid
        } else {
            let batch_uuid: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO payment_provider_batches (
                    provider,
                    provider_batch_id,
                    status,
                    raw_payload,
                    last_synced_at
                )
                VALUES (
                    'helcim',
                    $1,
                    'observed',
                    $2,
                    now()
                )
                ON CONFLICT (provider, provider_batch_id)
                DO UPDATE SET
                    raw_payload = COALESCE(payment_provider_batches.raw_payload, '{}'::jsonb) || EXCLUDED.raw_payload,
                    last_synced_at = now()
                RETURNING id
                "#,
            )
            .bind(&transaction.provider_batch_id)
            .bind(json!({
                "source": "helcim_card_transaction.cardBatchId",
                "provider_batch_id": transaction.provider_batch_id,
            }))
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
            batch_ids.insert(transaction.provider_batch_id.clone(), batch_uuid);
            stats.batches_upserted += 1;
            batch_uuid
        };

        let payment_transaction_id: Option<Uuid> = sqlx::query_scalar(
            r#"
            SELECT id
            FROM payment_transactions
            WHERE payment_provider = 'helcim'
              AND provider_transaction_id = $1
            LIMIT 1
            "#,
        )
        .bind(&transaction.provider_transaction_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
        let match_status = if payment_transaction_id.is_some() {
            "matched"
        } else {
            "unmatched"
        };
        let match_type = payment_transaction_id
            .map(|_| "provider_transaction_id")
            .map(str::to_string);

        sqlx::query(
            r#"
            INSERT INTO payment_provider_batch_transactions (
                provider,
                provider_batch_id,
                provider_transaction_id,
                payment_provider_batch_id,
                payment_transaction_id,
                transaction_type,
                status,
                currency,
                occurred_at,
                settled_at,
                gross_amount,
                fee_amount,
                net_amount,
                match_status,
                match_type,
                raw_payload,
                last_synced_at
            )
            VALUES (
                'helcim',
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                $13,
                $14,
                $15,
                now()
            )
            ON CONFLICT (provider, provider_transaction_id)
            DO UPDATE SET
                provider_batch_id = EXCLUDED.provider_batch_id,
                payment_provider_batch_id = EXCLUDED.payment_provider_batch_id,
                payment_transaction_id = COALESCE(payment_provider_batch_transactions.payment_transaction_id, EXCLUDED.payment_transaction_id),
                transaction_type = COALESCE(EXCLUDED.transaction_type, payment_provider_batch_transactions.transaction_type),
                status = COALESCE(EXCLUDED.status, payment_provider_batch_transactions.status),
                currency = COALESCE(EXCLUDED.currency, payment_provider_batch_transactions.currency),
                occurred_at = COALESCE(EXCLUDED.occurred_at, payment_provider_batch_transactions.occurred_at),
                settled_at = COALESCE(EXCLUDED.settled_at, payment_provider_batch_transactions.settled_at),
                gross_amount = COALESCE(EXCLUDED.gross_amount, payment_provider_batch_transactions.gross_amount),
                fee_amount = COALESCE(EXCLUDED.fee_amount, payment_provider_batch_transactions.fee_amount),
                net_amount = COALESCE(EXCLUDED.net_amount, payment_provider_batch_transactions.net_amount),
                match_status = CASE
                    WHEN EXCLUDED.payment_transaction_id IS NOT NULL THEN 'matched'
                    ELSE payment_provider_batch_transactions.match_status
                END,
                match_type = COALESCE(EXCLUDED.match_type, payment_provider_batch_transactions.match_type),
                raw_payload = EXCLUDED.raw_payload,
                last_synced_at = now()
            "#,
        )
        .bind(&transaction.provider_batch_id)
        .bind(&transaction.provider_transaction_id)
        .bind(batch_uuid)
        .bind(payment_transaction_id)
        .bind(transaction.transaction_type.as_deref())
        .bind(transaction.status.as_deref())
        .bind(transaction.currency.as_deref())
        .bind(transaction.occurred_at)
        .bind(transaction.settled_at)
        .bind(transaction.gross_amount.map(|amount| amount.round_dp(2)))
        .bind(transaction.fee_amount.map(|amount| amount.round_dp(2)))
        .bind(transaction.net_amount.map(|amount| amount.round_dp(2)))
        .bind(match_status)
        .bind(match_type.as_deref())
        .bind(&redacted_raw_payload)
        .execute(&mut **tx)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
        stats.batch_transactions_upserted += 1;
    }

    Ok(())
}

async fn create_existing_batch_transaction_findings(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    run_id: Uuid,
    stats: &mut HelcimSettlementSyncStats,
) -> Result<i64, PaymentError> {
    let rows = sqlx::query(
        r#"
        SELECT
            btx.id AS batch_transaction_id,
            btx.provider_batch_id,
            btx.provider_transaction_id,
            btx.payment_provider_batch_id,
            btx.payment_transaction_id,
            btx.status AS processor_status,
            btx.gross_amount AS processor_amount,
            btx.fee_amount AS processor_fee,
            btx.net_amount AS processor_net,
            pt.status AS ros_status,
            pt.provider_status AS ros_provider_status,
            pt.amount AS ros_amount,
            pt.merchant_fee AS ros_fee,
            pt.net_amount AS ros_net,
            pt.metadata->>'helcim_fee_sync_status' AS ros_fee_status,
            pt.metadata->>'helcim_net_sync_status' AS ros_net_status
        FROM payment_provider_batch_transactions btx
        LEFT JOIN payment_transactions pt ON pt.id = btx.payment_transaction_id
        WHERE btx.provider = 'helcim'
        "#,
    )
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let mut opened = 0_i64;
    for row in rows {
        let provider_batch_id = row.get::<Option<String>, _>("provider_batch_id");
        let provider_transaction_id = row.get::<String, _>("provider_transaction_id");
        let payment_provider_batch_id = row.get::<Option<Uuid>, _>("payment_provider_batch_id");
        let payment_transaction_id = row.get::<Option<Uuid>, _>("payment_transaction_id");
        let Some(payment_transaction_id) = payment_transaction_id else {
            stats.unmatched_processor_rows += 1;
            opened += insert_settlement_item(
                tx,
                run_id,
                "processor_transaction_missing_ros_payment",
                "critical",
                provider_batch_id.as_deref(),
                Some(&provider_transaction_id),
                None,
                payment_provider_batch_id,
                json!({ "provider_transaction_id": provider_transaction_id }),
                json!({}),
                "Processor batch transaction has no matched ROS payment transaction.",
            )
            .await?;
            continue;
        };

        let processor_amount = row.get::<Option<Decimal>, _>("processor_amount");
        let ros_amount = row.get::<Option<Decimal>, _>("ros_amount");
        if let (Some(processor_amount), Some(ros_amount)) = (processor_amount, ros_amount) {
            if processor_amount.round_dp(2) != ros_amount.round_dp(2) {
                stats.amount_mismatches += 1;
                opened += insert_settlement_item(
                    tx,
                    run_id,
                    "amount_mismatch",
                    "critical",
                    provider_batch_id.as_deref(),
                    Some(&provider_transaction_id),
                    Some(payment_transaction_id),
                    payment_provider_batch_id,
                    json!({ "gross_amount": processor_amount.to_string() }),
                    json!({ "amount": ros_amount.to_string() }),
                    "Processor gross amount does not match ROS payment amount.",
                )
                .await?;
            }
        }

        let processor_status = row.get::<Option<String>, _>("processor_status");
        let ros_status = row
            .get::<Option<String>, _>("ros_provider_status")
            .or_else(|| row.get::<Option<String>, _>("ros_status"));
        if !settlement_statuses_match(processor_status.as_deref(), ros_status.as_deref()) {
            stats.status_mismatches += 1;
            opened += insert_settlement_item(
                tx,
                run_id,
                "status_mismatch",
                "warning",
                provider_batch_id.as_deref(),
                Some(&provider_transaction_id),
                Some(payment_transaction_id),
                payment_provider_batch_id,
                json!({ "status": processor_status }),
                json!({ "status": ros_status }),
                "Processor status does not match ROS payment status.",
            )
            .await?;
        }

        let ros_fee_status = row.get::<Option<String>, _>("ros_fee_status");
        if ros_fee_status.as_deref() == Some("applied") {
            let processor_fee = row.get::<Option<Decimal>, _>("processor_fee");
            let ros_fee = row.get::<Option<Decimal>, _>("ros_fee");
            if let (Some(processor_fee), Some(ros_fee)) = (processor_fee, ros_fee) {
                if processor_fee.round_dp(2) != ros_fee.round_dp(2) {
                    stats.fee_mismatches += 1;
                    opened += insert_settlement_item(
                        tx,
                        run_id,
                        "fee_mismatch",
                        "warning",
                        provider_batch_id.as_deref(),
                        Some(&provider_transaction_id),
                        Some(payment_transaction_id),
                        payment_provider_batch_id,
                        json!({ "fee_amount": processor_fee.to_string() }),
                        json!({ "merchant_fee": ros_fee.to_string() }),
                        "Explicit processor fee does not match explicit ROS merchant fee.",
                    )
                    .await?;
                }
            }
        }

        let ros_net_status = row.get::<Option<String>, _>("ros_net_status");
        if ros_net_status.as_deref() == Some("applied") {
            let processor_net = row.get::<Option<Decimal>, _>("processor_net");
            let ros_net = row.get::<Option<Decimal>, _>("ros_net");
            if let (Some(processor_net), Some(ros_net)) = (processor_net, ros_net) {
                if processor_net.round_dp(2) != ros_net.round_dp(2) {
                    stats.net_mismatches += 1;
                    opened += insert_settlement_item(
                        tx,
                        run_id,
                        "net_mismatch",
                        "warning",
                        provider_batch_id.as_deref(),
                        Some(&provider_transaction_id),
                        Some(payment_transaction_id),
                        payment_provider_batch_id,
                        json!({ "net_amount": processor_net.to_string() }),
                        json!({ "net_amount": ros_net.to_string() }),
                        "Explicit processor net amount does not match explicit ROS net amount.",
                    )
                    .await?;
                }
            }
        }
    }

    Ok(opened)
}

#[allow(clippy::too_many_arguments)]
async fn insert_settlement_item(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    run_id: Uuid,
    item_type: &str,
    severity: &str,
    provider_batch_id: Option<&str>,
    provider_transaction_id: Option<&str>,
    payment_transaction_id: Option<Uuid>,
    payment_provider_batch_id: Option<Uuid>,
    processor_values: Value,
    ros_values: Value,
    message: &str,
) -> Result<i64, PaymentError> {
    let result = sqlx::query(
        r#"
        INSERT INTO payment_settlement_items (
            run_id,
            provider,
            item_type,
            severity,
            status,
            provider_batch_id,
            provider_transaction_id,
            payment_transaction_id,
            payment_provider_batch_id,
            processor_values,
            ros_values,
            message
        )
        VALUES ($1, 'helcim', $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(run_id)
    .bind(item_type)
    .bind(severity)
    .bind(provider_batch_id)
    .bind(provider_transaction_id)
    .bind(payment_transaction_id)
    .bind(payment_provider_batch_id)
    .bind(processor_values)
    .bind(ros_values)
    .bind(message)
    .execute(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(result.rows_affected() as i64)
}

fn settlement_statuses_match(processor_status: Option<&str>, ros_status: Option<&str>) -> bool {
    let processor = settlement_status_family(processor_status);
    let ros = settlement_status_family(ros_status);
    processor.is_none() || ros.is_none() || processor == ros
}

fn settlement_status_family(status: Option<&str>) -> Option<&'static str> {
    match status?.trim().to_ascii_lowercase().as_str() {
        "approved" | "approval" | "captured" | "capture" | "success" | "succeeded" | "settled" => {
            Some("success")
        }
        "declined" | "decline" | "failed" | "error" => Some("failed"),
        "cancelled" | "canceled" | "voided" | "reversed" => Some("canceled"),
        "refunded" | "refund" => Some("refunded"),
        _ => None,
    }
}

async fn load_last_helcim_settlement_run(
    state: &AppState,
) -> Result<Option<HelcimSettlementRunSummary>, PaymentError> {
    Ok(sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            DateTime<Utc>,
            Option<DateTime<Utc>>,
            Value,
            Option<String>,
        ),
    >(
        r#"
        SELECT id, status, started_at, completed_at, summary, error_message
        FROM payment_settlement_runs
        WHERE provider = 'helcim'
        ORDER BY started_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .map(
        |(id, status, started_at, completed_at, summary, error_message)| {
            HelcimSettlementRunSummary {
                id,
                status,
                started_at,
                completed_at,
                summary,
                error_message,
            }
        },
    ))
}

async fn load_helcim_batch_rows(
    state: &AppState,
    id: Option<&str>,
    query: &HelcimOperationsListQuery,
) -> Result<Vec<HelcimBatchListRow>, PaymentError> {
    let (batch_uuid, provider_batch_id) = id
        .map(parse_batch_identifier)
        .or_else(|| query.batch_id.as_deref().map(parse_batch_identifier))
        .unwrap_or((None, None));
    let search = clean_filter(query.search.as_deref()).map(|value| format!("%{value}%"));
    let rows = sqlx::query(
	        r#"
        SELECT
            batch.id,
            batch.provider_batch_id,
            batch.status,
            batch.closed_at,
            batch.settled_at,
            batch.expected_deposit_at,
            batch.gross_amount,
            batch.fee_amount,
            batch.net_amount,
            batch.transaction_count,
            batch.last_synced_at,
            COALESCE(issues.issue_count, 0)::bigint AS issue_count,
            COALESCE(completeness.fee_not_ready_count, 0)::bigint AS fee_not_ready_count,
            COALESCE(completeness.net_not_ready_count, 0)::bigint AS net_not_ready_count
        FROM payment_provider_batches batch
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::bigint AS issue_count
            FROM payment_settlement_items item
            WHERE item.provider = 'helcim'
              AND item.status = 'open'
              AND (item.payment_provider_batch_id = batch.id OR item.provider_batch_id = batch.provider_batch_id)
        ) issues ON true
        LEFT JOIN LATERAL (
            SELECT
                COUNT(*) FILTER (WHERE btx.fee_amount IS NULL)::bigint AS fee_not_ready_count,
                COUNT(*) FILTER (WHERE btx.net_amount IS NULL)::bigint AS net_not_ready_count
            FROM payment_provider_batch_transactions btx
            WHERE btx.provider = 'helcim'
              AND btx.payment_provider_batch_id = batch.id
        ) completeness ON true
        WHERE batch.provider = 'helcim'
          AND ($1::uuid IS NULL OR batch.id = $1)
          AND ($2::text IS NULL OR batch.provider_batch_id = $2)
	          AND ($3::text IS NULL OR batch.status = $3)
	          AND ($4::date IS NULL OR (COALESCE(batch.expected_deposit_at, batch.settled_at, batch.closed_at, batch.last_synced_at) AT TIME ZONE 'America/New_York')::date >= $4)
	          AND ($5::date IS NULL OR (COALESCE(batch.expected_deposit_at, batch.settled_at, batch.closed_at, batch.last_synced_at) AT TIME ZONE 'America/New_York')::date <= $5)
	          AND ($6::text IS NULL OR batch.id::text ILIKE $6 OR batch.provider_batch_id ILIKE $6 OR batch.raw_payload::text ILIKE $6)
	        ORDER BY COALESCE(batch.expected_deposit_at, batch.settled_at, batch.closed_at, batch.last_synced_at) DESC
	        LIMIT $7
	        "#,
	    )
	    .bind(batch_uuid)
	    .bind(provider_batch_id.as_deref())
	    .bind(clean_filter(query.status.as_deref()))
	    .bind(query.date_from)
	    .bind(query.date_to)
	    .bind(search.as_deref())
	    .bind(clamp_limit(query.limit, 100, 500))
    .fetch_all(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .into_iter()
    .map(|row| HelcimBatchListRow {
        id: row.get("id"),
        provider_batch_id: row.get("provider_batch_id"),
        status: row.get("status"),
        closed_at: row.get("closed_at"),
        settled_at: row.get("settled_at"),
        expected_deposit_at: row.get("expected_deposit_at"),
        gross_amount: money_option(row.get::<Option<Decimal>, _>("gross_amount")),
        fee_amount: money_option(row.get::<Option<Decimal>, _>("fee_amount")),
        net_amount: money_option(row.get::<Option<Decimal>, _>("net_amount")),
        transaction_count: row.get("transaction_count"),
        issue_count: row.get("issue_count"),
        fee_not_ready_count: row.get("fee_not_ready_count"),
        net_not_ready_count: row.get("net_not_ready_count"),
        last_synced_at: row.get("last_synced_at"),
    })
    .collect();
    Ok(rows)
}

fn batch_row_from_pg(row: sqlx::postgres::PgRow) -> HelcimBatchListRow {
    HelcimBatchListRow {
        id: row.get("id"),
        provider_batch_id: row.get("provider_batch_id"),
        status: row.get("status"),
        closed_at: row.get("closed_at"),
        settled_at: row.get("settled_at"),
        expected_deposit_at: row.get("expected_deposit_at"),
        gross_amount: money_option(row.get::<Option<Decimal>, _>("gross_amount")),
        fee_amount: money_option(row.get::<Option<Decimal>, _>("fee_amount")),
        net_amount: money_option(row.get::<Option<Decimal>, _>("net_amount")),
        transaction_count: row.get("transaction_count"),
        issue_count: row.get("issue_count"),
        fee_not_ready_count: row.get("fee_not_ready_count"),
        net_not_ready_count: row.get("net_not_ready_count"),
        last_synced_at: row.get("last_synced_at"),
    }
}

async fn load_helcim_deposit_rows(
    state: &AppState,
    id: Option<Uuid>,
    query: &HelcimOperationsListQuery,
) -> Result<Vec<HelcimDepositRow>, PaymentError> {
    let rows = sqlx::query(
        r#"
        SELECT
            deposit.id,
            deposit.source_system,
            deposit.source_reference,
            deposit.qbo_deposit_id,
            deposit.bank_feed_transaction_id,
            deposit.posted_at,
            deposit.amount,
            deposit.currency,
            deposit.status,
            deposit.reviewed_at,
            COALESCE(linked.linked_batch_count, 0)::bigint AS linked_batch_count,
            linked.expected_amount,
            linked.linked_amount,
            CASE
                WHEN linked.expected_amount IS NULL THEN NULL::numeric
                ELSE (deposit.amount - linked.expected_amount)::numeric(12,2)
            END AS difference,
            COALESCE(issues.open_issue_count, 0)::bigint AS open_issue_count
        FROM payment_actual_deposits deposit
        LEFT JOIN LATERAL (
            SELECT
                COUNT(*)::bigint AS linked_batch_count,
                SUM(expected_net_amount)::numeric(12,2) AS expected_amount,
                SUM(COALESCE(linked_amount, expected_net_amount))::numeric(12,2) AS linked_amount
            FROM payment_actual_deposit_batches link
            WHERE link.deposit_id = deposit.id
              AND link.status = 'linked'
        ) linked ON true
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::bigint AS open_issue_count
            FROM payment_deposit_reconciliation_items item
            WHERE item.provider = 'helcim'
              AND item.deposit_id = deposit.id
              AND item.status = 'open'
        ) issues ON true
        WHERE deposit.provider = 'helcim'
          AND ($1::uuid IS NULL OR deposit.id = $1)
          AND ($2::text IS NULL OR deposit.status = $2)
          AND ($3::date IS NULL OR (deposit.posted_at AT TIME ZONE 'America/New_York')::date >= $3)
          AND ($4::date IS NULL OR (deposit.posted_at AT TIME ZONE 'America/New_York')::date <= $4)
          AND ($5::text IS NULL OR deposit.source_reference ILIKE $5 OR deposit.qbo_deposit_id ILIKE $5 OR deposit.bank_feed_transaction_id ILIKE $5)
        ORDER BY deposit.posted_at DESC, deposit.created_at DESC
        LIMIT $6
        "#,
    )
    .bind(id)
    .bind(clean_filter(query.status.as_deref()))
    .bind(query.date_from)
    .bind(query.date_to)
    .bind(clean_filter(query.search.as_deref()).map(|value| format!("%{value}%")))
    .bind(clamp_limit(query.limit, 100, 500))
    .fetch_all(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .into_iter()
    .map(deposit_row_from_pg)
    .collect();
    Ok(rows)
}

fn deposit_row_from_pg(row: sqlx::postgres::PgRow) -> HelcimDepositRow {
    HelcimDepositRow {
        id: row.get("id"),
        source_system: row.get("source_system"),
        source_reference: row.get("source_reference"),
        qbo_deposit_id: row.get("qbo_deposit_id"),
        bank_feed_transaction_id: row.get("bank_feed_transaction_id"),
        posted_at: row.get("posted_at"),
        amount: money_string(row.get("amount")),
        currency: row.get("currency"),
        status: row.get("status"),
        linked_batch_count: row.get("linked_batch_count"),
        expected_amount: money_option(row.get::<Option<Decimal>, _>("expected_amount")),
        linked_amount: money_option(row.get::<Option<Decimal>, _>("linked_amount")),
        difference: money_option(row.get::<Option<Decimal>, _>("difference")),
        open_issue_count: row.get("open_issue_count"),
        reviewed_at: row.get("reviewed_at"),
    }
}

async fn load_helcim_deposit_detail(
    state: &AppState,
    id: Uuid,
) -> Result<HelcimDepositDetailResponse, PaymentError> {
    let mut deposits = load_helcim_deposit_rows(
        state,
        Some(id),
        &HelcimOperationsListQuery {
            limit: Some(1),
            ..Default::default()
        },
    )
    .await?;
    let Some(deposit) = deposits.pop() else {
        return Err(PaymentError::InvalidPayload(
            "Deposit was not found.".to_string(),
        ));
    };
    let linked_batches = sqlx::query(
        r#"
        SELECT
            link.id,
            link.payment_provider_batch_id,
            link.provider_batch_id,
            link.expected_net_amount,
            link.linked_amount,
            link.match_type,
            link.status,
            link.created_at,
            batch.status AS batch_status,
            batch.expected_deposit_at,
            batch.settled_at
        FROM payment_actual_deposit_batches link
        INNER JOIN payment_provider_batches batch ON batch.id = link.payment_provider_batch_id
        WHERE link.deposit_id = $1
          AND link.status = 'linked'
        ORDER BY link.created_at DESC
        "#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .into_iter()
    .map(|row| HelcimDepositBatchLinkRow {
        id: row.get("id"),
        payment_provider_batch_id: row.get("payment_provider_batch_id"),
        provider_batch_id: row.get("provider_batch_id"),
        expected_net_amount: money_option(row.get::<Option<Decimal>, _>("expected_net_amount")),
        linked_amount: money_option(row.get::<Option<Decimal>, _>("linked_amount")),
        match_type: row.get("match_type"),
        status: row.get("status"),
        created_at: row.get("created_at"),
        batch_status: row.get("batch_status"),
        expected_deposit_at: row.get("expected_deposit_at"),
        settled_at: row.get("settled_at"),
    })
    .collect();
    let events = sqlx::query_as::<_, (Uuid, String, Option<String>, Option<Uuid>, DateTime<Utc>)>(
        r#"
        SELECT id, action, note, actor_staff_id, created_at
        FROM payment_actual_deposit_events
        WHERE deposit_id = $1
        ORDER BY created_at DESC
        LIMIT 100
        "#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .into_iter()
    .map(
        |(id, action, note, actor_staff_id, created_at)| HelcimDepositEventRow {
            id,
            action,
            note,
            actor_staff_id,
            created_at,
        },
    )
    .collect();
    let issues = load_deposit_issue_rows(&state.db, Some(id), None, None, Some(100)).await?;
    Ok(HelcimDepositDetailResponse {
        deposit,
        linked_batches,
        events,
        issues,
    })
}

async fn load_helcim_transaction_rows(
    state: &AppState,
    query: &HelcimOperationsListQuery,
    payment_id: Option<Uuid>,
) -> Result<Vec<HelcimOperationsTransactionRow>, PaymentError> {
    let (batch_uuid, provider_batch_id) = query
        .batch_id
        .as_deref()
        .map(parse_batch_identifier)
        .unwrap_or((None, None));
    let search = clean_filter(query.search.as_deref()).map(|value| format!("%{value}%"));
    let rows = sqlx::query(
        r#"
        SELECT
            pt.id,
            pt.provider_transaction_id,
            pt.amount,
            pt.created_at,
            pt.status,
            pt.provider_status,
            pt.metadata,
            btx.match_status,
            CASE
                WHEN pt.metadata->>'helcim_fee_sync_status' = 'applied' THEN pt.merchant_fee
                ELSE btx.fee_amount
            END AS fee_amount,
            CASE
                WHEN pt.metadata->>'helcim_net_sync_status' = 'applied' THEN pt.net_amount
                ELSE btx.net_amount
            END AS net_amount,
            batch.id AS batch_id,
            batch.provider_batch_id,
            batch.status AS batch_status,
            COALESCE(issues.issue_count, 0)::bigint AS issue_count
        FROM payment_transactions pt
        LEFT JOIN payment_provider_batch_transactions btx
          ON btx.provider = 'helcim'
         AND (btx.payment_transaction_id = pt.id OR btx.provider_transaction_id = pt.provider_transaction_id)
        LEFT JOIN payment_provider_batches batch ON batch.id = btx.payment_provider_batch_id
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::bigint AS issue_count
            FROM payment_settlement_items item
            WHERE item.provider = 'helcim'
              AND item.status = 'open'
              AND (item.payment_transaction_id = pt.id
                OR (pt.provider_transaction_id IS NOT NULL AND item.provider_transaction_id = pt.provider_transaction_id))
        ) issues ON true
        WHERE pt.payment_provider = 'helcim'
          AND ($1::uuid IS NULL OR pt.id = $1)
          AND ($2::date IS NULL OR (pt.created_at AT TIME ZONE 'America/New_York')::date >= $2)
          AND ($3::date IS NULL OR (pt.created_at AT TIME ZONE 'America/New_York')::date <= $3)
          AND ($4::text IS NULL OR pt.status = $4 OR pt.provider_status = $4)
          AND ($5::uuid IS NULL OR batch.id = $5)
          AND ($6::text IS NULL OR batch.provider_batch_id = $6 OR btx.provider_batch_id = $6)
          AND ($7::text IS NULL OR btx.match_status = $7)
          AND ($8::text IS NULL OR pt.provider_transaction_id ILIKE $8 OR pt.provider_payment_id ILIKE $8 OR pt.payment_method ILIKE $8)
        ORDER BY pt.created_at DESC
        LIMIT $9
        "#,
    )
    .bind(payment_id)
    .bind(query.date_from)
    .bind(query.date_to)
    .bind(clean_filter(query.status.as_deref()))
    .bind(batch_uuid)
    .bind(provider_batch_id.as_deref())
    .bind(clean_filter(query.match_status.as_deref()))
    .bind(search.as_deref())
    .bind(clamp_limit(query.limit, 100, 500))
    .fetch_all(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .into_iter()
    .map(|row| {
        let metadata: Value = row.get("metadata");
        let fee_status = metadata
            .get("helcim_fee_sync_status")
            .and_then(Value::as_str)
            .unwrap_or("not_ready")
            .to_string();
        let net_status = metadata
            .get("helcim_net_sync_status")
            .and_then(Value::as_str)
            .unwrap_or("not_ready")
            .to_string();
        HelcimOperationsTransactionRow {
            payment_transaction_id: row.get("id"),
            provider_transaction_id: row.get("provider_transaction_id"),
            amount: money_string(row.get("amount")),
            payment_date: row.get("created_at"),
            payment_status: row.get("status"),
            provider_status: row.get("provider_status"),
            batch_id: row.get("batch_id"),
            provider_batch_id: row.get("provider_batch_id"),
            batch_status: row.get("batch_status"),
            fee_amount: money_option(row.get::<Option<Decimal>, _>("fee_amount")),
            net_amount: money_option(row.get::<Option<Decimal>, _>("net_amount")),
            fee_status,
            net_status,
            match_status: row.get("match_status"),
            issue_count: row.get("issue_count"),
        }
    })
    .collect();
    Ok(rows)
}

async fn load_helcim_reconciliation_items(
    state: &AppState,
    query: &HelcimOperationsListQuery,
    payment_id: Option<Uuid>,
) -> Result<Vec<HelcimReconciliationItemRow>, PaymentError> {
    let (batch_uuid, provider_batch_id) = query
        .batch_id
        .as_deref()
        .map(parse_batch_identifier)
        .unwrap_or((None, None));
    let rows = sqlx::query(
        r#"
        SELECT
            id,
            item_type,
            severity,
            status,
            provider_batch_id,
            provider_transaction_id,
            payment_transaction_id,
            payment_provider_batch_id,
            processor_values,
            ros_values,
            message,
            created_at,
            reviewed_at,
            resolved_at,
            resolution_type,
            resolution_note,
            COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', event.id,
                    'action', event.action,
                    'note', event.note,
                    'actor_staff_id', event.actor_staff_id,
                    'created_at', event.created_at
                ) ORDER BY event.created_at DESC)
                FROM payment_settlement_item_events event
                WHERE event.item_id = payment_settlement_items.id
            ), '[]'::jsonb) AS events
        FROM payment_settlement_items
        WHERE provider = 'helcim'
          AND ($1::text IS NULL OR status = $1)
          AND ($2::text IS NULL OR severity = $2)
          AND ($3::text IS NULL OR item_type = $3)
          AND ($4::uuid IS NULL OR payment_provider_batch_id = $4)
          AND ($5::text IS NULL OR provider_batch_id = $5)
          AND ($6::uuid IS NULL OR payment_transaction_id = $6)
          AND ($7::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date >= $7)
          AND ($8::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date <= $8)
        ORDER BY
            CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
            created_at DESC
        LIMIT $9
        "#,
    )
    .bind(clean_filter(query.status.as_deref()))
    .bind(clean_filter(query.severity.as_deref()))
    .bind(clean_filter(query.item_type.as_deref()))
    .bind(batch_uuid)
    .bind(provider_batch_id.as_deref())
    .bind(payment_id)
    .bind(query.date_from)
    .bind(query.date_to)
    .bind(clamp_limit(query.limit, 100, 500))
    .fetch_all(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .into_iter()
    .map(reconciliation_item_from_row)
    .collect();
    Ok(rows)
}

async fn load_helcim_reconciliation_item_by_id(
    state: &AppState,
    id: Uuid,
) -> Result<HelcimReconciliationItemRow, PaymentError> {
    let row = sqlx::query(
        r#"
        SELECT
            id,
            item_type,
            severity,
            status,
            provider_batch_id,
            provider_transaction_id,
            payment_transaction_id,
            payment_provider_batch_id,
            processor_values,
            ros_values,
            message,
            created_at,
            reviewed_at,
            resolved_at,
            resolution_type,
            resolution_note,
            COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', event.id,
                    'action', event.action,
                    'note', event.note,
                    'actor_staff_id', event.actor_staff_id,
                    'created_at', event.created_at
                ) ORDER BY event.created_at DESC)
                FROM payment_settlement_item_events event
                WHERE event.item_id = payment_settlement_items.id
            ), '[]'::jsonb) AS events
        FROM payment_settlement_items
        WHERE provider = 'helcim'
          AND id = $1
        LIMIT 1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .ok_or_else(|| PaymentError::InvalidPayload("Issue was not found.".to_string()))?;
    Ok(reconciliation_item_from_row(row))
}

async fn load_helcim_payment_timeline(
    state: &AppState,
    payment_id: Uuid,
    provider_transaction_id: Option<&str>,
) -> Result<Vec<HelcimPaymentTimelineRow>, PaymentError> {
    let mut timeline = Vec::new();
    if let Some(created_at) = sqlx::query_scalar::<_, DateTime<Utc>>(
        "SELECT created_at FROM payment_transactions WHERE id = $1",
    )
    .bind(payment_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    {
        timeline.push(HelcimPaymentTimelineRow {
            occurred_at: created_at,
            label: "Payment recorded".to_string(),
            status: "recorded".to_string(),
        });
    }

    let events = sqlx::query(
        r#"
        SELECT event_type, received_at, processing_status
        FROM helcim_event_log
        WHERE provider = 'helcim'
          AND (payment_transaction_id = $1
            OR ($2::text IS NOT NULL AND provider_transaction_id = $2))
        ORDER BY received_at ASC
        LIMIT 25
        "#,
    )
    .bind(payment_id)
    .bind(provider_transaction_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    for event in events {
        timeline.push(HelcimPaymentTimelineRow {
            occurred_at: event.get("received_at"),
            label: payment_event_label(event.get::<String, _>("event_type").as_str()),
            status: staff_safe_status(event.get::<String, _>("processing_status").as_str()),
        });
    }

    timeline.sort_by_key(|row| row.occurred_at);
    Ok(timeline)
}

fn reconciliation_item_from_row(row: sqlx::postgres::PgRow) -> HelcimReconciliationItemRow {
    let processor_values: Value = row.get("processor_values");
    let ros_values: Value = row.get("ros_values");
    let provider_transaction_id: Option<String> = row.get("provider_transaction_id");
    let provider_batch_id: Option<String> = row.get("provider_batch_id");
    HelcimReconciliationItemRow {
        id: row.get("id"),
        item_type: row.get::<String, _>("item_type").clone(),
        issue_label: issue_label(row.get::<String, _>("item_type").as_str()).to_string(),
        severity: staff_safe_severity(row.get::<String, _>("severity").as_str()),
        status: row.get("status"),
        amount: value_amount(&processor_values).or_else(|| value_amount(&ros_values)),
        reference: provider_transaction_id
            .clone()
            .or_else(|| provider_batch_id.clone())
            .or_else(|| value_reference(&processor_values))
            .or_else(|| value_reference(&ros_values)),
        provider_batch_id,
        provider_transaction_id,
        payment_transaction_id: row.get("payment_transaction_id"),
        payment_provider_batch_id: row.get("payment_provider_batch_id"),
        message: row.get("message"),
        created_at: row.get("created_at"),
        reviewed_at: row.get("reviewed_at"),
        resolved_at: row.get("resolved_at"),
        resolution_type: row.get("resolution_type"),
        resolution_note: row.get("resolution_note"),
        events: serde_json::from_value(row.get::<Value, _>("events")).unwrap_or_default(),
    }
}

fn parse_batch_identifier(value: &str) -> (Option<Uuid>, Option<String>) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return (None, None);
    }
    if let Ok(id) = Uuid::parse_str(trimmed) {
        (Some(id), None)
    } else {
        (None, Some(trimmed.to_string()))
    }
}

fn clean_filter(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn clean_required_note(
    value: Option<&str>,
    required: bool,
) -> Result<Option<String>, PaymentError> {
    let note = clean_filter(value);
    if required && note.is_none() {
        return Err(PaymentError::InvalidPayload(
            "A note is required for this action.".to_string(),
        ));
    }
    Ok(note)
}

fn parse_money_input(value: &str) -> Result<Decimal, PaymentError> {
    let amount = value
        .trim()
        .trim_start_matches('$')
        .replace(',', "")
        .parse::<Decimal>()
        .map_err(|_| PaymentError::InvalidPayload("Amount must be a valid number.".to_string()))?
        .round_dp(2);
    if amount.is_zero() {
        return Err(PaymentError::InvalidPayload(
            "Amount must not be zero.".to_string(),
        ));
    }
    Ok(amount)
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    matches!(error, sqlx::Error::Database(db_error) if db_error.code().as_deref() == Some("23505"))
}

fn normalize_resolution_action(action: &str) -> Result<String, PaymentError> {
    match action.trim().to_ascii_lowercase().as_str() {
        "reviewed" | "resolved" | "ignored" | "reopened" => Ok(action.trim().to_ascii_lowercase()),
        _ => Err(PaymentError::InvalidPayload(
            "Unsupported issue action.".to_string(),
        )),
    }
}

fn clamp_limit(value: Option<i64>, default: i64, max: i64) -> i64 {
    value.unwrap_or(default).clamp(1, max)
}

fn money_string(value: Decimal) -> String {
    value.round_dp(2).to_string()
}

fn money_option(value: Option<Decimal>) -> Option<String> {
    value.map(money_string)
}

fn value_amount(value: &Value) -> Option<String> {
    for key in [
        "gross_amount",
        "amount",
        "fee_amount",
        "merchant_fee",
        "net_amount",
    ] {
        if let Some(amount) = value.get(key).and_then(value_to_money_string) {
            return Some(amount);
        }
    }
    None
}

fn value_reference(value: &Value) -> Option<String> {
    for key in [
        "provider_transaction_id",
        "payment_transaction_id",
        "provider_batch_id",
        "local_batch_id",
    ] {
        if let Some(reference) = value.get(key).and_then(value_to_staff_string) {
            return Some(reference);
        }
    }
    None
}

fn value_to_money_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => value.parse::<Decimal>().ok().map(money_string),
        Value::Number(number) => number.to_string().parse::<Decimal>().ok().map(money_string),
        _ => None,
    }
}

fn value_to_staff_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn value_decimal(value: &Value) -> Option<Decimal> {
    match value {
        Value::String(value) => value.parse::<Decimal>().ok(),
        Value::Number(number) => number.to_string().parse::<Decimal>().ok(),
        _ => None,
    }
}

async fn load_settlement_item_state_for_update(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<Value, PaymentError> {
    sqlx::query_scalar::<_, Value>(
        r#"
        SELECT to_jsonb(item)
        FROM payment_settlement_items item
        WHERE item.id = $1
          AND item.provider = 'helcim'
        FOR UPDATE
        "#,
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .ok_or_else(|| PaymentError::InvalidPayload("Issue was not found.".to_string()))
}

async fn load_settlement_item_state<'e, E>(executor: E, id: Uuid) -> Result<Value, PaymentError>
where
    E: Executor<'e, Database = Postgres>,
{
    sqlx::query_scalar::<_, Value>(
        r#"
        SELECT to_jsonb(item)
        FROM payment_settlement_items item
        WHERE item.id = $1
          AND item.provider = 'helcim'
        "#,
    )
    .bind(id)
    .fetch_optional(executor)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .ok_or_else(|| PaymentError::InvalidPayload("Issue was not found.".to_string()))
}

async fn load_provider_batch_transaction<'e, E>(
    executor: E,
    provider_transaction_id: &str,
) -> Result<Value, PaymentError>
where
    E: Executor<'e, Database = Postgres>,
{
    sqlx::query_scalar::<_, Value>(
        r#"
        SELECT to_jsonb(btx)
        FROM payment_provider_batch_transactions btx
        WHERE btx.provider = 'helcim'
          AND btx.provider_transaction_id = $1
        "#,
    )
    .bind(provider_transaction_id)
    .fetch_optional(executor)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .ok_or_else(|| PaymentError::InvalidPayload("Processor payment was not found.".to_string()))
}

async fn insert_settlement_item_event(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    item_id: Uuid,
    actor_staff_id: Option<Uuid>,
    action: &str,
    note: Option<&str>,
    before_state: Value,
    after_state: Value,
) -> Result<(), PaymentError> {
    sqlx::query(
        r#"
        INSERT INTO payment_settlement_item_events (
            item_id,
            actor_staff_id,
            action,
            note,
            before_state,
            after_state
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(item_id)
    .bind(actor_staff_id)
    .bind(action)
    .bind(note)
    .bind(before_state)
    .bind(after_state)
    .execute(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(())
}

async fn load_deposit_state_for_update(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<Value, PaymentError> {
    sqlx::query_scalar::<_, Value>(
        r#"
        SELECT to_jsonb(deposit)
        FROM payment_actual_deposits deposit
        WHERE deposit.id = $1
          AND deposit.provider = 'helcim'
        FOR UPDATE
        "#,
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .ok_or_else(|| PaymentError::InvalidPayload("Deposit was not found.".to_string()))
}

async fn load_deposit_state<'e, E>(executor: E, id: Uuid) -> Result<Value, PaymentError>
where
    E: Executor<'e, Database = Postgres>,
{
    sqlx::query_scalar::<_, Value>(
        r#"
        SELECT to_jsonb(deposit)
        FROM payment_actual_deposits deposit
        WHERE deposit.id = $1
          AND deposit.provider = 'helcim'
        "#,
    )
    .bind(id)
    .fetch_optional(executor)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .ok_or_else(|| PaymentError::InvalidPayload("Deposit was not found.".to_string()))
}

async fn insert_deposit_event(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    deposit_id: Uuid,
    actor_staff_id: Option<Uuid>,
    action: &str,
    note: Option<&str>,
    before_state: Value,
    after_state: Value,
) -> Result<(), PaymentError> {
    sqlx::query(
        r#"
        INSERT INTO payment_actual_deposit_events (
            deposit_id,
            actor_staff_id,
            action,
            note,
            before_state,
            after_state
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(deposit_id)
    .bind(actor_staff_id)
    .bind(action)
    .bind(note)
    .bind(before_state)
    .bind(after_state)
    .execute(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(())
}

async fn deposit_difference<'e, E>(
    executor: E,
    deposit_id: Uuid,
) -> Result<Option<Decimal>, PaymentError>
where
    E: Executor<'e, Database = Postgres>,
{
    sqlx::query_scalar::<_, Option<Decimal>>(
        r#"
        SELECT
            CASE
                WHEN SUM(link.expected_net_amount) IS NULL THEN NULL::numeric
                ELSE (MAX(deposit.amount) - SUM(link.expected_net_amount))::numeric(12,2)
            END
        FROM payment_actual_deposits deposit
        LEFT JOIN payment_actual_deposit_batches link
          ON link.deposit_id = deposit.id
         AND link.status = 'linked'
        WHERE deposit.id = $1
          AND deposit.provider = 'helcim'
        GROUP BY deposit.id
        "#,
    )
    .bind(deposit_id)
    .fetch_optional(executor)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))
    .map(Option::flatten)
}

async fn refresh_deposit_match_status(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    deposit_id: Uuid,
) -> Result<(), PaymentError> {
    let row = sqlx::query(
        r#"
        SELECT
            deposit.amount,
            COUNT(link.id)::bigint AS linked_count,
            SUM(link.expected_net_amount)::numeric(12,2) AS expected_amount
        FROM payment_actual_deposits deposit
        LEFT JOIN payment_actual_deposit_batches link
          ON link.deposit_id = deposit.id
         AND link.status = 'linked'
        WHERE deposit.id = $1
          AND deposit.provider = 'helcim'
        GROUP BY deposit.id
        "#,
    )
    .bind(deposit_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .ok_or_else(|| PaymentError::InvalidPayload("Deposit was not found.".to_string()))?;
    let linked_count: i64 = row.get("linked_count");
    let amount: Decimal = row.get("amount");
    let expected: Option<Decimal> = row.get("expected_amount");
    let status = if linked_count == 0 {
        "open"
    } else if expected.map(|value| value.round_dp(2)) == Some(amount.round_dp(2)) {
        "matched"
    } else {
        "needs_review"
    };
    sqlx::query(
        r#"
        UPDATE payment_actual_deposits
        SET status = $2
        WHERE id = $1
          AND provider = 'helcim'
        "#,
    )
    .bind(deposit_id)
    .bind(status)
    .execute(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(())
}

async fn create_deposit_amount_item_if_needed(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    run_id: Option<Uuid>,
    deposit_id: Uuid,
) -> Result<i64, PaymentError> {
    let row = sqlx::query(
        r#"
        SELECT
            deposit.amount,
            COUNT(link.id)::bigint AS linked_count,
            SUM(link.expected_net_amount)::numeric(12,2) AS expected_amount
        FROM payment_actual_deposits deposit
        LEFT JOIN payment_actual_deposit_batches link
          ON link.deposit_id = deposit.id
         AND link.status = 'linked'
        WHERE deposit.id = $1
          AND deposit.provider = 'helcim'
        GROUP BY deposit.id
        "#,
    )
    .bind(deposit_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .ok_or_else(|| PaymentError::InvalidPayload("Deposit was not found.".to_string()))?;
    let amount: Decimal = row.get("amount");
    let linked_count: i64 = row.get("linked_count");
    let expected_amount: Option<Decimal> = row.get("expected_amount");
    if linked_count == 0 {
        return insert_deposit_item(
            tx,
            run_id,
            "actual_deposit_missing_expected_batch",
            "warning",
            Some(deposit_id),
            None,
            None,
            json!({ "actual_deposit_amount": amount.to_string() }),
            json!({}),
            "Actual bank deposit is not linked to any expected Helcim batch.",
        )
        .await;
    }
    let Some(expected_amount) = expected_amount.map(|value| value.round_dp(2)) else {
        return insert_deposit_item(
            tx,
            run_id,
            "partial_deposit",
            "warning",
            Some(deposit_id),
            None,
            None,
            json!({ "actual_deposit_amount": amount.to_string() }),
            json!({ "expected_amount": Value::Null }),
            "Linked expected batch amount is not ready.",
        )
        .await;
    };
    if amount.round_dp(2) == expected_amount {
        return Ok(0);
    }
    insert_deposit_item(
        tx,
        run_id,
        "deposit_amount_mismatch",
        "warning",
        Some(deposit_id),
        None,
        None,
        json!({ "actual_deposit_amount": amount.to_string() }),
        json!({ "expected_deposit_amount": expected_amount.to_string() }),
        "Actual bank deposit amount does not match linked expected deposit total.",
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn insert_deposit_item(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    run_id: Option<Uuid>,
    item_type: &str,
    severity: &str,
    deposit_id: Option<Uuid>,
    payment_provider_batch_id: Option<Uuid>,
    provider_batch_id: Option<&str>,
    processor_values: Value,
    ros_values: Value,
    message: &str,
) -> Result<i64, PaymentError> {
    let result = sqlx::query(
        r#"
        INSERT INTO payment_deposit_reconciliation_items (
            run_id,
            provider,
            item_type,
            severity,
            status,
            deposit_id,
            payment_provider_batch_id,
            provider_batch_id,
            processor_values,
            ros_values,
            message
        )
        VALUES ($1, 'helcim', $2, $3, 'open', $4, $5, $6, $7, $8, $9)
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(run_id)
    .bind(item_type)
    .bind(severity)
    .bind(deposit_id)
    .bind(payment_provider_batch_id)
    .bind(provider_batch_id)
    .bind(processor_values)
    .bind(ros_values)
    .bind(message)
    .execute(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(result.rows_affected() as i64)
}

async fn load_deposit_issue_rows<'e, E>(
    executor: E,
    deposit_id: Option<Uuid>,
    batch_id: Option<Uuid>,
    status: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<HelcimDepositIssueRow>, PaymentError>
where
    E: Executor<'e, Database = Postgres>,
{
    let rows = sqlx::query(
        r#"
        SELECT
            id,
            item_type,
            severity,
            status,
            deposit_id,
            payment_provider_batch_id,
            provider_batch_id,
            processor_values,
            ros_values,
            message,
            created_at
        FROM payment_deposit_reconciliation_items
        WHERE provider = 'helcim'
          AND ($1::uuid IS NULL OR deposit_id = $1)
          AND ($2::uuid IS NULL OR payment_provider_batch_id = $2)
          AND ($3::text IS NULL OR status = $3)
        ORDER BY
            CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
            created_at DESC
        LIMIT $4
        "#,
    )
    .bind(deposit_id)
    .bind(batch_id)
    .bind(status)
    .bind(clamp_limit(limit, 100, 500))
    .fetch_all(executor)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .into_iter()
    .map(deposit_issue_from_row)
    .collect();
    Ok(rows)
}

fn deposit_issue_from_row(row: sqlx::postgres::PgRow) -> HelcimDepositIssueRow {
    let processor_values: Value = row.get("processor_values");
    let ros_values: Value = row.get("ros_values");
    let provider_batch_id: Option<String> = row.get("provider_batch_id");
    HelcimDepositIssueRow {
        id: row.get("id"),
        item_type: row.get::<String, _>("item_type").clone(),
        issue_label: deposit_issue_label(row.get::<String, _>("item_type").as_str()).to_string(),
        severity: staff_safe_severity(row.get::<String, _>("severity").as_str()),
        status: row.get("status"),
        deposit_id: row.get("deposit_id"),
        payment_provider_batch_id: row.get("payment_provider_batch_id"),
        provider_batch_id: provider_batch_id.clone(),
        amount: value_amount(&processor_values).or_else(|| value_amount(&ros_values)),
        reference: provider_batch_id
            .or_else(|| value_reference(&processor_values))
            .or_else(|| value_reference(&ros_values)),
        message: row.get("message"),
        created_at: row.get("created_at"),
    }
}

#[derive(Default)]
struct DepositReconciliationStats {
    expected_batches_missing_actual: i64,
    actual_deposits_missing_expected: i64,
    amount_mismatches: i64,
    date_mismatches: i64,
    duplicate_references: i64,
    items_opened: i64,
}

async fn create_deposit_reconciliation_items(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    run_id: Uuid,
    date_from: Option<NaiveDate>,
    date_to: Option<NaiveDate>,
) -> Result<DepositReconciliationStats, PaymentError> {
    let mut stats = DepositReconciliationStats::default();

    let missing_batches = sqlx::query(
        r#"
        SELECT id, provider_batch_id, net_amount, expected_deposit_at, settled_at, closed_at
        FROM payment_provider_batches batch
        WHERE provider = 'helcim'
          AND net_amount IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM payment_actual_deposit_batches link
            WHERE link.payment_provider_batch_id = batch.id
              AND link.status = 'linked'
          )
          AND ($1::date IS NULL OR (COALESCE(expected_deposit_at, settled_at, closed_at, last_synced_at) AT TIME ZONE 'America/New_York')::date >= $1)
          AND ($2::date IS NULL OR (COALESCE(expected_deposit_at, settled_at, closed_at, last_synced_at) AT TIME ZONE 'America/New_York')::date <= $2)
        "#,
    )
    .bind(date_from)
    .bind(date_to)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    for row in missing_batches {
        stats.expected_batches_missing_actual += 1;
        let batch_id: Uuid = row.get("id");
        let provider_batch_id: String = row.get("provider_batch_id");
        stats.items_opened += insert_deposit_item(
            tx,
            Some(run_id),
            "expected_batch_missing_actual_deposit",
            "warning",
            None,
            Some(batch_id),
            Some(&provider_batch_id),
            json!({ "expected_deposit_amount": row.get::<Option<Decimal>, _>("net_amount").map(|value| value.to_string()) }),
            json!({ "provider_batch_id": provider_batch_id }),
            "Expected Helcim batch deposit is not linked to an actual bank deposit.",
        )
        .await?;
    }

    let deposits = sqlx::query(
        r#"
        SELECT id
        FROM payment_actual_deposits deposit
        WHERE provider = 'helcim'
          AND NOT EXISTS (
            SELECT 1
            FROM payment_actual_deposit_batches link
            WHERE link.deposit_id = deposit.id
              AND link.status = 'linked'
          )
          AND ($1::date IS NULL OR (posted_at AT TIME ZONE 'America/New_York')::date >= $1)
          AND ($2::date IS NULL OR (posted_at AT TIME ZONE 'America/New_York')::date <= $2)
        "#,
    )
    .bind(date_from)
    .bind(date_to)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    for row in deposits {
        stats.actual_deposits_missing_expected += 1;
        stats.items_opened +=
            create_deposit_amount_item_if_needed(tx, Some(run_id), row.get("id")).await?;
    }

    let linked_deposits = sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT DISTINCT deposit.id
        FROM payment_actual_deposits deposit
        INNER JOIN payment_actual_deposit_batches link ON link.deposit_id = deposit.id
        WHERE deposit.provider = 'helcim'
          AND link.status = 'linked'
          AND ($1::date IS NULL OR (deposit.posted_at AT TIME ZONE 'America/New_York')::date >= $1)
          AND ($2::date IS NULL OR (deposit.posted_at AT TIME ZONE 'America/New_York')::date <= $2)
        "#,
    )
    .bind(date_from)
    .bind(date_to)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    for deposit_id in linked_deposits {
        let opened = create_deposit_amount_item_if_needed(tx, Some(run_id), deposit_id).await?;
        if opened > 0 {
            stats.amount_mismatches += 1;
            stats.items_opened += opened;
        }
    }

    let date_mismatches = sqlx::query(
        r#"
        SELECT
            deposit.id AS deposit_id,
            batch.id AS batch_id,
            batch.provider_batch_id,
            deposit.posted_at,
            COALESCE(batch.expected_deposit_at, batch.settled_at, batch.closed_at) AS expected_at
        FROM payment_actual_deposits deposit
        INNER JOIN payment_actual_deposit_batches link ON link.deposit_id = deposit.id
        INNER JOIN payment_provider_batches batch ON batch.id = link.payment_provider_batch_id
        WHERE deposit.provider = 'helcim'
          AND link.status = 'linked'
          AND COALESCE(batch.expected_deposit_at, batch.settled_at, batch.closed_at) IS NOT NULL
          AND (
            deposit.posted_at < COALESCE(batch.expected_deposit_at, batch.settled_at, batch.closed_at) - interval '3 days'
            OR deposit.posted_at > COALESCE(batch.expected_deposit_at, batch.settled_at, batch.closed_at) + interval '3 days'
          )
          AND ($1::date IS NULL OR (deposit.posted_at AT TIME ZONE 'America/New_York')::date >= $1)
          AND ($2::date IS NULL OR (deposit.posted_at AT TIME ZONE 'America/New_York')::date <= $2)
        "#,
    )
    .bind(date_from)
    .bind(date_to)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    for row in date_mismatches {
        stats.date_mismatches += 1;
        let provider_batch_id: String = row.get("provider_batch_id");
        stats.items_opened += insert_deposit_item(
            tx,
            Some(run_id),
            "deposit_date_outside_window",
            "info",
            Some(row.get("deposit_id")),
            Some(row.get("batch_id")),
            Some(&provider_batch_id),
            json!({ "actual_posted_at": row.get::<DateTime<Utc>, _>("posted_at") }),
            json!({ "expected_deposit_at": row.get::<Option<DateTime<Utc>>, _>("expected_at") }),
            "Actual bank deposit posted outside the expected deposit date window.",
        )
        .await?;
    }

    let duplicate_refs = sqlx::query(
        r#"
        SELECT id, source_system, source_reference, qbo_deposit_id, bank_feed_transaction_id
        FROM payment_actual_deposits deposit
        WHERE provider = 'helcim'
          AND (
            (qbo_deposit_id IS NOT NULL AND qbo_deposit_id IN (
                SELECT qbo_deposit_id
                FROM payment_actual_deposits
                WHERE provider = 'helcim' AND qbo_deposit_id IS NOT NULL
                GROUP BY qbo_deposit_id
                HAVING COUNT(*) > 1
            ))
            OR (bank_feed_transaction_id IS NOT NULL AND bank_feed_transaction_id IN (
                SELECT bank_feed_transaction_id
                FROM payment_actual_deposits
                WHERE provider = 'helcim' AND bank_feed_transaction_id IS NOT NULL
                GROUP BY bank_feed_transaction_id
                HAVING COUNT(*) > 1
            ))
          )
        "#,
    )
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    for row in duplicate_refs {
        stats.duplicate_references += 1;
        stats.items_opened += insert_deposit_item(
            tx,
            Some(run_id),
            "duplicate_deposit_reference",
            "critical",
            Some(row.get("id")),
            None,
            None,
            json!({
                "source_system": row.get::<String, _>("source_system"),
                "source_reference": row.get::<Option<String>, _>("source_reference"),
                "qbo_deposit_id": row.get::<Option<String>, _>("qbo_deposit_id"),
                "bank_feed_transaction_id": row.get::<Option<String>, _>("bank_feed_transaction_id"),
            }),
            json!({}),
            "Actual bank deposit shares a QBO or bank-feed reference with another deposit.",
        )
        .await?;
    }

    Ok(stats)
}

fn deposit_issue_label(item_type: &str) -> &'static str {
    match item_type {
        "actual_deposit_missing_expected_batch" => "Unmatched Actual Deposit",
        "expected_batch_missing_actual_deposit" => "Not Cleared",
        "deposit_amount_mismatch" => "Amount Difference",
        "deposit_date_outside_window" => "Date Difference",
        "partial_deposit" => "Partial Deposit",
        "duplicate_deposit_reference" => "Duplicate Deposit",
        _ => "Needs Review",
    }
}

fn issue_label(item_type: &str) -> &'static str {
    match item_type {
        "processor_transaction_missing_ros_payment" => "Missing Payment",
        "ros_payment_missing_processor_batch" | "missing_processor_batch_row" => "Not in Deposit",
        "missing_provider_transaction_id" => "Processor Data Missing",
        "amount_mismatch" => "Amount Difference",
        "status_mismatch" => "Status Difference",
        "fee_mismatch" => "Fee Difference",
        "net_mismatch" => "Net Difference",
        _ => "Needs Review",
    }
}

fn staff_safe_severity(severity: &str) -> String {
    match severity {
        "critical" => "Critical",
        "warning" => "Warning",
        "info" => "Info",
        _ => "Warning",
    }
    .to_string()
}

fn staff_safe_status(status: &str) -> String {
    match status {
        "processed" => "complete",
        "failed" => "needs_review",
        "ignored" => "not_needed",
        _ => "received",
    }
    .to_string()
}

fn payment_event_label(event_type: &str) -> String {
    match event_type {
        "cardTransaction" => "Payment update".to_string(),
        "terminalCancel" => "Payment canceled".to_string(),
        "batchSettled" => "Batch update".to_string(),
        _ => "Payment update".to_string(),
    }
}

async fn expire_stale_helcim_terminal_attempts(
    pool: &PgPool,
    terminal_id: &str,
) -> Result<(), PaymentError> {
    sqlx::query(
        r#"
        UPDATE payment_provider_attempts
        SET status = 'expired',
            error_code = 'terminal_pending_timeout',
            error_message = 'Expired locally after the terminal stayed pending too long.',
            completed_at = now()
        WHERE provider = 'helcim'
          AND status = 'pending'
          AND COALESCE(terminal_id, device_id) = $1
          AND created_at < now() - ($2::bigint * interval '1 minute')
        "#,
    )
    .bind(terminal_id)
    .bind(HELCIM_TERMINAL_PENDING_TIMEOUT_MINUTES)
    .execute(pool)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(())
}

async fn terminal_in_use_message(pool: &PgPool, terminal_id: &str) -> Result<String, PaymentError> {
    let lane: Option<i16> = sqlx::query_scalar(
        r#"
        SELECT rs.register_lane
        FROM payment_provider_attempts ppa
        LEFT JOIN register_sessions rs ON rs.id = ppa.register_session_id
        WHERE ppa.provider = 'helcim'
          AND ppa.status = 'pending'
          AND COALESCE(ppa.terminal_id, ppa.device_id) = $1
        ORDER BY ppa.created_at ASC
        LIMIT 1
        "#,
    )
    .bind(terminal_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(match lane {
        Some(register_lane) => format!("Terminal in use by Register #{register_lane}"),
        None => "Terminal in use by another payment.".to_string(),
    })
}

async fn start_helcim_purchase(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<HelcimPurchaseRequestBody>,
) -> Result<Json<HelcimAttemptResponse>, PaymentError> {
    let auth = middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;

    if load_active_card_provider(&state).await? != helcim::HELCIM_PROVIDER_KEY {
        return Err(PaymentError::InvalidPayload(
            "Helcim is not the active card provider.".to_string(),
        ));
    }
    if payload.amount_cents <= 0 {
        return Err(PaymentError::InvalidPayload(
            "Helcim terminal payments must be greater than zero.".to_string(),
        ));
    }

    let (register_session_id, staff_id) = match auth {
        middleware::StaffOrPosSession::Staff(staff) => {
            (payload.register_session_id, Some(staff.id))
        }
        middleware::StaffOrPosSession::PosSession { session_id } => (Some(session_id), None),
    };
    let config = helcim::HelcimConfig::from_env();
    let terminal_route = resolve_helcim_terminal_for_register_with_selection(
        &state,
        &state.db,
        &config,
        register_session_id,
        payload.selected_terminal_key.as_deref(),
        payload.terminal_override_reason.as_deref(),
        staff_id,
    )
    .await?;
    let terminal_id = terminal_route.terminal_id.clone();
    expire_stale_helcim_terminal_attempts(&state.db, &terminal_id).await?;
    let currency = payload
        .currency
        .as_deref()
        .unwrap_or("usd")
        .trim()
        .to_ascii_lowercase();
    validate_currency(&currency)?;

    let attempt_id = Uuid::new_v4();
    let idempotency_key = format!("helcim-{attempt_id}");

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    lock_register_session_open_for_payment(&mut tx, register_session_id).await?;
    let insert_result = sqlx::query(
        r#"
        INSERT INTO payment_provider_attempts (
            id, provider, status, amount_cents, currency, register_session_id, staff_id,
            device_id, terminal_id, selected_terminal_key, terminal_route_source,
            terminal_override_staff_id, terminal_override_reason, idempotency_key, checkout_client_id
        )
        VALUES ($1, 'helcim', 'pending', $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, $12)
        "#,
    )
    .bind(attempt_id)
    .bind(payload.amount_cents)
    .bind(&currency)
    .bind(register_session_id)
    .bind(staff_id)
    .bind(&terminal_id)
    .bind(&terminal_route.terminal_key)
    .bind(&terminal_route.route_source)
    .bind(terminal_route.override_staff_id)
    .bind(&terminal_route.override_reason)
    .bind(&idempotency_key)
    .bind(payload.checkout_client_id)
    .execute(&mut *tx)
    .await;

    if let Err(e) = insert_result {
        let _ = tx.rollback().await;
        if e.as_database_error().and_then(|db| db.constraint())
            == Some("uq_payment_provider_attempts_active_device")
        {
            return Err(PaymentError::Conflict(
                terminal_in_use_message(&state.db, &terminal_id).await?,
            ));
        }
        return Err(PaymentError::InvalidPayload(e.to_string()));
    }
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    if config.simulator_enabled() {
        return load_helcim_attempt(&state, attempt_id, None)
            .await
            .map(Json);
    }

    let request_payload = helcim::build_purchase_request_payload(
        payload.amount_cents,
        currency.clone(),
        format!("ROS-{}", attempt_id.simple()),
    );
    let accepted = match helcim::start_terminal_purchase(
        &state.http_client,
        &config,
        &terminal_id,
        request_payload,
        &idempotency_key,
    )
    .await
    {
        Ok(accepted) => accepted,
        Err(error) => {
            if let Some(status) = error.status {
                let raw_text = error.raw_text.unwrap_or(error.message);
                let is_html = raw_text.trim().starts_with("<!DOCTYPE html>")
                    || raw_text.trim().starts_with("<html");
                let persisted_message = persisted_provider_error(&raw_text);
                sqlx::query(
                    r#"
                    UPDATE payment_provider_attempts
                    SET status = 'failed', error_code = $2, error_message = $3, completed_at = now()
                    WHERE id = $1
                    "#,
                )
                .bind(attempt_id)
                .bind(status.as_u16().to_string())
                .bind(persisted_message)
                .execute(&state.db)
                .await
                .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
                return Err(helcim_terminal_purchase_error(status, &raw_text, is_html));
            }

            let persisted_message = persisted_provider_error(&error.message);
            sqlx::query(
                r#"
                UPDATE payment_provider_attempts
                SET status = 'failed', error_code = 'request_failed', error_message = $2, completed_at = now()
                WHERE id = $1
                "#,
            )
            .bind(attempt_id)
            .bind(persisted_message)
            .execute(&state.db)
            .await
            .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
            return Err(PaymentError::ProviderError(error.message));
        }
    };
    let pending = helcim::normalize_accepted_purchase(
        terminal_id.clone(),
        payload.amount_cents,
        currency,
        idempotency_key,
        accepted,
    );

    sqlx::query(
        r#"
        UPDATE payment_provider_attempts
        SET provider_payment_id = $2,
            provider_transaction_id = $3,
            raw_audit_reference = $4
        WHERE id = $1
        "#,
    )
    .bind(attempt_id)
    .bind(&pending.provider_payment_id)
    .bind(&pending.provider_transaction_id)
    .bind(&pending.raw_audit_reference)
    .execute(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    load_helcim_attempt(&state, attempt_id, None)
        .await
        .map(Json)
}

async fn start_helcim_terminal_refund(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<HelcimTerminalRefundRequestBody>,
) -> Result<Json<HelcimAttemptResponse>, PaymentError> {
    let auth = middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;
    if load_active_card_provider(&state).await? != helcim::HELCIM_PROVIDER_KEY {
        return Err(PaymentError::InvalidPayload(
            "Helcim is not the active card provider.".to_string(),
        ));
    }

    if payload.amount_cents <= 0 {
        return Err(PaymentError::InvalidPayload(
            "Helcim terminal refunds must be greater than zero.".to_string(),
        ));
    }
    if payload.original_transaction_id <= 0 {
        return Err(PaymentError::InvalidPayload(
            "original_transaction_id is required".to_string(),
        ));
    }
    if !payload.customer_present_confirmed {
        return Err(PaymentError::InvalidPayload(
            "Helcim terminal debit refunds require the original card and customer present at the terminal.".to_string(),
        ));
    }

    let (register_session_id, staff_id) = match auth {
        middleware::StaffOrPosSession::Staff(staff) => {
            (payload.register_session_id, Some(staff.id))
        }
        middleware::StaffOrPosSession::PosSession { session_id } => (Some(session_id), None),
    };
    let config = helcim::HelcimConfig::from_env();
    let terminal_route = resolve_helcim_terminal_for_register_with_selection(
        &state,
        &state.db,
        &config,
        register_session_id,
        payload.selected_terminal_key.as_deref(),
        payload.terminal_override_reason.as_deref(),
        staff_id,
    )
    .await?;
    let terminal_id = terminal_route.terminal_id.clone();
    expire_stale_helcim_terminal_attempts(&state.db, &terminal_id).await?;
    let currency = payload
        .currency
        .as_deref()
        .unwrap_or("usd")
        .trim()
        .to_ascii_lowercase();
    validate_currency(&currency)?;

    let attempt_id = Uuid::new_v4();
    let idempotency_key = format!("helcim-refund-{attempt_id}");

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    lock_register_session_open_for_payment(&mut tx, register_session_id).await?;
    let insert_result = sqlx::query(
        r#"
        INSERT INTO payment_provider_attempts (
            id, provider, status, amount_cents, currency, register_session_id, staff_id,
            device_id, terminal_id, selected_terminal_key, terminal_route_source,
            terminal_override_staff_id, terminal_override_reason, idempotency_key,
            provider_transaction_id, raw_audit_reference
        )
        VALUES ($1, 'helcim', 'pending', $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, NULL, $12)
        "#,
    )
    .bind(attempt_id)
    .bind(payload.amount_cents)
    .bind(&currency)
    .bind(register_session_id)
    .bind(staff_id)
    .bind(&terminal_id)
    .bind(&terminal_route.terminal_key)
    .bind(&terminal_route.route_source)
    .bind(terminal_route.override_staff_id)
    .bind(&terminal_route.override_reason)
    .bind(&idempotency_key)
    .bind(format!(
        "helcim:terminalRefund:{}",
        payload.original_transaction_id
    ))
    .execute(&mut *tx)
    .await;

    if let Err(e) = insert_result {
        let _ = tx.rollback().await;
        if e.as_database_error().and_then(|db| db.constraint())
            == Some("uq_payment_provider_attempts_active_device")
        {
            return Err(PaymentError::Conflict(
                terminal_in_use_message(&state.db, &terminal_id).await?,
            ));
        }
        return Err(PaymentError::InvalidPayload(e.to_string()));
    }
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    if config.simulator_enabled() {
        return load_helcim_attempt(&state, attempt_id, None)
            .await
            .map(Json);
    }

    let request_payload = helcim::build_terminal_refund_request_payload(
        payload.amount_cents,
        payload.original_transaction_id,
    );
    match helcim::start_terminal_refund(
        &state.http_client,
        &config,
        &terminal_id,
        request_payload,
        &idempotency_key,
    )
    .await
    {
        Ok(accepted) => {
            let provider_payment_id = accepted.payment_id;
            let provider_transaction_id = accepted.transaction_id;
            sqlx::query(
                r#"
                UPDATE payment_provider_attempts
                SET provider_payment_id = $2,
                    provider_transaction_id = $3,
                    raw_audit_reference = COALESCE($4, raw_audit_reference)
                WHERE id = $1
                "#,
            )
            .bind(attempt_id)
            .bind(provider_payment_id)
            .bind(provider_transaction_id)
            .bind(accepted.audit_reference.or(accepted.status))
            .execute(&state.db)
            .await
            .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
        }
        Err(error) => {
            let persisted_message = persisted_provider_error(&error);
            sqlx::query(
                r#"
                UPDATE payment_provider_attempts
                SET status = 'failed', error_code = 'request_failed', error_message = $2, completed_at = now()
                WHERE id = $1
                "#,
            )
            .bind(attempt_id)
            .bind(persisted_message)
            .execute(&state.db)
            .await
            .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
            return Err(PaymentError::ProviderError(error));
        }
    }

    load_helcim_attempt(&state, attempt_id, None)
        .await
        .map(Json)
}

async fn process_helcim_card_token_purchase(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<HelcimCardTokenPurchaseRequestBody>,
) -> Result<Json<HelcimAttemptResponse>, PaymentError> {
    let auth = middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;
    if load_active_card_provider(&state).await? != helcim::HELCIM_PROVIDER_KEY {
        return Err(PaymentError::InvalidPayload(
            "Helcim is not the active card provider.".to_string(),
        ));
    }
    if payload.amount_cents <= 0 {
        return Err(PaymentError::InvalidPayload(
            "amount_cents must be greater than zero".to_string(),
        ));
    }
    let card_token = payload.card_token.trim();
    if card_token.is_empty() {
        return Err(PaymentError::InvalidPayload(
            "card_token is required".to_string(),
        ));
    }
    let currency = payload
        .currency
        .as_deref()
        .unwrap_or("usd")
        .trim()
        .to_ascii_uppercase();
    validate_currency(&currency.to_ascii_lowercase())?;
    let config = helcim::HelcimConfig::from_env();
    let attempt_id = Uuid::new_v4();
    let idempotency_key = format!("helcim-token-{attempt_id}");
    let (register_session_id, staff_id) = match auth {
        middleware::StaffOrPosSession::Staff(staff) => {
            (payload.register_session_id, Some(staff.id))
        }
        middleware::StaffOrPosSession::PosSession { session_id } => (Some(session_id), None),
    };
    sqlx::query(
        r#"
        INSERT INTO payment_provider_attempts (
            id, provider, status, amount_cents, currency, register_session_id, staff_id,
            idempotency_key, raw_audit_reference
        )
        VALUES ($1, 'helcim', 'pending', $2, $3, $4, $5, $6, 'helcim:cardTokenPurchase')
        "#,
    )
    .bind(attempt_id)
    .bind(payload.amount_cents)
    .bind(currency.to_ascii_lowercase())
    .bind(register_session_id)
    .bind(staff_id)
    .bind(&idempotency_key)
    .execute(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    if config.simulator_enabled() {
        let transaction_id = format!("helcim-sim-{attempt_id}");
        sqlx::query(
            r#"
            UPDATE payment_provider_attempts
            SET status = 'approved',
                provider_payment_id = $2,
                provider_transaction_id = $2,
                raw_audit_reference = $3,
                completed_at = now()
            WHERE id = $1
            "#,
        )
        .bind(attempt_id)
        .bind(&transaction_id)
        .bind(format!("helcim-sim:approved:{attempt_id}"))
        .execute(&state.db)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

        return load_helcim_attempt(&state, attempt_id, None)
            .await
            .map(Json);
    }

    let request = helcim::HelcimCardPurchaseRequest {
        ip_address: request_ip_address(&headers),
        ecommerce: false,
        currency,
        amount: cents_to_decimal_string(payload.amount_cents),
        customer_code: payload.customer_code.and_then(non_empty_string),
        invoice_number: payload.invoice_number.and_then(non_empty_string),
        card_data: helcim::HelcimCardData {
            card_token: card_token.to_string(),
        },
    };
    let transaction = match helcim::process_card_token_purchase(
        &state.http_client,
        &config,
        request,
        &idempotency_key,
    )
    .await
    {
        Ok(transaction) => transaction,
        Err(error) => {
            let persisted_message = persisted_provider_error(&error);
            sqlx::query(
                r#"
                UPDATE payment_provider_attempts
                SET status = 'failed',
                    error_code = 'request_failed',
                    error_message = $2,
                    completed_at = now()
                WHERE id = $1
                "#,
            )
            .bind(attempt_id)
            .bind(persisted_message)
            .execute(&state.db)
            .await
            .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
            return Err(PaymentError::ProviderError(error));
        }
    };

    let status = transaction.normalized_status();
    let provider_transaction_id = transaction.transaction_id_string();
    let raw_audit_reference = transaction.audit_reference();
    let warning = transaction
        .warning
        .as_deref()
        .map(helcim::redact_provider_text);
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    lock_register_session_open_for_payment(&mut tx, register_session_id).await?;
    sqlx::query(
        r#"
        UPDATE payment_provider_attempts
        SET status = $2,
            provider_payment_id = $3,
            provider_transaction_id = $3,
            error_code = CASE WHEN $2 = 'failed' THEN 'declined' ELSE NULL END,
            error_message = CASE WHEN $2 = 'failed' THEN COALESCE($5, 'Helcim payment was declined.') ELSE NULL END,
            raw_audit_reference = COALESCE($4, raw_audit_reference),
            completed_at = now()
        WHERE id = $1
        "#,
    )
    .bind(attempt_id)
    .bind(&status)
    .bind(provider_transaction_id)
    .bind(raw_audit_reference)
    .bind(warning)
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    load_helcim_attempt(&state, attempt_id, None)
        .await
        .map(Json)
}

async fn process_helcim_card_refund(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<HelcimCardRefundRequestBody>,
) -> Result<Json<HelcimAttemptResponse>, PaymentError> {
    let auth = middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;
    if load_active_card_provider(&state).await? != helcim::HELCIM_PROVIDER_KEY {
        return Err(PaymentError::InvalidPayload(
            "Helcim is not the active card provider.".to_string(),
        ));
    }
    if payload.amount_cents <= 0 || payload.original_transaction_id <= 0 {
        return Err(PaymentError::InvalidPayload(
            "amount_cents and original_transaction_id are required".to_string(),
        ));
    }
    let (register_session_id, staff_id) = match auth {
        middleware::StaffOrPosSession::Staff(staff) => {
            (payload.register_session_id, Some(staff.id))
        }
        middleware::StaffOrPosSession::PosSession { session_id } => (Some(session_id), None),
    };
    let config = helcim::HelcimConfig::from_env();
    let attempt_id = Uuid::new_v4();
    let idempotency_key = payload
        .idempotency_key
        .and_then(non_empty_string)
        .unwrap_or_else(|| format!("helcim-card-refund-{attempt_id}"));
    if let Some(existing) = load_helcim_attempt_by_idempotency_key(
        &state,
        &idempotency_key,
        register_session_id,
        staff_id,
    )
    .await?
    {
        return Ok(Json(existing));
    }

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    lock_register_session_open_for_payment(&mut tx, register_session_id).await?;
    let insert_result = sqlx::query(
        r#"
        INSERT INTO payment_provider_attempts (
            id, provider, status, amount_cents, currency, register_session_id, staff_id,
            idempotency_key, provider_transaction_id, raw_audit_reference
        )
        VALUES ($1, 'helcim', 'pending', $2, 'usd', $3, $4, $5, $6, $7)
        "#,
    )
    .bind(attempt_id)
    .bind(payload.amount_cents)
    .bind(register_session_id)
    .bind(staff_id)
    .bind(&idempotency_key)
    .bind(payload.original_transaction_id.to_string())
    .bind(format!(
        "helcim:cardRefund:{}",
        payload.original_transaction_id
    ))
    .execute(&mut *tx)
    .await;
    if let Err(error) = insert_result {
        if is_provider_idempotency_violation(&error) {
            let _ = tx.rollback().await;
            if let Some(existing) = load_helcim_attempt_by_idempotency_key(
                &state,
                &idempotency_key,
                register_session_id,
                staff_id,
            )
            .await?
            {
                return Ok(Json(existing));
            }
        }
        return Err(PaymentError::InvalidPayload(error.to_string()));
    }
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let request = helcim::HelcimCardRefundRequest {
        original_transaction_id: payload.original_transaction_id,
        amount: cents_to_decimal_string(payload.amount_cents),
        ip_address: request_ip_address(&headers),
        ecommerce: false,
    };
    let transaction =
        match helcim::process_card_refund(&state.http_client, &config, request, &idempotency_key)
            .await
        {
            Ok(transaction) => transaction,
            Err(error) => {
                let persisted_message = persisted_provider_error(&error);
                sqlx::query(
                    r#"
                UPDATE payment_provider_attempts
                SET status = 'failed',
                    error_code = 'request_failed',
                    error_message = $2,
                    completed_at = now()
                WHERE id = $1
                "#,
                )
                .bind(attempt_id)
                .bind(persisted_message)
                .execute(&state.db)
                .await
                .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
                return Err(PaymentError::ProviderError(error));
            }
        };

    let status = transaction.normalized_status();
    let provider_transaction_id = transaction.transaction_id_string();
    let warning = transaction
        .warning
        .as_deref()
        .map(helcim::redact_provider_text);
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    lock_register_session_open_for_payment(&mut tx, register_session_id).await?;
    sqlx::query(
        r#"
        UPDATE payment_provider_attempts
        SET status = $2,
            provider_payment_id = $3,
            provider_transaction_id = COALESCE($3, provider_transaction_id),
            error_code = CASE WHEN $2 = 'failed' THEN 'declined' ELSE NULL END,
            error_message = CASE WHEN $2 = 'failed' THEN COALESCE($5, 'Helcim refund was declined.') ELSE NULL END,
            raw_audit_reference = COALESCE($4, raw_audit_reference),
            completed_at = now()
        WHERE id = $1
        "#,
    )
    .bind(attempt_id)
    .bind(status)
    .bind(provider_transaction_id)
    .bind(transaction.audit_reference())
    .bind(warning)
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    load_helcim_attempt(&state, attempt_id, register_session_id)
        .await
        .map(Json)
}

async fn process_helcim_card_reverse(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<HelcimCardReverseRequestBody>,
) -> Result<Json<HelcimAttemptResponse>, PaymentError> {
    let auth = middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;
    if load_active_card_provider(&state).await? != helcim::HELCIM_PROVIDER_KEY {
        return Err(PaymentError::InvalidPayload(
            "Helcim is not the active card provider.".to_string(),
        ));
    }
    if payload.original_transaction_id <= 0 {
        return Err(PaymentError::InvalidPayload(
            "original_transaction_id is required".to_string(),
        ));
    }
    let (register_session_id, staff_id) = match auth {
        middleware::StaffOrPosSession::Staff(staff) => {
            (payload.register_session_id, Some(staff.id))
        }
        middleware::StaffOrPosSession::PosSession { session_id } => (Some(session_id), None),
    };
    let config = helcim::HelcimConfig::from_env();
    let attempt_id = Uuid::new_v4();
    let idempotency_key = payload
        .idempotency_key
        .and_then(non_empty_string)
        .unwrap_or_else(|| format!("helcim-card-reverse-{attempt_id}"));
    if let Some(existing) = load_helcim_attempt_by_idempotency_key(
        &state,
        &idempotency_key,
        register_session_id,
        staff_id,
    )
    .await?
    {
        return Ok(Json(existing));
    }
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    lock_register_session_open_for_payment(&mut tx, register_session_id).await?;
    let insert_result = sqlx::query(
        r#"
        INSERT INTO payment_provider_attempts (
            id, provider, status, amount_cents, currency, register_session_id, staff_id,
            idempotency_key, provider_transaction_id, raw_audit_reference
        )
        VALUES ($1, 'helcim', 'pending', 0, 'usd', $2, $3, $4, $5, $6)
        "#,
    )
    .bind(attempt_id)
    .bind(register_session_id)
    .bind(staff_id)
    .bind(&idempotency_key)
    .bind(payload.original_transaction_id.to_string())
    .bind(format!(
        "helcim:cardReverse:{}",
        payload.original_transaction_id
    ))
    .execute(&mut *tx)
    .await;
    if let Err(error) = insert_result {
        if is_provider_idempotency_violation(&error) {
            let _ = tx.rollback().await;
            if let Some(existing) = load_helcim_attempt_by_idempotency_key(
                &state,
                &idempotency_key,
                register_session_id,
                staff_id,
            )
            .await?
            {
                return Ok(Json(existing));
            }
        }
        return Err(PaymentError::InvalidPayload(error.to_string()));
    }
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let request = helcim::HelcimCardReverseRequest {
        card_transaction_id: payload.original_transaction_id,
        ip_address: request_ip_address(&headers),
        ecommerce: false,
    };
    let transaction =
        match helcim::process_card_reverse(&state.http_client, &config, request, &idempotency_key)
            .await
        {
            Ok(transaction) => transaction,
            Err(error) => {
                let persisted_message = persisted_provider_error(&error);
                sqlx::query(
                    r#"
                UPDATE payment_provider_attempts
                SET status = 'failed',
                    error_code = 'request_failed',
                    error_message = $2,
                    completed_at = now()
                WHERE id = $1
                "#,
                )
                .bind(attempt_id)
                .bind(persisted_message)
                .execute(&state.db)
                .await
                .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
                return Err(PaymentError::ProviderError(error));
            }
        };

    let status = transaction.normalized_status();
    let provider_transaction_id = transaction.transaction_id_string();
    let warning = transaction
        .warning
        .as_deref()
        .map(helcim::redact_provider_text);
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    lock_register_session_open_for_payment(&mut tx, register_session_id).await?;
    sqlx::query(
        r#"
        UPDATE payment_provider_attempts
        SET status = $2,
            provider_payment_id = $3,
            provider_transaction_id = COALESCE($3, provider_transaction_id),
            error_code = CASE WHEN $2 = 'failed' THEN 'declined' ELSE NULL END,
            error_message = CASE WHEN $2 = 'failed' THEN COALESCE($5, 'Helcim reverse was declined.') ELSE NULL END,
            raw_audit_reference = COALESCE($4, raw_audit_reference),
            completed_at = now()
        WHERE id = $1
        "#,
    )
    .bind(attempt_id)
    .bind(status)
    .bind(provider_transaction_id)
    .bind(transaction.audit_reference())
    .bind(warning)
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    load_helcim_attempt(&state, attempt_id, register_session_id)
        .await
        .map(Json)
}

async fn initialize_helcim_pay(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<HelcimPayInitializeRequestBody>,
) -> Result<Json<HelcimPayInitializeResponseBody>, PaymentError> {
    let auth = middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;
    if load_active_card_provider(&state).await? != helcim::HELCIM_PROVIDER_KEY {
        return Err(PaymentError::InvalidPayload(
            "Helcim is not the active card provider.".to_string(),
        ));
    }
    if payload.amount_cents <= 0 {
        return Err(PaymentError::InvalidPayload(
            "amount_cents must be greater than zero".to_string(),
        ));
    }
    let currency = payload
        .currency
        .as_deref()
        .unwrap_or("usd")
        .trim()
        .to_ascii_uppercase();
    validate_currency(&currency.to_ascii_lowercase())?;

    let config = helcim::HelcimConfig::from_env();
    let customer_code = payload.customer_code.and_then(non_empty_string);
    let invoice_number = payload.invoice_number.and_then(non_empty_string);
    let request = helcim::HelcimPayInitializeRequest {
        payment_type: "purchase".to_string(),
        amount: cents_to_decimal_string(payload.amount_cents),
        currency: currency.clone(),
        payment_method: "cc".to_string(),
        customer_code,
        invoice_number,
        hide_existing_payment_details: payload
            .hide_existing_payment_details
            .filter(|enabled| *enabled)
            .map(|_| 1),
        set_as_default_payment_method: payload
            .save_as_default
            .filter(|enabled| *enabled)
            .map(|_| 1),
        confirmation_screen: false,
        display_contact_fields: None,
    };
    let initialized = helcim::initialize_helcim_pay(&state.http_client, &config, request)
        .await
        .map_err(PaymentError::ProviderError)?;

    let attempt_id = Uuid::new_v4();
    let idempotency_key = format!("helcim-pay-{attempt_id}");
    let (register_session_id, staff_id) = match auth {
        middleware::StaffOrPosSession::Staff(staff) => {
            (payload.register_session_id, Some(staff.id))
        }
        middleware::StaffOrPosSession::PosSession { session_id } => (Some(session_id), None),
    };
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    lock_register_session_open_for_payment(&mut tx, register_session_id).await?;
    sqlx::query(
        r#"
        INSERT INTO payment_provider_attempts (
            id, provider, status, amount_cents, currency, register_session_id, staff_id,
            idempotency_key, provider_payment_id, provider_client_secret, raw_audit_reference
        )
        VALUES ($1, 'helcim', 'pending', $2, $3, $4, $5, $6, $7, $8, 'helcim-pay-js')
        "#,
    )
    .bind(attempt_id)
    .bind(payload.amount_cents)
    .bind(currency.to_ascii_lowercase())
    .bind(register_session_id)
    .bind(staff_id)
    .bind(&idempotency_key)
    .bind(&initialized.checkout_token)
    .bind(&initialized.secret_token)
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    Ok(Json(HelcimPayInitializeResponseBody {
        attempt: load_helcim_attempt(&state, attempt_id, None).await?,
        checkout_token: initialized.checkout_token,
    }))
}

async fn confirm_helcim_pay(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<HelcimPayConfirmRequestBody>,
) -> Result<Json<HelcimAttemptResponse>, PaymentError> {
    let auth = middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;
    let pos_session_id = match auth {
        middleware::StaffOrPosSession::PosSession { session_id } => Some(session_id),
        middleware::StaffOrPosSession::Staff(_) => None,
    };

    let row: Option<(String, i64, Option<Uuid>, Option<String>)> = sqlx::query_as(
        r#"
        SELECT status, amount_cents, register_session_id, provider_client_secret
        FROM payment_provider_attempts
        WHERE id = $1
          AND provider = 'helcim'
          AND provider_payment_id = $2
        "#,
    )
    .bind(payload.attempt_id)
    .bind(payload.checkout_token.trim())
    .fetch_optional(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    let Some((attempt_status, amount_cents, register_session_id, client_secret)) = row else {
        return Err(PaymentError::InvalidPayload(
            "HelcimPay.js attempt not found".to_string(),
        ));
    };
    if let Some(session_id) = pos_session_id {
        if register_session_id != Some(session_id) {
            return Err(PaymentError::Forbidden(
                "Helcim attempt does not belong to this register session.".to_string(),
            ));
        }
    }
    if attempt_status != "pending" {
        return Err(PaymentError::InvalidPayload(
            "HelcimPay.js attempt has already been completed".to_string(),
        ));
    }
    let client_secret = client_secret.ok_or_else(|| {
        PaymentError::InvalidPayload("HelcimPay.js validation secret is missing".to_string())
    })?;

    let canonical = serde_json::to_string(&payload.data)
        .map_err(|_| PaymentError::InvalidPayload("invalid Helcim response".to_string()))?;
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hasher.update(client_secret.as_bytes());
    let expected = hex::encode(hasher.finalize());
    if !expected.eq_ignore_ascii_case(payload.hash.trim()) {
        return Err(PaymentError::InvalidPayload(
            "HelcimPay.js response hash did not validate".to_string(),
        ));
    }

    let returned_amount = value_decimal_string(&payload.data, "amount")
        .ok_or_else(|| PaymentError::InvalidPayload("Helcim amount is missing".to_string()))?;
    if returned_amount != cents_to_decimal_string(amount_cents) {
        return Err(PaymentError::InvalidPayload(
            "Helcim amount does not match the approved payment".to_string(),
        ));
    }

    let provider_status = value_string(&payload.data, "status").unwrap_or_default();
    let normalized_status = match provider_status.trim().to_ascii_lowercase().as_str() {
        "approved" | "approval" | "captured" | "capture" => "approved",
        "cancelled" | "canceled" => "canceled",
        _ => "failed",
    };
    let provider_transaction_id =
        value_string(&payload.data, "transactionId").ok_or_else(|| {
            PaymentError::InvalidPayload("Helcim transaction id is missing".to_string())
        })?;
    let warning = value_string(&payload.data, "warning")
        .as_deref()
        .map(helcim::redact_provider_text);

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    lock_register_session_open_for_payment(&mut tx, register_session_id).await?;
    sqlx::query(
        r#"
        UPDATE payment_provider_attempts
        SET status = $2,
            provider_transaction_id = $3,
            error_code = CASE WHEN $2 = 'failed' THEN 'declined' ELSE NULL END,
            error_message = CASE WHEN $2 = 'failed' THEN COALESCE($4, 'Helcim payment was declined.') ELSE NULL END,
            raw_audit_reference = $5,
            provider_client_secret = NULL,
            completed_at = now()
        WHERE id = $1
        "#,
    )
    .bind(payload.attempt_id)
    .bind(normalized_status)
    .bind(&provider_transaction_id)
    .bind(warning)
    .bind(format!("helcim-pay-js:{provider_transaction_id}"))
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    load_helcim_attempt(&state, payload.attempt_id, pos_session_id)
        .await
        .map(Json)
}

async fn list_helcim_customers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HelcimCustomersQuery>,
) -> Result<Json<serde_json::Value>, PaymentError> {
    middleware::require_staff_with_permission(&state, &headers, CUSTOMERS_HUB_VIEW)
        .await
        .map_err(map_pay_session)?;
    let mut params = Vec::new();
    if let Some(value) = query.customer_code.and_then(non_empty_string) {
        params.push(("customerCode", value));
    } else if let Some(value) = query.search.and_then(non_empty_string) {
        params.push(("search", value));
    }
    if query.include_cards.unwrap_or(false) {
        params.push(("includeCards", "yes".to_string()));
    }
    let config = helcim::HelcimConfig::from_env();
    let body = helcim::get_customers(&state.http_client, &config, &params)
        .await
        .map_err(PaymentError::ProviderError)?;
    Ok(Json(body))
}

async fn list_helcim_customer_cards(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<i64>,
    Query(query): Query<HelcimCustomerCardsQuery>,
) -> Result<Json<serde_json::Value>, PaymentError> {
    middleware::require_staff_with_permission(&state, &headers, CUSTOMERS_HUB_VIEW)
        .await
        .map_err(map_pay_session)?;
    if customer_id <= 0 {
        return Err(PaymentError::InvalidPayload(
            "customer_id must be a Helcim customer id".to_string(),
        ));
    }
    let config = helcim::HelcimConfig::from_env();
    let body = helcim::get_customer_cards(
        &state.http_client,
        &config,
        customer_id,
        query.card_token.and_then(non_empty_string),
    )
    .await
    .map_err(PaymentError::ProviderError)?;
    Ok(Json(body))
}

async fn delete_helcim_customer_card(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((customer_id, card_id)): Path<(i64, i64)>,
) -> Result<StatusCode, PaymentError> {
    middleware::require_staff_with_permission(&state, &headers, CUSTOMERS_HUB_EDIT)
        .await
        .map_err(map_pay_session)?;
    if customer_id <= 0 || card_id <= 0 {
        return Err(PaymentError::InvalidPayload(
            "customer_id and card_id must be Helcim ids".to_string(),
        ));
    }
    let config = helcim::HelcimConfig::from_env();
    helcim::delete_customer_card(&state.http_client, &config, customer_id, card_id)
        .await
        .map_err(PaymentError::ProviderError)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_helcim_customer_card_default(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((customer_id, card_id)): Path<(i64, i64)>,
) -> Result<Json<serde_json::Value>, PaymentError> {
    middleware::require_staff_with_permission(&state, &headers, CUSTOMERS_HUB_EDIT)
        .await
        .map_err(map_pay_session)?;
    if customer_id <= 0 || card_id <= 0 {
        return Err(PaymentError::InvalidPayload(
            "customer_id and card_id must be Helcim ids".to_string(),
        ));
    }
    let config = helcim::HelcimConfig::from_env();
    let body = helcim::set_customer_card_default(&state.http_client, &config, customer_id, card_id)
        .await
        .map_err(PaymentError::ProviderError)?;
    Ok(Json(body))
}

async fn simulate_helcim_attempt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(attempt_id): Path<Uuid>,
    Json(payload): Json<HelcimSimulateAttemptRequest>,
) -> Result<Json<HelcimAttemptResponse>, PaymentError> {
    let config = helcim::HelcimConfig::from_env();
    if !config.simulator_enabled() {
        return Err(PaymentError::Forbidden(
            "Helcim simulator is not enabled.".to_string(),
        ));
    }

    let auth = middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;
    let session_id = match auth {
        middleware::StaffOrPosSession::PosSession { session_id } => Some(session_id),
        middleware::StaffOrPosSession::Staff(_) => None,
    };
    let attempt = load_helcim_attempt_row(&state, attempt_id).await?;
    if let Some(session_id) = session_id {
        if attempt.register_session_id != Some(session_id) {
            return Err(PaymentError::Forbidden(
                "Helcim attempt does not belong to this register session.".to_string(),
            ));
        }
    }
    if attempt.status != "pending" {
        return Err(PaymentError::InvalidPayload(
            "Only pending Helcim attempts can be simulated.".to_string(),
        ));
    }

    let outcome = payload.outcome.trim().to_ascii_lowercase();
    let transaction_id = format!("helcim-sim-{attempt_id}");
    let (status, error_code, error_message, provider_payment_id, provider_transaction_id) =
        match outcome.as_str() {
            "approve" | "approved" | "capture" | "captured" => (
                "approved",
                None,
                None,
                Some(transaction_id.clone()),
                Some(transaction_id.clone()),
            ),
            "decline" | "declined" | "fail" | "failed" => (
                "failed",
                Some("simulated_decline"),
                Some("Simulated Helcim decline."),
                Some(transaction_id.clone()),
                Some(transaction_id.clone()),
            ),
            "cancel" | "canceled" | "cancelled" => (
                "canceled",
                Some("simulated_cancel"),
                Some("Simulated Helcim terminal cancel."),
                None,
                None,
            ),
            _ => {
                return Err(PaymentError::InvalidPayload(
                    "outcome must be approve, decline, or cancel".to_string(),
                ));
            }
        };

    let audit = format!("helcim-sim:{status}:{attempt_id}");
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    lock_register_session_open_for_payment(&mut tx, attempt.register_session_id).await?;
    sqlx::query(
        r#"
        UPDATE payment_provider_attempts
        SET status = $2,
            provider_payment_id = $3,
            provider_transaction_id = $4,
            error_code = $5,
            error_message = $6,
            raw_audit_reference = $7,
            completed_at = now()
        WHERE id = $1 AND provider = 'helcim' AND status = 'pending'
        "#,
    )
    .bind(attempt_id)
    .bind(status)
    .bind(provider_payment_id)
    .bind(provider_transaction_id)
    .bind(error_code)
    .bind(error_message)
    .bind(audit)
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    load_helcim_attempt(&state, attempt_id, session_id)
        .await
        .map(Json)
}

async fn release_helcim_terminal_attempt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(attempt_id): Path<Uuid>,
) -> Result<Json<HelcimAttemptResponse>, PaymentError> {
    let auth = middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;
    let session_id = match auth {
        middleware::StaffOrPosSession::PosSession { session_id } => Some(session_id),
        middleware::StaffOrPosSession::Staff(_) => None,
    };
    let attempt = load_helcim_attempt_row(&state, attempt_id).await?;
    if let Some(session_id) = session_id {
        if attempt.register_session_id != Some(session_id) {
            return Err(PaymentError::Forbidden(
                "Helcim attempt does not belong to this register session.".to_string(),
            ));
        }
    }
    if attempt.status != "pending" {
        return Err(PaymentError::InvalidPayload(
            "Only pending Helcim terminal attempts can be released.".to_string(),
        ));
    }
    if attempt.provider_payment_id.is_some() || attempt.provider_transaction_id.is_some() {
        return Err(PaymentError::Conflict(
            "Helcim returned a provider reference for this attempt. Use Check Terminal before releasing it locally.".to_string(),
        ));
    }

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    if session_id.is_some() {
        lock_register_session_open_for_payment(&mut tx, attempt.register_session_id).await?;
    }
    let result = sqlx::query(
        r#"
        UPDATE payment_provider_attempts
        SET status = 'expired',
            error_code = 'terminal_released_no_provider_reference',
            error_message = 'Released locally after the terminal returned to ready; Helcim did not provide a payment reference to poll.',
            completed_at = now()
        WHERE id = $1
          AND provider = 'helcim'
          AND status = 'pending'
          AND provider_payment_id IS NULL
          AND provider_transaction_id IS NULL
        "#,
    )
    .bind(attempt_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    if result.rows_affected() == 0 {
        let _ = tx.rollback().await;
        return Err(PaymentError::Conflict(
            "Helcim attempt could not be released because it changed while checking status."
                .to_string(),
        ));
    }
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    load_helcim_attempt(&state, attempt_id, session_id)
        .await
        .map(Json)
}

async fn get_helcim_attempt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(attempt_id): Path<Uuid>,
) -> Result<Json<HelcimAttemptResponse>, PaymentError> {
    let auth = middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;
    let session_id = match auth {
        middleware::StaffOrPosSession::PosSession { session_id } => Some(session_id),
        middleware::StaffOrPosSession::Staff(_) => None,
    };
    load_helcim_attempt(&state, attempt_id, session_id)
        .await
        .map(Json)
}

async fn stream_helcim_attempt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(attempt_id): Path<Uuid>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>> + Send>, PaymentError> {
    let auth = middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;
    let session_id = match auth {
        middleware::StaffOrPosSession::PosSession { session_id } => Some(session_id),
        middleware::StaffOrPosSession::Staff(_) => None,
    };

    load_helcim_attempt(&state, attempt_id, session_id).await?;

    let stream = stream::unfold(
        (state, attempt_id, session_id, 0_u16),
        |(state, attempt_id, session_id, tick)| async move {
            if tick > HELCIM_ATTEMPT_STREAM_MAX_SECONDS {
                return None;
            }
            if tick > 0 {
                tokio::time::sleep(StdDuration::from_secs(1)).await;
            }

            let (event, next_tick) = match load_helcim_attempt(&state, attempt_id, session_id).await
            {
                Ok(attempt) => {
                    let next_tick = if attempt.status == "pending" {
                        tick.saturating_add(1)
                    } else {
                        HELCIM_ATTEMPT_STREAM_MAX_SECONDS.saturating_add(1)
                    };
                    let event = Event::default()
                        .event("attempt")
                        .json_data(&attempt)
                        .unwrap_or_else(|error| {
                            Event::default()
                                .event("error")
                                .data(json!({ "error": error.to_string() }).to_string())
                        });
                    (event, next_tick)
                }
                Err(error) => {
                    let event = Event::default()
                        .event("error")
                        .data(json!({ "error": error.to_string() }).to_string());
                    (event, HELCIM_ATTEMPT_STREAM_MAX_SECONDS.saturating_add(1))
                }
            };

            Some((Ok(event), (state, attempt_id, session_id, next_tick)))
        },
    );

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(StdDuration::from_secs(15))))
}

fn validate_currency(currency: &str) -> Result<(), PaymentError> {
    if currency.len() == 3 && currency.chars().all(|c| c.is_ascii_lowercase()) {
        Ok(())
    } else {
        Err(PaymentError::InvalidPayload(
            "currency must be a 3-letter code".to_string(),
        ))
    }
}

fn request_ip_address(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("127.0.0.1")
        .to_string()
}

fn non_empty_string(value: String) -> Option<String> {
    Some(value.trim().to_string()).filter(|value| !value.is_empty())
}

fn value_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|field| match field {
            Value::String(value) => Some(value.trim().to_string()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
        .filter(|value| !value.is_empty())
}

fn value_decimal_string(value: &Value, key: &str) -> Option<String> {
    let raw = value_string(value, key)?;
    let decimal = rust_decimal::Decimal::from_str_exact(&raw).ok()?;
    Some(decimal.round_dp(2).to_string())
}

fn cents_to_decimal_string(amount_cents: i64) -> String {
    let sign = if amount_cents < 0 { "-" } else { "" };
    let abs = amount_cents.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

fn should_skip_provider_refresh_for_idempotency_replay(attempt: &HelcimAttemptRow) -> bool {
    attempt.status == "pending"
}

async fn load_helcim_attempt_by_idempotency_key(
    state: &AppState,
    idempotency_key: &str,
    register_session_id: Option<Uuid>,
    staff_id: Option<Uuid>,
) -> Result<Option<HelcimAttemptResponse>, PaymentError> {
    let attempt = sqlx::query_as::<_, HelcimAttemptRow>(
        r#"
        SELECT id, provider, status, amount_cents, currency, register_session_id, staff_id,
               device_id, terminal_id, selected_terminal_key, terminal_route_source,
               terminal_override_staff_id, terminal_override_reason, idempotency_key, provider_payment_id,
               provider_transaction_id, error_code, error_message, raw_audit_reference,
               created_at, updated_at, completed_at
        FROM payment_provider_attempts
        WHERE provider = 'helcim' AND idempotency_key = $1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let Some(attempt) = attempt else {
        return Ok(None);
    };

    if let Some(session_id) = register_session_id {
        if attempt.register_session_id != Some(session_id) {
            return Err(PaymentError::Forbidden(
                "Helcim attempt does not belong to this register session.".to_string(),
            ));
        }
    } else if let Some(staff_id) = staff_id {
        if attempt.staff_id != Some(staff_id) {
            return Err(PaymentError::Forbidden(
                "Helcim attempt does not belong to this staff member.".to_string(),
            ));
        }
    } else {
        return Err(PaymentError::Forbidden(
            "Helcim attempt scope could not be verified.".to_string(),
        ));
    }

    if should_skip_provider_refresh_for_idempotency_replay(&attempt) {
        return Ok(Some(HelcimAttemptResponse::from_row(attempt, None, None)));
    }

    load_helcim_attempt(state, attempt.id, register_session_id)
        .await
        .map(Some)
}

async fn load_helcim_attempt(
    state: &AppState,
    attempt_id: Uuid,
    pos_session_id: Option<Uuid>,
) -> Result<HelcimAttemptResponse, PaymentError> {
    let mut attempt = load_helcim_attempt_row(state, attempt_id).await?;

    if let Some(session_id) = pos_session_id {
        if attempt.register_session_id != Some(session_id) {
            return Err(PaymentError::Forbidden(
                "Helcim attempt does not belong to this register session.".to_string(),
            ));
        }
    }

    if attempt.status == "pending" || attempt.status == "failed" {
        if let Some(refreshed) = refresh_helcim_attempt_from_provider(state, &attempt).await? {
            attempt = refreshed;
        }
    }

    let (transaction, safe_message) = match attempt.provider_transaction_id.as_deref() {
        Some(transaction_id) if transaction_id.starts_with("helcim-sim-") => (
            Some(helcim::simulated_card_transaction(
                transaction_id,
                attempt.amount_cents,
                attempt.currency.clone(),
                attempt.status.clone(),
            )),
            Some("Helcim simulator response.".to_string()),
        ),
        Some(transaction_id)
            if matches!(attempt.status.as_str(), "approved" | "captured" | "failed") =>
        {
            let config = helcim::HelcimConfig::from_env();
            match helcim::fetch_card_transaction(&state.http_client, &config, transaction_id).await
            {
                Ok(transaction) => (Some(transaction), None),
                Err(error) => {
                    tracing::warn!(
                        target = "helcim",
                        attempt_id = %attempt.id,
                        transaction_id = %transaction_id,
                        error = %error,
                        "could not enrich Helcim attempt status"
                    );
                    (
                        None,
                        Some("Helcim payment status is recorded; card details are not available yet.".to_string()),
                    )
                }
            }
        }
        _ => (None, None),
    };

    Ok(HelcimAttemptResponse::from_row(
        attempt,
        transaction,
        safe_message,
    ))
}

async fn refresh_helcim_attempt_from_provider(
    state: &AppState,
    attempt: &HelcimAttemptRow,
) -> Result<Option<HelcimAttemptRow>, PaymentError> {
    let config = helcim::HelcimConfig::from_env();
    if config.simulator_enabled() || !config.api_enabled() {
        return Ok(None);
    }

    let Some(transaction_id) = attempt
        .provider_transaction_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.starts_with("helcim-sim-"))
    else {
        return recover_helcim_attempt_by_invoice(state, attempt, &config).await;
    };

    let transaction =
        match helcim::fetch_card_transaction(&state.http_client, &config, transaction_id).await {
            Ok(transaction) => transaction,
            Err(error) => {
                tracing::warn!(
                    target = "helcim",
                    attempt_id = %attempt.id,
                    transaction_id = %transaction_id,
                    error = %error,
                    "could not refresh pending Helcim attempt from provider"
                );
                return Ok(None);
            }
        };

    let provider_status = transaction
        .provider_status()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let Some(status) = final_helcim_attempt_status(&provider_status) else {
        return Ok(None);
    };
    let provider_transaction_id = transaction
        .transaction_id_string()
        .unwrap_or_else(|| transaction_id.to_string());
    let raw_audit_reference = transaction.audit_reference();
    let warning = transaction
        .warning
        .as_deref()
        .map(helcim::redact_provider_text);

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    lock_register_session_open_for_payment(&mut tx, attempt.register_session_id).await?;
    let result = sqlx::query(
        r#"
        UPDATE payment_provider_attempts
        SET status = $2,
            provider_transaction_id = $3,
            error_code = CASE
                WHEN $2 = 'failed' THEN 'declined'
                WHEN $2 = 'canceled' THEN 'canceled'
                ELSE NULL
            END,
            error_message = CASE
                WHEN $2 = 'failed' THEN COALESCE($5, 'Helcim payment was declined.')
                WHEN $2 = 'canceled' THEN COALESCE($5, 'Canceled on Helcim terminal.')
                ELSE NULL
            END,
            raw_audit_reference = COALESCE($4, raw_audit_reference),
            completed_at = now()
        WHERE id = $1
          AND provider = 'helcim'
          AND (
              status = 'pending'
              OR ($6::boolean AND status = 'failed' AND $2 IN ('approved', 'captured'))
          )
        "#,
    )
    .bind(attempt.id)
    .bind(status)
    .bind(provider_transaction_id)
    .bind(raw_audit_reference)
    .bind(warning)
    .bind(attempt.status == "failed")
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    if result.rows_affected() == 0 {
        let _ = tx.rollback().await;
        return Ok(None);
    }
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    load_helcim_attempt_row(state, attempt.id).await.map(Some)
}

async fn recover_helcim_attempt_by_invoice(
    state: &AppState,
    attempt: &HelcimAttemptRow,
    config: &helcim::HelcimConfig,
) -> Result<Option<HelcimAttemptRow>, PaymentError> {
    let invoice_number = format!("ROS-{}", attempt.id.simple());
    let date_from = (attempt.created_at - ChronoDuration::days(1)).date_naive();
    let date_to = (Utc::now() + ChronoDuration::days(1)).date_naive();
    let rows = match helcim::list_card_transactions(
        &state.http_client,
        config,
        &helcim::HelcimCardTransactionsQuery {
            date_from: Some(date_from),
            date_to: Some(date_to),
            card_batch_id: None,
            limit: Some(100),
            page: None,
        },
    )
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(
                target = "helcim",
                attempt_id = %attempt.id,
                invoice_number = %invoice_number,
                error = %error,
                "could not recover Helcim attempt by invoice number"
            );
            return Ok(None);
        }
    };

    let matches: Vec<_> = rows
        .into_iter()
        .filter(|row| {
            let row_invoice = helcim::invoice_number_from_payload(&row.raw_payload);
            if row_invoice.as_deref() != Some(invoice_number.as_str()) {
                return false;
            }
            let row_amount_cents = row.gross_amount.and_then(decimal_to_cents);
            row_amount_cents == Some(attempt.amount_cents)
        })
        .collect();

    let approved_matches: Vec<_> = matches
        .iter()
        .filter(|row| {
            matches!(
                final_helcim_attempt_status(
                    &row.status
                        .clone()
                        .unwrap_or_default()
                        .trim()
                        .to_ascii_lowercase()
                ),
                Some("approved" | "captured")
            )
        })
        .collect();

    let matched = if attempt.status == "failed" {
        if approved_matches.len() != 1 {
            return Ok(None);
        }
        Some((*approved_matches[0]).clone())
    } else {
        matches.into_iter().find(|row| {
            let provider_status = row
                .status
                .clone()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            final_helcim_attempt_status(&provider_status).is_some()
        })
    };

    let Some(row) = matched else {
        return Ok(None);
    };
    let provider_status = row.status.unwrap_or_default().trim().to_ascii_lowercase();
    let Some(status) = final_helcim_attempt_status(&provider_status) else {
        return Ok(None);
    };
    let provider_transaction_id = row.provider_transaction_id.trim().to_string();
    if provider_transaction_id.is_empty() {
        return Ok(None);
    }
    let raw_audit_reference = Some(format!("helcim:cardTransaction:{provider_transaction_id}"));

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    lock_register_session_open_for_payment(&mut tx, attempt.register_session_id).await?;
    let result = sqlx::query(
        r#"
        UPDATE payment_provider_attempts
        SET status = $2,
            provider_transaction_id = $3,
            error_code = CASE
                WHEN $2 = 'failed' THEN 'declined'
                WHEN $2 = 'canceled' THEN 'canceled'
                ELSE NULL
            END,
            error_message = CASE
                WHEN $2 = 'failed' THEN 'Helcim payment was declined.'
                WHEN $2 = 'canceled' THEN 'Canceled on Helcim terminal.'
                ELSE NULL
            END,
            raw_audit_reference = COALESCE($4, raw_audit_reference),
            completed_at = now()
        WHERE id = $1
          AND provider = 'helcim'
          AND (
              status = 'pending'
              OR ($5::boolean AND status = 'failed' AND $2 IN ('approved', 'captured'))
          )
          AND (
              provider_transaction_id IS NULL
              OR ($5::boolean AND status = 'failed')
          )
        "#,
    )
    .bind(attempt.id)
    .bind(status)
    .bind(provider_transaction_id)
    .bind(raw_audit_reference)
    .bind(attempt.status == "failed")
    .execute(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    if result.rows_affected() == 0 {
        let _ = tx.rollback().await;
        return Ok(None);
    }
    tx.commit()
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    load_helcim_attempt_row(state, attempt.id).await.map(Some)
}

fn decimal_to_cents(amount: Decimal) -> Option<i64> {
    (amount.round_dp(2) * Decimal::from(100))
        .round_dp(0)
        .to_string()
        .parse::<i64>()
        .ok()
}

fn final_helcim_attempt_status(provider_status: &str) -> Option<&'static str> {
    match provider_status {
        "approved" | "approval" | "captured" | "capture" => Some("approved"),
        "declined" | "decline" | "failed" | "error" => Some("failed"),
        "cancelled" | "canceled" => Some("canceled"),
        _ => None,
    }
}

async fn load_helcim_attempt_row(
    state: &AppState,
    attempt_id: Uuid,
) -> Result<HelcimAttemptRow, PaymentError> {
    sqlx::query_as::<_, HelcimAttemptRow>(
        r#"
        SELECT id, provider, status, amount_cents, currency, register_session_id, staff_id,
               device_id, terminal_id, selected_terminal_key, terminal_route_source,
               terminal_override_staff_id, terminal_override_reason, idempotency_key, provider_payment_id,
               provider_transaction_id, error_code, error_message, raw_audit_reference,
               created_at, updated_at, completed_at
        FROM payment_provider_attempts
        WHERE id = $1 AND provider = 'helcim'
        "#,
    )
    .bind(attempt_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?
    .ok_or_else(|| PaymentError::InvalidPayload("Helcim attempt not found.".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_helcim_attempt_row(status: &str) -> HelcimAttemptRow {
        let now = Utc::now();
        HelcimAttemptRow {
            id: Uuid::new_v4(),
            provider: "helcim".to_string(),
            status: status.to_string(),
            amount_cents: 1_234,
            currency: "usd".to_string(),
            register_session_id: Some(Uuid::new_v4()),
            staff_id: None,
            device_id: None,
            terminal_id: None,
            selected_terminal_key: None,
            terminal_route_source: None,
            terminal_override_staff_id: None,
            terminal_override_reason: None,
            idempotency_key: "refund-replay-key".to_string(),
            provider_payment_id: None,
            provider_transaction_id: Some("123456789".to_string()),
            error_code: None,
            error_message: None,
            raw_audit_reference: Some("helcim:cardRefund:123456789".to_string()),
            created_at: now,
            updated_at: now,
            completed_at: None,
        }
    }

    #[test]
    fn pending_idempotency_replay_returns_attempt_without_provider_refresh() {
        let attempt = sample_helcim_attempt_row("pending");
        assert!(should_skip_provider_refresh_for_idempotency_replay(
            &attempt
        ));
        let response = HelcimAttemptResponse::from_row(attempt, None, None);

        assert_eq!(response.status, "pending");
        assert_eq!(
            response.provider_transaction_id.as_deref(),
            Some("123456789")
        );
        assert!(response.safe_message.is_none());
    }

    #[test]
    fn final_idempotency_replay_can_use_standard_attempt_loader() {
        let attempt = sample_helcim_attempt_row("approved");

        assert!(!should_skip_provider_refresh_for_idempotency_replay(
            &attempt
        ));
    }

    #[test]
    fn terminal_refund_request_confirmation_defaults_to_false() {
        let payload: HelcimTerminalRefundRequestBody = serde_json::from_value(serde_json::json!({
            "amount_cents": 100,
            "original_transaction_id": 123
        }))
        .expect("payload");
        assert!(!payload.customer_present_confirmed);

        let confirmed: HelcimTerminalRefundRequestBody =
            serde_json::from_value(serde_json::json!({
                "amount_cents": 100,
                "original_transaction_id": 123,
                "customer_present_confirmed": true
            }))
            .expect("payload");
        assert!(confirmed.customer_present_confirmed);
    }

    #[test]
    fn helcim_purchase_409_maps_to_staff_actionable_conflict() {
        let error = helcim_terminal_purchase_error(
            reqwest::StatusCode::CONFLICT,
            r#"{"message":"Device is busy","cardNumber":"4111111111111111"}"#,
            false,
        );

        let PaymentError::Conflict(message) = error else {
            panic!("expected conflict");
        };
        assert!(message.contains("Helcim reported a terminal conflict"));
        assert!(message.contains("Check status"));
        assert!(message.contains("[REDACTED]"));
        assert!(!message.contains("4111111111111111"));
    }

    #[test]
    fn helcim_purchase_409_not_listening_maps_to_terminal_setup_message() {
        let error = helcim_terminal_purchase_error(
            reqwest::StatusCode::CONFLICT,
            r#"{"errors":["device with code JFHP not listening"]}"#,
            false,
        );

        let PaymentError::Conflict(message) = error else {
            panic!("expected conflict");
        };
        assert!(message.contains("Helcim terminal JFHP is not listening"));
        assert!(message.contains("open or restart the Helcim app"));
        assert!(message.contains("update the Helcim terminal code in Settings"));
        assert!(!message.contains("active payment"));
    }

    #[test]
    fn helcim_purchase_non_409_keeps_provider_failure_classification() {
        let error = helcim_terminal_purchase_error(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"message":"Invalid amount"}"#,
            false,
        );

        let PaymentError::ProviderError(message) = error else {
            panic!("expected provider error");
        };
        assert!(message.contains("Helcim returned HTTP 400"));
        assert!(message.contains("Invalid amount"));
    }
}
