use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::process::Command as TokioCommand;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TailscaleStatus {
    #[serde(rename = "Self")]
    pub self_node: Option<TailscaleNode>,
    #[serde(rename = "BackendState")]
    pub backend_state: String,
    /// Whether MagicDNS is enabled on the tailnet
    #[serde(rename = "MagicDNS", default)]
    pub magic_dns: bool,
    /// The tailnet name (e.g. "example.tailnet.net")
    #[serde(rename = "TailnetName", default)]
    pub tailnet_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct TailscalePeerInfo {
    #[serde(rename = "UserProfile")]
    pub user_profile: Option<TailscaleUserProfile>,
    #[serde(rename = "NodeKey")]
    pub node_key: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TailscaleUserProfile {
    #[serde(rename = "LoginName")]
    pub login_name: String,
    #[serde(rename = "DisplayName")]
    pub display_name: String,
    #[serde(rename = "ProfilePicURL")]
    pub profile_pic_url: Option<String>,
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

impl Default for RemoteAccessManager {
    fn default() -> Self {
        Self::new()
    }
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
            return Err(anyhow::anyhow!("Tailscale error: {err}"));
        }

        let status: TailscaleStatus = serde_json::from_slice(&output.stdout)
            .context("Failed to parse tailscale status JSON")?;
        Ok(status)
    }

    pub async fn connect(&self, auth_key: &str) -> Result<()> {
        let output = TokioCommand::new(&self.binary_path)
            .arg("up")
            .arg(format!("--authkey={auth_key}"))
            .output()
            .await
            .context("Failed to execute tailscale up")?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("Tailscale connect failed: {err}"));
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
            return Err(anyhow::anyhow!("Tailscale disconnect failed: {err}"));
        }

        Ok(())
    }

    /// Identify a remote peer by their Tailscale IP using 'tailscale whois'.
    pub async fn whois(&self, remote_ip: &str) -> Result<TailscalePeerInfo> {
        let output = TokioCommand::new(&self.binary_path)
            .arg("whois")
            .arg("--json")
            .arg(remote_ip)
            .output()
            .await
            .context("Failed to execute tailscale whois")?;

        if !output.status.success() {
            // If the IP is not a Tailscale IP, whois might fail. Return a default/empty.
            return Ok(TailscalePeerInfo::default());
        }

        let info: TailscalePeerInfo = serde_json::from_slice(&output.stdout)
            .context("Failed to parse tailscale whois JSON")?;
        Ok(info)
    }

    /// Provision a TLS certificate for the MagicDNS name using 'tailscale cert'.
    pub async fn generate_cert(&self, dns_name: &str) -> Result<()> {
        let output = TokioCommand::new(&self.binary_path)
            .arg("cert")
            .arg(dns_name)
            .output()
            .await
            .context("Failed to execute tailscale cert")?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("Tailscale cert failed: {err}"));
        }

        Ok(())
    }
}
