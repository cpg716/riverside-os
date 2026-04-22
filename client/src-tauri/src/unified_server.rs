use riverside_server::launcher::{launch_server_with_ready_signal, LaunchReady, LauncherConfig};
use riverside_server::observability::ServerLogRing;
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UnifiedServerLifecycle {
    Stopped,
    Starting,
    Running,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct UnifiedServerStatus {
    pub lifecycle: UnifiedServerLifecycle,
    pub bind_addr: Option<String>,
    pub listen_port: Option<u16>,
    pub frontend_dist: Option<String>,
    pub message: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct UnifiedHostNetworkIdentity {
    pub hostname: Option<String>,
    pub lan_ipv4s: Vec<String>,
}

impl Default for UnifiedServerStatus {
    fn default() -> Self {
        Self {
            lifecycle: UnifiedServerLifecycle::Stopped,
            bind_addr: None,
            listen_port: None,
            frontend_dist: None,
            message: Some("Unified host is stopped.".to_string()),
            last_error: None,
        }
    }
}

pub struct UnifiedServerState {
    status: Mutex<UnifiedServerStatus>,
}

impl Default for UnifiedServerState {
    fn default() -> Self {
        Self {
            status: Mutex::new(UnifiedServerStatus::default()),
        }
    }
}

fn port_from_bind_addr(bind_addr: &str) -> Option<u16> {
    bind_addr.rsplit(':').next()?.parse().ok()
}

fn update_status(
    state: &UnifiedServerState,
    f: impl FnOnce(&mut UnifiedServerStatus),
) -> Result<(), String> {
    let mut status = state
        .status
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    f(&mut status);
    Ok(())
}

fn read_status(state: &UnifiedServerState) -> Result<UnifiedServerStatus, String> {
    state
        .status
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "Lock poisoned".to_string())
}

fn candidate_frontend_dist_paths(
    frontend_dist_env: Option<String>,
    resource_dir: Option<PathBuf>,
    current_dir: Option<PathBuf>,
    current_exe: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut out = Vec::new();

    if let Some(frontend_dist) = frontend_dist_env {
        let trimmed = frontend_dist.trim();
        if !trimmed.is_empty() {
            out.push(PathBuf::from(trimmed));
        }
    }

    if let Some(resource_dir) = resource_dir {
        out.push(resource_dir.join("dist"));
        out.push(resource_dir.clone());
    }

    if let Some(current_dir) = current_dir {
        out.push(current_dir.join("../dist"));
        out.push(current_dir.join("dist"));
    }

    if let Some(exe) = current_exe {
        if let Some(exe_dir) = exe.parent() {
            out.push(exe_dir.join("dist"));
            out.push(exe_dir.join("../dist"));
            out.push(exe_dir.join("../resources/dist"));
        }
    }

    out
}

fn resolve_host_frontend_dist(app: &AppHandle) -> Result<PathBuf, String> {
    resolve_host_frontend_dist_from_candidates(
        candidate_frontend_dist_paths(
            std::env::var("FRONTEND_DIST").ok(),
            app.path().resource_dir().ok(),
            std::env::current_dir().ok(),
            std::env::current_exe().ok(),
        ),
        std::env::current_dir().map_err(|e| format!("Could not resolve current directory: {e}"))?,
    )
}

fn resolve_host_frontend_dist_from_candidates(
    candidates: Vec<PathBuf>,
    current_dir: PathBuf,
) -> Result<PathBuf, String> {
    for candidate in candidates {
        let resolved = if candidate.is_absolute() {
            candidate
        } else {
            current_dir.join(candidate)
        };
        if resolved.is_dir() && resolved.join("index.html").is_file() {
            return Ok(resolved);
        }
    }

    Err(
        "Could not find a frontend bundle for satellite clients. Build and deploy the SPA dist, or set FRONTEND_DIST to a directory containing index.html."
            .to_string(),
    )
}

fn host_message(bind_addr: &str, frontend_dist: &PathBuf) -> String {
    format!(
        "Unified host is running on {bind_addr} and serving satellite clients from {}.",
        frontend_dist.display()
    )
}

fn normalize_hostname(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().trim_end_matches('.').to_string())
        .filter(|value| !value.is_empty())
}

fn is_candidate_lan_ipv4(ip: &Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_link_local() && !ip.is_broadcast() && !ip.is_unspecified()
}

fn collect_lan_ipv4s(entries: Vec<(String, IpAddr)>) -> Vec<String> {
    let mut private = Vec::new();
    let mut other = Vec::new();

    for (_interface_name, addr) in entries {
        let IpAddr::V4(ipv4) = addr else {
            continue;
        };
        if !is_candidate_lan_ipv4(&ipv4) {
            continue;
        }

        let rendered = ipv4.to_string();
        if ipv4.is_private() {
            if !private.contains(&rendered) {
                private.push(rendered);
            }
        } else if !other.contains(&rendered) {
            other.push(rendered);
        }
    }

    private.extend(other);
    private
}

#[tauri::command]
pub fn get_unified_host_network_identity() -> UnifiedHostNetworkIdentity {
    let hostname = normalize_hostname(
        std::env::var("COMPUTERNAME")
            .ok()
            .or_else(|| std::env::var("HOSTNAME").ok()),
    );

    let lan_ipv4s = local_ip_address::list_afinet_netifas()
        .map(collect_lan_ipv4s)
        .unwrap_or_default();

    UnifiedHostNetworkIdentity {
        hostname,
        lan_ipv4s,
    }
}

#[tauri::command]
pub async fn start_unified_server(
    app: AppHandle,
    state: State<'_, UnifiedServerState>,
    database_url: String,
    port: u16,
) -> Result<UnifiedServerStatus, String> {
    let current = read_status(&state)?;
    if matches!(
        current.lifecycle,
        UnifiedServerLifecycle::Starting | UnifiedServerLifecycle::Running
    ) {
        return Ok(current);
    }

    let frontend_dist = resolve_host_frontend_dist(&app)?;
    let bind_addr = format!("0.0.0.0:{port}");
    let frontend_dist_display = frontend_dist.display().to_string();

    update_status(&state, |status| {
        status.lifecycle = UnifiedServerLifecycle::Starting;
        status.bind_addr = Some(bind_addr.clone());
        status.listen_port = Some(port);
        status.frontend_dist = Some(frontend_dist_display.clone());
        status.message = Some(format!(
            "Starting unified host on {bind_addr}. Satellite clients will load {}.",
            frontend_dist_display
        ));
        status.last_error = None;
    })?;

    let config = LauncherConfig {
        database_url,
        stripe_secret_key: std::env::var("STRIPE_SECRET_KEY").unwrap_or_default(),
        stripe_public_key: std::env::var("STRIPE_PUBLIC_KEY").unwrap_or_default(),
        stripe_webhook_secret: std::env::var("STRIPE_WEBHOOK_SECRET").ok(),
        bind_addr: bind_addr.clone(),
        frontend_dist: Some(frontend_dist.clone()),
        cors_origins: vec![],
        strict_production: false,
        max_body_bytes: None,
    };

    let server_log_ring = ServerLogRing::new(800, 2048);
    let (ready_tx, ready_rx) = oneshot::channel::<Result<LaunchReady, String>>();
    let app_handle = app.clone();

    tokio::spawn(async move {
        let result = launch_server_with_ready_signal(config, server_log_ring, ready_tx).await;
        let app_state = app_handle.state::<UnifiedServerState>();
        let _ = update_status(&app_state, |status| match result {
            Ok(()) => {
                status.lifecycle = UnifiedServerLifecycle::Stopped;
                status.message = Some("Unified host stopped.".to_string());
            }
            Err(error) => {
                status.lifecycle = UnifiedServerLifecycle::Failed;
                status.last_error = Some(error.to_string());
                status.message =
                    Some("Unified host failed. Review the error and retry.".to_string());
            }
        });
    });

    match ready_rx.await {
        Ok(Ok(ready)) => {
            let ready_message = host_message(&ready.bind_addr, &ready.frontend_dist);
            update_status(&state, |status| {
                status.lifecycle = UnifiedServerLifecycle::Running;
                status.bind_addr = Some(ready.bind_addr.clone());
                status.listen_port = port_from_bind_addr(&ready.bind_addr);
                status.frontend_dist = Some(ready.frontend_dist.display().to_string());
                status.message = Some(ready_message.clone());
                status.last_error = None;
            })?;
            read_status(&state)
        }
        Ok(Err(error)) => {
            update_status(&state, |status| {
                status.lifecycle = UnifiedServerLifecycle::Failed;
                status.last_error = Some(error.clone());
                status.message = Some("Unified host could not start.".to_string());
            })?;
            Err(error)
        }
        Err(_) => {
            let error = "Unified host exited before reporting readiness.".to_string();
            update_status(&state, |status| {
                status.lifecycle = UnifiedServerLifecycle::Failed;
                status.last_error = Some(error.clone());
                status.message = Some("Unified host could not start.".to_string());
            })?;
            Err(error)
        }
    }
}

#[tauri::command]
pub fn get_unified_server_status(
    state: State<'_, UnifiedServerState>,
) -> Result<UnifiedServerStatus, String> {
    read_status(&state)
}

#[cfg(test)]
mod tests {
    use super::{
        candidate_frontend_dist_paths, collect_lan_ipv4s, is_candidate_lan_ipv4,
        normalize_hostname, port_from_bind_addr, resolve_host_frontend_dist_from_candidates,
    };
    use std::fs;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    use std::path::PathBuf;

    #[test]
    fn parses_port_from_bind_address() {
        assert_eq!(port_from_bind_addr("0.0.0.0:3000"), Some(3000));
        assert_eq!(port_from_bind_addr("127.0.0.1:8443"), Some(8443));
        assert_eq!(port_from_bind_addr("invalid"), None);
    }

    #[test]
    fn candidate_paths_include_frontend_dist_override_first() {
        let sentinel = "/tmp/riverside-host-dist";
        let candidates =
            candidate_frontend_dist_paths(Some(sentinel.to_string()), None, None, None);

        assert_eq!(candidates.first(), Some(&PathBuf::from(sentinel)));
    }

    #[test]
    fn current_dir_dist_candidate_is_considered() {
        let temp_root = std::env::temp_dir().join(format!(
            "ros-host-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        let nested = temp_root.join("workspace").join("client").join("src-tauri");
        let dist = temp_root.join("workspace").join("client").join("dist");
        fs::create_dir_all(&nested).expect("nested dirs");
        fs::create_dir_all(&dist).expect("dist dir");
        fs::write(dist.join("index.html"), "<!doctype html>").expect("index");

        let original_dir = std::env::current_dir().expect("current dir");
        std::env::set_current_dir(&nested).expect("set current dir");

        let candidates = candidate_frontend_dist_paths(None, None, Some(nested.clone()), None);

        assert!(candidates.iter().any(|p| p == &nested.join("../dist")));

        std::env::set_current_dir(original_dir).expect("restore dir");
        fs::remove_dir_all(temp_root).expect("cleanup");
    }

    #[test]
    fn resolves_existing_frontend_dist_with_index_html() {
        let temp_root = std::env::temp_dir().join(format!(
            "ros-host-dist-success-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        let current_dir = temp_root.join("workspace");
        let dist = current_dir.join("dist");
        fs::create_dir_all(&dist).expect("dist dir");
        fs::write(dist.join("index.html"), "<!doctype html>").expect("index");

        let resolved = resolve_host_frontend_dist_from_candidates(
            vec![PathBuf::from("dist")],
            current_dir.clone(),
        )
        .expect("resolved dist");

        assert_eq!(resolved, dist);

        fs::remove_dir_all(temp_root).expect("cleanup");
    }

    #[test]
    fn fails_when_no_candidate_contains_index_html() {
        let temp_root = std::env::temp_dir().join(format!(
            "ros-host-dist-failure-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        fs::create_dir_all(&temp_root).expect("temp root");

        let error = resolve_host_frontend_dist_from_candidates(
            vec![PathBuf::from("missing-dist")],
            temp_root.clone(),
        )
        .expect_err("missing bundle should fail");

        assert!(error.contains("Could not find a frontend bundle"));

        fs::remove_dir_all(temp_root).expect("cleanup");
    }

    #[test]
    fn normalizes_hostname_values() {
        assert_eq!(
            normalize_hostname(Some(" shop-host.\n".to_string())),
            Some("shop-host".to_string())
        );
        assert_eq!(normalize_hostname(Some("   ".to_string())), None);
        assert_eq!(normalize_hostname(None), None);
    }

    #[test]
    fn filters_loopback_and_link_local_ipv4_addrs() {
        assert!(!is_candidate_lan_ipv4(&Ipv4Addr::new(127, 0, 0, 1)));
        assert!(!is_candidate_lan_ipv4(&Ipv4Addr::new(169, 254, 10, 20)));
        assert!(is_candidate_lan_ipv4(&Ipv4Addr::new(192, 168, 1, 42)));
    }

    #[test]
    fn collects_private_lan_ipv4s_before_other_ipv4s() {
        let lan_ips = collect_lan_ipv4s(vec![
            ("lo".to_string(), IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))),
            (
                "wan".to_string(),
                IpAddr::V4(Ipv4Addr::new(203, 0, 113, 10)),
            ),
            (
                "lan".to_string(),
                IpAddr::V4(Ipv4Addr::new(192, 168, 0, 25)),
            ),
            ("v6".to_string(), IpAddr::V6(Ipv6Addr::LOCALHOST)),
            (
                "dup".to_string(),
                IpAddr::V4(Ipv4Addr::new(192, 168, 0, 25)),
            ),
        ]);

        assert_eq!(
            lan_ips,
            vec!["192.168.0.25".to_string(), "203.0.113.10".to_string()]
        );
    }
}
