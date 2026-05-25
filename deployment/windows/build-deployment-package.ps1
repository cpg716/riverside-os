[CmdletBinding()]
param(
  [string]$Version = "0.80.6",
  [string]$OutputDir = "$PSScriptRoot\..\..\dist\deployment",
  [string]$ServerBinaryPath = "$PSScriptRoot\..\..\target\release\riverside-server.exe",
  [string]$ClientDistPath = "$PSScriptRoot\..\..\client\dist",
  [string]$RegisterBundlePath = "$PSScriptRoot\..\..\target\release\bundle",
  [string]$UpdaterDistPath = "$PSScriptRoot\..\..\client\updater-dist",
  [string]$ManagerBinaryPath = "$PSScriptRoot\..\..\target\release\riverside-deployment-manager.exe",
  [switch]$AllowMissingRegisterBundle,
  [switch]$AllowMissingManagerBinary
)

$ErrorActionPreference = "Stop"

function Resolve-FullPath([string]$Path) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Get-GitShort([string]$RepoRoot) {
  try {
    return (& git -C $RepoRoot rev-parse --short HEAD 2>$null).Trim()
  } catch {
    return "unknown"
  }
}

function Get-GitFull([string]$RepoRoot) {
  try {
    return (& git -C $RepoRoot rev-parse HEAD 2>$null).Trim()
  } catch {
    return "unknown"
  }
}

function Assert-ClientDistMatchesSource([string]$ClientDistPath, [string]$Version, [string]$GitShort) {
  $assetDir = Join-Path $ClientDistPath "assets"
  if (-not (Test-Path $assetDir)) {
    throw "Client asset folder not found: $assetDir"
  }

  $scripts = Get-ChildItem $assetDir -Filter "*.js" -ErrorAction SilentlyContinue
  if (-not $scripts) {
    throw "No client JavaScript assets found in $assetDir. Rebuild the client before packaging."
  }

  $versionMatch = $scripts |
    Select-String -Pattern $Version -SimpleMatch -List -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $versionMatch) {
    throw "Client dist does not contain version marker $Version. Rebuild client/dist before packaging."
  }

  if ($GitShort -and $GitShort -ne "unknown") {
    $gitMatch = $scripts |
      Select-String -Pattern $GitShort -SimpleMatch -List -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $gitMatch) {
      throw "Client dist does not contain git marker $GitShort. Rebuild client/dist from the current commit before packaging."
    }
  }
}

$repoRoot = Resolve-FullPath "$PSScriptRoot\..\.."
$gitShort = Get-GitShort $repoRoot
$gitFull = Get-GitFull $repoRoot
$packageLabel = if ($gitShort -and $gitShort -ne "unknown") {
  "RiversideOS-v$Version-$gitShort-Windows-Deployment"
} else {
  "RiversideOS-v$Version-Windows-Deployment"
}
$packageRoot = Join-Path (Resolve-FullPath $OutputDir) $packageLabel

if (-not (Test-Path $ServerBinaryPath)) {
  throw "Server binary not found: $ServerBinaryPath. Build it first on Windows with cargo build --release --manifest-path server/Cargo.toml."
}
if (-not (Test-Path $ClientDistPath)) {
  throw "Client dist not found: $ClientDistPath. Build it first with npm --prefix client run build:register or build:pwa."
}
if (-not (Test-Path $RegisterBundlePath) -and -not $AllowMissingRegisterBundle) {
  throw "Register bundle not found: $RegisterBundlePath. Build it first with npm --prefix client run tauri:build, or pass -AllowMissingRegisterBundle."
}
if (-not (Test-Path $ManagerBinaryPath) -and -not $AllowMissingManagerBinary) {
  throw "Manager binary not found: $ManagerBinaryPath. Build it first with cd deployment/manager-app && npx tauri build, or pass -AllowMissingManagerBinary."
}

Assert-ClientDistMatchesSource $ClientDistPath $Version $gitShort

Remove-Item $packageRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\server" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\client-dist" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\migrations" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\seeds" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\register" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\updater" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\docs" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\release-docs" | Out-Null

Copy-Item "$PSScriptRoot\install-server.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\install-register.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\repair-bootstrap-admin.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\reset-riverside-database.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Reset-RiversideDatabase.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\apply-riverside-migrations.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Apply-RiversideMigrations.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\repair-server-credentials-key.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Repair-RiversideCredentialsKey.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\set-counterpoint-bridge-token.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Set-CounterpointBridgeToken.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\Start-RiversideDeployment.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Start-RiversideDeployment.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\Install-RosieAiStack.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Install-RosieAiStack.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\audit-system.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Audit-System.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\reset-postgres-password.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Reset-PostgresPassword.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\remove-main-hub.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\remove-standalone-app.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Export-IntegrationCredentials.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Import-IntegrationCredentials.ps1" $packageRoot -Force

# Include encrypted integration credentials if they were exported and committed
$integrationCredsSource = Join-Path $repoRoot "integration-credentials.sql"
if (Test-Path $integrationCredsSource) {
  Copy-Item $integrationCredsSource $packageRoot -Force
  Write-Host "Packaged integration-credentials.sql (encrypted credential dump)"
}

if (Test-Path $ManagerBinaryPath) {
  Copy-Item $ManagerBinaryPath "$packageRoot\RiversideOS-Deployment-Manager.exe" -Force
  Write-Host "Packaged RiversideOS-Deployment-Manager.exe"
}
Copy-Item "$PSScriptRoot\riverside-deployment.config.example.json" $packageRoot -Force
Copy-Item $ServerBinaryPath "$packageRoot\server\riverside-server.exe" -Force
Copy-Item "$ClientDistPath\*" "$packageRoot\client-dist" -Recurse -Force
Copy-Item "$repoRoot\migrations\*.sql" "$packageRoot\migrations" -Force
Copy-Item "$repoRoot\scripts\seeds\seed_core_required.sql" "$packageRoot\seeds" -Force
Copy-Item "$repoRoot\scripts\seeds\seed_rbac.sql" "$packageRoot\seeds" -Force
Copy-Item "$repoRoot\docs\*" "$packageRoot\release-docs" -Recurse -Force

# ROSIE AI stack manifest - install-server.ps1 reads this to download the pinned model.
New-Item -ItemType Directory -Force -Path "$packageRoot\rosie" | Out-Null
$modelPinSource = Join-Path $repoRoot "tools\ros-gemma\MODEL_PIN.json"
if (Test-Path $modelPinSource) {
  Copy-Item $modelPinSource "$packageRoot\rosie\MODEL_PIN.json" -Force
  Write-Host "Packaged ROSIE MODEL_PIN.json"
} else {
  Write-Warning "tools/ros-gemma/MODEL_PIN.json not found; ROSIE model download will be skipped during server install."
}

$llamaBinSrc = Join-Path $repoRoot "client\src-tauri\binaries"
$llamaBinDest = Join-Path $packageRoot "rosie\bin"
$llamaSourceExe = Join-Path $llamaBinSrc "llama-server-x86_64-pc-windows-msvc.exe"
if (Test-Path $llamaSourceExe) {
  New-Item -ItemType Directory -Force -Path $llamaBinDest | Out-Null
  Copy-Item $llamaSourceExe (Join-Path $llamaBinDest "llama-server.exe") -Force
  Get-ChildItem $llamaBinSrc -Filter "*.dll" -ErrorAction SilentlyContinue |
    Copy-Item -Destination $llamaBinDest -Force
  Write-Host "Packaged rosie/bin/llama-server.exe for Server PC ROSIE host"
} else {
  Write-Warning "client/src-tauri/binaries/llama-server-x86_64-pc-windows-msvc.exe not found; package ROSIE host runtime before building the deployment zip."
}

Copy-Item "$PSScriptRoot\start-riverside-llama.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Start-RiversideLlama.cmd" $packageRoot -Force


$manifest = @{
  releaseVersion = $Version
  sourceGitShort = $gitShort
  sourceGitSha = $gitFull
  packageName = $packageLabel
  builtAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  clientDistPath = (Resolve-FullPath $ClientDistPath)
  serverBinaryPath = (Resolve-FullPath $ServerBinaryPath)
} | ConvertTo-Json -Depth 4
Set-Content -Path "$packageRoot\deployment-package.manifest.json" -Value $manifest -Encoding UTF8

foreach ($doc in @(
  "docs\STORE_DEPLOYMENT_GUIDE.md",
  "docs\PWA_AND_REGISTER_DEPLOYMENT_TASKS.md",
  "docs\HARDWARE_MANAGEMENT.md",
  "docs\LOCAL_UPDATE_PROTOCOL.md",
  "docs\WINDOWS_INSTALLER_PACKAGE.md",
  "docs\DEPLOYMENT_MANAGER.md"
)) {
  $source = Join-Path $repoRoot $doc
  if (Test-Path $source) {
    Copy-Item $source "$packageRoot\docs" -Force
  }
}

if (Test-Path $RegisterBundlePath) {
  Copy-Item "$RegisterBundlePath\*" "$packageRoot\register" -Recurse -Force
  # Remove deployment manager installer from register directory to save space and prevent confusion
  Get-ChildItem "$packageRoot\register" -Recurse -Filter "*deployment*" -ErrorAction SilentlyContinue | Remove-Item -Force
  Get-ChildItem "$packageRoot\register" -Recurse -Filter "*manager*" -ErrorAction SilentlyContinue | Remove-Item -Force
}

if (Test-Path $UpdaterDistPath) {
  Copy-Item "$UpdaterDistPath\*" "$packageRoot\updater" -Recurse -Force
}

$readme = "# RiversideOS $Version Windows Deployment Package`n" +
  "`nPackage build: $gitShort`n" +
  "`n1. Double-click Start-RiversideDeployment.cmd.`n" +
  "2. Choose Backoffice / Server, Register #1, or Back Office Workstation.`n" +
  "3. Click Check, then Install, Update, Repair, or Uninstall.`n" +
  "`nThe Deployment Manager writes riverside-deployment.config.json for you and runs`n" +
  "the correct installer for the selected station type.`n" +
  "`nBackoffice / Server installs both:`n" +
  "`n- The Riverside OS server, database setup, firewall rule, and startup task.`n" +
  "- The Riverside Windows desktop app configured to use the local server.`n" +
  "`nPassword handling:`n" +
  "`n- If PostgreSQL is missing, the manager can offer to install PostgreSQL 18 through Windows Package Manager.`n" +
  "- Enter the existing PostgreSQL admin password when PostgreSQL is already installed.`n" +
  "- Riverside database and app secrets are generated automatically when left blank or placeholder.`n" +
  "- Station settings are written automatically for Register and Back Office workstation installs.`n" +
  "- A deployment-manager.log file is written next to the installer for support.`n" +
  "`nUninstall behavior:`n" +
  "`n- Workstation uninstall removes the Riverside desktop app and station settings.`n" +
  "- Server uninstall removes the Riverside server service, firewall rule, and app files.`n" +
  "- Server uninstall keeps the database, backups, and logs by default.`n" +
  "`nManual fallback:`n" +
  "`n1. Copy riverside-deployment.config.example.json to riverside-deployment.config.json.`n" +
  "2. Fill in the Server PC, database, secret, Register #1, and printer values.`n" +
  "3. On the Backoffice / Server PC, open PowerShell as Administrator and run: .\install-server.ps1`n" +
  "   Then install/configure the desktop app on the same PC: .\install-register.ps1`n" +
  "4. On Register #1, copy this package or the same config file, open PowerShell as Administrator, and run: .\install-register.ps1`n" +
  "`nThe Register installer writes C:\ProgramData\RiversideOS\station-config.json.`n" +
  "The desktop app imports that file on first launch and saves the API/printer settings for the station.`n" +
  "`nDatabase-only repair:`n" +
  "`n- If the app starts but a screen reports a missing relation/table, double-click Apply-RiversideMigrations.cmd.`n" +
  "`nIf the updater folder is present, keep those files with the release:`n" +
  "`n- latest.json`n- the Windows updater installer or archive`n- the matching .sig signature file"
Set-Content -Path "$packageRoot\README.md" -Value $readme -Encoding UTF8

Compress-Archive -Path "$packageRoot\*" -DestinationPath "$packageRoot.zip" -Force
Write-Host "Deployment package created:"
Write-Host $packageRoot
Write-Host "$packageRoot.zip"
