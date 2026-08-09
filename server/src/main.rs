#![allow(warnings)]
#![allow(clippy::all)]
//! Riverside OS Standalone HTTP server (Binary wrapper for library).

use riverside_server::launcher::{launch_server, LauncherConfig};
use riverside_server::observability::{init_tracing_with_optional_otel, ServerLogRing};
use std::path::{Path, PathBuf};
use tracing_subscriber::EnvFilter;

fn load_runtime_environment() -> Result<(), dotenvy::Error> {
    let executable_path = std::env::current_exe().ok();
    load_runtime_environment_from(executable_path.as_deref())
}

fn load_runtime_environment_from(executable_path: Option<&Path>) -> Result<(), dotenvy::Error> {
    if let Some(executable_path) = executable_path {
        if let Some(executable_dir) = executable_path.parent() {
            let installed_env_path = executable_dir.join(".env");
            if installed_env_path.is_file() {
                return dotenvy::from_path_override(installed_env_path);
            }
        }
    }

    match dotenvy::dotenv() {
        Ok(_) => Ok(()),
        Err(dotenvy::Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    load_runtime_environment()?;

    // Setup logging
    let server_log_ring = ServerLogRing::new(800, 2_048);
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("riverside_server=info,warn"));
    init_tracing_with_optional_otel(server_log_ring.clone(), env_filter);

    // Load configuration from environment
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:password@localhost/riverside_os".to_string());

    let bind_addr =
        std::env::var("RIVERSIDE_HTTP_BIND").unwrap_or_else(|_| "0.0.0.0:3000".to_string());

    let frontend_dist = std::env::var("FRONTEND_DIST").ok().map(PathBuf::from);

    let cors_origins = riverside_server::runtime_config::cors_origins_from_env();

    let strict_production = std::env::var("RIVERSIDE_STRICT_PRODUCTION")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false);

    let max_body_bytes = std::env::var("RIVERSIDE_MAX_BODY_BYTES")
        .ok()
        .and_then(|s| s.parse().ok());

    let config = LauncherConfig {
        database_url,
        bind_addr,
        frontend_dist,
        cors_origins,
        strict_production,
        max_body_bytes,
    };

    launch_server(config, server_log_ring).await
}

#[cfg(test)]
mod tests {
    use super::load_runtime_environment_from;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_TEST_LOCK: Mutex<()> = Mutex::new(());
    const TEST_ENV_KEY: &str = "RIVERSIDE_INSTALLED_ENV_PRECEDENCE_TEST";
    const TEST_WINDOWS_PATH_ENV_KEY: &str = "RIVERSIDE_INSTALLED_ENV_WINDOWS_PATH_TEST";

    #[test]
    fn installed_env_overrides_inherited_process_values() {
        let _guard = ENV_TEST_LOCK.lock().expect("environment test lock");
        let original = std::env::var_os(TEST_ENV_KEY);
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let test_dir = std::env::temp_dir().join(format!(
            "riverside-installed-env-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&test_dir).expect("create installed env test directory");
        std::fs::write(test_dir.join(".env"), format!("{TEST_ENV_KEY}=installed\n"))
            .expect("write installed .env");
        let executable_path: PathBuf = test_dir.join("riverside-server.exe");

        std::env::set_var(TEST_ENV_KEY, "stale-task-value");
        let result = load_runtime_environment_from(Some(&executable_path));
        let loaded = std::env::var(TEST_ENV_KEY);

        match original {
            Some(value) => std::env::set_var(TEST_ENV_KEY, value),
            None => std::env::remove_var(TEST_ENV_KEY),
        }
        std::fs::remove_file(test_dir.join(".env")).expect("remove installed .env");
        std::fs::remove_dir(test_dir).expect("remove installed env test directory");

        result.expect("load installed .env");
        assert_eq!(loaded.as_deref(), Ok("installed"));
    }

    #[test]
    fn installed_env_accepts_installer_escaped_windows_paths() {
        let _guard = ENV_TEST_LOCK.lock().expect("environment test lock");
        let original = std::env::var_os(TEST_WINDOWS_PATH_ENV_KEY);
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let test_dir = std::env::temp_dir().join(format!(
            "riverside-installed-windows-env-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&test_dir).expect("create installed env test directory");
        std::fs::write(
            test_dir.join(".env"),
            format!(
                r#"{TEST_WINDOWS_PATH_ENV_KEY}="C:\\Riverside OS\\client\\dist\\\$archive"
"#,
            ),
        )
        .expect("write installed .env");
        let executable_path: PathBuf = test_dir.join("riverside-server.exe");

        let result = load_runtime_environment_from(Some(&executable_path));
        let loaded = std::env::var(TEST_WINDOWS_PATH_ENV_KEY);

        match original {
            Some(value) => std::env::set_var(TEST_WINDOWS_PATH_ENV_KEY, value),
            None => std::env::remove_var(TEST_WINDOWS_PATH_ENV_KEY),
        }
        std::fs::remove_file(test_dir.join(".env")).expect("remove installed .env");
        std::fs::remove_dir(test_dir).expect("remove installed env test directory");

        result.expect("load installer-escaped installed .env");
        assert_eq!(
            loaded.as_deref(),
            Ok(r#"C:\Riverside OS\client\dist\$archive"#)
        );
    }
}
