//! POS helpers (register session): internal line metadata for client without hard-coded UUIDs.

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{
    effective_permissions_for_staff, staff_has_permission, CUSTOMERS_RMS_CHARGE_MANAGE_LINKS,
    ORDERS_REFUND_PROCESS, POS_RMS_CHARGE_HISTORY_BASIC, POS_RMS_CHARGE_LOOKUP, POS_RMS_CHARGE_USE,
};
use crate::logic::corecard;
use crate::logic::pos_rms_charge;
use crate::logic::shippo::{self, ShippoError};
use crate::middleware;

#[derive(Debug, Error)]
pub enum PosMetaError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    BadRequest(String),
}

impl IntoResponse for PosMetaError {
    fn into_response(self) -> Response {
        match self {
            PosMetaError::Unauthorized(m) => {
                (axum::http::StatusCode::UNAUTHORIZED, m).into_response()
            }
            PosMetaError::NotFound(m) => (axum::http::StatusCode::NOT_FOUND, m).into_response(),
            PosMetaError::Forbidden(m) => (
                axum::http::StatusCode::FORBIDDEN,
                Json(json!({ "error": m })),
            )
                .into_response(),
            PosMetaError::BadRequest(m) => (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({ "error": m })),
            )
                .into_response(),
            PosMetaError::Database(e) => {
                tracing::error!(error = %e, "pos meta database error");
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "database error".to_string(),
                )
                    .into_response()
            }
        }
    }
}

#[derive(Debug)]
enum PosShippingError {
    Shippo(ShippoError),
    Unauthorized(String),
}

impl IntoResponse for PosShippingError {
    fn into_response(self) -> Response {
        match self {
            PosShippingError::Unauthorized(m) => {
                (axum::http::StatusCode::UNAUTHORIZED, m).into_response()
            }
            PosShippingError::Shippo(ShippoError::InvalidAddress(m)) => (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            )
                .into_response(),
            PosShippingError::Shippo(ShippoError::Parse(m)) => (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            )
                .into_response(),
            PosShippingError::Shippo(ShippoError::Api(m)) => {
                tracing::warn!(error = %m, "pos shipping rates error");
                (
                    axum::http::StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({ "error": "shipping provider unavailable" })),
                )
                    .into_response()
            }
            PosShippingError::Shippo(ShippoError::Database(e)) => {
                tracing::error!(error = %e, "pos shipping rates DB error");
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "internal error" })),
                )
                    .into_response()
            }
        }
    }
}

impl From<ShippoError> for PosShippingError {
    fn from(e: ShippoError) -> Self {
        PosShippingError::Shippo(e)
    }
}

async fn require_pos_rms_permission(
    state: &AppState,
    headers: &HeaderMap,
    permissions: &[&str],
) -> Result<crate::auth::pins::AuthenticatedStaff, PosMetaError> {
    let staff = middleware::require_authenticated_staff_headers(state, headers)
        .await
        .map_err(|(_, axum::Json(v))| {
            PosMetaError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("unauthorized")
                    .to_string(),
            )
        })?;
    let effective = effective_permissions_for_staff(&state.db, staff.id, staff.role)
        .await
        .map_err(PosMetaError::Database)?;
    if permissions
        .iter()
        .any(|permission| staff_has_permission(&effective, permission))
    {
        Ok(staff)
    } else {
        Err(PosMetaError::Forbidden("missing permission".to_string()))
    }
}

async fn require_staff_rms_sensitive_permission(
    state: &AppState,
    headers: &HeaderMap,
    permissions: &[&str],
) -> Result<crate::auth::pins::AuthenticatedStaff, PosMetaError> {
    let staff = middleware::require_authenticated_staff_headers(state, headers)
        .await
        .map_err(|(_, axum::Json(v))| {
            PosMetaError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("unauthorized")
                    .to_string(),
            )
        })?;
    let effective = effective_permissions_for_staff(&state.db, staff.id, staff.role)
        .await
        .map_err(PosMetaError::Database)?;
    if permissions
        .iter()
        .any(|permission| staff_has_permission(&effective, permission))
    {
        Ok(staff)
    } else {
        Err(PosMetaError::Forbidden("missing permission".to_string()))
    }
}

#[derive(Debug, Deserialize)]
pub struct PosShippingRatesBody {
    pub to_address: shippo::ShippingAddressInput,
    #[serde(default)]
    pub parcel: Option<shippo::ParcelInput>,
    /// When false (default), live Shippo may run if configured in Settings + env.
    #[serde(default)]
    pub force_stub: bool,
}

async fn post_pos_shipping_rates(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PosShippingRatesBody>,
) -> Result<Json<shippo::StoreShippingRatesResult>, PosShippingError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(|(_, axum::Json(v))| {
            PosShippingError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("unauthorized")
                    .to_string(),
            )
        })?;

    let res = shippo::pos_shipping_rates(
        &state.db,
        &state.http_client,
        &body.to_address,
        body.parcel.as_ref(),
        body.force_stub,
    )
    .await?;
    Ok(Json(res))
}

#[derive(Debug, Serialize)]
pub struct RmsPaymentLineMeta {
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub sku: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct GiftCardLoadLineMeta {
    pub product_id: Uuid,
    pub variant_id: Uuid,
    pub sku: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
struct PosAccountProgramsQuery {
    customer_id: Uuid,
    account_id: String,
}

#[derive(Debug, Deserialize)]
struct PosAccountSummaryQuery {
    customer_id: Uuid,
    account_id: String,
}

#[derive(Debug, Deserialize)]
struct ReverseRmsChargeBody {
    #[serde(default)]
    record_id: Option<Uuid>,
    #[serde(default)]
    transaction_id: Option<Uuid>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    amount: Option<rust_decimal::Decimal>,
}

async fn rms_payment_line_meta(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Option<RmsPaymentLineMeta>>, PosMetaError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(|(_, axum::Json(v))| {
            PosMetaError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("unauthorized")
                    .to_string(),
            )
        })?;

    let row: Option<(Uuid, Uuid, String, String)> = sqlx::query_as(
        r#"
        SELECT p.id, v.id, v.sku, p.name
        FROM products p
        INNER JOIN product_variants v ON v.product_id = p.id
        WHERE p.pos_line_kind = 'rms_charge_payment'
        ORDER BY p.created_at ASC
        LIMIT 1
        "#,
    )
    .fetch_optional(&state.db)
    .await?;

    Ok(Json(row.map(|(product_id, variant_id, sku, name)| {
        RmsPaymentLineMeta {
            product_id,
            variant_id,
            sku,
            name,
        }
    })))
}

async fn gift_card_load_line_meta(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Option<GiftCardLoadLineMeta>>, PosMetaError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(|(_, axum::Json(v))| {
            PosMetaError::Unauthorized(
                v.get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("unauthorized")
                    .to_string(),
            )
        })?;

    let row: Option<(Uuid, Uuid, String, String)> = sqlx::query_as(
        r#"
        SELECT p.id, v.id, v.sku, p.name
        FROM products p
        INNER JOIN product_variants v ON v.product_id = p.id
        WHERE p.pos_line_kind = 'pos_gift_card_load'
        ORDER BY p.created_at ASC
        LIMIT 1
        "#,
    )
    .fetch_optional(&state.db)
    .await?;

    Ok(Json(row.map(|(product_id, variant_id, sku, name)| {
        GiftCardLoadLineMeta {
            product_id,
            variant_id,
            sku,
            name,
        }
    })))
}

async fn resolve_rms_charge_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<corecard::PosResolveAccountRequest>,
) -> Result<Json<corecard::PosResolveAccountResponse>, PosMetaError> {
    require_pos_rms_permission(
        &state,
        &headers,
        &[POS_RMS_CHARGE_USE, POS_RMS_CHARGE_LOOKUP],
    )
    .await?;
    let response = corecard::resolve_customer_account(&state.db, &body)
        .await
        .map_err(|error| PosMetaError::BadRequest(error.to_string()))?;
    Ok(Json(response))
}

async fn list_rms_charge_programs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PosAccountProgramsQuery>,
) -> Result<Json<Vec<corecard::CoreCardProgramOption>>, PosMetaError> {
    require_pos_rms_permission(
        &state,
        &headers,
        &[POS_RMS_CHARGE_USE, POS_RMS_CHARGE_LOOKUP],
    )
    .await?;
    let programs = corecard::programs_for_account(
        &state.db,
        &state.http_client,
        &state.corecard_config,
        &state.corecard_token_cache,
        q.customer_id,
        q.account_id.trim(),
    )
    .await
    .map_err(|error| match error {
        corecard::CoreCardError::AccountNotFound => {
            PosMetaError::NotFound("linked account not found".to_string())
        }
        _ => PosMetaError::BadRequest(error.to_string()),
    })?;
    Ok(Json(programs))
}

async fn get_rms_charge_account_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PosAccountSummaryQuery>,
) -> Result<Json<corecard::CoreCardAccountSummary>, PosMetaError> {
    require_pos_rms_permission(
        &state,
        &headers,
        &[POS_RMS_CHARGE_USE, POS_RMS_CHARGE_LOOKUP],
    )
    .await?;
    let mut summary = corecard::account_summary_for_customer(
        &state.db,
        &state.http_client,
        &state.corecard_config,
        &state.corecard_token_cache,
        q.customer_id,
        q.account_id.trim(),
    )
    .await
    .map_err(|error| match error {
        corecard::CoreCardError::AccountNotFound => {
            PosMetaError::NotFound("linked account not found".to_string())
        }
        _ => PosMetaError::BadRequest(error.to_string()),
    })?;

    let staff = require_pos_rms_permission(
        &state,
        &headers,
        &[POS_RMS_CHARGE_HISTORY_BASIC, POS_RMS_CHARGE_LOOKUP],
    )
    .await?;
    let effective = effective_permissions_for_staff(&state.db, staff.id, staff.role)
        .await
        .map_err(PosMetaError::Database)?;
    if staff_has_permission(&effective, POS_RMS_CHARGE_HISTORY_BASIC)
        || staff_has_permission(&effective, POS_RMS_CHARGE_LOOKUP)
    {
        summary.recent_history = corecard::recent_history_for_customer(
            &state.db,
            q.customer_id,
            Some(q.account_id.trim()),
            5,
        )
        .await
        .map_err(|error| PosMetaError::BadRequest(error.to_string()))?;
    }

    Ok(Json(summary))
}

async fn post_rms_charge_purchase(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<corecard::CoreCardPosPostPurchaseRequest>,
) -> Result<Json<corecard::CoreCardHostMutationResult>, PosMetaError> {
    require_pos_rms_permission(
        &state,
        &headers,
        &[POS_RMS_CHARGE_USE, POS_RMS_CHARGE_LOOKUP],
    )
    .await?;
    let idempotency_key = corecard::build_idempotency_key(
        corecard::CoreCardOperationType::Purchase,
        &body.checkout_client_id.to_string(),
        &body.linked_corecredit_account_id,
        body.amount,
        Some(&body.program_code),
    );
    let request = corecard::CoreCardMutationRequest {
        customer_id: Some(body.customer_id),
        linked_corecredit_customer_id: body.linked_corecredit_customer_id,
        linked_corecredit_account_id: body.linked_corecredit_account_id,
        linked_corecredit_card_id: body.linked_corecredit_card_id,
        program_code: Some(body.program_code),
        amount: body.amount,
        idempotency_key,
        transaction_id: None,
        payment_transaction_id: None,
        pos_rms_charge_record_id: None,
        reason: None,
        reference_hint: Some(format!("ROS-CHECKOUT-{}", body.checkout_client_id)),
        metadata: body.metadata,
    };
    let result = corecard::post_purchase(
        &state.db,
        &state.http_client,
        &state.corecard_config,
        &state.corecard_token_cache,
        &request,
    )
    .await
    .map_err(|error| PosMetaError::BadRequest(error.to_string()))?;
    Ok(Json(result))
}

async fn post_rms_charge_payment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<corecard::CoreCardPosPostPaymentRequest>,
) -> Result<Json<corecard::CoreCardHostMutationResult>, PosMetaError> {
    require_pos_rms_permission(
        &state,
        &headers,
        &[POS_RMS_CHARGE_USE, POS_RMS_CHARGE_LOOKUP],
    )
    .await?;
    let link = corecard::find_customer_account_link(
        &state.db,
        body.customer_id,
        &body.linked_corecredit_account_id,
    )
    .await
    .map_err(|error| PosMetaError::BadRequest(error.to_string()))?;
    let idempotency_key = corecard::build_idempotency_key(
        corecard::CoreCardOperationType::Payment,
        &body.checkout_client_id.to_string(),
        &body.linked_corecredit_account_id,
        body.amount,
        None,
    );
    let request = corecard::CoreCardMutationRequest {
        customer_id: Some(body.customer_id),
        linked_corecredit_customer_id: body
            .linked_corecredit_customer_id
            .unwrap_or(link.corecredit_customer_id),
        linked_corecredit_account_id: body.linked_corecredit_account_id,
        linked_corecredit_card_id: None,
        program_code: None,
        amount: body.amount,
        idempotency_key,
        transaction_id: None,
        payment_transaction_id: None,
        pos_rms_charge_record_id: None,
        reason: None,
        reference_hint: Some(format!("ROS-RMS-PAYMENT-{}", body.checkout_client_id)),
        metadata: body.metadata,
    };
    let result = corecard::post_payment(
        &state.db,
        &state.http_client,
        &state.corecard_config,
        &state.corecard_token_cache,
        &request,
    )
    .await
    .map_err(|error| PosMetaError::BadRequest(error.to_string()))?;
    Ok(Json(result))
}

async fn reverse_rms_record(
    state: &AppState,
    record: &corecard::RmsChargeRecordDetail,
    operation_type: corecard::CoreCardOperationType,
    reason: Option<String>,
    amount: rust_decimal::Decimal,
) -> Result<corecard::CoreCardHostMutationResult, PosMetaError> {
    let external_transaction_id = record.external_transaction_id.clone().ok_or_else(|| {
        PosMetaError::BadRequest(
            "This RMS record does not have a live host reference yet.".to_string(),
        )
    })?;
    let linked_customer = record
        .linked_corecredit_customer_id
        .clone()
        .ok_or_else(|| {
            PosMetaError::BadRequest("Missing linked CoreCredit customer id.".to_string())
        })?;
    let linked_account = record.linked_corecredit_account_id.clone().ok_or_else(|| {
        PosMetaError::BadRequest("Missing linked CoreCredit account id.".to_string())
    })?;
    let idempotency_key = corecard::build_idempotency_key(
        operation_type.clone(),
        &format!("{}:{external_transaction_id}", record.id),
        &linked_account,
        amount,
        record.program_code.as_deref(),
    );
    let request = corecard::CoreCardMutationRequest {
        customer_id: record.customer_id,
        linked_corecredit_customer_id: linked_customer,
        linked_corecredit_account_id: linked_account,
        linked_corecredit_card_id: None,
        program_code: record.program_code.clone(),
        amount,
        idempotency_key: idempotency_key.clone(),
        transaction_id: Some(record.transaction_id),
        payment_transaction_id: record.payment_transaction_id,
        pos_rms_charge_record_id: Some(record.id),
        reason,
        reference_hint: Some(external_transaction_id),
        metadata: json!({
            "original_external_transaction_id": record.external_transaction_id,
            "original_host_reference": record.host_reference,
            "record_kind": record.record_kind,
            "masked_account": record.masked_account,
        }),
    };
    let result = match operation_type {
        corecard::CoreCardOperationType::Refund => {
            corecard::post_refund(
                &state.db,
                &state.http_client,
                &state.corecard_config,
                &state.corecard_token_cache,
                &request,
            )
            .await
        }
        corecard::CoreCardOperationType::Reversal => {
            corecard::post_reversal(
                &state.db,
                &state.http_client,
                &state.corecard_config,
                &state.corecard_token_cache,
                &request,
            )
            .await
        }
        _ => Err(corecard::CoreCardError::InvalidRequest(
            "unsupported RMS follow-on operation".to_string(),
        )),
    }
    .map_err(|error| PosMetaError::BadRequest(error.to_string()))?;

    let mut metadata = record.metadata_json.clone();
    if !metadata.is_object() {
        metadata = json!({});
    }
    let obj = metadata.as_object_mut().expect("object just assigned");
    obj.insert(
        "idempotency_key".to_string(),
        Value::String(idempotency_key.clone()),
    );
    obj.insert(
        "posting_status".to_string(),
        Value::String(match operation_type {
            corecard::CoreCardOperationType::Refund => "refunded".to_string(),
            corecard::CoreCardOperationType::Reversal => "reversed".to_string(),
            _ => result.posting_status.clone(),
        }),
    );
    if let Some(value) = &result.external_transaction_id {
        obj.insert(
            "external_transaction_id".to_string(),
            Value::String(value.clone()),
        );
    }
    if let Some(value) = &result.host_reference {
        obj.insert("host_reference".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = result
        .refunded_at
        .or(result.reversed_at)
        .or(result.posted_at)
    {
        let field = if operation_type == corecard::CoreCardOperationType::Refund {
            "refunded_at"
        } else {
            "reversed_at"
        };
        obj.insert(field.to_string(), Value::String(value.to_rfc3339()));
    }
    obj.insert("host_metadata".to_string(), result.metadata.clone());
    obj.insert("response_snapshot".to_string(), result.metadata.clone());

    let mut tx = state.db.begin().await.map_err(PosMetaError::Database)?;
    pos_rms_charge::update_record_host_result(&mut *tx, record.id, &metadata)
        .await
        .map_err(PosMetaError::Database)?;
    corecard::attach_posting_event_refs(
        &mut *tx,
        &idempotency_key,
        Some(record.transaction_id),
        record.payment_transaction_id,
        Some(record.id),
    )
    .await
    .map_err(|error| PosMetaError::BadRequest(error.to_string()))?;
    tx.commit().await.map_err(PosMetaError::Database)?;

    Ok(result)
}

async fn reverse_rms_charge_purchase(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ReverseRmsChargeBody>,
) -> Result<Json<corecard::CoreCardHostMutationResult>, PosMetaError> {
    let staff = require_staff_rms_sensitive_permission(
        &state,
        &headers,
        &[ORDERS_REFUND_PROCESS, CUSTOMERS_RMS_CHARGE_MANAGE_LINKS],
    )
    .await?;
    let record = if let Some(record_id) = body.record_id {
        corecard::get_rms_charge_record_detail(&state.db, record_id)
            .await
            .map_err(|error| PosMetaError::BadRequest(error.to_string()))?
    } else if let Some(transaction_id) = body.transaction_id {
        let record_id: Uuid = sqlx::query_scalar(
            r#"
            SELECT id
            FROM pos_rms_charge_record
            WHERE transaction_id = $1 AND record_kind = 'charge'
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )
        .bind(transaction_id)
        .fetch_one(&state.db)
        .await
        .map_err(PosMetaError::Database)?;
        corecard::get_rms_charge_record_detail(&state.db, record_id)
            .await
            .map_err(|error| PosMetaError::BadRequest(error.to_string()))?
    } else {
        return Err(PosMetaError::BadRequest(
            "record_id or transaction_id is required".to_string(),
        ));
    };
    let result = reverse_rms_record(
        &state,
        &record,
        corecard::CoreCardOperationType::Refund,
        body.reason.clone(),
        body.amount.unwrap_or(record.amount),
    )
    .await?;
    let _ = crate::auth::pins::log_staff_access(
        &state.db,
        staff.id,
        "rms_charge_purchase_refund",
        json!({
            "record_id": record.id,
            "transaction_id": record.transaction_id,
            "amount": body.amount.unwrap_or(record.amount),
            "host_reference": result.host_reference,
        }),
    )
    .await;
    Ok(Json(result))
}

async fn reverse_rms_charge_payment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ReverseRmsChargeBody>,
) -> Result<Json<corecard::CoreCardHostMutationResult>, PosMetaError> {
    let staff = require_staff_rms_sensitive_permission(
        &state,
        &headers,
        &[ORDERS_REFUND_PROCESS, CUSTOMERS_RMS_CHARGE_MANAGE_LINKS],
    )
    .await?;
    let record = if let Some(record_id) = body.record_id {
        corecard::get_rms_charge_record_detail(&state.db, record_id)
            .await
            .map_err(|error| PosMetaError::BadRequest(error.to_string()))?
    } else if let Some(transaction_id) = body.transaction_id {
        let record_id: Uuid = sqlx::query_scalar(
            r#"
            SELECT id
            FROM pos_rms_charge_record
            WHERE transaction_id = $1 AND record_kind = 'payment'
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )
        .bind(transaction_id)
        .fetch_one(&state.db)
        .await
        .map_err(PosMetaError::Database)?;
        corecard::get_rms_charge_record_detail(&state.db, record_id)
            .await
            .map_err(|error| PosMetaError::BadRequest(error.to_string()))?
    } else {
        return Err(PosMetaError::BadRequest(
            "record_id or transaction_id is required".to_string(),
        ));
    };
    let result = reverse_rms_record(
        &state,
        &record,
        corecard::CoreCardOperationType::Reversal,
        body.reason.clone(),
        body.amount.unwrap_or(record.amount),
    )
    .await?;
    let _ = crate::auth::pins::log_staff_access(
        &state.db,
        staff.id,
        "rms_charge_payment_reversal",
        json!({
            "record_id": record.id,
            "transaction_id": record.transaction_id,
            "amount": body.amount.unwrap_or(record.amount),
            "host_reference": result.host_reference,
        }),
    )
    .await;
    Ok(Json(result))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rms-payment-line-meta", get(rms_payment_line_meta))
        .route("/gift-card-load-line-meta", get(gift_card_load_line_meta))
        .route(
            "/rms-charge/resolve-account",
            post(resolve_rms_charge_account),
        )
        .route("/rms-charge/programs", get(list_rms_charge_programs))
        .route(
            "/rms-charge/account-summary",
            get(get_rms_charge_account_summary),
        )
        .route("/rms-charge/post-purchase", post(post_rms_charge_purchase))
        .route("/rms-charge/post-payment", post(post_rms_charge_payment))
        .route(
            "/rms-charge/reverse-purchase",
            post(reverse_rms_charge_purchase),
        )
        .route(
            "/rms-charge/reverse-payment",
            post(reverse_rms_charge_payment),
        )
        .route("/shipping/rates", post(post_pos_shipping_rates))
}
