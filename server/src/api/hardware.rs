use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

use crate::api::AppState;
use crate::middleware;

#[derive(Debug, Deserialize)]
pub struct PrintRequest {
    pub ip: String,
    pub port: u16,
    pub payload: String,
    /// When `raw_escpos_base64`, `payload` is standard base64 of raw bytes (no UTF-8 text wrapper).
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PngToEscposRequest {
    pub png_base64: String,
}

#[derive(Debug, Error)]
pub enum HardwareError {
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    BadRequest(String),
}

fn map_hw_session(e: (StatusCode, axum::Json<serde_json::Value>)) -> HardwareError {
    let (_st, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    HardwareError::Unauthorized(msg)
}

impl IntoResponse for HardwareError {
    fn into_response(self) -> Response {
        match self {
            HardwareError::Unauthorized(msg) => {
                (StatusCode::UNAUTHORIZED, Json(json!({ "error": msg }))).into_response()
            }
            HardwareError::BadRequest(msg) => {
                (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
            }
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/print", post(handle_print))
        .route("/escpos-from-png", post(handle_escpos_from_png))
}

async fn handle_print(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PrintRequest>,
) -> Result<Response, HardwareError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_hw_session)?;

    let addr = format!("{}:{}", payload.ip, payload.port);

    let bytes_to_send: Vec<u8> = if payload.format.as_deref() == Some("raw_escpos_base64") {
        match base64::engine::general_purpose::STANDARD.decode(payload.payload.trim()) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(error = %e, "Thermal Hub: invalid raw_escpos_base64");
                return Err(HardwareError::BadRequest(format!("invalid base64: {e}")));
            }
        }
    } else {
        payload.payload.into_bytes()
    };

    match tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(&addr)).await {
        Ok(Ok(mut stream)) => {
            if let Err(e) = stream.write_all(&bytes_to_send).await {
                tracing::error!(error = %e, "Thermal Hub: Write failed to {}", addr);
                return Ok((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": format!("Write failed: {}", e)})),
                )
                    .into_response());
            }
            if let Err(e) = stream.flush().await {
                tracing::error!(error = %e, "Thermal Hub: Flush failed for {}", addr);
            }
            tracing::info!("Thermal Hub: Dispatched payload to {}", addr);
            Ok((StatusCode::OK, Json(json!({"status": "dispatched"}))).into_response())
        }
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "Thermal Hub: Connection refused at {}", addr);
            Ok((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": format!("Connection refused: {}", e)})),
            )
                .into_response())
        }
        Err(_) => {
            tracing::warn!("Thermal Hub: Connection timeout for {}", addr);
            Ok((
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({"error": "Printer connection timeout"})),
            )
                .into_response())
        }
    }
}

async fn handle_escpos_from_png(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PngToEscposRequest>,
) -> Result<Response, HardwareError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_hw_session)?;

    let png = base64::engine::general_purpose::STANDARD
        .decode(body.png_base64.trim())
        .map_err(|e| HardwareError::BadRequest(format!("invalid png_base64: {e}")))?;

    let escpos = crate::logic::receipt_escpos_raster::png_to_escpos_tm_raster(&png)
        .map_err(HardwareError::BadRequest)?;

    let escpos_base64 = base64::engine::general_purpose::STANDARD.encode(&escpos);

    Ok((
        StatusCode::OK,
        Json(json!({
            "escpos_base64": escpos_base64,
            "width_dots": crate::logic::receipt_escpos_raster::ESCPOS_RECEIPT_WIDTH_DOTS,
        })),
    )
        .into_response())
}
