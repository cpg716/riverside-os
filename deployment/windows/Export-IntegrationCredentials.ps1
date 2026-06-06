[CmdletBinding()]
param(
  [string]$ConfigPath = "",
  [string]$OutPath = "integration-credentials.sql"
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

$env:PGPASSWORD = $db.appPassword
try {
  $databaseUrl = "postgresql://$($db.appUser)@$($db.host):$($db.port)/$($db.databaseName)"

  $exists = & $psql $databaseUrl -w -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'integration_credentials');"
  if (($exists -join "").Trim() -ne "t") {
    throw "integration_credentials table does not exist. Run migrations first."
  }

  $count = & $psql $databaseUrl -w -tAc "SELECT count(*) FROM integration_credentials;"
  $count = ($count -join "").Trim()
  if ($count -eq "0") {
    throw "integration_credentials table is empty. Nothing to export."
  }

  Write-Host "Exporting $count credential rows from $($db.databaseName)..."

  & pg_dump -w --data-only --table=integration_credentials --no-owner --no-privileges --column-inserts $databaseUrl > $OutPath

  if ($LASTEXITCODE -ne 0) {
    throw "pg_dump failed with exit code $LASTEXITCODE."
  }

  Write-Host "Exported to $OutPath" -ForegroundColor Green
  Write-Host "You can now commit this file to your repository." -ForegroundColor Green
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
