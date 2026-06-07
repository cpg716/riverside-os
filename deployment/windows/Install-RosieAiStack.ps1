# ============================================================
# Riverside OS - ROSIE AI Stack Installer
# ============================================================
# Run this on the Main Hub to deploy the ROSIE
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

# Enable TLS 1.2 and TLS 1.3 for secure downloads from GitHub/HuggingFace (safely fallback if TLS 1.3 enum is missing)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 12288
} catch {}

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
$SHERPA_ARCH      = "win-x64-shared-MD-Release"
$SHERPA_TAR_NAME  = "sherpa-onnx-v$SHERPA_VERSION-$SHERPA_ARCH.tar.bz2"
$SHERPA_TAR_URL   = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$SHERPA_VERSION/$SHERPA_TAR_NAME"

# llama.cpp CPU runtime for the Host LLM. This is used when the
# deployment package does not already include rosie\bin\llama-server.exe.
$LLAMA_VERSION    = "b9512"
$LLAMA_ZIP_NAME   = "llama-$LLAMA_VERSION-bin-win-cpu-x64.zip"
$LLAMA_ZIP_URL    = "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_VERSION/$LLAMA_ZIP_NAME"
$LLAMA_ZIP_SHA256 = "78dde1e8805713d0a726e9603a2bb0a6c26aad77b4e667108233890652e41019"

# SenseVoice Small (int8) - STT primary. The older csukuangfj 2024 repo now
# returns 401 for unauthenticated downloads; use the public mirror with the
# same model/tokens file shape.
$STT_MODEL_DIR    = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
$STT_HF_REPO      = "chris-cao/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
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

# ---- Helper: download with optional HF auth and automatic retry ----
function Invoke-Download([string]$Url, [string]$OutFile, [string]$Label, [int]$MaxRetries = 3) {
  Write-Host "      Downloading $Label..."
  $attempt = 0
  $lastErr = $null
  while ($attempt -lt $MaxRetries) {
    $attempt++
    $webClient = $null
    try {
      if (Test-Path $OutFile) { Remove-Item $OutFile -Force -ErrorAction SilentlyContinue }
      
      # Use .NET WebClient for streaming download directly to disk (prevents memory bloat and IE dialog blocks)
      $webClient = New-Object System.Net.WebClient
      $effectiveToken = if ($HfToken) { $HfToken } elseif ($env:HF_TOKEN) { $env:HF_TOKEN } else { "" }
      if ($effectiveToken -and $Url -like "*huggingface.co*") {
        $webClient.Headers.Add("Authorization", "Bearer $effectiveToken")
      }
      # Add User-Agent to satisfy GitHub and HuggingFace CDN request rules
      $webClient.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
      
      $webClient.DownloadFile($Url, $OutFile)
      $webClient.Dispose()
      return  # success
    } catch {
      if ($null -ne $webClient) { $webClient.Dispose() }
      $lastErr = $_.ToString()
      Write-Warning "      Download attempt $attempt/$MaxRetries failed: $lastErr"
      if ($lastErr -match "401|Unauthorized|Invalid username or password") {
        throw "Download failed for '$Label': Hugging Face rejected the request. Rebuild the deployment package with bundled ROSIE models, use a public model pin, or pass -HfToken/Set HF_TOKEN for authenticated models. $lastErr"
      }
      if ($attempt -lt $MaxRetries) {
        $sleepSec = [math]::Pow(2, $attempt)  # 2s, 4s
        Write-Host "      Retrying in $sleepSec seconds..."
        Start-Sleep -Seconds $sleepSec
      }
    }
  }
  throw "Download failed after $MaxRetries attempts for '$Label': $lastErr"
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
$llamaVersionFile = Join-Path $rosieRoot "llama_version.txt"

# Stop any running ROSIE / llama-server processes BEFORE copying binaries.
# Without this, Windows will refuse to overwrite DLLs that are held open
# by a running process (e.g. ggml-base.dll), causing an "access denied" error.
Write-Host "      Stopping any running ROSIE / LLM processes before file copy..."
Stop-ScheduledTask -TaskName "Riverside OS LLM Host" -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
@("llama-server", "sherpa-onnx-offline", "sherpa-onnx-offline-tts", "sherpa-onnx") | ForEach-Object {
  Get-Process -Name $_ -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 2

# Check if sherpa version matches
$versionFile = Join-Path $rosieRoot "sherpa_version.txt"
$installedVersion = if (Test-Path $versionFile) { Get-Content $versionFile -Raw } else { "" }
$installedVersion = $installedVersion.Trim()

if ($installedVersion -ne $SHERPA_VERSION) {
  Write-Host "      Sherpa version mismatch (installed: '$installedVersion', script: '$SHERPA_VERSION'). Forcing clean bin update..."
  $requiredBinaries | ForEach-Object {
    $p = Join-Path $binDestDir $_
    if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
  }
}

# Copy any binaries that ARE in the package
if (Test-Path $pkgBinDir) {
  Write-Host "      Copying bundled binaries from package..."
  Copy-Item (Join-Path $pkgBinDir "*") $binDestDir -Force -Recurse -ErrorAction SilentlyContinue
}

$installedLlamaVersion = if (Test-Path $llamaVersionFile) { Get-Content $llamaVersionFile -Raw } else { "" }
$installedLlamaVersion = $installedLlamaVersion.Trim()
if ((Test-Path $destLlama) -and ($installedLlamaVersion -ne $LLAMA_VERSION) -and (-not (Test-Path $bundledLlama))) {
  Write-Host "      llama.cpp version mismatch (installed: '$installedLlamaVersion', script: '$LLAMA_VERSION'). Updating Host LLM runtime..."
  Remove-Item $destLlama -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path $destLlama)) {
  Write-Host "      llama-server.exe not bundled. Downloading llama.cpp $LLAMA_VERSION CPU runtime..."
  $llamaZipPath = Join-Path $env:TEMP $LLAMA_ZIP_NAME
  $llamaExtractDir = Join-Path $env:TEMP "llama-cpp-extract-$LLAMA_VERSION"

  Invoke-Download $LLAMA_ZIP_URL $llamaZipPath $LLAMA_ZIP_NAME
  $llamaHash = (Get-FileHash -Algorithm SHA256 -Path $llamaZipPath).Hash.ToLowerInvariant()
  if ($llamaHash -ne $LLAMA_ZIP_SHA256.ToLowerInvariant()) {
    Remove-Item $llamaZipPath -Force -ErrorAction SilentlyContinue
    throw "llama.cpp ZIP SHA256 mismatch. Expected $LLAMA_ZIP_SHA256, got $llamaHash."
  }

  if (Test-Path $llamaExtractDir) { Remove-Item $llamaExtractDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $llamaExtractDir | Out-Null
  Expand-Archive -Path $llamaZipPath -DestinationPath $llamaExtractDir -Force

  $extractedLlama = Get-ChildItem $llamaExtractDir -Recurse -Filter "llama-server.exe" | Select-Object -First 1
  if (-not $extractedLlama) {
    throw "llama.cpp archive did not contain llama-server.exe."
  }
  Copy-Item $extractedLlama.FullName $destLlama -Force
  Write-Host "      Extracted: llama-server.exe"

  $llamaRuntimeDir = $extractedLlama.DirectoryName
  Get-ChildItem $llamaRuntimeDir -Filter "*.dll" | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $binDestDir $_.Name) -Force
  }

  Remove-Item $llamaZipPath -Force -ErrorAction SilentlyContinue
  Remove-Item $llamaExtractDir -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path $destLlama)) {
  throw "Required ROSIE binary 'llama-server.exe' could not be obtained at: $destLlama"
}
$LLAMA_VERSION | Out-File -FilePath $llamaVersionFile -Encoding utf8
Write-Host "      OK: llama-server.exe"

# Check which sherpa-onnx binaries still need to be downloaded
$missingSherpa = $requiredBinaries | Where-Object { -not (Test-Path (Join-Path $binDestDir $_)) }

if ($missingSherpa.Count -gt 0) {
  Write-Host "      sherpa-onnx binaries not bundled. Downloading sherpa-onnx v$SHERPA_VERSION..."
  $tarPath    = Join-Path $env:TEMP "sherpa-onnx-$SHERPA_VERSION.tar.bz2"
  $extractDir = Join-Path $env:TEMP "sherpa-onnx-extract-$SHERPA_VERSION"

  if (-not (Test-Path $tarPath)) {
    Invoke-Download $SHERPA_TAR_URL $tarPath $SHERPA_TAR_NAME
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

# Write version file to prevent re-downloads/forcibly track the installed version
$SHERPA_VERSION | Out-File -FilePath $versionFile -Encoding utf8

# ============================================================
# STEP 2 - STT Models (SenseVoice Small)
# ============================================================
Write-Host "[2/4] Setting up STT models (SenseVoice Small)..."
New-Item -ItemType Directory -Force -Path $sttDir | Out-Null

$sttModelDir = Join-Path $sttDir $STT_MODEL_DIR
$pkgSttDir   = Join-Path $pkgRosieDir "stt"

$sttVersionFile = Join-Path $rosieRoot "stt_version.txt"
$installedStt = if (Test-Path $sttVersionFile) { Get-Content $sttVersionFile -Raw } else { "" }
$installedStt = $installedStt.Trim()

if ($installedStt -ne $STT_HF_REPO) {
  Write-Host "      STT model mismatch (installed: '$installedStt', script: '$STT_HF_REPO'). Forcing clean update..."
  if (Test-Path $sttModelDir) { Remove-Item $sttModelDir -Recurse -Force -ErrorAction SilentlyContinue }
}

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

$sttMissing = @($STT_FILES | Where-Object { -not (Test-Path (Join-Path $sttModelDir $_)) })
$sttReady = $sttMissing.Count -eq 0
if (-not $sttReady) {
  Write-Warning "      Some STT model files could not be downloaded. ROSIE voice input is blocked until setup is repaired."
} else {
  Write-Host "      STT models ready at: $sttModelDir"
  $STT_HF_REPO | Out-File -FilePath $sttVersionFile -Encoding utf8
}

# ============================================================
# STEP 3 - TTS Models (Kokoro-82M)
# ============================================================
Write-Host "[3/4] Setting up TTS models (Kokoro-82M)..."
New-Item -ItemType Directory -Force -Path $ttsDir | Out-Null

$ttsModelDir = Join-Path $ttsDir $TTS_MODEL_DIR
$pkgTtsDir   = Join-Path $pkgRosieDir "tts"

$ttsVersionFile = Join-Path $rosieRoot "tts_version.txt"
$installedTts = if (Test-Path $ttsVersionFile) { Get-Content $ttsVersionFile -Raw } else { "" }
$installedTts = $installedTts.Trim()

if ($installedTts -ne $TTS_HF_REPO) {
  Write-Host "      TTS model mismatch (installed: '$installedTts', script: '$TTS_HF_REPO'). Forcing clean update..."
  if (Test-Path $ttsModelDir) { Remove-Item $ttsModelDir -Recurse -Force -ErrorAction SilentlyContinue }
}

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

$ttsRequiredFiles = @($TTS_FILES + $TTS_ESPEAK_FILES)
$ttsMissing = @($ttsRequiredFiles | Where-Object { -not (Test-Path (Join-Path $ttsModelDir $_)) })
$ttsReady = $ttsMissing.Count -eq 0
if (-not $ttsReady) {
  Write-Warning "      Some TTS model files could not be downloaded. ROSIE voice output is blocked until setup is repaired."
} else {
  Write-Host "      TTS models ready at: $ttsModelDir"
  $TTS_HF_REPO | Out-File -FilePath $ttsVersionFile -Encoding utf8
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
$llmInstallError = ""
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
    $llmInstallError = $_.Exception.Message
    Write-Warning "      Gemma model verification/download failed: $($_.Exception.Message)"
    Write-Warning "      ROSIE LLM is blocked until Install-RosieAiStack.ps1 completes successfully."
  }
}

# Write component status and only mark the stack ready when every runtime component is usable.
$llmReady = Test-Path $modelDest
$binaryMissing = @(@("llama-server.exe", "sherpa-onnx-offline.exe", "sherpa-onnx-offline-tts.exe") | Where-Object {
  -not (Test-Path (Join-Path $binDestDir $_))
})
$binariesReady = $binaryMissing.Count -eq 0
$stackReady = $binariesReady -and $sttReady -and $ttsReady -and $llmReady
$statusPath = Join-Path $rosieRoot "rosie_status.json"
$status = [pscustomobject]@{
  ready = $stackReady
  generated_at = (Get-Date).ToString("o")
  components = [pscustomobject]@{
    binaries = [pscustomobject]@{
      ready = $binariesReady
      missing = $binaryMissing
      llama_version = $LLAMA_VERSION
      sherpa_version = $SHERPA_VERSION
    }
    llm = [pscustomobject]@{
      ready = $llmReady
      model_path = $modelDest
      model_filename = $pin.filename
      sha256 = $pin.sha256
    }
    stt = [pscustomobject]@{
      ready = $sttReady
      model_dir = $sttModelDir
      missing = $sttMissing
      source = $STT_HF_REPO
    }
    tts = [pscustomobject]@{
      ready = $ttsReady
      model_dir = $ttsModelDir
      missing = $ttsMissing
      source = $TTS_HF_REPO
    }
  }
}
$status | ConvertTo-Json -Depth 6 | Out-File -FilePath $statusPath -Encoding utf8
Write-Host "      Wrote ROSIE component status: $statusPath"

$readyFlag = Join-Path $rosieRoot "rosie_ready"
if ($stackReady) {
  "READY" | Out-File -FilePath $readyFlag -Encoding utf8
  Write-Host "      Created ready flag file: $readyFlag"
} else {
  if (Test-Path $readyFlag) { Remove-Item $readyFlag -Force -ErrorAction SilentlyContinue }
  Write-Warning "      ROSIE stack is not fully ready. See $statusPath for component details."
  $failureReason = if (-not [string]::IsNullOrWhiteSpace($llmInstallError)) {
    " Gemma setup error: $llmInstallError"
  } else {
    ""
  }
  throw "ROSIE setup did not complete. LLM, STT, TTS, and required binaries must all be ready before the Main Hub can rely on ROSIE.$failureReason"
}

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
  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_UPSTREAM" "http://127.0.0.1:8080"
  $envLines = Set-EnvLine $envLines "ROSIE_PROVIDER_MODE" "local-gemma"
  $envLines = Set-EnvLine $envLines "ROSIE_FORCE_LOCAL_FOR_SENSITIVE" "true"

  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllLines($serverEnvPath, $envLines, $utf8NoBom)
  Write-Host "      Server .env updated."

  $startScriptSource = Join-Path $ScriptRoot "start-riverside-llama.ps1"
  $watchdogScriptSource = Join-Path $ScriptRoot "watch-rosie-stack.ps1"
  $startScriptDest = Join-Path $ServerInstallRoot "start-riverside-llama.ps1"
  $watchdogScriptDest = Join-Path $ServerInstallRoot "watch-rosie-stack.ps1"
  if (Test-Path $startScriptSource) {
    Copy-Item $startScriptSource $startScriptDest -Force
  }
  if (Test-Path $watchdogScriptSource) {
    Copy-Item $watchdogScriptSource $watchdogScriptDest -Force
  }

  if (Test-Path $startScriptDest) {
    Write-Host "      Registering and starting the ROSIE LLM Host task..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScriptDest -InstallRoot $ServerInstallRoot | Out-Null
  }

  if (Test-Path $watchdogScriptDest) {
    $watchdogTaskName = "Riverside OS ROSIE Watchdog"
    Write-Host "      Registering ROSIE watchdog task..."
    Unregister-ScheduledTask -TaskName $watchdogTaskName -Confirm:$false -ErrorAction SilentlyContinue
    $watchdogAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$watchdogScriptDest`" -InstallRoot `"$ServerInstallRoot`""
    $startupTrigger = New-ScheduledTaskTrigger -AtStartup
    $repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    Register-ScheduledTask -TaskName $watchdogTaskName -Action $watchdogAction -Trigger @($startupTrigger, $repeatTrigger) -Principal $principal -Settings $settings | Out-Null
    Start-ScheduledTask -TaskName $watchdogTaskName
    Write-Host "      ROSIE watchdog registered."
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
