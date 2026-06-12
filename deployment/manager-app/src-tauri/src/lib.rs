use serde::{Deserialize, Serialize};
use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

mod app_updates;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
fn suppress_child_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_child_console(_command: &mut Command) {}

#[derive(Serialize, Deserialize, Clone)]
struct LogMessage {
    level: String,
    text: String,
}

fn get_package_root() -> PathBuf {
    let mut path = env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    path.pop();

    if path.join("install-server.ps1").exists() {
        return path;
    }

    let dev_path = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if dev_path.join("install-server.ps1").exists() {
        return dev_path;
    }
    if dev_path.join("windows").join("install-server.ps1").exists() {
        return dev_path.join("windows");
    }
    if dev_path
        .file_name()
        .is_some_and(|name| name == "manager-app")
    {
        let windows_dir = dev_path.parent().unwrap_or(&dev_path).join("windows");
        if windows_dir.join("install-server.ps1").exists() {
            return windows_dir;
        }
    }

    path
}

fn get_deployment_manager_log_path() -> PathBuf {
    get_package_root().join("deployment-manager.log")
}

fn log_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("epoch:{seconds}")
}

fn append_persistent_log(log_path: &PathBuf, level: &str, text: &str) {
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(
            file,
            "[{}] [{}] {}",
            log_timestamp(),
            level.to_uppercase(),
            text
        );
    }
}

fn emit_deployment_log(app: &AppHandle, log_path: &PathBuf, level: &str, text: impl Into<String>) {
    let text = text.into();
    append_persistent_log(log_path, level, &text);
    let _ = app.emit(
        "deployment-log",
        LogMessage {
            level: level.to_string(),
            text,
        },
    );
}

fn format_script_args_for_log(args: Option<&Vec<String>>) -> String {
    let Some(values) = args else {
        return "(none)".to_string();
    };
    if values.is_empty() {
        return "(none)".to_string();
    }

    let sensitive_flags = ["-token", "-password", "-adminpassword", "-apppassword"];
    let mut redact_next = false;
    values
        .iter()
        .map(|value| {
            if redact_next {
                redact_next = false;
                return "[redacted]".to_string();
            }

            if sensitive_flags.contains(&value.to_ascii_lowercase().as_str()) {
                redact_next = true;
            }
            value.clone()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn get_config_path() -> PathBuf {
    get_package_root().join("riverside-deployment.config.json")
}

fn config_path_arg() -> String {
    "-ConfigPath".to_string()
}

fn config_path_value() -> String {
    get_config_path().to_string_lossy().into_owned()
}

fn script_supports_config_path(script_name: &str) -> bool {
    !matches!(script_name, "audit-system.ps1" | "Install-RosieAiStack.ps1")
}

#[tauri::command]
fn get_deployment_paths() -> Result<serde_json::Value, String> {
    let package_root = get_package_root();
    let config_path = get_config_path();
    Ok(serde_json::json!({
        "packageRoot": package_root.to_string_lossy(),
        "configPath": config_path.to_string_lossy(),
        "configExists": config_path.exists(),
    }))
}

#[tauri::command]
async fn read_deployment_config() -> Result<String, String> {
    let path = get_config_path();
    if !path.exists() {
        // Auto-create from example config if available (mirrors Start-RiversideDeployment.ps1 behaviour).
        let example_path = get_package_root().join("riverside-deployment.config.example.json");
        if example_path.exists() {
            let example_content = tokio::fs::read_to_string(&example_path)
                .await
                .map_err(|e| format!("Failed to read example config: {e}"))?;
            if let Some(parent) = path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            tokio::fs::write(&path, &example_content)
                .await
                .map_err(|e| format!("Failed to create config from example: {e}"))?;
            return Ok(example_content);
        }
        return Ok("{}".to_string());
    }
    tokio::fs::read_to_string(path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_deployment_config(config: String) -> Result<(), String> {
    let path = get_config_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::fs::write(path, config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_deployment_script(
    app: AppHandle,
    script_name: String,
    args: Option<Vec<String>>,
) -> Result<(), String> {
    let package_root = get_package_root();
    let log_path = get_deployment_manager_log_path();
    let script_path = package_root.join(&script_name);

    if !script_path.exists() {
        return Err(format!(
            "Script not found: {} (package root: {})",
            script_path.display(),
            package_root.display()
        ));
    }

    let args_display = format_script_args_for_log(args.as_ref());
    emit_deployment_log(
        &app,
        &log_path,
        "info",
        format!(
            "Launching {} from {}",
            script_path.display(),
            package_root.display()
        ),
    );
    emit_deployment_log(
        &app,
        &log_path,
        "info",
        format!("Arguments: {args_display}"),
    );
    emit_deployment_log(
        &app,
        &log_path,
        "info",
        format!("Persistent log: {}", log_path.display()),
    );

    let mut cmd = Command::new("powershell");
    cmd.current_dir(&package_root)
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(script_path.as_os_str());

    if script_supports_config_path(&script_name) {
        cmd.arg(config_path_arg()).arg(config_path_value());
    }

    if let Some(arguments) = args {
        for arg in arguments {
            cmd.arg(arg);
        }
    }

    suppress_child_console(&mut cmd);
    let mut child = match cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let message = format!("Failed to spawn powershell: {error}");
            emit_deployment_log(&app, &log_path, "error", &message);
            return Err(message);
        }
    };

    emit_deployment_log(
        &app,
        &log_path,
        "info",
        "PowerShell process started; waiting for script output...",
    );

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let app_clone = app.clone();
    let stdout_log_path = log_path.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            emit_deployment_log(&app_clone, &stdout_log_path, "info", line);
        }
    });

    let app_clone = app.clone();
    let stderr_log_path = log_path.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            emit_deployment_log(&app_clone, &stderr_log_path, "error", line);
        }
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait: {e}"))?;

    emit_deployment_log(
        &app,
        &log_path,
        if status.success() { "success" } else { "error" },
        format!("Script exited with status: {status}"),
    );

    if status.success() {
        Ok(())
    } else {
        Err(format!("Script exited with {status}"))
    }
}

#[tauri::command]
async fn run_inline_powershell(app: AppHandle, script_content: String) -> Result<(), String> {
    if !is_elevated() {
        return Err(
            "Administrator privileges are required for server control commands. \
             Close this app and launch Start-RiversideDeployment.cmd (Run as administrator)."
                .to_string(),
        );
    }

    let log_path = get_deployment_manager_log_path();
    let mut cmd = Command::new("powershell");
    cmd.arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(&script_content)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    suppress_child_console(&mut cmd);
    emit_deployment_log(
        &app,
        &log_path,
        "info",
        format!("Persistent log: {}", log_path.display()),
    );
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!("Failed to spawn powershell: {error}");
            emit_deployment_log(&app, &log_path, "error", &message);
            return Err(message);
        }
    };

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let app_clone = app.clone();
    let stdout_log_path = log_path.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            emit_deployment_log(&app_clone, &stdout_log_path, "info", line);
        }
    });

    let app_clone = app.clone();
    let stderr_log_path = log_path.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            emit_deployment_log(&app_clone, &stderr_log_path, "error", line);
        }
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait: {e}"))?;

    emit_deployment_log(
        &app,
        &log_path,
        if status.success() { "success" } else { "error" },
        format!("Command exited with status: {status}"),
    );

    if status.success() {
        Ok(())
    } else {
        Err(format!("Exited with {status}"))
    }
}

#[tauri::command]
fn is_elevated() -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("net")
            .arg("session")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        true
    }
}

#[tauri::command]
fn relaunch_elevated() -> Result<(), String> {
    #[cfg(windows)]
    {
        let exe = env::current_exe().map_err(|e| e.to_string())?;
        let exe_arg = format!("'{}'", exe.to_string_lossy().replace('\'', "''"));
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &format!("Start-Process -FilePath {exe_arg} -Verb RunAs"),
            ])
            .spawn()
            .map_err(|e| e.to_string())?;
        std::process::exit(0);
    }
    #[cfg(not(windows))]
    {
        Err("Elevation relaunch is only supported on Windows.".to_string())
    }
}

#[tauri::command]
async fn open_logs() -> Result<(), String> {
    let config_path = get_config_path();
    let log_dir = if config_path.exists() {
        let raw = tokio::fs::read_to_string(&config_path)
            .await
            .map_err(|e| e.to_string())?;
        let install_root = serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|value| {
                value
                    .get("server")
                    .and_then(|server| server.get("installRoot"))
                    .and_then(|root| root.as_str())
                    .map(str::to_string)
            })
            .filter(|root| !root.trim().is_empty())
            .unwrap_or_else(|| "C:\\RiversideOS".to_string());
        PathBuf::from(install_root).join("logs")
    } else {
        PathBuf::from("C:\\RiversideOS\\logs")
    };

    tokio::fs::create_dir_all(&log_dir)
        .await
        .map_err(|e| e.to_string())?;
    Command::new("explorer")
        .arg(log_dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_deployment_log() -> Result<(), String> {
    let log_path = get_deployment_manager_log_path();
    if !log_path.exists() {
        append_persistent_log(&log_path, "info", "Deployment Manager log file created.");
    }

    Command::new("explorer")
        .arg(format!("/select,{}", log_path.to_string_lossy()))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Probe PostgreSQL: Windows service state, psql connectivity, version, DB size.
/// Returns a JSON object consumable by the frontend status panel.
#[tauri::command]
async fn get_postgres_status() -> Result<serde_json::Value, String> {
    let config_path = get_config_path();
    let (db_host, db_port, db_name, db_user, db_password, app_user, app_password, psql_hint) =
        if config_path.exists() {
            let raw = tokio::fs::read_to_string(&config_path)
                .await
                .unwrap_or_default();
            let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
            let db = v.get("server").and_then(|s| s.get("database"));
            let host = db
                .and_then(|d| d.get("host"))
                .and_then(|v| v.as_str())
                .unwrap_or("127.0.0.1")
                .to_string();
            let port = db
                .and_then(|d| d.get("port"))
                .and_then(|v| v.as_u64())
                .unwrap_or(5432);
            let name = db
                .and_then(|d| d.get("databaseName"))
                .and_then(|v| v.as_str())
                .unwrap_or("riverside_os")
                .to_string();
            let user = db
                .and_then(|d| d.get("adminUser"))
                .and_then(|v| v.as_str())
                .unwrap_or("postgres")
                .to_string();
            let password = db
                .and_then(|d| d.get("adminPassword"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let app_user = db
                .and_then(|d| d.get("appUser"))
                .and_then(|v| v.as_str())
                .unwrap_or("riverside_app")
                .to_string();
            let app_password = db
                .and_then(|d| d.get("appPassword"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let psql = db
                .and_then(|d| d.get("psqlPath"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            (
                host,
                port,
                name,
                user,
                password,
                app_user,
                app_password,
                psql,
            )
        } else {
            (
                "127.0.0.1".into(),
                5432,
                "riverside_os".into(),
                "postgres".into(),
                String::new(),
                "riverside_app".into(),
                String::new(),
                String::new(),
            )
        };

    // Build a single PowerShell script that outputs JSON.
    let ps_script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
$out = @{{ service_status = 'not_found'; service_name = ''; connectable = $false; version = ''; db_exists = $false; db_size = ''; auth_status = 'unknown'; auth_message = '' }}

# 1. Windows service status
$svc = Get-Service | Where-Object {{ $_.Name -like 'postgresql*' -or $_.DisplayName -like 'PostgreSQL*' }} | Sort-Object Name -Descending | Select-Object -First 1
if ($svc) {{
    $out.service_name = $svc.Name
    $out.service_status = $svc.Status.ToString().ToLower()
}}

# 2. Resolve psql path
$psqlPath = '{psql_hint}'
if (-not $psqlPath -or -not (Test-Path $psqlPath)) {{
    $psqlCmd = Get-Command psql.exe -ErrorAction SilentlyContinue
    if ($psqlCmd) {{
        $psqlPath = $psqlCmd.Source
    }} else {{
        $found = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) {{ $psqlPath = $found.FullName }}
    }}
}}
$out['psql_found'] = [bool]($psqlPath -and (Test-Path $psqlPath))

# 3. Connectivity + version
if ($out['psql_found']) {{
    $connectionUser = '{user}'
    $connectionDb = 'postgres'
    $env:PGPASSWORD = '{password}'
    $verResult = & $psqlPath '-h' '{host}' '-p' '{port}' '-U' $connectionUser '-d' $connectionDb '-w' '-tAc' 'SELECT version();' 2>&1
    if ($LASTEXITCODE -ne 0 -and -not [string]::IsNullOrWhiteSpace('{app_password}')) {{
        $connectionUser = '{app_user}'
        $connectionDb = '{db_name}'
        $env:PGPASSWORD = '{app_password}'
        $verResult = & $psqlPath '-h' '{host}' '-p' '{port}' '-U' $connectionUser '-d' $connectionDb '-w' '-tAc' 'SELECT version();' 2>&1
    }}
    if ($LASTEXITCODE -eq 0 -and $verResult) {{
        $out.connectable = $true
        $out.auth_status = 'ok'
        $out.auth_message = 'Database credentials verified.'
        $out.version = ($verResult -join '').Trim()
    }} else {{
        $out.auth_status = 'failed'
        $out.auth_message = 'PostgreSQL is running, but saved deployment credentials are missing or invalid.'
    }}
 
    # 4. DB existence + size
    if ($out.connectable) {{
        if ($connectionDb -eq '{db_name}') {{
            $out.db_exists = $true
        }} else {{
            $existsResult = & $psqlPath '-h' '{host}' '-p' '{port}' '-U' $connectionUser '-d' 'postgres' '-w' '-tAc' "SELECT 1 FROM pg_database WHERE datname = '{db_name}';" 2>&1
            $out.db_exists = (($existsResult -join '').Trim() -eq '1')
        }}
        if ($out.db_exists) {{
            $sizeResult = & $psqlPath '-h' '{host}' '-p' '{port}' '-U' $connectionUser '-d' '{db_name}' '-w' '-tAc' "SELECT pg_size_pretty(pg_database_size(current_database()));" 2>&1
            if ($LASTEXITCODE -eq 0) {{ $out.db_size = ($sizeResult -join '').Trim() }}
            $migResult = & $psqlPath '-h' '{host}' '-p' '{port}' '-U' $connectionUser '-d' '{db_name}' '-w' '-tAc' "SELECT count(*) FROM _sqlx_migrations;" 2>&1
            if ($LASTEXITCODE -eq 0) {{ $out['migration_count'] = ($migResult -join '').Trim() }}
            $tableResult = & $psqlPath '-h' '{host}' '-p' '{port}' '-U' $connectionUser '-d' '{db_name}' '-w' '-tAc' "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>&1
            if ($LASTEXITCODE -eq 0) {{ $out['table_count'] = ($tableResult -join '').Trim() }}
        }}
    }}
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}}

$out | ConvertTo-Json -Compress
"#,
        psql_hint = psql_hint.replace('\'', "''"),
        password = db_password.replace('\'', "''"),
        app_user = app_user.replace('\'', "''"),
        app_password = app_password.replace('\'', "''"),
        host = db_host,
        port = db_port,
        user = db_user,
        db_name = db_name,
    );

    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"])
        .arg(&ps_script);
    suppress_child_console(&mut cmd);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run postgres status probe: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap_or_else(|_| {
        serde_json::json!({
            "service_status": "probe_error",
            "connectable": false,
            "raw_output": stdout.trim(),
        })
    });

    Ok(parsed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            app_updates::check_app_update,
            app_updates::install_app_update,
            get_deployment_paths,
            read_deployment_config,
            write_deployment_config,
            run_deployment_script,
            run_inline_powershell,
            open_logs,
            open_deployment_log,
            is_elevated,
            relaunch_elevated,
            get_postgres_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
