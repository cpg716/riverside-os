//! Unified shipments hub API (POS, web, manual) + timeline.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::{SHIPMENTS_MANAGE, SHIPMENTS_VIEW};
use crate::logic::shipment::{
    add_staff_note, apply_rate_quote, create_manual_shipment, fetch_rates_for_shipment,
    get_shipment_detail, list_events, list_shipments, patch_shipment, purchase_shipment_label,
    ApplyQuoteBody, CreateManualShipmentBody, PatchShipmentBody, ShipmentError, ShipmentListQuery,
    StaffNoteBody,
};
use crate::logic::shippo::ParcelInput;
use crate::middleware;

#[derive(Debug, serde::Deserialize, Default)]
pub struct RatesQuery {
    #[serde(default)]
    pub force_stub: bool,
}

#[derive(Debug, serde::Deserialize, Default)]
pub struct RatesBody {
    #[serde(default)]
    pub parcel: Option<ParcelInput>,
}

async fn list_shipments_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ShipmentListQuery>,
) -> Result<Json<serde_json::Value>, ShipmentsApiError> {
    middleware::require_staff_with_permission(&state, &headers, SHIPMENTS_VIEW)
        .await
        .map_err(map_perm)?;
    let rows = list_shipments(&state.db, &q).await?;
    Ok(Json(json!({ "items": rows })))
}

async fn get_shipment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ShipmentsApiError> {
    middleware::require_staff_with_permission(&state, &headers, SHIPMENTS_VIEW)
        .await
        .map_err(map_perm)?;
    let row = get_shipment_detail(&state.db, id)
        .await?
        .ok_or(ShipmentError::NotFound)?;
    let events = list_events(&state.db, id).await?;
    Ok(Json(json!({
        "shipment": row,
        "events": events,
    })))
}

async fn create_manual(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateManualShipmentBody>,
) -> Result<Json<serde_json::Value>, ShipmentsApiError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SHIPMENTS_MANAGE)
        .await
        .map_err(map_perm)?;
    let id = create_manual_shipment(&state.db, body, staff.id).await?;
    Ok(Json(json!({ "shipment_id": id })))
}

async fn post_rates(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<RatesQuery>,
    Json(body): Json<RatesBody>,
) -> Result<Json<serde_json::Value>, ShipmentsApiError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SHIPMENTS_MANAGE)
        .await
        .map_err(map_perm)?;
    let res = fetch_rates_for_shipment(
        &state.db,
        &state.http_client,
        id,
        body.parcel.as_ref(),
        q.force_stub,
        staff.id,
    )
    .await?;
    Ok(Json(serde_json::to_value(res).unwrap_or(json!({}))))
}

async fn post_apply_quote(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<ApplyQuoteBody>,
) -> Result<StatusCode, ShipmentsApiError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SHIPMENTS_MANAGE)
        .await
        .map_err(map_perm)?;
    apply_rate_quote(&state.db, id, body.rate_quote_id, staff.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn post_purchase_label(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ShipmentsApiError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SHIPMENTS_MANAGE)
        .await
        .map_err(map_perm)?;
    let purchased = purchase_shipment_label(&state.db, &state.http_client, id, staff.id).await?;
    Ok(Json(
        serde_json::to_value(purchased).unwrap_or_else(|_| json!({})),
    ))
}

async fn post_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<StaffNoteBody>,
) -> Result<StatusCode, ShipmentsApiError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SHIPMENTS_MANAGE)
        .await
        .map_err(map_perm)?;
    add_staff_note(&state.db, id, body.message, staff.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn patch_shipment_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchShipmentBody>,
) -> Result<StatusCode, ShipmentsApiError> {
    let staff = middleware::require_staff_with_permission(&state, &headers, SHIPMENTS_MANAGE)
        .await
        .map_err(map_perm)?;
    patch_shipment(&state.db, id, body, staff.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug)]
enum ShipmentsApiError {
    Shipment(ShipmentError),
    Perm(StatusCode, String),
}

fn map_perm(e: (StatusCode, axum::Json<serde_json::Value>)) -> ShipmentsApiError {
    let (st, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("forbidden")
        .to_string();
    ShipmentsApiError::Perm(st, msg)
}

impl IntoResponse for ShipmentsApiError {
    fn into_response(self) -> Response {
        match self {
            ShipmentsApiError::Perm(st, m) => (st, Json(json!({ "error": m }))).into_response(),
            ShipmentsApiError::Shipment(ShipmentError::NotFound) => {
                (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response()
            }
            ShipmentsApiError::Shipment(ShipmentError::InvalidPayload(m)) => {
                (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response()
            }
            ShipmentsApiError::Shipment(ShipmentError::Shippo(e)) => match e {
                crate::logic::shippo::ShippoError::InvalidAddress(m)
                | crate::logic::shippo::ShippoError::Parse(m) => {
                    (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response()
                }
                crate::logic::shippo::ShippoError::Api(m) => {
                    tracing::warn!(error = %m, "shipment rates shippo API");
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(json!({ "error": "shipping provider error" })),
                    )
                        .into_response()
                }
                crate::logic::shippo::ShippoError::Database(d) => {
                    tracing::error!(error = %d, "shipment rates DB");
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": "internal error" })),
                    )
                        .into_response()
                }
            },
            ShipmentsApiError::Shipment(ShipmentError::Database(e)) => {
                tracing::error!(error = %e, "shipment API database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "internal error" })),
                )
                    .into_response()
            }
        }
    }
}

impl From<ShipmentError> for ShipmentsApiError {
    fn from(e: ShipmentError) -> Self {
        ShipmentsApiError::Shipment(e)
    }
}

impl From<sqlx::Error> for ShipmentsApiError {
    fn from(e: sqlx::Error) -> Self {
        ShipmentsApiError::Shipment(ShipmentError::Database(e))
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_shipments_handler).post(create_manual))
        .route("/{id}", get(get_shipment).patch(patch_shipment_handler))
        .route("/{id}/rates", post(post_rates))
        .route("/{id}/apply-quote", post(post_apply_quote))
        .route("/{id}/purchase-label", post(post_purchase_label))
        .route("/{id}/notes", post(post_note))
}
