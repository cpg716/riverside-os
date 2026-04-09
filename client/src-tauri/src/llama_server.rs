//! Optional embedded **llama.cpp** `llama-server` sidecar (see `binaries/README.md`).
//! Spawns with [`tauri_plugin_shell`] and tracks lifecycle for ROSIE / local LLM HTTP clients.

use std::sync::Mutex;
use tauri::async_runtime::Receiver;
use tauri::AppHandle;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Holds the running sidecar child so we can [`tauri_plugin_shell::process::CommandChild::kill`] on stop.
pub struct LlamaSidecarState(pub Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

impl Default for LlamaSidecarState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

fn drain_sidecar_logs(mut rx: Receiver<CommandEvent>) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::info!(
                        target: "llama_server",
                        "{}",
                        String::from_utf8_lossy(&line).trim_end()
                    );
                }
                CommandEvent::Stderr(line) => {
                    log::warn!(
                        target: "llama_server",
                        "{}",
                        String::from_utf8_lossy(&line).trim_end()
                    );
                }
                CommandEvent::Error(err) => {
                    log::error!(target: "llama_server", "{}", err);
                }
                CommandEvent::Terminated(payload) => {
                    log::info!(target: "llama_server", "terminated: {:?}", payload);
                    break;
                }
                _ => {}
            }
        }
    });
}

/// Start `llama-server` if not already running. Uses env:
/// - `RIVERSIDE_LLAMA_MODEL_PATH` — required `.gguf` path (Windows path OK).
/// - `RIVERSIDE_LLAMA_MMPROJ_PATH` — optional; enables **LLaVA** (`--mmproj`).
/// - `RIVERSIDE_LLAMA_HOST` — default `127.0.0.1`.
/// - `RIVERSIDE_LLAMA_PORT` — default `8080`.
#[tauri::command]
pub async fn rosie_llama_start(
    app: AppHandle,
    state: tauri::State<'_, LlamaSidecarState>,
) -> Result<String, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "llama-server state lock poisoned".to_string())?;

    if guard.is_some() {
        return Ok("llama-server already running".to_string());
    }

    let model_path = std::env::var("RIVERSIDE_LLAMA_MODEL_PATH")
        .map_err(|_| "RIVERSIDE_LLAMA_MODEL_PATH is not set (path to .gguf)".to_string())?;
    if model_path.is_empty() {
        return Err("RIVERSIDE_LLAMA_MODEL_PATH is empty".to_string());
    }

    let host = std::env::var("RIVERSIDE_LLAMA_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("RIVERSIDE_LLAMA_PORT").unwrap_or_else(|_| "8080".into());

    let mut cmd = app
        .shell()
        .sidecar("llama-server")
        .map_err(|e| format!("llama-server sidecar missing (see src-tauri/binaries/README.md): {e}"))?
        .args([
            "-m",
            model_path.as_str(),
            "--host",
            host.as_str(),
            "--port",
            port.as_str(),
        ]);

    if let Ok(mmproj) = std::env::var("RIVERSIDE_LLAMA_MMPROJ_PATH") {
        if !mmproj.is_empty() {
            cmd = cmd.args(["--mmproj", mmproj.as_str()]);
        }
    }

    let (rx, child) = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn llama-server: {e}"))?;

    drain_sidecar_logs(rx);
    *guard = Some(child);

    Ok(format!(
        "llama-server started at http://{}:{}/ (set RIVERSIDE_LLAMA_* to change)",
        host, port
    ))
}

/// Stop the embedded `llama-server` if running.
#[tauri::command]
pub async fn rosie_llama_stop(state: tauri::State<'_, LlamaSidecarState>) -> Result<String, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "llama-server state lock poisoned".to_string())?;

    let Some(child) = guard.take() else {
        return Ok("llama-server was not running".to_string());
    };

    child
        .kill()
        .map_err(|e| format!("failed to kill llama-server: {e}"))?;

    Ok("llama-server stopped".to_string())
}

/// Whether the sidecar process handle is held (best-effort; does not HTTP-probe).
#[tauri::command]
pub fn rosie_llama_status(state: tauri::State<'_, LlamaSidecarState>) -> Result<bool, String> {
    let guard = state
        .0
        .lock()
        .map_err(|_| "llama-server state lock poisoned".to_string())?;
    Ok(guard.is_some())
}
