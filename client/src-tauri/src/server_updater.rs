#![allow(unused_imports, dead_code)]
use serde::Deserialize;
use std::path::{Path, PathBuf};

use std::process::Command;
use tauri::{AppHandle, command};

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
}

#[derive(Deserialize, Debug)]
struct GithubRelease {
    assets: Vec<GithubAsset>,
}

#[command]
pub fn check_server_local_status() -> Result<ServerLocalStatus, String> {
    let install_root = "C:\\RiversideOS".to_string();
    let config_path = Path::new("C:\\RiversideOS\\riverside-deployment.config.json");
    let server_bin_path = Path::new("C:\\RiversideOS\\riverside-server.exe");

    // On non-Windows platforms, we treat it as not local
    #[cfg(windows)]
    let is_local = server_bin_path.exists() || config_path.exists();
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
pub async fn download_and_run_server_installer(version: String) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        let _version = version;
        return Err("Server updates can only be executed on a Windows Server Host PC.".to_string());
    }

    #[cfg(windows)]
    {
        // 1. Fetch release assets from GitHub API to find the deployment zip
        let tag_name = format!("v{}", version);
        let url = format!(
            "https://api.github.com/repos/cpg716/riverside-os/releases/tags/{}",
            tag_name
        );

        let client = reqwest::Client::builder()
            .user_agent("riverside-pos")
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

        let res = client
            .get(&url)
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

        let asset = release
            .assets
            .into_iter()
            .find(|a| a.name.ends_with("-Windows-Deployment.zip"))
            .ok_or_else(|| {
                format!(
                    "Could not find Windows Deployment ZIP asset in release tag {}",
                    tag_name
                )
            })?;

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

        // 3. Extract the ZIP using PowerShell
        let extraction_dir = temp_dir.join("extracted");
        std::fs::create_dir_all(&extraction_dir)
            .map_err(|e| format!("Failed to create extraction folder: {e}"))?;

        let extract_script = format!(
            "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
            zip_path.to_string_lossy().replace('\'', "''"),
            extraction_dir.to_string_lossy().replace('\'', "''")
        );

        let output = Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &extract_script])
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
        } else if extraction_dir.join("windows").join("install-server.ps1").exists() {
            script_dir = extraction_dir.join("windows");
        } else if extraction_dir.join("deployment").join("windows").join("install-server.ps1").exists() {
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
                        if entry.path().join("windows").join("install-server.ps1").exists() {
                            found_dir = Some(entry.path().join("windows"));
                            break;
                        }
                        if entry.path().join("deployment").join("windows").join("install-server.ps1").exists() {
                            found_dir = Some(entry.path().join("deployment").join("windows"));
                            break;
                        }
                    }
                }
            }
            if let Some(dir) = found_dir {
                script_dir = dir;
            } else {
                return Err("Failed to find install-server.ps1 in the extracted deployment package.".to_string());
            }
        }

        let runner_script_path = temp_dir.join("update-runner.ps1");
        
        let config_path = "C:\\RiversideOS\\riverside-deployment.config.json";
        
        let runner_content = format!(
            r#"$ErrorActionPreference = 'Stop'
Set-Location -Path '{script_dir}'
Write-Host '========================================='
Write-Host 'Riverside OS: Running Server Update'
Write-Host '========================================='
Write-Host 'Step 1: Running install-server.ps1...'
./install-server.ps1 -ConfigPath '{config_path}'
Write-Host 'Step 2: Running repair-bootstrap-admin.ps1...'
./repair-bootstrap-admin.ps1 -ConfigPath '{config_path}'
Write-Host 'Step 3: Running install-register.ps1...'
./install-register.ps1 -ConfigPath '{config_path}' -StationMode 'backoffice'
Write-Host '========================================='
Write-Host 'Update Complete! Press any key to exit.'
Write-Host '========================================='
Read-Host
"#,
            script_dir = script_dir.to_string_lossy().replace('\'', "''"),
            config_path = config_path.replace('\'', "''")
        );

        std::fs::write(&runner_script_path, runner_content)
            .map_err(|e| format!("Failed to write update runner script: {e}"))?;

        // 5. Spawn PowerShell elevated with Verb RunAs to execute the runner
        let spawn_cmd = format!(
            "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"{}\"' -Verb RunAs",
            runner_script_path.to_string_lossy().replace('"', "`\"")
        );

        let status = Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &spawn_cmd])
            .status()
            .map_err(|e| format!("Failed to spawn elevated installer process: {e}"))?;

        if !status.success() {
            return Err("Elevated installer process did not start successfully. User may have rejected the UAC prompt.".to_string());
        }

        Ok("Server update launched. Monitor the progress in the opened PowerShell window. Relaunch this client app when the update is complete.".to_string())
    }
}
