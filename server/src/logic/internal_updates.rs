use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const RELEASE_MANIFEST_FILE: &str = "release.json";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalReleaseAsset {
    pub file_name: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalWindowsUpdaterAsset {
    pub file_name: String,
    pub signature: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalReleaseManifest {
    pub contract_version: u8,
    pub version: String,
    pub source_git_sha: String,
    pub published_at: String,
    pub notes: Option<String>,
    pub main_hub_package: InternalReleaseAsset,
    pub windows_updater: InternalWindowsUpdaterAsset,
}

fn configured_root() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("RIVERSIDE_INTERNAL_UPDATE_DIR") {
        let path = PathBuf::from(value);
        if !path.as_os_str().is_empty() {
            return Some(path);
        }
    }

    #[cfg(windows)]
    {
        return Some(
            std::env::var_os("PROGRAMDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
                .join("RiversideOS")
                .join("updates"),
        );
    }

    #[cfg(not(windows))]
    None
}

pub fn current_release_dir() -> Option<PathBuf> {
    configured_root().map(|root| root.join("current"))
}

fn valid_file_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 180
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
}

fn valid_hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_asset(path: &Path, file_name: &str, sha256: &str, bytes: u64) -> Result<(), String> {
    if !valid_file_name(file_name) {
        return Err(format!(
            "Internal release contains an invalid asset name: {file_name}"
        ));
    }
    if !valid_hex(sha256, 64) {
        return Err(format!(
            "Internal release asset {file_name} does not contain a valid SHA-256."
        ));
    }
    if bytes == 0 {
        return Err(format!(
            "Internal release asset {file_name} has an invalid byte count."
        ));
    }
    let metadata = std::fs::metadata(path.join(file_name))
        .map_err(|error| format!("Internal release asset {file_name} is unavailable: {error}"))?;
    if !metadata.is_file() || metadata.len() != bytes {
        return Err(format!(
            "Internal release asset {file_name} does not match its published byte count."
        ));
    }
    Ok(())
}

pub fn load_current_release() -> Result<Option<InternalReleaseManifest>, String> {
    let Some(current_dir) = current_release_dir() else {
        return Ok(None);
    };
    let manifest_path = current_dir.join(RELEASE_MANIFEST_FILE);
    if !manifest_path.exists() {
        return Ok(None);
    }

    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Could not read internal release metadata: {error}"))?;
    let manifest: InternalReleaseManifest =
        serde_json::from_str(raw.trim_start_matches('\u{feff}'))
            .map_err(|error| format!("Could not parse internal release metadata: {error}"))?;

    if manifest.contract_version != 1 {
        return Err(format!(
            "Unsupported internal release contract version: {}",
            manifest.contract_version
        ));
    }
    if manifest.version.trim().is_empty() || manifest.version.len() > 64 {
        return Err("Internal release version is invalid.".to_string());
    }
    if !valid_hex(&manifest.source_git_sha, 40) {
        return Err("Internal release source Git SHA is invalid.".to_string());
    }
    if manifest.published_at.trim().is_empty() {
        return Err("Internal release publish time is missing.".to_string());
    }
    if manifest.windows_updater.signature.trim().is_empty() {
        return Err("Internal Windows updater signature is missing.".to_string());
    }

    validate_asset(
        &current_dir,
        &manifest.main_hub_package.file_name,
        &manifest.main_hub_package.sha256,
        manifest.main_hub_package.bytes,
    )?;
    validate_asset(
        &current_dir,
        &manifest.windows_updater.file_name,
        &manifest.windows_updater.sha256,
        manifest.windows_updater.bytes,
    )?;

    Ok(Some(manifest))
}

#[cfg(test)]
mod tests {
    use super::{valid_file_name, valid_hex};

    #[test]
    fn internal_asset_names_cannot_escape_release_directory() {
        assert!(valid_file_name("Riverside.POS_0.96.0_x64-setup.nsis.zip"));
        assert!(!valid_file_name("../release.zip"));
        assert!(!valid_file_name(r"folder\release.zip"));
        assert!(!valid_file_name("folder/release.zip"));
    }

    #[test]
    fn exact_release_digests_and_source_shas_are_required() {
        assert!(valid_hex(&"a".repeat(40), 40));
        assert!(valid_hex(&"F".repeat(64), 64));
        assert!(!valid_hex("not-a-sha", 40));
    }
}
