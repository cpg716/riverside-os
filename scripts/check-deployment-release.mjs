#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function read(path) {
  return readFileSync(join(repoRoot, path), "utf8").replace(/\r\n/g, "\n");
}

function sha256(path) {
  return createHash("sha256")
    .update(read(path).replace(/\r\n/g, "\n"))
    .digest("hex");
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

function checkMainHubInstallerRuntimeContracts(path) {
  const tempDir = mkdtempSync(join(tmpdir(), "ros-main-hub-installer-test-"));
  const testPath = join(tempDir, "test-installer-contracts.ps1");
  const installerPath = join(repoRoot, path).replaceAll("'", "''");
  writeFileSync(
    testPath,
    `$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${installerPath}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer PowerShell did not parse.' }
foreach ($functionName in @('ConvertTo-DotEnvValue', 'ConvertFrom-DotEnvValue', 'Test-FileReadyForReplacement')) {
  $functionAst = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName
  }, $true)
  if (-not $functionAst) { throw "Missing installer function: $functionName" }
  Invoke-Expression $functionAst.Extent.Text
}

$sample = 'C:\Program Files\Riverside $OS\models\"quoted"\it''s.gguf'
$encoded = ConvertTo-DotEnvValue $sample
$decoded = ConvertFrom-DotEnvValue $encoded
if ($decoded -cne $sample) { throw 'Dotenv value did not survive encode/decode.' }
if ((ConvertTo-DotEnvValue $decoded) -cne $encoded) { throw 'Dotenv serialization is not stable.' }
if ((ConvertFrom-DotEnvValue "'$sample'") -cne $sample) { throw 'Legacy single-quoted dotenv values are not readable.' }
$lineBreakRejected = $false
try { ConvertTo-DotEnvValue "one\`ntwo" | Out-Null } catch { $lineBreakRejected = $true }
if (-not $lineBreakRejected) { throw 'Dotenv serializer accepted a multiline value.' }

$lockPath = Join-Path ([System.IO.Path]::GetTempPath()) ("riverside-server-lock-" + [Guid]::NewGuid().ToString('N') + '.exe')
[System.IO.File]::WriteAllText($lockPath, 'test')
$lock = $null
try {
  $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
  if (Test-FileReadyForReplacement $lockPath) { throw 'Locked executable was reported replaceable.' }
  $lock.Dispose()
  $lock = $null
  if (-not (Test-FileReadyForReplacement $lockPath)) { throw 'Released executable was reported locked.' }
} finally {
  if ($lock) { $lock.Dispose() }
  Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
}
`,
    "utf8",
  );
  const pwsh = spawnSync("pwsh", ["-NoProfile", "-File", testPath], {
    encoding: "utf8",
  });
  rmSync(tempDir, { recursive: true, force: true });
  if (pwsh.error?.code === "ENOENT") {
    return;
  }
  if (pwsh.status !== 0) {
    fail(
      `${path}: installer runtime contract test failed\n${pwsh.stderr || pwsh.stdout}`,
    );
  }
}

function renderMainHubUpdateRunner(source) {
  const match = source.match(
    /let runner_content = format!\(\s*r#"\n?([\s\S]*?)\n\s*"#,/,
  );
  if (!match) {
    fail(
      "client/src-tauri/src/server_updater.rs: unable to locate generated update-runner.ps1 template",
    );
    return "";
  }

  const replacements = {
    runner_log_path:
      "C:\\Users\\Admin\\AppData\\Local\\Temp\\riverside-update-0.90.0\\main-hub-update-transcript.txt",
    script_dir:
      "C:\\Users\\Admin\\AppData\\Local\\Temp\\riverside-update-0.90.0\\deployment\\windows",
    install_root: "C:\\ProgramData\\riverside-os",
    config_path:
      "C:\\ProgramData\\riverside-os\\riverside-deployment.config.json",
    config_file: "riverside-deployment.config.json",
    task_name: "Riverside OS Server",
    server_port: "3000",
    ready_ep: "/api/ready",
    target_version: "0.90.0",
    target_build_short: "e96a3e50",
  };

  let rendered = match[1];
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }
  return rendered.replaceAll("{{", "{").replaceAll("}}", "}");
}

function assertAsciiOnly(path, source, message) {
  const offender = [...source].find((char) => char.charCodeAt(0) > 0x7f);
  if (offender) {
    fail(
      `${path}: ${message} (found non-ASCII character ${JSON.stringify(offender)})`,
    );
  }
}

const e2eLocalStack = "scripts/e2e-local-stack.sh";
assertIncludes(
  e2eLocalStack,
  'export RIVERSIDE_MEILISEARCH_URL=""',
  "the isolated E2E database must not write to a shared Meilisearch instance",
);
assertIncludes(
  e2eLocalStack,
  'export RIVERSIDE_MEILISEARCH_DAILY_REINDEX_ENABLED="0"',
  "the isolated E2E server must not start the shared daily reindex worker",
);
const playwrightWorkflow = read(".github/workflows/playwright-e2e.yml");
if (playwrightWorkflow.split('E2E_ALLOW_REGISTER_RESET: "1"').length - 1 < 2) {
  fail(
    ".github/workflows/playwright-e2e.yml: every isolated Playwright lane must explicitly authorize register cleanup",
  );
}

const managerApp = "deployment/manager-app/src/App.tsx";
assertNotIncludes(
  managerApp,
  "Installing Updates...",
  "install wizard must not call fresh installs updates",
);
for (const namespace of [
  "riverside-sccache-windows-register-updater",
  "riverside-sccache-windows-server",
  "riverside-sccache-windows-deployment-manager",
  "riverside-sccache-windows-server-manager",
  "riverside-sccache-windows-counterpoint-bridge",
]) {
  assertIncludes(
    ".github/workflows/windows-deployment-package.yml",
    namespace,
    "parallel Windows release jobs must keep independent sccache namespaces",
  );
}
for (const copy of [
  "cancel-in-progress: true",
  "build-register-updater:\n    needs: [validate-scripts]",
  "cache-workspace-crates: true",
  "build-register-updater, pre-retag-gate, require-playwright-green",
  "build-server-binary,\n        build-deployment-manager,\n        build-server-manager,\n        build-counterpoint-bridge-gui,\n        pre-retag-gate,\n        require-playwright-green",
]) {
  assertIncludes(
    ".github/workflows/windows-deployment-package.yml",
    copy,
    "Windows release builds must cancel superseded same-tag runs, restore workspace outputs, overlap compilation with pre-retag checks, and keep publication gated",
  );
}
const windowsReleaseWorkflow = read(
  ".github/workflows/windows-deployment-package.yml",
);
const rosieInstaller = read("deployment/windows/Install-RosieAiStack.ps1");
const installerLlamaVersion = rosieInstaller.match(/\$LLAMA_VERSION\s*=\s*"([^"]+)"/)?.[1];
const installerLlamaSha = rosieInstaller.match(/\$LLAMA_ZIP_SHA256\s*=\s*"([a-f0-9]{64})"/)?.[1];
const workflowLlamaVersion = windowsReleaseWorkflow.match(/LLAMA_CPP_RELEASE:\s*([^\s]+)/)?.[1];
const workflowLlamaSha = windowsReleaseWorkflow.match(/LLAMA_CPP_WIN_CPU_SHA256:\s*([a-f0-9]{64})/)?.[1];
if (
  !installerLlamaVersion ||
  !installerLlamaSha ||
  installerLlamaVersion !== workflowLlamaVersion ||
  installerLlamaSha !== workflowLlamaSha
) {
  fail(
    ".github/workflows/windows-deployment-package.yml: bundled llama.cpp version and SHA256 must match Install-RosieAiStack.ps1 release pins",
  );
}
for (const job of [
  "build-register-updater",
  "build-server-binary",
  "build-deployment-manager",
  "build-server-manager",
  "build-counterpoint-bridge-gui",
]) {
  const marker = `  ${job}:\n`;
  const jobStart = windowsReleaseWorkflow.indexOf(marker);
  const remainingWorkflow =
    jobStart >= 0 ? windowsReleaseWorkflow.slice(jobStart + marker.length) : "";
  const nextJob = remainingWorkflow.search(/\n  [a-zA-Z0-9_-]+:\n/);
  const jobBlock =
    nextJob >= 0 ? remainingWorkflow.slice(0, nextJob) : remainingWorkflow;
  const startsAfterScriptValidation = jobBlock.includes(
    "    needs: [validate-scripts]",
  );
  if (!startsAfterScriptValidation) {
    fail(
      `.github/workflows/windows-deployment-package.yml: ${job} must compile after script validation while the pre-retag publication gate runs concurrently`,
    );
  }
}
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
  assertIncludes(
    managerApp,
    copy,
    "install execution step must be role-specific and visible",
  );
}
for (const lanUpdateScript of [
  "deployment/windows/Apply-RiversideLanFleetUpdate.ps1",
  "scripts/push-main-hub.ps1",
]) {
  assertIncludes(
    lanUpdateScript,
    "refusing to use the limited Riverside app account for a full pre-update backup",
    "every Main Hub LAN update path must require PostgreSQL administrator access for a complete backup",
  );
  assertNotIncludes(
    lanUpdateScript,
    '$user = Get-SafeConfigValue $db "appUser" "riverside_app"',
    "Main Hub LAN backup paths must never fall back to the limited Riverside app account",
  );
  assertIncludes(
    lanUpdateScript,
    "Remove-Item $backupPath -Force -ErrorAction SilentlyContinue",
    "failed Main Hub LAN backups must remove incomplete dump files",
  );
  assertIncludes(
    lanUpdateScript,
    "$pgRestore --list $backupPath",
    "Main Hub LAN backups must prove the custom-format archive can be read before update downtime",
  );
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
  "resolve_deployment_config_path",
  "if installed_config.exists()",
  'script_name != "Install-RosieAiStack.ps1"',
]) {
  assertIncludes(
    managerRunner,
    copy,
    "deployment runner must emit immediate launch logs",
  );
}
for (const copy of [
  "typeof newConfig.server.strictProduction !== 'boolean'",
  "newConfig.server.environment.RIVERSIDE_BACKUP_DIR?.trim()",
  "Production safeguards are disabled",
  "production go-live signoff is blocked",
]) {
  assertIncludes(
    managerApp,
    copy,
    "Deployment Manager must preserve explicit hardening state and surface production blockers",
  );
}

const fallbackDeploymentManager =
  "deployment/windows/Start-RiversideDeployment.ps1";
for (const copy of [
  "function Resolve-DeploymentConfigPath",
  "function Get-ConfiguredInstallRoot",
  "$requestedConfigPath",
  'Set-ConfigEnvironmentValue $config "RIVERSIDE_BACKUP_DIR"',
  "Production safeguards remain enabled by the installed deployment config.",
]) {
  assertIncludes(
    fallbackDeploymentManager,
    copy,
    "fallback deployment manager must preserve installed config and fill required runtime paths",
  );
}
assertNotIncludes(
  fallbackDeploymentManager,
  "$config.server.strictProduction = $false",
  "deployment manager must not disable safeguards from stale package-side Helcim fields",
);

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

const deploymentConfigExample =
  "deployment/windows/riverside-deployment.config.example.json";
assertIncludes(
  deploymentConfigExample,
  '"language": "epl"',
  "deployment config example must carry the Riverside LP 2844 EPL tag-printer default",
);
assertNotIncludes(
  deploymentConfigExample,
  '"RIVERSIDE_MEILISEARCH_API_KEY": "dev_master_key_change_me"',
  "new Main Hub installs must generate a private Meilisearch key",
);

const counterpointTender092 =
  "migrations/092_counterpoint_live_tender_aliases.sql";
const counterpointSquare093 =
  "migrations/093_counterpoint_square_tender_alias.sql";
const expectedCounterpointTender092Sha =
  "def5b71eb0e7bcbb8bcf80341afc29dc0bfcbb6b46563a14b7e79ecc1eb968b4";
assertIncludes(
  ".gitattributes",
  "*.sql text eol=lf",
  "database migration source files must keep stable LF line endings before package normalization",
);
assertIncludes(
  "deployment/windows/build-deployment-package.ps1",
  "function Set-PackagedMigrationLineEndings",
  "Windows deployment package must normalize migration line endings to live-ledger-compatible checksums",
);
assertIncludes(
  "deployment/windows/build-deployment-package.ps1",
  "if ($migrationNumber -le 101)",
  "Windows deployment package must preserve legacy CRLF checksums for migrations 001-101",
);
assertIncludes(
  "deployment/windows/build-deployment-package.ps1",
  "Packaged migration line endings normalized: 001-101 CRLF, 102+ LF",
  "Windows deployment package must log the migration checksum compatibility rule",
);
assertIncludes(
  "server/src/db_migrations.rs",
  "fn migration_sha256_variants",
  "server startup migration verifier must accept line-ending-equivalent migration checksums",
);
assertIncludes(
  "server/src/db_migrations.rs",
  "Migration checksum differs only by line formatting",
  "server startup migration verifier must log formatting-only checksum compatibility",
);
for (const migrationScript of [
  "deployment/windows/install-server.ps1",
  "deployment/windows/apply-riverside-migrations.ps1",
]) {
  assertIncludes(
    migrationScript,
    "function Get-FileSha256Variants",
    `${migrationScript} must compute migration checksum line-ending variants`,
  );
  assertIncludes(
    migrationScript,
    "line-ending checksum compatible",
    `${migrationScript} must accept CRLF/LF-only checksum drift`,
  );
}
if (sha256(counterpointTender092) !== expectedCounterpointTender092Sha) {
  fail(
    `${counterpointTender092}: applied migration checksum changed; add a new numbered migration instead`,
  );
}
assertNotIncludes(
  counterpointTender092,
  "SQUARE",
  "applied Counterpoint tender migration must not be edited for Square",
);
assertIncludes(
  counterpointSquare093,
  "'SQUARE', 'credit_card'",
  "Square tender alias must live in a new migration after 092",
);

const deploymentPackageBuilder =
  "deployment/windows/build-deployment-package.ps1";
assertIncludes(
  deploymentPackageBuilder,
  "counterpoint-bridge-gui",
  "Windows deployment package must include the Counterpoint Bridge GUI installer directory",
);
for (const copy of [
  "function Add-MeilisearchBinary",
  "meilisearch-windows-amd64.exe",
  "meilisearch\\meilisearch.exe",
  "Meilisearch $meiliVersion Windows runtime",
]) {
  assertIncludes(
    deploymentPackageBuilder,
    copy,
    "Windows deployment package must include the local Meilisearch runtime used by Main Hub search",
  );
}
for (const copy of [
  "function Add-CubeRuntime",
  'cubeVersion = "1.7.16"',
  'Join-Path $cubeSource "package-lock.json"',
  "start-riverside-cube.ps1",
  "node.exe",
  "Cube Core $cubeVersion with a portable Windows Node runtime",
  "await this.server.listen(PORT, '127.0.0.1');",
]) {
  assertIncludes(
    deploymentPackageBuilder,
    copy,
    "Windows deployment packages must include the pinned non-Docker Cube Core runtime",
  );
}
const cubeInstallScript = "scripts/install-cube-runtime.ps1";
const cubeInstallCommand = `./${cubeInstallScript}`;
const cubeInstallCallCount =
  windowsReleaseWorkflow.split(cubeInstallCommand).length - 1;
if (cubeInstallCallCount !== 2) {
  fail(
    `.github/workflows/windows-deployment-package.yml: expected two ${cubeInstallCommand} calls, found ${cubeInstallCallCount} (both Windows package assembly paths must install Cube with bounded retries)`,
  );
}
for (const copy of [
  "npm ci --prefix cube",
  "$MaxAttempts = 3",
  "$InitialDelaySeconds = 10",
  "Start-Sleep -Seconds $delaySeconds",
  "exit $exitCode",
]) {
  assertIncludes(
    cubeInstallScript,
    copy,
    "Windows Cube installation must retry transient native-runtime download failures without masking a final failure",
  );
}
parsePowerShell(cubeInstallScript, read(cubeInstallScript));
assertIncludes(
  "cube/package.json",
  '"@cubejs-backend/server": "1.7.16"',
  "Cube runtime dependency must remain pinned to the packaged release",
);
const meilisearchVersionMatch = read(deploymentPackageBuilder).match(
  /\$meiliVersion = "([^"]+)"/,
);
if (!meilisearchVersionMatch) {
  fail(
    `${deploymentPackageBuilder}: unable to resolve the pinned Meilisearch version`,
  );
} else {
  const meilisearchVersion = meilisearchVersionMatch[1];
  assertIncludes(
    "docker-compose.yml",
    `getmeili/meilisearch:v${meilisearchVersion}`,
    "Docker and Windows Main Hub must use the same Meilisearch runtime",
  );
  assertIncludes(
    "server/src/logic/meilisearch_client.rs",
    `EXPECTED_MEILISEARCH_VERSION: &str = "${meilisearchVersion}"`,
    "runtime health checks must enforce the packaged Meilisearch version",
  );
}
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
  "timeout-minutes: 60",
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
  "main-hub-update",
  "publish-app-updater-only",
  "publish-main-hub-update",
  "client/updater-dist/latest.json",
  "client/updater-dist/riverside-updater-build-manifest.json",
  "gh release upload $tag client/updater-dist/* --clobber",
  "RiversideOS-v$version-*-MainHub-Update.zip",
  '-PackageFlavor "MainHub-Update"',
  "--manifest latest.json",
  "--build-manifest riverside-updater-build-manifest.json",
]) {
  assertIncludes(
    ".github/workflows/windows-deployment-package.yml",
    copy,
    "Windows release workflow must expose a verified app-updater-only path that skips the full deployment ZIP when requested",
  );
}
for (const copy of [
  "name: In-app Main Hub update",
  "windows-deployment-package.yml",
  "package_scope=main-hub-update",
  "source_ref",
  "actions: write",
  "gh run watch",
]) {
  assertIncludes(
    ".github/workflows/in-app-main-hub-update.yml",
    copy,
    "the dedicated in-app update workflow must dispatch and wait for the verified Main Hub/server package path",
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
    "mozilla-actions/sccache-action@9e7fa8a12102821edf02ca5dbea1acd0f89a2696 # v0.0.10",
    "Swatinem/rust-cache@42dc69e1aa15d09112580998cf2ef0119e2e91ae # v2",
  ]) {
    assertIncludes(
      path,
      copy,
      "release workflows must keep Rust/Tauri compiler caching wired for faster rebuilds",
    );
  }
}
assertNotIncludes(
  ".github/workflows/windows-deployment-package.yml",
  'shared-key: "windows-release"',
  "parallel Windows release jobs must not race to save one shared Rust cache",
);
for (const copy of [
  "Keep Rust cache key pinned to Riverside toolchain",
  "rustup default 1.91",
  'rustup toolchain uninstall stable || echo "Unpinned stable toolchain already absent"',
]) {
  assertIncludes(
    ".github/workflows/windows-deployment-package.yml",
    copy,
    "Windows release caches must ignore the GitHub runner's unpinned stable Rust toolchain",
  );
}
for (const path of [
  ".github/workflows/windows-deployment-package.yml",
  ".github/workflows/macos-ros-dev-center-release.yml",
]) {
  for (const copy of [
    "publish_release:",
    "disable for benchmarks",
    "inputs.publish_release",
  ]) {
    assertIncludes(
      path,
      copy,
      "release workflows must support non-publishing benchmark builds",
    );
  }
}
for (const copy of [
  "verify-release-candidate-runs.mjs",
  "verify-release-candidate-assets.mjs",
  "riverside-release-publish-${{ inputs.release_tag }}",
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8",
  "release-upload/$old_asset",
  "Riverside.POS_${version}_",
]) {
  assertIncludes(
    ".github/workflows/promote-release-candidate.yml",
    copy,
    "candidate promotion must verify exact provenance and serialize release publication",
  );
}

const mainHubInstaller = "deployment/windows/install-server.ps1";
const mainHubInstallerSource = read(mainHubInstaller);
for (const writer of [
  mainHubInstaller,
  "deployment/windows/Install-RosieAiStack.ps1",
  "deployment/windows/repair-server-credentials-key.ps1",
]) {
  assertIncludes(
    writer,
    "ConvertTo-DotEnvValue",
    "installed server environment writers must serialize Windows paths and special characters for dotenvy",
  );
}
for (const reader of [
  mainHubInstaller,
  "deployment/windows/Install-RosieAiStack.ps1",
  "deployment/windows/repair-server-credentials-key.ps1",
  "deployment/windows/start-riverside-llama.ps1",
  "deployment/windows/watch-rosie-stack.ps1",
  "deployment/windows/audit-system.ps1",
]) {
  assertIncludes(
    reader,
    "ConvertFrom-DotEnvValue",
    "installed server environment consumers must decode installer-serialized values",
  );
}
for (const guard of [
  "function Test-FileReadyForReplacement",
  "[System.IO.FileShare]::None",
  "Stop-RiversideServer $installedServerExe",
  "Riverside server stopped and executable handle released.",
]) {
  assertIncludes(
    mainHubInstaller,
    guard,
    "Main Hub updates must prove the server executable is unlocked before replacement",
  );
}
checkMainHubInstallerRuntimeContracts(mainHubInstaller);
for (const copy of [
  "function Ensure-RiversideMeilisearchHost",
  "Riverside OS Meilisearch",
  "RIVERSIDE_MEILISEARCH_URL",
  "RIVERSIDE_MEILISEARCH_API_KEY",
  "--master-key",
  "Wait-MeilisearchReady",
  "Repair-MeilisearchDataCompatibility",
  "data-incompatible-",
  "--no-analytics",
  "--schedule-snapshot=86400",
  "Replaced the legacy Meilisearch development key with a private Main Hub key.",
  "Restored the previous Meilisearch service key after the failed update.",
]) {
  assertIncludes(
    mainHubInstaller,
    copy,
    "Main Hub installer must install and start local Meilisearch before the API relies on it",
  );
}
for (const copy of [
  "function Ensure-CubeServerEnvironment",
  "function Set-CubeRolePassword",
  "function Ensure-RiversideCubeHost",
  "function Wait-CubeReady",
  'Riverside OS Cube Core',
  'RIVERSIDE_CUBE_UPSTREAM',
  'RIVERSIDE_CUBE_API_SECRET',
  'RIVERSIDE_CUBE_REPORTING_DB_PASSWORD',
  'http://127.0.0.1:4000',
  'Restored the previous Cube reporting-role password after the failed update.',
  'Previous Cube Core task restarted after the failed update.',
]) {
  assertIncludes(
    mainHubInstaller,
    copy,
    "Main Hub installer must configure, supervise, verify, and roll back local non-Docker Cube Core",
  );
}
assertNotIncludes(
  mainHubInstaller,
  "This existing Main Hub still uses the legacy development Meilisearch key.",
  "Main Hub installs must rotate the legacy development key together with the managed service configuration",
);
assertNotIncludes(
  mainHubInstaller,
  "UPDATE staff SET full_name = 'Chris G'",
  "routine Main Hub installs must preserve existing bootstrap credentials and permissions",
);
assertIncludes(
  mainHubInstaller,
  "existing credentials and permissions were preserved",
  "routine Main Hub installs must report credential preservation without printing an Access PIN",
);
for (const copy of [
  "$env:PGPASSWORD = $DbConfig.adminPassword",
  "-U $backupUser -d $DbConfig.databaseName",
  '[System.Uri]::EscapeDataString("$($db.appPassword)")',
  "New-PreMigrationBackup $preflightPsql $db $backupDir",
  "$pgRestore --list $backupPath",
  "Pre-migration backup archive verification failed",
  "Could not write deployment status '$Status'",
  "The running Riverside server has not been stopped or replaced.",
  "Previous Riverside OS Server task restarted after the failed update.",
  "Set-ServerDatabaseUrl $restoredEnvPath $databaseUrl",
  "Restored server DATABASE_URL synchronized with the PostgreSQL app role.",
  'Set-SafeProperty $serverEnvironment "RIVERSIDE_BACKUP_DIR" $backupDir',
  "Write-DeploymentConfigJson $installRootConfigPath $config",
  'Set-DeploymentConfigDatabaseAppPassword $installRootConfigPath "$($db.appPassword)"',
  "Restored deployment config synchronized with the PostgreSQL app role.",
  "Retained the failed initial install config because PostgreSQL app credentials were already applied.",
  "Restored the previous installed deployment config after the failed update.",
  "Removed the incomplete installed deployment config after the failed initial install.",
  "function Ensure-OptionalReportingRole",
  "Ensure-OptionalReportingRole $PsqlPath $Db -Required",
  "function Invoke-CubeRoleMigrationFile",
  'if ($file.Name -eq "185_cube_insights_and_saved_reports.sql")',
  '"-c", "SET ROLE $appUserIdentifier;"',
  "REVOKE ADMIN OPTION FOR cube_ro",
  "Applied Cube reporting migration with transaction-scoped role administration; app role privileges restored.",
  "[switch]$PreserveExistingRosie",
  "Get-PreservedRosieEnvironment $envPath",
  "Resolve-InstalledRosieModelPath $installRoot $ScriptRoot $preservedRosieEnvironment",
  "ROSIE scheduled task preserved without restart or re-registration.",
  "-FullCertification -SkipSpeechCertification",
  "ROSIE speech certification started in the background.",
  "The Riverside OS update will continue while ROSIE reports degraded status and the watchdog retries.",
  "Deferring cleanup of superseded certified ROSIE asset until the Main Hub update is fully ready",
  "Removing superseded certified ROSIE asset after successful Main Hub update",
]) {
  assertIncludes(
    mainHubInstaller,
    copy,
    "Main Hub updates must verify an admin-readable backup before downtime and recover the prior task after failure",
  );
}
assertIncludes(
  mainHubInstaller,
  "\n      Ensure-OptionalReportingRole $psql $db\n",
  "Main Hub database setup must provision the Cube reporting role before migrations",
);
for (const copy of [
  'temperature = 0',
  'seed = 42',
  '$startupTimeoutSeconds = if ((Get-Item $modelPath).Length -ge 4GB) { 180 } else { 60 }',
  'Waiting up to $startupTimeoutSeconds seconds for the ROSIE LLM host to load the model',
  'ROSIE certification details: HTTP healthy=$llmHealthy; LLM functional=$($llmProbe.ready); TTS=$ttsResult; STT=$sttResult.',
  'ROSIE LLM detail: $($llmProbe.error)',
  'ROSIE speech detail: $($speechProbe.error)',
  '"`"Voice recognition is working correctly`""',
  '"--sid=0"',
  "function Test-RosieHealthTranscript",
  "voice\\s+recognition\\s+is\\s+working\\s+correctly",
  '"--sense-voice-language=en"',
  '"--sense-voice-use-itn=1"',
  "speech_certification_pending",
  '$process.WaitForExit()',
  'function Test-WavFixture([string]$Path)',
  '$wavReady = Test-WavFixture $probeWav',
  '$recognized = Test-RosieHealthTranscript $transcript',
  'stt_error = "Skipped because the TTS fixture was not certified."',
  'wav_bytes = $speechProbe.tts_wav_bytes',
]) {
  assertIncludes(
    "deployment/windows/watch-rosie-stack.ps1",
    copy,
    "ROSIE certification must allow bounded cold startup and report the exact failing subsystem",
  );
}
for (const copy of [
  "ROSIE: Runtime assets verified. Functional certification will run next.",
  "Riverside OS database readiness is warming up; retrying.",
  '"running (0x41301)"',
]) {
  assertIncludes(
    mainHubInstaller,
    copy,
    "Main Hub updates must distinguish expected startup progress from actionable failures",
  );
}
assertNotIncludes(
  "deployment/windows/watch-rosie-stack.ps1",
  '"--sid=5"',
  "the Kokoro v1.1-zh package reserves speaker IDs 0-2 for English voices",
);
assertNotIncludes(
  "deployment/windows/watch-rosie-stack.ps1",
  "Riverside Rosie health check",
  "speech certification must measure English recognition without depending on brand-name pronunciation",
);
assertNotIncludes(
  "deployment/windows/watch-rosie-stack.ps1",
  "$wavReady = $ttsProbe.success -and",
  "a structurally valid generated WAV is the authoritative TTS functional result",
);
for (const [path, copy] of [
  ["client/src/lib/rosie.ts", 'export const DEFAULT_ROSIE_VOICE = "0"'],
  ["client/src/lib/rosie.ts", '{ value: "2", label: "ROSIE Vale (British English)" }'],
  ["server/src/api/settings.rs", '"0".to_string()'],
  ["server/src/logic/rosie_speech.rs", ".filter(|value| (0..=2).contains(value))"],
  ["client/src-tauri/src/rosie_voice.rs", ".filter(|value| (0..=2).contains(value))"],
]) {
  assertIncludes(
    path,
    copy,
    "ROSIE must restrict Kokoro v1.1-zh to its English speaker IDs",
  );
}
for (const path of [
  "client/src-tauri/src/rosie_voice.rs",
  "server/src/logic/rosie_speech.rs",
]) {
  assertIncludes(
    path,
    '"--sense-voice-language=en"',
    "production SenseVoice transcription must use the store's English language profile",
  );
  assertIncludes(
    path,
    '"--sense-voice-use-itn=1"',
    "production SenseVoice transcription must return normalized English text",
  );
}
assertIncludes(
  "scripts/verify_rosie_local_stack.sh",
  "--language en",
  "manual ROSIE verification must use the same English transcription profile as production",
);
assertNotIncludes(
  "deployment/windows/watch-rosie-stack.ps1",
  "$recognized = $sttProbe.success -and",
  "recognized fixture text is the authoritative STT functional result",
);
assertNotIncludes(
  mainHubInstaller,
  'throw "ROSIE functional certification failed.',
  "ROSIE degradation must not roll back an otherwise healthy Main Hub update",
);
const rosieCleanupIndex = mainHubInstallerSource.indexOf(
  "Removing superseded certified ROSIE asset after successful Main Hub update",
);
const installationReadyIndex = mainHubInstallerSource.indexOf(
  'Write-DeploymentStatus "READY" "Installation completed successfully"',
);
if (rosieCleanupIndex < installationReadyIndex || installationReadyIndex < 0) {
  fail(
    `${mainHubInstaller}: superseded ROSIE assets must remain available for rollback until the complete Main Hub update is ready`,
  );
}
for (const copy of [
  "function Resolve-DeploymentConfigPath",
  "function Get-ConfiguredInstallRoot",
  "function Write-AuditFailure",
  "$script:auditFailureCount",
  "Production safeguards are disabled",
  "production go-live signoff is blocked",
  "RIVERSIDE_BACKUP_DIR",
  "Installed production settings cannot be verified.",
  "Database contents and migration state cannot be verified.",
  'Invoke-WebRequest -Uri "$apiBase/api/ready"',
  "The API did not report an immutable build SHA.",
  "Installed API build matches the exact package SHA.",
  "does not match the expected package SHA",
  "Installed API version matches the expected package version.",
  'Get-DotEnvValue $serverEnvPath "RIVERSIDE_CREDENTIALS_KEY"',
  "API readiness is",
  "Direct Counterpoint Bridge sync is retired; no COUNTERPOINT_SYNC_TOKEN is required for Main Hub production readiness.",
  "Audit Verification Failed",
  "exit 1",
]) {
  assertIncludes(
    "deployment/windows/audit-system.ps1",
    copy,
    "Windows diagnostics must report production hardening and backup blockers truthfully",
  );
}
for (const copy of [
  'Copy-Item $packageManifestPath (Join-Path $releaseDir "deployment-package.manifest.json") -Force',
  "Strict production installation requires a verified deployment-package.manifest.json.",
]) {
  assertIncludes(
    mainHubInstaller,
    copy,
    "Main Hub installs must persist and require exact build provenance",
  );
}
for (const path of [
  "deployment/windows/Start-RiversideDeployment.ps1",
  "deployment/windows/Build-And-Apply-MainHubFastUpdate.ps1",
  "deployment/windows/Apply-RiversideLanFleetUpdate.ps1",
  "scripts/push-main-hub.ps1",
]) {
  assertNotIncludes(
    path,
    '"-PreserveExistingRosie"',
    "Normal Main Hub updates must apply and certify the release-pinned ROSIE stack",
  );
}
for (const copy of [
  '$sttPin = "$STT_HF_REPO@$STT_HF_REVISION"',
  '$ttsPin = "$TTS_HF_REPO@$TTS_HF_REVISION"',
  "Runtime pins match and required binaries are present; reusing installed binaries.",
  "STT pin matches and required files are present; verifying installed assets in place.",
  "TTS pin matches and required files are present; verifying installed assets in place.",
]) {
  assertIncludes(
    "deployment/windows/Install-RosieAiStack.ps1",
    copy,
    "ROSIE updates must reuse exact runtime and speech pins without unnecessary asset replacement",
  );
}
for (const path of [
  "deployment/windows/Build-And-Apply-MainHubFastUpdate.ps1",
  "deployment/windows/Apply-RiversideLanFleetUpdate.ps1",
  "scripts/push-main-hub.ps1",
]) {
  assertIncludes(
    path,
    '"-SkipRosieSetup"',
    "Scripted Main Hub updates may skip ROSIE only through an explicit operator switch",
  );
}
for (const passwordSafeScript of [
  "deployment/windows/repair-bootstrap-admin.ps1",
  "deployment/windows/Import-IntegrationCredentials.ps1",
]) {
  assertNotIncludes(
    passwordSafeScript,
    ":$($db.appPassword)@",
    "PowerShell PostgreSQL clients must pass special-character passwords through PGPASSWORD instead of embedding them in a URI",
  );
}
const preflightBackupIndex = mainHubInstallerSource.indexOf(
  "New-PreMigrationBackup $preflightPsql $db $backupDir",
);
const persistedConfigIndex = mainHubInstallerSource.indexOf(
  "Write-DeploymentConfigJson $installRootConfigPath $config",
);
const destructiveStopIndex = mainHubInstallerSource.indexOf(
  "Stop-RiversideServer",
  preflightBackupIndex,
);
const serverReplacementIndex = mainHubInstallerSource.indexOf(
  "Copy-Item $packageServerExe $installedServerExe -Force",
  preflightBackupIndex,
);
if (!(
  preflightBackupIndex >= 0 && destructiveStopIndex > preflightBackupIndex
)) {
  fail(
    `${mainHubInstaller}: pre-update backup must complete before the first destructive server stop`,
  );
}
if (!(destructiveStopIndex >= 0 && serverReplacementIndex > destructiveStopIndex)) {
  fail(
    `${mainHubInstaller}: server executable replacement must occur only after the bounded process and handle-release gate`,
  );
}
if (!(
  preflightBackupIndex >= 0 && persistedConfigIndex > preflightBackupIndex
)) {
  fail(
    `${mainHubInstaller}: resolved installed-config changes must not persist before the required pre-update backup`,
  );
}
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

const standaloneMigrationRunner =
  "deployment/windows/apply-riverside-migrations.ps1";
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

for (const migrationRunner of [
  "server/src/db_migrations.rs",
  "scripts/apply-migrations-psql.sh",
  "scripts/apply-migrations-docker.sh",
  standaloneMigrationRunner,
]) {
  for (const repairIdentity of [
    "172_reassign_txn_624853_to_glenn_jones.sql",
    "ac91ab897c2466bb2ed6bd7cde70d6598fdb0a91a015436603164b06b6dedf94",
    "e9fbb62d-02e6-4256-9b3c-e6faced388a8",
  ]) {
    assertIncludes(
      migrationRunner,
      repairIdentity,
      "migration 172 may be skipped only for its exact immutable file and absent source transaction",
    );
  }
}
const sourceLockedRepair172 =
  "migrations/172_reassign_txn_624853_to_glenn_jones.sql";
const sourceLockedRepair172Sha =
  "ac91ab897c2466bb2ed6bd7cde70d6598fdb0a91a015436603164b06b6dedf94";
if (sha256(sourceLockedRepair172) !== sourceLockedRepair172Sha) {
  fail(
    `${sourceLockedRepair172}: immutable reviewed repair checksum must remain ${sourceLockedRepair172Sha}`,
  );
}

const mainHubUpdater = "client/src-tauri/src/server_updater.rs";
const mainHubUpdaterSource = read(mainHubUpdater);
const renderedMainHubUpdateRunner =
  renderMainHubUpdateRunner(mainHubUpdaterSource);
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
assertNotIncludes(
  mainHubUpdater,
  'Write-Host "Update transcript: $transcriptPath"',
  "generated update-runner.ps1 transcript output must remain PowerShell 5.1 parse-safe",
);
assertNotIncludes(
  mainHubUpdater,
  'Write-Error "Update failed: $_"',
  "generated update-runner.ps1 error output must remain PowerShell 5.1 parse-safe",
);
assertNotIncludes(
  mainHubUpdater,
  "Write-Error ('Update failed: '",
  "generated update runner recovery must not be interrupted by ErrorActionPreference Stop",
);
assertAsciiOnly(
  `${mainHubUpdater}:generated-update-runner.ps1`,
  renderedMainHubUpdateRunner,
  "generated update-runner.ps1 must stay ASCII-only for Windows PowerShell 5.1",
);
for (const copy of [
  "resolve_existing_deployment_config",
  "candidate_deployment_config_paths",
  "Windows-Deployment",
  "Failed to stage deployment config",
  "$configPath = $installRootConfig",
  "Exact build SHA is required for a Main Hub update.",
  "Deployment package download failed with HTTP status",
  "verify_downloaded_asset_digest",
  "missing its GitHub SHA-256 digest",
  "Get-FileHash",
  "Write-MainHubUpdateStatus 'READY' 'Main Hub update completed and post-restart readiness passed.'",
  "build_sha = '{target_build_short}'",
]) {
  assertIncludes(
    mainHubUpdater,
    copy,
    "Main Hub updater must stage an existing deployment config before launching the elevated update runner",
  );
}
if (renderedMainHubUpdateRunner.includes("repair-bootstrap-admin.ps1")) {
  fail(
    `${mainHubUpdater}: routine Main Hub updates must not reset the bootstrap administrator`,
  );
}
for (const copy of [
  "Keep the current server running until install-server.ps1 verifies",
  "Attempting emergency restart of the previous Riverside server",
  "Start-ScheduledTask -TaskName $taskName -ErrorAction Stop",
  "Previous Riverside server is healthy after emergency restart.",
  "Emergency restart did not restore server health. Scheduled task result:",
  "ready_ep = contract::READY_ENDPOINT",
]) {
  assertIncludes(
    mainHubUpdater,
    copy,
    "Main Hub elevated runner must preserve service until backup preflight and restart it after failure",
  );
}
if (!renderedMainHubUpdateRunner.includes("/api/ready")) {
  fail(
    `${mainHubUpdater}: generated update runner must verify database readiness through /api/ready`,
  );
}
if (renderedMainHubUpdateRunner.includes("-PreserveExistingRosie")) {
  fail(
    `${mainHubUpdater}: generated update runner must install and certify release-pinned ROSIE assets`,
  );
}
if (renderedMainHubUpdateRunner.includes("/api/health")) {
  fail(
    `${mainHubUpdater}: generated update runner must not treat process-only /api/health as install or recovery readiness`,
  );
}
const runnerInstallIndex = renderedMainHubUpdateRunner.indexOf(
  "Write-Host 'Step 1: Running install-server.ps1...'",
);
const runnerFirstServerKillIndex = renderedMainHubUpdateRunner.indexOf(
  "Get-Process -Name 'riverside-server'",
);
if (!(
  runnerInstallIndex >= 0 && runnerFirstServerKillIndex > runnerInstallIndex
)) {
  fail(
    `${mainHubUpdater}: generated update runner must not kill riverside-server before install-server.ps1 completes backup preflight`,
  );
}
for (const copy of [
  "is_main_hub_update_asset",
  "RiversideOS-v0.90.0-e96a3e50-MainHub-Update.zip",
  "build_ids_match",
  "deployment_asset_selection_accepts_seven_char_asset_for_eight_char_build",
]) {
  assertIncludes(
    mainHubUpdater,
    copy,
    "Main Hub updater must prefer MainHub-Update.zip and tolerate existing 7/8-character build asset names",
  );
}
parsePowerShell(
  `${mainHubUpdater}:generated-update-runner.ps1`,
  renderedMainHubUpdateRunner,
);

for (const copy of [
  "[switch]$StartFresh",
  "-ApplySeeds",
  "Migrations and required seed data were applied",
]) {
  assertIncludes(
    "deployment/windows/reset-riverside-database.ps1",
    copy,
    "database reset must support a production fresh-start path that applies migrations and required seeds",
  );
}
assertIncludes(
  "deployment/windows/Reset-RiversideDatabase.cmd",
  "-StartFresh",
  "production database reset wrapper must reset to migrations plus required seed data",
);

for (const path of collectFiles("deployment/windows", (name) =>
  name.endsWith(".ps1"),
)) {
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
if (
  !existsSync(join(repoRoot, "deployment/windows/build-deployment-package.ps1"))
) {
  console.warn("Warning: deployment package builder was not found.");
}
