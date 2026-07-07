[CmdletBinding()]
param(
  [string]$SourceRoot = "",
  [string]$ConfigPath = "C:\RiversideOS\riverside-deployment.config.json",
  [string]$PackageRoot = "",
  [ValidateSet("ClientOnly", "Full")]
  [string]$Mode = "Full",
  [string]$SourceGitSha = "",
  [string]$SourceGitShort = "",
  [switch]$SkipToolInstall,
  [switch]$SkipNpmInstall,
  [switch]$SkipMigrations,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = $null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })
  if (-not $isAdmin) {
    throw "Run this script from an elevated PowerShell window on the Main Hub."
  }
}

function Resolve-FullPath([string]$Path) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Get-GitShort([string]$RepoRoot) {
  try {
    return (& git -C $RepoRoot rev-parse --short=8 HEAD 2>$null).Trim()
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

function Refresh-MachinePath {
  $machine = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
  $user = [System.Environment]::GetEnvironmentVariable("PATH", "User")
  $env:PATH = "$machine;$user;$env:PATH"
}

function Ensure-Command([string]$CommandName, [string]$WingetId) {
  if (Get-Command $CommandName -ErrorAction SilentlyContinue) {
    return
  }
  if ($SkipToolInstall) {
    throw "$CommandName was not found. Install $WingetId on the Main Hub or rerun without -SkipToolInstall."
  }

  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "$CommandName was not found and winget.exe is unavailable."
  }

  Write-Host "Installing $WingetId for local Main Hub builds..."
  & $winget.Source install -e --id $WingetId --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "winget install failed for $WingetId with exit code $LASTEXITCODE."
  }
  Refresh-MachinePath
  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "$CommandName is still unavailable after installing $WingetId. Restart PowerShell and retry."
  }
}

function Invoke-Step([string]$Label, [scriptblock]$Action) {
  Write-Host ""
  Write-Host "--- $Label ---"
  $oldErrorActionPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5 can wrap native stderr output as NativeCommandError.
    # npm/cargo warnings should not abort unless the process exit code is nonzero.
    $ErrorActionPreference = "Continue"
    & $Action
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode."
  }
}

function Copy-DeploymentScripts([string]$RepoRoot, [string]$Dest) {
  $source = Join-Path $RepoRoot "deployment\windows"
  foreach ($file in Get-ChildItem $source -File -Include "*.ps1", "*.cmd", "*.json") {
    Copy-Item $file.FullName $Dest -Force
  }
}

function Ensure-MeilisearchRuntime([string]$DestPackageRoot) {
  $destDir = Join-Path $DestPackageRoot "meilisearch"
  $destExe = Join-Path $destDir "meilisearch.exe"
  if (Test-Path $destExe) {
    return
  }

  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  $installedExe = "C:\RiversideOS\meilisearch\meilisearch.exe"
  if (Test-Path $installedExe) {
    Copy-Item $installedExe $destExe -Force
    return
  }

  $url = "https://github.com/meilisearch/meilisearch/releases/download/v1.11.3/meilisearch-windows-amd64.exe"
  Write-Host "Downloading Meilisearch runtime for package..."
  Invoke-WebRequest -Uri $url -OutFile $destExe -UseBasicParsing
}

function Resolve-InstallRootFromConfig([string]$Path) {
  $config = Get-Content $Path -Raw | ConvertFrom-Json
  $installRoot = $config.server.installRoot
  if ([string]::IsNullOrWhiteSpace($installRoot)) {
    return "C:\RiversideOS"
  }
  return $installRoot
}

function Get-ServerHealthUrl([string]$Path) {
  $config = Get-Content $Path -Raw | ConvertFrom-Json
  $httpBind = $config.server.httpBind
  if ([string]::IsNullOrWhiteSpace($httpBind)) {
    return "http://127.0.0.1:3000/api/health"
  }
  if ($httpBind -match ':(\d+)$') {
    return "http://127.0.0.1:$($Matches[1])/api/health"
  }
  return "http://127.0.0.1:3000/api/health"
}

function Test-ServerHealth([string]$ConfigPath) {
  $healthUrl = Get-ServerHealthUrl $ConfigPath
  try {
    $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 10
    if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
      throw "Unexpected status code $($response.StatusCode)."
    }
    Write-Host "Main Hub health check passed: $healthUrl" -ForegroundColor Green
  } catch {
    throw "Main Hub health check failed at ${healthUrl}: $($_.Exception.Message)"
  }
}

function Apply-ClientDistUpdate(
  [string]$RepoRoot,
  [string]$ConfigPath,
  [string]$Version,
  [string]$GitShort,
  [string]$GitFull
) {
  $builtDist = Join-Path $RepoRoot "client\dist"
  $builtIndex = Join-Path $builtDist "index.html"
  if (-not (Test-Path $builtIndex)) {
    throw "Built client dist is missing index.html: $builtDist"
  }

  $installRoot = Resolve-InstallRootFromConfig $ConfigPath
  $clientRoot = Join-Path $installRoot "client"
  $clientDist = Join-Path $clientRoot "dist"
  $releaseRoot = Join-Path $installRoot "release\lan-client"
  $timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  $stage = Join-Path $releaseRoot "dist-$Version-$GitShort-$timestamp"
  $backup = Join-Path $releaseRoot "backup-$timestamp"

  New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Copy-Item (Join-Path $builtDist "*") $stage -Recurse -Force

  $manifest = @{
    releaseVersion = $Version
    sourceGitShort = $GitShort
    sourceGitSha = $GitFull
    appliedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    updateMode = "client-only"
  } | ConvertTo-Json -Depth 4
  Set-Content -Path (Join-Path $stage "riverside-lan-update.json") -Value $manifest -Encoding UTF8

  New-Item -ItemType Directory -Force -Path $clientRoot | Out-Null
  try {
    if (Test-Path $clientDist) {
      Move-Item -Path $clientDist -Destination $backup -Force
    }
    Move-Item -Path $stage -Destination $clientDist -Force
    Remove-Item $backup -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    if ((-not (Test-Path $clientDist)) -and (Test-Path $backup)) {
      Move-Item -Path $backup -Destination $clientDist -Force
    }
    throw
  }

  Set-Content -Path (Join-Path $installRoot "lan-update-summary.json") -Value $manifest -Encoding UTF8
  Write-Host "Main Hub client dist updated: $clientDist"
  Test-ServerHealth $ConfigPath
}

Assert-Admin

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
  $SourceRoot = Resolve-FullPath (Join-Path $PSScriptRoot "..\..")
} else {
  $SourceRoot = Resolve-FullPath $SourceRoot
}

if (-not (Test-Path (Join-Path $SourceRoot "package.json"))) {
  throw "SourceRoot does not look like the Riverside OS repo: $SourceRoot"
}
if (-not (Test-Path $ConfigPath)) {
  throw "Main Hub config was not found: $ConfigPath"
}

Ensure-Command node.exe "OpenJS.NodeJS.LTS"
Ensure-Command npm.cmd "OpenJS.NodeJS.LTS"
if ($Mode -eq "Full") {
  Ensure-Command cargo.exe "Rustlang.Rustup"
}
Refresh-MachinePath

if (-not $SkipNpmInstall) {
  Invoke-Step "Install root npm dependencies" { npm ci --prefix $SourceRoot }
  Invoke-Step "Install client npm dependencies" { npm ci --prefix (Join-Path $SourceRoot "client") }
}

Invoke-Step "Build client web bundle" { npm run build --prefix $SourceRoot }

$gitShort = $SourceGitShort
if ([string]::IsNullOrWhiteSpace($gitShort)) {
  $gitShort = Get-GitShort $SourceRoot
}
$gitFull = $SourceGitSha
if ([string]::IsNullOrWhiteSpace($gitFull)) {
  $gitFull = Get-GitFull $SourceRoot
}
$version = (Get-Content (Join-Path $SourceRoot "package.json") -Raw | ConvertFrom-Json).version

if ($Mode -eq "ClientOnly") {
  Apply-ClientDistUpdate $SourceRoot $ConfigPath $version $gitShort $gitFull
  Write-Host ""
  Write-Host "Main Hub client-only LAN update complete."
  exit 0
}

Invoke-Step "Build Windows server binary" { cargo build --release --manifest-path (Join-Path $SourceRoot "server\Cargo.toml") }

if ([string]::IsNullOrWhiteSpace($PackageRoot)) {
  $PackageRoot = Join-Path $SourceRoot "dist\main-hub-fast-update\RiversideOS-v$version-$gitShort-MainHub-Update"
}
$PackageRoot = Resolve-FullPath $PackageRoot

Remove-Item $PackageRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $PackageRoot | Out-Null
foreach ($dir in @("server", "client-dist", "migrations", "seeds", "docs")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $PackageRoot $dir) | Out-Null
}

Copy-DeploymentScripts $SourceRoot $PackageRoot
Copy-Item (Join-Path $SourceRoot "target\release\riverside-server.exe") (Join-Path $PackageRoot "server\riverside-server.exe") -Force
Copy-Item (Join-Path $SourceRoot "client\dist\*") (Join-Path $PackageRoot "client-dist") -Recurse -Force
Copy-Item (Join-Path $SourceRoot "migrations\*.sql") (Join-Path $PackageRoot "migrations") -Force
Copy-Item (Join-Path $SourceRoot "scripts\seeds\seed_core_required.sql") (Join-Path $PackageRoot "seeds") -Force
Copy-Item (Join-Path $SourceRoot "scripts\seeds\seed_rbac.sql") (Join-Path $PackageRoot "seeds") -Force
Ensure-MeilisearchRuntime $PackageRoot

$manifest = @{
  releaseVersion = $version
  sourceGitShort = $gitShort
  sourceGitSha = $gitFull
  packageName = Split-Path $PackageRoot -Leaf
  builtAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  fastLanUpdate = $true
} | ConvertTo-Json -Depth 4
Set-Content -Path (Join-Path $PackageRoot "deployment-package.manifest.json") -Value $manifest -Encoding UTF8

$installer = Join-Path $PackageRoot "install-server.ps1"
$installerArgs = @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  $installer,
  "-ConfigPath",
  $ConfigPath,
  "-SkipRosieSetup"
)
if ($SkipMigrations) { $installerArgs += "-SkipMigrations" }
if ($NoStart) { $installerArgs += "-NoStart" }

Write-Host ""
Write-Host "--- Apply Main Hub fast update ---"
& powershell.exe @installerArgs
if ($LASTEXITCODE -ne 0) {
  throw "install-server.ps1 failed with exit code $LASTEXITCODE."
}

Write-Host ""
Write-Host "Main Hub fast update complete: $PackageRoot"
