use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{RemoteRelease, Updater, UpdaterExt};

const UPDATER_ENDPOINT: Option<&str> = option_env!("RIVERSIDE_UPDATER_ENDPOINT");
const UPDATER_PUBLIC_KEY: Option<&str> = option_env!("RIVERSIDE_UPDATER_PUBLIC_KEY");
const BUILD_SHA: Option<&str> = option_env!("RIVERSIDE_BUILD_SHA");
const GITHUB_SHA: Option<&str> = option_env!("GITHUB_SHA");
const UPDATE_TELEMETRY_FILE: &str = "app-update-install-state.json";
const UPDATE_TELEMETRY_SCHEMA_VERSION: u8 = 1;

static UPDATE_STATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static LAUNCH_ID: OnceLock<String> = OnceLock::new();

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

#[derive(Debug, Clone, Deserialize, Serialize)]
struct PendingUpdateInstall {
    target_version: String,
    target_build: Option<String>,
    started_at_unix_ms: u64,
    started_launch_id: String,
    started_from_version: String,
    started_from_build: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CompletedUpdateInstall {
    target_version: String,
    target_build: Option<String>,
    started_at_unix_ms: u64,
    observed_installed_at_unix_ms: u64,
    observed_running_version: String,
    observed_running_build: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct FailedUpdateInstall {
    target_version: String,
    target_build: Option<String>,
    started_at_unix_ms: u64,
    failed_at_unix_ms: u64,
    reason: String,
    observed_running_version: String,
    observed_running_build: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
struct AppUpdateInstallState {
    schema_version: u8,
    pending: Option<PendingUpdateInstall>,
    last_completed: Option<CompletedUpdateInstall>,
    last_failure: Option<FailedUpdateInstall>,
}

impl Default for AppUpdateInstallState {
    fn default() -> Self {
        Self {
            schema_version: UPDATE_TELEMETRY_SCHEMA_VERSION,
            pending: None,
            last_completed: None,
            last_failure: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AppUpdateTelemetryResult {
    pub observation_status: String,
    pub last_update_install_observed_at_unix_ms: Option<u64>,
    pub pending_target_version: Option<String>,
    pub pending_target_build: Option<String>,
    pub pending_started_at_unix_ms: Option<u64>,
    pub last_failure_at_unix_ms: Option<u64>,
    pub last_failure_reason: Option<String>,
    pub current_version: String,
    pub current_build: Option<String>,
}

fn configured_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn updater_config() -> Result<(String, String), String> {
    let endpoint = configured_value(UPDATER_ENDPOINT).ok_or_else(|| {
        "Updater is not configured (missing RIVERSIDE_UPDATER_ENDPOINT at build time)".to_string()
    })?;
    let pubkey = configured_value(UPDATER_PUBLIC_KEY).ok_or_else(|| {
        "Updater is not configured (missing RIVERSIDE_UPDATER_PUBLIC_KEY at build time)".to_string()
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

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn current_launch_id() -> &'static str {
    LAUNCH_ID
        .get_or_init(|| format!("{}-{}", std::process::id(), now_unix_ms()))
        .as_str()
}

fn update_telemetry_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(UPDATE_TELEMETRY_FILE))
        .map_err(|error| format!("Could not resolve updater telemetry directory: {error}"))
}

fn update_telemetry_backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

fn load_update_install_state(path: &Path) -> Result<AppUpdateInstallState, String> {
    let backup_path = update_telemetry_backup_path(path);
    if !path.exists() && backup_path.exists() {
        fs::rename(&backup_path, path).map_err(|error| {
            format!(
                "Could not recover updater telemetry marker {}: {error}",
                path.display()
            )
        })?;
    }
    if !path.exists() {
        return Ok(AppUpdateInstallState::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| {
        format!(
            "Could not read updater telemetry marker {}: {error}",
            path.display()
        )
    })?;
    let mut state: AppUpdateInstallState = serde_json::from_str(&raw).map_err(|error| {
        format!(
            "Updater telemetry marker {} is invalid: {error}",
            path.display()
        )
    })?;
    state.schema_version = UPDATE_TELEMETRY_SCHEMA_VERSION;
    Ok(state)
}

fn write_update_install_state(path: &Path, state: &AppUpdateInstallState) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| {
        format!(
            "Updater telemetry marker has no parent directory: {}",
            path.display()
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Could not create updater telemetry directory {}: {error}",
            parent.display()
        )
    })?;

    let temp_path = path.with_extension(format!("json.tmp-{}", current_launch_id()));
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("Could not serialize updater telemetry marker: {error}"))?;
    let mut temp_file = fs::File::create(&temp_path).map_err(|error| {
        format!(
            "Could not create updater telemetry marker {}: {error}",
            temp_path.display()
        )
    })?;
    temp_file.write_all(&bytes).map_err(|error| {
        format!(
            "Could not write updater telemetry marker {}: {error}",
            temp_path.display()
        )
    })?;
    temp_file.sync_all().map_err(|error| {
        format!(
            "Could not flush updater telemetry marker {}: {error}",
            temp_path.display()
        )
    })?;
    drop(temp_file);

    if !path.exists() {
        return fs::rename(&temp_path, path).map_err(|error| {
            format!(
                "Could not activate updater telemetry marker {}: {error}",
                path.display()
            )
        });
    }

    let backup_path = update_telemetry_backup_path(path);
    if backup_path.exists() {
        fs::remove_file(&backup_path).map_err(|error| {
            format!(
                "Could not clear prior updater telemetry backup {}: {error}",
                backup_path.display()
            )
        })?;
    }
    fs::rename(path, &backup_path).map_err(|error| {
        format!(
            "Could not preserve updater telemetry marker {}: {error}",
            path.display()
        )
    })?;
    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::rename(&backup_path, path);
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "Could not activate updater telemetry marker {}: {error}",
            path.display()
        ));
    }
    let _ = fs::remove_file(backup_path);
    Ok(())
}

fn normalized_release_version(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('v')
        .split('+')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn running_release_matches(
    target_version: &str,
    target_build: Option<&str>,
    running_version: &str,
    running_build: Option<&str>,
) -> bool {
    if normalized_release_version(target_version) != normalized_release_version(running_version) {
        return false;
    }
    match target_build.and_then(normalize_build_id) {
        Some(target_build) => running_build
            .and_then(normalize_build_id)
            .map(|running_build| running_build == target_build)
            .unwrap_or(false),
        None => true,
    }
}

fn reconcile_pending_install(
    state: &mut AppUpdateInstallState,
    running_version: &str,
    running_build: Option<&str>,
    launch_id: &str,
    observed_at_unix_ms: u64,
) -> bool {
    let Some(pending) = state.pending.clone() else {
        return false;
    };
    if pending.started_launch_id == launch_id {
        return false;
    }

    if running_release_matches(
        &pending.target_version,
        pending.target_build.as_deref(),
        running_version,
        running_build,
    ) {
        state.last_completed = Some(CompletedUpdateInstall {
            target_version: pending.target_version,
            target_build: pending.target_build,
            started_at_unix_ms: pending.started_at_unix_ms,
            observed_installed_at_unix_ms: observed_at_unix_ms,
            observed_running_version: running_version.to_string(),
            observed_running_build: running_build.and_then(normalize_build_id),
        });
        state.pending = None;
        state.last_failure = None;
        return true;
    }

    state.last_failure = Some(FailedUpdateInstall {
        target_version: pending.target_version,
        target_build: pending.target_build,
        started_at_unix_ms: pending.started_at_unix_ms,
        failed_at_unix_ms: observed_at_unix_ms,
        reason: format!(
            "Relaunched version/build did not match the pending update target (running {} / {}).",
            running_version,
            running_build.unwrap_or("unknown")
        ),
        observed_running_version: running_version.to_string(),
        observed_running_build: running_build.and_then(normalize_build_id),
    });
    state.pending = None;
    true
}

fn begin_pending_install(
    app: &AppHandle,
    target_version: &str,
    target_build: Option<String>,
) -> Result<(), String> {
    let _guard = UPDATE_STATE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = update_telemetry_path(app)?;
    let running_version = app.package_info().version.to_string();
    let running_build = current_build_id();
    let now = now_unix_ms();
    let mut state = load_update_install_state(&path)?;
    let _ = reconcile_pending_install(
        &mut state,
        &running_version,
        running_build.as_deref(),
        current_launch_id(),
        now,
    );
    if let Some(pending) = &state.pending {
        return Err(format!(
            "An app update to {} ({}) is already pending restart confirmation.",
            pending.target_version,
            pending.target_build.as_deref().unwrap_or("build unknown")
        ));
    }
    state.pending = Some(PendingUpdateInstall {
        target_version: target_version.to_string(),
        target_build,
        started_at_unix_ms: now,
        started_launch_id: current_launch_id().to_string(),
        started_from_version: running_version,
        started_from_build: running_build,
    });
    state.last_failure = None;
    write_update_install_state(&path, &state)
}

fn mark_pending_install_failed(app: &AppHandle, reason: &str) -> Result<(), String> {
    let _guard = UPDATE_STATE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = update_telemetry_path(app)?;
    let mut state = load_update_install_state(&path)?;
    let Some(pending) = state.pending.take() else {
        return Ok(());
    };
    state.last_failure = Some(FailedUpdateInstall {
        target_version: pending.target_version,
        target_build: pending.target_build,
        started_at_unix_ms: pending.started_at_unix_ms,
        failed_at_unix_ms: now_unix_ms(),
        reason: reason.chars().take(500).collect(),
        observed_running_version: app.package_info().version.to_string(),
        observed_running_build: current_build_id(),
    });
    write_update_install_state(&path, &state)
}

fn release_build_id(release: &RemoteRelease) -> Option<String> {
    normalize_build_id(release.version.build.as_str())
}

fn same_version_rebuild_available(current_build: Option<&str>, update_build: Option<&str>) -> bool {
    let Some(update_build) = update_build.and_then(normalize_build_id) else {
        return false;
    };

    match current_build.and_then(normalize_build_id) {
        Some(current_build) => update_build != current_build,
        None => true,
    }
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
                return same_version_rebuild_available(
                    current_build.as_deref(),
                    release_build_id(&update).as_deref(),
                );
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
pub fn read_app_update_telemetry(app: AppHandle) -> Result<AppUpdateTelemetryResult, String> {
    let _guard = UPDATE_STATE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = update_telemetry_path(&app)?;
    let current_version = app.package_info().version.to_string();
    let current_build = current_build_id();
    let mut state = load_update_install_state(&path)?;
    if reconcile_pending_install(
        &mut state,
        &current_version,
        current_build.as_deref(),
        current_launch_id(),
        now_unix_ms(),
    ) {
        write_update_install_state(&path, &state)?;
    }

    let observation_status = if state.pending.is_some() {
        "pending"
    } else if state.last_failure.is_some() {
        "failed"
    } else if state.last_completed.is_some() {
        "confirmed"
    } else {
        "none"
    };
    Ok(AppUpdateTelemetryResult {
        observation_status: observation_status.to_string(),
        last_update_install_observed_at_unix_ms: state
            .last_completed
            .as_ref()
            .map(|completed| completed.observed_installed_at_unix_ms),
        pending_target_version: state
            .pending
            .as_ref()
            .map(|pending| pending.target_version.clone()),
        pending_target_build: state
            .pending
            .as_ref()
            .and_then(|pending| pending.target_build.clone()),
        pending_started_at_unix_ms: state
            .pending
            .as_ref()
            .map(|pending| pending.started_at_unix_ms),
        last_failure_at_unix_ms: state
            .last_failure
            .as_ref()
            .map(|failure| failure.failed_at_unix_ms),
        last_failure_reason: state
            .last_failure
            .as_ref()
            .map(|failure| failure.reason.clone()),
        current_version,
        current_build,
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
    begin_pending_install(&app, &target_version, installed_build.clone())?;
    if let Err(error) = update
        .download_and_install(|_chunk_length, _content_length| {}, || {})
        .await
    {
        let install_error = format!("Failed to download/install update: {error}");
        if let Err(marker_error) = mark_pending_install_failed(&app, &install_error) {
            return Err(format!(
                "{install_error}; additionally could not persist failed update telemetry: {marker_error}"
            ));
        }
        return Err(install_error);
    }

    Ok(InstallUpdateResult {
        enabled: true,
        installed: true,
        version: Some(target_version),
        message: Some(
            "Update package applied. Relaunch Riverside; installation telemetry is confirmed only after the running version and build match the target."
                .to_string(),
        ),
        current_build,
        installed_build,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending_state(started_at_unix_ms: u64) -> AppUpdateInstallState {
        AppUpdateInstallState {
            pending: Some(PendingUpdateInstall {
                target_version: "0.95.0+bbbb2222".to_string(),
                target_build: Some("bbbb2222".to_string()),
                started_at_unix_ms,
                started_launch_id: "old-launch".to_string(),
                started_from_version: "0.95.0".to_string(),
                started_from_build: Some("aaaa1111".to_string()),
            }),
            ..AppUpdateInstallState::default()
        }
    }

    #[test]
    fn same_version_rebuild_is_available_when_build_differs() {
        assert!(same_version_rebuild_available(
            Some("aaaa1111"),
            Some("bbbb2222")
        ));
    }

    #[test]
    fn same_version_rebuild_is_not_available_when_build_matches() {
        assert!(!same_version_rebuild_available(
            Some("aaaa1111cccc"),
            Some("aaaa1111dddd")
        ));
    }

    #[test]
    fn same_version_rebuild_is_available_when_current_build_is_unknown() {
        assert!(same_version_rebuild_available(None, Some("bbbb2222")));
        assert!(same_version_rebuild_available(
            Some("dev"),
            Some("bbbb2222")
        ));
    }

    #[test]
    fn same_version_rebuild_requires_published_build_metadata() {
        assert!(!same_version_rebuild_available(Some("aaaa1111"), None));
    }

    #[test]
    fn pending_install_is_confirmed_only_after_new_launch_matches_version_and_build() {
        let mut state = pending_state(1_000);
        assert!(!reconcile_pending_install(
            &mut state,
            "0.95.0",
            Some("bbbb2222"),
            "old-launch",
            2_000,
        ));
        assert!(state.pending.is_some());
        assert!(state.last_completed.is_none());

        assert!(reconcile_pending_install(
            &mut state,
            "0.95.0",
            Some("bbbb2222cccc"),
            "new-launch",
            3_000,
        ));
        assert!(state.pending.is_none());
        let completed = state.last_completed.expect("confirmed install evidence");
        assert_eq!(completed.observed_installed_at_unix_ms, 3_000);
        assert_eq!(
            completed.observed_running_build.as_deref(),
            Some("bbbb2222")
        );
    }

    #[test]
    fn mismatched_relaunch_becomes_failed_evidence() {
        let mut state = pending_state(10_000);
        assert!(reconcile_pending_install(
            &mut state,
            "0.95.0",
            Some("aaaa1111"),
            "new-launch",
            11_000,
        ));
        assert!(state.pending.is_none());
        assert!(state.last_completed.is_none());
        let failure = state.last_failure.expect("failed install evidence");
        assert!(failure.reason.contains("did not match"));
    }
}
