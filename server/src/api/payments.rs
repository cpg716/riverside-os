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
    pub helcim_batch_api_available: bool,
    pub message: String,
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
            ) AS open_item_count
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

    Ok(Json(HelcimSettlementStatusResponse {
        batch_count: counts.batch_count,
        batch_transaction_count: counts.batch_transaction_count,
        matched_transaction_count: counts.matched_transaction_count,
        unmatched_transaction_count: counts.unmatched_transaction_count,
        open_item_count: counts.open_item_count,
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
                'source', 'local_payment_metadata',
                'helcim_batch_api_available', false
            )
        )
        RETURNING id
        "#,
    )
    .bind(payload.date_from)
    .bind(payload.date_to)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    let result =
        sync_helcim_settlement_rows(&mut tx, run_id, payload.date_from, payload.date_to).await;

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
                "source": "local_payment_metadata",
                "helcim_batch_api_available": false,
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
                helcim_batch_api_available: false,
                message: "Helcim batch API paths are not present in the repo; sync promoted known local Helcim batch metadata and created reconciliation findings only."
                    .to_string(),
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
}

async fn sync_helcim_settlement_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    run_id: Uuid,
    date_from: Option<NaiveDate>,
    date_to: Option<NaiveDate>,
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
