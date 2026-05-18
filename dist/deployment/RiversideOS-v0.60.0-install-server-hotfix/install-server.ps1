[CmdletBinding()]
param(
  [string]$ConfigPath = "$PSScriptRoot\riverside-deployment.config.json",
  [switch]$SkipDatabaseCreate,
  [switch]$SkipMigrations,
  [switch]$SkipFirewall,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$script:lastNativeCommandOutput = ""

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
  throw "psql.exe was not found. Install PostgreSQL first, or set server.database.psqlPath in the config."
}

function Ensure-PostgresServiceRunning {
  $services = Get-Service -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "postgresql*" -or $_.DisplayName -like "PostgreSQL*" } |
    Sort-Object Name -Descending

  if (-not $services) {
    Write-Warning "No PostgreSQL Windows service was found. Continuing because psql.exe exists, but database connection may fail if PostgreSQL is not running."
    return
  }

  $service = $services[0]
  if ($service.Status -ne "Running") {
    Write-Host "Starting PostgreSQL service $($service.Name)"
    Start-Service -Name $service.Name
    $service.WaitForStatus("Running", (New-TimeSpan -Seconds 30))
  }
  Set-Service -Name $service.Name -StartupType Automatic
}

function ConvertTo-NativeArgument([string]$Argument) {
  if ($Argument -notmatch '[\s"]') {
    return $Argument
  }
  return '"' + ($Argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-NativeCommand([string]$FilePath, [string[]]$Arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = ($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join " "
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $script:lastNativeCommandOutput = (($stderr, $stdout) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd() }) -join "`n"

  if ($stdout) {
    Write-Host $stdout.TrimEnd()
  }
  if ($stderr) {
    Write-Host $stderr.TrimEnd()
  }
  return $process.ExitCode
}

function Invoke-Psql($PsqlPath, $DatabaseUrl, $Sql) {
  $temp = New-TemporaryFile
  try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($temp.FullName, $Sql, $utf8NoBom)
    $exitCode = Invoke-NativeCommand $PsqlPath @($DatabaseUrl, "-v", "ON_ERROR_STOP=1", "-f", $temp.FullName)
    if ($exitCode -ne 0) {
      throw "psql failed with exit code $exitCode. $script:lastNativeCommandOutput"
    }
  } finally {
    Remove-Item $temp -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-PsqlFile($PsqlPath, $DatabaseUrl, $FilePath) {
  $exitCode = Invoke-NativeCommand $PsqlPath @($DatabaseUrl, "-v", "ON_ERROR_STOP=1", "-f", $FilePath)
  if ($exitCode -ne 0) {
    throw "psql failed with exit code $exitCode. $script:lastNativeCommandOutput"
  }
}

function Invoke-PsqlScalar($PsqlPath, $DatabaseUrl, [string]$Sql) {
  $result = & $PsqlPath $DatabaseUrl -tAc $Sql
  if ($LASTEXITCODE -ne 0) {
    throw "psql scalar query failed. $($result -join "`n")"
  }
  return (($result -join "").Trim())
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

function Invoke-PsqlAdminDatabase($PsqlPath, $Db, $DatabaseName, $Sql) {
  $env:PGPASSWORD = $Db.adminPassword
  try {
    $adminUrl = "postgresql://$($Db.adminUser)@$($Db.host):$($Db.port)/$DatabaseName"
    Invoke-Psql $PsqlPath $adminUrl $Sql
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

function Ensure-OptionalReportingRole($PsqlPath, $Db) {
  try {
    Invoke-PsqlAdmin $PsqlPath $Db "DO `$`$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'metabase_ro') THEN CREATE ROLE metabase_ro NOLOGIN; END IF; END `$`$;"
  } catch {
    Write-Warning "Could not create optional reporting role metabase_ro. Reporting grants will be skipped where supported."
  }
}

function Ensure-DatabaseExtension($PsqlPath, $Db, [string]$DatabaseName, [string]$ExtensionName) {
  try {
    Invoke-PsqlAdminDatabase $PsqlPath $Db $DatabaseName "CREATE EXTENSION IF NOT EXISTS ""$ExtensionName"";"
  } catch {
    Write-Warning "Could not preinstall PostgreSQL extension $ExtensionName. The matching migration will report details if it is required."
  }
}

function Get-DatabaseEncoding($PsqlPath, $Db, [string]$DatabaseName) {
  $env:PGPASSWORD = $Db.adminPassword
  try {
    $adminUrl = "postgresql://$($Db.adminUser)@$($Db.host):$($Db.port)/$DatabaseName"
    $encoding = & $PsqlPath $adminUrl -tAc "SHOW server_encoding;"
    if ($LASTEXITCODE -ne 0) {
      throw "Could not check encoding for database '$DatabaseName'."
    }
    return (($encoding -join "").Trim())
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

function Assert-DatabaseUtf8($PsqlPath, $Db, [string]$DatabaseName) {
  $encoding = Get-DatabaseEncoding $PsqlPath $Db $DatabaseName
  if ($encoding -ne "UTF8") {
    throw "Database '$DatabaseName' is encoded as '$encoding'. Riverside OS requires UTF8. During a fresh failed install, run Reset-RiversideDatabase.cmd, then rerun Backoffice / Server Install."
  }
}

function Ensure-BootstrapAdmin($PsqlPath, $DatabaseUrl) {
  $bootstrapPinHash = '$argon2id$v=19$m=19456,t=2,p=1$KWJoKjtQYNuPjRIyKL2M9g$FBpoET53ejevTU5LrsLTzQMrgXpV5NavqruJmerdPsc'
  Invoke-Psql $PsqlPath $DatabaseUrl @"
INSERT INTO staff (
  full_name,
  cashier_code,
  pin_hash,
  role,
  is_active,
  avatar_key
)
VALUES (
  'Chris G',
  '1234',
  '$bootstrapPinHash',
  'admin',
  TRUE,
  'ros_default'
)
ON CONFLICT (cashier_code) DO UPDATE
SET
  full_name = EXCLUDED.full_name,
  pin_hash = EXCLUDED.pin_hash,
  role = EXCLUDED.role,
  is_active = TRUE,
  avatar_key = COALESCE(staff.avatar_key, EXCLUDED.avatar_key);

DO `$`$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM staff
    WHERE cashier_code = '1234'
      AND role = 'admin'::staff_role
      AND is_active = TRUE
      AND pin_hash IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Bootstrap admin was not created.';
  END IF;
END
`$`$;
"@
}

function Stop-RiversideServer {
  Stop-ScheduledTask -TaskName "Riverside OS Server" -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  foreach ($process in Get-Process -Name "riverside-server" -ErrorAction SilentlyContinue) {
    try {
      Stop-Process -Id $process.Id -Force -ErrorAction Stop
    } catch {
      Write-Warning "Could not stop Riverside server process $($process.Id): $($_.Exception.Message)"
    }
  }
}

function Stop-PortListeners([int]$Port) {
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

  foreach ($processId in $listeners) {
    if (-not $processId -or $processId -eq $PID) {
      continue
    }

    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $process) {
      continue
    }

    Write-Host "Stopping process using Riverside port ${Port}: $($process.ProcessName) ($processId)"
    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
    } catch {
      throw "Could not stop process using Riverside port ${Port}: $($process.ProcessName) ($processId). Close it and run install again."
    }
  }
}

function Confirm-InstalledClientVersion($ClientDistPath, [string]$ExpectedVersion, [string]$ExpectedGitShort) {
  if (-not $ExpectedVersion -and -not $ExpectedGitShort) {
    return
  }

  $assetDir = Join-Path $ClientDistPath "assets"
  if (-not (Test-Path $assetDir)) {
    Write-Warning "Client asset folder was not found after install: $assetDir"
    return
  }

  $scripts = Get-ChildItem $assetDir -Filter "*.js" -ErrorAction SilentlyContinue

  if ($ExpectedVersion) {
    $versionMatches = $scripts |
      Select-String -Pattern $ExpectedVersion -SimpleMatch -List -ErrorAction SilentlyContinue |
      Select-Object -First 1

    if ($versionMatches) {
      Write-Host "Installed client bundle version marker found: $ExpectedVersion"
    } else {
      throw "Installed client bundle does not contain expected version marker $ExpectedVersion. Rebuild the full deployment package before deployment."
    }
  }

  if ($ExpectedGitShort) {
    $gitMatches = $scripts |
      Select-String -Pattern $ExpectedGitShort -SimpleMatch -List -ErrorAction SilentlyContinue |
      Select-Object -First 1

    if ($gitMatches) {
      Write-Host "Installed client bundle git marker found: $ExpectedGitShort"
    } else {
      throw "Installed client bundle does not contain expected git marker $ExpectedGitShort. Rebuild the full deployment package before deployment."
    }
  }
}

function Test-RiversideApiReady([string]$BaseUrl, [int]$Port) {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $listener) {
    return $false
  }

  $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if (-not $process -or $process.ProcessName -ne "riverside-server") {
    $owner = if ($process) { "$($process.ProcessName) ($($process.Id))" } else { "process $($listener.OwningProcess)" }
    throw "Port $Port is being used by $owner instead of Riverside OS Server."
  }

  try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/api/staff/list-for-pos" -UseBasicParsing -TimeoutSec 3
    $content = "$($response.Content)".TrimStart()
    return $response.StatusCode -eq 200 -and ($content.StartsWith("[") -or $content.StartsWith("{"))
  } catch {
    Write-Host "API check is not ready yet: $($_.Exception.Message)"
    return $false
  }
}

function Wait-RiversideApiReady([string]$BaseUrl, [int]$Port) {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    if (Test-RiversideApiReady $BaseUrl $Port) {
      return
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  throw "Riverside OS Server did not pass the API check at $BaseUrl/api/staff/list-for-pos."
}

function Ensure-RiversideFirewallRule([string]$DisplayName, [int]$Port) {
  Remove-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue
  New-NetFirewallRule `
    -DisplayName $DisplayName `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort $Port `
    -Action Allow `
    -Profile Any | Out-Null
}

function Escape-SqlLiteral([string]$Value) {
  return $Value.Replace("'", "''")
}

function Write-ServerEnv($Path, $Config, $DatabaseUrl, $FrontendDist) {
  $server = $Config.server
  $environmentMode = if ([bool]$server.strictProduction) { "production" } else { "development" }
  $corsOrigins = @($server.corsOrigins) |
    Where-Object { $null -ne $_ -and "$_".Trim() -ne "" } |
    ForEach-Object { "$_".Trim() }
  foreach ($requiredOrigin in @("http://tauri.localhost", "https://tauri.localhost")) {
    if ($corsOrigins -notcontains $requiredOrigin) {
      $corsOrigins += $requiredOrigin
    }
  }
  $lines = @(
    "DATABASE_URL=$DatabaseUrl",
    "FRONTEND_DIST=$FrontendDist",
    "RIVERSIDE_HTTP_BIND=$($server.httpBind)",
    "RIVERSIDE_MODE=$environmentMode",
    "RIVERSIDE_STRICT_PRODUCTION=$($server.strictProduction.ToString().ToLowerInvariant())",
    "RIVERSIDE_CORS_ORIGINS=$(($corsOrigins -join ','))",
    "RIVERSIDE_STORE_CUSTOMER_JWT_SECRET=$($server.storeCustomerJwtSecret)",
    "RIVERSIDE_CREDENTIALS_KEY=$($server.storeCustomerJwtSecret)"
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

function Get-MigrationLedgerExists($PsqlPath, $DatabaseUrl) {
  $ledgerCheck = & $PsqlPath $DatabaseUrl -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations');"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not check migration ledger."
  }
  return (($ledgerCheck -join "").Trim() -eq "t")
}

function Get-MigrationApplied($PsqlPath, $DatabaseUrl, [string]$Version) {
  $migrationVersion = Escape-SqlLiteral $Version
  $applied = & $PsqlPath $DatabaseUrl -tAc "SELECT EXISTS(SELECT 1 FROM ros_schema_migrations WHERE version = '$migrationVersion');"
  return (($applied -join "").Trim() -eq "t")
}

function Add-MigrationLedgerEntry($PsqlPath, $DatabaseUrl, [string]$Version) {
  $migrationVersion = Escape-SqlLiteral $Version
  Invoke-Psql $PsqlPath $DatabaseUrl "INSERT INTO ros_schema_migrations (version) SELECT '$migrationVersion' WHERE NOT EXISTS (SELECT 1 FROM ros_schema_migrations WHERE version = '$migrationVersion');"
}

function Test-CoreIdentityMigrationApplied($PsqlPath, $DatabaseUrl) {
  $result = & $PsqlPath $DatabaseUrl -tAc "SELECT to_regclass('public.store_settings') IS NOT NULL AND to_regclass('public.variant_sku_seq') IS NOT NULL;"
  return (($result -join "").Trim() -eq "t")
}

function Apply-Migrations($PsqlPath, $DatabaseUrl, $MigrationsDir) {
  $files = Get-ChildItem $MigrationsDir -Filter "*.sql" |
    Where-Object { $_.Name -match '^\d+[a-zA-Z]?_.*\.sql$' } |
    Sort-Object @{ Expression = { Get-MigrationSortKey $_ } }

  foreach ($file in $files) {
    if (Get-MigrationLedgerExists $PsqlPath $DatabaseUrl) {
      if (Get-MigrationApplied $PsqlPath $DatabaseUrl $file.Name) {
        Write-Host "Skip migration $($file.Name)"
        continue
      }
      if ($file.Name -eq "001_core_identity_staff.sql" -and (Test-CoreIdentityMigrationApplied $PsqlPath $DatabaseUrl)) {
        Write-Host "Recover migration ledger for $($file.Name)"
        Add-MigrationLedgerEntry $PsqlPath $DatabaseUrl $file.Name
        continue
      }
    }

    Write-Host "Apply migration $($file.Name)"
    try {
      Invoke-PsqlFile $PsqlPath $DatabaseUrl $file.FullName
    } catch {
      throw "Migration failed: $($file.Name). $($_.Exception.Message)"
    }
    if (-not (Get-MigrationLedgerExists $PsqlPath $DatabaseUrl)) {
      throw "Migration $($file.Name) did not create public.ros_schema_migrations; cannot record ledger state."
    }
    Add-MigrationLedgerEntry $PsqlPath $DatabaseUrl $file.Name
  }
}

function Apply-SeedFiles($PsqlPath, $DatabaseUrl, $SeedsDir) {
  $requiredSeeds = @(
    "seed_core_required.sql",
    "seed_rbac.sql"
  )

  foreach ($seedName in $requiredSeeds) {
    $seedPath = Join-Path $SeedsDir $seedName
    if (-not (Test-Path $seedPath)) {
      throw "Missing required seed file: $seedPath. Rebuild the deployment package or copy the seeds folder into the package root."
    }

    Write-Host "Apply seed $seedName"
    try {
      Invoke-PsqlFile $PsqlPath $DatabaseUrl $seedPath
    } catch {
      throw "Seed failed: $seedName. $($_.Exception.Message)"
    }
  }
}

function Set-DatabaseEnvironmentMode($PsqlPath, $DatabaseUrl, [bool]$StrictProduction) {
  $mode = if ($StrictProduction) { "production" } else { "development" }
  Invoke-Psql $PsqlPath $DatabaseUrl "UPDATE store_settings SET environment_mode = '$mode' WHERE id = 1;"
  $actualMode = Invoke-PsqlScalar $PsqlPath $DatabaseUrl "SELECT environment_mode FROM store_settings WHERE id = 1;"
  if ($actualMode -ne $mode) {
    throw "Could not stamp database environment_mode as '$mode'. Current value: '$actualMode'."
  }
}

Assert-Admin
if (-not (Test-Path $ConfigPath)) {
  throw "Config file not found: $ConfigPath. Copy riverside-deployment.config.example.json to riverside-deployment.config.json and fill it in."
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$packageManifestPath = Join-Path $PSScriptRoot "deployment-package.manifest.json"
$packageManifest = $null
if (Test-Path $packageManifestPath) {
  $packageManifest = Get-Content $packageManifestPath -Raw | ConvertFrom-Json
}
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
$packageSeeds = Join-Path $PSScriptRoot "seeds"
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
if (-not (Test-Path $packageSeeds)) {
  throw "Missing seeds folder in package: $packageSeeds"
}

$taskName = "Riverside OS Server"
$serverPort = [int](($server.httpBind -split ":")[-1])
Stop-RiversideServer
Stop-PortListeners $serverPort

Copy-Item $packageServerExe (Join-Path $serverDir "riverside-server.exe") -Force
Remove-Item "$clientDist\*" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$packageDist\*" $clientDist -Recurse -Force
Confirm-InstalledClientVersion $clientDist $config.releaseVersion $packageManifest.sourceGitShort
Remove-Item "$releaseDir\migrations" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item $packageMigrations (Join-Path $releaseDir "migrations") -Recurse -Force
Remove-Item "$releaseDir\seeds" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item $packageSeeds (Join-Path $releaseDir "seeds") -Recurse -Force
if (Test-Path $packageReleaseDocs) {
  Remove-Item "$releaseDir\docs" -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item $packageReleaseDocs (Join-Path $releaseDir "docs") -Recurse -Force
}

$psql = Resolve-PsqlPath $db
Ensure-PostgresServiceRunning
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
      Invoke-PsqlAdmin $psql $db "CREATE DATABASE ""$databaseName"" WITH OWNER ""$appUser"" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';"
    }
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
  Assert-DatabaseUtf8 $psql $db $databaseName
  Invoke-PsqlAdmin $psql $db "ALTER DATABASE ""$databaseName"" OWNER TO ""$appUser""; GRANT CREATE ON DATABASE ""$databaseName"" TO ""$appUser"";"
  Invoke-PsqlAdminDatabase $psql $db $databaseName "ALTER SCHEMA public OWNER TO ""$appUser""; GRANT ALL ON SCHEMA public TO ""$appUser"";"
  Ensure-OptionalReportingRole $psql $db
}

Assert-DatabaseUtf8 $psql $db $db.databaseName

if (-not $SkipMigrations) {
  $env:PGPASSWORD = $db.appPassword
  try {
    Apply-Migrations $psql $databaseUrl (Join-Path $releaseDir "migrations")
    Apply-SeedFiles $psql $databaseUrl (Join-Path $releaseDir "seeds")
    Set-DatabaseEnvironmentMode $psql $databaseUrl ([bool]$server.strictProduction)
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

$env:PGPASSWORD = $db.appPassword
try {
  Ensure-BootstrapAdmin $psql $databaseUrl
  Write-Host "Bootstrap admin ready: Chris G / Access PIN 1234"
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

$envPath = Join-Path $serverDir ".env"
Write-ServerEnv $envPath $config $databaseUrl $clientDist

if (-not $SkipFirewall) {
  Ensure-RiversideFirewallRule $server.firewallRuleName $serverPort
}

$serverExe = Join-Path $serverDir "riverside-server.exe"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute $serverExe -WorkingDirectory $serverDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $taskName
  $localUrl = "http://127.0.0.1:$serverPort"
  Wait-RiversideApiReady $localUrl $serverPort
  Write-Host "Riverside OS server API responded at $localUrl"
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
