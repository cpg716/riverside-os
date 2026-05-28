/// Install-layout contract for a standard Windows Riverside OS server installation.
///
/// # SYNC WARNING
///
/// Every constant here corresponds to a path, name, or port written by the
/// deployment installer scripts. If either side changes, BOTH must be updated:
///
///   - `deployment/windows/install-server.ps1`
///   - `deployment/windows/Start-RiversideDeployment.ps1`
///
/// After any change, run `deployment/windows/validate-install-contract.ps1`
/// to assert that these constants still match the installer. That script is
/// also gated in `ThingsBeforeLaunch.md` (T-45 build quality gate).
///
/// # Why this module exists
///
/// The updater bug (v0.85.0 GO LIVE) was caused by `server_updater.rs`
/// probing `{installRoot}\riverside-server.exe` while `install-server.ps1`
/// actually writes `{installRoot}\server\riverside-server.exe`. Two files
/// owned the same fact with no shared contract and no test connecting them.
/// This module is the fix: one file owns all constants; the validator script
/// is the cross-layer contract test.
pub mod contract {
    /// Default installation root on the server PC.
    /// Overridden at runtime by `server.installRoot` in the deployment config.
    pub const DEFAULT_INSTALL_ROOT: &str = "C:\\RiversideOS";

    /// Path of the server binary relative to the install root.
    /// install-server.ps1: `$serverDir = Join-Path $installRoot "server"` (line ~1130)
    ///                      `Copy-Item $packageServerExe (Join-Path $serverDir "riverside-server.exe")` (line ~1180)
    pub const SERVER_BIN_SUBPATH: &str = "server\\riverside-server.exe";

    /// Deployment config filename at the install root.
    /// Written by install-server.ps1 and read by the Deployment Manager.
    pub const DEPLOY_CONFIG_FILE: &str = "riverside-deployment.config.json";

    /// Deployment summary marker written by install-server.ps1 on successful install.
    /// install-server.ps1: `Set-Content -Path (Join-Path $installRoot "deployment-summary.txt")` (line ~1345)
    /// Used as a fast locality probe: if this file exists, this PC is the Main Hub.
    pub const DEPLOY_SUMMARY_FILE: &str = "deployment-summary.txt";

    /// Windows Scheduled Task name for the Riverside OS server process.
    /// install-server.ps1: `$taskName = "Riverside OS Server"` (line ~1173)
    /// server_updater.rs update runner script also references this name.
    pub const SERVER_TASK_NAME: &str = "Riverside OS Server";

    /// Default TCP port the server listens on.
    /// install-server.ps1: default `httpBind = "0.0.0.0:3000"` (line ~1175)
    pub const DEFAULT_SERVER_PORT: u16 = 3000;

    /// Health check path used to verify the server is ready after an update.
    /// server/src/api/health.rs: `GET /api/health`
    pub const HEALTH_ENDPOINT: &str = "/api/health";

    /// Top-level key in the deployment config JSON that holds server settings.
    pub const CONFIG_SERVER_KEY: &str = "server";

    /// Key within the `server` config object that overrides the install root path.
    pub const CONFIG_INSTALL_ROOT_KEY: &str = "installRoot";
}
