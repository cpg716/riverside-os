//! Helcim payment provider endpoints.

use crate::auth::permissions::{CUSTOMERS_HUB_EDIT, CUSTOMERS_HUB_VIEW, SETTINGS_ADMIN};
use crate::logic::helcim;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::middleware;

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

impl IntoResponse for PaymentError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            PaymentError::InvalidPayload(m) => (StatusCode::BAD_REQUEST, m),
            PaymentError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m),
            PaymentError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            PaymentError::Conflict(m) => (StatusCode::CONFLICT, m),
            PaymentError::ProviderError(e) => {
                tracing::error!(error = %e, "Provider error in payments");
                (
                    StatusCode::BAD_GATEWAY,
                    "Failed to communicate with payment provider".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
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
            "/providers/helcim/attempts/{id}/simulate",
            post(simulate_helcim_attempt),
        )
}

#[derive(Debug, Clone, Serialize)]
pub struct ActiveCardProviderResponse {
    pub active_provider: String,
    pub helcim: helcim::HelcimConfigStatus,
}

#[derive(Debug, Deserialize)]
pub struct PatchActiveCardProviderRequest {
    pub active_provider: String,
}

#[derive(Debug, Deserialize)]
pub struct HelcimPurchaseRequestBody {
    pub amount_cents: i64,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct HelcimTerminalRefundRequestBody {
    pub amount_cents: i64,
    pub original_transaction_id: i64,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub register_session_id: Option<Uuid>,
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
}

#[derive(Debug, Deserialize)]
pub struct HelcimCardReverseRequestBody {
    pub original_transaction_id: i64,
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
    pub last_event_at: Option<DateTime<Utc>>,
    pub last_failed_message: Option<String>,
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
    pub idempotency_key: String,
    pub provider_payment_id: Option<String>,
    pub provider_transaction_id: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub raw_audit_reference: Option<String>,
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
    Ok(ActiveCardProviderResponse {
        active_provider: load_active_card_provider(state).await?,
        helcim: helcim::HelcimConfig::from_env().status(),
    })
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

    Ok(Json(helcim::HelcimConfig::from_env().status()))
}

async fn get_helcim_fee_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HelcimFeeStatusResponse>, PaymentError> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;

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
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;

    let config = helcim::HelcimConfig::from_env();
    if !config.enabled() {
        return Err(PaymentError::InvalidPayload(
            "Helcim is not fully configured.".to_string(),
        ));
    }
    if config.simulator_enabled() {
        return Ok(Json(HelcimFeeSyncResponse {
            scanned: 0,
            updated: 0,
            fees_unavailable: 0,
            skipped_missing_transaction_id: 0,
            errors: 0,
            total_fee_synced: "0.00".to_string(),
            total_net_synced: "0.00".to_string(),
        }));
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
          AND (
              COALESCE(metadata->>'helcim_fee_sync_status', '') <> 'applied'
              OR COALESCE(metadata->>'helcim_net_sync_status', '') <> 'applied'
          )
          AND COALESCE(provider_status, status, '') NOT IN ('failed', 'canceled', 'cancelled', 'declined')
        ORDER BY created_at ASC
        LIMIT 100
        "#,
    )
    .fetch_all(&state.db)
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

        let transaction = match helcim::fetch_card_transaction(
            &state.http_client,
            &config,
            &transaction_id,
        )
        .await
        {
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
            .execute(&state.db)
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
        .execute(&state.db)
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

    Ok(Json(HelcimFeeSyncResponse {
        scanned,
        updated,
        fees_unavailable,
        skipped_missing_transaction_id,
        errors,
        total_fee_synced: total_fee_synced.round_dp(2).to_string(),
        total_net_synced: total_net_synced.round_dp(2).to_string(),
    }))
}

async fn get_helcim_settlement_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HelcimSettlementStatusResponse>, PaymentError> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;

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
    let api_integration_active = config.enabled() && !config.simulator_enabled();
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
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;
    let payload = payload
        .map(|Json(payload)| payload)
        .unwrap_or(HelcimSettlementSyncRequest {
            date_from: None,
            date_to: None,
        });
    let config = helcim::HelcimConfig::from_env();
    let api_integration_active = config.enabled() && !config.simulator_enabled();
    let processor_data = if api_integration_active {
        Some(
            fetch_helcim_processor_settlement_data(
                &state.http_client,
                &config,
                payload.date_from,
                payload.date_to,
            )
            .await
            .map_err(PaymentError::ProviderError)?,
        )
    } else {
        None
    };

    let mut tx = state
        .db
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
    .bind(payload.date_from)
    .bind(payload.date_to)
    .bind(if api_integration_active {
        "helcim_api"
    } else {
        "local_payment_metadata"
    })
    .bind(api_integration_active)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let result = sync_helcim_settlement_rows(
        &mut tx,
        run_id,
        payload.date_from,
        payload.date_to,
        processor_data.as_ref(),
    )
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
            Ok(Json(HelcimSettlementSyncResponse {
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
            }))
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
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;

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
        helcim_api_active: config.enabled() && !config.simulator_enabled(),
    }))
}

async fn list_helcim_batches(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HelcimOperationsListQuery>,
) -> Result<Json<Vec<HelcimBatchListRow>>, PaymentError> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;
    let rows = load_helcim_batch_rows(&state, None, &query).await?;
    Ok(Json(rows))
}

async fn get_helcim_batch_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<HelcimBatchDetailResponse>, PaymentError> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;
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
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;
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
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;
    let rows = load_helcim_reconciliation_items(&state, &query, None).await?;
    Ok(Json(rows))
}

async fn list_helcim_operations_transactions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HelcimOperationsListQuery>,
) -> Result<Json<Vec<HelcimOperationsTransactionRow>>, PaymentError> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;
    let rows = load_helcim_transaction_rows(&state, &query, None).await?;
    Ok(Json(rows))
}

async fn get_helcim_operations_transaction_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<HelcimOperationsTransactionDetailResponse>, PaymentError> {
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;
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
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;
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
    middleware::require_staff_with_permission(&state, &headers, SETTINGS_ADMIN)
        .await
        .map_err(map_pay_session)?;
    #[derive(sqlx::FromRow)]
    struct HealthRow {
        recent_event_count: i64,
        failed_event_count: i64,
        ignored_event_count: i64,
        last_event_at: Option<DateTime<Utc>>,
        last_failed_message: Option<String>,
    }
    let row: HealthRow = sqlx::query_as(
        r#"
        SELECT
            COUNT(*) FILTER (WHERE received_at >= now() - interval '24 hours')::bigint AS recent_event_count,
            COUNT(*) FILTER (WHERE processing_status = 'failed')::bigint AS failed_event_count,
            COUNT(*) FILTER (WHERE processing_status = 'ignored')::bigint AS ignored_event_count,
            MAX(received_at) AS last_event_at,
            (
                SELECT error_message
                FROM helcim_event_log
                WHERE processing_status = 'failed'
                  AND error_message IS NOT NULL
                ORDER BY received_at DESC
                LIMIT 1
            ) AS last_failed_message
        FROM helcim_event_log
        WHERE provider = 'helcim'
        "#,
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
    Ok(Json(HelcimEventsHealthResponse {
        recent_event_count: row.recent_event_count,
        failed_event_count: row.failed_event_count,
        ignored_event_count: row.ignored_event_count,
        last_event_at: row.last_event_at,
        last_failed_message: row.last_failed_message,
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
        .bind(&batch.raw_payload)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
        batch_ids.insert(batch.provider_batch_id.clone(), batch_uuid);
        stats.batches_upserted += 1;
    }

    for transaction in &processor_data.transactions {
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
        .bind(&transaction.raw_payload)
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
        ORDER BY COALESCE(batch.expected_deposit_at, batch.settled_at, batch.closed_at, batch.last_synced_at) DESC
        LIMIT $6
        "#,
    )
    .bind(batch_uuid)
    .bind(provider_batch_id.as_deref())
    .bind(clean_filter(query.status.as_deref()))
    .bind(query.date_from)
    .bind(query.date_to)
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
            created_at
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

    let config = helcim::HelcimConfig::from_env();
    let terminal_id = config.device_code().ok_or_else(|| {
        PaymentError::InvalidPayload("Helcim device code is not configured.".to_string())
    })?;
    let currency = payload
        .currency
        .as_deref()
        .unwrap_or("usd")
        .trim()
        .to_ascii_lowercase();
    validate_currency(&currency)?;

    let attempt_id = Uuid::new_v4();
    let idempotency_key = format!("helcim-{attempt_id}");
    let (register_session_id, staff_id) = match auth {
        middleware::StaffOrPosSession::Staff(staff) => {
            (payload.register_session_id, Some(staff.id))
        }
        middleware::StaffOrPosSession::PosSession { session_id } => (Some(session_id), None),
    };

    let insert_result = sqlx::query(
        r#"
        INSERT INTO payment_provider_attempts (
            id, provider, status, amount_cents, currency, register_session_id, staff_id,
            device_id, terminal_id, idempotency_key
        )
        VALUES ($1, 'helcim', 'pending', $2, $3, $4, $5, $6, $6, $7)
        "#,
    )
    .bind(attempt_id)
    .bind(payload.amount_cents)
    .bind(&currency)
    .bind(register_session_id)
    .bind(staff_id)
    .bind(terminal_id)
    .bind(&idempotency_key)
    .execute(&state.db)
    .await;

    if let Err(e) = insert_result {
        if e.as_database_error().and_then(|db| db.constraint())
            == Some("uq_payment_provider_attempts_active_device")
        {
            return Err(PaymentError::Conflict(
                "A Helcim terminal payment is already pending for this device.".to_string(),
            ));
        }
        return Err(PaymentError::InvalidPayload(e.to_string()));
    }

    if config.simulator_enabled() {
        return load_helcim_attempt(&state, attempt_id, None)
            .await
            .map(Json);
    }

    let token = config.api_token().ok_or_else(|| {
        PaymentError::InvalidPayload("Helcim is selected but not configured.".to_string())
    })?;
    let request_payload =
        helcim::build_purchase_request_payload(payload.amount_cents, currency.clone());
    let url = format!(
        "{}/devices/{}/payment/purchase",
        config.api_base_url(),
        terminal_id
    );
    let response_result = state
        .http_client
        .post(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("api-token", token)
        .header("idempotency-key", &idempotency_key)
        .json(&request_payload)
        .send()
        .await;
    let response = match response_result {
        Ok(response) => response,
        Err(e) => {
            let message = e.to_string();
            sqlx::query(
                r#"
                UPDATE payment_provider_attempts
                SET status = 'failed', error_code = 'request_failed', error_message = $2, completed_at = now()
                WHERE id = $1
                "#,
            )
            .bind(attempt_id)
            .bind(message.chars().take(500).collect::<String>())
            .execute(&state.db)
            .await
            .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
            return Err(PaymentError::ProviderError(message));
        }
    };

    if response.status() != reqwest::StatusCode::ACCEPTED {
        let status = response.status().as_u16().to_string();
        let message = response
            .text()
            .await
            .unwrap_or_else(|_| "Helcim purchase request failed".to_string());
        sqlx::query(
            r#"
            UPDATE payment_provider_attempts
            SET status = 'failed', error_code = $2, error_message = $3, completed_at = now()
            WHERE id = $1
            "#,
        )
        .bind(attempt_id)
        .bind(&status)
        .bind(message.chars().take(500).collect::<String>())
        .execute(&state.db)
        .await
        .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
        return Err(PaymentError::ProviderError(format!(
            "Helcim returned HTTP {status}"
        )));
    }

    let accepted = response
        .json::<helcim::HelcimAcceptedPurchaseResponse>()
        .await
        .unwrap_or(helcim::HelcimAcceptedPurchaseResponse {
            status: Some("accepted".to_string()),
            payment_id: None,
            transaction_id: None,
            audit_reference: None,
        });
    let pending = helcim::normalize_accepted_purchase(
        &config,
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

    let config = helcim::HelcimConfig::from_env();
    let terminal_id = config.device_code().ok_or_else(|| {
        PaymentError::InvalidPayload("Helcim device code is not configured.".to_string())
    })?;
    let currency = payload
        .currency
        .as_deref()
        .unwrap_or("usd")
        .trim()
        .to_ascii_lowercase();
    validate_currency(&currency)?;

    let attempt_id = Uuid::new_v4();
    let idempotency_key = format!("helcim-refund-{attempt_id}");
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
            device_id, terminal_id, idempotency_key, provider_transaction_id, raw_audit_reference
        )
        VALUES ($1, 'helcim', 'pending', $2, $3, $4, $5, $6, $6, $7, $8, $9)
        "#,
    )
    .bind(attempt_id)
    .bind(payload.amount_cents)
    .bind(&currency)
    .bind(register_session_id)
    .bind(staff_id)
    .bind(terminal_id)
    .bind(&idempotency_key)
    .bind(payload.original_transaction_id.to_string())
    .bind(format!(
        "helcim:terminalRefund:{}",
        payload.original_transaction_id
    ))
    .execute(&state.db)
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
        request_payload,
        &idempotency_key,
    )
    .await
    {
        Ok(accepted) => {
            let provider_payment_id = accepted.payment_id;
            let provider_transaction_id = accepted
                .transaction_id
                .or_else(|| Some(payload.original_transaction_id.to_string()));
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
            sqlx::query(
                r#"
                UPDATE payment_provider_attempts
                SET status = 'failed', error_code = 'request_failed', error_message = $2, completed_at = now()
                WHERE id = $1
                "#,
            )
            .bind(attempt_id)
            .bind(error.chars().take(500).collect::<String>())
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
            .bind(error.chars().take(500).collect::<String>())
            .execute(&state.db)
            .await
            .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;
            return Err(PaymentError::ProviderError(error));
        }
    };

    let status = transaction.normalized_status();
    let provider_transaction_id = transaction.transaction_id_string();
    let raw_audit_reference = transaction.audit_reference();
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
    .bind(transaction.warning.clone())
    .execute(&state.db)
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
) -> Result<Json<helcim::HelcimCardTransaction>, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;
    if payload.amount_cents <= 0 || payload.original_transaction_id <= 0 {
        return Err(PaymentError::InvalidPayload(
            "amount_cents and original_transaction_id are required".to_string(),
        ));
    }
    let config = helcim::HelcimConfig::from_env();
    let idempotency_key = Uuid::new_v4().to_string();
    let request = helcim::HelcimCardRefundRequest {
        original_transaction_id: payload.original_transaction_id,
        amount: cents_to_decimal_string(payload.amount_cents),
        ip_address: request_ip_address(&headers),
        ecommerce: false,
    };
    let transaction =
        helcim::process_card_refund(&state.http_client, &config, request, &idempotency_key)
            .await
            .map_err(PaymentError::ProviderError)?;
    Ok(Json(transaction))
}

async fn process_helcim_card_reverse(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<HelcimCardReverseRequestBody>,
) -> Result<Json<helcim::HelcimCardTransaction>, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;
    if payload.original_transaction_id <= 0 {
        return Err(PaymentError::InvalidPayload(
            "original_transaction_id is required".to_string(),
        ));
    }
    let config = helcim::HelcimConfig::from_env();
    let idempotency_key = Uuid::new_v4().to_string();
    let request = helcim::HelcimCardReverseRequest {
        card_transaction_id: payload.original_transaction_id,
        ip_address: request_ip_address(&headers),
        ecommerce: false,
    };
    let transaction =
        helcim::process_card_reverse(&state.http_client, &config, request, &idempotency_key)
            .await
            .map_err(PaymentError::ProviderError)?;
    Ok(Json(transaction))
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
    .execute(&state.db)
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
    let warning = value_string(&payload.data, "warning");

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
    .execute(&state.db)
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
    .execute(&state.db)
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

async fn load_helcim_attempt(
    state: &AppState,
    attempt_id: Uuid,
    pos_session_id: Option<Uuid>,
) -> Result<HelcimAttemptResponse, PaymentError> {
    let attempt = load_helcim_attempt_row(state, attempt_id).await?;

    if let Some(session_id) = pos_session_id {
        if attempt.register_session_id != Some(session_id) {
            return Err(PaymentError::Forbidden(
                "Helcim attempt does not belong to this register session.".to_string(),
            ));
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

async fn load_helcim_attempt_row(
    state: &AppState,
    attempt_id: Uuid,
) -> Result<HelcimAttemptRow, PaymentError> {
    sqlx::query_as::<_, HelcimAttemptRow>(
        r#"
        SELECT id, provider, status, amount_cents, currency, register_session_id, staff_id,
               device_id, terminal_id, idempotency_key, provider_payment_id,
               provider_transaction_id, error_code, error_message, raw_audit_reference
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
