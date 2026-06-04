use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::{RemoteRelease, Updater, UpdaterExt};

const UPDATER_PUBLIC_KEY: Option<&str> = option_env!("RIVERSIDE_UPDATER_PUBLIC_KEY");
const APP_UPDATER_ENDPOINT: Option<&str> = option_env!("RIVERSIDE_ROS_DEV_UPDATER_ENDPOINT");
const APP_UPDATER_PUBLIC_KEY: Option<&str> = option_env!("RIVERSIDE_ROS_DEV_UPDATER_PUBLIC_KEY");
const BUILD_SHA: Option<&str> = option_env!("RIVERSIDE_BUILD_SHA");
const GITHUB_SHA: Option<&str> = option_env!("GITHUB_SHA");
const APP_ENDPOINT_ENV: &str = "RIVERSIDE_ROS_DEV_UPDATER_ENDPOINT";
const APP_PUBLIC_KEY_ENV: &str = "RIVERSIDE_ROS_DEV_UPDATER_PUBLIC_KEY";

#[derive(Debug, Serialize)]
pub struct UpdateCheckResult {
    pub enabled: bool,
    pub available: bool,
    pub version: Option<String>,
    pub date: Option<String>,
    pub notes: Option<String>,
    pub message: Option<String>,
    pub current_build: Option<String>,
    pub available_build: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct InstallUpdateResult {
    pub enabled: bool,
    pub installed: bool,
    pub version: Option<String>,
    pub message: Option<String>,
    pub current_build: Option<String>,
    pub installed_build: Option<String>,
}

fn configured_value(app_value: Option<&str>, common_value: Option<&str>) -> Option<String> {
    app_value
        .or(common_value)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn updater_config() -> Result<(String, String), String> {
    let endpoint = APP_UPDATER_ENDPOINT
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            format!("Updater is not configured (missing {APP_ENDPOINT_ENV} at build time)")
        })?;
    let pubkey = configured_value(APP_UPDATER_PUBLIC_KEY, UPDATER_PUBLIC_KEY).ok_or_else(|| {
        format!(
            "Updater is not configured (missing {APP_PUBLIC_KEY_ENV} or RIVERSIDE_UPDATER_PUBLIC_KEY at build time)"
        )
    })?;
    Ok((endpoint, pubkey))
}

fn normalize_build_id(value: &str) -> Option<String> {
    let cleaned = value
        .trim()
        .trim_start_matches('+')
        .trim()
        .to_ascii_lowercase();
    if cleaned.is_empty() || cleaned == "unknown" || cleaned == "dev" {
        return None;
    }
    let short: String = cleaned.chars().take(8).collect();
    if short.is_empty() {
        None
    } else {
        Some(short)
    }
}

fn current_build_id() -> Option<String> {
    BUILD_SHA.or(GITHUB_SHA).and_then(normalize_build_id)
}

fn release_build_id(release: &RemoteRelease) -> Option<String> {
    normalize_build_id(release.version.build.as_str())
}

fn build_updater(app: &AppHandle, endpoint: String, pubkey: String) -> Result<Updater, String> {
    let current_build = current_build_id();
    let endpoint = endpoint
        .parse()
        .map_err(|e| format!("Invalid updater endpoint: {e}"))?;

    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| format!("Failed to configure updater endpoint: {e}"))?
        .pubkey(pubkey)
        .version_comparator(move |current, update| {
            if current.major == update.version.major
                && current.minor == update.version.minor
                && current.patch == update.version.patch
                && current.pre == update.version.pre
            {
                if let Some(current_build) = &current_build {
                    if let Some(update_build) = release_build_id(&update) {
                        return update_build != *current_build;
                    }
                }
            }

            update.version > current
        })
        .build()
        .map_err(|e| format!("Failed to initialize updater: {e}"))
}

#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<UpdateCheckResult, String> {
    let current_build = current_build_id();
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
                current_build,
                available_build: None,
            })
        }
    };

    let update = build_updater(&app, endpoint, pubkey)?
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
            current_build,
            available_build: normalize_build_id(
                update.version.split('+').nth(1).unwrap_or_default(),
            ),
        });
    }

    Ok(UpdateCheckResult {
        enabled: true,
        available: false,
        version: None,
        date: None,
        notes: None,
        message: Some("No update available".to_string()),
        current_build,
        available_build: None,
    })
}

#[tauri::command]
pub async fn install_app_update(app: AppHandle) -> Result<InstallUpdateResult, String> {
    let current_build = current_build_id();
    let (endpoint, pubkey) = match updater_config() {
        Ok(cfg) => cfg,
        Err(msg) => {
            return Ok(InstallUpdateResult {
                enabled: false,
                installed: false,
                version: None,
                message: Some(msg),
                current_build,
                installed_build: None,
            })
        }
    };

    let update = build_updater(&app, endpoint, pubkey)?
        .check()
        .await
        .map_err(|e| format!("Failed to check for updates: {e}"))?;

    let Some(update) = update else {
        return Ok(InstallUpdateResult {
            enabled: true,
            installed: false,
            version: None,
            message: Some("No update available".to_string()),
            current_build,
            installed_build: None,
        });
    };

    let target_version = update.version.clone();
    let installed_build = normalize_build_id(target_version.split('+').nth(1).unwrap_or_default());
    update
        .download_and_install(|_chunk_length, _content_length| {}, || {})
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
        current_build,
        installed_build,
    })
}
