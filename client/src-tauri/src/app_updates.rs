use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

const UPDATER_ENDPOINT: Option<&str> = option_env!("RIVERSIDE_UPDATER_ENDPOINT");
const UPDATER_PUBLIC_KEY: Option<&str> = option_env!("RIVERSIDE_UPDATER_PUBLIC_KEY");

#[derive(Debug, Serialize)]
pub struct UpdateCheckResult {
    pub enabled: bool,
    pub available: bool,
    pub version: Option<String>,
    pub date: Option<String>,
    pub notes: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct InstallUpdateResult {
    pub enabled: bool,
    pub installed: bool,
    pub version: Option<String>,
    pub message: Option<String>,
}

fn updater_config() -> Result<(String, String), String> {
    let endpoint = UPDATER_ENDPOINT
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "Updater is not configured (missing RIVERSIDE_UPDATER_ENDPOINT at build time)"
                .to_string()
        })?;
    let pubkey = UPDATER_PUBLIC_KEY
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "Updater is not configured (missing RIVERSIDE_UPDATER_PUBLIC_KEY at build time)"
                .to_string()
        })?;
    Ok((endpoint.to_string(), pubkey.to_string()))
}

#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<UpdateCheckResult, String> {
    let (endpoint, pubkey) = match updater_config() {
        Ok(cfg) => cfg,
        Err(msg) => {
            return Ok(UpdateCheckResult {
                enabled: false,
                available: false,
                version: None,
                date: None,
                notes: None,
                message: Some(msg),
            })
        }
    };

    let update = app
        .updater_builder()
        .endpoints(vec![endpoint.parse().map_err(|e| format!("Invalid updater endpoint: {e}"))?])
        .map_err(|e| format!("Failed to configure updater endpoint: {e}"))?
        .pubkey(pubkey)
        .build()
        .map_err(|e| format!("Failed to initialize updater: {e}"))?
        .check()
        .await
        .map_err(|e| format!("Failed to check for updates: {e}"))?;

    if let Some(update) = update {
        return Ok(UpdateCheckResult {
            enabled: true,
            available: true,
            version: Some(update.version.clone()),
            date: update.date.map(|d| d.to_string()),
            notes: update.body.clone(),
            message: None,
        });
    }

    Ok(UpdateCheckResult {
        enabled: true,
        available: false,
        version: None,
        date: None,
        notes: None,
        message: Some("No update available".to_string()),
    })
}

#[tauri::command]
pub async fn install_app_update(app: AppHandle) -> Result<InstallUpdateResult, String> {
    let (endpoint, pubkey) = match updater_config() {
        Ok(cfg) => cfg,
        Err(msg) => {
            return Ok(InstallUpdateResult {
                enabled: false,
                installed: false,
                version: None,
                message: Some(msg),
            })
        }
    };

    let update = app
        .updater_builder()
        .endpoints(vec![endpoint.parse().map_err(|e| format!("Invalid updater endpoint: {e}"))?])
        .map_err(|e| format!("Failed to configure updater endpoint: {e}"))?
        .pubkey(pubkey)
        .build()
        .map_err(|e| format!("Failed to initialize updater: {e}"))?
        .check()
        .await
        .map_err(|e| format!("Failed to check for updates: {e}"))?;

    let Some(update) = update else {
        return Ok(InstallUpdateResult {
            enabled: true,
            installed: false,
            version: None,
            message: Some("No update available".to_string()),
        });
    };

    let target_version = update.version.clone();
    update
        .download_and_install(
            |_chunk_length, _content_length| {},
            || {},
        )
        .await
        .map_err(|e| format!("Failed to download/install update: {e}"))?;

    Ok(InstallUpdateResult {
        enabled: true,
        installed: true,
        version: Some(target_version),
        message: Some(
            "Update installed. On Windows the app exits during install; relaunch after completion."
                .to_string(),
        ),
    })
}
