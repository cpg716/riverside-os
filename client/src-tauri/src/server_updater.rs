#![allow(unused_imports, dead_code)]
use serde::Deserialize;
use std::path::{Path, PathBuf};

use std::process::Command;
use tauri::{command, AppHandle};

use crate::install_contract::contract;

const UPDATER_CHANNEL: Option<&str> = option_env!("RIVERSIDE_UPDATER_CHANNEL");

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
fn suppress_child_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_child_console(_command: &mut Command) {}

#[derive(serde::Serialize)]
pub struct ServerLocalStatus {
    pub is_local: bool,
    pub install_root: String,
    pub config_exists: bool,
    pub server_binary_exists: bool,
}

#[derive(Deserialize, Debug)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
}

#[derive(Deserialize, Debug)]
struct GithubRelease {
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct InternalMainHubAsset {
    file_name: String,
    url: String,
    sha256: String,
    bytes: u64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct InternalRelease {
    contract_version: u8,
    version: String,
    source_git_sha: String,
    main_hub_package: InternalMainHubAsset,
}

fn internal_release_url() -> Result<reqwest::Url, String> {
    let station = crate::station_config::read_station_config_value()?
        .ok_or_else(|| "Internal Main Hub update requires station-config.json.".to_string())?;
    let api_base = station
        .get("register")
        .and_then(|register| register.get("apiBase"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Internal Main Hub update requires register.apiBase.".to_string())?;
    let mut url = reqwest::Url::parse(api_base)
        .map_err(|error| format!("Internal Main Hub API address is invalid: {error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err("Internal Main Hub API address must be an HTTP(S) server origin without credentials, query parameters, fragments, or a path.".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Internal Main Hub API address does not contain a host.".to_string())?;
    if url.scheme() == "http" && !crate::station_config::is_allowed_internal_update_host(host) {
        return Err("Plain HTTP Main Hub updates are restricted to loopback, private LAN, and Tailscale addresses.".to_string());
    }
    url.set_path("/api/internal-updates/release.json");
    Ok(url)
}

fn version_core(value: &str) -> &str {
    value
        .trim()
        .trim_start_matches('v')
        .split('+')
        .next()
        .unwrap_or_default()
}

async fn resolve_internal_deployment_asset(
    client: &reqwest::Client,
    version: &str,
    target_build_sha: &str,
) -> Result<GithubAsset, String> {
    let metadata_url = internal_release_url()?;
    let response = client
        .get(metadata_url.clone())
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .map_err(|error| format!("Failed to request internal release metadata: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Internal release metadata returned HTTP {}.",
            response.status()
        ));
    }
    let release: InternalRelease = response
        .json()
        .await
        .map_err(|error| format!("Failed to parse internal release metadata: {error}"))?;
    if release.contract_version != 1 {
        return Err(format!(
            "Unsupported internal release contract version: {}",
            release.contract_version
        ));
    }
    if version_core(&release.version) != version_core(version) {
        return Err(format!(
            "Internal release version mismatch. Expected {}, metadata contains {}.",
            version_core(version),
            version_core(&release.version)
        ));
    }
    if !release
        .source_git_sha
        .eq_ignore_ascii_case(target_build_sha)
    {
        return Err(format!(
            "Internal release build mismatch. Expected {target_build_sha}, metadata contains {}.",
            release.source_git_sha
        ));
    }
    if release.main_hub_package.bytes == 0 {
        return Err("Internal Main Hub package has an invalid byte count.".to_string());
    }
    let asset_url = reqwest::Url::parse(&release.main_hub_package.url)
        .map_err(|error| format!("Internal Main Hub package URL is invalid: {error}"))?;
    if asset_url.scheme() != metadata_url.scheme()
        || asset_url.host_str() != metadata_url.host_str()
        || asset_url.port_or_known_default() != metadata_url.port_or_known_default()
        || !asset_url.path().starts_with("/api/internal-updates/files/")
    {
        return Err(
            "Internal Main Hub package URL did not resolve to the configured Main Hub update service."
                .to_string(),
        );
    }
    Ok(GithubAsset {
        name: release.main_hub_package.file_name,
        browser_download_url: asset_url.to_string(),
        digest: Some(format!("sha256:{}", release.main_hub_package.sha256)),
    })
}

fn normalized_build_short(value: &str) -> Option<String> {
    let cleaned = value
        .trim()
        .trim_start_matches('+')
        .trim()
        .to_ascii_lowercase();
    if cleaned.is_empty() || cleaned == "unknown" || cleaned == "dev" {
        return None;
    }
    Some(cleaned.chars().take(8).collect())
}

fn build_ids_match(left: &str, right: &str) -> bool {
    let Some(left) = normalized_build_short(left) else {
        return false;
    };
    let Some(right) = normalized_build_short(right) else {
        return false;
    };
    let compare_len = left.len().min(right.len());
    compare_len >= 7 && left[..compare_len] == right[..compare_len]
}

fn asset_name_matches_build(asset_name: &str, target_build: &str) -> bool {
    let Some(target_build) = normalized_build_short(target_build) else {
        return false;
    };
    let asset_name = asset_name.to_ascii_lowercase();
    if asset_name.contains(&target_build) {
        return true;
    }
    if target_build.len() >= 8 {
        return asset_name.contains(&target_build[..7]);
    }
    false
}

fn is_main_hub_update_asset(asset_name: &str) -> bool {
    asset_name.ends_with("-MainHub-Update.zip")
}

fn is_windows_deployment_asset(asset_name: &str) -> bool {
    asset_name.ends_with("-Windows-Deployment.zip")
}

fn parse_sha256_digest(digest: Option<&str>) -> Result<String, String> {
    let digest = digest
        .map(str::trim)
        .filter(|digest| !digest.is_empty())
        .ok_or_else(|| {
            "Main Hub update package is missing its GitHub SHA-256 digest; refusing to install it."
                .to_string()
        })?;
    let value = digest.strip_prefix("sha256:").ok_or_else(|| {
        format!("Main Hub update package uses an unsupported digest format: {digest}")
    })?;
    if value.len() != 64 || !value.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("Main Hub update package has an invalid SHA-256 digest.".to_string());
    }
    Ok(value.to_ascii_lowercase())
}

#[cfg(windows)]
fn verify_downloaded_asset_digest(path: &Path, digest: Option<&str>) -> Result<String, String> {
    let expected = parse_sha256_digest(digest)?;
    let hash_script = format!(
        "(Get-FileHash -LiteralPath '{}' -Algorithm SHA256).Hash",
        path.to_string_lossy().replace('\'', "''")
    );
    let mut hash_cmd = Command::new("powershell");
    hash_cmd.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &hash_script,
    ]);
    suppress_child_console(&mut hash_cmd);
    let output = hash_cmd
        .output()
        .map_err(|error| format!("Failed to calculate Main Hub package SHA-256: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not verify Main Hub package SHA-256: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let actual = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_ascii_lowercase();
    if actual != expected {
        return Err(format!(
            "Main Hub update package SHA-256 mismatch. Expected {expected}, downloaded {actual}. Refusing to install it."
        ));
    }
    Ok(actual)
}

fn select_deployment_asset(
    assets: Vec<GithubAsset>,
    tag_name: &str,
    target_build_short: Option<&str>,
) -> Result<GithubAsset, String> {
    let mut deployment_assets: Vec<GithubAsset> = assets
        .into_iter()
        .filter(|asset| {
            is_main_hub_update_asset(&asset.name) || is_windows_deployment_asset(&asset.name)
        })
        .collect();
    deployment_assets.sort_by_key(|asset| {
        if is_main_hub_update_asset(&asset.name) {
            0
        } else {
            1
        }
    });

    if deployment_assets.is_empty() {
        return Err(format!(
            "Could not find Main Hub update package or Windows Deployment ZIP asset in release tag {tag_name}"
        ));
    }

    if let Some(target_build_short) = target_build_short {
        if let Some(index) = deployment_assets
            .iter()
            .position(|asset| asset_name_matches_build(&asset.name, target_build_short))
        {
            return Ok(deployment_assets.remove(index));
        }

        let names = deployment_assets
            .iter()
            .map(|asset| asset.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "Release {tag_name} does not contain a Main Hub update package or Windows Deployment ZIP for build {target_build_short}. Available update assets: {names}"
        ));
    }

    deployment_assets.into_iter().next().ok_or_else(|| {
        format!("Could not find Main Hub update package or Windows Deployment ZIP asset in release tag {tag_name}")
    })
}

fn find_deployment_manifest(script_dir: &Path, extraction_dir: &Path) -> Option<PathBuf> {
    let manifest_name = "deployment-package.manifest.json";
    let mut current = Some(script_dir);
    while let Some(dir) = current {
        let candidate = dir.join(manifest_name);
        if candidate.exists() {
            return Some(candidate);
        }
        if dir == extraction_dir {
            break;
        }
        current = dir.parent();
    }
    None
}

fn parse_deployment_package_manifest(raw: &str) -> Result<serde_json::Value, serde_json::Error> {
    serde_json::from_str(raw.trim_start_matches('\u{feff}'))
}

fn verify_deployment_package_build(
    script_dir: &Path,
    extraction_dir: &Path,
    target_build_sha: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(target_build_short) = target_build_sha.and_then(normalized_build_short) else {
        return Ok(None);
    };

    let manifest_path =
        find_deployment_manifest(script_dir, extraction_dir).ok_or_else(|| {
            "Deployment package is missing deployment-package.manifest.json; refusing to run an unverifiable Main Hub update."
                .to_string()
        })?;

    let raw = std::fs::read_to_string(&manifest_path).map_err(|e| {
        format!(
            "Could not read deployment package manifest {}: {e}",
            manifest_path.display()
        )
    })?;
    let manifest = parse_deployment_package_manifest(&raw).map_err(|e| {
        format!(
            "Could not parse deployment package manifest {}: {e}",
            manifest_path.display()
        )
    })?;

    let actual_build = manifest
        .get("sourceGitSha")
        .and_then(|value| value.as_str())
        .or_else(|| {
            manifest
                .get("sourceGitShort")
                .and_then(|value| value.as_str())
        })
        .ok_or_else(|| {
            format!(
                "Deployment package manifest {} does not include sourceGitSha/sourceGitShort.",
                manifest_path.display()
            )
        })?;

    let actual_build_short = normalized_build_short(actual_build).ok_or_else(|| {
        format!(
            "Deployment package manifest {} has an invalid source build '{}'.",
            manifest_path.display(),
            actual_build
        )
    })?;

    let exact_builds_mismatch = target_build_sha.is_some_and(|target| {
        target.len() == 40 && actual_build.len() == 40 && !actual_build.eq_ignore_ascii_case(target)
    });
    if exact_builds_mismatch || !build_ids_match(&actual_build_short, &target_build_short) {
        return Err(format!(
            "Deployment package build mismatch. Expected {target_build_short}, package contains {actual_build_short}. Refusing to run the Main Hub update."
        ));
    }

    Ok(Some(actual_build_short))
}

fn candidate_deployment_config_paths(
    install_root: &Path,
    script_dir: &Path,
    extraction_dir: &Path,
) -> Vec<PathBuf> {
    let config_file = contract::DEPLOY_CONFIG_FILE;
    let mut candidates = vec![install_root.join(config_file), script_dir.join(config_file)];

    let mut current = Some(script_dir);
    while let Some(dir) = current {
        candidates.push(dir.join(config_file));
        if dir == extraction_dir {
            break;
        }
        current = dir.parent();
    }

    #[cfg(windows)]
    {
        if let Some(program_data) = std::env::var_os("ProgramData") {
            let program_data = PathBuf::from(program_data);
            candidates.push(program_data.join("RiversideOS").join(config_file));
            candidates.push(program_data.join("riverside-os").join(config_file));
        }
        if let Some(user_profile) = std::env::var_os("USERPROFILE") {
            let downloads_dir = PathBuf::from(user_profile).join("Downloads");
            if let Ok(entries) = std::fs::read_dir(downloads_dir) {
                let mut package_config_paths = entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| {
                        path.is_dir()
                            && path
                                .file_name()
                                .and_then(|name| name.to_str())
                                .is_some_and(|name| {
                                    name.starts_with("RiversideOS-")
                                        && name.contains("Windows-Deployment")
                                })
                    })
                    .map(|path| path.join(config_file))
                    .collect::<Vec<_>>();
                package_config_paths.sort_by(|left, right| right.cmp(left));
                candidates.extend(package_config_paths);
            }
        }
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                candidates.push(exe_dir.join(config_file));
                if let Some(parent) = exe_dir.parent() {
                    candidates.push(parent.join(config_file));
                }
            }
        }
    }

    let mut unique = Vec::new();
    for candidate in candidates {
        if !unique
            .iter()
            .any(|existing: &PathBuf| existing == &candidate)
        {
            unique.push(candidate);
        }
    }
    unique
}

fn resolve_existing_deployment_config(
    install_root: &Path,
    script_dir: &Path,
    extraction_dir: &Path,
) -> Option<PathBuf> {
    candidate_deployment_config_paths(install_root, script_dir, extraction_dir)
        .into_iter()
        .find(|candidate| candidate.exists())
}

#[cfg(test)]
mod tests {
    use super::{
        build_ids_match, candidate_deployment_config_paths, parse_deployment_package_manifest,
        parse_sha256_digest, select_deployment_asset, GithubAsset,
    };
    use std::path::Path;

    fn asset(name: &str) -> GithubAsset {
        GithubAsset {
            name: name.to_string(),
            browser_download_url: format!("https://example.invalid/{name}"),
            digest: Some(format!("sha256:{}", "a".repeat(64))),
        }
    }

    #[test]
    fn github_asset_digest_requires_sha256() {
        assert_eq!(
            parse_sha256_digest(Some(&format!("sha256:{}", "A".repeat(64))))
                .expect("valid SHA-256 digest"),
            "a".repeat(64)
        );
        assert!(parse_sha256_digest(None).is_err());
        assert!(parse_sha256_digest(Some("md5:abc")).is_err());
        assert!(parse_sha256_digest(Some("sha256:not-a-digest")).is_err());
    }

    #[test]
    fn deployment_package_manifest_accepts_windows_utf8_bom() {
        let value = parse_deployment_package_manifest(
            "\u{feff}{\"sourceGitSha\":\"a1af8f2378d98a96857e3f2e616c3d2cfe48225d\"}",
        )
        .expect("deployment package manifest with a UTF-8 BOM should parse");

        assert_eq!(
            value["sourceGitSha"],
            "a1af8f2378d98a96857e3f2e616c3d2cfe48225d"
        );
    }

    #[test]
    fn deployment_asset_selection_prefers_target_build_sha() {
        let selected = select_deployment_asset(
            vec![
                asset("RiversideOS-v0.90.0-14c3164b-Windows-Deployment.zip"),
                asset("RiversideOS-v0.90.0-e96a3e50-Windows-Deployment.zip"),
            ],
            "v0.90.0",
            Some("e96a3e50"),
        )
        .expect("expected matching deployment asset");

        assert_eq!(
            selected.name,
            "RiversideOS-v0.90.0-e96a3e50-Windows-Deployment.zip"
        );
    }

    #[test]
    fn deployment_asset_selection_prefers_main_hub_update_package() {
        let selected = select_deployment_asset(
            vec![
                asset("RiversideOS-v0.90.0-e96a3e50-Windows-Deployment.zip"),
                asset("RiversideOS-v0.90.0-e96a3e50-MainHub-Update.zip"),
            ],
            "v0.90.0",
            Some("e96a3e50"),
        )
        .expect("expected matching Main Hub update package");

        assert_eq!(
            selected.name,
            "RiversideOS-v0.90.0-e96a3e50-MainHub-Update.zip"
        );
    }

    #[test]
    fn deployment_asset_selection_accepts_seven_char_asset_for_eight_char_build() {
        let selected = select_deployment_asset(
            vec![asset("RiversideOS-v0.90.0-7620fea-Windows-Deployment.zip")],
            "v0.90.0",
            Some("7620fea0"),
        )
        .expect("expected seven-character asset to match eight-character build");

        assert_eq!(
            selected.name,
            "RiversideOS-v0.90.0-7620fea-Windows-Deployment.zip"
        );
    }

    #[test]
    fn build_id_matching_accepts_seven_or_eight_character_prefixes() {
        assert!(build_ids_match("7620fea", "7620fea0"));
        assert!(build_ids_match("7620fea0", "7620fea"));
        assert!(build_ids_match(
            "7620fea0deadcafe1234567890abcdef12345678",
            "7620fea"
        ));
        assert!(!build_ids_match("7620feb", "7620fea0"));
    }

    #[test]
    fn deployment_asset_selection_rejects_missing_target_build_sha() {
        let err = select_deployment_asset(
            vec![asset("RiversideOS-v0.90.0-14c3164b-Windows-Deployment.zip")],
            "v0.90.0",
            Some("e96a3e50"),
        )
        .expect_err("missing exact build should fail");

        assert!(err.contains("does not contain a Main Hub update package or Windows Deployment ZIP for build e96a3e50"));
    }

    #[test]
    fn main_hub_update_config_candidates_include_install_root_and_package() {
        let install_root = Path::new("C:\\RiversideOS");
        let extraction_dir =
            Path::new("C:\\Users\\Admin\\AppData\\Local\\Temp\\riverside-update-0.90.0\\extracted");
        let script_dir = extraction_dir.join("deployment").join("windows");
        let candidates =
            candidate_deployment_config_paths(install_root, &script_dir, extraction_dir);

        let candidate_text = candidates
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(candidate_text.contains("C:\\RiversideOS"));
        assert!(candidate_text.contains("deployment"));
        assert!(candidate_text.contains("windows"));
        assert!(candidate_text.contains("extracted"));
    }
}

#[command]
pub fn check_server_local_status() -> Result<ServerLocalStatus, String> {
    // Default install root — overridden if the config file specifies otherwise.
    let mut install_root = contract::DEFAULT_INSTALL_ROOT.to_string();

    let default_config = PathBuf::from(&install_root).join(contract::DEPLOY_CONFIG_FILE);
    if default_config.exists() {
        if let Ok(raw) = std::fs::read_to_string(&default_config) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(root) = json
                    .get(contract::CONFIG_SERVER_KEY)
                    .and_then(|s| s.get(contract::CONFIG_INSTALL_ROOT_KEY))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                {
                    install_root = root.to_string();
                }
            }
        }
    }

    let config_path = PathBuf::from(&install_root).join(contract::DEPLOY_CONFIG_FILE);
    // install_contract::contract::SERVER_BIN_SUBPATH — must match install-server.ps1.
    let server_bin_path = PathBuf::from(&install_root).join(contract::SERVER_BIN_SUBPATH);

    #[cfg(windows)]
    let is_local = {
        // install_contract::contract::DEPLOY_SUMMARY_FILE — written by install-server.ps1 on success.
        let summary_path = PathBuf::from(&install_root).join(contract::DEPLOY_SUMMARY_FILE);
        server_bin_path.exists() || config_path.exists() || summary_path.exists()
    };
    #[cfg(not(windows))]
    let is_local = false;

    Ok(ServerLocalStatus {
        is_local,
        install_root,
        config_exists: config_path.exists(),
        server_binary_exists: server_bin_path.exists(),
    })
}

#[command]
pub async fn download_and_run_server_installer(
    version: String,
    build_sha: Option<String>,
) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        let _version = version;
        let _build_sha = build_sha;
        Err("Main Hub updates can only be executed on the Windows Main Hub.".to_string())
    }

    #[cfg(windows)]
    {
        let target_build_sha = build_sha
            .as_deref()
            .map(str::trim)
            .filter(|sha| sha.len() == 40 && sha.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .map(str::to_ascii_lowercase)
            .ok_or_else(|| {
                "Exact build SHA is required for a Main Hub update. Refresh the update check before trying again."
                    .to_string()
            })?;
        let target_build_short = target_build_sha[..8].to_string();

        // 1. Resolve the exact deployment asset from the configured release channel.
        let tag_name = format!("v{}", version);
        let client = reqwest::Client::builder()
            .user_agent("riverside-pos")
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
        let asset = if UPDATER_CHANNEL
            .is_some_and(|channel| channel.eq_ignore_ascii_case("internal"))
        {
            resolve_internal_deployment_asset(&client, &version, &target_build_sha).await?
        } else {
            let url = format!(
                "https://api.github.com/repos/cpg716/riverside-os/releases/tags/{}",
                tag_name
            );
            let res = client
                .get(&url)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .send()
                .await
                .map_err(|e| format!("Failed to request release metadata from GitHub: {e}"))?;

            if !res.status().is_success() {
                return Err(format!(
                    "GitHub API returned error status: {} for release tag {}",
                    res.status(),
                    tag_name
                ));
            }
            let release: GithubRelease = res
                .json()
                .await
                .map_err(|e| format!("Failed to parse GitHub release JSON: {e}"))?;
            select_deployment_asset(release.assets, &tag_name, Some(target_build_short.as_str()))?
        };
        let asset_name = asset.name.clone();
        let asset_digest = asset.digest.clone();

        let download_url = asset.browser_download_url;

        // 2. Download the ZIP file to a temp directory
        let temp_dir = std::env::temp_dir().join(format!("riverside-update-{}", version));
        if temp_dir.exists() {
            let _ = std::fs::remove_dir_all(&temp_dir);
        }
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to create temp directory: {e}"))?;

        let zip_path = temp_dir.join("deployment.zip");

        let mut response = client
            .get(&download_url)
            .send()
            .await
            .map_err(|e| format!("Failed to start download of deployment package: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Deployment package download failed with HTTP status {} for {}.",
                response.status(),
                asset_name
            ));
        }

        let mut file = std::fs::File::create(&zip_path)
            .map_err(|e| format!("Failed to create destination zip file: {e}"))?;

        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Error during chunk download: {e}"))?
        {
            use std::io::Write;
            file.write_all(&chunk)
                .map_err(|e| format!("Error writing chunk to file: {e}"))?;
        }
        drop(file);

        let verified_package_digest =
            verify_downloaded_asset_digest(&zip_path, asset_digest.as_deref())?;

        // 3. Extract the ZIP using PowerShell
        let extraction_dir = temp_dir.join("extracted");
        std::fs::create_dir_all(&extraction_dir)
            .map_err(|e| format!("Failed to create extraction folder: {e}"))?;

        let extract_script = format!(
            "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
            zip_path.to_string_lossy().replace('\'', "''"),
            extraction_dir.to_string_lossy().replace('\'', "''")
        );

        let mut extract_cmd = Command::new("powershell");
        extract_cmd.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &extract_script,
        ]);
        suppress_child_console(&mut extract_cmd);
        let output = extract_cmd
            .output()
            .map_err(|e| format!("Failed to run PowerShell extraction: {e}"))?;

        if !output.status.success() {
            let err_msg = String::from_utf8_lossy(&output.stderr).to_string();
            return Err(format!("Extraction failed: {}", err_msg));
        }

        // 4. Create update-runner.ps1 script
        let mut script_dir = extraction_dir.clone();
        if extraction_dir.join("install-server.ps1").exists() {
            // Root
        } else if extraction_dir
            .join("windows")
            .join("install-server.ps1")
            .exists()
        {
            script_dir = extraction_dir.join("windows");
        } else if extraction_dir
            .join("deployment")
            .join("windows")
            .join("install-server.ps1")
            .exists()
        {
            script_dir = extraction_dir.join("deployment").join("windows");
        } else {
            // Scan for install-server.ps1 recursively
            let mut found_dir = None;
            if let Ok(entries) = std::fs::read_dir(&extraction_dir) {
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        if entry.path().join("install-server.ps1").exists() {
                            found_dir = Some(entry.path());
                            break;
                        }
                        if entry
                            .path()
                            .join("windows")
                            .join("install-server.ps1")
                            .exists()
                        {
                            found_dir = Some(entry.path().join("windows"));
                            break;
                        }
                        if entry
                            .path()
                            .join("deployment")
                            .join("windows")
                            .join("install-server.ps1")
                            .exists()
                        {
                            found_dir = Some(entry.path().join("deployment").join("windows"));
                            break;
                        }
                    }
                }
            }
            if let Some(dir) = found_dir {
                script_dir = dir;
            } else {
                return Err(
                    "Failed to find install-server.ps1 in the extracted deployment package."
                        .to_string(),
                );
            }
        }

        let verified_build = verify_deployment_package_build(
            &script_dir,
            &extraction_dir,
            Some(target_build_sha.as_str()),
        )?;

        let runner_script_path = temp_dir.join("update-runner.ps1");
        let runner_log_path = temp_dir.join("main-hub-update-transcript.txt");
        // Resolve config path from the detected install root rather than hardcoding.
        let install_root = check_server_local_status()
            .map(|s| s.install_root)
            .unwrap_or_else(|_| contract::DEFAULT_INSTALL_ROOT.to_string());
        let install_root_path = PathBuf::from(&install_root);
        let staged_config_path = script_dir.join(contract::DEPLOY_CONFIG_FILE);
        let resolved_config_path = if let Some(path) =
            resolve_existing_deployment_config(&install_root_path, &script_dir, &extraction_dir)
        {
            path
        } else {
            let searched =
                candidate_deployment_config_paths(&install_root_path, &script_dir, &extraction_dir)
                    .into_iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join("; ");
            return Err(format!(
                "Could not find {config_file} for the Main Hub update. Searched: {searched}",
                config_file = contract::DEPLOY_CONFIG_FILE
            ));
        };
        if resolved_config_path != staged_config_path {
            std::fs::copy(&resolved_config_path, &staged_config_path).map_err(|e| {
                format!(
                    "Failed to stage deployment config from {} to {}: {e}",
                    resolved_config_path.display(),
                    staged_config_path.display()
                )
            })?;
        }
        let config_path = staged_config_path.to_string_lossy().to_string();

        let runner_content = format!(
            r#"$ErrorActionPreference = 'Stop'
$transcriptStarted = $false
$transcriptPath = '{runner_log_path}'
try {{
    Start-Transcript -Path $transcriptPath -Force | Out-Null
    $transcriptStarted = $true
    Write-Host ('Transcript: ' + $transcriptPath)
}} catch {{
    Write-Warning ('Could not start transcript: ' + $_.Exception.Message)
}}
Set-Location -Path '{script_dir}'
Write-Host '========================================='
Write-Host 'Riverside OS: Running Main Hub Update'
Write-Host '========================================='

$installRoot = '{install_root}'
$configPath = '{config_path}'
$serverBin = "$installRoot\server\riverside-server.exe"
$backupBin = "$installRoot\server\riverside-server.exe.bak"
$taskName = '{task_name}'
$serverPort = {server_port}
$deploymentStatusPath = Join-Path $env:ProgramData 'RiversideOS\deployment.status'

function Write-MainHubUpdateStatus([string]$Status, [string]$Message) {{
    try {{
        $statusDir = Split-Path $deploymentStatusPath -Parent
        New-Item -ItemType Directory -Force -Path $statusDir | Out-Null
        [ordered]@{{
            status = $Status
            timestamp = (Get-Date).ToString('o')
            message = $Message
            version = '{target_version}'
            build_sha = '{target_build_short}'
            transcript = $transcriptPath
        }} | ConvertTo-Json | Set-Content -Path $deploymentStatusPath -Encoding UTF8
    }} catch {{
        Write-Warning ('Could not persist Main Hub update status: ' + $_.Exception.Message)
    }}
}}

function Test-RiversideReady {{
    try {{
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$serverPort{ready_ep}" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($response.StatusCode -ne 200) {{ return $false }}
        $payload = $response.Content | ConvertFrom-Json -ErrorAction Stop
        $observedBuild = "$($payload.build_sha)".Trim().ToLowerInvariant()
        return $payload.database.connected -eq $true -and
            $payload.search.authoritative -eq $true -and
            $observedBuild -eq '{target_build_sha}'
    }} catch {{
        return $false
    }}
}}

function Stop-MainHubPortListeners {{
    $ownerProcessIds = @(
        Get-NetTCPConnection -LocalPort $serverPort -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    )
    foreach ($ownerProcessId in $ownerProcessIds) {{
        if (-not $ownerProcessId -or $ownerProcessId -eq $PID) {{ continue }}
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerProcessId" -ErrorAction SilentlyContinue
        $ownerDescription = if ($owner) {{ "$($owner.Name) ($ownerProcessId)" }} else {{ "PID $ownerProcessId" }}
        Write-Host ("Reclaiming Riverside port $serverPort from " + $ownerDescription)
        Stop-Process -Id $ownerProcessId -Force -ErrorAction Stop
    }}
}}

Write-MainHubUpdateStatus 'UPDATING' 'Main Hub update started.'

# Keep the current server running until install-server.ps1 verifies the
# pre-migration database backup and begins its guarded replacement window.
if (Test-Path -Path $serverBin) {{
    Write-Host 'Creating backup of existing server binary...'
    Copy-Item -Path $serverBin -Destination $backupBin -Force -ErrorAction SilentlyContinue
}}

try {{
    Write-Host 'Step 1: Running install-server.ps1...'
    ./install-server.ps1 -ConfigPath $configPath
    $installRootConfig = Join-Path $installRoot '{config_file}'
    if (Test-Path -Path $installRootConfig) {{
        $configPath = $installRootConfig
    }}
    Write-MainHubUpdateStatus 'UPDATING' 'Server files installed; completing the desktop update and final readiness check.'

    Write-Host 'Step 2: Updating client app on this PC (preserving existing config)...'
    ./install-register.ps1 -ConfigPath $configPath -StationMode mainhub

    # Checksum verification
    if (Test-Path -Path $serverBin) {{
        Write-Host 'Step 3: Verifying binary checksum...'
        $hash = Get-FileHash -Path $serverBin -Algorithm SHA256
        Write-Host ('  SHA256: ' + $hash.Hash)
    }} else {{
        throw "Server binary was not installed correctly (missing file)."
    }}

    # install-server.ps1 already performs the one required server restart and
    # verifies /api/ready. Do not create a second outage after updating the
    # local desktop application.
    Write-Host 'Step 4: Confirming Riverside OS Server remains ready...'
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {{
        Start-Sleep -Seconds 2
        if (Test-RiversideReady) {{ $ready = $true; break }}
        Write-Host ('  Waiting... (' + ($i * 2).ToString() + 's)')
    }}
    if ($ready) {{
        Write-Host '  Server is ready.'
    }} else {{
        throw "Server did not respond within 60s."
    }}

    Write-MainHubUpdateStatus 'READY' 'Main Hub update completed and post-restart readiness passed.'

    Write-Host '========================================='
    Write-Host 'Update Complete! Relaunch Riverside on all stations.'
    Write-Host '========================================='
    if ($transcriptStarted) {{
        Stop-Transcript | Out-Null
        $transcriptStarted = $false
    }}
}} catch {{
    Write-Host ('Update failed: ' + $_.Exception.Message) -ForegroundColor Red
    Write-MainHubUpdateStatus 'FAILED' ('Main Hub update failed: ' + $_.Exception.Message)
    $serverStillHealthy = Test-RiversideReady
    if ($serverStillHealthy) {{
        Write-Host 'The existing Riverside server is still healthy; no restart or rollback was needed.'
    }} else {{
        Write-Host 'Attempting emergency restart of the previous Riverside server...'
        try {{
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Get-Process -Name 'riverside-server' -ErrorAction SilentlyContinue |
                ForEach-Object {{ Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }}
            Start-Sleep -Seconds 2
            Stop-MainHubPortListeners
            if (Test-Path -Path $backupBin) {{
                Write-Host 'Rolling back to previous server binary...'
                Copy-Item -Path $backupBin -Destination $serverBin -Force -ErrorAction Stop
                Write-Host 'Binary rollback complete.'
            }}
            if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {{
                Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
                Write-Host ('  Scheduled task ' + $taskName + ' restarted after update failure.')
                $recoveryReady = $false
                for ($i = 0; $i -lt 15; $i++) {{
                    Start-Sleep -Seconds 2
                    if (Test-RiversideReady) {{
                        $recoveryReady = $true
                        break
                    }}
                }}
                if ($recoveryReady) {{
                    Write-Host '  Previous Riverside server is healthy after emergency restart.' -ForegroundColor Green
                }} else {{
                    $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
                    $lastTaskResult = if ($taskInfo) {{ $taskInfo.LastTaskResult }} else {{ 'unavailable' }}
                    Write-Warning ('  Emergency restart did not restore server health. Scheduled task result: ' + $lastTaskResult)
                }}
            }} else {{
                Write-Warning ('  Scheduled task ' + $taskName + ' is missing; use Deployment Manager Repair Server.')
            }}
        }} catch {{
            Write-Warning ('Emergency server restart failed: ' + $_.Exception.Message)
        }}
    }}
    Write-Host 'Please check server logs for details.'
    Write-Host ('Update transcript: ' + $transcriptPath)
    if ($transcriptStarted) {{
        Stop-Transcript | Out-Null
        $transcriptStarted = $false
    }}
    Read-Host 'Press Enter to exit'
    exit 1
}}
Read-Host 'Press Enter to close this window'
"#,
            script_dir = script_dir.to_string_lossy().replace('\'', "''"),
            runner_log_path = runner_log_path.to_string_lossy().replace('\'', "''"),
            install_root = install_root.replace('\'', "''"),
            config_path = config_path.replace('\'', "''"),
            config_file = contract::DEPLOY_CONFIG_FILE,
            task_name = contract::SERVER_TASK_NAME,
            server_port = contract::DEFAULT_SERVER_PORT,
            ready_ep = contract::READY_ENDPOINT,
            target_version = version.replace('\'', "''"),
            target_build_short = target_build_short.replace('\'', "''"),
            target_build_sha = target_build_sha.replace('\'', "''"),
        );

        std::fs::write(&runner_script_path, runner_content)
            .map_err(|e| format!("Failed to write update runner script: {e}"))?;

        let escaped_runner = runner_script_path.to_string_lossy().replace('\'', "''");
        let spawn_cmd = format!(
            "$args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', '{}'); Start-Process -FilePath 'powershell.exe' -ArgumentList $args -Verb RunAs",
            escaped_runner
        );

        let mut spawn_process = Command::new("powershell");
        spawn_process.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &spawn_cmd,
        ]);
        suppress_child_console(&mut spawn_process);
        let status = spawn_process
            .status()
            .map_err(|e| format!("Failed to spawn elevated installer process: {e}"))?;

        if !status.success() {
            return Err("Elevated installer process did not start successfully. User may have rejected the UAC prompt.".to_string());
        }

        Ok(format!(
            "Main Hub update launched from {}{} Package SHA-256 {} verified. If the elevated PowerShell window is not visible, run {} manually. Transcript: {}. Relaunch Riverside when the update completes.",
            asset_name,
            verified_build
                .as_deref()
                .map(|build| format!(" (verified build {build})."))
                .unwrap_or_else(|| ". ".to_string()),
            &verified_package_digest[..12],
            runner_script_path.display(),
            runner_log_path.display()
        ))
    }
}
