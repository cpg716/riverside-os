[CmdletBinding()]
param(
  [string]$InstallRoot = "C:\RiversideOS",
  [string]$Token = ""
)

$ErrorActionPreference = "Stop"

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ($null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' }))
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
    $value = $line.Substring($idx + 1).Trim().Trim('"')
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

if (-not (Test-Admin)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "`"$PSCommandPath`"",
    "-InstallRoot",
    "`"$InstallRoot`"",
    "-Token",
    "`"$Token`""
  )
  exit
}

$cleanToken = $Token.Trim().Trim('"')
if (-not $cleanToken) {
  $cleanToken = (Read-Host "Paste the exact COUNTERPOINT_SYNC_TOKEN from C:\counterpoint-bridge\.env").Trim().Trim('"')
}
if (-not $cleanToken) {
  throw "COUNTERPOINT_SYNC_TOKEN cannot be blank."
}

$serverDir = Join-Path $InstallRoot "server"
$envPath = Join-Path $serverDir ".env"
if (-not (Test-Path $serverDir)) {
  throw "Riverside server folder was not found at $serverDir. Run Backoffice / Server install first."
}

$env = Read-EnvMap $envPath
$env["COUNTERPOINT_SYNC_TOKEN"] = $cleanToken
Write-EnvMap $envPath $env
[Environment]::SetEnvironmentVariable("COUNTERPOINT_SYNC_TOKEN", $cleanToken, "Machine")
Set-Item -Path "Env:\COUNTERPOINT_SYNC_TOKEN" -Value $cleanToken
Restart-RiversideServer

Write-Host ""
Write-Host "Counterpoint bridge token synced to Riverside Server."
Write-Host "Riverside server restarted."
Write-Host "Now close and restart the Counterpoint bridge."
