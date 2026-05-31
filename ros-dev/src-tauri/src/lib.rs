#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::Semaphore;

#[derive(Serialize, Deserialize, Clone)]
pub struct DiscoveredServer {
    pub url: String,
    pub name: Option<String>,
    pub tailscale: bool,
    pub latency_ms: u32,
}

// --- Keychain Commands ---

#[tauri::command]
fn save_secure_pin(profile_id: &str, pin: &str) -> Result<(), String> {
    let entry =
        Entry::new("com.riverside.ros-dev-center", profile_id).map_err(|e| e.to_string())?;
    entry.set_password(pin).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_secure_pin(profile_id: &str) -> Result<String, String> {
    let entry =
        Entry::new("com.riverside.ros-dev-center", profile_id).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(pin) => Ok(pin),
        Err(keyring::Error::NoEntry) => Ok("".to_string()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn delete_secure_pin(profile_id: &str) -> Result<(), String> {
    let entry =
        Entry::new("com.riverside.ros-dev-center", profile_id).map_err(|e| e.to_string())?;
    match entry.delete_password() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// --- Network Discovery Helpers & Commands ---

fn get_local_subnet_prefix() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let local_addr = socket.local_addr().ok()?;
    let ip_str = local_addr.ip().to_string();
    let parts: Vec<&str> = ip_str.split('.').collect();
    if parts.len() == 4 {
        Some(format!("{}.{}.{}", parts[0], parts[1], parts[2]))
    } else {
        None
    }
}

async fn get_tailscale_ips() -> Vec<(String, String)> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(1000))
        .build()
    {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let res = client
        .get("http://100.100.100.100:8080/localapi/v0/status")
        .send()
        .await;
    if let Ok(resp) = res {
        if let Ok(json) = resp.json::<serde_json::Value>().await {
            let mut list = vec![];
            if let Some(peers) = json.get("Peer").and_then(|p| p.as_array()) {
                for peer in peers {
                    let dns_name = peer
                        .get("DNSName")
                        .and_then(|d| d.as_str())
                        .map(|s| s.trim_end_matches('.').to_string())
                        .or_else(|| {
                            peer.get("HostName")
                                .and_then(|h| h.as_str())
                                .map(|s| s.to_string())
                        });

                    if let Some(ips_arr) = peer.get("TailscaleIPs").and_then(|i| i.as_array()) {
                        if let Some(ip) = ips_arr.first().and_then(|ip| ip.as_str()) {
                            list.push((ip.to_string(), dns_name.unwrap_or_else(|| ip.to_string())));
                        }
                    }
                }
            }
            return list;
        }
    }
    vec![]
}

async fn scan_ip(
    ip_str: String,
    host_name: Option<String>,
    is_ts: bool,
) -> Option<DiscoveredServer> {
    let start = std::time::Instant::now();
    let ip: IpAddr = ip_str.parse().ok()?;
    let addr = SocketAddr::new(ip, 3000);

    let stream = TcpStream::connect(&addr);
    if let Ok(Ok(_)) = tokio::time::timeout(Duration::from_millis(400), stream).await {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_millis(1000))
            .build()
        {
            Ok(c) => c,
            Err(_) => return None,
        };
        let url = format!("http://{ip_str}:3000");
        let req = client
            .get(format!("{url}/api/health"))
            .header("x-riverside-staff-code", "");

        if let Ok(res) = req.send().await {
            if res.status().is_success() {
                let version = if let Ok(json) = res.json::<serde_json::Value>().await {
                    json.get("version")
                        .and_then(|v| v.as_str())
                        .map(|v| v.to_string())
                } else {
                    None
                };
                let name = match (host_name, version) {
                    (Some(h), Some(v)) => Some(format!("{h} (v{v})")),
                    (None, Some(v)) => Some(format!("Riverside OS v{v}")),
                    (Some(h), None) => Some(h),
                    (None, None) => Some("Riverside OS".to_string()),
                };
                return Some(DiscoveredServer {
                    url,
                    name,
                    tailscale: is_ts,
                    latency_ms: start.elapsed().as_millis() as u32,
                });
            }
        }
    }
    None
}

#[tauri::command]
async fn discover_servers() -> Result<Vec<DiscoveredServer>, String> {
    let mut join_set = tokio::task::JoinSet::new();
    let semaphore = Arc::new(Semaphore::new(40));

    // 1. Queue Tailscale peers
    let ts_peers = get_tailscale_ips().await;
    for (ip, host_name) in ts_peers {
        let sem = semaphore.clone();
        join_set.spawn(async move {
            let _permit = sem.acquire().await.ok();
            scan_ip(ip, Some(host_name), true).await
        });
    }

    // 2. Queue local subnet
    if let Some(prefix) = get_local_subnet_prefix() {
        for i in 1..=254 {
            let ip = format!("{prefix}.{i}");
            let sem = semaphore.clone();
            join_set.spawn(async move {
                let _permit = sem.acquire().await.ok();
                scan_ip(ip, None, false).await
            });
        }
    } else {
        let fallbacks = vec!["192.168.1", "192.168.0", "10.0.0", "10.0.1"];
        for prefix in fallbacks {
            for i in 1..=254 {
                let ip = format!("{prefix}.{i}");
                let sem = semaphore.clone();
                join_set.spawn(async move {
                    let _permit = sem.acquire().await.ok();
                    scan_ip(ip, None, false).await
                });
            }
        }
    }

    let mut discovered = vec![];
    while let Some(res) = join_set.join_next().await {
        if let Ok(Some(server)) = res {
            discovered.push(server);
        }
    }

    discovered.sort_by_key(|s| s.latency_ms);
    Ok(discovered)
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TailscaleStatus {
    pub running: bool,
    pub version: Option<String>,
    pub tailnet: Option<String>,
}

#[tauri::command]
async fn check_tailscale_status() -> TailscaleStatus {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
    {
        Ok(c) => c,
        Err(_) => return TailscaleStatus { running: false, version: None, tailnet: None },
    };

    let res = client
        .get("http://100.100.100.100:8080/localapi/v0/status")
        .send()
        .await;

    if let Ok(resp) = res {
        if let Ok(json) = resp.json::<serde_json::Value>().await {
            let running = json.get("BackendState").and_then(|s| s.as_str()) == Some("Running");
            let version = json.get("Version").and_then(|v| v.as_str()).map(|s| s.to_string());
            let tailnet = json.get("CurrentTailnet")
                .and_then(|t| t.get("Name"))
                .and_then(|n| n.as_str())
                .map(|s| s.to_string());
            return TailscaleStatus {
                running,
                version,
                tailnet,
            };
        }
    }
    TailscaleStatus { running: false, version: None, tailnet: None }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            save_secure_pin,
            get_secure_pin,
            delete_secure_pin,
            discover_servers,
            check_tailscale_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
