use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{Manager, State};

struct BridgeProcessState {
    child: Mutex<Option<Child>>,
    logs: Arc<Mutex<Vec<String>>>,
}

fn strip_quotes(s: &str) -> String {
    let mut val = s.trim().to_string();
    if (val.starts_with('"') && val.ends_with('"'))
        || (val.starts_with('\'') && val.ends_with('\''))
    {
        val.remove(0);
        if !val.is_empty() {
            val.pop();
        }
    }
    val
}

fn find_bridge_directory(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    // 1. Check Tauri resource directory (for production installations)
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        if res_dir.join("index.mjs").exists() {
            return Some(res_dir);
        }
        let nested = res_dir.join("_up_/_up_/_up_/counterpoint-bridge");
        if nested.join("index.mjs").exists() {
            return Some(nested);
        }
    }

    // 2. Check next to current running executable
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let path = exe_dir.join("counterpoint-bridge");
            if path.join("index.mjs").exists() {
                return Some(path);
            }
            // Check parent directory
            let parent_path = exe_dir.join("../counterpoint-bridge");
            if parent_path.join("index.mjs").exists() {
                return Some(parent_path);
            }
            // Check double parent (common inside target/debug)
            let grandparent_path = exe_dir.join("../../counterpoint-bridge");
            if grandparent_path.join("index.mjs").exists() {
                return Some(grandparent_path);
            }
        }
    }

    // 3. Check development workspace path relative to Cargo manifest
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let dev_path = Path::new(manifest_dir).join("../../../counterpoint-bridge");
    if dev_path.join("index.mjs").exists() {
        return Some(dev_path);
    }

    None
}

#[tauri::command]
fn start_bridge(
    app: tauri::AppHandle,
    state: State<'_, BridgeProcessState>,
    dry_run: bool,
) -> Result<String, String> {
    let mut child_guard = state.child.lock().unwrap();
    if child_guard.is_some() {
        if let Some(mut child) = child_guard.take() {
            let _ = child.kill();
        }
    }

    // Clear logs on new start
    {
        let mut logs = state.logs.lock().unwrap();
        logs.clear();
        logs.push(format!(
            "[SYSTEM] Starting sync engine (dry_run: {})...",
            dry_run
        ));
    }

    let bridge_dir = match find_bridge_directory(&app) {
        Some(dir) => dir,
        None => return Err("Could not locate counterpoint-bridge directory.".into()),
    };

    // Auto-run npm install if node_modules does not exist
    let node_modules_dir = bridge_dir.join("node_modules");
    if !node_modules_dir.exists() {
        {
            let mut logs = state.logs.lock().unwrap();
            logs.push("[SYSTEM] node_modules folder not found. Installing node dependencies in the background...".into());
        }

        let mut install_cmd = if cfg!(target_os = "windows") {
            let mut cmd = Command::new("cmd");
            cmd.args(&["/C", "npm install"]);
            cmd
        } else {
            let mut cmd = Command::new("npm");
            cmd.arg("install");
            cmd
        };

        install_cmd.current_dir(&bridge_dir);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            install_cmd.creation_flags(CREATE_NO_WINDOW);
        }

        match install_cmd.output() {
            Ok(output) => {
                let mut logs = state.logs.lock().unwrap();
                if output.status.success() {
                    logs.push("[SYSTEM] Dependencies installed successfully.".into());
                } else {
                    let err_msg = String::from_utf8_lossy(&output.stderr);
                    logs.push(format!("[SYSTEM ERROR] 'npm install' failed: {}", err_msg));
                    return Err(format!("Failed to install dependencies: {}", err_msg));
                }
            }
            Err(e) => {
                let mut logs = state.logs.lock().unwrap();
                logs.push(format!("[SYSTEM ERROR] Failed to run 'npm install'. Please ensure Node.js is installed. Error: {}", e));
                return Err(format!("Could not run 'npm install': {}", e));
            }
        }
    }

    let mut cmd = Command::new("node");
    cmd.arg("index.mjs");
    if dry_run {
        cmd.arg("--dry-run");
    }
    cmd.current_dir(&bridge_dir);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Suppress Command Prompt window on Windows release builds
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.spawn() {
        Ok(mut child) => {
            let stdout = child.stdout.take().expect("Failed to capture stdout");
            let stderr = child.stderr.take().expect("Failed to capture stderr");

            let logs_clone1 = Arc::clone(&state.logs);
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    if let Ok(line_str) = line {
                        let mut logs = logs_clone1.lock().unwrap();
                        if logs.len() > 1000 {
                            logs.remove(0);
                        }
                        logs.push(line_str);
                    }
                }
            });

            let logs_clone2 = Arc::clone(&state.logs);
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(line_str) = line {
                        let mut logs = logs_clone2.lock().unwrap();
                        if logs.len() > 1000 {
                            logs.remove(0);
                        }
                        logs.push(format!("[ERROR] {}", line_str));
                    }
                }
            });

            *child_guard = Some(child);
            Ok(format!("Started Bridge in {:?}", bridge_dir))
        }
        Err(e) => {
            let mut logs = state.logs.lock().unwrap();
            logs.push(format!(
                "[SYSTEM ERROR] Failed to start Node process: {}",
                e
            ));
            Err(format!("Failed to start Node process: {}", e))
        }
    }
}

#[tauri::command]
fn stop_bridge(state: State<'_, BridgeProcessState>) -> Result<String, String> {
    let mut child_guard = state.child.lock().unwrap();
    if let Some(mut child) = child_guard.take() {
        match child.kill() {
            Ok(_) => {
                let mut logs = state.logs.lock().unwrap();
                logs.push("[SYSTEM] Stopped bridge process manually.".into());
                Ok("Stopped bridge process".into())
            }
            Err(e) => Err(format!("Failed to stop process: {}", e)),
        }
    } else {
        Ok("Bridge was not running".into())
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct BridgeSettings {
    sql_conn: String,
    ros_url: String,
    sync_token: String,
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<BridgeSettings, String> {
    let bridge_dir = match find_bridge_directory(&app) {
        Some(dir) => dir,
        None => return Err("Could not locate counterpoint-bridge directory.".into()),
    };

    let env_path = bridge_dir.join(".env");
    if !env_path.exists() {
        return Ok(BridgeSettings {
            sql_conn: "".into(),
            ros_url: "".into(),
            sync_token: "".into(),
        });
    }

    let content = std::fs::read_to_string(env_path).map_err(|e| e.to_string())?;
    let mut sql_conn = String::new();
    let mut ros_url = String::new();
    let mut sync_token = String::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        if let Some(pos) = trimmed.find('=') {
            let key = trimmed[..pos].trim();
            let value = trimmed[pos + 1..].trim();
            match key {
                "SQL_CONNECTION_STRING" => sql_conn = strip_quotes(value),
                "ROS_BASE_URL" => ros_url = strip_quotes(value),
                "COUNTERPOINT_SYNC_TOKEN" => sync_token = strip_quotes(value),
                _ => {}
            }
        }
    }

    Ok(BridgeSettings {
        sql_conn,
        ros_url,
        sync_token,
    })
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    sql_conn: String,
    ros_url: String,
    sync_token: String,
) -> Result<String, String> {
    let bridge_dir = match find_bridge_directory(&app) {
        Some(dir) => dir,
        None => return Err("Could not locate counterpoint-bridge directory.".into()),
    };

    let env_path = bridge_dir.join(".env");
    let mut content = if env_path.exists() {
        std::fs::read_to_string(&env_path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };

    let mut lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();

    // Update or insert keys
    let keys = vec![
        ("SQL_CONNECTION_STRING", &sql_conn),
        ("ROS_BASE_URL", &ros_url),
        ("COUNTERPOINT_SYNC_TOKEN", &sync_token),
    ];

    for (k, v) in keys {
        let mut found = false;
        for line in &mut lines {
            let trimmed = line.trim();
            if trimmed.starts_with(k) && trimmed.contains('=') {
                if let Some(pos) = trimmed.find('=') {
                    if trimmed[..pos].trim() == k {
                        *line = format!("{}={}", k, v);
                        found = true;
                        break;
                    }
                }
            }
        }
        if !found {
            lines.push(format!("{}={}", k, v));
        }
    }

    content = lines.join("\n");
    std::fs::write(env_path, content).map_err(|e| e.to_string())?;

    Ok("Settings successfully saved to .env file.".into())
}

#[tauri::command]
fn get_bridge_directory(app: tauri::AppHandle) -> Result<String, String> {
    match find_bridge_directory(&app) {
        Some(dir) => Ok(dir.to_string_lossy().to_string()),
        None => Err("Not found".into()),
    }
}

#[derive(serde::Serialize)]
struct EngineStatus {
    is_running: bool,
    exit_code: Option<i32>,
    rust_logs: Vec<String>,
}

#[tauri::command]
fn get_engine_status(state: State<'_, BridgeProcessState>) -> EngineStatus {
    let mut child_guard = state.child.lock().unwrap();
    let mut is_running = false;
    let mut exit_code = None;

    if let Some(ref mut child) = *child_guard {
        match child.try_wait() {
            Ok(None) => {
                is_running = true;
            }
            Ok(Some(status)) => {
                is_running = false;
                exit_code = status.code();
            }
            Err(_) => {
                is_running = false;
            }
        }
    }

    let rust_logs = state.logs.lock().unwrap().clone();

    EngineStatus {
        is_running,
        exit_code,
        rust_logs,
    }
}

#[tauri::command]
fn clear_process_logs(state: State<'_, BridgeProcessState>) {
    let mut logs = state.logs.lock().unwrap();
    logs.clear();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(BridgeProcessState {
            child: Mutex::new(None),
            logs: Arc::new(Mutex::new(Vec::new())),
        })
        .invoke_handler(tauri::generate_handler![
            start_bridge,
            stop_bridge,
            get_bridge_directory,
            load_settings,
            save_settings,
            get_engine_status,
            clear_process_logs
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<BridgeProcessState>();
                let mut child_guard = state.child.lock().unwrap();
                if let Some(mut child) = child_guard.take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
