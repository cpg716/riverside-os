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

fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
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
        .is_some_and(|name| name == "server-manager-app")
    {
        let windows_dir = dev_path.parent().unwrap_or(&dev_path).join("windows");
        if windows_dir.join("install-server.ps1").exists() {
            return windows_dir;
        }
    }

    path
}

fn get_config_path() -> PathBuf {
    get_package_root().join("riverside-deployment.config.json")
}

fn get_server_install_root() -> PathBuf {
    let config_path = get_config_path();
    if let Ok(raw) = std::fs::read_to_string(config_path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(root) = value
                .get("server")
                .and_then(|server| server.get("installRoot"))
                .and_then(|root| root.as_str())
                .filter(|root| !root.trim().is_empty())
            {
                return PathBuf::from(root);
            }
        }
    }

    PathBuf::from("C:\\RiversideOS")
}

fn get_server_manager_log_path() -> PathBuf {
    get_server_install_root()
        .join("logs")
        .join("server-manager.log")
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

fn emit_server_manager_log(
    app: &AppHandle,
    log_path: &PathBuf,
    level: &str,
    text: impl Into<String>,
) {
    let text = text.into();
    append_persistent_log(log_path, level, &text);
    let _ = app.emit(
        "server-manager-log",
        LogMessage {
            level: level.to_string(),
            text,
        },
    );
}

fn script_supports_config_path(script_name: &str) -> bool {
    !matches!(script_name, "audit-system.ps1" | "Install-RosieAiStack.ps1")
}

#[tauri::command]
fn get_manager_paths() -> Result<serde_json::Value, String> {
    let package_root = get_package_root();
    let config_path = get_config_path();
    Ok(serde_json::json!({
        "packageRoot": package_root.to_string_lossy(),
        "configPath": config_path.to_string_lossy(),
        "configExists": config_path.exists(),
    }))
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
        let exe_arg = ps_quote(&exe.to_string_lossy());
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

async fn run_powershell_capture(script: &str) -> Result<String, String> {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"])
        .arg(script);
    suppress_child_console(&mut cmd);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to spawn powershell: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "PowerShell exited with {}: {}",
            output.status, stderr
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
async fn get_server_snapshot() -> Result<serde_json::Value, String> {
    let config_path = ps_quote(&get_config_path().to_string_lossy());
    let package_root = ps_quote(&get_package_root().to_string_lossy());
    let script = SERVER_SNAPSHOT_PS
        .replace("__CONFIG_PATH__", &config_path)
        .replace("__PACKAGE_ROOT__", &package_root);
    let stdout = run_powershell_capture(&script).await?;

    serde_json::from_str(stdout.trim()).map_err(|e| {
        format!(
            "Could not parse server snapshot JSON: {e}. Raw output: {}",
            stdout.trim()
        )
    })
}

async fn run_script(app: AppHandle, script_name: &str, args: &[&str]) -> Result<(), String> {
    let package_root = get_package_root();
    let script_path = package_root.join(script_name);

    if !script_path.exists() {
        return Err(format!(
            "Script not found: {} (package root: {})",
            script_path.display(),
            package_root.display()
        ));
    }

    let mut cmd = Command::new("powershell");
    cmd.current_dir(&package_root)
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(script_path.as_os_str());

    if script_supports_config_path(script_name) {
        cmd.arg("-ConfigPath")
            .arg(get_config_path().to_string_lossy().to_string());
    }

    for arg in args {
        cmd.arg(arg);
    }

    run_command_with_logs(app, cmd).await
}

async fn run_inline(app: AppHandle, script: &str) -> Result<(), String> {
    let mut cmd = Command::new("powershell");
    cmd.current_dir(get_package_root())
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(script);
    run_command_with_logs(app, cmd).await
}

async fn run_command_with_logs(app: AppHandle, mut cmd: Command) -> Result<(), String> {
    let log_path = get_server_manager_log_path();
    emit_server_manager_log(
        &app,
        &log_path,
        "info",
        format!("Persistent log: {}", log_path.display()),
    );
    suppress_child_console(&mut cmd);
    let mut child = match cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let message = format!("Failed to spawn PowerShell: {error}");
            emit_server_manager_log(&app, &log_path, "error", &message);
            return Err(message);
        }
    };

    let stdout = child.stdout.take().ok_or("Could not read stdout")?;
    let stderr = child.stderr.take().ok_or("Could not read stderr")?;

    let app_clone = app.clone();
    let stdout_log_path = log_path.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            emit_server_manager_log(&app_clone, &stdout_log_path, "info", line);
        }
    });

    let app_clone = app.clone();
    let stderr_log_path = log_path.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            emit_server_manager_log(&app_clone, &stderr_log_path, "error", line);
        }
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed waiting on command: {e}"))?;
    let level = if status.success() { "success" } else { "error" };
    emit_server_manager_log(
        &app,
        &log_path,
        level,
        format!("Command exited with status: {status}"),
    );

    if status.success() {
        Ok(())
    } else {
        Err(format!("Command exited with {status}"))
    }
}

#[tauri::command]
async fn run_server_action(app: AppHandle, action_id: String) -> Result<(), String> {
    match action_id.as_str() {
        "start_server" => run_inline(app, "Start-ScheduledTask -TaskName 'Riverside OS Server'").await,
        "stop_server" => {
            run_inline(
                app,
                "Stop-ScheduledTask -TaskName 'Riverside OS Server' -ErrorAction SilentlyContinue; Stop-Process -Name 'riverside-server' -Force -ErrorAction SilentlyContinue",
            )
            .await
        }
        "restart_server" => {
            run_inline(
                app,
                "Stop-ScheduledTask -TaskName 'Riverside OS Server' -ErrorAction SilentlyContinue; Stop-Process -Name 'riverside-server' -Force -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName 'Riverside OS Server'",
            )
            .await
        }
        "run_audit" => run_script(app, "audit-system.ps1", &[]).await,
        "apply_migrations" => run_script(app, "apply-riverside-migrations.ps1", &[]).await,
        "repair_credentials" => run_script(app, "repair-server-credentials-key.ps1", &[]).await,
        "repair_admin" => run_script(app, "repair-bootstrap-admin.ps1", &[]).await,
        "update_server" => run_script(app, "install-server.ps1", &[]).await,
        "install_rosie" => run_script(app, "Install-RosieAiStack.ps1", &[]).await,
        "start_rosie" => run_script(app, "start-riverside-llama.ps1", &[]).await,
        "reset_postgres_password" => run_script(app, "reset-postgres-password.ps1", &[]).await,
        "open_logs" => {
            run_inline(
                app,
                "$logDir = Join-Path 'C:\\RiversideOS' 'logs'; New-Item -ItemType Directory -Path $logDir -Force | Out-Null; explorer $logDir",
            )
            .await
        }
        "cleanup_logs" => {
            run_inline(
                app,
                "Get-ChildItem 'C:\\RiversideOS\\logs' -File -ErrorAction SilentlyContinue | Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) | Remove-Item -Force; Write-Host 'Removed Riverside log files older than 30 days.'",
            )
            .await
        }
        "cleanup_temp" => {
            run_inline(
                app,
                "Get-ChildItem $env:TEMP -File -Filter 'ros-*' -ErrorAction SilentlyContinue | Remove-Item -Force; Write-Host 'Removed temporary ROS installer files from the current user temp folder.'",
            )
            .await
        }
        "optimize_database" => {
            let script = OPTIMIZE_DATABASE_PS.replace(
                "__CONFIG_PATH__",
                &ps_quote(&get_config_path().to_string_lossy()),
            );
            run_inline(app, &script).await
        }
        _ => Err(format!("Unknown server action: {action_id}")),
    }
}

const OPTIMIZE_DATABASE_PS: &str = r#"
$ErrorActionPreference = 'Stop'
$configPath = __CONFIG_PATH__
$config = if (Test-Path $configPath) { Get-Content $configPath -Raw | ConvertFrom-Json } else { $null }
$db = if ($config -and $config.server -and $config.server.database) { $config.server.database } else { $null }
$hostName = if ($db -and $db.host) { "$($db.host)" } else { '127.0.0.1' }
$port = if ($db -and $db.port) { "$($db.port)" } else { '5432' }
$database = if ($db -and $db.databaseName) { "$($db.databaseName)" } else { 'riverside_os' }
$user = if ($db -and $db.adminUser) { "$($db.adminUser)" } else { 'postgres' }
$password = if ($db -and $null -ne $db.adminPassword) { "$($db.adminPassword)" } else { '' }
$psql = if ($db -and $db.psqlPath -and (Test-Path "$($db.psqlPath)")) { "$($db.psqlPath)" } else { (Get-Command psql.exe -ErrorAction Stop).Source }
$env:PGPASSWORD = $password
Write-Host "Running VACUUM ANALYZE on $database..."
& $psql -h $hostName -p $port -U $user -d $database -w -c 'VACUUM (ANALYZE);'
Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
Write-Host 'Database optimization complete.'
"#;

const SERVER_SNAPSHOT_PS: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$configPath = __CONFIG_PATH__
$packageRoot = __PACKAGE_ROOT__
$config = if (Test-Path $configPath) { Get-Content $configPath -Raw | ConvertFrom-Json } else { $null }
$installRoot = if ($config -and $config.server -and $config.server.installRoot) { "$($config.server.installRoot)" } else { 'C:\RiversideOS' }
$db = if ($config -and $config.server -and $config.server.database) { $config.server.database } else { $null }
$envConfig = if ($config -and $config.server -and $config.server.environment) { $config.server.environment } else { $null }
$httpBind = if ($config -and $config.server -and $config.server.httpBind) { "$($config.server.httpBind)" } else { '0.0.0.0:3000' }
$serverPort = (($httpBind -split ':')[-1])
$apiBase = "http://127.0.0.1:$serverPort"

function Get-DirSummary($Path) {
  if (-not (Test-Path $Path)) {
    return @{ exists = $false; file_count = 0; size_mb = 0; path = $Path }
  }
  $files = Get-ChildItem $Path -File -Recurse -ErrorAction SilentlyContinue
  $size = ($files | Measure-Object Length -Sum).Sum
  return @{ exists = $true; file_count = @($files).Count; size_mb = [math]::Round(($size / 1MB), 1); path = $Path }
}

function Test-Http($Url) {
  try {
    $res = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
    return @{ ok = $true; status = [int]$res.StatusCode; error = '' }
  } catch {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    return @{ ok = $false; status = $status; error = $_.Exception.Message }
  }
}

$issues = New-Object System.Collections.ArrayList
$out = [ordered]@{
  generated_at = (Get-Date).ToString('s')
  package_root = $packageRoot
  config_path = $configPath
  config_exists = [bool](Test-Path $configPath)
  install_root = $installRoot
  api_base = $apiBase
  elevated = $false
  server = @{}
  api = @{}
  postgres = @{}
  rosie = @{}
  storage = @{}
  maintenance = @{}
  issues = @()
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$out.elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$task = Get-ScheduledTask -TaskName 'Riverside OS Server' -ErrorAction SilentlyContinue
$serverProcesses = @(Get-Process -Name 'riverside-server' -ErrorAction SilentlyContinue)
$serverExe = Join-Path $installRoot 'server\riverside-server.exe'
$out.server = @{
  task_status = if ($task) { "$($task.State)" } else { 'missing' }
  task_present = [bool]$task
  process_count = $serverProcesses.Count
  exe_present = [bool](Test-Path $serverExe)
  exe_path = $serverExe
}
if (-not $task) { [void]$issues.Add(@{ severity = 'critical'; title = 'Server startup task is missing'; detail = 'The local Windows scheduled task for Riverside OS Server is not registered.'; action = 'update_server' }) }
if ($serverProcesses.Count -eq 0) { [void]$issues.Add(@{ severity = 'critical'; title = 'Server process is not running'; detail = 'The API cannot serve registers or Back Office if riverside-server.exe is stopped.'; action = 'start_server' }) }

# Deployment Handshake: Check deployment.status before polling API
$deploymentStatusPath = 'C:\ProgramData\RiversideOS\deployment.status'
$deploymentStatus = $null
if (Test-Path $deploymentStatusPath) {
  try {
    $deploymentStatus = Get-Content $deploymentStatusPath -Raw | ConvertFrom-Json
  } catch { }
}
$out.deployment_status = if ($deploymentStatus) { $deploymentStatus.status } else { 'unknown' }

# Only poll API if database is READY (not MIGRATING or AUTH_FAILED)
$shouldPollApi = $true
if ($deploymentStatus) {
  if ($deploymentStatus.status -eq 'MIGRATING') {
    $shouldPollApi = $false
    [void]$issues.Add(@{ severity = 'warning'; title = 'Database is migrating'; detail = 'Database migrations are in progress. API health check skipped.'; action = 'run_audit' })
  } elseif ($deploymentStatus.status -eq 'AUTH_FAILED') {
    $shouldPollApi = $false
    [void]$issues.Add(@{ severity = 'critical'; title = 'Database authentication failed'; detail = 'Database password is missing or invalid. Update server.database.adminPassword in config.'; action = 'update_server' })
  }
}

if ($shouldPollApi) {
  $health = Test-Http "$apiBase/api/health"
  $ready = Test-Http "$apiBase/api/ready"
  $live = Test-Http "$apiBase/api/live"
  $version = Test-Http "$apiBase/api/version"
  $out.api = @{ health = $health; ready = $ready; live = $live; version = $version }
  if (-not $health.ok) { [void]$issues.Add(@{ severity = 'critical'; title = 'API health is unreachable'; detail = $health.error; action = 'restart_server' }) }
  elseif (-not $ready.ok) { [void]$issues.Add(@{ severity = 'warning'; title = 'API is live but not ready'; detail = $ready.error; action = 'run_audit' }) }
} else {
  $out.api = @{ health = @{ ok = $false; status = 0; error = 'Skipped due to deployment status' }; ready = @{ ok = $false; status = 0; error = 'Skipped due to deployment status' }; live = @{ ok = $false; status = 0; error = 'Skipped due to deployment status' }; version = @{ ok = $false; status = 0; error = 'Skipped due to deployment status' } }
}

$pgSvc = Get-Service | Where-Object { $_.Name -like 'postgresql*' -or $_.DisplayName -like 'PostgreSQL*' } | Sort-Object Name -Descending | Select-Object -First 1
$psqlPath = if ($db -and $db.psqlPath) { "$($db.psqlPath)" } else { '' }
if (-not $psqlPath -or -not (Test-Path $psqlPath)) {
  $psqlCmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($psqlCmd) { $psqlPath = $psqlCmd.Source }
  else {
    $found = Get-ChildItem 'C:\Program Files\PostgreSQL' -Recurse -Filter psql.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $psqlPath = $found.FullName }
  }
}
$dbHost = if ($db -and $db.host) { "$($db.host)" } else { '127.0.0.1' }
$dbPort = if ($db -and $db.port) { "$($db.port)" } else { '5432' }
$dbName = if ($db -and $db.databaseName) { "$($db.databaseName)" } else { 'riverside_os' }
$dbUser = if ($db -and $db.adminUser) { "$($db.adminUser)" } else { 'postgres' }
$dbPassword = if ($db -and $null -ne $db.adminPassword) { "$($db.adminPassword)" } else { '' }
$pg = @{ service_name = if ($pgSvc) { $pgSvc.Name } else { '' }; service_status = if ($pgSvc) { "$($pgSvc.Status)" } else { 'missing' }; psql_found = [bool]($psqlPath -and (Test-Path $psqlPath)); connectable = $false; db_exists = $false; db_size = ''; table_count = ''; migration_count = '' }
if ($pg.psql_found) {
  $env:PGPASSWORD = $dbPassword
  $connect = & $psqlPath -h $dbHost -p $dbPort -U $dbUser -d postgres -w -tAc 'SELECT 1;' 2>&1
  $pg.connectable = ($LASTEXITCODE -eq 0 -and (($connect -join '').Trim() -eq '1'))
  if ($pg.connectable) {
    $exists = & $psqlPath -h $dbHost -p $dbPort -U $dbUser -d postgres -w -tAc "SELECT 1 FROM pg_database WHERE datname = '$dbName';" 2>&1
    $pg.db_exists = (($exists -join '').Trim() -eq '1')
    if ($pg.db_exists) {
      $pg.db_size = ((& $psqlPath -h $dbHost -p $dbPort -U $dbUser -d $dbName -w -tAc 'SELECT pg_size_pretty(pg_database_size(current_database()));' 2>&1) -join '').Trim()
      $pg.table_count = ((& $psqlPath -h $dbHost -p $dbPort -U $dbUser -d $dbName -w -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>&1) -join '').Trim()
      $pg.migration_count = ((& $psqlPath -h $dbHost -p $dbPort -U $dbUser -d $dbName -w -tAc "SELECT count(*) FROM _sqlx_migrations;" 2>&1) -join '').Trim()
    }
  }
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
$out.postgres = $pg
if (-not $pg.psql_found) { [void]$issues.Add(@{ severity = 'critical'; title = 'PostgreSQL tools are missing'; detail = 'psql.exe could not be located.'; action = 'run_audit' }) }
elseif (-not $pg.connectable) { [void]$issues.Add(@{ severity = 'critical'; title = 'PostgreSQL is not reachable'; detail = 'The local database connection failed.'; action = 'reset_postgres_password' }) }
elseif (-not $pg.db_exists) { [void]$issues.Add(@{ severity = 'critical'; title = 'Riverside database is missing'; detail = 'The configured database does not exist.'; action = 'apply_migrations' }) }

$llamaHost = if ($envConfig -and $envConfig.RIVERSIDE_LLAMA_HOST) { "$($envConfig.RIVERSIDE_LLAMA_HOST)" } else { '127.0.0.1' }
$llamaPort = if ($envConfig -and $envConfig.RIVERSIDE_LLAMA_PORT) { "$($envConfig.RIVERSIDE_LLAMA_PORT)" } else { '8080' }
$llamaBase = "http://${llamaHost}:${llamaPort}"
$llamaHealth = Test-Http "$llamaBase/health"
$llamaProcesses = @(Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue)
$out.rosie = @{ host = $llamaBase; health = $llamaHealth; process_count = $llamaProcesses.Count }
if (-not $llamaHealth.ok) { [void]$issues.Add(@{ severity = 'warning'; title = 'ROSIE LLM host is offline'; detail = 'Local chat may be unavailable until the LLM host starts.'; action = 'start_rosie' }) }

$driveName = ([System.IO.Path]::GetPathRoot($installRoot)).TrimEnd('\').TrimEnd(':')
$drive = Get-PSDrive -Name $driveName -ErrorAction SilentlyContinue
$out.storage = @{
  drive = $driveName
  free_gb = if ($drive) { [math]::Round($drive.Free / 1GB, 1) } else { 0 }
  used_gb = if ($drive) { [math]::Round($drive.Used / 1GB, 1) } else { 0 }
  logs = Get-DirSummary (Join-Path $installRoot 'logs')
  backups = Get-DirSummary (Join-Path $installRoot 'backups')
}
if ($drive -and ($drive.Free / 1GB) -lt 10) { [void]$issues.Add(@{ severity = 'critical'; title = 'Server drive is low on space'; detail = 'Less than 10 GB free on the server drive.'; action = 'cleanup_logs' }) }
if ($out.storage.logs.size_mb -gt 1024) { [void]$issues.Add(@{ severity = 'warning'; title = 'Server logs are large'; detail = 'Log files exceed 1 GB.'; action = 'cleanup_logs' }) }

$out.maintenance = @{
  scripts_available = @{
    audit = [bool](Test-Path (Join-Path $packageRoot 'audit-system.ps1'))
    migrations = [bool](Test-Path (Join-Path $packageRoot 'apply-riverside-migrations.ps1'))
    install = [bool](Test-Path (Join-Path $packageRoot 'install-server.ps1'))
    rosie = [bool](Test-Path (Join-Path $packageRoot 'Install-RosieAiStack.ps1'))
  }
}
$out.issues = @($issues)
$out | ConvertTo-Json -Depth 8 -Compress
"#;

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
            get_manager_paths,
            get_server_snapshot,
            run_server_action,
            is_elevated,
            relaunch_elevated
        ])
        .run(tauri::generate_context!())
        .expect("error while running ROS Server Manager");
}
