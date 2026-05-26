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
    CUSTOMERS_RMS_CHARGE_REVERSE, ORDERS_REFUND_PROCESS, POS_RMS_CHARGE_HISTORY_BASIC,
    POS_RMS_CHARGE_LOOKUP, POS_RMS_CHARGE_USE,
};
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

#[derive(serde::Serialize)]
struct RmsMutationResult {
    operation_type: String,
    posting_status: String,
    host_reference: Option<String>,
    metadata: Value,
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
    #[serde(default)]
    pub parcels: Option<Vec<shippo::ParcelInput>>,
    #[serde(default)]
    pub customs_declaration_object_id: Option<String>,
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
        body.parcels.as_deref(),
        body.customs_declaration_object_id.as_deref(),
        false,
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

async fn reverse_rms_record_manual(
    state: &AppState,
    record_id: Uuid,
    status: &str,
    reason: Option<String>,
    amount: rust_decimal::Decimal,
) -> Result<RmsMutationResult, PosMetaError> {
    let now = chrono::Utc::now();
    let (metadata_row, current_resolution): (Option<Value>, String) = sqlx::query_as(
        "SELECT metadata_json, COALESCE(resolution_status, '') FROM pos_rms_charge_record WHERE id = $1"
    )
        .bind(record_id)
        .fetch_optional(&state.db)
        .await
        .map_err(PosMetaError::Database)?
        .ok_or(PosMetaError::BadRequest(
            "RMS charge record not found".to_string(),
        ))?;
    if current_resolution == "refunded" || current_resolution == "reversed" {
        return Err(PosMetaError::BadRequest(
            "Record has already been reversed or refunded".to_string(),
        ));
    }
    let mut metadata = metadata_row.unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({});
    }
    let obj = metadata.as_object_mut().expect("object just assigned");
    obj.insert(
        "source_mode".to_string(),
        Value::String("manual".to_string()),
    );
    obj.insert(
        "rms_charge_source".to_string(),
        Value::String("manual".to_string()),
    );
    obj.insert(
        "posting_status".to_string(),
        Value::String(status.to_string()),
    );
    obj.insert(
        "manual_tracking_status".to_string(),
        Value::String(format!("{status}_manually")),
    );
    obj.insert("not_host_posted".to_string(), Value::Bool(true));
    obj.insert(
        "manual_follow_on_amount".to_string(),
        Value::String(amount.to_string()),
    );
    if let Some(reason) = reason.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        obj.insert(
            "manual_follow_on_reason".to_string(),
            Value::String(reason.to_string()),
        );
    }
    let timestamp_field = if status == "refunded" {
        "refunded_at"
    } else {
        "reversed_at"
    };
    obj.insert(timestamp_field.to_string(), Value::String(now.to_rfc3339()));

    let mut tx = state.db.begin().await.map_err(PosMetaError::Database)?;
    pos_rms_charge::update_record_host_result(&mut *tx, record_id, &metadata)
        .await
        .map_err(PosMetaError::Database)?;

    let host_reference: Option<String> =
        sqlx::query_scalar("SELECT host_reference FROM pos_rms_charge_record WHERE id = $1")
            .bind(record_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(PosMetaError::Database)?;

    tx.commit().await.map_err(PosMetaError::Database)?;

    Ok(RmsMutationResult {
        operation_type: if status == "refunded" {
            "refund".to_string()
        } else {
            "reversal".to_string()
        },
        posting_status: status.to_string(),
        host_reference,
        metadata,
    })
}

async fn reverse_rms_charge_purchase(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ReverseRmsChargeBody>,
) -> Result<Json<RmsMutationResult>, PosMetaError> {
    let staff =
        require_staff_rms_sensitive_permission(&state, &headers, &[CUSTOMERS_RMS_CHARGE_REVERSE])
            .await?;
    let record_id = if let Some(id) = body.record_id {
        id
    } else if let Some(transaction_id) = body.transaction_id {
        sqlx::query_scalar(
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
        .map_err(PosMetaError::Database)?
    } else {
        return Err(PosMetaError::BadRequest(
            "record_id or transaction_id is required".to_string(),
        ));
    };
    let result = reverse_rms_record_manual(
        &state,
        record_id,
        "refunded",
        body.reason.clone(),
        body.amount.unwrap_or_else(|| rust_decimal::Decimal::ZERO),
    )
    .await?;
    let _ = crate::auth::pins::log_staff_access(
        &state.db,
        staff.id,
        "rms_charge_purchase_refund",
        json!({
            "record_id": record_id,
            "amount": body.amount,
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
) -> Result<Json<RmsMutationResult>, PosMetaError> {
    let staff =
        require_staff_rms_sensitive_permission(&state, &headers, &[CUSTOMERS_RMS_CHARGE_REVERSE])
            .await?;
    let record_id = if let Some(id) = body.record_id {
        id
    } else if let Some(transaction_id) = body.transaction_id {
        sqlx::query_scalar(
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
        .map_err(PosMetaError::Database)?
    } else {
        return Err(PosMetaError::BadRequest(
            "record_id or transaction_id is required".to_string(),
        ));
    };
    let result = reverse_rms_record_manual(
        &state,
        record_id,
        "reversed",
        body.reason.clone(),
        body.amount.unwrap_or_else(|| rust_decimal::Decimal::ZERO),
    )
    .await?;
    let _ = crate::auth::pins::log_staff_access(
        &state.db,
        staff.id,
        "rms_charge_payment_reversal",
        json!({
            "record_id": record_id,
            "amount": body.amount,
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
            "/rms-charge/reverse-purchase",
            post(reverse_rms_charge_purchase),
        )
        .route(
            "/rms-charge/reverse-payment",
            post(reverse_rms_charge_payment),
        )
        .route("/shipping/rates", post(post_pos_shipping_rates))
}
