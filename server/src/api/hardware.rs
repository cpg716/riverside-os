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

#[cfg(windows)]
use std::{ffi::c_void, fs, process::Command, time::SystemTime};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
#[serde(rename_all = "snake_case")]
pub enum PrintStation {
    Receipt,
    Tag,
    Report,
}

impl PrintStation {
    fn as_key(&self) -> &'static str {
        match self {
            PrintStation::Receipt => "receipt",
            PrintStation::Tag => "tag",
            PrintStation::Report => "report",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrintStationMode {
    Network,
    System,
}

#[derive(Debug, Deserialize)]
pub struct StationPrintRequest {
    pub station: PrintStation,
    #[serde(default)]
    pub mode: Option<PrintStationMode>,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub printer_name: Option<String>,
    pub payload: String,
    /// Supported: text (default), raw_base64, raw_escpos_base64.
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StationPrinterCheckRequest {
    pub station: PrintStation,
    #[serde(default)]
    pub mode: Option<PrintStationMode>,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub printer_name: Option<String>,
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

enum ResolvedPrintTarget {
    Network { ip: String, port: u16 },
    System { printer_name: String },
}

fn target_from_request(
    mode: Option<PrintStationMode>,
    ip: Option<String>,
    port: Option<u16>,
    printer_name: Option<String>,
) -> Result<Option<ResolvedPrintTarget>, HardwareError> {
    match mode {
        Some(PrintStationMode::Network) => {
            let ip = ip
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    HardwareError::BadRequest("Printer address is not configured.".to_string())
                })?
                .to_string();
            Ok(Some(ResolvedPrintTarget::Network {
                ip,
                port: port.unwrap_or(9100),
            }))
        }
        Some(PrintStationMode::System) => {
            let printer_name = printer_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    HardwareError::BadRequest("Installed printer is not selected.".to_string())
                })?
                .to_string();
            Ok(Some(ResolvedPrintTarget::System { printer_name }))
        }
        None => Ok(None),
    }
}

fn target_from_config_lane(lane: &Value, station: &str) -> Option<ResolvedPrintTarget> {
    let mode_key = format!("ros.hardware.printer.{station}.mode");
    match lane_string_value(lane, &mode_key) {
        Some("system") => {
            let name_key = format!("ros.hardware.printer.{station}.systemName");
            lane_string_value(lane, &name_key).map(|printer_name| ResolvedPrintTarget::System {
                printer_name: printer_name.to_string(),
            })
        }
        _ => {
            let ip_key = format!("ros.hardware.printer.{station}.ip");
            lane_string_value(lane, &ip_key).map(|ip| ResolvedPrintTarget::Network {
                ip: ip.to_string(),
                port: lane_printer_port(lane, station),
            })
        }
    }
}

async fn resolve_stored_station_target(
    state: &AppState,
    station: &PrintStation,
) -> Result<ResolvedPrintTarget, HardwareError> {
    let config: Value =
        sqlx::query_scalar("SELECT pos_station_config FROM store_settings WHERE id = 1")
            .fetch_optional(&state.db)
            .await
            .map_err(|error| {
                tracing::error!(%error, "Thermal Hub: failed to load printer station config");
                HardwareError::Internal("Could not load printer configuration.".to_string())
            })?
            .unwrap_or(Value::Null);

    let station_key = station.as_key();
    let Some(printer_config) = config.get("printer_config").and_then(Value::as_object) else {
        return Err(HardwareError::BadRequest(format!(
            "Main Hub {} printer is not configured.",
            station_key
        )));
    };

    let preferred_keys: &[&str] = match station {
        PrintStation::Tag => &["0", "1"],
        PrintStation::Receipt => &["1", "0"],
        PrintStation::Report => &["0", "1"],
    };
    for key in preferred_keys {
        if let Some(lane) = printer_config.get(*key) {
            if let Some(target) = target_from_config_lane(lane, station_key) {
                return Ok(target);
            }
        }
    }

    let mut sorted_keys = printer_config.keys().collect::<Vec<_>>();
    sorted_keys.sort();
    for key in sorted_keys {
        if preferred_keys.contains(&key.as_str()) {
            continue;
        }
        if let Some(lane) = printer_config.get(key) {
            if let Some(target) = target_from_config_lane(lane, station_key) {
                return Ok(target);
            }
        }
    }

    Err(HardwareError::BadRequest(format!(
        "Main Hub {} printer is not configured.",
        station_key
    )))
}

fn decode_station_payload(payload: &str, format: Option<&str>) -> Result<Vec<u8>, HardwareError> {
    match format.unwrap_or("text") {
        "raw_base64" | "raw_escpos_base64" => base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .map_err(|e| HardwareError::BadRequest(format!("invalid base64: {e}"))),
        "text" | "raw_text" => Ok(payload.as_bytes().to_vec()),
        other => Err(HardwareError::BadRequest(format!(
            "Unsupported print format '{other}'."
        ))),
    }
}

async fn dispatch_network_bytes(ip: &str, port: u16, bytes: &[u8]) -> Result<(), HardwareError> {
    let addr = format!("{}:{}", ip.trim(), port);
    let mut stream =
        match tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(&addr)).await {
            Ok(Ok(stream)) => stream,
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "Thermal Hub: Connection refused at {}", addr);
                return Err(HardwareError::BadRequest(format!(
                    "Connection refused: {e}"
                )));
            }
            Err(_) => {
                tracing::warn!("Thermal Hub: Connection timeout for {}", addr);
                return Err(HardwareError::BadRequest(
                    "Printer connection timeout".to_string(),
                ));
            }
        };

    if let Err(e) = stream.write_all(bytes).await {
        tracing::error!(error = %e, "Thermal Hub: Write failed to {}", addr);
        return Err(HardwareError::Internal(format!("Write failed: {e}")));
    }
    if let Err(e) = stream.flush().await {
        tracing::error!(error = %e, "Thermal Hub: Flush failed for {}", addr);
    }
    Ok(())
}

#[cfg(windows)]
fn check_windows_printer(printer_name: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null_mut, NonNull};

    #[link(name = "Winspool")]
    extern "system" {
        fn OpenPrinterW(
            printer_name: *mut u16,
            printer_handle: *mut *mut c_void,
            defaults: *mut c_void,
        ) -> i32;
        fn ClosePrinter(printer_handle: *mut c_void) -> i32;
    }

    let mut printer_name_w: Vec<u16> = OsStr::new(printer_name)
        .encode_wide()
        .chain(once(0))
        .collect();
    let mut handle: *mut c_void = null_mut();
    let opened = unsafe { OpenPrinterW(printer_name_w.as_mut_ptr(), &mut handle, null_mut()) };
    let Some(handle) = NonNull::new(handle) else {
        return Err(format!("Windows could not open printer '{printer_name}'."));
    };
    unsafe {
        ClosePrinter(handle.as_ptr());
    }
    if opened == 0 {
        return Err(format!("Windows could not open printer '{printer_name}'."));
    }
    Ok(())
}

#[cfg(not(windows))]
fn check_windows_printer(_printer_name: &str) -> Result<(), String> {
    Err("Installed printer checks are available on Windows Main Hub stations.".to_string())
}

#[cfg(windows)]
fn print_raw_to_windows_printer(printer_name: &str, bytes: &[u8]) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null_mut, NonNull};

    #[repr(C)]
    struct DocInfo1W {
        doc_name: *mut u16,
        output_file: *mut u16,
        datatype: *mut u16,
    }

    #[link(name = "Winspool")]
    extern "system" {
        fn OpenPrinterW(
            printer_name: *mut u16,
            printer_handle: *mut *mut c_void,
            defaults: *mut c_void,
        ) -> i32;
        fn ClosePrinter(printer_handle: *mut c_void) -> i32;
        fn StartDocPrinterW(printer_handle: *mut c_void, level: u32, doc_info: *mut c_void) -> u32;
        fn EndDocPrinter(printer_handle: *mut c_void) -> i32;
        fn StartPagePrinter(printer_handle: *mut c_void) -> i32;
        fn EndPagePrinter(printer_handle: *mut c_void) -> i32;
        fn WritePrinter(
            printer_handle: *mut c_void,
            buffer: *mut c_void,
            buffer_len: u32,
            written: *mut u32,
        ) -> i32;
    }

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(once(0)).collect()
    }

    let mut printer_name_w = wide(printer_name);
    let mut doc_name_w = wide("Riverside OS print hub job");
    let mut datatype_w = wide("RAW");
    let mut handle: *mut c_void = null_mut();

    let opened = unsafe { OpenPrinterW(printer_name_w.as_mut_ptr(), &mut handle, null_mut()) };
    let Some(handle) = NonNull::new(handle) else {
        return Err(format!("Windows could not open printer '{printer_name}'."));
    };
    if opened == 0 {
        return Err(format!("Windows could not open printer '{printer_name}'."));
    }

    let mut doc_info = DocInfo1W {
        doc_name: doc_name_w.as_mut_ptr(),
        output_file: null_mut(),
        datatype: datatype_w.as_mut_ptr(),
    };

    let result = (|| {
        let job_id =
            unsafe { StartDocPrinterW(handle.as_ptr(), 1, &mut doc_info as *mut _ as *mut c_void) };
        if job_id == 0 {
            return Err(format!(
                "Windows could not start a print job for '{printer_name}'."
            ));
        }

        let started_page = unsafe { StartPagePrinter(handle.as_ptr()) };
        if started_page == 0 {
            unsafe {
                EndDocPrinter(handle.as_ptr());
            }
            return Err(format!(
                "Windows could not start a printer page for '{printer_name}'."
            ));
        }

        let mut written = 0u32;
        let wrote = unsafe {
            WritePrinter(
                handle.as_ptr(),
                bytes.as_ptr() as *mut c_void,
                bytes.len() as u32,
                &mut written,
            )
        };

        unsafe {
            EndPagePrinter(handle.as_ptr());
            EndDocPrinter(handle.as_ptr());
        }

        if wrote == 0 || written as usize != bytes.len() {
            return Err(format!(
                "Windows did not accept the full print job for '{printer_name}'."
            ));
        }

        Ok(())
    })();

    unsafe {
        ClosePrinter(handle.as_ptr());
    }

    result
}

#[cfg(not(windows))]
fn print_raw_to_windows_printer(_printer_name: &str, _bytes: &[u8]) -> Result<(), String> {
    Err("Installed printer printing is available on Windows Main Hub stations.".to_string())
}

#[cfg(windows)]
fn print_text_to_windows_printer(printer_name: &str, content: &str) -> Result<(), String> {
    const REPORT_PRINT_SCRIPT: &str = r#"
$PrinterName = $args[0]
$ContentPath = $args[1]
Add-Type -AssemblyName System.Drawing
$doc = $null
$font = $null
try {
  $content = [System.IO.File]::ReadAllText($ContentPath)
  $rawLines = $content -split '\r?\n'
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($line in $rawLines) {
    if ($line.Length -le 120) {
      [void]$lines.Add($line)
      continue
    }
    for ($i = 0; $i -lt $line.Length; $i += 120) {
      [void]$lines.Add($line.Substring($i, [Math]::Min(120, $line.Length - $i)))
    }
  }

  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.DocumentName = 'Riverside OS Print Hub Report'
  $doc.PrinterSettings.PrinterName = $PrinterName
  if (-not $doc.PrinterSettings.IsValid) {
    throw "Configured Reports printer '$PrinterName' is not available."
  }
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(36, 36, 36, 36)
  $font = New-Object System.Drawing.Font('Consolas', 9)
  $brush = [System.Drawing.Brushes]::Black
  $state = @{ Index = 0 }
  $handler = {
    param($sender, $eventArgs)
    $lineHeight = $font.GetHeight($eventArgs.Graphics)
    $x = [single]$eventArgs.MarginBounds.Left
    $y = [single]$eventArgs.MarginBounds.Top
    while ($state.Index -lt $lines.Count -and ($y + $lineHeight) -le $eventArgs.MarginBounds.Bottom) {
      $eventArgs.Graphics.DrawString($lines[$state.Index], $font, $brush, $x, $y)
      $state.Index++
      $y += $lineHeight
    }
    $eventArgs.HasMorePages = $state.Index -lt $lines.Count
  }.GetNewClosure()
  $doc.add_PrintPage($handler)
  $doc.Print()
} finally {
  if ($font -ne $null) { $font.Dispose() }
  if ($doc -ne $null) { $doc.Dispose() }
}
"#;
    let timestamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| format!("Could not create report timestamp: {e}"))?
        .as_millis();
    let path = std::env::temp_dir().join(format!(
        "riverside-print-hub-report-{}-{timestamp}.txt",
        std::process::id()
    ));
    fs::write(&path, content).map_err(|e| format!("Could not prepare report print file: {e}"))?;

    let path_arg = path.to_string_lossy().to_string();
    let output = Command::new("powershell")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            REPORT_PRINT_SCRIPT,
            printer_name,
            path_arg.as_str(),
        ])
        .output()
        .map_err(|e| format!("Could not start Windows report print: {e}"));

    let _ = fs::remove_file(&path);

    let output = output?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            output.status.to_string()
        };
        Err(format!(
            "Windows report print failed for '{printer_name}': {detail}"
        ))
    }
}

#[cfg(not(windows))]
fn print_text_to_windows_printer(_printer_name: &str, _content: &str) -> Result<(), String> {
    Err("Direct report printing is available on Windows Main Hub stations.".to_string())
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
        .route("/print-station", post(handle_print_station))
        .route("/check-printer", post(handle_check_printer))
        .route("/check-station-printer", post(handle_check_station_printer))
        .route("/escpos-from-png", post(handle_escpos_from_png))
}

async fn handle_check_station_printer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<StationPrinterCheckRequest>,
) -> Result<Response, HardwareError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_hw_session)?;

    let target =
        match target_from_request(payload.mode, payload.ip, payload.port, payload.printer_name)? {
            Some(target) => target,
            None => resolve_stored_station_target(&state, &payload.station).await?,
        };

    match target {
        ResolvedPrintTarget::Network { ip, port } => {
            let addr = format!("{ip}:{port}");
            match tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(&addr)).await {
                Ok(Ok(_stream)) => Ok((
                    StatusCode::OK,
                    Json(json!({
                        "status": "reachable",
                        "station": payload.station.as_key(),
                        "target": addr,
                        "route": "network",
                    })),
                )
                    .into_response()),
                Ok(Err(e)) => Ok((
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error": format!("Connection refused: {e}")})),
                )
                    .into_response()),
                Err(_) => Ok((
                    StatusCode::GATEWAY_TIMEOUT,
                    Json(json!({"error": "Printer connection timeout"})),
                )
                    .into_response()),
            }
        }
        ResolvedPrintTarget::System { printer_name } => {
            tokio::task::spawn_blocking({
                let printer_name = printer_name.clone();
                move || check_windows_printer(&printer_name)
            })
            .await
            .map_err(|e| HardwareError::Internal(format!("Printer task failed: {e}")))?
            .map_err(HardwareError::BadRequest)?;
            Ok((
                StatusCode::OK,
                Json(json!({
                    "status": "reachable",
                    "station": payload.station.as_key(),
                    "target": printer_name,
                    "route": "system",
                })),
            )
                .into_response())
        }
    }
}

async fn handle_print_station(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<StationPrintRequest>,
) -> Result<Response, HardwareError> {
    middleware::require_staff_or_pos_register_session(&state, &headers)
        .await
        .map_err(map_hw_session)?;

    let bytes_to_send = decode_station_payload(&payload.payload, payload.format.as_deref())?;
    if bytes_to_send.is_empty() {
        return Err(HardwareError::BadRequest(
            "Print payload is empty.".to_string(),
        ));
    }

    let target =
        match target_from_request(payload.mode, payload.ip, payload.port, payload.printer_name)? {
            Some(target) => target,
            None => resolve_stored_station_target(&state, &payload.station).await?,
        };

    match target {
        ResolvedPrintTarget::Network { ip, port } => {
            require_allowed_printer_target(&state, &ip, port).await?;
            dispatch_network_bytes(&ip, port, &bytes_to_send).await?;
            let target = format!("{ip}:{port}");
            tracing::info!(
                station = payload.station.as_key(),
                target = %target,
                bytes = bytes_to_send.len(),
                "Thermal Hub: station print dispatched"
            );
            Ok((
                StatusCode::OK,
                Json(json!({
                    "status": "dispatched",
                    "station": payload.station.as_key(),
                    "route": "network",
                    "target": target,
                    "bytes": bytes_to_send.len(),
                })),
            )
                .into_response())
        }
        ResolvedPrintTarget::System { printer_name } => {
            if matches!(&payload.station, PrintStation::Report)
                && payload.format.as_deref().unwrap_or("text") == "text"
            {
                tokio::task::spawn_blocking({
                    let printer_name = printer_name.clone();
                    let content = payload.payload.clone();
                    move || print_text_to_windows_printer(&printer_name, &content)
                })
                .await
                .map_err(|e| HardwareError::Internal(format!("Printer task failed: {e}")))?
                .map_err(HardwareError::BadRequest)?;
            } else {
                tokio::task::spawn_blocking({
                    let printer_name = printer_name.clone();
                    let bytes = bytes_to_send.clone();
                    move || print_raw_to_windows_printer(&printer_name, &bytes)
                })
                .await
                .map_err(|e| HardwareError::Internal(format!("Printer task failed: {e}")))?
                .map_err(HardwareError::BadRequest)?;
            }

            tracing::info!(
                station = payload.station.as_key(),
                target = %printer_name,
                bytes = bytes_to_send.len(),
                "Thermal Hub: station print dispatched"
            );
            Ok((
                StatusCode::OK,
                Json(json!({
                    "status": "dispatched",
                    "station": payload.station.as_key(),
                    "route": "system",
                    "target": printer_name,
                    "bytes": bytes_to_send.len(),
                })),
            )
                .into_response())
        }
    }
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
