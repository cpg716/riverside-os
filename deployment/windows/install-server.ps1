[CmdletBinding()]
param(
  [string]$ConfigPath = "",
  [switch]$SkipDatabaseCreate,
  [switch]$SkipMigrations,
  [switch]$SkipFirewall,
  [switch]$SkipRosieSetup,
  [switch]$NoStart,
  [switch]$SkipPostgresInstall
)

$ErrorActionPreference = "Stop"
$script:lastNativeCommandOutput = ""

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
  try {
    $packageManifest = Get-Content $packageManifestPath -Raw | ConvertFrom-Json
  } catch {}
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

$deploymentStatusPath = "C:\ProgramData\RiversideOS\deployment.status"
$deploymentLogPath = "C:\ProgramData\RiversideOS\deployment-manager.log"

function Write-DeploymentStatus([string]$Status, [string]$Message = "") {
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
      "Install PostgreSQL 18 manually from https://www.postgresql.org/download/windows/ " +
      "then rerun install-server.ps1.")
  }

  if ([string]::IsNullOrWhiteSpace($AdminPassword)) {
    # Generate a temporary password so the unattended installer doesn't fail
    $chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    $rng = New-Object System.Random
    $AdminPassword = -join (1..24 | ForEach-Object { $chars[$rng.Next(0, $chars.Length)] })
  }

  Write-Host "PostgreSQL 18 not found. Installing via winget (this may take several minutes)..." -ForegroundColor Yellow
  $override = "--mode unattended --unattendedmodeui minimal --superpassword `"$AdminPassword`" --serverport 5432"
  $output = & $winget.Source install -e --id PostgreSQL.PostgreSQL.18 --silent `
    --accept-package-agreements --accept-source-agreements --override $override 2>&1
  foreach ($line in $output) {
    if ($null -ne $line) { Write-Host $line }
  }
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL 18 winget install failed with exit code $LASTEXITCODE."
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
        "Install PostgreSQL 18 first, then rerun install-server.ps1.")
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
  $result = & $PsqlPath $DatabaseUrl -tAc -w $Sql
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
    $encoding = & $PsqlPath $adminUrl -tAc -w "SHOW server_encoding;"
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
  $sql = "INSERT INTO staff (full_name, cashier_code, pin_hash, role, is_active, avatar_key) " +
    "VALUES ('Chris G', '1234', '$bootstrapPinHash', 'admin', TRUE, 'ros_default') " +
    "ON CONFLICT (cashier_code) DO UPDATE SET " +
    "full_name = EXCLUDED.full_name, pin_hash = EXCLUDED.pin_hash, role = EXCLUDED.role, " +
    "is_active = TRUE, avatar_key = COALESCE(staff.avatar_key, EXCLUDED.avatar_key); " +
    "DO `$`$ BEGIN " +
    "IF NOT EXISTS (SELECT 1 FROM staff WHERE cashier_code = '1234' AND role = 'admin'::staff_role AND is_active = TRUE AND pin_hash IS NOT NULL) THEN " +
    "RAISE EXCEPTION 'Bootstrap admin was not created.'; END IF; END `$`$;"
  Invoke-Psql $PsqlPath $DatabaseUrl $sql
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

  if (-not $script:postgresReachable) {
    Write-Warning "Riverside OS Server API is not responding at $BaseUrl. This is expected because PostgreSQL was not reachable during install and the database was not set up."
    Write-Warning "To fix: resolve PostgreSQL (check the PostgreSQL log in its data/log directory, run initdb if the data directory is missing, or free port 5432), then rerun install-server.ps1."
    return
  }

  throw "Riverside OS Server did not pass the API check at $BaseUrl/api/staff/list-for-pos."
}

function Ensure-RiversideLlamaHost(
  [string]$PackageRoot,
  [string]$InstallRoot,
  [string]$ModelPath,
  [string]$LlamaHost,
  [int]$LlamaPort
) {
  $llamaSrc = Join-Path $PackageRoot "rosie\bin\llama-server.exe"
  if (-not (Test-Path $llamaSrc)) {
    Write-Warning ("ROSIE: llama-server.exe was not found in this deployment package ($llamaSrc). " +
      "ROSIE chat will stay unavailable until llama-server is running on http://${LlamaHost}:${LlamaPort}/. " +
      "Run Install-RosieAiStack.ps1 after copying a full deployment package, or start the Riverside desktop app on this PC (it can launch the sidecar).")
    return
  }

  if ([string]::IsNullOrWhiteSpace($ModelPath) -or -not (Test-Path $ModelPath)) {
    Write-Warning "ROSIE: LLM model is missing at '$ModelPath'. Skipping Riverside OS LLM Host scheduled task."
    return
  }

  $taskName = "Riverside OS LLM Host"
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2

  $llamaDir = Join-Path $InstallRoot "rosie\bin"
  New-Item -ItemType Directory -Force -Path $llamaDir | Out-Null
  Copy-Item "$PackageRoot\rosie\bin\*" $llamaDir -Force

  $llamaExe = Join-Path $llamaDir "llama-server.exe"
  $argument = "-m `"$ModelPath`" --host $LlamaHost --port $LlamaPort --reasoning off"

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

function Escape-SqlLiteral([string]$Value) {
  return $Value.Replace("'", "''")
}

function Write-ServerEnv($Path, $Config, $DatabaseUrl, $FrontendDist, $RosieModelPath) {
  $server = $Config.server
  $environmentMode = if ([bool]$server.strictProduction) { "production" } else { "development" }
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
    "DATABASE_URL=$DatabaseUrl",
    "FRONTEND_DIST=$FrontendDist",
    "RIVERSIDE_HTTP_BIND=$httpBind",
    "RIVERSIDE_MODE=$environmentMode",
    "RIVERSIDE_STRICT_PRODUCTION=$("$([bool]$server.strictProduction)".ToLowerInvariant())",
    "RIVERSIDE_CORS_ORIGINS=$(($corsOrigins -join ','))",
    "RIVERSIDE_STORE_CUSTOMER_JWT_SECRET=$($server.storeCustomerJwtSecret)",
    "RIVERSIDE_CREDENTIALS_KEY=$($server.storeCustomerJwtSecret)"
  )

  # ROSIE local LLM - write model path so the Axum proxy can derive RIVERSIDE_LLAMA_UPSTREAM
  # at startup. Port stays at the default 8080 unless overridden in config.server.environment.
  if ($RosieModelPath) {
    $lines += "RIVERSIDE_LLAMA_MODEL_PATH=$RosieModelPath"
    $lines += "RIVERSIDE_LLAMA_PORT=8080"
    $lines += "RIVERSIDE_LLAMA_HOST=127.0.0.1"
  }

  if ($server.environment) {
    foreach ($prop in $server.environment.PSObject.Properties) {
      if ($null -ne $prop.Value -and "$($prop.Value)" -ne "") {
        $lines += "$($prop.Name)=$($prop.Value)"
      }
    }
  }

  Set-Content -Path $Path -Value $lines -Encoding UTF8
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

  Write-Host "ROSIE: Delegating to $installerPath with -SkipEnvPatch..."
  try {
    # Call the installer script, passing the target install root and -SkipEnvPatch
    & $installerPath -ServerInstallRoot $installRoot -SkipEnvPatch
  } catch {
    Write-Warning "ROSIE: Install-RosieAiStack.ps1 execution failed: $_"
    return $null
  }

  # Verify the rosie_ready flag in C:\RiversideOS\rosie\rosie_ready to confirm deployment success
  $rosieRoot = Join-Path $installRoot "rosie"
  $readyFlag = Join-Path $rosieRoot "rosie_ready"
  if (-not (Test-Path $readyFlag)) {
    Write-Warning "ROSIE: rosie_ready flag file was not found at $readyFlag. ROSIE installation failed or was incomplete."
    return $null
  }

  # Resolve model destination using MODEL_PIN.json or release default
  $pinPath = Join-Path $PackageRoot "rosie\MODEL_PIN.json"
  $modelFilename = "google_gemma-4-E4B-it-Q4_K_M.gguf"
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
  # Machine-level environment variable writes removed for security hardening.
  # All secrets are loaded locally from the C:\RiversideOS\server\.env file.
}

function Get-MigrationSortKey($File) {
  if ($File.Name -match '^(\d+)([a-zA-Z]?)_') {
    return "{0:D6}-{1}-{2}" -f [int]$Matches[1], $Matches[2], $File.Name
  }
  return "999999--$($File.Name)"
}

function Get-MigrationLedgerExists($PsqlPath, $DatabaseUrl) {
  $ledgerCheck = & $PsqlPath $DatabaseUrl -tAc -w "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations');"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not check migration ledger."
  }
  return (($ledgerCheck -join "").Trim() -eq "t")
}

function Get-MigrationApplied($PsqlPath, $DatabaseUrl, [string]$Version) {
  $migrationVersion = Escape-SqlLiteral $Version
  $applied = & $PsqlPath $DatabaseUrl -tAc -w "SELECT EXISTS(SELECT 1 FROM ros_schema_migrations WHERE version = '$migrationVersion');"
  return (($applied -join "").Trim() -eq "t")
}

function Add-MigrationLedgerEntry($PsqlPath, $DatabaseUrl, [string]$Version) {
  $migrationVersion = Escape-SqlLiteral $Version
  Invoke-Psql $PsqlPath $DatabaseUrl "INSERT INTO ros_schema_migrations (version) SELECT '$migrationVersion' WHERE NOT EXISTS (SELECT 1 FROM ros_schema_migrations WHERE version = '$migrationVersion');"
}

function Test-CoreIdentityMigrationApplied($PsqlPath, $DatabaseUrl) {
  $result = & $PsqlPath $DatabaseUrl -tAc -w "SELECT to_regclass('public.store_settings') IS NOT NULL AND to_regclass('public.variant_sku_seq') IS NOT NULL;"
  return (($result -join "").Trim() -eq "t")
}

function Apply-Migrations($PsqlPath, $DatabaseUrl, $MigrationsDir) {
  Write-DeploymentStatus "MIGRATING" "Starting database migrations"
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
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $ScriptRoot "riverside-deployment.config.json"
}
if (-not (Test-Path $ConfigPath)) {
  throw "Config file not found: $ConfigPath. Copy riverside-deployment.config.example.json to riverside-deployment.config.json and fill it in."
}

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
  $random = New-Object System.Random
  $result = ""
  for ($i = 0; $i -lt $Length; $i++) {
    $result += $chars[$random.Next(0, $chars.Length)]
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
  if (-not $dbPort) { $dbPort = 5432 }
  if ([string]::IsNullOrWhiteSpace($dbUser)) { $dbUser = "postgres" }

  $psqlCmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  $psqlPath = if ($psqlCmd) { $psqlCmd.Source } else {
    $matches = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
    if ($matches) { $matches[0].FullName } else { "psql.exe" }
  }

  Write-Host "Verifying database connection details..."
  $tcpClient = New-Object System.Net.Sockets.TcpClient
  $connect = $tcpClient.BeginConnect($dbHost, $dbPort, $null, $null)
  $success = $connect.AsyncWaitHandle.WaitOne(1000, $false)
  if ($success) {
    $tcpClient.EndConnect($connect)
    $tcpClient.Close()

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
  }

if ($configModified) {
  $configJson = $config | ConvertTo-Json -Depth 8
  Set-Content -Path $ConfigPath -Value $configJson -Encoding UTF8
  Write-DeploymentLog "Writing config to $ConfigPath"
  Write-Host "Auto-saved resolved credentials and passwords to $ConfigPath." -ForegroundColor Green
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
$packageServerExe = Join-Path $ScriptRoot "server\riverside-server.exe"
$packageDist = Join-Path $ScriptRoot "client-dist"
$packageMigrations = Join-Path $ScriptRoot "migrations"
$packageSeeds = Join-Path $ScriptRoot "seeds"
$packageReleaseDocs = Join-Path $ScriptRoot "release-docs"

foreach ($dir in @($installRoot, $serverDir, $clientDist, $releaseDir, $backupDir, $logDir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

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

$taskName = "Riverside OS Server"
$httpBind = $server.httpBind
if ([string]::IsNullOrWhiteSpace($httpBind)) { $httpBind = "0.0.0.0:3000" }
$serverPort = [int](($httpBind -split ":")[-1])
Stop-RiversideServer
Stop-PortListeners $serverPort

Copy-Item $packageServerExe (Join-Path $serverDir "riverside-server.exe") -Force
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

$databaseUrl = "postgresql://$($db.appUser):$($db.appPassword)@$($db.host):$($db.port)/$($db.databaseName)"

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
      $env:PGPASSWORD = $db.adminPassword
      try {
        $exists = & $psql "postgresql://$($db.adminUser)@$($db.host):$($db.port)/postgres" -tAc -w "SELECT 1 FROM pg_database WHERE datname = '$databaseName';"
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
      Write-Warning "Database creation/setup failed: $($_.Exception.Message). Continuing with server installation."
    }
  }

  try {
    Assert-DatabaseUtf8 $psql $db $db.databaseName
  } catch {
    Write-Warning "Database UTF-8 check failed: $($_.Exception.Message). Continuing."
  }

  if (-not $SkipMigrations) {
    try {
      $env:PGPASSWORD = $db.appPassword
      try {
        Apply-Migrations $psql $databaseUrl (Join-Path $releaseDir "migrations")
        Apply-SeedFiles $psql $databaseUrl (Join-Path $releaseDir "seeds")
        Set-DatabaseEnvironmentMode $psql $databaseUrl ([bool]$server.strictProduction)
      } finally {
        Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
      }
    } catch {
      Write-Warning "Migrations/seeds failed: $($_.Exception.Message). Continuing with server installation."
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
      Write-Host "Bootstrap admin ready: Chris G / Access PIN 1234"
    } finally {
      Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    }
  } catch {
    Write-Warning "Bootstrap admin setup failed: $($_.Exception.Message). Continuing."
  }
} else {
  Write-Warning "PostgreSQL is not reachable. Skipping all database operations. Run install-server.ps1 again after fixing PostgreSQL."
}

# ROSIE AI stack - download model and set up voice tools.
# Runs before the .env is written so the model path can be included.
$rosieModelPath = $null
if (-not $SkipRosieSetup) {
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

$envPath = Join-Path $serverDir ".env"
Write-ServerEnv $envPath $config $databaseUrl $clientDist $rosieModelPath
Set-MachineEnvironmentFromServerConfig $config

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
if ($server.environment) {
  $envHost = "$($server.environment.RIVERSIDE_LLAMA_HOST)".Trim()
  $envPort = "$($server.environment.RIVERSIDE_LLAMA_PORT)".Trim()
  if ($envHost) { $llamaHost = $envHost }
  if ($envPort -and ($envPort -match '^\d+$')) { $llamaPort = [int]$envPort }
}
Ensure-RiversideLlamaHost $ScriptRoot $installRoot $rosieModelPath $llamaHost $llamaPort

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $taskName
  $localUrl = "http://127.0.0.1:$serverPort"
  Wait-RiversideApiReady $localUrl $serverPort
  Write-Host "Riverside OS server API responded at $localUrl"
}

$summary = "Riverside OS Server install complete.`n" +
  "Install root: $installRoot`n" +
  "Server task: $taskName`n" +
  "Frontend: $clientDist`n" +
  "Database: $($db.databaseName) on $($db.host):$($db.port)`n" +
  "Config: $envPath"
Set-Content -Path (Join-Path $installRoot "deployment-summary.txt") -Value $summary -Encoding UTF8
Write-Host $summary
Write-DeploymentStatus "READY" "Installation completed successfully"
