# ============================================================
# Riverside OS - ROSIE AI Stack Installer
# ============================================================
# Run this on the Backoffice / Server PC to deploy the ROSIE
# pre-compiled binaries and models, and verify integrity.
#
# Usage (elevated PowerShell):
#   .\Install-RosieAiStack.ps1
#
# Optional flags:
#   -ServerInstallRoot "C:\RiversideOS"   (default: auto-detected)
#   -SkipEnvPatch                         (downloads/extracts but skips .env edit)
#   -HfToken "hf_..."                     (Hugging Face token for gated models)
#
# Binaries and models may be bundled in the deployment package under
# .\rosie\ or they will be downloaded automatically from pinned releases.
# ============================================================

[CmdletBinding()]
param(
  [string]$ServerInstallRoot = "",
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
Write-Host "  Riverside OS - ROSIE AI Stack Installer (Zero-Python)"
Write-Host "  Server root : $ServerInstallRoot"
Write-Host "  Server .env : $serverEnvPath"
Write-Host "========================================================"
Write-Host ""

$rosieRoot  = Join-Path $ServerInstallRoot "rosie"
$binDestDir = Join-Path $rosieRoot "bin"
$modelsDir  = Join-Path $rosieRoot "models\gemma-4-e4b"
$sttDir     = Join-Path $rosieRoot "stt"
$ttsDir     = Join-Path $rosieRoot "tts"

$pkgRosieDir = Join-Path $ScriptRoot "rosie"
$pkgBinDir   = Join-Path $pkgRosieDir "bin"

# ============================================================
# PINNED VERSIONS  (update here when upgrading components)
# ============================================================
$SHERPA_VERSION   = "1.13.2"
$SHERPA_ARCH      = "win-x64"  # win-x64 | win-x86 | win-arm64
$SHERPA_TAR_URL   = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$SHERPA_VERSION/sherpa-onnx-v$SHERPA_VERSION-$SHERPA_ARCH.tar.bz2"

# SenseVoice Small (int8) - STT primary
$STT_MODEL_DIR    = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
$STT_HF_REPO      = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
$STT_FILES        = @("model.int8.onnx", "tokens.txt")

# Kokoro-82M multi-lang - TTS primary
$TTS_MODEL_DIR    = "kokoro-multi-lang-v1_0"
$TTS_HF_REPO      = "csukuangfj/kokoro-multi-lang-v1_0"
$TTS_FILES        = @("model.onnx", "voices.bin", "tokens.txt")
$TTS_ESPEAK_FILES = @(
  "espeak-ng-data/afrikaans_dict",
  "espeak-ng-data/en_dict",
  "espeak-ng-data/phontab",
  "espeak-ng-data/phonindex",
  "espeak-ng-data/phondata",
  "espeak-ng-data/intonations",
  "espeak-ng-data/lang/en/en",
  "espeak-ng-data/lang/en/en-us",
  "espeak-ng-data/lang/es/es",
  "espeak-ng-data/lang/fr/fr",
  "espeak-ng-data/lang/de/de"
)

# ---- Helper: download with optional HF auth ----
function Invoke-Download([string]$Url, [string]$OutFile, [string]$Label) {
  Write-Host "      Downloading $Label..."
  $headers = @{}
  $effectiveToken = if ($HfToken) { $HfToken } elseif ($env:HF_TOKEN) { $env:HF_TOKEN } else { "" }
  if ($effectiveToken -and $Url -like "*huggingface.co*") {
    $headers["Authorization"] = "Bearer $effectiveToken"
  }
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -Headers $headers -UseBasicParsing
}

# ---- Helper: download a single HuggingFace file ----
function Get-HfFile([string]$Repo, [string]$FilePath, [string]$DestDir) {
  $url      = "https://huggingface.co/$Repo/resolve/main/$FilePath"
  $destPath = Join-Path $DestDir $FilePath
  $destParent = Split-Path $destPath -Parent
  if (-not (Test-Path $destParent)) {
    New-Item -ItemType Directory -Force -Path $destParent | Out-Null
  }
  if (Test-Path $destPath) {
    Write-Host "      Already present: $FilePath"
    return
  }
  Invoke-Download $url $destPath $FilePath
}

# ============================================================
# STEP 1 - Binaries: copy from package or download
# ============================================================
Write-Host "[1/4] Setting up ROSIE binaries..."
New-Item -ItemType Directory -Force -Path $binDestDir | Out-Null

$requiredBinaries = @("sherpa-onnx-offline.exe", "sherpa-onnx-offline-tts.exe")
$bundledLlama    = Join-Path $pkgBinDir "llama-server.exe"
$destLlama       = Join-Path $binDestDir "llama-server.exe"

# Copy any binaries that ARE in the package
if (Test-Path $pkgBinDir) {
  Write-Host "      Copying bundled binaries from package..."
  Copy-Item (Join-Path $pkgBinDir "*") $binDestDir -Force -Recurse -ErrorAction SilentlyContinue
}

# Check which sherpa-onnx binaries still need to be downloaded
$missingSherpa = $requiredBinaries | Where-Object { -not (Test-Path (Join-Path $binDestDir $_)) }

if ($missingSherpa.Count -gt 0) {
  Write-Host "      sherpa-onnx binaries not bundled. Downloading sherpa-onnx v$SHERPA_VERSION..."
  $tarPath    = Join-Path $env:TEMP "sherpa-onnx-$SHERPA_VERSION.tar.bz2"
  $extractDir = Join-Path $env:TEMP "sherpa-onnx-extract-$SHERPA_VERSION"

  if (-not (Test-Path $tarPath)) {
    Invoke-Download $SHERPA_TAR_URL $tarPath "sherpa-onnx-v$SHERPA_VERSION-$SHERPA_ARCH.tar.bz2"
  }

  if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

  Write-Host "      Extracting sherpa-onnx archive..."
  # tar is natively available on Windows 10 1803+
  $tarResult = & tar -xjf $tarPath -C $extractDir 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "tar extraction failed. Ensure Windows tar supports .bz2 (Windows 10 1803+ required). Output: $tarResult"
  }

  # Copy just the executables we need from the extracted tree
  $exesToCopy = @("sherpa-onnx-offline.exe", "sherpa-onnx-offline-tts.exe", "sherpa-onnx.exe")
  Get-ChildItem $extractDir -Recurse -Filter "*.exe" | ForEach-Object {
    if ($exesToCopy -contains $_.Name) {
      $dest = Join-Path $binDestDir $_.Name
      Copy-Item $_.FullName $dest -Force
      Write-Host "      Extracted: $($_.Name)"
    }
  }

  # Also copy required DLLs (onnxruntime.dll etc.) from same folder as the exe
  Get-ChildItem $extractDir -Recurse -Filter "sherpa-onnx-offline.exe" | Select-Object -First 1 | ForEach-Object {
    $exeDir = $_.DirectoryName
    Get-ChildItem $exeDir -Filter "*.dll" | ForEach-Object {
      Copy-Item $_.FullName (Join-Path $binDestDir $_.Name) -Force
    }
  }

  Remove-Item $tarPath -Force -ErrorAction SilentlyContinue
  Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Verify required binaries are now present
foreach ($bin in $requiredBinaries) {
  $binPath = Join-Path $binDestDir $bin
  if (-not (Test-Path $binPath)) {
    throw "Required ROSIE binary '$bin' could not be obtained at: $binPath"
  }
  Write-Host "      OK: $bin"
}

# ============================================================
# STEP 2 - STT Models (SenseVoice Small)
# ============================================================
Write-Host "[2/4] Setting up STT models (SenseVoice Small)..."
New-Item -ItemType Directory -Force -Path $sttDir | Out-Null

$sttModelDir = Join-Path $sttDir $STT_MODEL_DIR
$pkgSttDir   = Join-Path $pkgRosieDir "stt"

# Copy from package if present
if (Test-Path $pkgSttDir) {
  Write-Host "      Copying bundled STT models from package..."
  Copy-Item (Join-Path $pkgSttDir "*") $sttDir -Force -Recurse -ErrorAction SilentlyContinue
}

# Download any missing STT files
New-Item -ItemType Directory -Force -Path $sttModelDir | Out-Null
foreach ($file in $STT_FILES) {
  Get-HfFile $STT_HF_REPO $file $sttModelDir
}

$sttOk = $STT_FILES | ForEach-Object { Test-Path (Join-Path $sttModelDir $_) } | Where-Object { -not $_ }
if ($sttOk) {
  Write-Warning "      Some STT model files could not be downloaded. ROSIE voice input will be unavailable."
} else {
  Write-Host "      STT models ready at: $sttModelDir"
}

# ============================================================
# STEP 3 - TTS Models (Kokoro-82M)
# ============================================================
Write-Host "[3/4] Setting up TTS models (Kokoro-82M)..."
New-Item -ItemType Directory -Force -Path $ttsDir | Out-Null

$ttsModelDir = Join-Path $ttsDir $TTS_MODEL_DIR
$pkgTtsDir   = Join-Path $pkgRosieDir "tts"

# Copy from package if present
if (Test-Path $pkgTtsDir) {
  Write-Host "      Copying bundled TTS models from package..."
  Copy-Item (Join-Path $pkgTtsDir "*") $ttsDir -Force -Recurse -ErrorAction SilentlyContinue
}

# Download any missing TTS files
New-Item -ItemType Directory -Force -Path $ttsModelDir | Out-Null
foreach ($file in $TTS_FILES) {
  Get-HfFile $TTS_HF_REPO $file $ttsModelDir
}
# Download espeak-ng-data files (needed for Kokoro phoneme synthesis)
foreach ($file in $TTS_ESPEAK_FILES) {
  Get-HfFile $TTS_HF_REPO $file $ttsModelDir
}

$ttsOk = $TTS_FILES | ForEach-Object { Test-Path (Join-Path $ttsModelDir $_) } | Where-Object { -not $_ }
if ($ttsOk) {
  Write-Warning "      Some TTS model files could not be downloaded. ROSIE voice output will be unavailable."
} else {
  Write-Host "      TTS models ready at: $ttsModelDir"
}

# ============================================================
# STEP 4 - GGUF model download and integrity check
# ============================================================
Write-Host "[4/4] Verification of Gemma GGUF model..."

$pinPath = Join-Path $pkgRosieDir "MODEL_PIN.json"
if (Test-Path $pinPath) {
  $pin = Get-Content -Raw $pinPath | ConvertFrom-Json
} else {
  Write-Host "      MODEL_PIN.json not found in package - using release-pinned values."
  $pin = [pscustomobject]@{
    huggingface_model_id = "bartowski/google_gemma-4-E4B-it-GGUF"
    revision             = "c04cb322fd63e347db759a08b6249b867488ccf8"
    filename             = "google_gemma-4-E4B-it-Q4_K_M.gguf"
    sha256               = "51865750adafd22de56994a343d5a887cc1a589b9bae41d62b748c8bd0ca9c76"
    size_bytes           = 5405168384
  }
}

New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
$modelDest = Join-Path $modelsDir $pin.filename

$needsDownload = $true
if (Test-Path $modelDest) {
  Write-Host "      Verifying Gemma model SHA256..."
  $existingHash = (Get-FileHash -Algorithm SHA256 -Path $modelDest).Hash.ToLowerInvariant()
  if ($existingHash -eq $pin.sha256.ToLowerInvariant()) {
    Write-Host "      OK - Gemma model verified successfully."
    $needsDownload = $false
  } else {
    Write-Warning "      Gemma model hash mismatch ($existingHash vs $($pin.sha256)) - re-downloading."
    Remove-Item $modelDest -Force
  }
}

if ($needsDownload) {
  $modelUrl = "https://huggingface.co/$($pin.huggingface_model_id)/resolve/$($pin.revision)/$($pin.filename)"
  Write-Host "      Downloading $($pin.filename) (~$([math]::Round($pin.size_bytes / 1GB, 1)) GB) from Hugging Face..."
  try {
    Invoke-Download $modelUrl $modelDest $pin.filename

    $gotHash = (Get-FileHash -Algorithm SHA256 -Path $modelDest).Hash.ToLowerInvariant()
    if ($gotHash -ne $pin.sha256.ToLowerInvariant()) {
      Remove-Item $modelDest -Force
      throw "SHA256 mismatch after download. Expected $($pin.sha256), got $gotHash."
    }
    Write-Host "      Gemma model downloaded and verified successfully."
  } catch {
    Write-Warning "      Gemma model verification/download failed: $($_.Exception.Message)"
    Write-Warning "      ROSIE LLM will be unavailable. Re-run Install-RosieAiStack.ps1 when network is available."
    # Do NOT throw - partial ROSIE (STT/TTS without LLM) is better than full failure
  }
}

# Write ready flag file (written even if Gemma download failed - binaries are present)
$readyFlag = Join-Path $rosieRoot "rosie_ready"
"READY" | Out-File -FilePath $readyFlag -Encoding utf8
Write-Host "      Created ready flag file: $readyFlag"

# ============================================================
# STEP 5 - Patch server .env
# ============================================================
Write-Host "[5/5] Patching server env..."
if ($SkipEnvPatch) {
  Write-Host "      Server .env patch skipped (-SkipEnvPatch)."
} elseif (-not (Test-Path $serverEnvPath)) {
  Write-Warning "      Server .env not found at: $serverEnvPath - skipping environment variables configuration."
} else {
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

  if (Test-Path $modelDest) {
    $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_MODEL_PATH" $modelDest
  }
  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_HOST" "127.0.0.1"
  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_PORT" "8080"

  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllLines($serverEnvPath, $envLines, $utf8NoBom)
  Write-Host "      Server .env updated."

  # Restart LLM scheduled task if registered
  $taskName = "Riverside OS LLM Host"
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task -and (Test-Path $modelDest)) {
    Write-Host "      Restarting scheduled task '$taskName'..."
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Get-Process -Name "llama-server" -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    Start-ScheduledTask -TaskName $taskName
    Write-Host "      Scheduled task restarted."
  }
}

Write-Host ""
Write-Host "========================================================"
Write-Host "  ROSIE AI Stack Install - Complete"
Write-Host "  Binaries : $binDestDir"
Write-Host "  STT      : $sttModelDir"
Write-Host "  TTS      : $ttsModelDir"
if (Test-Path $modelDest) {
  Write-Host "  LLM      : $modelDest"
} else {
  Write-Host "  LLM      : (not yet downloaded - run Install-RosieAiStack.ps1 again)"
}
Write-Host "========================================================"
Write-Host ""
