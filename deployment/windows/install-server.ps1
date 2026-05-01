[CmdletBinding()]
param(
  [string]$ConfigPath = "$PSScriptRoot\riverside-deployment.config.json",
  [switch]$SkipDatabaseCreate,
  [switch]$SkipMigrations,
  [switch]$SkipFirewall,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this installer from an elevated PowerShell window."
  }
}

function Resolve-PsqlPath($dbConfig) {
  if ($dbConfig.psqlPath -and (Test-Path $dbConfig.psqlPath)) {
    return $dbConfig.psqlPath
  }
  $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  $matches = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending
  if ($matches) {
    return $matches[0].FullName
  }
  throw "psql.exe was not found. Install PostgreSQL 16 first, or set server.database.psqlPath in the config."
}

function Invoke-Psql($PsqlPath, $DatabaseUrl, $Sql) {
  $temp = New-TemporaryFile
  try {
    Set-Content -Path $temp -Value $Sql -Encoding UTF8
    & $PsqlPath $DatabaseUrl -v ON_ERROR_STOP=1 -f $temp
    if ($LASTEXITCODE -ne 0) {
      throw "psql failed with exit code $LASTEXITCODE"
    }
  } finally {
    Remove-Item $temp -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-PsqlAdmin($PsqlPath, $Db, $Sql) {
  $env:PGPASSWORD = $Db.adminPassword
  try {
    $adminUrl = "postgresql://$($Db.adminUser)@$($Db.host):$($Db.port)/postgres"
    Invoke-Psql $PsqlPath $adminUrl $Sql
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

function Escape-SqlLiteral([string]$Value) {
  return $Value.Replace("'", "''")
}

function Write-ServerEnv($Path, $Config, $DatabaseUrl, $FrontendDist) {
  $server = $Config.server
  $lines = @(
    "DATABASE_URL=$DatabaseUrl",
    "FRONTEND_DIST=$FrontendDist",
    "RIVERSIDE_HTTP_BIND=$($server.httpBind)",
    "RIVERSIDE_STRICT_PRODUCTION=$($server.strictProduction.ToString().ToLowerInvariant())",
    "RIVERSIDE_CORS_ORIGINS=$(($server.corsOrigins -join ','))",
    "RIVERSIDE_STORE_CUSTOMER_JWT_SECRET=$($server.storeCustomerJwtSecret)"
  )

  if ($server.environment) {
    foreach ($prop in $server.environment.PSObject.Properties) {
      if ($null -ne $prop.Value -and "$($prop.Value)" -ne "") {
        $lines += "$($prop.Name)=$($prop.Value)"
      }
    }
  }

  Set-Content -Path $Path -Value $lines -Encoding UTF8
}

function Get-MigrationSortKey($File) {
  if ($File.Name -match '^(\d+)([a-zA-Z]?)_') {
    return "{0:D6}-{1}-{2}" -f [int]$Matches[1], $Matches[2], $File.Name
  }
  return "999999--$($File.Name)"
}

function Apply-Migrations($PsqlPath, $DatabaseUrl, $MigrationsDir) {
  $ledgerCheck = & $PsqlPath $DatabaseUrl -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations');"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not check migration ledger."
  }
  if (($ledgerCheck -join "").Trim() -ne "t") {
    Invoke-Psql $PsqlPath $DatabaseUrl (Get-Content "$MigrationsDir\00_ros_migration_ledger.sql" -Raw)
    Invoke-Psql $PsqlPath $DatabaseUrl "INSERT INTO ros_schema_migrations (version) VALUES ('00_ros_migration_ledger.sql') ON CONFLICT (version) DO NOTHING;"
  }

  $files = Get-ChildItem $MigrationsDir -Filter "*.sql" |
    Where-Object { $_.Name -match '^\d+[a-zA-Z]?_.*\.sql$' -and $_.Name -ne "00_ros_migration_ledger.sql" } |
    Sort-Object @{ Expression = { Get-MigrationSortKey $_ } }

  foreach ($file in $files) {
    $applied = & $PsqlPath $DatabaseUrl -tAc "SELECT EXISTS(SELECT 1 FROM ros_schema_migrations WHERE version = '$($file.Name)');"
    if (($applied -join "").Trim() -eq "t") {
      Write-Host "Skip migration $($file.Name)"
      continue
    }
    Write-Host "Apply migration $($file.Name)"
    & $PsqlPath $DatabaseUrl -v ON_ERROR_STOP=1 -f $file.FullName
    if ($LASTEXITCODE -ne 0) {
      throw "Migration failed: $($file.Name)"
    }
    Invoke-Psql $PsqlPath $DatabaseUrl "INSERT INTO ros_schema_migrations (version) VALUES ('$($file.Name)') ON CONFLICT (version) DO NOTHING;"
  }
}

Assert-Admin
if (-not (Test-Path $ConfigPath)) {
  throw "Config file not found: $ConfigPath. Copy riverside-deployment.config.example.json to riverside-deployment.config.json and fill it in."
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$server = $config.server
$db = $server.database
$installRoot = $server.installRoot
$serverDir = Join-Path $installRoot "server"
$clientDist = Join-Path $installRoot "client\dist"
$releaseDir = Join-Path $installRoot "release"
$backupDir = Join-Path $installRoot "backups"
$logDir = Join-Path $installRoot "logs"
$packageServerExe = Join-Path $PSScriptRoot "server\riverside-server.exe"
$packageDist = Join-Path $PSScriptRoot "client-dist"
$packageMigrations = Join-Path $PSScriptRoot "migrations"
$packageReleaseDocs = Join-Path $PSScriptRoot "release-docs"

foreach ($dir in @($installRoot, $serverDir, $clientDist, $releaseDir, $backupDir, $logDir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

if (-not (Test-Path $packageServerExe)) {
  throw "Missing server binary in package: $packageServerExe"
}
if (-not (Test-Path $packageDist)) {
  throw "Missing client-dist folder in package: $packageDist"
}
if (-not (Test-Path $packageMigrations)) {
  throw "Missing migrations folder in package: $packageMigrations"
}

Copy-Item $packageServerExe (Join-Path $serverDir "riverside-server.exe") -Force
Remove-Item "$clientDist\*" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$packageDist\*" $clientDist -Recurse -Force
Remove-Item "$releaseDir\migrations" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item $packageMigrations (Join-Path $releaseDir "migrations") -Recurse -Force
if (Test-Path $packageReleaseDocs) {
  Remove-Item "$releaseDir\docs" -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item $packageReleaseDocs (Join-Path $releaseDir "docs") -Recurse -Force
}

$psql = Resolve-PsqlPath $db
$databaseUrl = "postgresql://$($db.appUser):$($db.appPassword)@$($db.host):$($db.port)/$($db.databaseName)"

if (-not $SkipDatabaseCreate) {
  $appUser = Escape-SqlLiteral $db.appUser
  $appPassword = Escape-SqlLiteral $db.appPassword
  $databaseName = Escape-SqlLiteral $db.databaseName
  Invoke-PsqlAdmin $psql $db @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$appUser') THEN
    CREATE ROLE "$appUser" LOGIN PASSWORD '$appPassword';
  ELSE
    ALTER ROLE "$appUser" LOGIN PASSWORD '$appPassword';
  END IF;
END
`$`$;
"@
  $env:PGPASSWORD = $db.adminPassword
  try {
    $exists = & $psql "postgresql://$($db.adminUser)@$($db.host):$($db.port)/postgres" -tAc "SELECT 1 FROM pg_database WHERE datname = '$databaseName';"
    if (($exists -join "").Trim() -ne "1") {
      Invoke-PsqlAdmin $psql $db "CREATE DATABASE ""$databaseName"" OWNER ""$appUser"";"
    }
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

if (-not $SkipMigrations) {
  $env:PGPASSWORD = $db.appPassword
  try {
    Apply-Migrations $psql $databaseUrl (Join-Path $releaseDir "migrations")
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

$envPath = Join-Path $serverDir ".env"
Write-ServerEnv $envPath $config $databaseUrl $clientDist

if (-not $SkipFirewall) {
  $port = ($server.httpBind -split ":")[-1]
  New-NetFirewallRule -DisplayName $server.firewallRuleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Private -ErrorAction SilentlyContinue | Out-Null
}

$taskName = "Riverside OS Server"
$serverExe = Join-Path $serverDir "riverside-server.exe"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute $serverExe -WorkingDirectory $serverDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 3
  $localUrl = "http://127.0.0.1:$(($server.httpBind -split ':')[-1])"
  try {
    Invoke-WebRequest -Uri $localUrl -UseBasicParsing -TimeoutSec 10 | Out-Null
    Write-Host "Riverside OS server responded at $localUrl"
  } catch {
    Write-Warning "Server task started, but $localUrl did not respond yet. Check $logDir and Windows Task Scheduler."
  }
}

$summary = @"
Riverside OS Server install complete.
Install root: $installRoot
Server task: $taskName
Frontend: $clientDist
Database: $($db.databaseName) on $($db.host):$($db.port)
Config: $envPath
"@
Set-Content -Path (Join-Path $installRoot "deployment-summary.txt") -Value $summary -Encoding UTF8
Write-Host $summary
