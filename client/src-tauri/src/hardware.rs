use base64::Engine;
use std::time::Duration;
use tauri::command;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

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
