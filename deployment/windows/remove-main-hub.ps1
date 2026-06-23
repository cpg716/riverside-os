[CmdletBinding()]
param(
  [switch]$KeepDatabase,
  [switch]$KeepInstallRoot,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = $null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })
  if (-not $isAdmin) {
    throw "Run this script from an elevated PowerShell window."
  }
}

Assert-Admin

# Resolve install root from config.
# Check the canonical location first ({installRoot}\riverside-deployment.config.json),
# then fall back to the next to the script itself (for removal from the deployment package).
$installRoot = "C:\RiversideOS"
$configPath  = Join-Path $installRoot "riverside-deployment.config.json"
if (-not (Test-Path $configPath)) {
  # Also try next to the script (e.g. running from the deployment package directory)
  $scriptSidePath = Join-Path $PSScriptRoot "riverside-deployment.config.json"
  if (Test-Path $scriptSidePath) { $configPath = $scriptSidePath }
}
if (Test-Path $configPath) {
  try {
    $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($cfg.server -and $cfg.server.installRoot) { $installRoot = $cfg.server.installRoot }
  } catch {}
}

Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  Riverside OS Main Hub Removal" -ForegroundColor Yellow
Write-Host "  Install root: $installRoot" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""

if (-not $Force) {
  Write-Host "WARNING: This will remove the Riverside OS Server, scheduled tasks, and client app." -ForegroundColor Red
  if (-not $KeepDatabase) {
    Write-Host "WARNING: The PostgreSQL database 'riverside_os' will be DROPPED." -ForegroundColor Red
  }
  $confirm = Read-Host "Type REMOVE to confirm"
  if ($confirm -ne "REMOVE") {
    Write-Host "Aborted." -ForegroundColor Yellow
    exit 1
  }
}

# 1. Stop server process and scheduled tasks
Write-Host "[1/6] Stopping Riverside OS services..." -ForegroundColor Cyan
$tasks = @("Riverside OS Server", "Riverside OS LLM Host", "Riverside OS Meilisearch")
foreach ($taskName in $tasks) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    try {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
      Write-Host "  Removed scheduled task: $taskName" -ForegroundColor Green
    } catch {
      Write-Warning "Could not remove task '$taskName': $($_.Exception.Message)"
    }
  }
}

Get-Process -Name "riverside-server" -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  Write-Host "  Stopped process: riverside-server (PID $($_.Id))" -ForegroundColor Green
}

Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  Write-Host "  Stopped process: llama-server (PID $($_.Id))" -ForegroundColor Green
}

Get-Process -Name "meilisearch" -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  Write-Host "  Stopped process: meilisearch (PID $($_.Id))" -ForegroundColor Green
}

# 2. Uninstall desktop app MSI
Write-Host "[2/6] Uninstalling desktop app..." -ForegroundColor Cyan
$existing = Get-WmiObject -Class Win32_Product -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "*Riverside*" }
if ($existing) {
  foreach ($msi in $existing) {
    try {
      $msi.Uninstall() | Out-Null
      Write-Host "  Uninstalled: $($msi.Name)" -ForegroundColor Green
    } catch {
      Write-Warning "Could not uninstall '$($msi.Name)': $($_.Exception.Message)"
    }
  }
} else {
  Write-Host "  No Riverside MSI found in WMI." -ForegroundColor Gray
}

# 3. Remove firewall rules
Write-Host "[3/6] Removing firewall rules..." -ForegroundColor Cyan
$rules = @("Riverside OS Server", "Riverside OS API", "Riverside OS LLM Host", "Riverside OS Meilisearch")
foreach ($ruleName in $rules) {
  Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  Write-Host "  Removed firewall rule: $ruleName" -ForegroundColor Green
}

# 4. Drop database (unless --KeepDatabase)
if (-not $KeepDatabase) {
  Write-Host "[4/6] Dropping PostgreSQL database 'riverside_os'..." -ForegroundColor Cyan
  $psql = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($psql) {
    $pgPath = $psql.Source
    try {
      $env:PGPASSWORD = if ($cfg -and $cfg.server -and $cfg.server.database -and $cfg.server.database.adminPassword) { $cfg.server.database.adminPassword } else { "postgres" }
      & $pgPath -U postgres -w -c "DROP DATABASE IF EXISTS riverside_os;" 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
      Write-Host "  Database dropped." -ForegroundColor Green
    } catch {
      Write-Warning "Could not drop database: $($_.Exception.Message)"
    } finally {
      Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    }
  } else {
    Write-Warning "psql.exe not found. Skipping database drop."
  }
} else {
  Write-Host "[4/6] Skipping database drop (--KeepDatabase)." -ForegroundColor Gray
}

# 5. Remove station config
# install-register.ps1 writes: %PROGRAMDATA%\RiversideOS\station-config.json
Write-Host "[5/6] Removing station configuration..." -ForegroundColor Cyan
$stationConfigFile = Join-Path $env:PROGRAMDATA "RiversideOS\station-config.json"
if (Test-Path $stationConfigFile) {
  Remove-Item $stationConfigFile -Force -ErrorAction SilentlyContinue
  Write-Host "  Removed: $stationConfigFile" -ForegroundColor Green
}
# Also clean the parent dir if empty
$stationConfigDir = Join-Path $env:PROGRAMDATA "RiversideOS"
if ((Test-Path $stationConfigDir) -and -not (Get-ChildItem $stationConfigDir -ErrorAction SilentlyContinue)) {
  Remove-Item $stationConfigDir -Force -ErrorAction SilentlyContinue
  Write-Host "  Removed empty dir: $stationConfigDir" -ForegroundColor Green
}

# 6. Remove install root (unless --KeepInstallRoot)
if (-not $KeepInstallRoot) {
  Write-Host "[6/6] Removing install directory $installRoot..." -ForegroundColor Cyan
  if (Test-Path $installRoot) {
    Remove-Item $installRoot -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  Removed: $installRoot" -ForegroundColor Green
  }
  # Also remove config file
  if (Test-Path $configPath) {
    Remove-Item $configPath -Force -ErrorAction SilentlyContinue
    Write-Host "  Removed: $configPath" -ForegroundColor Green
  }
} else {
  Write-Host "[6/6] Skipping install directory removal (--KeepInstallRoot)." -ForegroundColor Gray
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Riverside OS Main Hub removed." -ForegroundColor Green
if ($KeepDatabase) { Write-Host "  Database preserved (--KeepDatabase)." -ForegroundColor Yellow }
if ($KeepInstallRoot) { Write-Host "  Install root preserved (--KeepInstallRoot)." -ForegroundColor Yellow }
Write-Host "========================================" -ForegroundColor Green
