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

function ConvertTo-DotEnvValue($Value) {
  $text = if ($null -eq $Value) { "" } else { "$Value" }
  if ($text -match "[`r`n]") {
    throw "Server environment values cannot contain line breaks."
  }
  $escaped = $text.Replace('\', '\\').Replace('"', '\"').Replace('$', '\$')
  return '"' + $escaped + '"'
}

function ConvertFrom-DotEnvValue([string]$Value) {
  $text = "$Value".Trim()
  if ($text.Length -lt 2) { return $text }
  if ($text[0] -eq "'" -and $text[$text.Length - 1] -eq "'") {
    return $text.Substring(1, $text.Length - 2)
  }
  if ($text[0] -eq '"' -and $text[$text.Length - 1] -eq '"') {
    $inner = $text.Substring(1, $text.Length - 2)
    return $inner.Replace('\$', '$').Replace('\"', '"').Replace('\\', '\')
  }
  return $text
}

function Read-ServerEnvValue([string]$EnvPath, [string]$Key) {
  if (-not (Test-Path $EnvPath)) { return "" }
  foreach ($line in Get-Content $EnvPath) {
    if ($line -match "^\s*$([regex]::Escape($Key))=(.*)$") {
      return ConvertFrom-DotEnvValue $Matches[1]
    }
  }
  return ""
}

$previousModelPath = Read-ServerEnvValue $serverEnvPath "RIVERSIDE_LLAMA_MODEL_PATH"
$previousMmprojPath = Read-ServerEnvValue $serverEnvPath "RIVERSIDE_LLAMA_MMPROJ_PATH"
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
$SHERPA_VERSION   = "1.13.4"
$SHERPA_ARCH      = "win-x64-shared-MD-Release"
$SHERPA_TAR_NAME  = "sherpa-onnx-v$SHERPA_VERSION-$SHERPA_ARCH.tar.bz2"
$SHERPA_TAR_URL   = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$SHERPA_VERSION/$SHERPA_TAR_NAME"
$SHERPA_TAR_SHA256 = "d4dacc8be5afe03f22ade4d50cfd587c03a625eaca8c41f2d99a24d3db463eab"

# llama.cpp CPU runtime for the Host LLM. This is used when the
# deployment package does not already include rosie\bin\llama-server.exe.
$LLAMA_VERSION    = "b10229"
$LLAMA_ZIP_NAME   = "llama-$LLAMA_VERSION-bin-win-cpu-x64.zip"
$LLAMA_ZIP_URL    = "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_VERSION/$LLAMA_ZIP_NAME"
$LLAMA_ZIP_SHA256 = "142d927c697e9b518c2834b8faecde0a1a8c09acbcf9da62057947c99d2b19c0"

# SenseVoice Small (int8) - STT primary. The older csukuangfj 2024 repo now
# returns 401 for unauthenticated downloads; use the public mirror with the
# same model/tokens file shape.
$STT_MODEL_DIR    = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
$STT_HF_REPO      = "chris-cao/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
$STT_HF_REVISION  = "20dc3ebe15651c2e26d7e07b04fcd84a39c3b920"
$STT_FILES        = @("model.int8.onnx", "tokens.txt")
$STT_FILE_SHA256  = @{
  "model.int8.onnx" = "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"
  "tokens.txt" = "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"
}

# Kokoro-82M multi-lang - TTS primary
$TTS_MODEL_DIR    = "kokoro-multi-lang-v1_1"
$TTS_HF_REPO      = "csukuangfj/kokoro-multi-lang-v1_1"
$TTS_HF_REVISION  = "914313412b607d95400bcd12446233fbd1248801"
$TTS_FILES        = @("model.onnx", "voices.bin", "tokens.txt")
$TTS_ESPEAK_FILES = @(
  "espeak-ng-data/en_dict",
  "espeak-ng-data/phontab",
  "espeak-ng-data/phonindex",
  "espeak-ng-data/phondata",
  "espeak-ng-data/intonations",
  "espeak-ng-data/lang/gmw/en",
  "espeak-ng-data/lang/gmw/en-US",
  "espeak-ng-data/lang/roa/es",
  "espeak-ng-data/lang/roa/fr",
  "espeak-ng-data/lang/gmw/de"
)
$TTS_FILE_SHA256 = @{
  "model.onnx" = "acc4adc175b9d9986106cd20060329673ad5a2e12ef3c557d2d3745b694f8b38"
  "voices.bin" = "e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c"
  "tokens.txt" = "931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14"
  "espeak-ng-data/en_dict" = "71bd330ba8a2e3e8076e631508208ef49449d6147c17b7bd2b4b1e1468292e35"
  "espeak-ng-data/phontab" = "886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6"
  "espeak-ng-data/phonindex" = "3ca7b8fa3b42624e4b0f152707e7a39245fce569aa99ea47c055d9e622fcf0c4"
  "espeak-ng-data/phondata" = "4e0288957874029a8c3c9f41a8f517ad4bf18127046decbdd4b9d1d6807ce3a3"
  "espeak-ng-data/intonations" = "3f8af65fd3eda9759a10f021d61361c120871f463515229c925995c7f90918cc"
  "espeak-ng-data/lang/gmw/en" = "4605d5330801de3641c6e366d15f129ea1f5ffbce8722642aba01ace07ab9c83"
  "espeak-ng-data/lang/gmw/en-US" = "41534c2a22df5dd4f1052ff9e1a33a3ea7bff5a26b5c02bdad5ba8ddb7524704"
  "espeak-ng-data/lang/roa/es" = "966aa015ea5646d79f0ca4807cf5da7339aabd3782b55cfa5eb0d8c3fc8fc588"
  "espeak-ng-data/lang/roa/fr" = "95f44834b48c075dad13eace54d2c98ff79b81aa0074dd67eebaf66c2909eef8"
  "espeak-ng-data/lang/gmw/de" = "f3cca92f94b70f8c25a29ee0a4c9ce4c7f1022241532e0647fa2b7f698bf104e"
}

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
function Get-HfFile([string]$Repo, [string]$Revision, [string]$FilePath, [string]$DestDir, [string]$ExpectedSha256) {
  if ([string]::IsNullOrWhiteSpace($Revision) -or [string]::IsNullOrWhiteSpace($ExpectedSha256)) {
    throw "Immutable revision and SHA256 are required for ROSIE asset '$FilePath'."
  }
  $url      = "https://huggingface.co/$Repo/resolve/$Revision/$FilePath"
  $destPath = Join-Path $DestDir $FilePath
  $destParent = Split-Path $destPath -Parent
  if (-not (Test-Path $destParent)) {
    New-Item -ItemType Directory -Force -Path $destParent | Out-Null
  }
  if (Test-Path $destPath) {
    $existingHash = (Get-FileHash -Algorithm SHA256 -Path $destPath).Hash.ToLowerInvariant()
    if ($existingHash -eq $ExpectedSha256.ToLowerInvariant()) {
      Write-Host "      Verified: $FilePath"
      return
    }
    Write-Warning "      Existing asset hash mismatch for $FilePath. Re-downloading."
    Remove-Item $destPath -Force
  }
  Invoke-Download $url $destPath $FilePath
  $downloadedHash = (Get-FileHash -Algorithm SHA256 -Path $destPath).Hash.ToLowerInvariant()
  if ($downloadedHash -ne $ExpectedSha256.ToLowerInvariant()) {
    Remove-Item $destPath -Force -ErrorAction SilentlyContinue
    throw "SHA256 mismatch for '$FilePath'. Expected $ExpectedSha256, got $downloadedHash."
  }
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
$versionFile = Join-Path $rosieRoot "sherpa_version.txt"
$installedVersion = if (Test-Path $versionFile) { Get-Content $versionFile -Raw } else { "" }
$installedVersion = $installedVersion.Trim()
$installedLlamaVersion = if (Test-Path $llamaVersionFile) { Get-Content $llamaVersionFile -Raw } else { "" }
$installedLlamaVersion = $installedLlamaVersion.Trim()
$missingInstalledSherpa = @($requiredBinaries | Where-Object { -not (Test-Path (Join-Path $binDestDir $_)) })
$sherpaNeedsInstall = ($installedVersion -ne $SHERPA_VERSION) -or ($missingInstalledSherpa.Count -gt 0)
$llamaNeedsInstall = ($installedLlamaVersion -ne $LLAMA_VERSION) -or (-not (Test-Path $destLlama))

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

if ($installedVersion -ne $SHERPA_VERSION) {
  Write-Host "      Sherpa version mismatch (installed: '$installedVersion', script: '$SHERPA_VERSION'). Forcing clean bin update..."
  $requiredBinaries | ForEach-Object {
    $p = Join-Path $binDestDir $_
    if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
  }
}

# Copy bundled binaries only when a runtime pin changed or a required binary is missing.
if ((Test-Path $pkgBinDir) -and ($sherpaNeedsInstall -or $llamaNeedsInstall)) {
  Write-Host "      Copying bundled binaries from package..."
  Copy-Item (Join-Path $pkgBinDir "*") $binDestDir -Force -Recurse -ErrorAction SilentlyContinue
} elseif (-not $sherpaNeedsInstall -and -not $llamaNeedsInstall) {
  Write-Host "      Runtime pins match and required binaries are present; reusing installed binaries."
}

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
  $sherpaHash = (Get-FileHash -Algorithm SHA256 -Path $tarPath).Hash.ToLowerInvariant()
  if ($sherpaHash -ne $SHERPA_TAR_SHA256.ToLowerInvariant()) {
    Remove-Item $tarPath -Force -ErrorAction SilentlyContinue
    throw "sherpa-onnx archive SHA256 mismatch. Expected $SHERPA_TAR_SHA256, got $sherpaHash."
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
$sttPin = "$STT_HF_REPO@$STT_HF_REVISION"
$sttPinChanged = -not [string]::IsNullOrWhiteSpace($installedStt) -and $installedStt -ne $sttPin -and $installedStt -ne $STT_HF_REPO
$sttFilesMissingBefore = @($STT_FILES | Where-Object { -not (Test-Path (Join-Path $sttModelDir $_)) })
$sttNeedsInstall = $sttPinChanged -or ($sttFilesMissingBefore.Count -gt 0)

if ($sttPinChanged) {
  Write-Host "      STT model pin changed (installed: '$installedStt', release: '$sttPin'). Forcing clean update..."
  if (Test-Path $sttModelDir) { Remove-Item $sttModelDir -Recurse -Force -ErrorAction SilentlyContinue }
}

# Copy from the package only when the pin changed or an installed file is missing.
if ((Test-Path $pkgSttDir) -and $sttNeedsInstall) {
  Write-Host "      Copying bundled STT models from package..."
  Copy-Item (Join-Path $pkgSttDir "*") $sttDir -Force -Recurse -ErrorAction SilentlyContinue
} elseif (-not $sttNeedsInstall) {
  Write-Host "      STT pin matches and required files are present; verifying installed assets in place."
}

# Download any missing STT files
New-Item -ItemType Directory -Force -Path $sttModelDir | Out-Null
foreach ($file in $STT_FILES) {
  Get-HfFile $STT_HF_REPO $STT_HF_REVISION $file $sttModelDir $STT_FILE_SHA256[$file]
}

$sttMissing = @($STT_FILES | Where-Object { -not (Test-Path (Join-Path $sttModelDir $_)) })
$sttReady = $sttMissing.Count -eq 0
if (-not $sttReady) {
  Write-Warning "      Some STT model files could not be downloaded. ROSIE voice input is blocked until setup is repaired."
} else {
  Write-Host "      STT models ready at: $sttModelDir"
  $sttPin | Out-File -FilePath $sttVersionFile -Encoding utf8
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
$ttsPin = "$TTS_HF_REPO@$TTS_HF_REVISION"
$ttsPinChanged = -not [string]::IsNullOrWhiteSpace($installedTts) -and $installedTts -ne $ttsPin -and $installedTts -ne $TTS_HF_REPO
$ttsRequiredFiles = @($TTS_FILES + $TTS_ESPEAK_FILES)
$ttsFilesMissingBefore = @($ttsRequiredFiles | Where-Object { -not (Test-Path (Join-Path $ttsModelDir $_)) })
$ttsNeedsInstall = $ttsPinChanged -or ($ttsFilesMissingBefore.Count -gt 0)

if ($ttsPinChanged) {
  Write-Host "      TTS model pin changed (installed: '$installedTts', release: '$ttsPin'). Forcing clean update..."
  if (Test-Path $ttsModelDir) { Remove-Item $ttsModelDir -Recurse -Force -ErrorAction SilentlyContinue }
}

# Copy from the package only when the pin changed or an installed file is missing.
if ((Test-Path $pkgTtsDir) -and $ttsNeedsInstall) {
  Write-Host "      Copying bundled TTS models from package..."
  Copy-Item (Join-Path $pkgTtsDir "*") $ttsDir -Force -Recurse -ErrorAction SilentlyContinue
} elseif (-not $ttsNeedsInstall) {
  Write-Host "      TTS pin matches and required files are present; verifying installed assets in place."
}

# Download any missing TTS files
New-Item -ItemType Directory -Force -Path $ttsModelDir | Out-Null
foreach ($file in $TTS_FILES) {
  Get-HfFile $TTS_HF_REPO $TTS_HF_REVISION $file $ttsModelDir $TTS_FILE_SHA256[$file]
}
# Download espeak-ng-data files (needed for Kokoro phoneme synthesis)
foreach ($file in $TTS_ESPEAK_FILES) {
  Get-HfFile $TTS_HF_REPO $TTS_HF_REVISION $file $ttsModelDir $TTS_FILE_SHA256[$file]
}

$ttsMissing = @($ttsRequiredFiles | Where-Object { -not (Test-Path (Join-Path $ttsModelDir $_)) })
$ttsReady = $ttsMissing.Count -eq 0
if (-not $ttsReady) {
  Write-Warning "      Some TTS model files could not be downloaded. ROSIE voice output is blocked until setup is repaired."
} else {
  Write-Host "      TTS models ready at: $ttsModelDir"
  $ttsPin | Out-File -FilePath $ttsVersionFile -Encoding utf8
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
    huggingface_model_id = "google/gemma-4-E4B-it-qat-q4_0-gguf"
    revision             = "4b4a2c1d584be7264f87aac328a1bc739ce81b6c"
    filename             = "gemma-4-E4B_q4_0-it.gguf"
    sha256               = "676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee"
    size_bytes           = 5154941280
    mmproj_filename      = "gemma-4-E4B-it-mmproj.gguf"
    mmproj_sha256        = "7498a37cb619e55f2fcf87eb931f56e99389ed6d432e4c5c66110694c0d65578"
    mmproj_size_bytes    = 991552256
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

$mmprojDest = Join-Path $modelsDir $pin.mmproj_filename
$needsMmprojDownload = $true
if (Test-Path $mmprojDest) {
  $existingMmprojHash = (Get-FileHash -Algorithm SHA256 -Path $mmprojDest).Hash.ToLowerInvariant()
  if ($existingMmprojHash -eq $pin.mmproj_sha256.ToLowerInvariant()) {
    Write-Host "      OK - Gemma multimodal projector verified successfully."
    $needsMmprojDownload = $false
  } else {
    Write-Warning "      Gemma multimodal projector hash mismatch - re-downloading."
    Remove-Item $mmprojDest -Force
  }
}

if ($needsMmprojDownload -and [string]::IsNullOrWhiteSpace($llmInstallError)) {
  $mmprojUrl = "https://huggingface.co/$($pin.huggingface_model_id)/resolve/$($pin.revision)/$($pin.mmproj_filename)"
  Write-Host "      Downloading $($pin.mmproj_filename) (~$([math]::Round($pin.mmproj_size_bytes / 1GB, 1)) GB)..."
  try {
    Invoke-Download $mmprojUrl $mmprojDest $pin.mmproj_filename
    $gotMmprojHash = (Get-FileHash -Algorithm SHA256 -Path $mmprojDest).Hash.ToLowerInvariant()
    if ($gotMmprojHash -ne $pin.mmproj_sha256.ToLowerInvariant()) {
      Remove-Item $mmprojDest -Force
      throw "Multimodal projector SHA256 mismatch. Expected $($pin.mmproj_sha256), got $gotMmprojHash."
    }
    Write-Host "      Gemma multimodal projector downloaded and verified successfully."
  } catch {
    $llmInstallError = $_.Exception.Message
    Write-Warning "      Gemma multimodal projector download failed: $($_.Exception.Message)"
  }
}

# Write component status and only mark the stack ready when every runtime component is usable.
$llmReady = (Test-Path $modelDest) -and (Test-Path $mmprojDest)
$binaryMissing = @(@("llama-server.exe", "sherpa-onnx-offline.exe", "sherpa-onnx-offline-tts.exe") | Where-Object {
  -not (Test-Path (Join-Path $binDestDir $_))
})
$binariesReady = $binaryMissing.Count -eq 0
$stackReady = $binariesReady -and $sttReady -and $ttsReady -and $llmReady
$statusPath = Join-Path $rosieRoot "rosie_status.json"
$status = [pscustomobject]@{
  ready = $false
  installation_ready = $stackReady
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
      mmproj_path = $mmprojDest
      mmproj_filename = $pin.mmproj_filename
      mmproj_sha256 = $pin.mmproj_sha256
    }
    stt = [pscustomobject]@{
      ready = $sttReady
      model_dir = $sttModelDir
      missing = $sttMissing
      source = $STT_HF_REPO
      revision = $STT_HF_REVISION
    }
    tts = [pscustomobject]@{
      ready = $ttsReady
      model_dir = $ttsModelDir
      missing = $ttsMissing
      source = $TTS_HF_REPO
      revision = $TTS_HF_REVISION
    }
  }
}
$status | ConvertTo-Json -Depth 6 | Out-File -FilePath $statusPath -Encoding utf8
Write-Host "      Wrote ROSIE component status: $statusPath"

$readyFlag = Join-Path $rosieRoot "rosie_ready"
if ($stackReady) {
  if (Test-Path $readyFlag) { Remove-Item $readyFlag -Force -ErrorAction SilentlyContinue }
  Write-Host "      Assets verified. Functional watchdog certification is still required."
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
  Write-Host "      Server .env patch skipped by request (-SkipEnvPatch). Full Main Hub installs write .env after ROSIE returns."
} elseif (-not (Test-Path $serverEnvPath)) {
  Write-Warning "      Server .env not found at: $serverEnvPath - skipping environment variables configuration."
} else {
  $envLines = Get-Content $serverEnvPath -Encoding UTF8

  function Set-EnvLine([string[]]$Lines, [string]$Key, [string]$Value) {
    $serialized = ConvertTo-DotEnvValue $Value
    $found = $false
    $out = $Lines | ForEach-Object {
      if ($_ -match "^$Key=") { $found = $true; "$Key=$serialized" }
      else { $_ }
    }
    if (-not $found) { $out += "$Key=$serialized" }
    return $out
  }

  if (Test-Path $modelDest) {
    $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_MODEL_PATH" $modelDest
    $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_MMPROJ_PATH" $mmprojDest
  }
  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_HOST" "127.0.0.1"
  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_PORT" "8080"
  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_UPSTREAM" "http://127.0.0.1:8080"
  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_CONTEXT_SIZE" "16384"
  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_PARALLEL" "2"
  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_BATCH_SIZE" "512"
  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_UBATCH_SIZE" "512"
  $envLines = Set-EnvLine $envLines "ROSIE_PROVIDER_MODE" "local-gemma"
  $envLines = Set-EnvLine $envLines "ROSIE_STT_PROVIDER" "local"
  $envLines = Set-EnvLine $envLines "ROSIE_TTS_PROVIDER" "local"
  $envLines = Set-EnvLine $envLines "ROSIE_ALLOW_CLOUD_PROVIDERS" "false"
  $envLines = Set-EnvLine $envLines "ROSIE_ENABLE_ANALYSIS_REASONING" "false"
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
    Write-Host "      Running bounded LLM/STT/TTS functional certification..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdogScriptDest -InstallRoot $ServerInstallRoot -FullCertification
    if ($LASTEXITCODE -ne 0) {
      if (-not [string]::IsNullOrWhiteSpace($previousModelPath) -and (Test-Path $previousModelPath)) {
        Write-Warning "      New Gemma model certification failed. Restoring the previously configured model path."
        $rollbackLines = Get-Content $serverEnvPath -Encoding UTF8
        $rollbackLines = Set-EnvLine $rollbackLines "RIVERSIDE_LLAMA_MODEL_PATH" $previousModelPath
        $rollbackLines = Set-EnvLine $rollbackLines "RIVERSIDE_LLAMA_MMPROJ_PATH" $previousMmprojPath
        [System.IO.File]::WriteAllLines($serverEnvPath, $rollbackLines, $utf8NoBom)
        Stop-ScheduledTask -TaskName "Riverside OS LLM Host" -ErrorAction SilentlyContinue
        Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScriptDest -InstallRoot $ServerInstallRoot | Out-Null
      }
      throw "ROSIE functional certification failed. See $statusPath."
    }
    foreach ($supersededAsset in @($previousModelPath, $previousMmprojPath)) {
      if (
        -not [string]::IsNullOrWhiteSpace($supersededAsset) -and
        $supersededAsset -ne $modelDest -and
        $supersededAsset -ne $mmprojDest -and
        (Test-Path $supersededAsset) -and
        [IO.Path]::GetFullPath((Split-Path -Parent $supersededAsset)).TrimEnd('\') -eq [IO.Path]::GetFullPath($modelsDir).TrimEnd('\')
      ) {
        Write-Host "      Removing superseded certified ROSIE model asset: $(Split-Path -Leaf $supersededAsset)"
        Remove-Item $supersededAsset -Force
      }
    }
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
