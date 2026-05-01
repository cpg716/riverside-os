use std::path::PathBuf;
use tauri::command;

#[cfg(windows)]
fn station_config_path() -> PathBuf {
    std::env::var_os("PROGRAMDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
        .join("RiversideOS")
        .join("station-config.json")
}

#[cfg(not(windows))]
fn station_config_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".riverside-os")
        .join("station-config.json")
}

#[command]
pub async fn load_station_config() -> Result<Option<serde_json::Value>, String> {
    let path = station_config_path();
    if !path.exists() {
        return Ok(None);
    }

    let raw = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Could not read station setup file: {e}"))?;
    let value = serde_json::from_str(&raw)
        .map_err(|e| format!("Could not read station setup values: {e}"))?;
    Ok(Some(value))
}
