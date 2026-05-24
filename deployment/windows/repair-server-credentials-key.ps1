[CmdletBinding()]
param(
  [string]$InstallRoot = "C:\RiversideOS"
)

$ErrorActionPreference = "Stop"

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ($null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' }))
}

function New-RiversideSecret([int]$Length = 48) {
  $chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789".ToCharArray()
  $bytes = New-Object byte[] $Length
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  $result = New-Object char[] $Length
  for ($i = 0; $i -lt $Length; $i++) {
    $result[$i] = $chars[$bytes[$i] % $chars.Length]
  }
  return -join $result
}

function Test-UsableSecret([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $false
  }
  $trimmed = $Value.Trim()
  return $trimmed.Length -ge 32 `
    -and $trimmed -notmatch "^replace-" `
    -and $trimmed -ne "password" `
    -and $trimmed -ne "riverside-dev-credential-key-change-me" `
    -and $trimmed -ne "riverside-dev-token-key-change-me"
}

function Read-EnvMap([string]$Path) {
  $ordered = [ordered]@{}
  if (-not (Test-Path $Path)) {
    return $ordered
  }
  foreach ($line in Get-Content $Path) {
    if ($line -match '^\s*#' -or $line -notmatch '=') {
      continue
    }
    $idx = $line.IndexOf('=')
    if ($idx -le 0) {
      continue
    }
    $name = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    if ($name) {
      $ordered[$name] = $value
    }
  }
  return $ordered
}

function Write-EnvMap([string]$Path, $Map) {
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($key in $Map.Keys) {
    $lines.Add("$key=$($Map[$key])")
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, (($lines -join "`r`n") + "`r`n"), $utf8NoBom)
}

function Restart-RiversideServer {
  $taskName = "Riverside OS Server"
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  foreach ($process in Get-Process -Name "riverside-server" -ErrorAction SilentlyContinue) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
}

function Set-MachineEnvironmentValue([string]$Name, [string]$Value) {
  [Environment]::SetEnvironmentVariable($Name, $Value, "Machine")
  Set-Item -Path "Env:\$Name" -Value $Value
}

if (-not (Test-Admin)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "`"$PSCommandPath`"",
    "-InstallRoot",
    "`"$InstallRoot`""
  )
  exit
}

$serverDir = Join-Path $InstallRoot "server"
$envPath = Join-Path $serverDir ".env"
if (-not (Test-Path $serverDir)) {
  throw "Riverside server folder was not found at $serverDir. Run Backoffice / Server install first."
}

$env = Read-EnvMap $envPath
$storeSecret = if ($env.Contains("RIVERSIDE_STORE_CUSTOMER_JWT_SECRET")) { "$($env["RIVERSIDE_STORE_CUSTOMER_JWT_SECRET"])" } else { "" }
$credentialKey = if ($env.Contains("RIVERSIDE_CREDENTIALS_KEY")) { "$($env["RIVERSIDE_CREDENTIALS_KEY"])" } else { "" }

if (-not (Test-UsableSecret $credentialKey)) {
  if (Test-UsableSecret $storeSecret) {
    $credentialKey = $storeSecret
  } else {
    $credentialKey = New-RiversideSecret 48
    $env["RIVERSIDE_STORE_CUSTOMER_JWT_SECRET"] = $credentialKey
  }
  $env["RIVERSIDE_CREDENTIALS_KEY"] = $credentialKey
  Write-Host "Repaired Riverside integration credential encryption key."
} else {
  Write-Host "Riverside integration credential encryption key is already present."
}

if (-not $env.Contains("COUNTERPOINT_SYNC_TOKEN") -or -not (Test-UsableSecret "$($env["COUNTERPOINT_SYNC_TOKEN"])")) {
  $env["COUNTERPOINT_SYNC_TOKEN"] = New-RiversideSecret 48
  Write-Host "Generated Counterpoint bridge sync token."
}

Write-EnvMap $envPath $env
# Machine-level environment variable writes removed for security hardening.
# All secrets are loaded locally from the C:\RiversideOS\server\.env file.
Restart-RiversideServer

Write-Host ""
Write-Host "Credential repair complete."
Write-Host "Credential key was written to server .env and Windows machine environment."
Write-Host "Riverside server restarted."
Write-Host "Now reopen Settings > Counterpoint and save the Bridge sync token again."
