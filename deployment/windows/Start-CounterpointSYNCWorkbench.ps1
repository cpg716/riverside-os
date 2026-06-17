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
$bundledNodePath = Join-Path $packageRoot "node-runtime\node.exe"

if (-not (Test-Path $workbenchDir)) {
  throw "Counterpoint SYNC Workbench was not found at $workbenchDir. Rebuild the Windows deployment package."
}
if (-not (Test-Path (Join-Path $workbenchDir "index.mjs"))) {
  throw "Counterpoint SYNC Workbench runtime is incomplete. Missing index.mjs."
}

$nodePath = $bundledNodePath
if (-not (Test-Path $nodePath)) {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) {
    throw "Counterpoint SYNC Workbench needs Node.js 22.5+ or the bundled node-runtime\node.exe. Rebuild the Windows deployment package or install Node.js 22.5+ on the Main Hub."
  }
  $nodePath = $node.Source
}

$nodeVersionRaw = (& $nodePath --version).Trim().TrimStart("v")
$nodeVersion = [version]$nodeVersionRaw
if ($nodeVersion -lt [version]"22.5.0") {
  throw "Counterpoint SYNC Workbench requires Node.js 22.5+ for node:sqlite. Found Node.js $nodeVersionRaw."
}

if (-not (Test-Path $envPath)) {
  if (-not (Test-Path $envExamplePath)) {
    throw "Missing env.example for Counterpoint SYNC Workbench."
  }
  Copy-Item $envExamplePath $envPath -Force
  Write-Host "Created counterpoint-sync-workbench\.env from env.example. Bridge PCs should use this Main Hub LAN address with port 3015." -ForegroundColor Yellow
}

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Push-Location $workbenchDir
try {
  $env:COUNTERPOINT_SYNC_WORKBENCH_DB = ".\data\sync-workbench-store.sqlite"
  $env:COUNTERPOINT_SYNC_WORKBENCH_STORE = ".\data\sync-workbench-store.json"
  if (-not $env:COUNTERPOINT_SYNC_WORKBENCH_HOST) {
    $env:COUNTERPOINT_SYNC_WORKBENCH_HOST = "0.0.0.0"
  }
  $port = if ($env:COUNTERPOINT_SYNC_WORKBENCH_PORT) { $env:COUNTERPOINT_SYNC_WORKBENCH_PORT } else { "3015" }
  $url = "http://127.0.0.1:$port"
  Write-Host "Starting Counterpoint SYNC Workbench API on $url locally and port $port on the Main Hub LAN ..." -ForegroundColor Cyan
  Write-Host "Using Node.js $nodeVersionRaw from $nodePath" -ForegroundColor DarkGray
  Write-Host "The browser opens only after /health returns Counterpoint SYNC JSON." -ForegroundColor DarkGray
  $process = Start-Process -FilePath $nodePath -ArgumentList "index.mjs" -WorkingDirectory $workbenchDir -PassThru -NoNewWindow
  $healthy = $false
  $lastError = ""
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    if ($process.HasExited) {
      throw "Counterpoint SYNC Workbench exited before health check passed. Exit code $($process.ExitCode)."
    }
    try {
      $response = Invoke-WebRequest -Uri "$url/health" -UseBasicParsing -TimeoutSec 2
      $body = [string]$response.Content
      if ($body.TrimStart().StartsWith("{")) {
        $health = $body | ConvertFrom-Json
        if ($health.service -eq "counterpoint_sync_workbench" -and $health.ok -ne $false) {
          $healthy = $true
          break
        }
        $lastError = "Unexpected health service '$($health.service)'."
      } else {
        $snippet = $body.Substring(0, [Math]::Min(120, $body.Length))
        $lastError = "Port $port returned HTML/text instead of Counterpoint SYNC JSON: $snippet"
      }
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $healthy) {
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    throw "Counterpoint SYNC Workbench did not return JSON at $url/health. $lastError Stop any other app using port $port or set COUNTERPOINT_SYNC_WORKBENCH_PORT to a free port."
  }
  Write-Host "Counterpoint SYNC Workbench health OK: $url/health" -ForegroundColor Green
  if (-not $NoBrowser) {
    Start-Process $url | Out-Null
  }
  Write-Host "Use Ctrl+C in this window to stop the Workbench." -ForegroundColor DarkGray
  Wait-Process -Id $process.Id
  if ($process.ExitCode -ne 0) {
    throw "Counterpoint SYNC Workbench exited with code $($process.ExitCode)."
  }
} finally {
  Pop-Location
}
