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

function Resolve-LlamaPerfProfile([string]$Requested) {
  $profile = "$Requested".Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($profile) -or $profile -eq "auto") {
    $cpuName = ""
    try {
      $cpuName = "$((Get-CimInstance Win32_Processor | Select-Object -First 1).Name)"
    } catch {
      $cpuName = ""
    }
    if ($cpuName -match "8840U") { return "minisforum-v3" }
    if ($cpuName -match "12900") { return "intel-i9-12900" }
    return "portable-cpu"
  }
  if ($profile -in @("intel-i9-12900", "i9-12900", "12900")) { return "intel-i9-12900" }
  if ($profile -in @("minisforum-v3", "amd-8840u", "ryzen-8840u")) { return "minisforum-v3" }
  if ($profile -in @("apple-m3-pro", "m3-pro")) { return "apple-m3-pro" }
  if ($profile -in @("apple-m3-pro-cpu", "m3-pro-cpu")) { return "apple-m3-pro-cpu" }
  if ($profile -in @("portable-cpu", "cpu-portable")) { return "portable-cpu" }
  return "portable-cpu"
}

function Resolve-LlamaPerfArgs([string]$Requested) {
  $profile = Resolve-LlamaPerfProfile $Requested
  switch ($profile) {
    "intel-i9-12900" { return "--threads 8 --threads-batch 8 --cpu-mask 0xFFFF --cpu-mask-batch 0xFFFF --cpu-strict 1 --cpu-strict-batch 1 --gpu-layers 0 --device none --flash-attn on --mmap --mlock" }
    "minisforum-v3" { return "--threads 8 --threads-batch 8 --cpu-mask 0xFFFF --cpu-mask-batch 0xFFFF --cpu-strict 1 --cpu-strict-batch 1 --gpu-layers 0 --device none --flash-attn on --mmap --mlock" }
    "apple-m3-pro" { return "--threads 6 --threads-batch 6 --gpu-layers 99 --flash-attn on --mmap" }
    "apple-m3-pro-cpu" { return "--threads 6 --threads-batch 6 --gpu-layers 0 --device none --flash-attn on --mmap" }
    default { return "--threads 6 --threads-batch 6 --gpu-layers 0 --device none --flash-attn on --mmap" }
  }
}

function Resolve-BoundedInt([string]$Value, [int]$Default, [int]$Minimum, [int]$Maximum, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $Default }
  $parsed = 0
  if (-not [int]::TryParse($Value, [ref]$parsed) -or $parsed -lt $Minimum -or $parsed -gt $Maximum) {
    throw "$Label must be an integer between $Minimum and $Maximum."
  }
  return $parsed
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
$mmprojPath = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_MMPROJ_PATH"
$hostName = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_HOST"
$port = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_PORT"
$llamaPerfProfile = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_PERF_PROFILE"
$contextSizeValue = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_CONTEXT_SIZE"
$parallelValue = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_PARALLEL"
$batchSizeValue = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_BATCH_SIZE"
$ubatchSizeValue = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_UBATCH_SIZE"
$extraArgs = Read-ServerEnvValue $envPath "RIVERSIDE_LLAMA_EXTRA_ARGS"
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
  throw "llama-server.exe was not found under $InstallRoot\rosie\bin. Re-run Install-RosieAiStack.ps1 or install-server.ps1 after network connectivity is restored."
}

if ([string]::IsNullOrWhiteSpace($modelPath) -or -not (Test-Path $modelPath)) {
  throw "RIVERSIDE_LLAMA_MODEL_PATH is missing or the GGUF file does not exist. Run Install-RosieAiStack.ps1 or complete server install with ROSIE setup."
}

$taskName = "Riverside OS LLM Host"
$llamaPerfArgs = Resolve-LlamaPerfArgs $llamaPerfProfile
$resolvedLlamaPerfProfile = Resolve-LlamaPerfProfile $llamaPerfProfile
$contextSize = Resolve-BoundedInt $contextSizeValue 16384 2048 131072 "RIVERSIDE_LLAMA_CONTEXT_SIZE"
$parallel = Resolve-BoundedInt $parallelValue 2 1 8 "RIVERSIDE_LLAMA_PARALLEL"
$batchSize = Resolve-BoundedInt $batchSizeValue 512 32 2048 "RIVERSIDE_LLAMA_BATCH_SIZE"
$ubatchSize = Resolve-BoundedInt $ubatchSizeValue 512 256 $batchSize "RIVERSIDE_LLAMA_UBATCH_SIZE"
Write-Host "Applying llama.cpp performance profile '$resolvedLlamaPerfProfile'."
Write-Host "Runtime tuning: context=$contextSize, parallel=$parallel, batch=$batchSize, ubatch=$ubatchSize."
$argument = "-m `"$modelPath`" --host $hostName --port $port --ctx-size $contextSize --parallel $parallel --batch-size $batchSize --ubatch-size $ubatchSize --cont-batching $llamaPerfArgs"
if (-not [string]::IsNullOrWhiteSpace($mmprojPath) -and (Test-Path $mmprojPath)) {
  $argument = "$argument --mmproj `"$mmprojPath`""
}
if (-not [string]::IsNullOrWhiteSpace($extraArgs)) {
  $argument = "$argument $extraArgs"
}
$llamaDir = Split-Path -Parent $llamaExe

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute $llamaExe -Argument $argument -WorkingDirectory $llamaDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

if (-not $NoStart) {
  Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName $taskName
  Write-Host "Started $taskName -> http://${hostName}:${port}/"
}
