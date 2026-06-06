[CmdletBinding()]
param(
  [string]$ConfigPath = "",
  [string]$SqlPath = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$ScriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ScriptRoot)) {
  $ScriptRoot = if ($MyInvocation -and $MyInvocation.MyCommand -and $MyInvocation.MyCommand.Path) {
    Split-Path -Parent $MyInvocation.MyCommand.Path
  } else {
    "."
  }
}

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $ScriptRoot "riverside-deployment.config.json"
}
if (-not (Test-Path $ConfigPath)) {
  throw "Config file not found: $ConfigPath"
}

if ([string]::IsNullOrWhiteSpace($SqlPath)) {
  $SqlPath = Join-Path $ScriptRoot "integration-credentials.sql"
}

if (-not (Test-Path $SqlPath)) {
  Write-Host "No integration-credentials.sql found in deployment package. Skipping credential import."
  return
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$db = $config.server.database

$psql = Get-Command psql.exe -ErrorAction SilentlyContinue
if (-not $psql) {
  $psql = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($psql) { $psql = $psql.FullName } else { throw "psql.exe not found." }
} else {
  $psql = $psql.Source
}

$databaseUrl = "postgresql://$($db.appUser):$($db.appPassword)@$($db.host):$($db.port)/$($db.databaseName)"

$env:PGPASSWORD = $db.appPassword
try {
  $tableExists = & $psql $databaseUrl -w -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'integration_credentials');"
  if (($tableExists -join "").Trim() -ne "t") {
    Write-Warning "integration_credentials table does not exist yet. Skipping credential import."
    return
  }

  $existingCount = & $psql $databaseUrl -w -tAc "SELECT count(*) FROM integration_credentials;"
  $existingCount = ($existingCount -join "").Trim()

  if ($existingCount -ne "0" -and -not $Force) {
    Write-Host "integration_credentials already has $existingCount rows. Skipping import (use -Force to overwrite)."
    return
  }

  if ($existingCount -ne "0" -and $Force) {
    Write-Host "Clearing $existingCount existing credential rows for forced import..."
    & $psql $databaseUrl -w -c "TRUNCATE TABLE integration_credentials;" 2>&1 | Write-Host
  }

  Write-Host "Importing integration credentials from $SqlPath..."
  & $psql $databaseUrl -v ON_ERROR_STOP=1 -1 -w -f $SqlPath 2>&1 | Write-Host
  if ($LASTEXITCODE -ne 0) {
    throw "psql import failed with exit code $LASTEXITCODE."
  }

  $importedCount = & $psql $databaseUrl -w -tAc "SELECT count(*) FROM integration_credentials;"
  $importedCount = ($importedCount -join "").Trim()
  Write-Host "Integration credentials imported: $importedCount rows." -ForegroundColor Green
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
