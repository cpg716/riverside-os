[CmdletBinding()]
param(
  [string]$InstallRoot = "C:\RiversideOS"
)

$ErrorActionPreference = "Stop"
$cubeDir = Join-Path $InstallRoot "cube"
$envPath = Join-Path $cubeDir ".env"
$nodeExe = Join-Path $cubeDir "node.exe"
$serverScript = Join-Path $cubeDir "node_modules\@cubejs-backend\server\bin\server"
$logDir = Join-Path $InstallRoot "logs"
$logPath = Join-Path $logDir "cube-core.log"

foreach ($required in @($envPath, $nodeExe, $serverScript, (Join-Path $cubeDir "cube.js"), (Join-Path $cubeDir "model"))) {
  if (-not (Test-Path $required)) {
    throw "Cube Core runtime file is missing: $required"
  }
}

foreach ($line in Get-Content $envPath) {
  $trimmed = "$line".Trim()
  if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) {
    continue
  }
  $parts = $trimmed.Split("=", 2)
  [Environment]::SetEnvironmentVariable($parts[0], $parts[1], "Process")
}

foreach ($requiredName in @(
  "CUBEJS_DB_HOST",
  "CUBEJS_DB_PORT",
  "CUBEJS_DB_NAME",
  "CUBEJS_DB_USER",
  "CUBEJS_DB_PASS",
  "CUBEJS_API_SECRET"
)) {
  $value = [Environment]::GetEnvironmentVariable($requiredName, "Process")
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Cube Core runtime setting is missing: $requiredName"
  }
}

$env:NODE_ENV = "production"
$env:CUBEJS_DEV_MODE = "false"
$env:CUBEJS_TELEMETRY = "false"
$env:CUBEJS_DB_TYPE = "postgres"
$env:PORT = "4000"
$env:CUBEJS_CACHE_AND_QUEUE_DRIVER = "memory"
$env:CUBEJS_SCHEMA_PATH = "model"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Location $cubeDir
& $nodeExe $serverScript *>> $logPath
exit $LASTEXITCODE
