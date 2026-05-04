[CmdletBinding()]
param(
  [string]$Version = "0.4.0",
  [string]$OutputDir = "$PSScriptRoot\..\..\dist\deployment",
  [string]$ServerBinaryPath = "$PSScriptRoot\..\..\server\target\release\riverside-server.exe",
  [string]$ClientDistPath = "$PSScriptRoot\..\..\client\dist",
  [string]$RegisterBundlePath = "$PSScriptRoot\..\..\client\src-tauri\target\release\bundle",
  [string]$UpdaterDistPath = "$PSScriptRoot\..\..\client\updater-dist",
  [switch]$AllowMissingRegisterBundle
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

Assert-ClientDistMatchesSource $ClientDistPath $Version $gitShort

Remove-Item $packageRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\server" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\client-dist" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\migrations" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\register" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\updater" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\docs" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\release-docs" | Out-Null

Copy-Item "$PSScriptRoot\install-server.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\install-register.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\repair-bootstrap-admin.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Start-RiversideDeployment.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Start-RiversideDeployment.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\riverside-deployment.config.example.json" $packageRoot -Force
Copy-Item $ServerBinaryPath "$packageRoot\server\riverside-server.exe" -Force
Copy-Item "$ClientDistPath\*" "$packageRoot\client-dist" -Recurse -Force
Copy-Item "$repoRoot\migrations\*.sql" "$packageRoot\migrations" -Force
Copy-Item "$repoRoot\docs\*" "$packageRoot\release-docs" -Recurse -Force

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
  "docs\WINDOWS_INSTALLER_PACKAGE.md"
)) {
  $source = Join-Path $repoRoot $doc
  if (Test-Path $source) {
    Copy-Item $source "$packageRoot\docs" -Force
  }
}

if (Test-Path $RegisterBundlePath) {
  Copy-Item "$RegisterBundlePath\*" "$packageRoot\register" -Recurse -Force
}

if (Test-Path $UpdaterDistPath) {
  Copy-Item "$UpdaterDistPath\*" "$packageRoot\updater" -Recurse -Force
}

$readme = @"
# RiversideOS $Version Windows Deployment Package

Package build: $gitShort

1. Double-click Start-RiversideDeployment.cmd.
2. Choose Backoffice / Server, Register #1, or Back Office Workstation.
3. Click Check, then Install, Update, Repair, or Uninstall.

The Deployment Manager writes riverside-deployment.config.json for you and runs
the correct installer for the selected station type.

Backoffice / Server installs both:

- The Riverside OS server, database setup, firewall rule, and startup task.
- The Riverside Windows desktop app configured to use the local server.

Password handling:

- If PostgreSQL is missing, the manager can offer to install PostgreSQL 18 through Windows Package Manager.
- Enter the existing PostgreSQL admin password when PostgreSQL is already installed.
- Riverside database and app secrets are generated automatically when left blank or placeholder.
- Station settings are written automatically for Register and Back Office workstation installs.
- A deployment-manager.log file is written next to the installer for support.

Uninstall behavior:

- Workstation uninstall removes the Riverside desktop app and station settings.
- Server uninstall removes the Riverside server service, firewall rule, and app files.
- Server uninstall keeps the database, backups, and logs by default.

Manual fallback:

1. Copy riverside-deployment.config.example.json to riverside-deployment.config.json.
2. Fill in the Server PC, database, secret, Register #1, and printer values.
3. On the Backoffice / Server PC, open PowerShell as Administrator and run:

   .\install-server.ps1

   Then install/configure the desktop app on the same PC:

   .\install-register.ps1

4. On Register #1, copy this package or the same config file, open PowerShell as Administrator, and run:

   .\install-register.ps1

The Register installer writes C:\ProgramData\RiversideOS\station-config.json.
The desktop app imports that file on first launch and saves the API/printer settings for the station.

If the updater folder is present, keep those files with the release:

- latest.json
- the Windows updater installer or archive
- the matching .sig signature file
"@
Set-Content -Path "$packageRoot\README.md" -Value $readme -Encoding UTF8

Compress-Archive -Path "$packageRoot\*" -DestinationPath "$packageRoot.zip" -Force
Write-Host "Deployment package created:"
Write-Host $packageRoot
Write-Host "$packageRoot.zip"
