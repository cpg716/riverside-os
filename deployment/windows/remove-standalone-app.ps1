[CmdletBinding()]
param(
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

Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  Riverside OS Standalone App Removal" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""

if (-not $Force) {
  Write-Host "WARNING: This will uninstall the Riverside OS desktop app and remove station config." -ForegroundColor Red
  $confirm = Read-Host "Type REMOVE to confirm"
  if ($confirm -ne "REMOVE") {
    Write-Host "Aborted." -ForegroundColor Yellow
    exit 1
  }
}

# 1. Stop running client
Write-Host "[1/3] Stopping Riverside client..." -ForegroundColor Cyan
Get-Process -Name "riverside-client" -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  Write-Host "  Stopped riverside-client (PID $($_.Id))" -ForegroundColor Green
}

# 2. Uninstall MSI
Write-Host "[2/3] Uninstalling Riverside OS desktop app..." -ForegroundColor Cyan
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

# Also try msiexec directly if WMI didn't find it
$uninstallReg = Get-ChildItem "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
  Get-ItemProperty |
  Where-Object { $_.DisplayName -like "*Riverside*" }
if ($uninstallReg) {
  foreach ($entry in $uninstallReg) {
    if ($entry.UninstallString) {
      try {
        & cmd.exe /c $entry.UninstallString /quiet /norestart 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
        Write-Host "  Uninstalled via registry: $($entry.DisplayName)" -ForegroundColor Green
      } catch {
        Write-Warning "Registry uninstall failed: $($_.Exception.Message)"
      }
    }
  }
}

# 3. Remove station config
# install-register.ps1 writes: %PROGRAMDATA%\RiversideOS\station-config.json
Write-Host "[3/3] Removing station configuration..." -ForegroundColor Cyan
$stationConfigFile = Join-Path $env:PROGRAMDATA "RiversideOS\station-config.json"
if (Test-Path $stationConfigFile) {
  Remove-Item $stationConfigFile -Force -ErrorAction SilentlyContinue
  Write-Host "  Removed: $stationConfigFile" -ForegroundColor Green
}
$stationConfigDir = Join-Path $env:PROGRAMDATA "RiversideOS"
if ((Test-Path $stationConfigDir) -and -not (Get-ChildItem $stationConfigDir -ErrorAction SilentlyContinue)) {
  Remove-Item $stationConfigDir -Force -ErrorAction SilentlyContinue
  Write-Host "  Removed empty dir: $stationConfigDir" -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Riverside OS Standalone App removed." -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
