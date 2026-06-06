[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [switch]$StatusOnly
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

function Test-RosieHttpHealth([string]$BaseUrl) {
  try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/health" -UseBasicParsing -TimeoutSec 10
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Write-RosieStatus([string]$StatusPath, [object]$Status) {
  $Status | ConvertTo-Json -Depth 8 | Out-File -FilePath $StatusPath -Encoding utf8
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $configPath = Join-Path $ScriptRoot "riverside-deployment.config.json"
  if (Test-Path $configPath) {
    try {
      $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
      if ($cfg.server.installRoot) { $InstallRoot = $cfg.server.installRoot }
    } catch {}
  }
  if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = "C:\RiversideOS" }
}

$rosieRoot = Join-Path $InstallRoot "rosie"
$binDir = Join-Path $rosieRoot "bin"
$envPath = Join-Path $InstallRoot "server\.env"
$statusPath = Join-Path $rosieRoot "rosie_status.json"
$readyFlag = Join-Path $rosieRoot "rosie_ready"

$hostName = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_HOST"
$port = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_PORT"
$modelPath = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_MODEL_PATH"
if ([string]::IsNullOrWhiteSpace($hostName)) { $hostName = "127.0.0.1" }
if ([string]::IsNullOrWhiteSpace($port)) { $port = "8080" }
if ([string]::IsNullOrWhiteSpace($modelPath)) {
  $modelPath = Join-Path $rosieRoot "models\gemma-4-e4b\google_gemma-4-E4B-it-Q4_K_M.gguf"
}

$llamaExe = Join-Path $binDir "llama-server.exe"
$asrExe = Join-Path $binDir "sherpa-onnx-offline.exe"
$ttsExe = Join-Path $binDir "sherpa-onnx-offline-tts.exe"
$sttModelDir = Join-Path $rosieRoot "stt\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
$ttsModelDir = Join-Path $rosieRoot "tts\kokoro-multi-lang-v1_0"

$binariesMissing = @($llamaExe, $asrExe, $ttsExe) | Where-Object { -not (Test-Path $_) }
$sttMissing = @(
  (Join-Path $sttModelDir "model.int8.onnx"),
  (Join-Path $sttModelDir "tokens.txt")
) | Where-Object { -not (Test-Path $_) }
$ttsMissing = @(
  (Join-Path $ttsModelDir "model.onnx"),
  (Join-Path $ttsModelDir "voices.bin"),
  (Join-Path $ttsModelDir "tokens.txt"),
  (Join-Path $ttsModelDir "espeak-ng-data\phondata")
) | Where-Object { -not (Test-Path $_) }

$llmReady = Test-Path $modelPath
$binariesReady = $binariesMissing.Count -eq 0
$sttReady = $sttMissing.Count -eq 0
$ttsReady = $ttsMissing.Count -eq 0
$baseUrl = "http://${hostName}:${port}"
$llmHealthy = $false

if ($binariesReady -and $llmReady) {
  $llmHealthy = Test-RosieHttpHealth $baseUrl
  if (-not $llmHealthy -and -not $StatusOnly) {
    $taskName = "Riverside OS LLM Host"
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
      Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    } else {
      $startScript = Join-Path $ScriptRoot "start-riverside-llama.ps1"
      if (-not (Test-Path $startScript)) {
        $startScript = Join-Path $InstallRoot "start-riverside-llama.ps1"
      }
      if (Test-Path $startScript) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript -InstallRoot $InstallRoot | Out-Null
      }
    }
    Start-Sleep -Seconds 8
    $llmHealthy = Test-RosieHttpHealth $baseUrl
  }
}

$stackReady = $binariesReady -and $llmReady -and $sttReady -and $ttsReady -and $llmHealthy
$status = [pscustomobject]@{
  ready = $stackReady
  generated_at = (Get-Date).ToString("o")
  watchdog = [pscustomobject]@{
    status_only = [bool]$StatusOnly
    llm_base_url = $baseUrl
    llm_http_healthy = $llmHealthy
  }
  components = [pscustomobject]@{
    binaries = [pscustomobject]@{
      ready = $binariesReady
      missing = $binariesMissing
    }
    llm = [pscustomobject]@{
      ready = $llmReady -and $llmHealthy
      model_path = $modelPath
      model_present = $llmReady
      http_healthy = $llmHealthy
    }
    stt = [pscustomobject]@{
      ready = $sttReady
      model_dir = $sttModelDir
      missing = $sttMissing
    }
    tts = [pscustomobject]@{
      ready = $ttsReady
      model_dir = $ttsModelDir
      missing = $ttsMissing
    }
  }
}

New-Item -ItemType Directory -Force -Path $rosieRoot | Out-Null
Write-RosieStatus $statusPath $status

if ($stackReady) {
  "READY" | Out-File -FilePath $readyFlag -Encoding utf8
  Write-Host "ROSIE stack is healthy at $baseUrl."
} else {
  if (Test-Path $readyFlag) { Remove-Item $readyFlag -Force -ErrorAction SilentlyContinue }
  Write-Warning "ROSIE stack is not fully healthy. See $statusPath."
  exit 1
}
