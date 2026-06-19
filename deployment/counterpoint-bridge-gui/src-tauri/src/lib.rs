use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{Manager, State};

mod app_updates;

const BRIDGE_RESOURCE_FILES: &[&str] = &[
    "index.mjs",
    "package.json",
    "package-lock.json",
    ".env.example",
    "env.example",
    "dashboard.html",
    "README.md",
    "INSTALL_ON_COUNTERPOINT_SERVER.txt",
    "SCHEMA_PROBE_ALIGNMENT.txt",
    "DISCOVER_SCHEMA.cmd",
    "ssms-find-your-tables.sql",
    "ssms-list-bridge-tables.sql",
];

const BRIDGE_RESOURCE_DIRS: &[&str] = &["node_modules"];

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

fn normalize_sql_connection_input(value: &str) -> String {
    let mut normalized = value.trim();
    if let Some((key, raw_value)) = normalized.split_once('=') {
        if key.trim().eq_ignore_ascii_case("SQL_CONNECTION_STRING") {
            normalized = raw_value.trim();
        }
    }
    strip_quotes(normalized)
}

fn reject_multiline_setting(name: &str, value: &str) -> Result<(), String> {
    if value.contains('\n') || value.contains('\r') {
        return Err(format!("{name} must be a single line."));
    }
    Ok(())
}

fn sql_connection_value(value: &str, aliases: &[&str]) -> Option<String> {
    let normalized_value = normalize_sql_connection_input(value);
    for part in normalized_value.split(';') {
        let trimmed = part.trim();
        let Some((key, raw_value)) = trimmed.split_once('=') else {
            continue;
        };
        let normalized_key = key
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        if aliases.iter().any(|alias| normalized_key == *alias) {
            let raw_value = raw_value.trim();
            if !raw_value.is_empty() {
                return Some(raw_value.to_string());
            }
        }
    }
    None
}

fn is_placeholder_sql_value(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.is_empty()
        || trimmed == "..."
        || trimmed.contains('<')
        || trimmed.contains('>')
        || trimmed.chars().all(|ch| ch == 'x' || ch == 'X')
}

fn normalize_sql_server_host(value: &str) -> String {
    let mut server = value.trim();
    if server.len() >= 4 && server[..4].eq_ignore_ascii_case("tcp:") {
        server = &server[4..];
    }
    if let Some((host, _port)) = server.split_once(',') {
        if !server.contains('\\') {
            return host.trim().to_string();
        }
    }
    server.to_string()
}

fn validate_sql_connection_string(value: &str) -> Result<(), String> {
    let value = normalize_sql_connection_input(value);
    let server = sql_connection_value(
        &value,
        &[
            "server",
            "data source",
            "address",
            "addr",
            "network address",
        ],
    )
    .as_deref()
    .map(normalize_sql_server_host)
    .unwrap_or_default();
    if is_placeholder_sql_value(&server) {
        return Err("Counterpoint SQL connection must include a real SQL Server host, for example Server=RMSSVR;Database=COUNTERPOINT;User Id=...;Password=...;TrustServerCertificate=True.".into());
    }

    let database =
        sql_connection_value(&value, &["database", "initial catalog"]).unwrap_or_default();
    if is_placeholder_sql_value(&database) {
        return Err("Counterpoint SQL connection must include the real company database, for example Database=COUNTERPOINT or Initial Catalog=COUNTERPOINT.".into());
    }

    let uses_windows_auth = value.split(';').any(|part| {
        let Some((key, raw_value)) = part.trim().split_once('=') else {
            return false;
        };
        let key = key
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        let raw_value = raw_value.trim().to_ascii_lowercase();
        (key == "trusted_connection" || key == "integrated security")
            && matches!(raw_value.as_str(), "true" | "yes" | "sspi")
    });
    let has_sql_auth = sql_connection_value(&value, &["user id", "uid", "user"]).is_some()
        && sql_connection_value(&value, &["password", "pwd"]).is_some();
    if uses_windows_auth && !has_sql_auth {
        return Err("Counterpoint SQL connection uses Windows trusted authentication. The packaged Bridge requires a SQL login; save User Id and Password in the connection string.".into());
    }

    Ok(())
}

fn package_version(dir: &Path) -> Option<String> {
    let content = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("version")?.as_str().map(str::to_string)
}

fn bundled_bridge_directory(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        let candidates = [
            res_dir.join("counterpoint-bridge"),
            res_dir.join("_up_/_up_/_up_/counterpoint-bridge"),
            res_dir,
        ];

        for candidate in candidates {
            if candidate.join("index.mjs").exists() {
                return Some(candidate);
            }
        }
    }

    None
}

fn app_data_bridge_directory(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("counterpoint-bridge"))
}

fn settings_bridge_directory(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let dev_path = Path::new(manifest_dir).join("../../../counterpoint-bridge");
        if dev_path.join("index.mjs").exists() {
            return Ok(dev_path);
        }
    }

    app_data_bridge_directory(app_handle)
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|e| e.to_string())?;

    for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry.file_type().map_err(|e| e.to_string())?;

        if file_type.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else if file_type.is_file() {
            if let Some(parent) = target_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&source_path, &target_path).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

fn copy_bridge_resources(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|e| e.to_string())?;

    for file in BRIDGE_RESOURCE_FILES {
        let source_path = source.join(file);
        if !source_path.exists() {
            continue;
        }

        let target_path = target.join(file);
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&source_path, &target_path).map_err(|e| e.to_string())?;
    }

    for dir in BRIDGE_RESOURCE_DIRS {
        let source_path = source.join(dir);
        if !source_path.exists() {
            continue;
        }

        copy_dir_recursive(&source_path, &target.join(dir))?;
    }

    Ok(())
}

fn file_contents_differ(source: &Path, target: &Path) -> bool {
    if !target.exists() {
        return true;
    }

    match (std::fs::read(source), std::fs::read(target)) {
        (Ok(source_bytes), Ok(target_bytes)) => source_bytes != target_bytes,
        _ => true,
    }
}

fn ensure_packaged_bridge_directory(
    app_handle: &tauri::AppHandle,
) -> Result<Option<PathBuf>, String> {
    let Some(source_dir) = bundled_bridge_directory(app_handle) else {
        return Ok(None);
    };

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let target_dir = app_data_dir.join("counterpoint-bridge");
    let source_version = package_version(&source_dir);
    let target_version = package_version(&target_dir);
    let version_changed = source_version.is_some() && source_version != target_version;
    let stale_files = BRIDGE_RESOURCE_FILES.iter().any(|file| {
        let source_path = source_dir.join(file);
        source_path.exists() && file_contents_differ(&source_path, &target_dir.join(file))
    });
    let missing_dirs = BRIDGE_RESOURCE_DIRS
        .iter()
        .any(|dir| source_dir.join(dir).exists() && !target_dir.join(dir).exists());
    let dependency_manifest_changed = ["package.json", "package-lock.json"].iter().any(|file| {
        let source_path = source_dir.join(file);
        source_path.exists() && file_contents_differ(&source_path, &target_dir.join(file))
    });

    if !target_dir.join("index.mjs").exists() || version_changed || stale_files || missing_dirs {
        if version_changed || dependency_manifest_changed {
            for dir in BRIDGE_RESOURCE_DIRS {
                let target_path = target_dir.join(dir);
                if target_path.exists() {
                    std::fs::remove_dir_all(target_path).map_err(|e| e.to_string())?;
                }
            }
        }
        copy_bridge_resources(&source_dir, &target_dir)?;
    }

    Ok(Some(target_dir))
}

fn bundled_node_executable(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };
    let res_dir = app_handle.path().resource_dir().ok()?;
    let candidates = [
        res_dir.join("bridge-runtime").join(exe_name),
        res_dir
            .join("src-tauri")
            .join("bridge-runtime")
            .join(exe_name),
        res_dir
            .join("_up_/_up_/_up_/deployment/counterpoint-bridge-gui/src-tauri/bridge-runtime")
            .join(exe_name),
    ];

    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn node_command(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = bundled_node_executable(app_handle) {
        return Ok(path);
    }

    if cfg!(debug_assertions) {
        return Ok(PathBuf::from("node"));
    }

    Err(
        "Packaged Node runtime is missing. Reinstall or update Riverside Countersync Bridge GUI."
            .to_string(),
    )
}

fn install_dev_dependencies(bridge_dir: &Path) -> Result<(), String> {
    let mut install_cmd = if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "npm install"]);
        cmd
    } else {
        let mut cmd = Command::new("npm");
        cmd.arg("install");
        cmd
    };

    install_cmd.current_dir(bridge_dir);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        install_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match install_cmd.output() {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => Err(format!(
            "Failed to install dependencies: {}",
            String::from_utf8_lossy(&output.stderr)
        )),
        Err(e) => Err(format!("Could not run 'npm install': {e}")),
    }
}

fn find_bridge_directory(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = ensure_packaged_bridge_directory(app_handle)? {
        return Ok(dir);
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let path = exe_dir.join("counterpoint-bridge");
            if path.join("index.mjs").exists() {
                return Ok(path);
            }
            let parent_path = exe_dir.join("../counterpoint-bridge");
            if parent_path.join("index.mjs").exists() {
                return Ok(parent_path);
            }
            let grandparent_path = exe_dir.join("../../counterpoint-bridge");
            if grandparent_path.join("index.mjs").exists() {
                return Ok(grandparent_path);
            }
        }
    }

    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let dev_path = Path::new(manifest_dir).join("../../../counterpoint-bridge");
    if dev_path.join("index.mjs").exists() {
        return Ok(dev_path);
    }

    Err("Could not locate counterpoint-bridge directory.".into())
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
            "[SYSTEM] Starting sync engine (dry_run: {dry_run})..."
        ));
    }

    let bridge_dir = find_bridge_directory(&app)?;
    let settings = load_settings(app.clone())?;
    let normalized_sql_conn = normalize_sql_connection_input(&settings.sql_conn);
    let sql_conn = normalized_sql_conn.trim();
    if sql_conn.is_empty() {
        let message = "Counterpoint SQL connection string is missing. Open Main Hub Connection, enter the SQL Server connection string, and Save Configuration.".to_string();
        let mut logs = state.logs.lock().unwrap();
        logs.push(format!("[SYSTEM ERROR] {message}"));
        return Err(message);
    }
    reject_multiline_setting("Counterpoint SQL connection string", sql_conn)?;
    validate_sql_connection_string(sql_conn)?;

    let ros_url = settings.ros_url.trim();
    if ros_url.is_empty() {
        let message = "Main Hub ROS URL is missing. Open Main Hub Connection, enter the Main Hub ROS URL, and Save Configuration.".to_string();
        let mut logs = state.logs.lock().unwrap();
        logs.push(format!("[SYSTEM ERROR] {message}"));
        return Err(message);
    }
    reject_multiline_setting("Main Hub ROS URL", ros_url)?;

    let node_modules_dir = bridge_dir.join("node_modules");
    if !node_modules_dir.exists() {
        if cfg!(debug_assertions) {
            {
                let mut logs = state.logs.lock().unwrap();
                logs.push(
                    "[SYSTEM] Development bridge dependencies missing. Running npm install..."
                        .into(),
                );
            }
            install_dev_dependencies(&bridge_dir)?;
        } else {
            let message = "Packaged bridge dependencies are missing. Reinstall or update Riverside Countersync Bridge GUI.".to_string();
            let mut logs = state.logs.lock().unwrap();
            logs.push(format!("[SYSTEM ERROR] {message}"));
            return Err(message);
        }
    }

    let node_path = node_command(&app)?;
    let mut cmd = Command::new(&node_path);
    cmd.arg("index.mjs");
    if dry_run {
        cmd.arg("--dry-run");
    }
    cmd.env("COUNTERPOINT_BRIDGE_TARGET_MODE", "ros_import_first");
    cmd.env("SQL_CONNECTION_STRING", sql_conn);
    cmd.env("ROS_BASE_URL", ros_url);
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
                for line_str in reader.lines().map_while(Result::ok) {
                    let mut logs = logs_clone1.lock().unwrap();
                    if logs.len() > 1000 {
                        logs.remove(0);
                    }
                    logs.push(line_str);
                }
            });

            let logs_clone2 = Arc::clone(&state.logs);
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line_str in reader.lines().map_while(Result::ok) {
                    let mut logs = logs_clone2.lock().unwrap();
                    if logs.len() > 1000 {
                        logs.remove(0);
                    }
                    logs.push(format!("[ERROR] {line_str}"));
                }
            });

            *child_guard = Some(child);
            Ok(format!(
                "Started Bridge in {bridge_dir:?} with Node runtime {node_path:?}"
            ))
        }
        Err(e) => {
            let mut logs = state.logs.lock().unwrap();
            logs.push(format!("[SYSTEM ERROR] Failed to start Node process: {e}"));
            Err(format!("Failed to start Node process: {e}"))
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
            Err(e) => Err(format!("Failed to stop process: {e}")),
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
    sync_workbench_url: String,
    sync_workbench_token: String,
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<BridgeSettings, String> {
    let bridge_dir = settings_bridge_directory(&app)?;

    let env_path = bridge_dir.join(".env");
    if !env_path.exists() {
        return Ok(BridgeSettings {
            sql_conn: "".into(),
            ros_url: "".into(),
            sync_token: "".into(),
            sync_workbench_url: "".into(),
            sync_workbench_token: "".into(),
        });
    }

    let content = std::fs::read_to_string(env_path).map_err(|e| e.to_string())?;
    let mut sql_conn = String::new();
    let mut ros_url = String::new();
    let mut sync_token = String::new();
    let mut sync_workbench_url = String::new();
    let mut sync_workbench_token = String::new();

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
                "COUNTERPOINT_SYNC_WORKBENCH_URL" => sync_workbench_url = strip_quotes(value),
                "COUNTERPOINT_SYNC_WORKBENCH_TOKEN" => sync_workbench_token = strip_quotes(value),
                _ => {}
            }
        }
    }

    Ok(BridgeSettings {
        sql_conn,
        ros_url,
        sync_token,
        sync_workbench_url,
        sync_workbench_token,
    })
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    sql_conn: String,
    ros_url: String,
    sync_token: String,
    sync_workbench_url: String,
    sync_workbench_token: String,
) -> Result<String, String> {
    let _ = sync_token;
    let _ = sync_workbench_url;
    let _ = sync_workbench_token;
    let bridge_dir = settings_bridge_directory(&app)?;
    std::fs::create_dir_all(&bridge_dir).map_err(|e| e.to_string())?;
    let normalized_sql_conn = normalize_sql_connection_input(&sql_conn);
    let sql_conn = normalized_sql_conn.trim();
    let ros_url = ros_url.trim();
    reject_multiline_setting("Counterpoint SQL connection string", sql_conn)?;
    reject_multiline_setting("Main Hub ROS URL", ros_url)?;
    if sql_conn.is_empty() {
        return Err("Counterpoint SQL connection string is required.".into());
    }
    validate_sql_connection_string(sql_conn)?;
    if ros_url.is_empty() {
        return Err("Main Hub ROS URL is required.".into());
    }

    let env_path = bridge_dir.join(".env");
    let content = [
        format!("SQL_CONNECTION_STRING={sql_conn}"),
        "COUNTERPOINT_BRIDGE_TARGET_MODE=ros_import_first".to_string(),
        format!("ROS_BASE_URL={ros_url}"),
    ]
    .join("\n");
    std::fs::write(env_path, content).map_err(|e| e.to_string())?;

    Ok("Bridge connection settings saved for Main Hub ROS intake.".into())
}

#[tauri::command]
fn get_bridge_directory(app: tauri::AppHandle) -> Result<String, String> {
    find_bridge_directory(&app).map(|dir| dir.to_string_lossy().to_string())
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(BridgeProcessState {
            child: Mutex::new(None),
            logs: Arc::new(Mutex::new(Vec::new())),
        })
        .invoke_handler(tauri::generate_handler![
            app_updates::check_app_update,
            app_updates::install_app_update,
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
