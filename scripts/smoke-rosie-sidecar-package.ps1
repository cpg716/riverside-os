[CmdletBinding()]
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [switch]$AllowMissingModel
)

$ErrorActionPreference = "Stop"

function Assert-FileNonEmpty([string]$Path, [string]$Description) {
  if (-not (Test-Path $Path -PathType Leaf)) {
    throw "$Description not found: $Path"
  }
  $item = Get-Item $Path
  if ($item.Length -le 0) {
    throw "$Description is empty: $Path"
  }
}

function Resolve-SmokeEnv([string]$Name, [string]$DefaultValue) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = $DefaultValue
    [Environment]::SetEnvironmentVariable($Name, $value, "Process")
    Write-Host "$Name was not set; using smoke default: $value"
  }
  return $value
}

function Split-ExtraArgs([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return @()
  }
  return [regex]::Matches($Value, '("[^"]+"|''[^'']+''|\S+)') |
    ForEach-Object { $_.Value.Trim('"', "'") }
}

$binaryDir = Join-Path $RepoRoot "client/src-tauri/binaries"
$windowsSidecar = Join-Path $binaryDir "llama-server-x86_64-pc-windows-msvc.exe"
$tauriConfigPath = Join-Path $RepoRoot "client/src-tauri/tauri.conf.json"
$capabilityPath = Join-Path $RepoRoot "client/src-tauri/capabilities/default.json"

if ($IsWindows -or (Test-Path $windowsSidecar)) {
  Assert-FileNonEmpty $windowsSidecar "Windows ROSIE llama-server sidecar"
  $dlls = Get-ChildItem -Path $binaryDir -Filter "*.dll" -File -ErrorAction SilentlyContinue
  if (-not $dlls -or $dlls.Count -lt 1) {
    throw "No ROSIE llama-server DLLs found beside the Windows sidecar in $binaryDir"
  }
  Write-Host "Windows ROSIE sidecar present: $windowsSidecar"
  Write-Host "ROSIE sidecar DLL count: $($dlls.Count)"
} else {
  Write-Host "Windows ROSIE sidecar binary is not present on this non-Windows checkout; Windows CI verifies it after download."
}

$tauriConfig = Get-Content $tauriConfigPath -Raw | ConvertFrom-Json
$externalBins = @($tauriConfig.bundle.externalBin)
if ($externalBins -notcontains "binaries/llama-server") {
  throw "client/src-tauri/tauri.conf.json must include externalBin entry binaries/llama-server"
}

$capability = Get-Content $capabilityPath -Raw | ConvertFrom-Json
$sidecarAllowed = $false
foreach ($permission in @($capability.permissions)) {
  if ($permission.identifier -ne "shell:allow-execute") {
    continue
  }
  foreach ($allow in @($permission.allow)) {
    if ($allow.name -eq "binaries/llama-server" -and $allow.sidecar -eq $true) {
      $sidecarAllowed = $true
    }
  }
}
if (-not $sidecarAllowed) {
  throw "client/src-tauri/capabilities/default.json must allow binaries/llama-server as a sidecar"
}

$hostName = Resolve-SmokeEnv "RIVERSIDE_LLAMA_HOST" "127.0.0.1"
$port = Resolve-SmokeEnv "RIVERSIDE_LLAMA_PORT" "18080"
$extraArgs = Resolve-SmokeEnv "RIVERSIDE_LLAMA_EXTRA_ARGS" "--reasoning off"
$modelPath = Resolve-SmokeEnv "RIVERSIDE_LLAMA_MODEL_PATH" (Join-Path ([IO.Path]::GetTempPath()) "missing-rosie-model.gguf")

if ($extraArgs -notmatch '(^|\s)--reasoning\s+off(\s|$)') {
  throw "RIVERSIDE_LLAMA_EXTRA_ARGS must include '--reasoning off' for ROSIE insight runtime smoke; performance profile flags are enforced by the launchers"
}

if (-not (Test-Path $modelPath -PathType Leaf)) {
  if ($AllowMissingModel) {
    Write-Host "ROSIE model asset intentionally skipped for smoke: $modelPath"
    Write-Host "ROSIE sidecar package smoke passed without launch."
    exit 0
  }
  throw "ROSIE model asset missing at $modelPath. Set RIVERSIDE_LLAMA_MODEL_PATH or pass -AllowMissingModel for CI package smoke."
}

Assert-FileNonEmpty $windowsSidecar "Windows ROSIE llama-server sidecar"

$stdout = Join-Path ([IO.Path]::GetTempPath()) "rosie-llama-smoke.stdout.log"
$stderr = Join-Path ([IO.Path]::GetTempPath()) "rosie-llama-smoke.stderr.log"
$args = @("-m", $modelPath, "--host", $hostName, "--port", $port) + @(Split-ExtraArgs $extraArgs)
$process = $null
$baseUrl = "http://${hostName}:${port}"

try {
  $process = Start-Process -FilePath $windowsSidecar -ArgumentList $args -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr

  $healthy = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      Invoke-WebRequest -Uri "$baseUrl/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
      $healthy = $true
      break
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  if (-not $healthy) {
    throw "ROSIE sidecar did not respond at $baseUrl/health"
  }

  try {
    Invoke-WebRequest -Uri "$baseUrl/v1/models" -UseBasicParsing -TimeoutSec 5 | Out-Null
    Write-Host "ROSIE sidecar /v1/models responded."
  } catch {
    Write-Host "ROSIE sidecar /v1/models check skipped after healthy /health: $($_.Exception.Message)"
  }

  Write-Host "ROSIE sidecar package smoke passed with live health check."
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    $process.WaitForExit(5000) | Out-Null
  }
  Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue
}
