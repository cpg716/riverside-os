[CmdletBinding()]
param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$packageRoot = $PSScriptRoot
$workbenchDir = Join-Path $packageRoot "counterpoint-sync-workbench"
$envPath = Join-Path $workbenchDir ".env"
$envExamplePath = Join-Path $workbenchDir "env.example"
$dataDir = Join-Path $workbenchDir "data"

if (-not (Test-Path $workbenchDir)) {
  throw "Counterpoint SYNC Workbench was not found at $workbenchDir. Rebuild the Windows deployment package."
}
if (-not (Test-Path (Join-Path $workbenchDir "index.mjs"))) {
  throw "Counterpoint SYNC Workbench runtime is incomplete. Missing index.mjs."
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js 22.5+ is required for Counterpoint SYNC Workbench. Install Node.js on the Main Hub, then run this launcher again."
}

$nodeVersionRaw = (& $node.Source --version).Trim().TrimStart("v")
$nodeVersion = [version]$nodeVersionRaw
if ($nodeVersion -lt [version]"22.5.0") {
  throw "Counterpoint SYNC Workbench requires Node.js 22.5+ for node:sqlite. Found Node.js $nodeVersionRaw."
}

if (-not (Test-Path $envPath)) {
  if (-not (Test-Path $envExamplePath)) {
    throw "Missing env.example for Counterpoint SYNC Workbench."
  }
  Copy-Item $envExamplePath $envPath -Force
  Write-Host "Created counterpoint-sync-workbench\.env from env.example. Review the token before live Bridge use." -ForegroundColor Yellow
}

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Push-Location $workbenchDir
try {
  $env:COUNTERPOINT_SYNC_WORKBENCH_DB = ".\data\sync-workbench-store.sqlite"
  $env:COUNTERPOINT_SYNC_WORKBENCH_STORE = ".\data\sync-workbench-store.json"
  $url = "http://127.0.0.1:3015"
  Write-Host "Starting Counterpoint SYNC Workbench on $url ..." -ForegroundColor Cyan
  Write-Host "Use Ctrl+C in this window to stop the Workbench." -ForegroundColor DarkGray
  if (-not $NoBrowser) {
    Start-Process $url | Out-Null
  }
  & $node.Source "index.mjs"
  if ($LASTEXITCODE -ne 0) {
    throw "Counterpoint SYNC Workbench exited with code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
