use base64::Engine;
use serde::Serialize;
use std::time::Duration;
use tauri::command;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

#[cfg(windows)]
use std::{ffi::c_void, process::Command};

#[derive(Debug, Serialize)]
pub struct SystemPrinter {
    pub name: String,
    pub is_default: bool,
}

#[cfg(windows)]
fn list_system_printers_sync() -> Result<Vec<SystemPrinter>, String> {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Printer | Select-Object @{Name='name';Expression={$_.Name}}, @{Name='is_default';Expression={$_.Default}} | ConvertTo-Json -Compress",
        ])
        .output()
        .map_err(|e| format!("Could not ask Windows for installed printers: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Windows printer list failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let value: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("Could not read Windows printer list: {e}"))?;
    let rows = match value {
        serde_json::Value::Array(rows) => rows,
        serde_json::Value::Object(_) => vec![value],
        _ => Vec::new(),
    };

    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let name = row.get("name")?.as_str()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(SystemPrinter {
                name,
                is_default: row
                    .get("is_default")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect())
}

#[cfg(not(windows))]
fn list_system_printers_sync() -> Result<Vec<SystemPrinter>, String> {
    Ok(Vec::new())
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
    let mut doc_name_w = wide("Riverside OS print job");
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
    Err("Installed printer printing is available on Windows desktop stations.".to_string())
}

#[command]
pub async fn list_system_printers() -> Result<Vec<SystemPrinter>, String> {
    tokio::task::spawn_blocking(list_system_printers_sync)
        .await
        .map_err(|e| format!("Printer list task failed: {e}"))?
}

#[command]
pub async fn check_system_printer(printer_name: String) -> Result<(), String> {
    let target = printer_name.trim().to_string();
    if target.is_empty() {
        return Err("Choose an installed printer first.".to_string());
    }
    let printers = list_system_printers_sync()?;
    if printers.iter().any(|printer| printer.name == target) {
        Ok(())
    } else {
        Err(format!(
            "Installed printer '{target}' was not found on this station."
        ))
    }
}

#[command]
pub async fn print_raw_to_system_printer_b64(
    printer_name: String,
    payload_b64: String,
) -> Result<(), String> {
    let target = printer_name.trim().to_string();
    if target.is_empty() {
        return Err("Choose an installed printer first.".to_string());
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload_b64.trim())
        .map_err(|e| format!("Invalid base64: {e}"))?;

    tokio::task::spawn_blocking(move || print_raw_to_windows_printer(&target, &bytes))
        .await
        .map_err(|e| format!("Printer task failed: {e}"))?
}

#[command]
pub async fn print_zpl_receipt(ip: String, port: u16, payload: String) -> Result<(), String> {
    log::info!("Attempting to dispatch ZPL receipt to {ip}:{port}");

    // Generous 5-second connect timeout for internal LAN
    let connect_future = TcpStream::connect((ip.as_str(), port));
    let mut stream = match tokio::time::timeout(Duration::from_secs(5), connect_future).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            log::error!("Failed to connect to printer: {e}");
            return Err(format!("Network connection failed: {e}"));
        }
        Err(_) => {
            log::error!("Printer connection timed out to {ip}:{port}");
            return Err("Printer connection timed out".to_string());
        }
    };

    if let Err(e) = stream.write_all(payload.as_bytes()).await {
        log::error!("Failed to transmit ZPL payload: {e}");
        return Err(format!("Payload transmission failed: {e}"));
    }

    if let Err(e) = stream.flush().await {
        log::error!("Failed to flush stream: {e}");
    }

    log::info!("Successfully dispatched ZPL to {ip}:{port}");
    Ok(())
}

#[command]
pub async fn print_escpos_receipt(ip: String, port: u16, payload: String) -> Result<(), String> {
    log::info!("Attempting to dispatch ESC/POS receipt to {ip}:{port}");

    let connect_future = TcpStream::connect((ip.as_str(), port));
    let mut stream = match tokio::time::timeout(Duration::from_secs(5), connect_future).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("Network connection failed: {e}")),
        Err(_) => return Err("Printer connection timed out".to_string()),
    };

    // ESC/POS Init (`ESC @`)
    let init: [u8; 2] = [0x1B, 0x40];

    // ESC/POS Full Cut (`GS V A 0`)
    let cut: [u8; 4] = [0x1D, 0x56, 0x41, 0x00];

    // Build final payload buffer
    let mut buf = Vec::new();
    buf.extend_from_slice(&init);

    // Epson TM series prints standard UTF-8 text perfectly if font pages align.
    // We add the raw text payload, appending line feeds if necessary.
    buf.extend_from_slice(payload.as_bytes());

    // Add 4 empty lines before cutting to feed past the tear bar
    buf.extend_from_slice(b"\n\n\n\n");
    buf.extend_from_slice(&cut);

    if let Err(e) = stream.write_all(&buf).await {
        log::error!("Failed to transmit ESC/POS buffer: {e}");
        return Err(format!("Payload transmission failed: {e}"));
    }

    if let Err(e) = stream.flush().await {
        log::error!("Failed to flush printer stream: {e}");
    }

    log::info!("Successfully dispatched ESC/POS to Epson {ip}:{port}");
    Ok(())
}

/// Raw ESC/POS bytes (standard base64), e.g. PNG→raster pipeline for Epson TM-m30III.
#[command]
pub async fn print_escpos_binary_b64(
    ip: String,
    port: u16,
    payload_b64: String,
) -> Result<(), String> {
    log::info!("Dispatching raw ESC/POS (base64) to {ip}:{port}");

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload_b64.trim())
        .map_err(|e| format!("Invalid base64: {e}"))?;

    let connect_future = TcpStream::connect((ip.as_str(), port));
    let mut stream = match tokio::time::timeout(Duration::from_secs(5), connect_future).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("Network connection failed: {e}")),
        Err(_) => return Err("Printer connection timed out".to_string()),
    };

    if let Err(e) = stream.write_all(&bytes).await {
        log::error!("Failed to transmit raw ESC/POS: {e}");
        return Err(format!("Payload transmission failed: {e}"));
    }
    if let Err(e) = stream.flush().await {
        log::error!("Failed to flush printer stream: {e}");
    }

    log::info!("Raw ESC/POS dispatched to {ip}:{port}");
    Ok(())
}

#[command]
pub async fn check_printer_connection(ip: String, port: u16) -> Result<(), String> {
    log::info!("Diagnostic: checking printer @ {ip}:{port}");
    let connect_future = TcpStream::connect((ip.as_str(), port));

    // Quick 2-second handshake for status check
    match tokio::time::timeout(Duration::from_secs(2), connect_future).await {
        Ok(Ok(_)) => {
            log::info!("Printer diagnostic SUCCESS");
            Ok(())
        }
        Ok(Err(e)) => Err(format!("Network failed: {e}")),
        Err(_) => Err("Connection timed out".to_string()),
    }
}
