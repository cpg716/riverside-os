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

# ============================================================
# STEP 1 - Binary Verification and Extraction
# ============================================================
Write-Host "[1/3] Verifying and extracting pre-compiled binaries..."
$pkgRosieDir = Join-Path $ScriptRoot "rosie"
$pkgBinDir   = Join-Path $pkgRosieDir "bin"

$requiredBinaries = @(
  "llama-server.exe",
  "sherpa-onnx-offline.exe",
  "sherpa-onnx-offline-tts.exe"
)

foreach ($bin in $requiredBinaries) {
  $pkgBinPath = Join-Path $pkgBinDir $bin
  if (-not (Test-Path $pkgBinPath)) {
    Write-Error "Required ROSIE binary '$bin' is missing from the package at: $pkgBinPath"
    Write-Error "Please Rebuild the deployment package with the required pre-compiled binaries."
    throw "Missing binary: $bin"
  }
}

# Ensure destination directories exist
New-Item -ItemType Directory -Force -Path $binDestDir | Out-Null
New-Item -ItemType Directory -Force -Path $sttDir | Out-Null
New-Item -ItemType Directory -Force -Path $ttsDir | Out-Null

# Copy binaries
Write-Host "      Copying binaries to destination: $binDestDir"
Copy-Item (Join-Path $pkgBinDir "*") $binDestDir -Force -Recurse

# Copy models if present in the package
if (Test-Path (Join-Path $pkgRosieDir "stt")) {
  Write-Host "      Extracting STT models..."
  Copy-Item (Join-Path $pkgRosieDir "stt\*") $sttDir -Force -Recurse
}
if (Test-Path (Join-Path $pkgRosieDir "tts")) {
  Write-Host "      Extracting TTS models..."
  Copy-Item (Join-Path $pkgRosieDir "tts\*") $ttsDir -Force -Recurse
}

# ============================================================
# STEP 2 - GGUF model download and integrity check
# ============================================================
Write-Host "[2/3] Verification of Gemma GGUF model..."

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
  $sizeMb  = [math]::Round($pin.size_bytes / 1MB)
  $modelUrl = "https://huggingface.co/$($pin.huggingface_model_id)/resolve/$($pin.revision)/$($pin.filename)"
  Write-Host "      Downloading $($pin.filename) (~$([math]::Round($pin.size_bytes / 1GB, 1)) GB) from Hugging Face..."
  try {
    $headers = @{}
    $effectiveToken = if ($HfToken) { $HfToken } elseif ($env:HF_TOKEN) { $env:HF_TOKEN } else { "" }
    if ($effectiveToken) { $headers["Authorization"] = "Bearer $effectiveToken" }
    
    $oldProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $modelUrl -OutFile $modelDest -Headers $headers -UseBasicParsing
    $ProgressPreference = $oldProgress
    
    $gotHash = (Get-FileHash -Algorithm SHA256 -Path $modelDest).Hash.ToLowerInvariant()
    if ($gotHash -ne $pin.sha256.ToLowerInvariant()) {
      Remove-Item $modelDest -Force
      throw "SHA256 mismatch after download. Expected $($pin.sha256), got $gotHash."
    }
    Write-Host "      Gemma model downloaded and verified successfully."
  } catch {
    Write-Error "      Gemma model verification/download failed: $($_.Exception.Message)"
    throw "Gemma model setup failed."
  }
}

# Write ready flag file
$readyFlag = Join-Path $rosieRoot "rosie_ready"
"READY" | Out-File -FilePath $readyFlag -Encoding utf8
Write-Host "      Created ready flag file: $readyFlag"

# ============================================================
# STEP 3 - Patch server .env
# ============================================================
Write-Host "[3/3] Patching server env..."
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

  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_MODEL_PATH" $modelDest
  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_HOST" "127.0.0.1"
  $envLines = Set-EnvLine $envLines "RIVERSIDE_LLAMA_PORT" "8080"

  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllLines($serverEnvPath, $envLines, $utf8NoBom)
  Write-Host "      Server .env updated."

  # Restart LLM scheduled task if registered
  $taskName = "Riverside OS LLM Host"
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
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
Write-Host "  ROSIE is Ready."
Write-Host "========================================================"
Write-Host ""
