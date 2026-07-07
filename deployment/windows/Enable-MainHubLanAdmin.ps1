[CmdletBinding()]
param(
  [switch]$MacClientCompatibility,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = $null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })
  if (-not $isAdmin) {
    throw "Run this script from an elevated PowerShell window on the Main Hub."
  }
}

function Get-PrimaryIpv4Address {
  $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
    Sort-Object InterfaceMetric |
    Select-Object -First 1

  if ($ip) {
    return $ip.IPAddress
  }
  return ""
}

Assert-Admin

Write-Host "Enabling Riverside OS LAN admin channel for Main Hub updates..."

Set-Service -Name WinRM -StartupType Automatic
Enable-PSRemoting -Force:$Force -SkipNetworkProfileCheck

if ($MacClientCompatibility) {
  Write-Warning "Enabling WinRM Basic auth and AllowUnencrypted for private-LAN macOS PowerShell compatibility."
  Set-Item -Path WSMan:\localhost\Service\Auth\Basic -Value $true
  Set-Item -Path WSMan:\localhost\Service\AllowUnencrypted -Value $true
} else {
  try {
    Set-Item -Path WSMan:\localhost\Service\Auth\Basic -Value $false
  } catch {
    Write-Warning "Could not disable WinRM Basic auth: $($_.Exception.Message)"
  }

  try {
    Set-Item -Path WSMan:\localhost\Service\AllowUnencrypted -Value $false
  } catch {
    Write-Warning "Could not require encrypted WinRM transport: $($_.Exception.Message)"
  }
}

if (-not (Get-NetFirewallRule -DisplayName "Riverside OS Main Hub WinRM" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule `
    -DisplayName "Riverside OS Main Hub WinRM" `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 5985 `
    -Profile Private `
    | Out-Null
}

$ip = Get-PrimaryIpv4Address
Write-Host ""
Write-Host "LAN admin channel is ready."
if ($ip) {
  Write-Host "From the repo Mac, test with:"
  Write-Host "  npm run push:main-hub:fast -- -MainHubHost `"$ip`" -Authentication Basic -DryRun"
} else {
  Write-Host "From the repo Mac, test with:"
  Write-Host "  npm run push:main-hub:fast -- -MainHubHost `"<MAIN_HUB_IP_OR_NAME>`" -Authentication Basic -DryRun"
}
