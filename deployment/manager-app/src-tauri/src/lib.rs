use serde::{Deserialize, Serialize};
use std::env;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Serialize, Deserialize, Clone)]
struct LogMessage {
    level: String,
    text: String,
}

fn get_config_path() -> PathBuf {
    // In production, this would resolve to the package root.
    // For now, assume it's next to the executable.
    let mut path = env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    path.pop(); // remove executable name
    path.push("riverside-deployment.config.json");
    
    // Fallback for development if file doesn't exist
    if !path.exists() {
        let mut dev_path = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        dev_path.push("riverside-deployment.config.json");
        return dev_path;
    }
    path
}

#[tauri::command]
async fn read_deployment_config() -> Result<String, String> {
    let path = get_config_path();
    if !path.exists() {
        return Ok("{}".to_string());
    }
    tokio::fs::read_to_string(path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_deployment_config(config: String) -> Result<(), String> {
    let path = get_config_path();
    tokio::fs::write(path, config).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_deployment_script(app: AppHandle, script_name: String, args: Option<Vec<String>>) -> Result<(), String> {
    let script_path = {
        let mut path = env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
        path.pop();
        path.push(&script_name);
        
        // Fallback for development
        if !path.exists() {
            let mut dev_path = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            dev_path.pop(); // Up to deployment/
            dev_path.push(&script_name);
            path = dev_path;
        }
        path
    };

    if !script_path.exists() {
        return Err(format!("Script not found: {}", script_path.display()));
    }

    let mut cmd = Command::new("powershell");
    cmd.arg("-NoProfile")
       .arg("-ExecutionPolicy")
       .arg("Bypass")
       .arg("-File")
       .arg(script_path.to_str().unwrap());

    if let Some(arguments) = args {
        for arg in arguments {
            cmd.arg(arg);
        }
    }

    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn powershell: {}", e))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let app_clone = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_clone.emit("deployment-log", LogMessage {
                level: "info".to_string(),
                text: line,
            });
        }
    });

    let app_clone = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_clone.emit("deployment-log", LogMessage {
                level: "error".to_string(),
                text: line,
            });
        }
    });

    let status = child.wait().await.map_err(|e| format!("Failed to wait: {}", e))?;
    
    let _ = app.emit("deployment-log", LogMessage {
        level: if status.success() { "success".to_string() } else { "error".to_string() },
        text: format!("Script exited with status: {}", status),
    });

    if status.success() {
        Ok(())
    } else {
        Err(format!("Script exited with {}", status))
    }
}

#[tauri::command]
async fn run_inline_powershell(app: AppHandle, script_content: String) -> Result<(), String> {
    let mut child = Command::new("powershell")
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(&script_content)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn powershell: {}", e))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let app_clone = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_clone.emit("deployment-log", LogMessage { level: "info".to_string(), text: line });
        }
    });

    let app_clone = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_clone.emit("deployment-log", LogMessage { level: "error".to_string(), text: line });
        }
    });

    let status = child.wait().await.map_err(|e| format!("Failed to wait: {}", e))?;
    
    let _ = app.emit("deployment-log", LogMessage {
        level: if status.success() { "success".to_string() } else { "error".to_string() },
        text: format!("Command exited with status: {}", status),
    });

    if status.success() { Ok(()) } else { Err(format!("Exited with {}", status)) }
}

#[tauri::command]
async fn open_logs() -> Result<(), String> {
    Command::new("explorer")
        .arg("C:\\RiversideOS\\logs")
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        .invoke_handler(tauri::generate_handler![
            read_deployment_config,
            write_deployment_config,
            run_deployment_script,
            run_inline_powershell,
            open_logs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
