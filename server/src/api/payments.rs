//! Stripe Terminal handshake: create a `card_present` PaymentIntent for the physical reader.

use crate::auth::permissions::SETTINGS_ADMIN;
use crate::logic::{helcim, stripe_vault};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;
use stripe::{CancelPaymentIntent, CreatePaymentIntent, Currency, PaymentIntent, PaymentIntentId};
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::middleware;

#[derive(Debug, Error)]
pub enum PaymentError {
    #[error("Stripe API error: {0}")]
    StripeError(String),
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
    #[error("Too many payment intent requests; try again shortly")]
    RateLimited,
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
            PaymentError::RateLimited => (
                StatusCode::TOO_MANY_REQUESTS,
                "Too many payment intent requests; try again shortly".to_string(),
            ),
            PaymentError::ProviderError(e) => {
                tracing::error!(error = %e, "Provider error in payments");
                (
                    StatusCode::BAD_GATEWAY,
                    "Failed to communicate with payment provider".to_string(),
                )
            }
            PaymentError::StripeError(e) => {
                tracing::error!(error = %e, "Stripe error in payments");
                (
                    StatusCode::BAD_GATEWAY,
                    "Failed to communicate with payment processor".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateIntentRequest {
    pub amount_due: Decimal,
    /// If true, uses 'card' instead of 'card_present' for MOTO / phone orders.
    pub moto: Option<bool>,
    /// Link to a ROS customer for card vaulting / retrieval.
    pub customer_id: Option<Uuid>,
    /// Securely use a vaulted card for off-session / quick-pay.
    pub payment_method_id: Option<String>,
    /// Attempt an unlinked credit (negative intent).
    pub is_credit: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct CreateIntentResponse {
    pub intent_id: String,
    pub client_secret: String,
    pub amount_cents: i64,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/intent", post(create_payment_intent))
        .route("/intent/cancel", post(cancel_payment_intent))
        .route("/config", get(get_payments_config))
        .route(
            "/providers/active",
            get(get_active_card_provider).patch(patch_active_card_provider),
        )
        .route("/providers/helcim/status", get(get_helcim_provider_status))
        .route("/providers/helcim/purchase", post(start_helcim_purchase))
        .route("/providers/helcim/attempts/{id}", get(get_helcim_attempt))
        .route(
            "/providers/helcim/attempts/{id}/simulate",
            post(simulate_helcim_attempt),
        )
        .route("/customers/{id}/payment-methods", get(get_vaulted_methods))
        .route(
            "/customers/{id}/setup-intent",
            post(create_vault_setup_intent),
        )
        .route(
            "/customers/{id}/payment-methods/{pm_id}",
            delete(delete_vaulted_method),
        )
        .route(
            "/customers/{id}/payment-methods/record",
            post(record_vaulted_method),
        )
}

#[derive(Debug, Clone, Serialize)]
pub struct StripeProviderStatus {
    pub enabled: bool,
    pub secret_configured: bool,
    pub public_key_configured: bool,
    pub missing_config: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActiveCardProviderResponse {
    pub active_provider: String,
    pub stripe: StripeProviderStatus,
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

fn looks_placeholder(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.is_empty()
        || lower.contains("dummy")
        || lower.contains("placeholder")
        || lower.contains("replace_me")
}

fn stripe_provider_status() -> StripeProviderStatus {
    let secret = std::env::var("STRIPE_SECRET_KEY").unwrap_or_default();
    let public = std::env::var("STRIPE_PUBLIC_KEY").unwrap_or_default();
    let secret_configured = secret.trim().starts_with("sk_") && !looks_placeholder(&secret);
    let public_key_configured = public.trim().starts_with("pk_") && !looks_placeholder(&public);
    let mut missing_config = Vec::new();
    if !secret_configured {
        missing_config.push("STRIPE_SECRET_KEY is not configured".to_string());
    }
    if !public_key_configured {
        missing_config.push("STRIPE_PUBLIC_KEY is not configured".to_string());
    }

    StripeProviderStatus {
        enabled: secret_configured && public_key_configured,
        secret_configured,
        public_key_configured,
        missing_config,
    }
}

async fn load_active_card_provider(state: &AppState) -> Result<String, PaymentError> {
    let provider: Option<String> =
        sqlx::query_scalar("SELECT active_card_provider FROM store_settings WHERE id = 1")
            .fetch_optional(&state.db)
            .await
            .map_err(|e| PaymentError::InvalidPayload(e.to_string()))?;

    Ok(provider.unwrap_or_else(|| "stripe".to_string()))
}

async fn active_card_provider_response(
    state: &AppState,
) -> Result<ActiveCardProviderResponse, PaymentError> {
    Ok(ActiveCardProviderResponse {
        active_provider: load_active_card_provider(state).await?,
        stripe: stripe_provider_status(),
        helcim: helcim::HelcimConfig::from_env().status(),
    })
}

async fn get_payments_config(
    State(_state): State<AppState>,
    _headers: HeaderMap,
) -> Result<Json<serde_json::Value>, PaymentError> {
    let public_key = std::env::var("STRIPE_PUBLIC_KEY").unwrap_or_default();
    Ok(Json(json!({ "stripe_public_key": public_key })))
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
    if provider != "stripe" && provider != helcim::HELCIM_PROVIDER_KEY {
        return Err(PaymentError::InvalidPayload(
            "active_provider must be stripe or helcim".to_string(),
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
    if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_lowercase()) {
        return Err(PaymentError::InvalidPayload(
            "currency must be a 3-letter code".to_string(),
        ));
    }

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

async fn get_vaulted_methods(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<Vec<stripe_vault::VaultedPaymentMethod>>, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;

    let methods = stripe_vault::list_vaulted_methods(&state.db, &state.stripe_client, customer_id)
        .await
        .map_err(|e| PaymentError::StripeError(e.to_string()))?;

    Ok(Json(methods))
}

async fn create_vault_setup_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;

    let secret = stripe_vault::create_setup_intent(&state.db, &state.stripe_client, customer_id)
        .await
        .map_err(|e| PaymentError::StripeError(e.to_string()))?;

    Ok(Json(json!({ "client_secret": secret })))
}

async fn delete_vaulted_method(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((customer_id, pm_id)): Path<(Uuid, String)>,
) -> Result<StatusCode, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;

    stripe_vault::delete_vaulted_method(&state.db, &state.stripe_client, customer_id, &pm_id)
        .await
        .map_err(|e| PaymentError::StripeError(e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct RecordVaultedMethodRequest {
    pub stripe_payment_method_id: String,
    pub brand: String,
    pub last4: String,
    pub exp_month: i32,
    pub exp_year: i32,
}

async fn record_vaulted_method(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Json(payload): Json<RecordVaultedMethodRequest>,
) -> Result<Json<serde_json::Value>, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;

    let id = stripe_vault::record_vaulted_method(
        &state.db,
        customer_id,
        &payload.stripe_payment_method_id,
        &payload.brand,
        &payload.last4,
        payload.exp_month,
        payload.exp_year,
    )
    .await
    .map_err(|e| PaymentError::StripeError(e.to_string()))?;

    Ok(Json(json!({ "id": id })))
}

async fn create_payment_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateIntentRequest>,
) -> Result<Json<CreateIntentResponse>, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;

    if state.payment_intent_max_per_minute > 0 {
        let mut w = state.payment_intent_minute.lock().await;
        let now = std::time::Instant::now();
        if now.duration_since(w.window_start) >= Duration::from_secs(60) {
            w.window_start = now;
            w.count = 0;
        }
        if w.count >= state.payment_intent_max_per_minute {
            return Err(PaymentError::RateLimited);
        }
        w.count += 1;
    }

    if payload.amount_due <= Decimal::ZERO && !payload.is_credit.unwrap_or(false) {
        return Err(PaymentError::InvalidPayload(
            "Amount must be greater than zero for standard payments".to_string(),
        ));
    }

    let cents_decimal = payload.amount_due * Decimal::from(100);
    let amount_cents = cents_decimal.to_i64().ok_or_else(|| {
        PaymentError::InvalidPayload("Amount is too large or malformed".to_string())
    })?;

    let mut create_intent = CreatePaymentIntent::new(amount_cents, Currency::USD);

    if payload.moto.unwrap_or(false) {
        create_intent.payment_method_types = Some(vec!["card".to_string()]);
        // For MOTO, we often want to save the card for future use
        if payload.customer_id.is_some() {
            create_intent.setup_future_usage =
                Some(stripe::PaymentIntentSetupFutureUsage::OffSession);
        }
    } else if payload.payment_method_id.is_some() {
        // Saved card: don't restrict to card_present
        create_intent.payment_method_types = Some(vec!["card".to_string()]);
    } else {
        create_intent.payment_method_types = Some(vec!["card_present".to_string()]);
    }

    if let Some(pm_id) = payload.payment_method_id {
        create_intent.payment_method = Some(
            pm_id
                .parse()
                .map_err(|_| PaymentError::StripeError("invalid payment method id".into()))?,
        );
        // Off-session confirmation if using a saved card directly from POS
        create_intent.confirm = Some(true);
        create_intent.off_session = Some(stripe::PaymentIntentOffSession::Exists(true));
    }

    // Link Stripe customer if we have one for this ROS customer
    if let Some(cid) = payload.customer_id {
        let stripe_cust_id: Option<String> = sqlx::query_scalar::<_, Option<String>>(
            "SELECT stripe_customer_id FROM customers WHERE id = $1",
        )
        .bind(cid)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| PaymentError::StripeError(e.to_string()))?
        .flatten();

        if let Some(scid) = stripe_cust_id {
            create_intent.customer = Some(
                scid.parse()
                    .map_err(|_| PaymentError::StripeError("invalid stripe customer id".into()))?,
            );
        }
    }

    let intent = PaymentIntent::create(&state.stripe_client, create_intent)
        .await
        .map_err(|e| PaymentError::StripeError(e.to_string()))?;

    Ok(Json(CreateIntentResponse {
        intent_id: intent.id.to_string(),
        client_secret: intent.client_secret.unwrap_or_default(),
        amount_cents,
    }))
}

#[derive(Debug, Deserialize)]
pub struct CancelIntentRequest {
    pub intent_id: String,
}

/// Voids a **uncaptured** Terminal `PaymentIntent` when staff removes the card tender from the ledger
/// before completing the sale. Succeeded / canceled intents return an error from Stripe (surfaced as 400).
async fn cancel_payment_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CancelIntentRequest>,
) -> Result<Json<serde_json::Value>, PaymentError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_pay_session)?;

    let id = payload.intent_id.trim();
    if id.is_empty() || id == "offline_simulation" {
        return Ok(Json(json!({ "status": "skipped" })));
    }
    if !id.starts_with("pi_") {
        return Err(PaymentError::InvalidPayload(
            "intent_id must be a Stripe PaymentIntent id (pi_...)".to_string(),
        ));
    }

    let pi_id: PaymentIntentId = id
        .parse()
        .map_err(|_| PaymentError::StripeError("invalid intent id".into()))?;
    PaymentIntent::cancel(&state.stripe_client, &pi_id, CancelPaymentIntent::default())
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, intent_id = %id, "payment intent cancel");
            PaymentError::InvalidPayload(format!("Could not void authorization: {e}"))
        })?;

    Ok(Json(json!({ "status": "cancelled" })))
}
