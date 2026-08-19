[CmdletBinding()]
param(
  [string]$ConfigPath = "",
  [switch]$SkipDatabaseCreate,
  [switch]$SkipMigrations,
  [switch]$SkipFirewall,
  [switch]$SkipRosieSetup,
  [switch]$PreserveExistingRosie,
  [switch]$NoStart,
  [switch]$SkipPostgresInstall
)

$ErrorActionPreference = "Stop"
$script:lastNativeCommandOutput = ""

if ($SkipRosieSetup -and $PreserveExistingRosie) {
  throw "-SkipRosieSetup and -PreserveExistingRosie cannot be used together."
}

# Enable TLS 1.2 and TLS 1.3 for secure downloads (safely fallback if TLS 1.3 enum is missing)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 12288
} catch {}

$ScriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ScriptRoot)) {
  $ScriptRoot = if ($MyInvocation -and $MyInvocation.MyCommand -and $MyInvocation.MyCommand.Path) {
    Split-Path -Parent $MyInvocation.MyCommand.Path
  } else {
    "."
  }
}

$packageManifestPath = Join-Path $ScriptRoot "deployment-package.manifest.json"
$packageManifest = $null
if (Test-Path $packageManifestPath) {
  $packageVerifier = Join-Path $ScriptRoot "verify-deployment-package.ps1"
  if (-not (Test-Path $packageVerifier)) {
    throw "Packaged install is missing verify-deployment-package.ps1."
  }
  & $packageVerifier -PackageRoot $ScriptRoot
  try {
    $packageManifest = Get-Content $packageManifestPath -Raw | ConvertFrom-Json
  } catch {
    throw "deployment-package.manifest.json is invalid: $($_.Exception.Message)"
  }
}

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = $null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })
  if (-not $isAdmin) {
    throw "Run this installer from an elevated PowerShell window."
  }
}

function Set-SafeProperty($Object, $Name, $Value) {
  if ($null -eq $Object) { return }
  if ($Object.PSObject.Properties[$Name]) {
    $Object.$Name = $Value
  } else {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
  }
}

function Get-ManifestComponentFingerprint($Manifest, [string]$ComponentName) {
  if (-not $Manifest -or -not $Manifest.components) { return "" }
  $component = $Manifest.components.PSObject.Properties[$ComponentName]
  if (-not $component -or -not $component.Value) { return "" }
  return "$($component.Value.fingerprint)".Trim().ToLowerInvariant()
}

function Test-DeploymentComponentChanged($CurrentManifest, $InstalledManifest, [string]$ComponentName) {
  $currentFingerprint = Get-ManifestComponentFingerprint $CurrentManifest $ComponentName
  $installedFingerprint = Get-ManifestComponentFingerprint $InstalledManifest $ComponentName
  if ([string]::IsNullOrWhiteSpace($currentFingerprint) -or
      [string]::IsNullOrWhiteSpace($installedFingerprint)) {
    return $true
  }
  return $currentFingerprint -ne $installedFingerprint
}

function Test-DeploymentHttpReady([string]$Url) {
  if ([string]::IsNullOrWhiteSpace($Url)) { return $false }
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300
  } catch {
    return $false
  }
}

$deploymentStatusPath = "C:\ProgramData\RiversideOS\deployment.status"
$deploymentLogPath = "C:\ProgramData\RiversideOS\deployment-manager.log"

function Write-DeploymentStatus([string]$Status, [string]$Message = "") {
  try {
    $statusDir = Split-Path $deploymentStatusPath -Parent
    if (-not (Test-Path $statusDir)) {
      New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
    }
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $statusJson = @{
      status = $Status
      timestamp = $timestamp
      message = $Message
    } | ConvertTo-Json
    Set-Content -Path $deploymentStatusPath -Value $statusJson -Encoding UTF8
  } catch {
    Write-Warning "Could not write deployment status '$Status': $($_.Exception.Message)"
  }
}

function Get-DeploymentStatus {
  if (Test-Path $deploymentStatusPath) {
    try {
      $content = Get-Content $deploymentStatusPath -Raw | ConvertFrom-Json
      return $content
    } catch {
      return $null
    }
  }
  return $null
}

function Write-DeploymentLog([string]$Message) {
  $logDir = Split-Path $deploymentLogPath -Parent
  if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  }
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $logEntry = "[$timestamp] $Message"
  Add-Content -Path $deploymentLogPath -Value $logEntry -Encoding UTF8
}

function Find-PsqlPath {
  $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $found = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($found) { return $found.FullName }
  return $null
}

function Install-PostgreSqlWithWinget([string]$AdminPassword) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw ("PostgreSQL is not installed and Windows Package Manager (winget) was not found. " +
      "Install PostgreSQL 16 manually from https://www.postgresql.org/download/windows/ " +
      "then rerun install-server.ps1.")
  }

  if ([string]::IsNullOrWhiteSpace($AdminPassword)) {
    # Generate a temporary password so the unattended installer doesn't fail
    $chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    $rng = New-Object System.Random
    $AdminPassword = -join (1..24 | ForEach-Object { $chars[$rng.Next(0, $chars.Length)] })
  }

  Write-Host "PostgreSQL 16 not found. Installing via winget (this may take several minutes)..." -ForegroundColor Yellow
  $override = "--mode unattended --unattendedmodeui minimal --superpassword `"$AdminPassword`" --serverport 5432"
  $output = & $winget.Source install -e --id PostgreSQL.PostgreSQL.16 --silent `
    --accept-package-agreements --accept-source-agreements --override $override 2>&1
  foreach ($line in $output) {
    if ($null -ne $line) { Write-Host $line }
  }
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL 16 winget install failed with exit code $LASTEXITCODE."
  }

  # Refresh PATH so psql.exe is found in this session
  $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + `
              [System.Environment]::GetEnvironmentVariable("PATH", "User")

  Write-Host "Waiting for PostgreSQL to become available after install..."
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    if (Find-PsqlPath) {
      Write-Host "PostgreSQL installed successfully." -ForegroundColor Green
      return $AdminPassword
    }
  }
  throw "PostgreSQL install finished, but psql.exe was not found. Restart Windows, then rerun install-server.ps1."
}

function Resolve-PsqlPath($dbConfig) {
  if ($dbConfig.psqlPath -and (Test-Path $dbConfig.psqlPath)) {
    return $dbConfig.psqlPath
  }
  $found = Find-PsqlPath
  if ($found) { return $found }
  throw "psql.exe was not found. Install PostgreSQL first, or set server.database.psqlPath in the config."
}

function New-PreMigrationBackup([string]$PsqlPath, $DbConfig, [string]$BackupDir) {
  $pgDump = Join-Path (Split-Path $PsqlPath -Parent) "pg_dump.exe"
  if (-not (Test-Path $pgDump)) {
    throw "pg_dump.exe was not found beside psql.exe; refusing to migrate without a verified backup."
  }
  $pgRestore = Join-Path (Split-Path $PsqlPath -Parent) "pg_restore.exe"
  if (-not (Test-Path $pgRestore)) {
    throw "pg_restore.exe was not found beside psql.exe; refusing to migrate without archive verification."
  }

  $backupUser = "$($DbConfig.adminUser)".Trim()
  if ([string]::IsNullOrWhiteSpace($backupUser)) {
    throw "PostgreSQL admin user is required for the verified pre-migration backup."
  }

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = Join-Path $BackupDir "pre-install-migration-$stamp.dump"
  $env:PGPASSWORD = $DbConfig.adminPassword
  try {
    & $pgDump -h $DbConfig.host -p $DbConfig.port -U $backupUser -d $DbConfig.databaseName -w -Fc -f $backupPath
    if ($LASTEXITCODE -ne 0) {
      throw "pg_dump failed with exit code $LASTEXITCODE."
    }

    $backupFile = Get-Item $backupPath -ErrorAction Stop
    if ($backupFile.Length -lt 1024) {
      throw "Pre-migration backup was unexpectedly small: $backupPath"
    }

    $archiveListing = @(& $pgRestore --list $backupPath)
    if ($LASTEXITCODE -ne 0 -or $archiveListing.Count -eq 0) {
      throw "Pre-migration backup archive verification failed: $backupPath"
    }
  } catch {
    Remove-Item $backupPath -Force -ErrorAction SilentlyContinue
    throw
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
  Write-Host "Pre-migration database backup created: $backupPath" -ForegroundColor Green
}

function Get-PgDataDir([string]$ServiceName) {
  try {
    $wmi = Get-WmiObject win32_service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
    if ($wmi -and $wmi.PathName -match '-D\s+"([^"]+)"') { return $Matches[1] }
    if ($wmi -and $wmi.PathName -match "-D\s+([^ ]+)")   { return $Matches[1] }
  } catch {}
  return $null
}

function Get-PgCtlPath([string]$ServiceName) {
  try {
    $wmi = Get-WmiObject win32_service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
    if ($wmi -and $wmi.PathName -match '"([^"]+pg_ctl\.exe)"') { return $Matches[1] }
    if ($wmi -and $wmi.PathName -match '([^\s]+pg_ctl\.exe)')  { return $Matches[1] }
  } catch {}
  # Fall back: look for pg_ctl next to psql
  $psqlCmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($psqlCmd) {
    $pgCtl = Join-Path (Split-Path $psqlCmd.Source) "pg_ctl.exe"
    if (Test-Path $pgCtl) { return $pgCtl }
  }
  $pgCtlFound = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter pg_ctl.exe -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($pgCtlFound) { return $pgCtlFound.FullName }
  return $null
}

function Show-PostgresLogs([string]$DataDir) {
  if ([string]::IsNullOrWhiteSpace($DataDir) -or -not (Test-Path $DataDir)) { return }
  $logDir = Join-Path $DataDir "log"
  if (-not (Test-Path $logDir)) { $logDir = $DataDir }
  $latest = Get-ChildItem $logDir -Filter "*.log" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latest) {
    Write-Warning "--- Last 20 lines of PostgreSQL log: $($latest.FullName) ---"
    Get-Content $latest.FullName -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Warning $_ }
    Write-Warning "--- End of PostgreSQL log ---"
  }
}

function Show-ServiceEventLog([string]$ServiceName) {
  try {
    $events = Get-WinEvent -FilterHashtable @{ LogName='System'; Id=@(7000,7009,7023,7034,7038); StartTime=(Get-Date).AddMinutes(-10) } -ErrorAction SilentlyContinue |
      Where-Object { $_.Message -like "*$ServiceName*" } |
      Select-Object -Last 5
    if ($events) {
      Write-Warning "--- Windows Service Event Log entries for '$ServiceName' ---"
      $events | ForEach-Object { Write-Warning "$($_.TimeCreated): $($_.Message)" }
      Write-Warning "--- End of event log entries ---"
    }
  } catch {}
}

function Test-PostgresReachable([string]$DbHost, [int]$DbPort) {
  $tcpClient = New-Object System.Net.Sockets.TcpClient
  try {
    $connect = $tcpClient.BeginConnect($DbHost, $DbPort, $null, $null)
    $ok = $connect.AsyncWaitHandle.WaitOne(2000, $false)
    if ($ok) { $tcpClient.EndConnect($connect) }
    return $ok
  } catch {
    return $false
  } finally {
    $tcpClient.Close()
  }
}

function Resolve-MainHubDatabaseHost([string]$DbHost) {
  $value = "$DbHost".Trim()
  if ([string]::IsNullOrWhiteSpace($value)) {
    return "127.0.0.1"
  }
  if ($value -ne "127.0.0.1" -and $value -ne "localhost" -and $value -ne "::1") {
    Write-Warning "Database host was '$value'. Main Hub PostgreSQL uses local host 127.0.0.1."
    return "127.0.0.1"
  }
  return "127.0.0.1"
}

function Ensure-PostgresServiceRunning {
  $dbHost = "127.0.0.1"
  $dbPort = 5432
  if ($db) {
    if (-not [string]::IsNullOrWhiteSpace($db.host)) { $dbHost = $db.host }
    if ($db.port) { $dbPort = [int]$db.port }
  }

  Write-Host "Checking if PostgreSQL is already reachable on $dbHost`:$dbPort..."
  if (Test-PostgresReachable $dbHost $dbPort) {
    Write-Host "PostgreSQL is already reachable on $dbHost`:$dbPort. Skipping service start."
    return
  }

  $services = Get-Service -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "postgresql*" -or $_.DisplayName -like "PostgreSQL*" } |
    Sort-Object Name -Descending

  if (-not $services) {
    Write-Warning "No PostgreSQL Windows service was found on this machine."

    if ($SkipPostgresInstall) {
      throw ("PostgreSQL is not reachable at $dbHost`:$dbPort and no PostgreSQL Windows service was found. " +
        "Install PostgreSQL 16 first, then rerun install-server.ps1.")
    }

    if (-not (Find-PsqlPath)) {
      # PostgreSQL is not installed at all — offer silent install via winget
      Write-Host "PostgreSQL does not appear to be installed. Attempting automatic install via winget..." -ForegroundColor Yellow
      $adminPwd = if ($db -and -not [string]::IsNullOrWhiteSpace($db.adminPassword)) { $db.adminPassword } else { $null }
      $installedPwd = Install-PostgreSqlWithWinget $adminPwd

      # Persist the generated password back to config so subsequent psql calls succeed
      if ($installedPwd -and $db -and [string]::IsNullOrWhiteSpace($db.adminPassword)) {
        Set-SafeProperty $db "adminPassword" $installedPwd
        $script:configModifiedAfterPostgresInstall = $true
      }

      # Re-enumerate services now that PostgreSQL is installed
      Start-Sleep -Seconds 3
      $services = Get-Service -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "postgresql*" -or $_.DisplayName -like "PostgreSQL*" } |
        Sort-Object Name -Descending
    }

    if (-not $services) {
      throw ("PostgreSQL is not reachable at $dbHost`:$dbPort and no PostgreSQL Windows service was found " +
        "even after install. Restart Windows and rerun install-server.ps1.")
    }
  }

  $started = $false

  foreach ($service in $services) {
    if ($service.Status -eq "Running") {
      Write-Host "PostgreSQL service '$($service.Name)' is already running."
      $started = $true

      # Still not reachable even though service says Running - wait a moment and recheck
      if (-not (Test-PostgresReachable $dbHost $dbPort)) {
        Write-Warning "Service '$($service.Name)' is Running but port $dbPort is not yet open. Waiting up to 15s..."
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $deadline) {
          Start-Sleep -Milliseconds 500
          if (Test-PostgresReachable $dbHost $dbPort) { break }
        }
      }
      break
    }

    Write-Host "Attempting to start PostgreSQL service '$($service.Name)'..."
    try {
      Start-Service -Name $service.Name -ErrorAction Stop
      $service.WaitForStatus("Running", (New-TimeSpan -Seconds 30))
      Write-Host "Successfully started PostgreSQL service '$($service.Name)'."
      $started = $true
      break
    } catch {
      Write-Warning "Could not start PostgreSQL service '$($service.Name)' via Service Control Manager: $($_.Exception.Message)"

      # Show Windows Event Log and PostgreSQL log for diagnostics
      Show-ServiceEventLog $service.Name
      $dataDir = Get-PgDataDir $service.Name
      Show-PostgresLogs $dataDir

      # Fallback: try pg_ctl start directly
      $pgCtl = Get-PgCtlPath $service.Name
      if ($pgCtl -and $dataDir) {
        Write-Host "Attempting fallback: pg_ctl start -D `"$dataDir`"..."
        try {
          $pgCtlOut = & $pgCtl start -D $dataDir -w -t 30 2>&1
          Write-Host $pgCtlOut
          if ($LASTEXITCODE -eq 0) {
            Write-Host "pg_ctl start succeeded for '$($service.Name)'."
            $started = $true
            break
          } else {
            Write-Warning "pg_ctl start exited with code $LASTEXITCODE."
          }
        } catch {
          Write-Warning "pg_ctl fallback failed: $($_.Exception.Message)"
        }
      } else {
        if (-not $pgCtl)  { Write-Warning "pg_ctl.exe could not be located for fallback startup." }
        if (-not $dataDir){ Write-Warning "PostgreSQL data directory could not be determined for fallback startup." }
      }
    }
  }

  if (-not $started) {
    # Final TCP check — maybe one of the above attempts worked despite error codes
    if (Test-PostgresReachable $dbHost $dbPort) {
      Write-Host "PostgreSQL is now reachable on $dbHost`:$dbPort."
      $started = $true
    }
  }

  # If service exists but won't start, try initdb if the data directory is missing
  if (-not $started -and $services) {
    foreach ($service in $services) {
      $dataDir = Get-PgDataDir $service.Name
      if ($dataDir -and -not (Test-Path $dataDir)) {
        $pgCtl = Get-PgCtlPath $service.Name
        if ($pgCtl) {
          $binDir = Split-Path $pgCtl -Parent
          $initDb = Join-Path $binDir "initdb.exe"
          if (Test-Path $initDb) {
            Write-Warning "PostgreSQL data directory missing at $dataDir. Running initdb..."
            New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
            $env:PGUSER = "postgres"
            try {
              & $initDb -D "$dataDir" -E UTF8 --no-locale --auth=trust 2>&1 | ForEach-Object { Write-Host $_ }
              if ($LASTEXITCODE -eq 0) {
                # Ensure the service account can access the data directory
                try {
                  $wmiSvc = Get-WmiObject win32_service -Filter "Name='$($service.Name)'" -ErrorAction SilentlyContinue
                  if ($wmiSvc -and $wmiSvc.StartName) {
                    $svcAccount = $wmiSvc.StartName
                    Write-Host "Granting service account '$svcAccount' access to data directory..."
                    & icacls "$dataDir" /grant "$svcAccount`:(OI)(CI)F" /T 2>&1 | ForEach-Object { Write-Host $_ }
                  }
                } catch {
                  Write-Warning "Could not set data directory permissions: $($_.Exception.Message)"
                }
                Write-Host "initdb succeeded. Retrying service start..."
                try {
                  Start-Service -Name $service.Name -ErrorAction Stop
                  $service.WaitForStatus("Running", (New-TimeSpan -Seconds 30))
                  if (Test-PostgresReachable $dbHost $dbPort) {
                    Write-Host "PostgreSQL is now reachable after initdb."
                    $started = $true
                    break
                  }
                } catch {
                  Write-Warning "Service start after initdb failed: $($_.Exception.Message)"
                }
              } else {
                Write-Warning "initdb exited with code $LASTEXITCODE."
              }
            } catch {
              Write-Warning "initdb failed: $($_.Exception.Message)"
            } finally {
              Remove-Item Env:\PGUSER -ErrorAction SilentlyContinue
            }
          }
        }
      }
    }
  }

  if (-not $started) {
    $names = ($services | ForEach-Object { $_.Name }) -join ", "
    Write-Warning ("PostgreSQL is not reachable at $dbHost`:$dbPort after attempting to start: $names. " +
      "Database setup will be skipped. To fix: check the PostgreSQL log in its data/log directory and the Windows Application Event Log, " +
      "then rerun install-server.ps1. Common causes: missing data directory (run initdb), " +
      "corrupted data files, or another process already using port $dbPort.")
  }

  # Set chosen (first running) service to auto-start
  $running = Get-Service -ErrorAction SilentlyContinue |
    Where-Object { ($_.Name -like "postgresql*" -or $_.DisplayName -like "PostgreSQL*") -and $_.Status -eq "Running" } |
    Select-Object -First 1
  if ($running) {
    try { Set-Service -Name $running.Name -StartupType Automatic } catch {
      Write-Warning "Could not set service '$($running.Name)' startup type to Automatic: $($_.Exception.Message)"
    }
  }
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
  # Redirect stdin so psql (and other tools) can NEVER open an interactive
  # password prompt in the console window. If PGPASSWORD is wrong the tool
  # will exit non-zero immediately instead of blocking.
  $psi.RedirectStandardInput = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  [void]$process.Start()
  # Close stdin immediately so the child never blocks waiting for input.
  $process.StandardInput.Close()
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
    $exitCode = Invoke-NativeCommand $PsqlPath @($DatabaseUrl, "-v", "ON_ERROR_STOP=1", "-w", "-f", $temp.FullName)
    if ($exitCode -ne 0) {
      throw "psql failed with exit code $exitCode. $script:lastNativeCommandOutput"
    }
  } finally {
    Remove-Item $temp -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-PsqlFile($PsqlPath, $DatabaseUrl, $FilePath) {
  $exitCode = Invoke-NativeCommand $PsqlPath @($DatabaseUrl, "-v", "ON_ERROR_STOP=1", "-1", "-w", "-f", $FilePath)
  if ($exitCode -ne 0) {
    throw "psql failed with exit code $exitCode. $script:lastNativeCommandOutput"
  }
}

function Invoke-PsqlScalar($PsqlPath, $DatabaseUrl, [string]$Sql) {
  $result = & $PsqlPath $DatabaseUrl -w -tAc $Sql
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

function Invoke-PsqlAdminScalar($PsqlPath, $Db, $DatabaseName, $Sql) {
  $env:PGPASSWORD = $Db.adminPassword
  try {
    $adminUrl = "postgresql://$($Db.adminUser)@$($Db.host):$($Db.port)/$DatabaseName"
    return Invoke-PsqlScalar $PsqlPath $adminUrl $Sql
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

function Repair-AverageCostAuditTableOwnership($PsqlPath, $Db) {
  $appUser = "$($Db.appUser)".Trim()
  if ([string]::IsNullOrWhiteSpace($appUser)) {
    throw "PostgreSQL app role is required for average-cost audit ownership repair."
  }

  $appUserIdentifier = Quote-SqlIdentifier $appUser
  $tableName = "public.inventory_average_cost_line_repair_audit"
  $owner = Invoke-PsqlAdminScalar $PsqlPath $Db $Db.databaseName @"
SELECT pg_get_userbyid(c.relowner)
FROM pg_class c
WHERE c.oid = to_regclass('$tableName');
"@

  if ([string]::IsNullOrWhiteSpace($owner) -or $owner -eq $appUser) {
    return
  }

  Invoke-PsqlAdminDatabase $PsqlPath $Db $Db.databaseName "ALTER TABLE $tableName OWNER TO $appUserIdentifier;"
  $repairedOwner = Invoke-PsqlAdminScalar $PsqlPath $Db $Db.databaseName @"
SELECT pg_get_userbyid(c.relowner)
FROM pg_class c
WHERE c.oid = to_regclass('$tableName');
"@
  if ($repairedOwner -ne $appUser) {
    throw "Could not transfer $tableName ownership from '$owner' to the PostgreSQL app role."
  }

  Write-Host "Transferred $tableName ownership from '$owner' to the PostgreSQL app role."
}

function Ensure-OptionalReportingRole($PsqlPath, $Db, [switch]$Required) {
  try {
    Invoke-PsqlAdmin $PsqlPath $Db "DO `$`$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cube_ro') THEN CREATE ROLE cube_ro LOGIN NOINHERIT; ELSE ALTER ROLE cube_ro LOGIN NOINHERIT; END IF; END `$`$;"
  } catch {
    if ($Required) {
      throw "Could not provision the required Cube reporting role cube_ro: $($_.Exception.Message)"
    }
    Write-Warning "Could not create optional reporting role cube_ro. Reporting grants will be skipped where supported."
  }
}

function Invoke-CubeRoleMigrationFile($PsqlPath, $Db, [string]$FilePath) {
  Ensure-OptionalReportingRole $PsqlPath $Db -Required

  $appUser = "$($Db.appUser)".Trim()
  if ([string]::IsNullOrWhiteSpace($appUser)) {
    throw "PostgreSQL app role is required for Cube reporting migration compatibility."
  }

  $appUserLiteral = Escape-SqlLiteral $appUser
  $appUserIdentifier = Quote-SqlIdentifier $appUser
  $hadCreateRole = Invoke-PsqlAdminScalar $PsqlPath $Db $Db.databaseName "SELECT rolcreaterole FROM pg_roles WHERE rolname = '$appUserLiteral';"
  if ($hadCreateRole -notin @("t", "f")) {
    throw "Could not determine PostgreSQL role-management state for the app role."
  }

  $membershipState = Invoke-PsqlAdminScalar $PsqlPath $Db $Db.databaseName @"
SELECT COALESCE(
  (
    SELECT CASE WHEN membership.admin_option THEN 'admin' ELSE 'member' END
    FROM pg_auth_members membership
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE granted_role.rolname = 'cube_ro'
      AND member_role.rolname = '$appUserLiteral'
    LIMIT 1
  ),
  'none'
);
"@
  if ($membershipState -notin @("none", "member", "admin")) {
    throw "Could not determine Cube reporting-role membership for the app role."
  }

  $enableSql = @()
  $restoreSql = @()
  if ($hadCreateRole -eq "f") {
    $enableSql += "ALTER ROLE $appUserIdentifier CREATEROLE;"
    $restoreSql += "ALTER ROLE $appUserIdentifier NOCREATEROLE;"
  }
  if ($membershipState -ne "admin") {
    $enableSql += "GRANT cube_ro TO $appUserIdentifier WITH ADMIN OPTION;"
    if ($membershipState -eq "none") {
      $restoreSql = @("REVOKE cube_ro FROM $appUserIdentifier;") + $restoreSql
    } else {
      $restoreSql = @("REVOKE ADMIN OPTION FOR cube_ro FROM $appUserIdentifier;") + $restoreSql
    }
  }

  $env:PGPASSWORD = $Db.adminPassword
  try {
    $adminUrl = "postgresql://$($Db.adminUser)@$($Db.host):$($Db.port)/$($Db.databaseName)"
    $arguments = @($adminUrl, "-v", "ON_ERROR_STOP=1", "-1", "-w")
    if ($enableSql.Count -gt 0) {
      $arguments += @("-c", ($enableSql -join " "))
    }
    $arguments += @(
      "-c", "SET ROLE $appUserIdentifier;",
      "-f", $FilePath,
      "-c", "RESET ROLE;"
    )
    if ($restoreSql.Count -gt 0) {
      $arguments += @("-c", ($restoreSql -join " "))
    }

    $exitCode = Invoke-NativeCommand $PsqlPath $arguments
    if ($exitCode -ne 0) {
      throw "psql failed with exit code $exitCode. $script:lastNativeCommandOutput"
    }
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }

  Write-Host "Applied Cube reporting migration with transaction-scoped role administration; app role privileges restored."
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
    $encoding = & $PsqlPath $adminUrl -w -tAc "SHOW server_encoding;"
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
    throw "Database '$DatabaseName' is encoded as '$encoding'. Riverside OS requires UTF8. During a fresh failed install, run Reset-RiversideDatabase.cmd, then rerun Main Hub Install."
  }
}

function Ensure-BootstrapAdmin($PsqlPath, $DatabaseUrl) {
  $bootstrapPinHash = '$argon2id$v=19$m=19456,t=2,p=1$KWJoKjtQYNuPjRIyKL2M9g$FBpoET53ejevTU5LrsLTzQMrgXpV5NavqruJmerdPsc'
  $sql = "INSERT INTO staff (full_name, cashier_code, pin_hash, role, is_active, avatar_key) " +
    "SELECT 'Chris G', '1234', '$bootstrapPinHash', 'admin'::staff_role, TRUE, 'ros_default' " +
    "WHERE NOT EXISTS (SELECT 1 FROM staff WHERE cashier_code = '1234'); " +
    "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM staff WHERE cashier_code = '1234') THEN " +
    "RAISE EXCEPTION 'Bootstrap staff account was not created.'; END IF; END `$`$;"
  Invoke-Psql $PsqlPath $DatabaseUrl $sql
}

function Test-FileReadyForReplacement([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path $Path)) {
    return $true
  }

  $stream = $null
  try {
    $stream = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
    return $true
  } catch {
    return $false
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}

function Stop-RiversideServer([string]$ExecutablePath, [int]$TimeoutSeconds = 30) {
  Stop-ScheduledTask -TaskName "Riverside OS Server" -ErrorAction SilentlyContinue

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    foreach ($process in Get-Process -Name "riverside-server" -ErrorAction SilentlyContinue) {
      try {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
      } catch {
        Write-Warning "Could not stop Riverside server process $($process.Id): $($_.Exception.Message)"
      }
    }

    $remainingProcesses = @(Get-Process -Name "riverside-server" -ErrorAction SilentlyContinue)
    if ($remainingProcesses.Count -eq 0 -and (Test-FileReadyForReplacement $ExecutablePath)) {
      Write-Host "Riverside server stopped and executable handle released."
      return
    }

    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  $remainingProcessIds = @(
    Get-Process -Name "riverside-server" -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty Id
  )
  $processDetail = if ($remainingProcessIds.Count -gt 0) {
    " Remaining process IDs: $($remainingProcessIds -join ',')."
  } else {
    ""
  }
  throw "Riverside server did not release '$ExecutablePath' within $TimeoutSeconds seconds.$processDetail The installed files were not replaced."
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

function Test-RiversideServerProcess([int]$Port) {
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

  return $true
}

function Test-RiversideApiEndpoint([string]$Url, [string]$ExpectedPrefixPattern) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
    $content = "$($response.Content)".TrimStart()
    $matched = $response.StatusCode -eq 200 -and ($content -match $ExpectedPrefixPattern)
    if ($matched) {
      $script:lastRiversideApiReadyError = $null
    }
    return $matched
  } catch {
    $script:lastRiversideApiReadyError = $_.Exception.Message
    return $false
  }
}

function Get-RiversideServerStartupStatus {
  $taskSummary = "task unavailable"
  try {
    $task = Get-ScheduledTask -TaskName "Riverside OS Server" -ErrorAction SilentlyContinue
    if ($task) {
      $info = Get-ScheduledTaskInfo -TaskName "Riverside OS Server" -ErrorAction SilentlyContinue
      $lastResult = if (-not $info) {
        "unknown"
      } elseif ($info.LastTaskResult -eq 267009) {
        "running (0x41301)"
      } else {
        $info.LastTaskResult
      }
      $taskSummary = "task state: $($task.State), last result: $lastResult"
    }
  } catch {
    $taskSummary = "task diagnostic failed: $($_.Exception.Message)"
  }

  $processCount = @(Get-Process -Name "riverside-server" -ErrorAction SilentlyContinue).Count
  return "$taskSummary; riverside-server process count: $processCount"
}

function Wait-RiversideApiReady([string]$BaseUrl, [int]$Port) {
  $script:lastRiversideApiReadyError = $null
  $healthUrl = "$BaseUrl/api/health"
  $readyUrl = "$BaseUrl/api/ready"
  $staffUrl = "$BaseUrl/api/staff/list-for-pos"

  Write-Host "Waiting for Riverside OS Server process on port $Port..."
  $deadline = (Get-Date).AddSeconds(180)
  $healthPassed = $false
  $lastStartupStatusAt = (Get-Date).AddSeconds(-30)
  do {
    if ((Test-RiversideServerProcess $Port) -and (Test-RiversideApiEndpoint $healthUrl '^\{')) {
      Write-Host "Riverside OS Server health check passed at $healthUrl"
      $healthPassed = $true
      break
    }
    if ((Get-Date) -ge $lastStartupStatusAt.AddSeconds(10)) {
      $startupStatus = Get-RiversideServerStartupStatus
      Write-Host "Riverside OS Server not listening yet ($startupStatus)."
      $lastStartupStatusAt = Get-Date
    }
    if ($script:lastRiversideApiReadyError) {
      Write-Host "API health check is not ready yet: $script:lastRiversideApiReadyError"
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)

  if (-not $healthPassed) {
    throw "Riverside OS Server did not pass the health check at $healthUrl. $(Get-RiversideServerStartupStatus). Check the Riverside OS Server scheduled task and C:\RiversideOS\server\.env."
  }

  Write-Host "Waiting for Riverside OS database readiness at $readyUrl..."
  $script:lastRiversideApiReadyError = $null
  $deadline = (Get-Date).AddSeconds(180)
  $readyPassed = $false
  $lastReadyStatusAt = (Get-Date).AddSeconds(-10)
  do {
    if (Test-RiversideApiEndpoint $readyUrl '^\{') {
      Write-Host "Riverside OS readiness check passed at $readyUrl"
      $readyPassed = $true
      break
    }
    if ($script:lastRiversideApiReadyError -and (Get-Date) -ge $lastReadyStatusAt.AddSeconds(10)) {
      if ($script:lastRiversideApiReadyError -match '\(503\)') {
        Write-Host "Riverside OS database readiness is warming up; retrying."
      } else {
        Write-Host "API readiness check is not ready yet: $script:lastRiversideApiReadyError"
      }
      $lastReadyStatusAt = Get-Date
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)

  if ($readyPassed) {
    return
  }

  Write-Host "Checking POS staff list once for a more specific diagnostic..."
  if (Test-RiversideApiEndpoint $staffUrl '^(\[|\{)') {
    Write-Host "Riverside OS POS staff check passed at $staffUrl"
    return
  }
  throw "Riverside OS Server did not become database-ready at $readyUrl. Last error: $script:lastRiversideApiReadyError. POS staff check also failed at $staffUrl."
}

function Resolve-LlamaPerfProfile([string]$Requested) {
  $profile = "$Requested".Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($profile) -or $profile -eq "auto") {
    $cpuName = ""
    try {
      $cpuName = "$((Get-CimInstance Win32_Processor | Select-Object -First 1).Name)"
    } catch {
      $cpuName = ""
    }
    if ($cpuName -match "8840U") { return "minisforum-v3" }
    if ($cpuName -match "12900") { return "intel-i9-12900" }
    return "portable-cpu"
  }
  if ($profile -in @("intel-i9-12900", "i9-12900", "12900")) { return "intel-i9-12900" }
  if ($profile -in @("minisforum-v3", "amd-8840u", "ryzen-8840u")) { return "minisforum-v3" }
  if ($profile -in @("apple-m3-pro", "m3-pro")) { return "apple-m3-pro" }
  if ($profile -in @("apple-m3-pro-cpu", "m3-pro-cpu")) { return "apple-m3-pro-cpu" }
  if ($profile -in @("portable-cpu", "cpu-portable")) { return "portable-cpu" }
  return "portable-cpu"
}

function Resolve-LlamaPerfArgs([string]$Requested) {
  $profile = Resolve-LlamaPerfProfile $Requested
  switch ($profile) {
    "intel-i9-12900" { return "--threads 8 --threads-batch 8 --cpu-mask 0xFFFF --cpu-mask-batch 0xFFFF --cpu-strict 1 --cpu-strict-batch 1 --gpu-layers 0 --device none --flash-attn on --mmap --mlock" }
    "minisforum-v3" { return "--threads 8 --threads-batch 8 --cpu-mask 0xFFFF --cpu-mask-batch 0xFFFF --cpu-strict 1 --cpu-strict-batch 1 --gpu-layers 0 --device none --flash-attn on --mmap --mlock" }
    "apple-m3-pro" { return "--threads 6 --threads-batch 6 --gpu-layers 99 --flash-attn on --mmap" }
    "apple-m3-pro-cpu" { return "--threads 6 --threads-batch 6 --gpu-layers 0 --device none --flash-attn on --mmap" }
    default { return "--threads 6 --threads-batch 6 --gpu-layers 0 --device none --flash-attn on --mmap" }
  }
}

function Ensure-RiversideLlamaHost(
  [string]$PackageRoot,
  [string]$InstallRoot,
  [string]$ModelPath,
  [string]$LlamaHost,
  [int]$LlamaPort,
  [string]$LlamaPerfProfile = "auto",
  [int]$ContextSize = 16384,
  [int]$Parallel = 2,
  [int]$BatchSize = 512,
  [int]$UbatchSize = 512
) {
  $llamaSrc = Join-Path $PackageRoot "rosie\bin\llama-server.exe"
  $llamaDir = Join-Path $InstallRoot "rosie\bin"
  $llamaExe = Join-Path $llamaDir "llama-server.exe"

  if ([string]::IsNullOrWhiteSpace($ModelPath) -or -not (Test-Path $ModelPath)) {
    Write-Warning "ROSIE: LLM model is missing at '$ModelPath'. Skipping Riverside OS LLM Host scheduled task."
    return
  }

  if ((-not (Test-Path $llamaSrc)) -and (-not (Test-Path $llamaExe))) {
    Write-Warning ("ROSIE: llama-server.exe was not found in the deployment package or installed ROSIE bin directory. " +
      "ROSIE chat will stay unavailable until llama-server is running on http://${LlamaHost}:${LlamaPort}/. " +
      "Run Install-RosieAiStack.ps1 again after network connectivity is restored.")
    return
  }

  $taskName = "Riverside OS LLM Host"
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2

  New-Item -ItemType Directory -Force -Path $llamaDir | Out-Null
  if (Test-Path $llamaSrc) {
    Copy-Item "$PackageRoot\rosie\bin\*" $llamaDir -Force
  }
  $llamaPerfArgs = Resolve-LlamaPerfArgs $LlamaPerfProfile
  $resolvedLlamaPerfProfile = Resolve-LlamaPerfProfile $LlamaPerfProfile
  Write-Host "ROSIE: Applying llama.cpp performance profile '$resolvedLlamaPerfProfile'."
  $argument = "-m `"$ModelPath`" --host $LlamaHost --port $LlamaPort --ctx-size $ContextSize --parallel $Parallel --batch-size $BatchSize --ubatch-size $UbatchSize --cont-batching $llamaPerfArgs"
  $mmprojPath = Join-Path (Split-Path -Parent $ModelPath) "gemma-4-E4B-it-mmproj.gguf"
  if (Test-Path $mmprojPath) {
    $argument = "$argument --mmproj `"$mmprojPath`""
  }

  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  $action = New-ScheduledTaskAction -Execute $llamaExe -Argument $argument -WorkingDirectory $llamaDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

  Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName $taskName
  Write-Host "ROSIE: Registered and started scheduled task '$taskName' at http://${LlamaHost}:${LlamaPort}/"
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

function Ensure-ServerEnvironmentObject($Config) {
  if (-not $Config.server.environment) {
    $Config.server | Add-Member -NotePropertyName "environment" -NotePropertyValue ([pscustomobject]@{}) -Force
    $script:meilisearchConfigModified = $true
  }
  return $Config.server.environment
}

function Get-ServerEnvironmentValue($Config, [string[]]$Names) {
  $envObj = Ensure-ServerEnvironmentObject $Config
  foreach ($name in $Names) {
    $prop = $envObj.PSObject.Properties[$name]
    if ($prop -and $null -ne $prop.Value -and -not [string]::IsNullOrWhiteSpace("$($prop.Value)")) {
      return "$($prop.Value)".Trim()
    }
  }
  return ""
}

function Get-CloudflaredConfigPath {
  $candidates = @()
  try {
    $service = Get-CimInstance Win32_Service -Filter "Name='cloudflared'" -ErrorAction SilentlyContinue
    if ($service -and $service.PathName) {
      if ($service.PathName -match '--config\s+"([^"]+)"') {
        $candidates += $Matches[1]
      } elseif ($service.PathName -match '--config\s+([^\s]+)') {
        $candidates += $Matches[1]
      }
    }
  } catch {}

  $candidates += @(
    "C:\ProgramData\cloudflared\config.yml",
    "C:\Windows\System32\config\systemprofile\.cloudflared\config.yml"
  )
  if ($env:USERPROFILE) {
    $candidates += (Join-Path $env:USERPROFILE ".cloudflared\config.yml")
  }

  return $candidates |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    Select-Object -Unique |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
}

function Get-CloudflaredWindowsService {
  try {
    return Get-CimInstance Win32_Service -Filter "Name='cloudflared'" -ErrorAction SilentlyContinue
  } catch {
    return $null
  }
}

function Get-ConfiguredCloudflaredConfigPath($Config) {
  $configPath = Get-ServerEnvironmentValue $Config @("RIVERSIDE_CLOUDFLARE_CONFIG_PATH", "CLOUDFLARED_CONFIG_PATH")
  if (-not [string]::IsNullOrWhiteSpace($configPath) -and (Test-Path $configPath)) {
    return $configPath
  }
  return ""
}

function New-CloudflaredConfigFromServerConfig($Config, [string]$Hostname, [string]$ServiceUrl) {
  $tunnelId = Get-ServerEnvironmentValue $Config @("RIVERSIDE_CLOUDFLARE_TUNNEL_ID", "CLOUDFLARED_TUNNEL_ID")
  $credentialsFile = Get-ServerEnvironmentValue $Config @("RIVERSIDE_CLOUDFLARE_CREDENTIALS_FILE", "CLOUDFLARED_CREDENTIALS_FILE")
  if ([string]::IsNullOrWhiteSpace($tunnelId) -or [string]::IsNullOrWhiteSpace($credentialsFile)) {
    return ""
  }
  if (-not (Test-Path $credentialsFile)) {
    Write-Warning "Cloudflare tunnel credentials were configured, but the credentials file was not found at $credentialsFile. Cannot create cloudflared config.yml."
    return ""
  }

  $configPath = Get-ServerEnvironmentValue $Config @("RIVERSIDE_CLOUDFLARE_CONFIG_PATH", "CLOUDFLARED_CONFIG_PATH")
  if ([string]::IsNullOrWhiteSpace($configPath)) {
    $configPath = "C:\ProgramData\cloudflared\config.yml"
  }
  $configDir = Split-Path $configPath -Parent
  if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
  }

  $lines = @(
    "tunnel: $tunnelId",
    "credentials-file: '$($credentialsFile.Replace("'", "''"))'",
    "ingress:",
    "  - hostname: $Hostname",
    "    service: $ServiceUrl",
    "  - service: http_status:404"
  )
  Set-Content -Path $configPath -Value $lines -Encoding UTF8
  Write-Host "Created cloudflared config for $Hostname -> $ServiceUrl at $configPath" -ForegroundColor Green
  return $configPath
}

function Set-CloudflaredIngressRule([string]$ConfigPath, [string]$Hostname, [string]$ServiceUrl) {
  $lines = @(Get-Content $ConfigPath -ErrorAction Stop)
  $escapedHost = [regex]::Escape($Hostname)
  $updated = $false
  $foundHost = $false
  $inTarget = $false
  $targetServiceSeen = $false
  $insertBeforeIndex = -1
  $serviceIndent = "    "

  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ($line -match "^\s*-\s+hostname:\s*['""]?$escapedHost['""]?\s*$" -or
        $line -match "^\s*hostname:\s*['""]?$escapedHost['""]?\s*$") {
      $foundHost = $true
      $inTarget = $true
      $targetServiceSeen = $false
      if ($line -match "^(\s*)-\s+hostname:") {
        $serviceIndent = "$($Matches[1])  "
      } elseif ($line -match "^(\s*)hostname:") {
        $serviceIndent = $Matches[1]
      }
      continue
    }

    if ($inTarget -and $line -match "^\s*-\s+" -and $line -notmatch "^\s*-\s+service:") {
      if (-not $targetServiceSeen) {
        $insertBeforeIndex = $i
      }
      $inTarget = $false
    }

    if ($inTarget -and $line -match "^(\s*)service:\s*") {
      $targetServiceSeen = $true
      $desired = "$($Matches[1])service: $ServiceUrl"
      if ($line -ne $desired) {
        $lines[$i] = $desired
        $updated = $true
      }
      $inTarget = $false
    }
  }

  $newLines = New-Object System.Collections.Generic.List[string]
  if ($foundHost -and $insertBeforeIndex -ge 0) {
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($i -eq $insertBeforeIndex) {
        $newLines.Add("${serviceIndent}service: $ServiceUrl")
        $updated = $true
      }
      $newLines.Add($lines[$i])
    }
    $lines = @($newLines)
  } elseif ($foundHost -and $inTarget -and -not $targetServiceSeen) {
    $lines += "${serviceIndent}service: $ServiceUrl"
    $updated = $true
  } elseif (-not $foundHost) {
    $inserted = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      $newLines.Add($lines[$i])
      if (-not $inserted -and $lines[$i] -match "^\s*ingress:\s*$") {
        $newLines.Add("  - hostname: $Hostname")
        $newLines.Add("    service: $ServiceUrl")
        $inserted = $true
        $updated = $true
      }
    }
    if (-not $inserted) {
      $newLines.Add("ingress:")
      $newLines.Add("  - hostname: $Hostname")
      $newLines.Add("    service: $ServiceUrl")
      $updated = $true
    }
    $lines = @($newLines)
  }

  if ($updated) {
    Set-Content -Path $ConfigPath -Value $lines -Encoding UTF8
  }
  return $updated
}

function Ensure-CloudflaredRosIngress($Config, [int]$ServerPort) {
  $hostname = Get-ServerEnvironmentValue $Config @("RIVERSIDE_CLOUDFLARE_TUNNEL_HOSTNAME")
  if ([string]::IsNullOrWhiteSpace($hostname)) {
    return
  }
  $serviceUrl = "http://127.0.0.1:$ServerPort"
  $configPath = Get-CloudflaredConfigPath
  if ([string]::IsNullOrWhiteSpace($configPath)) {
    $configPath = Get-ConfiguredCloudflaredConfigPath $Config
  }
  if ([string]::IsNullOrWhiteSpace($configPath)) {
    $cloudflaredService = Get-CloudflaredWindowsService
    if ($cloudflaredService -and "$($cloudflaredService.State)" -eq "Running") {
      Write-Host "Detected running cloudflared Windows service without a local config.yml; preserving the existing service/dashboard-managed tunnel for $hostname." -ForegroundColor Green
      return
    }
    $configPath = New-CloudflaredConfigFromServerConfig $Config $hostname $serviceUrl
    if ([string]::IsNullOrWhiteSpace($configPath)) {
      if ($cloudflaredService) {
        Write-Warning "Cloudflare tunnel hostname '$hostname' is configured, but the cloudflared Windows service is not running and no local config.yml or tunnel credentials were found. Start or repair the existing cloudflared service before relying on public Helcim callbacks."
      } else {
        Write-Warning "Cloudflare tunnel hostname '$hostname' is configured, but no local cloudflared service/config.yml was found and no tunnel credentials were supplied. Public Helcim callbacks require a reachable cloudflared route to $serviceUrl."
      }
      return
    }
  }

  try {
    $updated = Set-CloudflaredIngressRule $configPath $hostname $serviceUrl
    if ($updated) {
      Write-Host "Updated cloudflared ingress for $hostname -> $serviceUrl in $configPath" -ForegroundColor Green
      Restart-Service cloudflared -ErrorAction SilentlyContinue
    } else {
      Write-Host "Verified cloudflared ingress for $hostname -> $serviceUrl"
    }
  } catch {
    Write-Warning "Could not update cloudflared ingress for ${hostname}: $($_.Exception.Message)"
  }
}

function Ensure-MeilisearchServerEnvironment($Config, [bool]$AllowLegacyKey = $false) {
  $envObj = Ensure-ServerEnvironmentObject $Config
  $url = Get-ServerEnvironmentValue $Config @("RIVERSIDE_MEILISEARCH_URL", "MEILISEARCH_URL")
  $apiKey = Get-ServerEnvironmentValue $Config @("RIVERSIDE_MEILISEARCH_API_KEY", "MEILISEARCH_API_KEY")

  if ([string]::IsNullOrWhiteSpace($url)) {
    $url = "http://127.0.0.1:7700"
    $script:meilisearchConfigModified = $true
  }
  $meiliInstallRoot = "$($Config.server.installRoot)".Trim()
  if ([string]::IsNullOrWhiteSpace($meiliInstallRoot)) {
    $meiliInstallRoot = "C:\RiversideOS"
  }
  $existingMeiliVersion = Join-Path $meiliInstallRoot "meilisearch\data\VERSION"
  $isDevelopmentDefault = $apiKey -eq "dev_master_key_change_me"
  if ([string]::IsNullOrWhiteSpace($apiKey) -or ($isDevelopmentDefault -and -not $AllowLegacyKey)) {
    if ($isDevelopmentDefault -and (Test-Path $existingMeiliVersion)) {
      $script:legacyMeilisearchKeyRotated = $true
      $script:previousMeilisearchApiKey = $apiKey
    }
    $apiKey = New-RiversideSecret 48
    $script:meilisearchConfigModified = $true
    if ($isDevelopmentDefault -and (Test-Path $existingMeiliVersion)) {
      Write-Host "Replaced the legacy Meilisearch development key with a private Main Hub key." -ForegroundColor Green
    } else {
      Write-Host "Auto-generated a private Meilisearch master key for this Main Hub." -ForegroundColor Green
    }
  }

  if (-not $envObj.PSObject.Properties["RIVERSIDE_MEILISEARCH_URL"] -or "$($envObj.RIVERSIDE_MEILISEARCH_URL)" -ne $url) {
    Set-SafeProperty $envObj "RIVERSIDE_MEILISEARCH_URL" $url
    $script:meilisearchConfigModified = $true
  }
  if (-not $envObj.PSObject.Properties["RIVERSIDE_MEILISEARCH_API_KEY"] -or "$($envObj.RIVERSIDE_MEILISEARCH_API_KEY)" -ne $apiKey) {
    Set-SafeProperty $envObj "RIVERSIDE_MEILISEARCH_API_KEY" $apiKey
    $script:meilisearchConfigModified = $true
  }

  return @{
    Url = $url
    ApiKey = $apiKey
  }
}

function Wait-MeilisearchReady([string]$BaseUrl) {
  $healthUrl = "$($BaseUrl.TrimEnd('/'))/health"
  Write-Host "Waiting for Meilisearch at $healthUrl..."
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    try {
      $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
      if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300) {
        Write-Host "Meilisearch health check passed at $healthUrl" -ForegroundColor Green
        return
      }
    } catch {}
  }
  throw "Meilisearch did not pass the health check at $healthUrl. Check the 'Riverside OS Meilisearch' scheduled task and C:\RiversideOS\meilisearch."
}

function Get-MeilisearchBinaryVersion([string]$MeilisearchExe) {
  if (-not (Test-Path $MeilisearchExe)) {
    return ""
  }
  try {
    $versionOutput = & $MeilisearchExe --version 2>$null | Select-Object -First 1
    if ("$versionOutput" -match '(\d+\.\d+\.\d+)') {
      return $Matches[1]
    }
  } catch {}
  return ""
}

function Repair-MeilisearchDataCompatibility([string]$MeilisearchExe, [string]$DataDir, [string]$MeiliDir) {
  $versionFile = Join-Path $DataDir "VERSION"
  if (-not (Test-Path $versionFile)) {
    return
  }

  $dataVersion = ""
  try {
    $dataVersion = (Get-Content $versionFile -Raw).Trim()
  } catch {
    $dataVersion = ""
  }
  $binaryVersion = Get-MeilisearchBinaryVersion $MeilisearchExe
  if ([string]::IsNullOrWhiteSpace($dataVersion) -or [string]::IsNullOrWhiteSpace($binaryVersion)) {
    return
  }
  if ($dataVersion -eq $binaryVersion) {
    return
  }

  $timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  $archiveDir = Join-Path $MeiliDir "data-incompatible-$dataVersion-$timestamp"
  Write-Warning "Meilisearch data version $dataVersion is incompatible with runtime $binaryVersion. Archiving local search index to $archiveDir so ROS can rebuild it."
  Move-Item -Path $DataDir -Destination $archiveDir -Force
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
}

function Ensure-RiversideMeilisearchHost(
  [string]$PackageRoot,
  [string]$InstallRoot,
  $Config,
  [bool]$StartNow = $true,
  [bool]$AllowLegacyKey = $false
) {
  $meiliConfig = Ensure-MeilisearchServerEnvironment $Config $AllowLegacyKey
  $meiliUrl = $meiliConfig.Url
  $apiKey = $meiliConfig.ApiKey

  if ($apiKey -match '"') {
    throw "RIVERSIDE_MEILISEARCH_API_KEY cannot contain a double quote because it is passed to the scheduled task command line."
  }

  try {
    $uri = [Uri]$meiliUrl
  } catch {
    throw "RIVERSIDE_MEILISEARCH_URL '$meiliUrl' is not a valid URL."
  }

  if ($uri.Scheme -notin @("http", "https")) {
    throw "RIVERSIDE_MEILISEARCH_URL '$meiliUrl' must use http or https."
  }

  $isLocal = $uri.Host -in @("127.0.0.1", "localhost", "::1")
  if (-not $isLocal) {
    Write-Warning "Meilisearch URL '$meiliUrl' is not local. Skipping local Riverside OS Meilisearch scheduled task setup."
    return
  }

  $port = if ($uri.Port -gt 0) { $uri.Port } else { 7700 }
  $localUrl = "http://127.0.0.1:$port"
  if ($meiliUrl -ne $localUrl) {
    Set-SafeProperty (Ensure-ServerEnvironmentObject $Config) "RIVERSIDE_MEILISEARCH_URL" $localUrl
    $script:meilisearchConfigModified = $true
    $meiliUrl = $localUrl
  }
  $taskName = "Riverside OS Meilisearch"
  $meiliSrc = Join-Path $PackageRoot "meilisearch\meilisearch.exe"
  $meiliDir = Join-Path $InstallRoot "meilisearch"
  $meiliExe = Join-Path $meiliDir "meilisearch.exe"
  $dataDir = Join-Path $meiliDir "data"
  $snapshotDir = Join-Path $meiliDir "snapshots"
  $dumpDir = Join-Path $meiliDir "dumps"

  if ((-not (Test-Path $meiliSrc)) -and (-not (Test-Path $meiliExe))) {
    throw "Meilisearch runtime is missing from the deployment package: $meiliSrc"
  }

  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  # Remove the restart policy before replacing the binary. Otherwise the task
  # can restart Meilisearch after Stop-ScheduledTask and relock the executable.
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Get-Process -Name "meilisearch" -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  $stopDeadline = (Get-Date).AddSeconds(15)
  do {
    $remainingMeilisearch = @(Get-Process -Name "meilisearch" -ErrorAction SilentlyContinue)
    if ($remainingMeilisearch.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $stopDeadline)
  if ($remainingMeilisearch.Count -gt 0) {
    throw "Meilisearch did not stop before its executable was replaced."
  }

  New-Item -ItemType Directory -Force -Path $meiliDir | Out-Null
  if (Test-Path $meiliSrc) {
    Copy-Item $meiliSrc $meiliExe -Force
  }
  Repair-MeilisearchDataCompatibility $meiliExe $dataDir $meiliDir
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  New-Item -ItemType Directory -Force -Path $snapshotDir | Out-Null
  New-Item -ItemType Directory -Force -Path $dumpDir | Out-Null

  $argument = "--http-addr 127.0.0.1:$port --master-key `"$apiKey`" --db-path `"$dataDir`" --snapshot-dir `"$snapshotDir`" --dump-dir `"$dumpDir`" --schedule-snapshot=86400 --no-analytics --env production"
  $action = New-ScheduledTaskAction -Execute $meiliExe -Argument $argument -WorkingDirectory $meiliDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 0)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
  Write-Host "Registered scheduled task '$taskName' at $meiliUrl"

  if ($StartNow) {
    Start-ScheduledTask -TaskName $taskName
    Wait-MeilisearchReady $meiliUrl
  }
}

function Get-DotEnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path $Path)) { return "" }
  foreach ($line in Get-Content $Path) {
    if ($line -match "^$([regex]::Escape($Name))=(.*)$") {
      return ConvertFrom-DotEnvValue $Matches[1]
    }
  }
  return ""
}

function Ensure-CubeServerEnvironment($Config, [string]$InstallRoot) {
  $envObj = Ensure-ServerEnvironmentObject $Config
  $existingEnvPath = Join-Path $InstallRoot "server\.env"
  $apiSecret = Get-ServerEnvironmentValue $Config @("RIVERSIDE_CUBE_API_SECRET")
  $reportingPassword = Get-ServerEnvironmentValue $Config @("RIVERSIDE_CUBE_REPORTING_DB_PASSWORD")

  if ([string]::IsNullOrWhiteSpace($apiSecret)) {
    $apiSecret = Get-DotEnvValue $existingEnvPath "RIVERSIDE_CUBE_API_SECRET"
  }
  if ([string]::IsNullOrWhiteSpace($reportingPassword)) {
    $reportingPassword = Get-DotEnvValue $existingEnvPath "RIVERSIDE_CUBE_REPORTING_DB_PASSWORD"
  }
  if ([string]::IsNullOrWhiteSpace($apiSecret) -or $apiSecret.Length -lt 32 -or $apiSecret -match "change_me|generate_a_long") {
    $apiSecret = New-RiversideSecret 48
    Write-Host "Auto-generated a private Cube Core API secret for this Main Hub." -ForegroundColor Green
  }
  if ([string]::IsNullOrWhiteSpace($reportingPassword) -or $reportingPassword.Length -lt 24 -or $reportingPassword -match "change_me|generate_a_long") {
    $reportingPassword = New-RiversideSecret 40
    Write-Host "Auto-generated the private cube_ro database password for this Main Hub." -ForegroundColor Green
  }

  foreach ($entry in @(
    @{ Name = "RIVERSIDE_CUBE_UPSTREAM"; Value = "http://127.0.0.1:4000" },
    @{ Name = "RIVERSIDE_CUBE_API_SECRET"; Value = $apiSecret },
    @{ Name = "RIVERSIDE_CUBE_REPORTING_DB_USER"; Value = "cube_ro" },
    @{ Name = "RIVERSIDE_CUBE_REPORTING_DB_PASSWORD"; Value = $reportingPassword }
  )) {
    $current = Get-ServerEnvironmentValue $Config @($entry.Name)
    if ($current -ne $entry.Value) {
      Set-SafeProperty $envObj $entry.Name $entry.Value
      $script:cubeConfigModified = $true
    }
  }

  return @{
    ApiSecret = $apiSecret
    ReportingPassword = $reportingPassword
  }
}

function Set-CubeRolePassword($PsqlPath, $Db, [string]$Password) {
  if ([string]::IsNullOrWhiteSpace($Password)) {
    throw "Cube reporting-role password is missing."
  }
  $escapedPassword = Escape-SqlLiteral $Password
  Invoke-PsqlAdminDatabase $PsqlPath $Db $Db.databaseName "ALTER ROLE cube_ro LOGIN NOINHERIT PASSWORD '$escapedPassword';"
  Write-Host "Cube reporting role credentials synchronized."
}

function Stop-RiversideCubeHost([string]$InstallRoot) {
  $taskName = "Riverside OS Cube Core"
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  $cubeRoot = [IO.Path]::GetFullPath((Join-Path $InstallRoot "cube")).TrimEnd('\')
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $executable = "$($_.ExecutablePath)"
    if ($executable -and [IO.Path]::GetFullPath($executable).StartsWith($cubeRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Wait-CubeReady([string]$BaseUrl) {
  $readyUrl = "$($BaseUrl.TrimEnd('/'))/readyz"
  Write-Host "Waiting for Cube Core at $readyUrl..."
  $deadline = (Get-Date).AddSeconds(120)
  do {
    try {
      $response = Invoke-WebRequest -Uri $readyUrl -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) {
        Write-Host "Cube Core readiness check passed at $readyUrl" -ForegroundColor Green
        return
      }
    } catch {}
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw "Cube Core did not pass the readiness check at $readyUrl. Check the 'Riverside OS Cube Core' scheduled task and $BaseUrl."
}

function Ensure-RiversideCubeHost(
  [string]$PackageRoot,
  [string]$InstallRoot,
  $Config,
  $Db,
  [bool]$StartNow = $true
) {
  $packageCube = Join-Path $PackageRoot "cube"
  $cubeDir = Join-Path $InstallRoot "cube"
  foreach ($required in @(
    (Join-Path $packageCube "node.exe"),
    (Join-Path $packageCube "node_modules\@cubejs-backend\server\bin\server"),
    (Join-Path $packageCube "cube.js"),
    (Join-Path $packageCube "model"),
    (Join-Path $packageCube "start-riverside-cube.ps1")
  )) {
    if (-not (Test-Path $required)) {
      throw "Cube Core runtime is missing from the deployment package: $required"
    }
  }

  Stop-RiversideCubeHost $InstallRoot
  if (Test-Path $cubeDir) {
    Remove-Item $cubeDir -Recurse -Force
  }
  Copy-Item $packageCube $cubeDir -Recurse -Force

  $envObj = Ensure-ServerEnvironmentObject $Config
  $cubeEnv = @(
    "CUBEJS_DB_HOST=$($Db.host)",
    "CUBEJS_DB_PORT=$($Db.port)",
    "CUBEJS_DB_NAME=$($Db.databaseName)",
    "CUBEJS_DB_USER=cube_ro",
    "CUBEJS_DB_PASS=$($envObj.RIVERSIDE_CUBE_REPORTING_DB_PASSWORD)",
    "CUBEJS_API_SECRET=$($envObj.RIVERSIDE_CUBE_API_SECRET)"
  )
  Set-Content -Path (Join-Path $cubeDir ".env") -Value $cubeEnv -Encoding UTF8

  $taskName = "Riverside OS Cube Core"
  $startScript = Join-Path $cubeDir "start-riverside-cube.ps1"
  $argument = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -InstallRoot `"$InstallRoot`""
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument -WorkingDirectory $cubeDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 0)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
  Write-Host "Registered scheduled task '$taskName' at http://127.0.0.1:4000"

  if ($StartNow) {
    Start-ScheduledTask -TaskName $taskName
    Wait-CubeReady "http://127.0.0.1:4000"
  }
}

function Escape-SqlLiteral([string]$Value) {
  return $Value.Replace("'", "''")
}

function Quote-SqlIdentifier([string]$Value) {
  return '"' + $Value.Replace('"', '""') + '"'
}

function Resolve-ServerEnvironmentMode($Config) {
  $mode = "$($Config.server.environmentMode)".Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($mode)) {
    return "production"
  }
  if ($mode -notin @("development", "production", "e2e")) {
    throw "Invalid server.environmentMode '$mode'. Expected development, production, or e2e."
  }
  return $mode
}

function ConvertTo-DotEnvValue($Value) {
  $text = if ($null -eq $Value) { "" } else { "$Value" }
  if ($text -match "[`r`n]") {
    throw "Server environment values cannot contain line breaks."
  }
  $escaped = $text.Replace('\', '\\').Replace('"', '\"').Replace('$', '\$')
  return '"' + $escaped + '"'
}

function ConvertFrom-DotEnvValue([string]$Value) {
  $text = "$Value".Trim()
  if ($text.Length -lt 2) { return $text }
  if ($text[0] -eq "'" -and $text[$text.Length - 1] -eq "'") {
    return $text.Substring(1, $text.Length - 2)
  }
  if ($text[0] -eq '"' -and $text[$text.Length - 1] -eq '"') {
    $inner = $text.Substring(1, $text.Length - 2)
    return $inner.Replace('\$', '$').Replace('\"', '"').Replace('\\', '\')
  }
  return $text
}

function Format-DotEnvLine([string]$Name, $Value) {
  return "$Name=$(ConvertTo-DotEnvValue $Value)"
}

function Get-PreservedRosieEnvironment([string]$Path) {
  $preserved = @{}
  if (-not (Test-Path $Path)) {
    return $preserved
  }

  foreach ($line in @(Get-Content $Path)) {
    if ($line -match '^((?:RIVERSIDE_(?:LLAMA|ROSIE|SHERPA)|ROSIE)_[A-Z0-9_]+)=(.*)$') {
      $preserved[$Matches[1]] = ConvertFrom-DotEnvValue $Matches[2]
    }
  }
  return $preserved
}

function Restore-RosieEnvironment([string]$Path, $Environment) {
  if (-not (Test-Path $Path)) { return }
  $lines = @(Get-Content $Path) | Where-Object {
    $_ -notmatch '^((?:RIVERSIDE_(?:LLAMA|ROSIE|SHERPA)|ROSIE)_[A-Z0-9_]+)='
  }
  foreach ($key in @($Environment.Keys | Sort-Object)) {
    $lines += Format-DotEnvLine $key $Environment[$key]
  }
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($Path, [string[]]$lines, $utf8WithoutBom)
}

function Resolve-InstalledRosieModelPath([string]$InstallRoot, [string]$PackageRoot, $PreservedRosieEnvironment) {
  if ($PreservedRosieEnvironment.ContainsKey("RIVERSIDE_LLAMA_MODEL_PATH")) {
    $configuredPath = "$($PreservedRosieEnvironment["RIVERSIDE_LLAMA_MODEL_PATH"])".Trim()
    if ($configuredPath -and (Test-Path $configuredPath)) {
      return $configuredPath
    }
  }

  $modelDirectory = Join-Path $InstallRoot "rosie\models\gemma-4-e4b"
  $modelFilename = "gemma-4-E4B_q4_0-it.gguf"
  $pinPath = Join-Path $PackageRoot "rosie\MODEL_PIN.json"
  if (Test-Path $pinPath) {
    try {
      $pin = Get-Content -Raw $pinPath | ConvertFrom-Json
      if ($pin.filename) { $modelFilename = "$($pin.filename)" }
    } catch {}
  }

  $pinnedModelPath = Join-Path $modelDirectory $modelFilename
  if (Test-Path $pinnedModelPath) {
    return $pinnedModelPath
  }

  $installedModels = @(Get-ChildItem -Path $modelDirectory -Filter "*.gguf" -File -ErrorAction SilentlyContinue)
  if ($installedModels.Count -eq 1) {
    return $installedModels[0].FullName
  }
  if ($installedModels.Count -gt 1) {
    Write-Warning "Multiple installed ROSIE models were found and the existing environment does not identify one. ROSIE files and scheduled tasks will remain untouched."
  }
  return $null
}

function Write-ServerEnv($Path, $Config, $DatabaseUrl, $BackupDatabaseUrl, $FrontendDist, $RosieModelPath, $PreservedRosieEnvironment = $null) {
  $server = $Config.server
  $configuredLlamaProfile = ""
  if ($server.environment) {
    $configuredLlamaProfile = "$($server.environment.RIVERSIDE_LLAMA_PERF_PROFILE)".Trim()
  }
  $environmentMode = Resolve-ServerEnvironmentMode $Config
  $httpBind = $server.httpBind
  if ([string]::IsNullOrWhiteSpace($httpBind)) { $httpBind = "0.0.0.0:3000" }
  $corsOrigins = @($server.corsOrigins) |
    Where-Object { $null -ne $_ -and "$_".Trim() -ne "" } |
    ForEach-Object { "$_".Trim() }
  foreach ($requiredOrigin in @("http://tauri.localhost", "https://tauri.localhost")) {
    if ($corsOrigins -notcontains $requiredOrigin) {
      $corsOrigins += $requiredOrigin
    }
  }
  $lines = @(
    (Format-DotEnvLine "DATABASE_URL" $DatabaseUrl),
    (Format-DotEnvLine "RIVERSIDE_BACKUP_DATABASE_URL" $BackupDatabaseUrl),
    (Format-DotEnvLine "FRONTEND_DIST" $FrontendDist),
    (Format-DotEnvLine "RIVERSIDE_HTTP_BIND" $httpBind),
    (Format-DotEnvLine "RIVERSIDE_MODE" $environmentMode),
    (Format-DotEnvLine "RIVERSIDE_STRICT_PRODUCTION" "$([bool]$server.strictProduction)".ToLowerInvariant()),
    (Format-DotEnvLine "RIVERSIDE_CORS_ORIGINS" ($corsOrigins -join ',')),
    (Format-DotEnvLine "RIVERSIDE_STORE_CUSTOMER_JWT_SECRET" $server.storeCustomerJwtSecret),
    (Format-DotEnvLine "RIVERSIDE_CREDENTIALS_KEY" $server.storeCustomerJwtSecret)
  )

  # ROSIE local LLM - write model path so the Axum proxy can derive RIVERSIDE_LLAMA_UPSTREAM
  # at startup. Port stays at the default 8080 unless overridden in config.server.environment.
  if ($PreservedRosieEnvironment -and $PreservedRosieEnvironment.Count -gt 0) {
    foreach ($key in @($PreservedRosieEnvironment.Keys | Sort-Object)) {
      $lines += Format-DotEnvLine $key $PreservedRosieEnvironment[$key]
    }
  } elseif ($RosieModelPath) {
    $rosieMmprojPath = Join-Path (Split-Path -Parent $RosieModelPath) "gemma-4-E4B-it-mmproj.gguf"
    $lines += Format-DotEnvLine "RIVERSIDE_LLAMA_MODEL_PATH" $RosieModelPath
    if (Test-Path $rosieMmprojPath) {
      $lines += Format-DotEnvLine "RIVERSIDE_LLAMA_MMPROJ_PATH" $rosieMmprojPath
    }
    $lines += Format-DotEnvLine "RIVERSIDE_LLAMA_PORT" "8080"
    $lines += Format-DotEnvLine "RIVERSIDE_LLAMA_HOST" "127.0.0.1"
    $lines += Format-DotEnvLine "RIVERSIDE_LLAMA_CONTEXT_SIZE" "16384"
    $lines += Format-DotEnvLine "RIVERSIDE_LLAMA_PARALLEL" "2"
    $lines += Format-DotEnvLine "RIVERSIDE_LLAMA_BATCH_SIZE" "512"
    $lines += Format-DotEnvLine "RIVERSIDE_LLAMA_UBATCH_SIZE" "512"
    $lines += Format-DotEnvLine "ROSIE_ALLOW_CLOUD_PROVIDERS" "false"
    $lines += Format-DotEnvLine "ROSIE_ENABLE_ANALYSIS_REASONING" "false"
    if (-not $configuredLlamaProfile) {
      $lines += Format-DotEnvLine "RIVERSIDE_LLAMA_PERF_PROFILE" "auto"
    }
  }

  if ($server.environment) {
    foreach ($prop in $server.environment.PSObject.Properties) {
      $isPreservedRosieSetting = $PreservedRosieEnvironment -and $PreservedRosieEnvironment.ContainsKey($prop.Name)
      $isInstallerManagedBackupConnection = $prop.Name -eq "RIVERSIDE_BACKUP_DATABASE_URL"
      if (-not $isPreservedRosieSetting -and -not $isInstallerManagedBackupConnection -and $null -ne $prop.Value -and "$($prop.Value)" -ne "") {
        $lines += Format-DotEnvLine $prop.Name $prop.Value
      }
    }
  }

  Set-Content -Path $Path -Value $lines -Encoding UTF8
}

function Set-ServerDatabaseUrl([string]$Path, [string]$DatabaseUrl) {
  if (-not (Test-Path $Path)) {
    throw "Cannot repair DATABASE_URL because the restored server environment file is missing: $Path"
  }

  $lines = @(Get-Content $Path)
  $replaced = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^DATABASE_URL=') {
      $lines[$i] = Format-DotEnvLine "DATABASE_URL" $DatabaseUrl
      $replaced = $true
    }
  }
  if (-not $replaced) {
    $lines = @(Format-DotEnvLine "DATABASE_URL" $DatabaseUrl) + $lines
  }

  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($Path, [string[]]$lines, $utf8WithoutBom)
}

function Write-DeploymentConfigJson([string]$Path, $DeploymentConfig) {
  $json = $DeploymentConfig | ConvertTo-Json -Depth 20
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8WithoutBom)
}

function Set-DeploymentConfigDatabaseAppPassword([string]$Path, [string]$AppPassword) {
  if (-not (Test-Path $Path)) {
    throw "Cannot synchronize the deployment config because it is missing: $Path"
  }

  $restoredConfig = Get-Content $Path -Raw | ConvertFrom-Json
  if (-not $restoredConfig.server -or -not $restoredConfig.server.database) {
    throw "Cannot synchronize the deployment config because server.database is missing: $Path"
  }
  Set-SafeProperty $restoredConfig.server.database "appPassword" $AppPassword
  Write-DeploymentConfigJson $Path $restoredConfig
}

# ---------------------------------------------------------------------------
# ROSIE AI Stack Setup
# Downloads the pinned Gemma GGUF, SenseVoice STT model, and Kokoro TTS model.
# Sherpa-ONNX runtime is not installed.
# All assets land in %LOCALAPPDATA%\riverside-os\rosie\.
# Returns the resolved model path (or $null if skipped / failed non-fatally).
# ---------------------------------------------------------------------------
function Install-RosieStack($PackageRoot) {
  $installerPath = Join-Path $PackageRoot "Install-RosieAiStack.ps1"
  if (-not (Test-Path $installerPath)) {
    Write-Warning "ROSIE: Install-RosieAiStack.ps1 not found at $installerPath. Cannot set up ROSIE stack."
    return $null
  }

  # Stop the LLM scheduled task and any llama-server / sherpa processes before
  # running the installer so that bundled DLLs (e.g. ggml-base.dll) are never
  # locked when the installer tries to overwrite them.
  Stop-ScheduledTask -TaskName "Riverside OS LLM Host" -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  @("llama-server", "sherpa-onnx-offline", "sherpa-onnx-offline-tts", "sherpa-onnx") | ForEach-Object {
    Get-Process -Name $_ -ErrorAction SilentlyContinue | ForEach-Object {
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 2

  Write-Host "ROSIE: Delegating to $installerPath. The main installer will write server .env after ROSIE resolves the model path..."
  try {
    # Call the installer script with -SkipEnvPatch because Write-ServerEnv owns the final
    # server .env contents for full Main Hub installs.
    & $installerPath -ServerInstallRoot $installRoot -SkipEnvPatch
  } catch {
    Write-Warning "ROSIE: Install-RosieAiStack.ps1 execution failed: $_"
    return $null
  }

  $rosieRoot = Join-Path $installRoot "rosie"
  $statusPath = Join-Path $rosieRoot "rosie_status.json"
  $readyFlag = Join-Path $rosieRoot "rosie_ready"
  if (Test-Path $statusPath) {
    try {
      $rosieStatus = Get-Content -Raw $statusPath | ConvertFrom-Json
      if ($rosieStatus.ready -eq $true) {
        Write-Host "ROSIE: Component status reports full stack readiness."
      } elseif ($rosieStatus.installation_ready -eq $true) {
        Write-Host "ROSIE: Runtime assets verified. Functional certification will run next."
      } else {
        Write-Warning "ROSIE: Component status reports partial setup. LLM may still be configured if the Gemma model is present."
      }
    } catch {
      Write-Warning "ROSIE: Could not parse component status at $statusPath."
    }
  } elseif (-not (Test-Path $readyFlag)) {
    Write-Warning "ROSIE: No component status or ready flag was found under $rosieRoot."
  }

  # Resolve model destination using MODEL_PIN.json or release default
  $pinPath = Join-Path $PackageRoot "rosie\MODEL_PIN.json"
  $modelFilename = "gemma-4-E4B_q4_0-it.gguf"
  if (Test-Path $pinPath) {
    try {
      $pin = Get-Content -Raw $pinPath | ConvertFrom-Json
      if ($pin.filename) { $modelFilename = $pin.filename }
    } catch {}
  }

  $modelDest = Join-Path $rosieRoot "models\gemma-4-e4b\$modelFilename"
  if (Test-Path $modelDest) {
    Write-Host "ROSIE: Setup verified successfully. Model path: $modelDest"
    return $modelDest
  } else {
    Write-Warning "ROSIE: Model file not found at $modelDest despite rosie_ready flag."
    return $null
  }
}

function Set-MachineEnvironmentFromServerConfig($Config) {
  # Keep secrets in C:\RiversideOS\server\.env, but clear stale machine-level
  # runtime mode because Windows environment variables override dotenv values.
  $environmentMode = Resolve-ServerEnvironmentMode $Config
  [Environment]::SetEnvironmentVariable("RIVERSIDE_MODE", $environmentMode, "Machine")
  $env:RIVERSIDE_MODE = $environmentMode
  Write-Host "Machine RIVERSIDE_MODE set to $environmentMode."
}

function Get-MigrationSortKey($File) {
  if ($File.Name -match '^(\d+)([a-zA-Z]?)_') {
    return "{0:D6}-{1}-{2}" -f [int]$Matches[1], $Matches[2], $File.Name
  }
  return "999999--$($File.Name)"
}

function Get-FileSha256([string]$Path) {
  $hash = Get-FileHash -Path $Path -Algorithm SHA256
  return $hash.Hash.ToLower()
}

function Get-Sha256ForBytes([byte[]]$Bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($Bytes)
    return -join ($hash | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha.Dispose()
  }
}

function Get-FileSha256Variants([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $lfBytes = New-Object System.Collections.Generic.List[byte]
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    if ($bytes[$i] -eq 13) {
      if (($i + 1) -lt $bytes.Length -and $bytes[$i + 1] -eq 10) {
        $lfBytes.Add(10)
        $i++
      } else {
        $lfBytes.Add(10)
      }
    } else {
      $lfBytes.Add($bytes[$i])
    }
  }

  $crlfBytes = New-Object System.Collections.Generic.List[byte]
  foreach ($byte in $lfBytes) {
    if ($byte -eq 10) {
      $crlfBytes.Add(13)
      $crlfBytes.Add(10)
    } else {
      $crlfBytes.Add($byte)
    }
  }

  return @(
    Get-Sha256ForBytes $bytes
    Get-Sha256ForBytes $lfBytes.ToArray()
    Get-Sha256ForBytes $crlfBytes.ToArray()
  ) | Select-Object -Unique
}

function Test-MigrationChecksumMatch([string]$StoredSha, [string[]]$AllowedShas) {
  $normalizedStoredSha = $StoredSha.Trim().ToLower()
  return ($AllowedShas -contains $normalizedStoredSha)
}

function Test-SupersededBrokenMigration([string]$FileName, [string]$FileSha256, [string]$MigrationsDir) {
  if ($FileName -ne "202_repair_verified_rms90_programs.sql") {
    return $false
  }

  $knownBrokenShas = @(
    "34dd6bacf8f6da4aac19e039b7318a39a5beada46d7b1e709ac5ffcb7fb2c1a9",
    "855ee71f347c84be89d897881ac84124bcf82f6a8113565c90f16ad169603b9b"
  )
  $replacementPath = Join-Path $MigrationsDir "206_repair_verified_rms90_programs_v2.sql"
  return ($knownBrokenShas -contains $FileSha256) -and (Test-Path $replacementPath)
}

function Get-MigrationLedgerExists($PsqlPath, $DatabaseUrl) {
  $ledgerCheck = & $PsqlPath $DatabaseUrl -w -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations');"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not check migration ledger."
  }
  return (($ledgerCheck -join "").Trim() -eq "t")
}

function Get-MigrationApplied($PsqlPath, $DatabaseUrl, [string]$Version) {
  $migrationVersion = Escape-SqlLiteral $Version
  $applied = & $PsqlPath $DatabaseUrl -w -tAc "SELECT EXISTS(SELECT 1 FROM ros_schema_migrations WHERE version = '$migrationVersion');"
  return (($applied -join "").Trim() -eq "t")
}

function Ensure-MigrationChecksumColumn($PsqlPath, $DatabaseUrl) {
  if (Get-MigrationLedgerExists $PsqlPath $DatabaseUrl) {
    Invoke-Psql $PsqlPath $DatabaseUrl "ALTER TABLE ros_schema_migrations ADD COLUMN IF NOT EXISTS file_sha256 text;"
  }
}

function Get-StoredMigrationChecksum($PsqlPath, $DatabaseUrl, [string]$Version) {
  $migrationVersion = Escape-SqlLiteral $Version
  $stored = & $PsqlPath $DatabaseUrl -w -tAc "SELECT COALESCE(file_sha256, '') FROM ros_schema_migrations WHERE version = '$migrationVersion';"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read migration checksum for $Version."
  }
  return (($stored -join "").Trim()).ToLower()
}

function Update-StoredMigrationChecksum($PsqlPath, $DatabaseUrl, [string]$Version, [string]$FileSha256) {
  $migrationVersion = Escape-SqlLiteral $Version
  $safeSha = Escape-SqlLiteral $FileSha256
  Invoke-Psql $PsqlPath $DatabaseUrl "UPDATE ros_schema_migrations SET file_sha256 = '$safeSha' WHERE version = '$migrationVersion' AND (file_sha256 IS NULL OR btrim(file_sha256) = '');"
}

function Add-MigrationLedgerEntry($PsqlPath, $DatabaseUrl, [string]$Version, [string]$FileSha256) {
  $migrationVersion = Escape-SqlLiteral $Version
  $safeSha = Escape-SqlLiteral $FileSha256
  $sql = "UPDATE ros_schema_migrations SET file_sha256 = CASE " +
    "WHEN file_sha256 IS NULL OR btrim(file_sha256) = '' THEN '$safeSha' " +
    "ELSE file_sha256 END WHERE version = '$migrationVersion'; " +
    "INSERT INTO ros_schema_migrations (version, file_sha256) " +
    "SELECT '$migrationVersion', '$safeSha' " +
    "WHERE NOT EXISTS (SELECT 1 FROM ros_schema_migrations WHERE version = '$migrationVersion');"
  Invoke-Psql $PsqlPath $DatabaseUrl $sql
}

function Test-CoreIdentityMigrationApplied($PsqlPath, $DatabaseUrl) {
  $result = & $PsqlPath $DatabaseUrl -w -tAc "SELECT to_regclass('public.store_settings') IS NOT NULL AND to_regclass('public.variant_sku_seq') IS NOT NULL;"
  return (($result -join "").Trim() -eq "t")
}

function Repair-PublicSerialSequences($PsqlPath, $DatabaseUrl) {
  $sql = @'
DO $$
DECLARE
  rec record;
  max_value bigint;
BEGIN
  FOR rec IN
    SELECT
      n.nspname AS table_schema,
      c.relname AS table_name,
      a.attname AS column_name,
      pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS sequence_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname = 'public'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
  LOOP
    EXECUTE format(
      'SELECT COALESCE(MAX(%I), 0) FROM %I.%I',
      rec.column_name,
      rec.table_schema,
      rec.table_name
    )
    INTO max_value;

    EXECUTE format(
      'SELECT setval(%L::regclass, GREATEST(%s + 1, 1), false)',
      rec.sequence_name,
      max_value
    );
  END LOOP;
END $$;
'@
  Invoke-Psql $PsqlPath $DatabaseUrl $sql
}

function Apply-Migrations($PsqlPath, $DatabaseUrl, $MigrationsDir, $DbConfig) {
  Write-DeploymentStatus "MIGRATING" "Starting database migrations"
  $files = Get-ChildItem $MigrationsDir -Filter "*.sql" |
    Where-Object { $_.Name -match '^\d+[a-zA-Z]?_.*\.sql$' } |
    Sort-Object @{ Expression = { Get-MigrationSortKey $_ } }

  if (Get-MigrationLedgerExists $PsqlPath $DatabaseUrl) {
    Ensure-MigrationChecksumColumn $PsqlPath $DatabaseUrl
  }

  foreach ($file in $files) {
    $currentSha = Get-FileSha256 $file.FullName
    $currentShaVariants = Get-FileSha256Variants $file.FullName
    if (Get-MigrationLedgerExists $PsqlPath $DatabaseUrl) {
      if (Get-MigrationApplied $PsqlPath $DatabaseUrl $file.Name) {
        $storedSha = Get-StoredMigrationChecksum $PsqlPath $DatabaseUrl $file.Name
        if ([string]::IsNullOrWhiteSpace($storedSha)) {
          Update-StoredMigrationChecksum $PsqlPath $DatabaseUrl $file.Name $currentSha
          Write-Host "Skip migration $($file.Name) (checksum recorded)"
        } elseif (-not (Test-MigrationChecksumMatch $storedSha $currentShaVariants)) {
          throw "Migration checksum drift detected for $($file.Name). Stored=$storedSha Current=$currentSha. Create a new numbered migration to reconcile."
        } elseif ($storedSha -ne $currentSha) {
          Write-Host "Skip migration $($file.Name) (line-ending checksum compatible)"
        } else {
          Write-Host "Skip migration $($file.Name)"
        }
        continue
      }
      if ($file.Name -eq "001_core_identity_staff.sql" -and (Test-CoreIdentityMigrationApplied $PsqlPath $DatabaseUrl)) {
        Write-Host "Recover migration ledger for $($file.Name)"
        Add-MigrationLedgerEntry $PsqlPath $DatabaseUrl $file.Name $currentSha
        continue
      }
    }

    if (Test-SupersededBrokenMigration $file.Name $currentSha $MigrationsDir) {
      Write-Host "Skip migration $($file.Name) (superseded by migration 206)"
      Add-MigrationLedgerEntry $PsqlPath $DatabaseUrl $file.Name $currentSha
      continue
    }

    Write-Host "Apply migration $($file.Name)"
    try {
      Repair-PublicSerialSequences $PsqlPath $DatabaseUrl
      if ($file.Name -eq "185_cube_insights_and_saved_reports.sql") {
        Invoke-CubeRoleMigrationFile $PsqlPath $DbConfig $file.FullName
      } else {
        Invoke-PsqlFile $PsqlPath $DatabaseUrl $file.FullName
      }
    } catch {
      throw "Migration failed: $($file.Name). $($_.Exception.Message)"
    }
    if (-not (Get-MigrationLedgerExists $PsqlPath $DatabaseUrl)) {
      throw "Migration $($file.Name) did not create public.ros_schema_migrations; cannot record ledger state."
    }
    Ensure-MigrationChecksumColumn $PsqlPath $DatabaseUrl
    Add-MigrationLedgerEntry $PsqlPath $DatabaseUrl $file.Name $currentSha
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

function Set-DatabaseEnvironmentMode($PsqlPath, $DatabaseUrl, [string]$Mode) {
  $mode = $Mode.Trim().ToLowerInvariant()
  if ($mode -notin @("development", "production", "e2e")) {
    throw "Invalid database environment_mode '$mode'. Expected development, production, or e2e."
  }
  Invoke-Psql $PsqlPath $DatabaseUrl "UPDATE store_settings SET environment_mode = '$mode' WHERE id = 1;"
  $actualMode = Invoke-PsqlScalar $PsqlPath $DatabaseUrl "SELECT environment_mode FROM store_settings WHERE id = 1;"
  if ($actualMode -ne $mode) {
    throw "Could not stamp database environment_mode as '$mode'. Current value: '$actualMode'."
  }
}

Assert-Admin
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $ScriptRoot "riverside-deployment.config.json"
}
if (-not (Test-Path $ConfigPath)) {
  $configFileName = "riverside-deployment.config.json"
  $candidateConfigPaths = @(
    $ConfigPath,
    (Join-Path $ScriptRoot $configFileName),
    (Join-Path (Split-Path -Parent $ScriptRoot) $configFileName),
    "C:\RiversideOS\$configFileName",
    "C:\ProgramData\RiversideOS\$configFileName",
    "C:\ProgramData\riverside-os\$configFileName"
  )
  $downloadsDir = Join-Path $env:USERPROFILE "Downloads"
  if (Test-Path $downloadsDir) {
    $downloadPackageConfigs = Get-ChildItem -Path $downloadsDir -Directory -Filter "RiversideOS-*-Windows-Deployment*" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      ForEach-Object { Join-Path $_.FullName $configFileName }
    $candidateConfigPaths += $downloadPackageConfigs
  }
  $resolvedConfigPath = $null
  foreach ($candidateConfigPath in $candidateConfigPaths) {
    if (-not [string]::IsNullOrWhiteSpace($candidateConfigPath) -and (Test-Path $candidateConfigPath)) {
      $resolvedConfigPath = $candidateConfigPath
      break
    }
  }
  if ($resolvedConfigPath) {
    Write-Host "Using deployment config from $resolvedConfigPath" -ForegroundColor Yellow
    $ConfigPath = $resolvedConfigPath
  } else {
    $searchedConfigPaths = ($candidateConfigPaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique) -join "; "
    throw "Config file not found. Searched: $searchedConfigPaths. Save the PostgreSQL Admin Password in Riverside before running Main Hub update."
  }
}

$sourceConfigOriginalBytes = [System.IO.File]::ReadAllBytes($ConfigPath)
$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
if (-not $config.server) {
  $config | Add-Member -NotePropertyName server -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $config.server.database) {
  $config.server | Add-Member -NotePropertyName database -NotePropertyValue ([pscustomobject]@{}) -Force
}

if ($packageManifest -and $packageManifest.releaseVersion) {
  if ($config.releaseVersion -ne $packageManifest.releaseVersion) {
    Set-SafeProperty $config "releaseVersion" $packageManifest.releaseVersion
    $configModified = $true
  }
}

function New-RiversideSecret([int]$Length) {
  $chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  $bytes = New-Object byte[] 1
  $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $result = ""
  try {
    while ($result.Length -lt $Length) {
      $random.GetBytes($bytes)
      # Reject the top eight byte values so modulo 62 is unbiased.
      if ($bytes[0] -lt 248) {
        $result += $chars[$bytes[0] % $chars.Length]
      }
    }
  } finally {
    $random.Dispose()
  }
  return $result
}

function Test-PlaceholderSecret([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
  return $Value -match "replace-" -or $Value -eq "password" -or $Value -eq "placeholder"
}
$configModified = $false

if (Test-PlaceholderSecret $config.server.storeCustomerJwtSecret) {
  # Check if an existing key can be salvaged from server/.env first
  $existingKey = $null
  $tempInstallRoot = $config.server.installRoot
  if ([string]::IsNullOrWhiteSpace($tempInstallRoot)) {
    $tempInstallRoot = "C:\RiversideOS"
  }
  $tempEnvPath = Join-Path $tempInstallRoot "server\.env"
  if (Test-Path $tempEnvPath) {
    foreach ($line in Get-Content $tempEnvPath) {
      if ($line -match '^RIVERSIDE_CREDENTIALS_KEY=(.+)$') {
        $candidate = $Matches[1].Trim()
        if (-not (Test-PlaceholderSecret $candidate)) {
          $existingKey = $candidate
          break
        }
      }
    }
  }

  if ($existingKey) {
    Set-SafeProperty $config.server "storeCustomerJwtSecret" $existingKey
    $configModified = $true
    Write-Host "Salvaged existing secure JWT secret from server .env." -ForegroundColor Green
  } else {
    Set-SafeProperty $config.server "storeCustomerJwtSecret" (New-RiversideSecret 32)
    $configModified = $true
    Write-Host "Auto-generated secure JWT secret." -ForegroundColor Green
  }
}

if (Test-PlaceholderSecret $config.server.database.appPassword) {
  Set-SafeProperty $config.server.database "appPassword" (New-RiversideSecret 24)
  $configModified = $true
  Write-Host "Auto-generated secure database app password." -ForegroundColor Green
}

  $dbHost = $config.server.database.host
  $dbPort = $config.server.database.port
  $dbUser = $config.server.database.adminUser
  if ([string]::IsNullOrWhiteSpace($dbHost)) { $dbHost = "127.0.0.1" }
  $resolvedDbHost = Resolve-MainHubDatabaseHost $dbHost
  if ($resolvedDbHost -ne $dbHost) {
    Set-SafeProperty $config.server.database "host" $resolvedDbHost
    $configModified = $true
    $dbHost = $resolvedDbHost
    Write-Host "Repaired Main Hub database host to $dbHost." -ForegroundColor Green
  }
  if (-not $dbPort) { $dbPort = 5432 }
  if ([string]::IsNullOrWhiteSpace($dbUser)) { $dbUser = "postgres" }

  $psqlCmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  $psqlPath = if ($psqlCmd) { $psqlCmd.Source } else {
    $matches = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
    if ($matches) { $matches[0].FullName } else { "psql.exe" }
  }

  Write-Host "Verifying database connection details..."
  $success = Test-PostgresReachable $dbHost $dbPort
  if ($success) {
    $authenticated = $false
    $currentPwd = $config.server.database.adminPassword
    if (Test-PlaceholderSecret $currentPwd) { $currentPwd = "" }

    # Test current configured password.
    # -w (--no-password) prevents psql from ever opening an interactive prompt;
    # if the password is wrong it exits non-zero immediately.
    # We temporarily switch $ErrorActionPreference to SilentlyContinue to prevent native stderr output from triggering crashes.
    $oldEAP = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"

    $env:PGPASSWORD = $currentPwd
    $testQuery = & $psqlPath -U $dbUser -h $dbHost -p $dbPort -d postgres -w -c "SELECT 1;" -t 2>&1
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -eq 0) {
      $authenticated = $true
      Set-SafeProperty $config.server.database "adminPassword" $currentPwd
    } else {
      # Try trust authentication (empty/no password)
      $env:PGPASSWORD = ""
      $testQuery = & $psqlPath -U $dbUser -h $dbHost -p $dbPort -d postgres -w -c "SELECT 1;" -t 2>&1
      Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
      if ($LASTEXITCODE -eq 0) {
        $authenticated = $true
        Set-SafeProperty $config.server.database "adminPassword" ""
        $configModified = $true
        Write-Host "PostgreSQL trust authentication detected (no password required)." -ForegroundColor Green
      } else {
        # Try common default passwords
        foreach ($pwd in @("postgres", "admin", "password")) {
          $env:PGPASSWORD = $pwd
          $testQuery = & $psqlPath -U $dbUser -h $dbHost -p $dbPort -d postgres -w -c "SELECT 1;" -t 2>&1
          Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
          if ($LASTEXITCODE -eq 0) {
            $authenticated = $true
            Set-SafeProperty $config.server.database "adminPassword" $pwd
            $configModified = $true
            Write-Host "Auto-detected PostgreSQL admin password: '$pwd'" -ForegroundColor Green
            break
          }
        }
      }
    }

    $ErrorActionPreference = $oldEAP

    # If not authenticated, fail gracefully with config file reference
    if (-not $authenticated) {
      Write-DeploymentStatus "AUTH_FAILED" "Database password missing or invalid in config"
      Write-Host "--------------------------------------------------------" -ForegroundColor Red
      Write-Host "Database password missing in config" -ForegroundColor Red
      Write-Host "--------------------------------------------------------" -ForegroundColor Red
      Write-Host "The PostgreSQL admin password is not set or invalid in $ConfigPath" -ForegroundColor Yellow
      Write-Host "Please update the 'server.database.adminPassword' field in the config file." -ForegroundColor Yellow
      Write-Host "Opening config file in Notepad..." -ForegroundColor Yellow
      Start-Process notepad.exe $ConfigPath
      throw "Database password missing in config. Please update server.database.adminPassword in $ConfigPath"
    }
  } else {
    Write-Warning "PostgreSQL is not reachable on $dbHost`:$dbPort during credential precheck. Continuing so the installer can start, repair, or install local PostgreSQL."
  }

if ($configModified) {
  Write-Host "Resolved deployment config changes will be saved after update preflight succeeds." -ForegroundColor Yellow
}
# $packageManifest already loaded at script startup
$server = $config.server
if (-not $server) { throw "Config file is missing the 'server' section. Check your riverside-deployment.config.json." }
$db = $server.database
if (-not $db) { throw "Config file is missing the 'server.database' section. Check your riverside-deployment.config.json." }
if ($db.adminUser -match '^(Admin|Administrator)$') {
  Write-Warning "database.adminUser was '$($db.adminUser)'; using 'postgres' (PostgreSQL superuser)."
  Set-SafeProperty $db "adminUser" "postgres"
}
if ($db.appUser -match '^(Admin|Administrator)$') {
  Write-Warning "database.appUser was '$($db.appUser)'; using 'riverside_app'."
  Set-SafeProperty $db "appUser" "riverside_app"
}
if ([string]::IsNullOrWhiteSpace($db.host))         { Set-SafeProperty $db "host" "127.0.0.1" }
if (-not $db.port)                                   { Set-SafeProperty $db "port" 5432 }
if ([string]::IsNullOrWhiteSpace($db.databaseName))  { Set-SafeProperty $db "databaseName" "riverside_os" }
if ([string]::IsNullOrWhiteSpace($db.appUser))       { Set-SafeProperty $db "appUser" "riverside_app" }
if ([string]::IsNullOrWhiteSpace($db.adminUser))     { Set-SafeProperty $db "adminUser" "postgres" }
$installRoot = $server.installRoot
if ([string]::IsNullOrWhiteSpace($installRoot)) {
  $installRoot = "C:\RiversideOS"
  Write-Host "No installRoot in config - defaulting to $installRoot" -ForegroundColor Yellow
}
$serverDir = Join-Path $installRoot "server"
$clientDist = Join-Path $installRoot "client\dist"
$releaseDir = Join-Path $installRoot "release"
$backupDir = Join-Path $installRoot "backups"
$logDir = Join-Path $installRoot "logs"
$installedServerExe = Join-Path $serverDir "riverside-server.exe"
$packageServerExe = Join-Path $ScriptRoot "server\riverside-server.exe"
$packageDist = Join-Path $ScriptRoot "client-dist"
$packageMigrations = Join-Path $ScriptRoot "migrations"
$packageSeeds = Join-Path $ScriptRoot "seeds"
$packageReleaseDocs = Join-Path $ScriptRoot "docs"

$serverEnvironment = Ensure-ServerEnvironmentObject $config
$previousCubeRolePassword = Get-DotEnvValue (Join-Path $serverDir ".env") "RIVERSIDE_CUBE_REPORTING_DB_PASSWORD"
$script:cubeConfigModified = $false
$cubeRuntimeConfig = Ensure-CubeServerEnvironment $config $installRoot
if ($script:cubeConfigModified) {
  $configModified = $true
}
$configuredRuntimeBackupDir = "$($serverEnvironment.RIVERSIDE_BACKUP_DIR)".Trim()
if ([string]::IsNullOrWhiteSpace($configuredRuntimeBackupDir)) {
  Set-SafeProperty $serverEnvironment "RIVERSIDE_BACKUP_DIR" $backupDir
  $configModified = $true
  Write-Host "Configured the durable runtime backup directory at $backupDir." -ForegroundColor Green
}

foreach ($dir in @($installRoot, $serverDir, $clientDist, $releaseDir, $backupDir, $logDir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

$installRootConfigPath = Join-Path $installRoot "riverside-deployment.config.json"
$sourceConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
$canonicalConfigPath = [System.IO.Path]::GetFullPath($installRootConfigPath)
$configPathsDiffer = -not $sourceConfigPath.Equals(
  $canonicalConfigPath,
  [System.StringComparison]::OrdinalIgnoreCase
)
$canonicalConfigExisted = Test-Path $installRootConfigPath
$canonicalConfigOriginalBytes = if ($configPathsDiffer -and $canonicalConfigExisted) {
  [System.IO.File]::ReadAllBytes($installRootConfigPath)
} elseif (-not $configPathsDiffer) {
  $sourceConfigOriginalBytes
} else {
  $null
}
$canonicalConfigRollbackRequired = $false

# Lockdown C:\RiversideOS directory so only SYSTEM and Administrators have access
try {
  Write-Host "Locking down folder permissions for $installRoot..."
  $acl = Get-Acl $installRoot
  $acl.SetAccessRuleProtection($true, $false) # Remove inherited permissions
  $ruleSystem = New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
  $ruleAdmins = New-Object System.Security.AccessControl.FileSystemAccessRule("Administrators", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
  $acl.SetAccessRule($ruleSystem)
  $acl.SetAccessRule($ruleAdmins)
  Set-Acl $installRoot $acl
  Write-Host "Folder permissions locked down successfully." -ForegroundColor Green
} catch {
  Write-Warning "Could not lock down folder permissions on ${installRoot}: $($_.Exception.Message)"
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
if (-not (Test-Path (Join-Path $ScriptRoot "cube\node.exe"))) {
  throw "Missing non-Docker Cube Core runtime in package: $(Join-Path $ScriptRoot 'cube\node.exe')"
}

$taskName = "Riverside OS Server"
$cubeTaskName = "Riverside OS Cube Core"
$httpBind = $server.httpBind
if ([string]::IsNullOrWhiteSpace($httpBind)) { $httpBind = "0.0.0.0:3000" }
$serverPort = [int](($httpBind -split ":")[-1])
$rollbackDir = Join-Path $installRoot ".install-rollback"
$hadExistingTask = $null -ne (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
$hadExistingCubeTask = $null -ne (Get-ScheduledTask -TaskName $cubeTaskName -ErrorAction SilentlyContinue)
$hadExistingServerInstall = $hadExistingTask -or (Test-Path (Join-Path $serverDir "riverside-server.exe"))
$packageFlavor = if ($packageManifest) { "$($packageManifest.packageFlavor)".Trim() } else { "" }
$isOptimizedMainHubUpdate = $packageFlavor -eq "MainHub-Update"
if ($isOptimizedMainHubUpdate) {
  if (-not $hadExistingServerInstall) {
    throw "MainHub-Update packages require an existing Riverside Main Hub installation. Use the Windows Deployment package for first-time installation or recovery."
  }
  if ([int]$packageManifest.updateContractVersion -ne 1) {
    throw "MainHub-Update package contract '$($packageManifest.updateContractVersion)' is not supported by this installer. Use the matching Windows Deployment package."
  }
}

$installedPackageManifest = $null
$installedPackageManifestPath = Join-Path $releaseDir "deployment-package.manifest.json"
if ($isOptimizedMainHubUpdate -and (Test-Path $installedPackageManifestPath)) {
  try {
    $installedPackageManifest = Get-Content $installedPackageManifestPath -Raw | ConvertFrom-Json
  } catch {
    Write-Warning "Installed deployment manifest could not be read. Auxiliary Main Hub components will be reconciled conservatively."
  }
}
$updateRosieComponent = (-not $isOptimizedMainHubUpdate) -or
  (Test-DeploymentComponentChanged $packageManifest $installedPackageManifest "rosie")
$updateMeilisearchComponent = (-not $isOptimizedMainHubUpdate) -or
  (Test-DeploymentComponentChanged $packageManifest $installedPackageManifest "meilisearch")
$updateCubeComponent = (-not $isOptimizedMainHubUpdate) -or
  (Test-DeploymentComponentChanged $packageManifest $installedPackageManifest "cube")

if ($isOptimizedMainHubUpdate -and -not $updateRosieComponent) {
  $installedRosieModel = Get-DotEnvValue (Join-Path $serverDir ".env") "RIVERSIDE_LLAMA_MODEL_PATH"
  $hasRosieTask = $null -ne (Get-ScheduledTask -TaskName "Riverside OS LLM Host" -ErrorAction SilentlyContinue)
  if (-not $hasRosieTask -or [string]::IsNullOrWhiteSpace($installedRosieModel) -or -not (Test-Path $installedRosieModel)) {
    Write-Warning "ROSIE fingerprint matches, but its installed task or model is missing. The component will be reconciled."
    $updateRosieComponent = $true
  }
}
if ($isOptimizedMainHubUpdate -and -not $updateMeilisearchComponent) {
  $meilisearchUrl = Get-ServerEnvironmentValue $config @("RIVERSIDE_MEILISEARCH_URL")
  if ([string]::IsNullOrWhiteSpace($meilisearchUrl)) { $meilisearchUrl = "http://127.0.0.1:7700" }
  $hasMeilisearchTask = $null -ne (Get-ScheduledTask -TaskName "Riverside OS Meilisearch" -ErrorAction SilentlyContinue)
  $hasMeilisearchBinary = Test-Path (Join-Path $installRoot "meilisearch\meilisearch.exe")
  if (-not $hasMeilisearchTask -or -not $hasMeilisearchBinary -or
      -not (Test-DeploymentHttpReady "$($meilisearchUrl.TrimEnd('/'))/health")) {
    Write-Warning "Meilisearch fingerprint matches, but its installed runtime is not healthy. The component will be reconciled."
    $updateMeilisearchComponent = $true
  }
}
if ($isOptimizedMainHubUpdate -and -not $updateCubeComponent) {
  $cubeUrl = Get-ServerEnvironmentValue $config @("RIVERSIDE_CUBE_UPSTREAM")
  if ([string]::IsNullOrWhiteSpace($cubeUrl)) { $cubeUrl = "http://127.0.0.1:4000" }
  $hasCubeTask = $null -ne (Get-ScheduledTask -TaskName $cubeTaskName -ErrorAction SilentlyContinue)
  $hasCubeBinary = Test-Path (Join-Path $installRoot "cube\node.exe")
  if (-not $hasCubeTask -or -not $hasCubeBinary -or
      -not (Test-DeploymentHttpReady "$($cubeUrl.TrimEnd('/'))/readyz")) {
    Write-Warning "Cube Core fingerprint matches, but its installed runtime is not healthy. The component will be reconciled."
    $updateCubeComponent = $true
  }
}
$preserveRosieForOptimizedUpdate = $isOptimizedMainHubUpdate -and -not $updateRosieComponent
if ($isOptimizedMainHubUpdate) {
  Write-Host "Optimized Main Hub update component plan:" -ForegroundColor Cyan
  Write-Host "  ROSIE: $(if ($updateRosieComponent) { 'update and certify' } else { 'preserve exact installed component' })"
  Write-Host "  Meilisearch: $(if ($updateMeilisearchComponent) { 'update and verify' } else { 'preserve exact installed component' })"
  Write-Host "  Cube Core: $(if ($updateCubeComponent) { 'update and verify' } else { 'preserve exact installed component' })"
}
Remove-Item $rollbackDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $rollbackDir | Out-Null
if ($hadExistingTask) {
  Export-ScheduledTask -TaskName $taskName | Set-Content (Join-Path $rollbackDir "server-task.xml") -Encoding Unicode
}
if ($hadExistingCubeTask -and $updateCubeComponent) {
  Export-ScheduledTask -TaskName $cubeTaskName | Set-Content (Join-Path $rollbackDir "cube-task.xml") -Encoding Unicode
}
$rollbackEntries = @(
  @{ Source = $serverDir; Name = "server" },
  @{ Source = (Join-Path $installRoot "client"); Name = "client" },
  @{ Source = $releaseDir; Name = "release" }
)
if ($updateCubeComponent) {
  $rollbackEntries += @{ Source = (Join-Path $installRoot "cube"); Name = "cube" }
}
foreach ($entry in $rollbackEntries) {
  if (Test-Path $entry.Source) {
    Copy-Item $entry.Source (Join-Path $rollbackDir $entry.Name) -Recurse -Force
  }
}

$preMigrationBackupCreated = $false
$databaseRoleCredentialsUpdated = $false
$cubeRolePasswordUpdated = $false
$databaseUrlUser = [System.Uri]::EscapeDataString("$($db.appUser)")
$databaseUrlPassword = [System.Uri]::EscapeDataString("$($db.appPassword)")
$backupDatabaseUrlUser = [System.Uri]::EscapeDataString("$($db.adminUser)")
$backupDatabaseUrlPassword = [System.Uri]::EscapeDataString("$($db.adminPassword)")
$databaseUrlName = [System.Uri]::EscapeDataString("$($db.databaseName)")
$databaseUrl = "postgresql://${databaseUrlUser}:${databaseUrlPassword}@$($db.host):$($db.port)/${databaseUrlName}"
$backupDatabaseUrl = "postgresql://${backupDatabaseUrlUser}:${backupDatabaseUrlPassword}@$($db.host):$($db.port)/${databaseUrlName}"
if ($hadExistingServerInstall -and -not $SkipMigrations) {
  $preflightPsql = Resolve-PsqlPath $db
  if (-not (Test-PostgresReachable $db.host $db.port)) {
    throw "PostgreSQL is not reachable for the required pre-update backup. The running Riverside server has not been stopped or replaced."
  }
  New-PreMigrationBackup $preflightPsql $db $backupDir
  $preMigrationBackupCreated = $true
}

try {
$canonicalConfigRollbackRequired = $true
if ($configModified) {
  Write-DeploymentConfigJson $installRootConfigPath $config
  Write-DeploymentLog "Writing config to $installRootConfigPath"
  Write-Host "Persisted resolved deployment config to $installRootConfigPath." -ForegroundColor Green
} elseif ($configPathsDiffer) {
  Copy-Item -Path $sourceConfigPath -Destination $installRootConfigPath -Force
  Write-Host "Persisted deployment config to $installRootConfigPath." -ForegroundColor Green
}
$ConfigPath = $installRootConfigPath
Stop-RiversideServer $installedServerExe
Stop-PortListeners $serverPort

Copy-Item $packageServerExe $installedServerExe -Force
Remove-Item "$clientDist\*" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$packageDist\*" $clientDist -Recurse -Force
$expectedGitShort = if ($packageManifest) { $packageManifest.sourceGitShort } else { $null }
Confirm-InstalledClientVersion $clientDist $config.releaseVersion $expectedGitShort
Remove-Item "$releaseDir\migrations" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item $packageMigrations (Join-Path $releaseDir "migrations") -Recurse -Force
Remove-Item "$releaseDir\seeds" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item $packageSeeds (Join-Path $releaseDir "seeds") -Recurse -Force
if (Test-Path $packageReleaseDocs) {
  Remove-Item "$releaseDir\docs" -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item $packageReleaseDocs (Join-Path $releaseDir "docs") -Recurse -Force
}
if ($packageManifest) {
  Copy-Item $packageManifestPath (Join-Path $releaseDir "deployment-package.manifest.json") -Force
} elseif ([bool]$server.strictProduction) {
  throw "Strict production installation requires a verified deployment-package.manifest.json."
}

$psql = Resolve-PsqlPath $db
Ensure-PostgresServiceRunning

# If PostgreSQL was just installed by winget, the admin password may have been generated
# inside Ensure-PostgresServiceRunning. Re-resolve psql (PATH was refreshed) and persist config.
if ($script:configModifiedAfterPostgresInstall) {
  $configJson = $config | ConvertTo-Json -Depth 8
  Set-Content -Path $ConfigPath -Value $configJson -Encoding UTF8
  Write-Host "Saved PostgreSQL credentials to $ConfigPath." -ForegroundColor Green
  # Re-resolve psql now that PATH was updated by the winget install
  $psql = Resolve-PsqlPath $db
}

# Test if PostgreSQL is actually reachable before attempting DB operations
$script:postgresReachable = Test-PostgresReachable $db.host $db.port
if ($script:postgresReachable) {
  if (-not $SkipDatabaseCreate) {
    try {
      $appUser = Escape-SqlLiteral $db.appUser
      $appPassword = Escape-SqlLiteral $db.appPassword
      $databaseName = Escape-SqlLiteral $db.databaseName
      $roleSql = "DO `$`$ BEGIN " +
        "IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$appUser') THEN " +
        "CREATE ROLE ""$appUser"" LOGIN PASSWORD '$appPassword'; " +
        "ELSE ALTER ROLE ""$appUser"" LOGIN PASSWORD '$appPassword'; " +
        "END IF; END `$`$;"
      Invoke-PsqlAdmin $psql $db $roleSql
      $databaseRoleCredentialsUpdated = $true
      $env:PGPASSWORD = $db.adminPassword
      try {
        $exists = & $psql "postgresql://$($db.adminUser)@$($db.host):$($db.port)/postgres" -w -tAc "SELECT 1 FROM pg_database WHERE datname = '$databaseName';"
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
    } catch {
      throw "Database creation/setup failed: $($_.Exception.Message)"
    }
  }

  try {
    Assert-DatabaseUtf8 $psql $db $db.databaseName
  } catch {
    throw "Database UTF-8 check failed: $($_.Exception.Message)"
  }

  if (-not $SkipMigrations) {
    try {
      if (-not $preMigrationBackupCreated) {
        New-PreMigrationBackup $psql $db $backupDir
        $preMigrationBackupCreated = $true
      }
      $env:PGPASSWORD = $db.appPassword
      try {
        Repair-AverageCostAuditTableOwnership $psql $db
        Apply-Migrations $psql $databaseUrl (Join-Path $releaseDir "migrations") $db
        Apply-SeedFiles $psql $databaseUrl (Join-Path $releaseDir "seeds")
        Set-DatabaseEnvironmentMode $psql $databaseUrl (Resolve-ServerEnvironmentMode $config)
      } finally {
        Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
      }
    } catch {
      throw "Migrations/seeds failed: $($_.Exception.Message)"
    }
  }

  # Import encrypted integration credentials shipped with the deployment package.
  # Safe to commit to git because values are encrypted with RIVERSIDE_CREDENTIALS_KEY.
  $packageCredentialsPath = Join-Path $ScriptRoot "integration-credentials.sql"
  if (Test-Path $packageCredentialsPath) {
    try {
      Write-Host "Integration credentials file found in deployment package. Checking database..."
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptRoot "Import-IntegrationCredentials.ps1") -ConfigPath $ConfigPath -SqlPath $packageCredentialsPath 2>&1 | Write-Host
    } catch {
      Write-Warning "Integration credential import failed: $($_.Exception.Message). Continuing."
    }
  }

  try {
    $env:PGPASSWORD = $db.appPassword
    try {
      Ensure-BootstrapAdmin $psql $databaseUrl
      Write-Host "Bootstrap staff account verified; existing credentials and permissions were preserved."
    } finally {
      Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    }
  } catch {
    throw "Bootstrap admin setup failed: $($_.Exception.Message)"
  }

  try {
    Set-CubeRolePassword $psql $db $cubeRuntimeConfig.ReportingPassword
    $cubeRolePasswordUpdated = $true
  } catch {
    throw "Cube reporting-role setup failed: $($_.Exception.Message)"
  }
} else {
  throw "PostgreSQL is not reachable. No server files will be reported ready; fix PostgreSQL and rerun install-server.ps1."
}

# ROSIE AI stack - apply the release pins for normal installs and updates, or
# preserve the existing ROSIE environment only when explicitly requested.
# Runs before the .env is written so the model path can be included.
$envPath = Join-Path $serverDir ".env"
$rosieModelPath = $null
$preservedRosieEnvironment = $null
$supersededRosieAssets = @()
$rosieWatchdogTask = ""
$previousRosieEnvironment = Get-PreservedRosieEnvironment $envPath
if ($PreserveExistingRosie -or $preserveRosieForOptimizedUpdate) {
  $preservedRosieEnvironment = $previousRosieEnvironment
  $rosieModelPath = Resolve-InstalledRosieModelPath $installRoot $ScriptRoot $preservedRosieEnvironment
  if ($rosieModelPath) {
    $preservedRosieEnvironment["RIVERSIDE_LLAMA_MODEL_PATH"] = $rosieModelPath
    if (-not $preservedRosieEnvironment.ContainsKey("RIVERSIDE_LLAMA_HOST")) {
      $preservedRosieEnvironment["RIVERSIDE_LLAMA_HOST"] = "127.0.0.1"
    }
    if (-not $preservedRosieEnvironment.ContainsKey("RIVERSIDE_LLAMA_PORT")) {
      $preservedRosieEnvironment["RIVERSIDE_LLAMA_PORT"] = "8080"
    }
    if (-not $preservedRosieEnvironment.ContainsKey("RIVERSIDE_LLAMA_UPSTREAM")) {
      $preservedRosieEnvironment["RIVERSIDE_LLAMA_UPSTREAM"] = "http://127.0.0.1:8080"
    }
  }
  if ($preserveRosieForOptimizedUpdate) {
    Write-Host "ROSIE component fingerprint is unchanged. Preserving its files, environment, processes, and scheduled task."
  } else {
    Write-Host "ROSIE update preservation enabled. Existing ROSIE files, environment, processes, and scheduled task will not be changed."
  }
  if ($preservedRosieEnvironment.Count -eq 0) {
    Write-Warning "No existing ROSIE environment settings were found at $envPath. The Main Hub update will continue without downloading or replacing ROSIE assets."
  }
} elseif (-not $SkipRosieSetup) {
  Write-Host "`n--- ROSIE AI Stack Setup ---"
  $rosieModelPath = Install-RosieStack $ScriptRoot
  if ($rosieModelPath) {
    Write-Host "ROSIE model path: $rosieModelPath"
  } else {
    Write-Warning "ROSIE AI stack was not fully configured. ROSIE will show as unavailable until setup is completed manually. Re-run install-server.ps1 (or just Install-RosieStack) after connectivity is restored."
  }
} else {
  Write-Host "ROSIE setup skipped (-SkipRosieSetup). ROSIE will be unavailable until the model is installed."
}

$script:meilisearchConfigModified = $false
$script:legacyMeilisearchKeyRotated = $false
$script:previousMeilisearchApiKey = $null
if ($updateMeilisearchComponent) {
  Ensure-RiversideMeilisearchHost $ScriptRoot $installRoot $config (-not $NoStart)
} else {
  Write-Host "Meilisearch component fingerprint is unchanged. Preserving the running service and installed files."
}
if ($script:meilisearchConfigModified) {
  $configJson = $config | ConvertTo-Json -Depth 8
  Set-Content -Path $ConfigPath -Value $configJson -Encoding UTF8
  Write-Host "Saved Meilisearch runtime settings to $ConfigPath." -ForegroundColor Green
}

if ($updateCubeComponent) {
  Ensure-RiversideCubeHost $ScriptRoot $installRoot $config $db (-not $NoStart)
} else {
  Write-Host "Cube Core component fingerprint is unchanged. Preserving the running service and installed files."
}

Write-ServerEnv $envPath $config $databaseUrl $backupDatabaseUrl $clientDist $rosieModelPath $preservedRosieEnvironment
Set-MachineEnvironmentFromServerConfig $config
Ensure-CloudflaredRosIngress $config $serverPort

if (-not $SkipFirewall) {
  $fwName = $server.firewallRuleName
  if ([string]::IsNullOrWhiteSpace($fwName)) { $fwName = "Riverside OS Server" }
  Ensure-RiversideFirewallRule $fwName $serverPort
}

$serverExe = Join-Path $serverDir "riverside-server.exe"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute $serverExe -WorkingDirectory $serverDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

$llamaHost = "127.0.0.1"
$llamaPort = 8080
$llamaPerfProfile = "auto"
$llamaContextSize = 16384
$llamaParallel = 2
$llamaBatchSize = 512
$llamaUbatchSize = 512
if ($server.environment) {
  $envHost = "$($server.environment.RIVERSIDE_LLAMA_HOST)".Trim()
  $envPort = "$($server.environment.RIVERSIDE_LLAMA_PORT)".Trim()
  $envPerfProfile = "$($server.environment.RIVERSIDE_LLAMA_PERF_PROFILE)".Trim()
  $envContextSize = "$($server.environment.RIVERSIDE_LLAMA_CONTEXT_SIZE)".Trim()
  $envParallel = "$($server.environment.RIVERSIDE_LLAMA_PARALLEL)".Trim()
  $envBatchSize = "$($server.environment.RIVERSIDE_LLAMA_BATCH_SIZE)".Trim()
  $envUbatchSize = "$($server.environment.RIVERSIDE_LLAMA_UBATCH_SIZE)".Trim()
  if ($envHost) { $llamaHost = $envHost }
  if ($envPort -and ($envPort -match '^\d+$')) { $llamaPort = [int]$envPort }
  if ($envPerfProfile) { $llamaPerfProfile = $envPerfProfile }
  if ($envContextSize -match '^\d+$') { $llamaContextSize = [math]::Min(131072, [math]::Max(2048, [int]$envContextSize)) }
  if ($envParallel -match '^\d+$') { $llamaParallel = [math]::Min(8, [math]::Max(1, [int]$envParallel)) }
  if ($envBatchSize -match '^\d+$') { $llamaBatchSize = [math]::Min(2048, [math]::Max(32, [int]$envBatchSize)) }
  if ($envUbatchSize -match '^\d+$') { $llamaUbatchSize = [math]::Min($llamaBatchSize, [math]::Max(256, [int]$envUbatchSize)) }
}
if ($PreserveExistingRosie -or $preserveRosieForOptimizedUpdate) {
  Write-Host "ROSIE scheduled task preserved without restart or re-registration."
} else {
  Ensure-RiversideLlamaHost $ScriptRoot $installRoot $rosieModelPath $llamaHost $llamaPort $llamaPerfProfile $llamaContextSize $llamaParallel $llamaBatchSize $llamaUbatchSize
  $rosieWatchdogSource = Join-Path $ScriptRoot "watch-rosie-stack.ps1"
  if (Test-Path $rosieWatchdogSource) {
    $rosieWatchdogDest = Join-Path $installRoot "watch-rosie-stack.ps1"
    Copy-Item $rosieWatchdogSource $rosieWatchdogDest -Force
    $rosieWatchdogTask = "Riverside OS ROSIE Watchdog"
    Unregister-ScheduledTask -TaskName $rosieWatchdogTask -Confirm:$false -ErrorAction SilentlyContinue
    $rosieWatchdogAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$rosieWatchdogDest`" -InstallRoot `"$installRoot`""
    $rosieWatchdogStartup = New-ScheduledTaskTrigger -AtStartup
    $rosieWatchdogRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
    $rosieWatchdogPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
    $rosieWatchdogSettings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName $rosieWatchdogTask -Action $rosieWatchdogAction -Trigger @($rosieWatchdogStartup, $rosieWatchdogRepeat) -Principal $rosieWatchdogPrincipal -Settings $rosieWatchdogSettings | Out-Null
    if (-not $NoStart) {
      $rosieCandidateCertified = $true
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $rosieWatchdogDest -InstallRoot $installRoot -FullCertification -SkipSpeechCertification
      if ($LASTEXITCODE -ne 0) {
        $rosieCandidateCertified = $false
        if ($previousRosieEnvironment.Count -gt 0) {
          Write-Warning "ROSIE candidate certification failed. Restoring the previous ROSIE environment."
          Restore-RosieEnvironment $envPath $previousRosieEnvironment
          Stop-ScheduledTask -TaskName "Riverside OS LLM Host" -ErrorAction SilentlyContinue
          Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
          $rosieStartScript = Join-Path $installRoot "start-riverside-llama.ps1"
          if (Test-Path $rosieStartScript) {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $rosieStartScript -InstallRoot $installRoot | Out-Null
          }
        }
        Write-Warning "ROSIE functional certification failed. The Riverside OS update will continue while ROSIE reports degraded status and the watchdog retries. See $installRoot\rosie\rosie_status.json."
      }
      if ($rosieCandidateCertified) {
        $managedModelDir = Join-Path $installRoot "rosie\models\gemma-4-e4b"
        foreach ($key in @("RIVERSIDE_LLAMA_MODEL_PATH", "RIVERSIDE_LLAMA_MMPROJ_PATH")) {
          if (-not $previousRosieEnvironment.ContainsKey($key)) { continue }
          $oldAsset = "$($previousRosieEnvironment[$key])".Trim().Trim('"')
          if (
            $oldAsset -and
            (Test-Path $oldAsset) -and
            [IO.Path]::GetFullPath((Split-Path -Parent $oldAsset)).TrimEnd('\') -eq [IO.Path]::GetFullPath($managedModelDir).TrimEnd('\') -and
            $oldAsset -ne $rosieModelPath -and
            $oldAsset -ne (Join-Path $managedModelDir "gemma-4-E4B-it-mmproj.gguf")
          ) {
            Write-Host "Deferring cleanup of superseded certified ROSIE asset until the Main Hub update is fully ready: $(Split-Path -Leaf $oldAsset)"
            $supersededRosieAssets += $oldAsset
          }
        }
      }
    }
  }
}

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $taskName
  $localUrl = "http://127.0.0.1:$serverPort"
  Wait-RiversideApiReady $localUrl $serverPort
  Write-Host "Riverside OS server API responded at $localUrl"
  if (-not [string]::IsNullOrWhiteSpace($rosieWatchdogTask)) {
    Start-ScheduledTask -TaskName $rosieWatchdogTask
    Write-Host "ROSIE speech certification started in the background."
  }
}

$summary = "Riverside OS Server install complete.`n" +
  "Install root: $installRoot`n" +
  "Server task: $taskName`n" +
  "Cube task: $cubeTaskName (http://127.0.0.1:4000)`n" +
  "Frontend: $clientDist`n" +
  "Database: $($db.databaseName) on $($db.host):$($db.port)`n" +
  "Config: $envPath"
Set-Content -Path (Join-Path $installRoot "deployment-summary.txt") -Value $summary -Encoding UTF8
Write-Host $summary
Write-DeploymentStatus "READY" "Installation completed successfully"
foreach ($supersededAsset in @($supersededRosieAssets | Select-Object -Unique)) {
  try {
    if (Test-Path $supersededAsset) {
      Write-Host "Removing superseded certified ROSIE asset after successful Main Hub update: $(Split-Path -Leaf $supersededAsset)"
      Remove-Item $supersededAsset -Force -ErrorAction Stop
    }
  } catch {
    Write-Warning "Could not remove superseded ROSIE asset '$supersededAsset': $($_.Exception.Message)"
  }
}
Remove-Item $rollbackDir -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  $installFailure = $_
  Write-DeploymentStatus "FAILED" $installFailure.Exception.Message
  try {
    Stop-RiversideServer $installedServerExe
    if ($updateCubeComponent) {
      Stop-RiversideCubeHost $installRoot
    }
    $rollbackRestoreEntries = @(
      @{ Target = $serverDir; Name = "server" },
      @{ Target = (Join-Path $installRoot "client"); Name = "client" },
      @{ Target = $releaseDir; Name = "release" }
    )
    if ($updateCubeComponent) {
      $rollbackRestoreEntries += @{ Target = (Join-Path $installRoot "cube"); Name = "cube" }
    }
    foreach ($entry in $rollbackRestoreEntries) {
      $saved = Join-Path $rollbackDir $entry.Name
      if (Test-Path $saved) {
        Remove-Item $entry.Target -Recurse -Force -ErrorAction SilentlyContinue
        Copy-Item $saved $entry.Target -Recurse -Force
      } elseif ($entry.Name -eq "cube") {
        Remove-Item $entry.Target -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
    if ($databaseRoleCredentialsUpdated) {
      $restoredEnvPath = Join-Path $serverDir ".env"
      Set-ServerDatabaseUrl $restoredEnvPath $databaseUrl
      Write-Host "Restored server DATABASE_URL synchronized with the PostgreSQL app role." -ForegroundColor Yellow
    }
  } catch {
    Write-Warning "Rollback file restoration failed: $($_.Exception.Message)"
  }

  if ($canonicalConfigRollbackRequired) {
    try {
      if ($canonicalConfigExisted) {
        [System.IO.File]::WriteAllBytes($installRootConfigPath, $canonicalConfigOriginalBytes)
        if ($databaseRoleCredentialsUpdated) {
          Set-DeploymentConfigDatabaseAppPassword $installRootConfigPath "$($db.appPassword)"
          Write-Host "Restored deployment config synchronized with the PostgreSQL app role." -ForegroundColor Yellow
        }
        Write-Host "Restored the previous installed deployment config after the failed update." -ForegroundColor Yellow
      } elseif ($databaseRoleCredentialsUpdated) {
        Write-DeploymentConfigJson $installRootConfigPath $config
        Write-Host "Retained the failed initial install config because PostgreSQL app credentials were already applied." -ForegroundColor Yellow
      } else {
        Remove-Item $installRootConfigPath -Force -ErrorAction SilentlyContinue
        Write-Host "Removed the incomplete installed deployment config after the failed initial install." -ForegroundColor Yellow
      }
    } catch {
      Write-Warning "Rollback deployment config restoration failed: $($_.Exception.Message)"
    }
  }

  if ($cubeRolePasswordUpdated -and -not [string]::IsNullOrWhiteSpace($previousCubeRolePassword)) {
    try {
      Set-CubeRolePassword $psql $db $previousCubeRolePassword
      Write-Host "Restored the previous Cube reporting-role password after the failed update." -ForegroundColor Yellow
    } catch {
      Write-Warning "Could not restore the previous Cube reporting-role password: $($_.Exception.Message)"
    }
  }

  if ($script:legacyMeilisearchKeyRotated -and -not [string]::IsNullOrWhiteSpace($script:previousMeilisearchApiKey)) {
    try {
      $restoredEnvironment = Ensure-ServerEnvironmentObject $config
      Set-SafeProperty $restoredEnvironment "RIVERSIDE_MEILISEARCH_API_KEY" $script:previousMeilisearchApiKey
      Ensure-RiversideMeilisearchHost $ScriptRoot $installRoot $config $true $true
      Write-Host "Restored the previous Meilisearch service key after the failed update." -ForegroundColor Yellow
    } catch {
      Write-Warning "Could not restore the previous Meilisearch service key: $($_.Exception.Message)"
    }
  }

  try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    if ($hadExistingTask) {
      $savedTaskXml = Get-Content (Join-Path $rollbackDir "server-task.xml") -Raw
      Register-ScheduledTask -TaskName $taskName -Xml $savedTaskXml | Out-Null
    }
  } catch {
    Write-Warning "Rollback scheduled-task restoration failed: $($_.Exception.Message)"
  }

  if ($updateCubeComponent) {
    try {
      Unregister-ScheduledTask -TaskName $cubeTaskName -Confirm:$false -ErrorAction SilentlyContinue
      if ($hadExistingCubeTask) {
        $savedCubeTaskXml = Get-Content (Join-Path $rollbackDir "cube-task.xml") -Raw
        Register-ScheduledTask -TaskName $cubeTaskName -Xml $savedCubeTaskXml | Out-Null
      }
    } catch {
      Write-Warning "Rollback Cube scheduled-task restoration failed: $($_.Exception.Message)"
    }
  }

  if ($hadExistingTask) {
    try {
      Write-Host "Reclaiming Riverside port $serverPort before the rollback restart." -ForegroundColor Yellow
      Stop-PortListeners $serverPort
      Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
      Write-Host "Previous Riverside OS Server task restarted after the failed update." -ForegroundColor Yellow
    } catch {
      Write-Warning "Could not restart the previous Riverside OS Server task after rollback: $($_.Exception.Message)"
    }
  }
  if ($hadExistingCubeTask) {
    try {
      Start-ScheduledTask -TaskName $cubeTaskName -ErrorAction Stop
      Write-Host "Previous Cube Core task restarted after the failed update." -ForegroundColor Yellow
    } catch {
      Write-Warning "Could not restart the previous Cube Core task after rollback: $($_.Exception.Message)"
    }
  }
  throw $installFailure
}
