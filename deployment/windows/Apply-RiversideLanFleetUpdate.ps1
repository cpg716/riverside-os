[CmdletBinding()]
param(
  [string]$PackagePath = $PSScriptRoot,
  [string]$ConfigPath = "C:\RiversideOS\riverside-deployment.config.json",
  [string]$MainHubApiBase = "",
  [string]$TargetsJson = "",
  [string]$TargetsPath = "",
  [System.Management.Automation.PSCredential]$Credential,
  [string]$RemoteStagingRoot = "C:\ProgramData\RiversideOS\incoming",
  [switch]$SkipBackup,
  [switch]$SkipMigrations,
  [switch]$SkipRosieSetup,
  [switch]$NoStart,
  [switch]$SkipMainHubDesktop,
  [switch]$SkipWorkstations,
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = $null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })
  if (-not $isAdmin) {
    throw "Run this script from an elevated PowerShell window."
  }
}

function Assert-PackageShape([string]$Path) {
  foreach ($relative in @(
    "install-server.ps1",
    "install-register.ps1",
    "server\riverside-server.exe",
    "client-dist",
    "migrations",
    "register"
  )) {
    $candidate = Join-Path $Path $relative
    if (-not (Test-Path $candidate)) {
      throw "Package is missing required path: $candidate"
    }
  }
}

function Get-SafeConfigValue($Object, [string]$Name, [string]$DefaultValue) {
  if ($Object -and $Object.PSObject.Properties[$Name] -and $null -ne $Object.$Name -and "$($Object.$Name)" -ne "") {
    return "$($Object.$Name)"
  }
  return $DefaultValue
}

function Find-PostgresTool([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  $found = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter $Name -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if ($found) {
    return $found.FullName
  }
  throw "$Name was not found on the Main Hub."
}

function New-PreUpdateBackup([string]$ConfigPath) {
  $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
  $server = $config.server
  $db = $server.database
  if (-not $db) {
    throw "Config file is missing server.database; cannot create pre-update backup."
  }

  $installRoot = Get-SafeConfigValue $server "installRoot" "C:\RiversideOS"
  $backupDir = Join-Path $installRoot "backups"
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

  $pgDump = Find-PostgresTool "pg_dump.exe"
  $pgRestore = Find-PostgresTool "pg_restore.exe"
  $hostName = Get-SafeConfigValue $db "host" "127.0.0.1"
  $port = Get-SafeConfigValue $db "port" "5432"
  $databaseName = Get-SafeConfigValue $db "databaseName" "riverside_os"
  $user = Get-SafeConfigValue $db "adminUser" "postgres"
  $password = Get-SafeConfigValue $db "adminPassword" ""
  if ([string]::IsNullOrWhiteSpace($password)) {
    throw "PostgreSQL administrator password is missing from deployment config; refusing to use the limited Riverside app account for a full pre-update backup."
  }

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = Join-Path $backupDir "pre-lan-fleet-update-$stamp.dump"
  $env:PGPASSWORD = $password
  try {
    & $pgDump -h $hostName -p $port -U $user -d $databaseName -w -Fc -f $backupPath
    if ($LASTEXITCODE -ne 0) {
      throw "pg_dump failed with exit code $LASTEXITCODE."
    }

    $backupFile = Get-Item $backupPath -ErrorAction Stop
    if ($backupFile.Length -lt 1024) {
      throw "Pre-update backup was too small: $backupPath"
    }

    $archiveListing = @(& $pgRestore --list $backupPath)
    if ($LASTEXITCODE -ne 0 -or $archiveListing.Count -eq 0) {
      throw "Pre-update backup archive verification failed: $backupPath"
    }
  } catch {
    Remove-Item $backupPath -Force -ErrorAction SilentlyContinue
    throw
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
  return $backupPath
}

function Get-MainHubApiBase([string]$ConfigPath, [string]$Requested) {
  if (-not [string]::IsNullOrWhiteSpace($Requested)) {
    return $Requested.Trim().TrimEnd("/")
  }

  $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
  $httpBind = Get-SafeConfigValue $config.server "httpBind" "0.0.0.0:3000"
  $port = "3000"
  if ($httpBind -match ':(\d+)$') {
    $port = $Matches[1]
  }

  $ipv4 = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notmatch '^127\.' -and
      $_.IPAddress -notmatch '^169\.254\.' -and
      $_.PrefixOrigin -ne 'WellKnown'
    } |
    Sort-Object InterfaceMetric, InterfaceIndex |
    Select-Object -First 1 -ExpandProperty IPAddress

  if (-not $ipv4) {
    throw "Could not determine the Main Hub LAN IP. Pass -MainHubApiBase explicitly."
  }
  return "http://$ipv4`:$port"
}

function ConvertTo-TargetList([string]$Json, [string]$Path) {
  if (-not [string]::IsNullOrWhiteSpace($Path)) {
    if (-not (Test-Path $Path)) {
      throw "TargetsPath was not found: $Path"
    }
    $Json = Get-Content $Path -Raw
  }
  if ([string]::IsNullOrWhiteSpace($Json)) {
    return @()
  }
  $targets = $Json | ConvertFrom-Json
  if ($null -eq $targets) {
    return @()
  }
  if ($targets -is [System.Array]) {
    return @($targets)
  }
  return @($targets)
}

function New-RoleConfig(
  [string]$BaseConfigPath,
  [string]$OutputPath,
  [string]$ApiBase,
  [string]$StationMode,
  [string]$StationLabel
) {
  $config = Get-Content $BaseConfigPath -Raw | ConvertFrom-Json
  if (-not $config.register) {
    $config | Add-Member -NotePropertyName "register" -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  if ($config.register.PSObject.Properties["apiBase"]) {
    $config.register.apiBase = $ApiBase
  } else {
    $config.register | Add-Member -NotePropertyName "apiBase" -NotePropertyValue $ApiBase -Force
  }
  if ($config.register.PSObject.Properties["stationLabel"]) {
    $config.register.stationLabel = $StationLabel
  } else {
    $config.register | Add-Member -NotePropertyName "stationLabel" -NotePropertyValue $StationLabel -Force
  }
  $config | ConvertTo-Json -Depth 12 | Set-Content -Path $OutputPath -Encoding UTF8
  return $OutputPath
}

function Invoke-Installer([string]$ScriptPath, [string[]]$Args) {
  $installerArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath) + $Args
  & powershell.exe @installerArgs
  if ($LASTEXITCODE -ne 0) {
    throw "$ScriptPath failed with exit code $LASTEXITCODE."
  }
}

function Invoke-MainHubUpdate(
  [string]$PackagePath,
  [string]$ConfigPath,
  [string]$MainHubApiBase,
  [bool]$BackupRequired
) {
  if ($BackupRequired) {
    $backupPath = New-PreUpdateBackup $ConfigPath
    Write-Host "Pre-update backup created: $backupPath"
  } else {
    Write-Warning "Pre-update backup skipped by operator request."
  }

  $serverArgs = @("-ConfigPath", $ConfigPath, "-PreserveExistingRosie")
  if ($SkipMigrations) { $serverArgs += "-SkipMigrations" }
  if ($SkipRosieSetup) { Write-Warning "-SkipRosieSetup is retained for compatibility; update mode now preserves the installed ROSIE stack." }
  if ($NoStart) { $serverArgs += "-NoStart" }
  Invoke-Installer (Join-Path $PackagePath "install-server.ps1") $serverArgs

  if (-not $SkipMainHubDesktop) {
    $mainHubConfig = Join-Path $PackagePath "riverside-lan-mainhub.config.json"
    New-RoleConfig $ConfigPath $mainHubConfig "http://127.0.0.1:3000" "mainhub" "Main Hub" | Out-Null
    $desktopArgs = @("-ConfigPath", $mainHubConfig, "-StationMode", "mainhub")
    if ($NoLaunch) { $desktopArgs += "-NoLaunch" }
    Invoke-Installer (Join-Path $PackagePath "install-register.ps1") $desktopArgs
  }

  if (-not $NoStart) {
    $version = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/version" -UseBasicParsing -TimeoutSec 10
    Write-Host "Main Hub version response: $($version.Content)"
  }
}

function Copy-PackageToStation(
  [System.Management.Automation.Runspaces.PSSession]$Session,
  [string]$PackagePath,
  [string]$RemoteRoot
) {
  $deploymentId = Get-Date -Format "yyyyMMdd-HHmmss"
  $remotePackage = Invoke-Command -Session $Session -ScriptBlock {
    param($Root, $DeploymentId, $PackageName)
    $path = Join-Path $Root (Join-Path $DeploymentId $PackageName)
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    $path
  } -ArgumentList $RemoteRoot, $deploymentId, (Split-Path $PackagePath -Leaf)

  Copy-Item -Path (Join-Path $PackagePath "*") -Destination $remotePackage -Recurse -Force -ToSession $Session
  return $remotePackage
}

function Invoke-WorkstationUpdate(
  $Target,
  [string]$PackagePath,
  [string]$BaseConfigPath,
  [string]$MainHubApiBase
) {
  $hostName = "$($Target.host)".Trim()
  if ([string]::IsNullOrWhiteSpace($hostName)) {
    throw "Every LAN fleet target requires a host value."
  }

  $stationMode = "$($Target.stationMode)".Trim().ToLowerInvariant()
  if ($stationMode -notin @("register1", "backoffice")) {
    throw "Target $hostName has invalid stationMode '$stationMode'. Expected register1 or backoffice."
  }

  $stationLabel = "$($Target.stationLabel)".Trim()
  if ([string]::IsNullOrWhiteSpace($stationLabel)) {
    $stationLabel = if ($stationMode -eq "backoffice") { "Back Office" } else { "Register #1" }
  }

  Write-Host ""
  Write-Host "Updating $stationLabel at $hostName..."
  $sessionArgs = @{ ComputerName = $hostName }
  if ($Credential) {
    $sessionArgs.Credential = $Credential
  }
  $session = $null
  try {
    $session = New-PSSession @sessionArgs
    $remotePackage = Copy-PackageToStation $session $PackagePath $RemoteStagingRoot
    Invoke-Command -Session $session -ScriptBlock {
      param($RemotePackage, $BaseConfigJson, $ApiBase, $StationMode, $StationLabel, $NoLaunchRequested)
      $ErrorActionPreference = "Stop"
      $configPath = Join-Path $RemotePackage "riverside-lan-station.config.json"
      $config = $BaseConfigJson | ConvertFrom-Json
      if (-not $config.register) {
        $config | Add-Member -NotePropertyName "register" -NotePropertyValue ([pscustomobject]@{}) -Force
      }
      if ($config.register.PSObject.Properties["apiBase"]) {
        $config.register.apiBase = $ApiBase
      } else {
        $config.register | Add-Member -NotePropertyName "apiBase" -NotePropertyValue $ApiBase -Force
      }
      if ($config.register.PSObject.Properties["stationLabel"]) {
        $config.register.stationLabel = $StationLabel
      } else {
        $config.register | Add-Member -NotePropertyName "stationLabel" -NotePropertyValue $StationLabel -Force
      }
      $config | ConvertTo-Json -Depth 12 | Set-Content -Path $configPath -Encoding UTF8

      $installer = Join-Path $RemotePackage "install-register.ps1"
      $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $installer, "-ConfigPath", $configPath, "-StationMode", $StationMode)
      if ($NoLaunchRequested) { $args += "-NoLaunch" }
      & powershell.exe @args
      if ($LASTEXITCODE -ne 0) {
        throw "install-register.ps1 failed with exit code $LASTEXITCODE."
      }
    } -ArgumentList $remotePackage, (Get-Content $BaseConfigPath -Raw), $MainHubApiBase, $stationMode, $stationLabel, ([bool]$NoLaunch)
    Write-Host "$stationLabel update complete."
  } finally {
    if ($session) {
      Remove-PSSession $session
    }
  }
}

Assert-Admin
$PackagePath = (Resolve-Path $PackagePath).Path
Assert-PackageShape $PackagePath
if (-not (Test-Path $ConfigPath)) {
  throw "Main Hub deployment config was not found: $ConfigPath"
}

$manifestPath = Join-Path $PackagePath "deployment-package.manifest.json"
if (Test-Path $manifestPath) {
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  Write-Host "Package: $($manifest.packageName) / $($manifest.sourceGitSha)"
}

$resolvedMainHubApiBase = Get-MainHubApiBase $ConfigPath $MainHubApiBase
Write-Host "Main Hub API base for workstations/PWAs: $resolvedMainHubApiBase"

$targets = ConvertTo-TargetList $TargetsJson $TargetsPath
Invoke-MainHubUpdate $PackagePath $ConfigPath $resolvedMainHubApiBase (-not $SkipBackup)

if (-not $SkipWorkstations) {
  foreach ($target in $targets) {
    Invoke-WorkstationUpdate $target $PackagePath $ConfigPath $resolvedMainHubApiBase
  }
}

Write-Host ""
Write-Host "LAN fleet update complete."
