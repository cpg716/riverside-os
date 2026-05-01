[CmdletBinding()]
param(
  [string]$ConfigPath = "$PSScriptRoot\riverside-deployment.config.json",
  [switch]$SkipAppInstall,
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this installer from an elevated PowerShell window."
  }
}

function Find-RegisterInstaller {
  $registerDir = Join-Path $PSScriptRoot "register"
  if (-not (Test-Path $registerDir)) {
    throw "Missing register installer folder: $registerDir"
  }

  $msi = Get-ChildItem $registerDir -Recurse -Filter "*.msi" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($msi) {
    return $msi.FullName
  }

  $exe = Get-ChildItem $registerDir -Recurse -Filter "*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($exe) {
    return $exe.FullName
  }

  throw "No MSI or EXE installer found under $registerDir"
}

function Write-StationConfig($Config) {
  $programData = $env:PROGRAMDATA
  if (-not $programData) {
    $programData = "C:\ProgramData"
  }
  $dir = Join-Path $programData "RiversideOS"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  $stationConfig = [ordered]@{
    releaseVersion = $Config.releaseVersion
    register = $Config.register
  }
  $path = Join-Path $dir "station-config.json"
  $stationConfig | ConvertTo-Json -Depth 10 | Set-Content -Path $path -Encoding UTF8
  return $path
}

function Install-RegisterApp($InstallerPath) {
  $extension = [IO.Path]::GetExtension($InstallerPath).ToLowerInvariant()
  if ($extension -eq ".msi") {
    $args = @("/i", "`"$InstallerPath`"", "/qn", "/norestart")
    $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList $args -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
      throw "MSI install failed with exit code $($proc.ExitCode)"
    }
    return
  }

  $proc = Start-Process -FilePath $InstallerPath -ArgumentList "/S" -Wait -PassThru
  if ($proc.ExitCode -ne 0) {
    throw "Installer failed with exit code $($proc.ExitCode). Re-run without /S manually if this package uses an interactive installer."
  }
}

function Find-InstalledApp {
  $candidates = @(
    "$env:ProgramFiles\Riverside POS\Riverside POS.exe",
    "${env:ProgramFiles(x86)}\Riverside POS\Riverside POS.exe",
    "$env:LOCALAPPDATA\Programs\Riverside POS\Riverside POS.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }
  return $null
}

Assert-Admin
if (-not (Test-Path $ConfigPath)) {
  throw "Config file not found: $ConfigPath. Copy riverside-deployment.config.example.json to riverside-deployment.config.json and fill it in."
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$stationConfigPath = Write-StationConfig $config
Write-Host "Station setup written to $stationConfigPath"

if (-not $SkipAppInstall) {
  $installer = Find-RegisterInstaller
  Write-Host "Installing Riverside desktop app from $installer"
  Install-RegisterApp $installer
}

if (-not $NoLaunch) {
  $app = Find-InstalledApp
  if ($app) {
    Start-Process $app
  } else {
    Write-Warning "Could not find installed Riverside POS app to launch. Open it from Start after install."
  }
}

$summary = @"
Riverside OS Register install complete.
Station setup: $stationConfigPath
API base: $($config.register.apiBase)
Station label: $($config.register.stationLabel)
Receipt mode: $($config.register.receiptPrinter.mode)
"@
Set-Content -Path (Join-Path (Split-Path $stationConfigPath) "register-deployment-summary.txt") -Value $summary -Encoding UTF8
Write-Host $summary
