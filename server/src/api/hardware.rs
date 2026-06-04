use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
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
pub struct PrinterCheckRequest {
    pub ip: String,
    pub port: u16,
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
    Forbidden(String),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Internal(String),
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
            HardwareError::Forbidden(msg) => {
                (StatusCode::FORBIDDEN, Json(json!({ "error": msg }))).into_response()
            }
            HardwareError::BadRequest(msg) => {
                (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
            }
            HardwareError::Internal(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": msg })),
            )
                .into_response(),
        }
    }
}

const PRINTER_STATIONS: [&str; 3] = ["receipt", "tag", "report"];

fn normalize_printer_host(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase()
}

fn lane_string_value<'a>(lane: &'a Value, key: &str) -> Option<&'a str> {
    lane.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

fn lane_printer_port(lane: &Value, station: &str) -> u16 {
    let key = format!("ros.hardware.printer.{station}.port");
    lane.get(&key)
        .and_then(|value| match value {
            Value::String(raw) => raw.trim().parse::<u16>().ok(),
            Value::Number(raw) => raw.as_u64().and_then(|n| u16::try_from(n).ok()),
            _ => None,
        })
        .filter(|port| *port > 0)
        .unwrap_or(9100)
}

fn printer_target_allowed(pos_station_config: &Value, ip: &str, port: u16) -> bool {
    let requested_host = normalize_printer_host(ip);
    if requested_host.is_empty() {
        return false;
    }

    let Some(printer_config) = pos_station_config
        .get("printer_config")
        .and_then(Value::as_object)
    else {
        return false;
    };

    printer_config.values().any(|lane| {
        PRINTER_STATIONS.iter().any(|station| {
            let mode_key = format!("ros.hardware.printer.{station}.mode");
            if matches!(lane_string_value(lane, &mode_key), Some("system")) {
                return false;
            }

            let ip_key = format!("ros.hardware.printer.{station}.ip");
            let Some(configured_ip) = lane_string_value(lane, &ip_key) else {
                return false;
            };

            normalize_printer_host(configured_ip) == requested_host
                && lane_printer_port(lane, station) == port
        })
    })
}

async fn require_allowed_printer_target(
    state: &AppState,
    ip: &str,
    port: u16,
) -> Result<(), HardwareError> {
    let config: Value =
        sqlx::query_scalar("SELECT pos_station_config FROM store_settings WHERE id = 1")
            .fetch_optional(&state.db)
            .await
            .map_err(|error| {
                tracing::error!(%error, "Thermal Hub: failed to load printer allowlist");
                HardwareError::Internal("Could not verify printer configuration.".to_string())
            })?
            .unwrap_or(Value::Null);

    if printer_target_allowed(&config, ip, port) {
        return Ok(());
    }

    tracing::warn!(
        printer_ip = %ip,
        printer_port = port,
        "Thermal Hub: blocked print to non-allowlisted printer target"
    );
    Err(HardwareError::Forbidden(
        "Printer target is not configured for any saved station.".to_string(),
    ))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/print", post(handle_print))
        .route("/check-printer", post(handle_check_printer))
        .route("/escpos-from-png", post(handle_escpos_from_png))
}

async fn handle_check_printer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PrinterCheckRequest>,
) -> Result<Response, HardwareError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_hw_session)?;

    let addr = format!("{}:{}", payload.ip.trim(), payload.port);
    if payload.ip.trim().is_empty() {
        return Err(HardwareError::BadRequest(
            "Printer address is not configured.".to_string(),
        ));
    }

    match tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(&addr)).await {
        Ok(Ok(_stream)) => {
            tracing::info!("Thermal Hub: Printer readiness confirmed at {}", addr);
            Ok((StatusCode::OK, Json(json!({"status": "reachable"}))).into_response())
        }
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "Thermal Hub: Printer readiness failed at {}", addr);
            Ok((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": format!("Connection refused: {}", e)})),
            )
                .into_response())
        }
        Err(_) => {
            tracing::warn!("Thermal Hub: Printer readiness timeout for {}", addr);
            Ok((
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({"error": "Printer connection timeout"})),
            )
                .into_response())
        }
    }
}

async fn handle_print(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PrintRequest>,
) -> Result<Response, HardwareError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_hw_session)?;

    let ip = payload.ip.trim();
    if ip.is_empty() {
        return Err(HardwareError::BadRequest(
            "Printer address is not configured.".to_string(),
        ));
    }
    require_allowed_printer_target(&state, ip, payload.port).await?;
    let addr = format!("{}:{}", ip, payload.port);

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
