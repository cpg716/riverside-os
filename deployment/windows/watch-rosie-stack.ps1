[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [switch]$StatusOnly,
  [switch]$FullCertification
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

function Test-RosieLlmFunction([string]$BaseUrl) {
  $chatUrl = "$BaseUrl/v1/chat/completions"
  $headers = @{ "Content-Type" = "application/json" }
  $results = [ordered]@{
    ready = $false
    text_completion = $false
    streaming = $false
    native_tool_calling = $false
    multimodal = $false
    error = ""
  }
  try {
    $textBody = @{
      model = "local"
      stream = $false
      max_tokens = 24
      reasoning = $false
      chat_template_kwargs = @{ enable_thinking = $false }
      messages = @(@{ role = "user"; content = "Reply with exactly ROSIE_TEXT_OK" })
    } | ConvertTo-Json -Depth 8 -Compress
    $textResponse = Invoke-RestMethod -Uri $chatUrl -Method Post -Headers $headers -Body $textBody -TimeoutSec 60
    $textContent = "$($textResponse.choices[0].message.content)".Trim()
    $results.text_completion = $textContent -match 'ROSIE_TEXT_OK'

    $streamBody = @{
      model = "local"
      stream = $true
      stream_options = @{ include_usage = $true }
      max_tokens = 24
      reasoning = $false
      chat_template_kwargs = @{ enable_thinking = $false }
      messages = @(@{ role = "user"; content = "Reply with exactly ROSIE_STREAM_OK" })
    } | ConvertTo-Json -Depth 8 -Compress
    $streamResponse = Invoke-WebRequest -Uri $chatUrl -Method Post -Headers $headers -Body $streamBody -UseBasicParsing -TimeoutSec 60
    $streamText = ""
    $streamDone = $false
    foreach ($line in @($streamResponse.Content -split "`r?`n")) {
      if ($line -eq "data: [DONE]") {
        $streamDone = $true
      } elseif ($line.StartsWith("data: ")) {
        try {
          $chunk = $line.Substring(6) | ConvertFrom-Json
          $streamText += "$($chunk.choices[0].delta.content)"
        } catch {}
      }
    }
    $results.streaming = $streamText.Trim() -match 'ROSIE_STREAM_OK' -and $streamDone

    $toolBody = @{
      model = "local"
      stream = $false
      max_tokens = 128
      reasoning = $false
      chat_template_kwargs = @{ enable_thinking = $false }
      messages = @(
        @{ role = "system"; content = "Use the supplied tool for inventory questions." },
        @{ role = "user"; content = "Do we have navy suits in 40R?" }
      )
      tools = @(@{
        type = "function"
        function = @{
          name = "get_inventory_availability"
          description = "Search inventory availability"
          parameters = @{
            type = "object"
            properties = @{ query = @{ type = "string" } }
            required = @("query")
            additionalProperties = $false
          }
        }
      })
      tool_choice = "auto"
      parallel_tool_calls = $false
    } | ConvertTo-Json -Depth 12 -Compress
    $toolResponse = Invoke-RestMethod -Uri $chatUrl -Method Post -Headers $headers -Body $toolBody -TimeoutSec 60
    $results.native_tool_calling = "$($toolResponse.choices[0].message.tool_calls[0].function.name)" -eq "get_inventory_availability"

    # A tiny request-scoped PNG proves that llama-server loaded the matching
    # projector and accepted Gemma's OpenAI-compatible image input path.
    $imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII="
    $visionBody = @{
      model = "local"
      stream = $false
      max_tokens = 24
      reasoning = $false
      chat_template_kwargs = @{ enable_thinking = $false }
      messages = @(@{
        role = "user"
        content = @(
          @{ type = "text"; text = "After successfully inspecting this image, reply with exactly ROSIE_VISION_OK." },
          @{ type = "image_url"; image_url = @{ url = $imageDataUrl } }
        )
      })
    } | ConvertTo-Json -Depth 12 -Compress
    $visionResponse = Invoke-RestMethod -Uri $chatUrl -Method Post -Headers $headers -Body $visionBody -TimeoutSec 60
    $visionContent = "$($visionResponse.choices[0].message.content)".Trim()
    $results.multimodal = $visionContent -match 'ROSIE_VISION_OK'

    $results.ready = $results.text_completion -and $results.streaming -and $results.native_tool_calling -and $results.multimodal
    if (-not $results.ready) {
      $results.error = "One or more Gemma functional probes did not meet the certification contract."
    }
  } catch {
    $results.error = $_.Exception.Message
  }
  return [pscustomobject]$results
}

function Write-RosieStatus([string]$StatusPath, [object]$Status) {
  $Status | ConvertTo-Json -Depth 8 | Out-File -FilePath $StatusPath -Encoding utf8
}

function Invoke-BoundedProcess([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds) {
  $probeId = [guid]::NewGuid().ToString("N")
  $stdoutPath = Join-Path $env:TEMP "rosie-probe-$probeId.stdout.log"
  $stderrPath = Join-Path $env:TEMP "rosie-probe-$probeId.stderr.log"
  $startedAt = Get-Date
  try {
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -NoNewWindow -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try { $process.Kill() } catch {}
      return [pscustomobject]@{ success = $false; timed_out = $true; exit_code = $null; stdout = ""; stderr = "Timed out after $TimeoutSeconds seconds"; elapsed_ms = [int]((Get-Date) - $startedAt).TotalMilliseconds }
    }
    return [pscustomobject]@{
      success = $process.ExitCode -eq 0
      timed_out = $false
      exit_code = $process.ExitCode
      stdout = if (Test-Path $stdoutPath) { Get-Content $stdoutPath -Raw } else { "" }
      stderr = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw } else { "" }
      elapsed_ms = [int]((Get-Date) - $startedAt).TotalMilliseconds
    }
  } catch {
    return [pscustomobject]@{ success = $false; timed_out = $false; exit_code = $null; stdout = ""; stderr = $_.Exception.Message; elapsed_ms = [int]((Get-Date) - $startedAt).TotalMilliseconds }
  } finally {
    Remove-Item $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Test-RosieSpeechFunction([string]$AsrExe, [string]$TtsExe, [string]$SttModelDir, [string]$TtsModelDir) {
  $probeDir = Join-Path $env:TEMP "riverside-rosie-speech-$([guid]::NewGuid().ToString('N'))"
  $probeWav = Join-Path $probeDir "speech-check.wav"
  New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
  try {
    $ttsArgs = @(
      "--kokoro-model=`"$(Join-Path $TtsModelDir 'model.onnx')`"",
      "--kokoro-voices=`"$(Join-Path $TtsModelDir 'voices.bin')`"",
      "--kokoro-tokens=`"$(Join-Path $TtsModelDir 'tokens.txt')`"",
      "--kokoro-data-dir=`"$(Join-Path $TtsModelDir 'espeak-ng-data')`"",
      "--kokoro-lang=en-us",
      "--output-filename=`"$probeWav`"",
      "--sid=5",
      "--speed=1.0",
      "Riverside Rosie health check"
    )
    $ttsProbe = Invoke-BoundedProcess $TtsExe $ttsArgs 60
    $wavReady = $ttsProbe.success -and (Test-Path $probeWav) -and (Get-Item $probeWav).Length -gt 44
    if (-not $wavReady) {
      return [pscustomobject]@{ ready = $false; tts_ready = $false; stt_ready = $false; tts_elapsed_ms = $ttsProbe.elapsed_ms; stt_elapsed_ms = $null; transcript = ""; error = "Kokoro functional probe failed: $($ttsProbe.stderr)" }
    }

    $sttArgs = @(
      "--sense-voice-model=`"$(Join-Path $SttModelDir 'model.int8.onnx')`"",
      "--tokens=`"$(Join-Path $SttModelDir 'tokens.txt')`"",
      "--num-threads=2",
      "--decoding-method=greedy_search",
      "`"$probeWav`""
    )
    $sttProbe = Invoke-BoundedProcess $AsrExe $sttArgs 60
    $transcript = "$($sttProbe.stdout)".Trim()
    $recognized = $sttProbe.success -and $transcript -match '(?i)riverside|rosie|health|check'
    return [pscustomobject]@{
      ready = [bool]($wavReady -and $recognized)
      tts_ready = [bool]$wavReady
      stt_ready = [bool]$recognized
      tts_elapsed_ms = $ttsProbe.elapsed_ms
      stt_elapsed_ms = $sttProbe.elapsed_ms
      transcript = if ($recognized) { $transcript } else { "" }
      error = if ($recognized) { "" } else { "SenseVoice functional probe did not recognize the health-check fixture. $($sttProbe.stderr)" }
    }
  } finally {
    Remove-Item $probeDir -Recurse -Force -ErrorAction SilentlyContinue
  }
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
$modelCertificationPath = Join-Path $rosieRoot "gemma_model_certification.json"
$llamaVersionPath = Join-Path $rosieRoot "llama_version.txt"
$sherpaVersionPath = Join-Path $rosieRoot "sherpa_version.txt"
$llamaVersion = if (Test-Path $llamaVersionPath) { (Get-Content $llamaVersionPath -Raw).Trim() } else { "" }
$sherpaVersion = if (Test-Path $sherpaVersionPath) { (Get-Content $sherpaVersionPath -Raw).Trim() } else { "" }

$hostName = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_HOST"
$port = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_PORT"
$modelPath = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_MODEL_PATH"
$mmprojPath = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_MMPROJ_PATH"
if ([string]::IsNullOrWhiteSpace($hostName)) { $hostName = "127.0.0.1" }
if ([string]::IsNullOrWhiteSpace($port)) { $port = "8080" }
if ([string]::IsNullOrWhiteSpace($modelPath)) {
  $modelPath = Join-Path $rosieRoot "models\gemma-4-e4b\gemma-4-E4B_q4_0-it.gguf"
}
if ([string]::IsNullOrWhiteSpace($mmprojPath)) {
  $mmprojPath = Join-Path $rosieRoot "models\gemma-4-e4b\gemma-4-E4B-it-mmproj.gguf"
}

$llamaExe = Join-Path $binDir "llama-server.exe"
$asrExe = Join-Path $binDir "sherpa-onnx-offline.exe"
$ttsExe = Join-Path $binDir "sherpa-onnx-offline-tts.exe"
$sttModelDir = Join-Path $rosieRoot "stt\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
$ttsModelDir = Join-Path $rosieRoot "tts\kokoro-multi-lang-v1_1"
if (-not (Test-Path $ttsModelDir)) {
  $ttsModelDir = Join-Path $rosieRoot "tts\kokoro-multi-lang-v1_0"
}

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

$modelPresent = Test-Path $modelPath
$mmprojPresent = Test-Path $mmprojPath
$llmReady = $modelPresent -and $mmprojPresent
$binariesReady = $binariesMissing.Count -eq 0
$sttReady = $sttMissing.Count -eq 0
$ttsReady = $ttsMissing.Count -eq 0
$baseUrl = "http://${hostName}:${port}"
$llmHealthy = $false
$llmProbe = [pscustomobject]@{ ready = $false; text_completion = $false; streaming = $false; native_tool_calling = $false; multimodal = $false; error = "Gemma has not been functionally certified" }
$speechProbe = [pscustomobject]@{ ready = $false; tts_ready = $false; stt_ready = $false; tts_elapsed_ms = $null; stt_elapsed_ms = $null; transcript = ""; error = "Speech assets are incomplete" }

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
    for ($attempt = 1; $attempt -le 20 -and -not $llmHealthy; $attempt++) {
      Start-Sleep -Seconds 1
      $llmHealthy = Test-RosieHttpHealth $baseUrl
    }
  }
}

if ($llmHealthy -and $llmReady) {
  $modelFile = Get-Item $modelPath
  $mmprojFile = Get-Item $mmprojPath
  if ($FullCertification -and -not $StatusOnly) {
    $llmProbe = Test-RosieLlmFunction $baseUrl
    if ($llmProbe.ready) {
      [pscustomobject]@{
        ready = $true
        certified_at = (Get-Date).ToString("o")
        model_path = $modelFile.FullName
        model_length = $modelFile.Length
        model_last_write_utc = $modelFile.LastWriteTimeUtc.ToString("o")
        mmproj_path = $mmprojFile.FullName
        mmproj_length = $mmprojFile.Length
        mmproj_last_write_utc = $mmprojFile.LastWriteTimeUtc.ToString("o")
        probes = $llmProbe
      } | ConvertTo-Json -Depth 8 | Out-File -FilePath $modelCertificationPath -Encoding utf8
    } elseif (Test-Path $modelCertificationPath) {
      Remove-Item $modelCertificationPath -Force
    }
  } elseif (Test-Path $modelCertificationPath) {
    try {
      $certification = Get-Content $modelCertificationPath -Raw | ConvertFrom-Json
      $certificationMatches =
        $certification.ready -eq $true -and
        "$($certification.model_path)" -eq $modelFile.FullName -and
        [int64]$certification.model_length -eq $modelFile.Length -and
        "$($certification.model_last_write_utc)" -eq $modelFile.LastWriteTimeUtc.ToString("o") -and
        "$($certification.mmproj_path)" -eq $mmprojFile.FullName -and
        [int64]$certification.mmproj_length -eq $mmprojFile.Length -and
        "$($certification.mmproj_last_write_utc)" -eq $mmprojFile.LastWriteTimeUtc.ToString("o")
      if ($certificationMatches) {
        $llmProbe = [pscustomobject]@{
          ready = $true
          text_completion = [bool]$certification.probes.text_completion
          streaming = [bool]$certification.probes.streaming
          native_tool_calling = [bool]$certification.probes.native_tool_calling
          multimodal = [bool]$certification.probes.multimodal
          error = ""
        }
      }
    } catch {
      $llmProbe = [pscustomobject]@{ ready = $false; text_completion = $false; streaming = $false; native_tool_calling = $false; multimodal = $false; error = "Gemma certification record could not be read" }
    }
  }
}

if ($binariesReady -and $sttReady -and $ttsReady) {
  $speechProbe = Test-RosieSpeechFunction $asrExe $ttsExe $sttModelDir $ttsModelDir
}

$stackReady = $binariesReady -and $llmReady -and $llmHealthy -and $llmProbe.ready -and $speechProbe.ready
$status = [pscustomobject]@{
  ready = $stackReady
  generated_at = (Get-Date).ToString("o")
  watchdog = [pscustomobject]@{
    status_only = [bool]$StatusOnly
    llm_base_url = $baseUrl
    llm_http_healthy = $llmHealthy
    llm_functionally_certified = $llmProbe.ready
    speech_functional = $speechProbe.ready
  }
  components = [pscustomobject]@{
    binaries = [pscustomobject]@{
      ready = $binariesReady
      missing = $binariesMissing
      llama_version = $llamaVersion
      sherpa_version = $sherpaVersion
    }
    llm = [pscustomobject]@{
      ready = $llmReady -and $llmHealthy -and $llmProbe.ready
      model_path = $modelPath
      mmproj_path = $mmprojPath
      model_present = $modelPresent
      mmproj_present = $mmprojPresent
      http_healthy = $llmHealthy
      functional_probe = $llmProbe
    }
    stt = [pscustomobject]@{
      ready = $sttReady -and $speechProbe.stt_ready
      model_dir = $sttModelDir
      missing = $sttMissing
      functional_probe = [pscustomobject]@{
        ready = $speechProbe.stt_ready
        elapsed_ms = $speechProbe.stt_elapsed_ms
        transcript = $speechProbe.transcript
        error = $speechProbe.error
      }
    }
    tts = [pscustomobject]@{
      ready = $ttsReady -and $speechProbe.tts_ready
      model_dir = $ttsModelDir
      missing = $ttsMissing
      functional_probe = [pscustomobject]@{
        ready = $speechProbe.tts_ready
        elapsed_ms = $speechProbe.tts_elapsed_ms
        error = $speechProbe.error
      }
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
