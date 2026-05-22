[CmdletBinding()]
param(
  [string]$ConfigPath = "",
  [switch]$SkipAppInstall,
  [switch]$NoLaunch
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

$packageManifestPath = Join-Path $ScriptRoot "deployment-package.manifest.json"
$packageManifest = $null
if (Test-Path $packageManifestPath) {
  try {
    $packageManifest = Get-Content $packageManifestPath -Raw | ConvertFrom-Json
  } catch {}
}

function Set-SafeProperty($Object, $Name, $Value) {
  if ($null -eq $Object) { return }
  if ($Object.PSObject.Properties[$Name]) {
    $Object.$Name = $Value
  } else {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
  }
}

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = $null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })
  if (-not $isAdmin) {
    throw "Run this installer from an elevated PowerShell window."
  }
}

function Find-RegisterInstaller {
  $registerDir = Join-Path $ScriptRoot "register"
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

function Normalize-ApiBase([string]$Value) {
  $url = "$Value".Trim()
  if (-not $url) {
    return ""
  }
  if ($url -notmatch "^https?://") {
    $url = "http://$url"
  }
  $hasExplicitPort = $url -match "^https?://[^/]+:\d+(/|$)"
  $uri = [Uri]$url
  $builder = [UriBuilder]::new($uri)
  if (-not $hasExplicitPort -and $builder.Scheme -eq "http") {
    $builder.Port = 3000
  }
  return $builder.Uri.AbsoluteUri.TrimEnd("/")
}

function Write-StationConfig($Config) {
  $apiBase = Normalize-ApiBase $Config.register.apiBase
  $stationLabel = "$($Config.register.stationLabel)".Trim()
  if ($stationLabel -ne "Backoffice / Server" -and $apiBase -match "^https?://(127\.0\.0\.1|localhost)(:|/|$)") {
    throw "$stationLabel cannot use $apiBase. Enter the Backoffice / Server PC address, for example http://10.64.70.196:3000."
  }
  $Config.register.apiBase = $apiBase

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

function Stop-RiversideDesktopApp {
  foreach ($name in @("Riverside POS", "Riverside.POS", "RiversideOS", "riverside-pos")) {
    Stop-Process -Name $name -Force -ErrorAction SilentlyContinue
  }
}

function Uninstall-ExistingRiversideApp {
  Stop-RiversideDesktopApp
  $registryPaths = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )

  $apps = foreach ($path in $registryPaths) {
    Get-ItemProperty $path -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -match "Riverside" -and ($_.DisplayName -match "POS|OS") }
  }

  foreach ($app in $apps) {
    Write-Host "Removing existing Riverside desktop app $($app.DisplayName) $($app.DisplayVersion)"
    if ($app.PSChildName -match "^\{.*\}$") {
      $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/x", $app.PSChildName, "/qn", "/norestart") -Wait -PassThru
      if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
        throw "Existing Riverside desktop uninstall failed with exit code $($proc.ExitCode)."
      }
    } elseif ($app.UninstallString) {
      $proc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $app.UninstallString) -Wait -PassThru
      if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
        throw "Existing Riverside desktop uninstall failed with exit code $($proc.ExitCode)."
      }
    }
  }
}

function Clear-RiversideClientCaches {
  $paths = @(
    (Join-Path $env:LOCALAPPDATA "Riverside POS"),
    (Join-Path $env:APPDATA "Riverside POS"),
    (Join-Path $env:LOCALAPPDATA "RiversideOS"),
    (Join-Path $env:APPDATA "RiversideOS"),
    (Join-Path $env:LOCALAPPDATA "com.riverside.pos"),
    (Join-Path $env:APPDATA "com.riverside.pos")
  )

  foreach ($path in $paths) {
    if ($path -and (Test-Path $path)) {
      Write-Host "Clearing Riverside client cache $path"
      Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Install-RegisterApp($InstallerPath) {
  $extension = [IO.Path]::GetExtension($InstallerPath).ToLowerInvariant()
  if ($extension -eq ".msi") {
    $args = @("/i", "`"$InstallerPath`"", "/qn", "/norestart")
    $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList $args -Wait -PassThru
    if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
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
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $ScriptRoot "riverside-deployment.config.json"
}
if (-not (Test-Path $ConfigPath)) {
  throw "Config file not found: $ConfigPath. Copy riverside-deployment.config.example.json to riverside-deployment.config.json and fill it in."
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json

if ($packageManifest -and $packageManifest.releaseVersion) {
  if ($config.releaseVersion -ne $packageManifest.releaseVersion) {
    Set-SafeProperty $config "releaseVersion" $packageManifest.releaseVersion
    $configJson = $config | ConvertTo-Json -Depth 8
    Set-Content -Path $ConfigPath -Value $configJson -Encoding UTF8
  }
}

$stationConfigPath = Write-StationConfig $config
Write-Host "Station setup written to $stationConfigPath"

if (-not $SkipAppInstall) {
  $installer = Find-RegisterInstaller
  Uninstall-ExistingRiversideApp
  Clear-RiversideClientCaches
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

$summary = "Riverside OS workstation install complete.`n" +
  "Station setup: $stationConfigPath`n" +
  "API base: $($config.register.apiBase)`n" +
  "Station label: $($config.register.stationLabel)`n" +
  "Receipt mode: $($config.register.receiptPrinter.mode)"
Set-Content -Path (Join-Path (Split-Path $stationConfigPath) "register-deployment-summary.txt") -Value $summary -Encoding UTF8
Write-Host $summary
