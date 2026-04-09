//! POS helpers (register session): internal line metadata for client without hard-coded UUIDs.

use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
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
}

impl IntoResponse for PosMetaError {
    fn into_response(self) -> Response {
        match self {
            PosMetaError::Unauthorized(m) => {
                (axum::http::StatusCode::UNAUTHORIZED, m).into_response()
            }
            PosMetaError::NotFound(m) => (axum::http::StatusCode::NOT_FOUND, m).into_response(),
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

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rms-payment-line-meta", get(rms_payment_line_meta))
        .route("/gift-card-load-line-meta", get(gift_card_load_line_meta))
        .route("/shipping/rates", post(post_pos_shipping_rates))
}
