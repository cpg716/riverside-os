# ============================================================
# Riverside OS - ROSIE AI Stack Installer
# ============================================================
# Run this on the Backoffice / Server PC to download the ROSIE
# LLM model and voice stack, then patch the server .env so
# ROSIE becomes available without a full server reinstall.
#
# Usage (elevated PowerShell):
#   .\Install-RosieAiStack.ps1
#
# Optional flags:
#   -ServerInstallRoot "C:\RiversideOS"   (default: auto-detected)
#   -SkipVoiceTools                       (skips sherpa-onnx / STT / TTS)
#   -SkipEnvPatch                         (downloads model but skips .env edit)
#   -HfToken "hf_..."                     (Hugging Face token for gated models)
# ============================================================

[CmdletBinding()]
param(
  [string]$ServerInstallRoot = "",
  [switch]$SkipVoiceTools,
  [switch]$SkipEnvPatch,
  [string]$HfToken = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ScriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ScriptRoot)) {
  $ScriptRoot = if ($MyInvocation -and $MyInvocation.MyCommand -and $MyInvocation.MyCommand.Path) {
    Split-Path -Parent $MyInvocation.MyCommand.Path
  } else {
    "."
  }
}

# ---- Admin guard ----
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = $null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })
if (-not $isAdmin) {
  Write-Host "Re-launching as Administrator..."
  Start-Process powershell.exe -Verb RunAs -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`""
  )
  exit
}

# ---- Resolve server install root ----
if (-not $ServerInstallRoot) {
  # Try reading from riverside-deployment.config.json next to this script.
  $configPath = Join-Path $ScriptRoot "riverside-deployment.config.json"
  if (Test-Path $configPath) {
    try {
      $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
      if ($cfg.server.installRoot) { $ServerInstallRoot = $cfg.server.installRoot }
    } catch {}
  }
  if (-not $ServerInstallRoot) { $ServerInstallRoot = "C:\RiversideOS" }
}
$serverEnvPath = Join-Path $ServerInstallRoot "server\.env"
Write-Host ""
Write-Host "========================================================"
Write-Host "  Riverside OS - ROSIE AI Stack Installer"
Write-Host "  Server root : $ServerInstallRoot"
Write-Host "  Server .env : $serverEnvPath"
Write-Host "========================================================"
Write-Host ""

# ---- Asset directories (%LOCALAPPDATA%\riverside-os\rosie\) ----
$rosieRoot  = Join-Path $env:LOCALAPPDATA "riverside-os\rosie"
$modelsDir  = Join-Path $rosieRoot "models\gemma-4-e4b"
$sttDir     = Join-Path $rosieRoot "stt"
$ttsDir     = Join-Path $rosieRoot "tts"

# ============================================================
# STEP 1 - Pinned Gemma GGUF (MODEL_PIN.json)
# ============================================================
Write-Host "[1/4] LLM model (Gemma 4 E4B)..."

# MODEL_PIN.json is either next to this script (from the deployment package)
# or we fall back to inline values pinned at release time.
$pinPath = Join-Path $ScriptRoot "rosie\MODEL_PIN.json"
if (Test-Path $pinPath) {
  $pin = Get-Content -Raw $pinPath | ConvertFrom-Json
} else {
  Write-Host "      MODEL_PIN.json not found next to script - using release-pinned values."
  $pin = [pscustomobject]@{
    huggingface_model_id = "bartowski/google_gemma-4-E4B-it-GGUF"
    revision             = "c04cb322fd63e347db759a08b6249b867488ccf8"
    filename             = "google_gemma-4-E4B-it-Q4_K_M.gguf"
    sha256               = "b937a48e96379116137c50acbe39fd1b46eb101d2df4e560f47f5e2171b6451e"
    size_bytes           = 5405167904
  }
}

New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
$modelDest = Join-Path $modelsDir $pin.filename

$needsDownload = $true
if (Test-Path $modelDest) {
  Write-Host "      Verifying existing model SHA256..."
  $existingHash = (Get-FileHash -Algorithm SHA256 -Path $modelDest).Hash.ToLowerInvariant()
  if ($existingHash -eq $pin.sha256.ToLowerInvariant()) {
    Write-Host "      OK - model already present and verified."
    Write-Host "      Path: $modelDest"
    $needsDownload = $false
  } else {
    Write-Warning "      Hash mismatch - re-downloading."
    Remove-Item $modelDest -Force
  }
}

if ($needsDownload) {
  $sizeMb  = [math]::Round($pin.size_bytes / 1MB)
  $modelUrl = "https://huggingface.co/$($pin.huggingface_model_id)/resolve/$($pin.revision)/$($pin.filename)"
  Write-Host "      Downloading $($pin.filename) (~${sizeMb} MB) from Hugging Face."
  Write-Host "      This will take several minutes on a typical connection."
  Write-Host "      URL : $modelUrl"
  Write-Host "      Dest: $modelDest"
  try {
    $headers = @{}
    $effectiveToken = if ($HfToken) { $HfToken } elseif ($env:HF_TOKEN) { $env:HF_TOKEN } else { "" }
    if ($effectiveToken) { $headers["Authorization"] = "Bearer $effectiveToken" }
    Invoke-WebRequest -Uri $modelUrl -OutFile $modelDest -Headers $headers -UseBasicParsing
    $gotHash = (Get-FileHash -Algorithm SHA256 -Path $modelDest).Hash.ToLowerInvariant()
    if ($gotHash -ne $pin.sha256.ToLowerInvariant()) {
      Remove-Item $modelDest -Force
      throw "SHA256 mismatch after download. Expected $($pin.sha256), got $gotHash."
    }
    Write-Host "      Model downloaded and SHA256 verified."
  } catch {
    Write-Warning "      Model download failed: $($_.Exception.Message)"
    Write-Warning "      ROSIE LLM will be unavailable until the model is present at:"
    Write-Warning "      $modelDest"
    $modelDest = $null
  }
}

# ============================================================
# STEP 2 - sherpa-onnx Python runtime (via uv)
# ============================================================
if ($SkipVoiceTools) {
  Write-Host "[2/4] Voice tools skipped (-SkipVoiceTools)."
} else {
  Write-Host "[2/4] sherpa-onnx Python runtime..."

  $uvCmdObj = Get-Command uv.exe -ErrorAction SilentlyContinue
  $uvCmd = if ($uvCmdObj) { $uvCmdObj.Source } else { $null }
  if (-not $uvCmd) {
    $uvLocal = Join-Path $env:LOCALAPPDATA "Programs\uv\uv.exe"
    $uvUserProfile = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
    if (Test-Path $uvUserProfile) {
      $uvCmd = $uvUserProfile
    } elseif (Test-Path $uvLocal) {
      $uvCmd = $uvLocal
    } else {
      Write-Host "      Installing uv (Python toolchain manager)..."
      try {
        Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
        if (Test-Path $uvUserProfile) {
          $uvCmd = $uvUserProfile
        } else {
          $uvCmd = Join-Path $env:LOCALAPPDATA "Programs\uv\uv.exe"
        }
        Write-Host "      uv installed."
      } catch {
        Write-Warning "      Could not install uv: $($_.Exception.Message)"
        Write-Warning "      Install uv manually from https://astral.sh/uv, then re-run this script."
        $uvCmd = $null
      }
    }
  }

  if ($uvCmd -and (Test-Path $uvCmd)) {
    Write-Host "      uv: $uvCmd"
    Write-Host "      Installing sherpa-onnx..."
    $sherpaInstalled = $false
    # Attempt 1: uv tool install with pinned Python 3.12
    try {
      & $uvCmd tool install --force --python 3.12 sherpa-onnx 2>&1 | ForEach-Object { Write-Host "      $_" }
      if ($LASTEXITCODE -eq 0) { $sherpaInstalled = $true }
    } catch { }
    # Attempt 2: uv tool install without pinned Python
    if (-not $sherpaInstalled) {
      Write-Host "      Retry 1 - without pinned Python..."
      try {
        & $uvCmd tool install --force sherpa-onnx 2>&1 | ForEach-Object { Write-Host "      $_" }
        if ($LASTEXITCODE -eq 0) { $sherpaInstalled = $true }
      } catch { }
    }
    # Attempt 3: pip install into a dedicated venv
    if (-not $sherpaInstalled) {
      Write-Host "      Retry 2 - creating dedicated venv with pip..."
      $sherpaVenv = Join-Path $env:LOCALAPPDATA "riverside-os\rosie\sherpa-venv"
      try {
        & $uvCmd venv --python 3.12 $sherpaVenv 2>&1 | ForEach-Object { Write-Host "      $_" }
        $sherpaVenvPip = Join-Path $sherpaVenv "Scripts\pip.exe"
        if (Test-Path $sherpaVenvPip) {
          & $sherpaVenvPip install --upgrade sherpa-onnx 2>&1 | ForEach-Object { Write-Host "      $_" }
          if ($LASTEXITCODE -eq 0) { $sherpaInstalled = $true }
        }
      } catch { }
    }
    if ($sherpaInstalled) {
      Write-Host "      sherpa-onnx installed successfully."
    } else {
      Write-Warning "      sherpa-onnx install FAILED after all retries. Voice STT/TTS will not be available. Check network connectivity and try again."
    }
  }

  # ---- SenseVoice STT model ----
  Write-Host "[3/4] SenseVoice STT model..."
  $sensevoiceDir   = Join-Path $sttDir "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
  $sensevoiceModel = Join-Path $sensevoiceDir "model.int8.onnx"
  if (Test-Path $sensevoiceModel) {
    Write-Host "      SenseVoice model already present."
  } else {
    $sttUrl  = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2"
    $tarDest = Join-Path $env:TEMP "ros-sensevoice.tar.bz2"
    New-Item -ItemType Directory -Force -Path $sttDir | Out-Null
    Write-Host "      Downloading SenseVoice STT model..."
    try {
      Invoke-WebRequest -Uri $sttUrl -OutFile $tarDest -UseBasicParsing
      Write-Host "      Extracting..."
      & tar.exe -xjf $tarDest -C $sttDir
      Remove-Item $tarDest -Force -ErrorAction SilentlyContinue
      Write-Host "      SenseVoice STT installed."
    } catch {
      Write-Warning "      SenseVoice download failed: $($_.Exception.Message)"
      Write-Warning "      Voice input will use Windows Speech fallback."
    }
  }

  # ---- Kokoro TTS model ----
  Write-Host "[4/4] Kokoro TTS model..."
  $kokoroDir   = Join-Path $ttsDir "kokoro-multi-lang-v1_0"
  $kokoroModel = Join-Path $kokoroDir "model.onnx"
  if (Test-Path $kokoroModel) {
    Write-Host "      Kokoro TTS model already present."
  } else {
    $ttsUrl  = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2"
    $tarDest = Join-Path $env:TEMP "ros-kokoro.tar.bz2"
    New-Item -ItemType Directory -Force -Path $ttsDir | Out-Null
    Write-Host "      Downloading Kokoro TTS model..."
    try {
      Invoke-WebRequest -Uri $ttsUrl -OutFile $tarDest -UseBasicParsing
      Write-Host "      Extracting..."
      & tar.exe -xjf $tarDest -C $ttsDir
      Remove-Item $tarDest -Force -ErrorAction SilentlyContinue
      Write-Host "      Kokoro TTS installed."
    } catch {
      Write-Warning "      Kokoro download failed: $($_.Exception.Message)"
      Write-Warning "      Voice output will use Windows TTS fallback."
    }
  }
}

# ============================================================
# Patch server .env
# ============================================================
if ($SkipEnvPatch) {
  Write-Host ""
  Write-Host "Server .env patch skipped (-SkipEnvPatch)."
} elseif (-not (Test-Path $serverEnvPath)) {
  Write-Warning ""
  Write-Warning "Server .env not found at: $serverEnvPath"
  Write-Warning "Cannot patch RIVERSIDE_LLAMA_* variables automatically."
  Write-Warning "Add these lines to your server .env manually when the server is installed:"
  if ($modelDest) { Write-Warning "  RIVERSIDE_LLAMA_MODEL_PATH=$modelDest" }
  Write-Warning "  RIVERSIDE_LLAMA_HOST=127.0.0.1"
  Write-Warning "  RIVERSIDE_LLAMA_PORT=8080"
} else {
  Write-Host ""
  Write-Host "Patching server .env..."
  $envLines = Get-Content $serverEnvPath -Encoding UTF8

  function Set-EnvLine([string[]]$Lines, [string]$Key, [string]$Value) {
    $found = $false
    $out = $Lines | ForEach-Object {
      if ($_ -match "^$Key=") { $found = $true; "$Key=$Value" }
      else { $_ }
    }
    if (-not $found) { $out += "$Key=$Value" }
    return $out
  }

  if ($modelDest) {
    $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_MODEL_PATH" $modelDest
  }
  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_HOST" "127.0.0.1"
  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_PORT" "8080"

  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllLines($serverEnvPath, $envLines, $utf8NoBom)
  Write-Host "      Server .env updated."

  # Restart the server task so it picks up the new env.
  $task = Get-ScheduledTask -TaskName "Riverside OS Server" -ErrorAction SilentlyContinue
  if ($task) {
    Write-Host "      Restarting Riverside OS Server task..."
    Stop-ScheduledTask  -TaskName "Riverside OS Server" -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Get-Process -Name "riverside-server" -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    Start-ScheduledTask -TaskName "Riverside OS Server"
    Start-Sleep -Seconds 3
    Write-Host "      Server restarted."
  } else {
    Write-Warning "      Riverside OS Server scheduled task not found. Start the server manually."
  }
}

$llamaScript = Join-Path $ScriptRoot "start-riverside-llama.ps1"
if ((Test-Path $llamaScript) -and $modelDest -and (Test-Path $modelDest)) {
  Write-Host ""
  Write-Host "[5/5] Starting ROSIE LLM host (llama-server)..."
  try {
    & $llamaScript -InstallRoot $ServerInstallRoot
  } catch {
    Write-Warning "      Could not start ROSIE LLM host: $($_.Exception.Message)"
  }
}

# ============================================================
# Summary
# ============================================================
Write-Host ""
Write-Host "========================================================"
Write-Host "  ROSIE AI Stack Install - Complete"
Write-Host ""
if ($modelDest -and (Test-Path $modelDest)) {
  Write-Host "  LLM model  : OK - $modelDest"
} else {
  Write-Host "  LLM model  : MISSING - download manually and re-run"
}
if (-not $SkipVoiceTools) {
  $sttOk = Test-Path (Join-Path $sttDir "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17\model.int8.onnx")
  $ttsOk = Test-Path (Join-Path $ttsDir "kokoro-multi-lang-v1_0\model.onnx")
  Write-Host "  STT model  : $(if ($sttOk) { 'OK' } else { 'MISSING (voice input unavailable)' })"
  Write-Host "  TTS model  : $(if ($ttsOk) { 'OK' } else { 'MISSING (voice output unavailable)' })"
}
Write-Host ""
Write-Host "  ROSIE will be available in the Riverside app once the"
Write-Host "  server has restarted with the updated .env settings."
Write-Host "========================================================"
Write-Host ""
