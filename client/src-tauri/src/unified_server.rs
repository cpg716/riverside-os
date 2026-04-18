use riverside_server::launcher::{launch_server, LauncherConfig};
use riverside_server::observability::ServerLogRing;
use std::sync::Mutex;
use tauri::State;

pub struct UnifiedServerState {
    pub is_running: Mutex<bool>,
}

impl Default for UnifiedServerState {
    fn default() -> Self {
        Self {
            is_running: Mutex::new(false),
        }
    }
}

#[tauri::command]
pub async fn start_unified_server(
    state: State<'_, UnifiedServerState>,
    database_url: String,
    stripe_key: String,
    port: u16,
) -> Result<String, String> {
    let mut running = state.is_running.lock().map_err(|_| "Lock poisoned")?;
    if *running {
        return Ok("Server already running".to_string());
    }

    let bind_addr = format!("0.0.0.0:{}", port);
    
    // In Tauri mode, we don't serve the frontend dist because Tauri itself is the frontend.
    // However, for other registers (iPad/PWA) to work, the server MUST serve the static files.
    // We assume they are located in a folder relative to the executable or a standard path.
    let config = LauncherConfig {
        database_url,
        stripe_secret_key: stripe_key,
        bind_addr,
        frontend_dist: None, // We'll need to figure out where the PWA files are bundled
        cors_origins: vec![],
        strict_production: false,
        max_body_bytes: None,
    };

    let server_log_ring = ServerLogRing::new(800, 2048);
    
    tokio::spawn(async move {
        if let Err(e) = launch_server(config, server_log_ring).await {
            log::error!("Unified Server failed: {}", e);
        }
    });

    *running = true;
    Ok("Unified Server started".to_string())
}

#[tauri::command]
pub fn get_unified_server_status(state: State<'_, UnifiedServerState>) -> bool {
    *state.is_running.lock().unwrap_or_else(|_| &mut false)
}
