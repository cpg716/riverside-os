#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function read(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

function assertIncludes(path, text, reason) {
  const body = read(path);
  if (!body.includes(text)) {
    fail(`${path}: missing ${JSON.stringify(text)} (${reason})`);
  }
}

function assertNotIncludes(path, text, reason) {
  const body = read(path);
  if (body.includes(text)) {
    fail(`${path}: forbidden ${JSON.stringify(text)} (${reason})`);
  }
}

function collectFiles(dir, predicate) {
  const base = join(repoRoot, dir);
  const out = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...collectFiles(rel, predicate));
    if (entry.isFile() && predicate(entry.name)) out.push(rel);
  }
  return out;
}

function parsePowerShell(path, source) {
  const tempDir = mkdtempSync(join(tmpdir(), "ros-deploy-ps-"));
  const tempPath = join(tempDir, "parse.ps1");
  writeFileSync(tempPath, source, "utf8");
  const pwsh = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-Command",
      `$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${tempPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{Write-Error "$($_.Extent.StartLineNumber):$($_.Extent.StartColumnNumber) $($_.Message)"};exit 1}`,
    ],
    { encoding: "utf8" },
  );
  rmSync(tempDir, { recursive: true, force: true });
  if (pwsh.error?.code === "ENOENT") {
    return;
  }
  if (pwsh.status !== 0) {
    fail(`${path}: PowerShell parse failed\n${pwsh.stderr || pwsh.stdout}`);
  }
}

function renderMainHubUpdateRunner(source) {
  const match = source.match(/let runner_content = format!\(\s*r#"\n?([\s\S]*?)\n\s*"#,/);
  if (!match) {
    fail("client/src-tauri/src/server_updater.rs: unable to locate generated update-runner.ps1 template");
    return "";
  }

  const replacements = {
    runner_log_path:
      "C:\\Users\\Admin\\AppData\\Local\\Temp\\riverside-update-0.90.0\\main-hub-update-transcript.txt",
    script_dir:
      "C:\\Users\\Admin\\AppData\\Local\\Temp\\riverside-update-0.90.0\\deployment\\windows",
    install_root: "C:\\ProgramData\\riverside-os",
    config_path: "C:\\ProgramData\\riverside-os\\riverside-deployment.config.json",
    task_name: "Riverside OS Server",
    server_port: "3000",
    health_ep: "/api/health",
  };

  let rendered = match[1];
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }
  return rendered.replaceAll("{{", "{").replaceAll("}}", "}");
}

const managerApp = "deployment/manager-app/src/App.tsx";
assertNotIncludes(
  managerApp,
  "Installing Updates...",
  "install wizard must not call fresh installs updates",
);
assertNotIncludes(
  managerApp,
  "Install or update this station",
  "deployment header must include repair and not blur install/update only",
);
for (const copy of [
  "Installing Main Hub",
  "Installing Back Office App",
  "Installing Register #1 App",
  "Live installer output is shown in the full Execution Output console below.",
  "runMainHubDesktopSequence: true",
  "wizardExecutionStatus === 'success'",
  "Install failed. Review or copy the execution log before retrying.",
  "const MAIN_HUB_DATABASE_HOST = '127.0.0.1'",
  "newConfig.server.database.host = MAIN_HUB_DATABASE_HOST",
  "await saveMainHubConfig('main-hub')",
  "disabled={role === 'main-hub'}",
]) {
  assertIncludes(managerApp, copy, "install execution step must be role-specific and visible");
}
assertNotIncludes(
  managerApp,
  "scriptName === 'install-server.ps1' && step === 3",
  "Main Hub wizard sequence must not depend on stale React step state",
);

const managerRunner = "deployment/manager-app/src-tauri/src/lib.rs";
for (const copy of [
  "Launching {} from {}",
  "Arguments: {args_display}",
  "PowerShell process started; waiting for script output...",
]) {
  assertIncludes(managerRunner, copy, "deployment runner must emit immediate launch logs");
}

const registerInstaller = "deployment/windows/install-register.ps1";
assertIncludes(
  registerInstaller,
  "[switch]$Launch",
  "desktop app launch must be opt-in for installer/update workflows",
);
assertIncludes(
  registerInstaller,
  "if ($Launch -and -not $NoLaunch)",
  "install-register.ps1 must not auto-launch the desktop app unless explicitly requested",
);
assertNotIncludes(
  registerInstaller,
  "if (-not $NoLaunch)",
  "install-register.ps1 must not default to auto-launching the desktop app",
);
assertIncludes(
  registerInstaller,
  '$Config.register.tagPrinter | Add-Member -NotePropertyName "language" -NotePropertyValue "epl" -Force',
  "install-register.ps1 must preserve the Riverside LP 2844 EPL tag-printer default",
);

const deploymentConfigExample = "deployment/windows/riverside-deployment.config.example.json";
assertIncludes(
  deploymentConfigExample,
  '"language": "epl"',
  "deployment config example must carry the Riverside LP 2844 EPL tag-printer default",
);

const deploymentPackageBuilder = "deployment/windows/build-deployment-package.ps1";
assertIncludes(
  deploymentPackageBuilder,
  "counterpoint-bridge-gui",
  "Windows deployment package must include the Counterpoint Bridge GUI installer directory",
);
assertIncludes(
  deploymentPackageBuilder,
  "rev-parse --short=8 HEAD",
  "Windows deployment ZIP names must use the same 8-character build prefix as updater metadata",
);
for (const obsolete of [
  "CounterpointSyncSourcePath",
  "Copy-CounterpointSyncWorkbench",
  "counterpoint-sync-workbench",
  "Start-CounterpointSYNCWorkbench.ps1",
  "Start-CounterpointSYNCWorkbench.cmd",
  "set-counterpoint-bridge-token.ps1",
  "Set-CounterpointBridgeToken.cmd",
  "NodeRuntimePath",
]) {
  assertNotIncludes(
    deploymentPackageBuilder,
    obsolete,
    "Windows deployment package must not include obsolete standalone Counterpoint SYNC Workbench or token helper payloads",
  );
}
assertNotIncludes(
  deploymentPackageBuilder,
  "counterpoint-sync-bridge",
  "Bridge GUI assets must not be placed in a misleading SYNC Workbench folder",
);
assertNotIncludes(
  ".github/workflows/windows-deployment-package.yml",
  "-NodeRuntimePath",
  "Windows deployment workflow must not pass a Node runtime for the removed standalone SYNC Workbench",
);
for (const forbidden of [
  "path: dist/deployment/*.zip",
  "gh release upload $tag $zipFiles.FullName --clobber",
]) {
  assertNotIncludes(
    ".github/workflows/windows-deployment-package.yml",
    forbidden,
    "Windows deployment release must not publish every ZIP in dist/deployment because tracked or stale ZIPs can be re-uploaded",
  );
}
for (const required of [
  'Remove-Item -Path "dist/deployment" -Recurse -Force -ErrorAction SilentlyContinue',
  "RiversideOS-v$version-*-Windows-Deployment.zip",
  "timeout-minutes: 25",
  "Uploading Windows deployment package:",
  "gh release upload $tag $zipFiles[0].FullName --clobber",
]) {
  assertIncludes(
    ".github/workflows/windows-deployment-package.yml",
    required,
    "Windows deployment release must clean package output and publish exactly one current deployment ZIP",
  );
}
for (const copy of [
  "app-updater-only",
  "publish-app-updater-only",
  "client/updater-dist/latest.json",
  "client/updater-dist/riverside-updater-build-manifest.json",
  "gh release upload $tag client/updater-dist/* --clobber",
  "--manifest latest.json",
  "--build-manifest riverside-updater-build-manifest.json",
]) {
  assertIncludes(
    ".github/workflows/windows-deployment-package.yml",
    copy,
    "Windows release workflow must expose a verified app-updater-only path that skips the full deployment ZIP when requested",
  );
}
for (const path of [
  ".github/workflows/windows-deployment-package.yml",
  ".github/workflows/macos-ros-dev-center-release.yml",
]) {
  for (const copy of [
    'CARGO_INCREMENTAL: "0"',
    'RUSTC_WRAPPER: "sccache"',
    'SCCACHE_GHA_ENABLED: "true"',
    "mozilla-actions/sccache-action@v0.0.9",
    "swatinem/rust-cache@v2",
  ]) {
    assertIncludes(
      path,
      copy,
      "release workflows must keep Rust/Tauri compiler caching wired for faster rebuilds",
    );
  }
}

const mainHubInstaller = "deployment/windows/install-server.ps1";
for (const copy of [
  "function Repair-PublicSerialSequences",
  "pg_get_serial_sequence",
  "Repair-PublicSerialSequences $PsqlPath $DatabaseUrl",
  "function Resolve-MainHubDatabaseHost",
  "$success = Test-PostgresReachable $dbHost $dbPort",
  "Continuing so the installer can start, repair, or install local PostgreSQL.",
]) {
  assertIncludes(
    mainHubInstaller,
    copy,
    "Main Hub installer must repair stale PostgreSQL sequences and avoid raw database precheck socket failures",
  );
}

const standaloneMigrationRunner = "deployment/windows/apply-riverside-migrations.ps1";
for (const copy of [
  "function Repair-PublicSerialSequences",
  "pg_get_serial_sequence",
  "Repair-PublicSerialSequences $PsqlPath $DatabaseUrl",
]) {
  assertIncludes(
    standaloneMigrationRunner,
    copy,
    "standalone migration runner must repair stale PostgreSQL sequences before applying pending migrations",
  );
}

const mainHubUpdater = "client/src-tauri/src/server_updater.rs";
const mainHubUpdaterSource = read(mainHubUpdater);
assertNotIncludes(
  mainHubUpdater,
  "$($i * 2)s",
  "generated update-runner.ps1 must not use invalid PowerShell interpolation",
);
assertIncludes(
  mainHubUpdater,
  "Write-Host ('  Waiting... (' + ($i * 2).ToString() + 's)')",
  "generated update-runner.ps1 wait output must remain parse-safe",
);
parsePowerShell(
  `${mainHubUpdater}:generated-update-runner.ps1`,
  renderMainHubUpdateRunner(mainHubUpdaterSource),
);

for (const path of collectFiles("deployment/windows", (name) => name.endsWith(".ps1"))) {
  parsePowerShell(path, read(path));
}

if (failures.length > 0) {
  console.error("Deployment release gate failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Deployment release gate passed.");
if (!existsSync(join(repoRoot, "deployment/windows/build-deployment-package.ps1"))) {
  console.warn("Warning: deployment package builder was not found.");
}
