use serde::{Deserialize, Serialize};
use std::process::Command;
use tokio::process::Command as TokioCommand;
use anyhow::{Result, Context};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TailscaleStatus {
    #[serde(rename = "Self")]
    pub self_node: Option<TailscaleNode>,
    #[serde(rename = "BackendState")]
    pub backend_state: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TailscaleNode {
    #[serde(rename = "ID")]
    pub id: String,
    #[serde(rename = "HostName")]
    pub hostname: String,
    #[serde(rename = "DNSName")]
    pub dns_name: String,
    #[serde(rename = "TailscaleIPs")]
    pub tailscale_ips: Vec<String>,
}

pub struct RemoteAccessManager {
    binary_path: String,
}

impl RemoteAccessManager {
    pub fn new() -> Self {
        let path = std::env::var("RIVERSIDE_TAILSCALE_BINARY_PATH")
            .unwrap_or_else(|_| "tailscale".to_string());
        Self { binary_path: path }
    }

    pub async fn get_status(&self) -> Result<TailscaleStatus> {
        let output = TokioCommand::new(&self.binary_path)
            .arg("status")
            .arg("--json")
            .output()
            .await
            .context("Failed to execute tailscale status")?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("Tailscale error: {}", err));
        }

        let status: TailscaleStatus = serde_json::from_slice(&output.stdout)
            .context("Failed to parse tailscale status JSON")?;
        Ok(status)
    }

    pub async fn connect(&self, auth_key: &str) -> Result<()> {
        let output = TokioCommand::new(&self.binary_path)
            .arg("up")
            .arg(format!("--authkey={}", auth_key))
            .output()
            .await
            .context("Failed to execute tailscale up")?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("Tailscale connect failed: {}", err));
        }

        Ok(())
    }

    pub async fn disconnect(&self) -> Result<()> {
        let output = TokioCommand::new(&self.binary_path)
            .arg("down")
            .output()
            .await
            .context("Failed to execute tailscale down")?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("Tailscale disconnect failed: {}", err));
        }

        Ok(())
    }
}
