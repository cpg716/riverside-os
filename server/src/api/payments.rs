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
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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
