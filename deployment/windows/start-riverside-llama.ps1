[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [switch]$NoStart
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

function Read-ServerEnvValue([string]$EnvPath, [string]$Key) {
  if (-not (Test-Path $EnvPath)) { return "" }
  foreach ($line in Get-Content $EnvPath) {
    if ($line -match "^\s*$([regex]::Escape($Key))=(.*)$") {
      return $Matches[1].Trim().Trim('"')
    }
  }
  return ""
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $configPath = Join-Path $ScriptRoot "riverside-deployment.config.json"
  if (Test-Path $configPath) {
    $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($cfg.server.installRoot) { $InstallRoot = $cfg.server.installRoot }
  }
  if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = "C:\RiversideOS" }
}

$envPath = Join-Path $InstallRoot "server\.env"
$modelPath = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_MODEL_PATH"
$hostName = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_HOST"
$port = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_PORT"
if ([string]::IsNullOrWhiteSpace($hostName)) { $hostName = "127.0.0.1" }
if ([string]::IsNullOrWhiteSpace($port)) { $port = "8080" }

$llamaExe = Join-Path $InstallRoot "rosie\bin\llama-server.exe"
if (-not (Test-Path $llamaExe)) {
  $packageLlama = Join-Path $ScriptRoot "rosie\bin\llama-server.exe"
  if (Test-Path $packageLlama) {
    $binDir = Join-Path $InstallRoot "rosie\bin"
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    Copy-Item "$ScriptRoot\rosie\bin\*" $binDir -Force
    $llamaExe = Join-Path $binDir "llama-server.exe"
  }
}

if (-not (Test-Path $llamaExe)) {
  throw "llama-server.exe was not found under $InstallRoot\rosie\bin. Re-run install-server.ps1 from a full v0.70.1+ deployment package."
}

if ([string]::IsNullOrWhiteSpace($modelPath) -or -not (Test-Path $modelPath)) {
  throw "RIVERSIDE_LLAMA_MODEL_PATH is missing or the GGUF file does not exist. Run Install-RosieAiStack.ps1 or complete server install with ROSIE setup."
}

$taskName = "Riverside OS LLM Host"
$argument = "-m `"$modelPath`" --host $hostName --port $port --reasoning off"
$llamaDir = Split-Path -Parent $llamaExe

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute $llamaExe -Argument $argument -WorkingDirectory $llamaDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

if (-not $NoStart) {
  Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName $taskName
  Write-Host "Started $taskName -> http://${hostName}:${port}/"
}
