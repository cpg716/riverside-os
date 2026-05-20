[CmdletBinding()]
param(
  [string]$ConfigPath = "",
  [switch]$SkipDatabaseCreate,
  [switch]$SkipMigrations,
  [switch]$SkipFirewall,
  [switch]$SkipRosieSetup,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$script:lastNativeCommandOutput = ""

$ScriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ScriptRoot)) {
  $ScriptRoot = if ($MyInvocation -and $MyInvocation.MyCommand -and $MyInvocation.MyCommand.Path) {
    Split-Path -Parent $MyInvocation.MyCommand.Path
  } else {
    "."
  }
}

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = $null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })
  if (-not $isAdmin) {
    throw "Run this installer from an elevated PowerShell window."
  }
}

function Set-SafeProperty($Object, $Name, $Value) {
  if ($null -eq $Object) { return }
  if ($Object.PSObject.Properties[$Name]) {
    $Object.$Name = $Value
  } else {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
  }
}

function Resolve-PsqlPath($dbConfig) {
  if ($dbConfig.psqlPath -and (Test-Path $dbConfig.psqlPath)) {
    return $dbConfig.psqlPath
  }
  $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  $matches = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending
  if ($matches) {
    return $matches[0].FullName
  }
  throw "psql.exe was not found. Install PostgreSQL first, or set server.database.psqlPath in the config."
}

function Ensure-PostgresServiceRunning {
  $services = Get-Service -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "postgresql*" -or $_.DisplayName -like "PostgreSQL*" } |
    Sort-Object Name -Descending

  if (-not $services) {
    Write-Warning "No PostgreSQL Windows service was found. Continuing because psql.exe exists, but database connection may fail if PostgreSQL is not running."
    return
  }

  $service = $services[0]
  if ($service.Status -ne "Running") {
    Write-Host "Starting PostgreSQL service $($service.Name)"
    try {
      Start-Service -Name $service.Name
      $service.WaitForStatus("Running", (New-TimeSpan -Seconds 30))
    } catch {
      Write-Warning "Could not start PostgreSQL service '$($service.Name)': $($_.Exception.Message)"
      Write-Warning "Continuing — database operations will fail if PostgreSQL is not reachable."
    }
  }
  try { Set-Service -Name $service.Name -StartupType Automatic } catch {
    Write-Warning "Could not set service startup type: $($_.Exception.Message)"
  }
}

function ConvertTo-NativeArgument([string]$Argument) {
  if ($Argument -notmatch '[\s"]') {
    return $Argument
  }
  return '"' + ($Argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-NativeCommand([string]$FilePath, [string[]]$Arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = ($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join " "
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $script:lastNativeCommandOutput = (($stderr, $stdout) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd() }) -join "`n"

  if ($stdout) {
    Write-Host $stdout.TrimEnd()
  }
  if ($stderr) {
    Write-Host $stderr.TrimEnd()
  }
  return $process.ExitCode
}

function Invoke-Psql($PsqlPath, $DatabaseUrl, $Sql) {
  $temp = New-TemporaryFile
  try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($temp.FullName, $Sql, $utf8NoBom)
    $exitCode = Invoke-NativeCommand $PsqlPath @($DatabaseUrl, "-v", "ON_ERROR_STOP=1", "-f", $temp.FullName)
    if ($exitCode -ne 0) {
      throw "psql failed with exit code $exitCode. $script:lastNativeCommandOutput"
    }
  } finally {
    Remove-Item $temp -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-PsqlFile($PsqlPath, $DatabaseUrl, $FilePath) {
  $exitCode = Invoke-NativeCommand $PsqlPath @($DatabaseUrl, "-v", "ON_ERROR_STOP=1", "-f", $FilePath)
  if ($exitCode -ne 0) {
    throw "psql failed with exit code $exitCode. $script:lastNativeCommandOutput"
  }
}

function Invoke-PsqlScalar($PsqlPath, $DatabaseUrl, [string]$Sql) {
  $result = & $PsqlPath $DatabaseUrl -tAc $Sql
  if ($LASTEXITCODE -ne 0) {
    throw "psql scalar query failed. $($result -join "`n")"
  }
  return (($result -join "").Trim())
}

function Invoke-PsqlAdmin($PsqlPath, $Db, $Sql) {
  $env:PGPASSWORD = $Db.adminPassword
  try {
    $adminUrl = "postgresql://$($Db.adminUser)@$($Db.host):$($Db.port)/postgres"
    Invoke-Psql $PsqlPath $adminUrl $Sql
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

function Invoke-PsqlAdminDatabase($PsqlPath, $Db, $DatabaseName, $Sql) {
  $env:PGPASSWORD = $Db.adminPassword
  try {
    $adminUrl = "postgresql://$($Db.adminUser)@$($Db.host):$($Db.port)/$DatabaseName"
    Invoke-Psql $PsqlPath $adminUrl $Sql
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

function Ensure-OptionalReportingRole($PsqlPath, $Db) {
  try {
    Invoke-PsqlAdmin $PsqlPath $Db "DO `$`$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'metabase_ro') THEN CREATE ROLE metabase_ro NOLOGIN; END IF; END `$`$;"
  } catch {
    Write-Warning "Could not create optional reporting role metabase_ro. Reporting grants will be skipped where supported."
  }
}

function Ensure-DatabaseExtension($PsqlPath, $Db, [string]$DatabaseName, [string]$ExtensionName) {
  try {
    Invoke-PsqlAdminDatabase $PsqlPath $Db $DatabaseName "CREATE EXTENSION IF NOT EXISTS ""$ExtensionName"";"
  } catch {
    Write-Warning "Could not preinstall PostgreSQL extension $ExtensionName. The matching migration will report details if it is required."
  }
}

function Get-DatabaseEncoding($PsqlPath, $Db, [string]$DatabaseName) {
  $env:PGPASSWORD = $Db.adminPassword
  try {
    $adminUrl = "postgresql://$($Db.adminUser)@$($Db.host):$($Db.port)/$DatabaseName"
    $encoding = & $PsqlPath $adminUrl -tAc "SHOW server_encoding;"
    if ($LASTEXITCODE -ne 0) {
      throw "Could not check encoding for database '$DatabaseName'."
    }
    return (($encoding -join "").Trim())
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

function Assert-DatabaseUtf8($PsqlPath, $Db, [string]$DatabaseName) {
  $encoding = Get-DatabaseEncoding $PsqlPath $Db $DatabaseName
  if ($encoding -ne "UTF8") {
    throw "Database '$DatabaseName' is encoded as '$encoding'. Riverside OS requires UTF8. During a fresh failed install, run Reset-RiversideDatabase.cmd, then rerun Backoffice / Server Install."
  }
}

function Ensure-BootstrapAdmin($PsqlPath, $DatabaseUrl) {
  $bootstrapPinHash = '$argon2id$v=19$m=19456,t=2,p=1$KWJoKjtQYNuPjRIyKL2M9g$FBpoET53ejevTU5LrsLTzQMrgXpV5NavqruJmerdPsc'
  $sql = "INSERT INTO staff (full_name, cashier_code, pin_hash, role, is_active, avatar_key) " +
    "VALUES ('Chris G', '1234', '$bootstrapPinHash', 'admin', TRUE, 'ros_default') " +
    "ON CONFLICT (cashier_code) DO UPDATE SET " +
    "full_name = EXCLUDED.full_name, pin_hash = EXCLUDED.pin_hash, role = EXCLUDED.role, " +
    "is_active = TRUE, avatar_key = COALESCE(staff.avatar_key, EXCLUDED.avatar_key); " +
    "DO `$`$ BEGIN " +
    "IF NOT EXISTS (SELECT 1 FROM staff WHERE cashier_code = '1234' AND role = 'admin'::staff_role AND is_active = TRUE AND pin_hash IS NOT NULL) THEN " +
    "RAISE EXCEPTION 'Bootstrap admin was not created.'; END IF; END `$`$;"
  Invoke-Psql $PsqlPath $DatabaseUrl $sql
}

function Stop-RiversideServer {
  Stop-ScheduledTask -TaskName "Riverside OS Server" -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  foreach ($process in Get-Process -Name "riverside-server" -ErrorAction SilentlyContinue) {
    try {
      Stop-Process -Id $process.Id -Force -ErrorAction Stop
    } catch {
      Write-Warning "Could not stop Riverside server process $($process.Id): $($_.Exception.Message)"
    }
  }
}

function Stop-PortListeners([int]$Port) {
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

  foreach ($processId in $listeners) {
    if (-not $processId -or $processId -eq $PID) {
      continue
    }

    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $process) {
      continue
    }

    Write-Host "Stopping process using Riverside port ${Port}: $($process.ProcessName) ($processId)"
    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
    } catch {
      throw "Could not stop process using Riverside port ${Port}: $($process.ProcessName) ($processId). Close it and run install again."
    }
  }
}

function Confirm-InstalledClientVersion($ClientDistPath, [string]$ExpectedVersion, [string]$ExpectedGitShort) {
  if (-not $ExpectedVersion -and -not $ExpectedGitShort) {
    return
  }

  $assetDir = Join-Path $ClientDistPath "assets"
  if (-not (Test-Path $assetDir)) {
    Write-Warning "Client asset folder was not found after install: $assetDir"
    return
  }

  $scripts = Get-ChildItem $assetDir -Filter "*.js" -ErrorAction SilentlyContinue

  if ($ExpectedVersion) {
    $versionMatches = $scripts |
      Select-String -Pattern $ExpectedVersion -SimpleMatch -List -ErrorAction SilentlyContinue |
      Select-Object -First 1

    if ($versionMatches) {
      Write-Host "Installed client bundle version marker found: $ExpectedVersion"
    } else {
      throw "Installed client bundle does not contain expected version marker $ExpectedVersion. Rebuild the full deployment package before deployment."
    }
  }

  if ($ExpectedGitShort) {
    $gitMatches = $scripts |
      Select-String -Pattern $ExpectedGitShort -SimpleMatch -List -ErrorAction SilentlyContinue |
      Select-Object -First 1

    if ($gitMatches) {
      Write-Host "Installed client bundle git marker found: $ExpectedGitShort"
    } else {
      throw "Installed client bundle does not contain expected git marker $ExpectedGitShort. Rebuild the full deployment package before deployment."
    }
  }
}

function Test-RiversideApiReady([string]$BaseUrl, [int]$Port) {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $listener) {
    return $false
  }

  $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if (-not $process -or $process.ProcessName -ne "riverside-server") {
    $owner = if ($process) { "$($process.ProcessName) ($($process.Id))" } else { "process $($listener.OwningProcess)" }
    throw "Port $Port is being used by $owner instead of Riverside OS Server."
  }

  try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/api/staff/list-for-pos" -UseBasicParsing -TimeoutSec 3
    $content = "$($response.Content)".TrimStart()
    return $response.StatusCode -eq 200 -and ($content.StartsWith("[") -or $content.StartsWith("{"))
  } catch {
    Write-Host "API check is not ready yet: $($_.Exception.Message)"
    return $false
  }
}

function Wait-RiversideApiReady([string]$BaseUrl, [int]$Port) {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    if (Test-RiversideApiReady $BaseUrl $Port) {
      return
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  throw "Riverside OS Server did not pass the API check at $BaseUrl/api/staff/list-for-pos."
}

function Ensure-RiversideLlamaHost(
  [string]$PackageRoot,
  [string]$InstallRoot,
  [string]$ModelPath,
  [string]$LlamaHost,
  [int]$LlamaPort
) {
  $llamaSrc = Join-Path $PackageRoot "rosie\bin\llama-server.exe"
  if (-not (Test-Path $llamaSrc)) {
    Write-Warning ("ROSIE: llama-server.exe was not found in this deployment package ($llamaSrc). " +
      "ROSIE chat will stay unavailable until llama-server is running on http://${LlamaHost}:${LlamaPort}/. " +
      "Run Install-RosieAiStack.ps1 after copying a full deployment package, or start the Riverside desktop app on this PC (it can launch the sidecar).")
    return
  }

  if ([string]::IsNullOrWhiteSpace($ModelPath) -or -not (Test-Path $ModelPath)) {
    Write-Warning "ROSIE: LLM model is missing at '$ModelPath'. Skipping Riverside OS LLM Host scheduled task."
    return
  }

  $llamaDir = Join-Path $InstallRoot "rosie\bin"
  New-Item -ItemType Directory -Force -Path $llamaDir | Out-Null
  Copy-Item "$PackageRoot\rosie\bin\*" $llamaDir -Force

  $llamaExe = Join-Path $llamaDir "llama-server.exe"
  $taskName = "Riverside OS LLM Host"
  $argument = "-m `"$ModelPath`" --host $LlamaHost --port $LlamaPort --reasoning off"

  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  $action = New-ScheduledTaskAction -Execute $llamaExe -Argument $argument -WorkingDirectory $llamaDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

  Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName $taskName
  Write-Host "ROSIE: Registered and started scheduled task '$taskName' at http://${LlamaHost}:${LlamaPort}/"
}

function Ensure-RiversideFirewallRule([string]$DisplayName, [int]$Port) {
  Remove-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue
  New-NetFirewallRule `
    -DisplayName $DisplayName `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort $Port `
    -Action Allow `
    -Profile Any | Out-Null
}

function Escape-SqlLiteral([string]$Value) {
  return $Value.Replace("'", "''")
}

function Write-ServerEnv($Path, $Config, $DatabaseUrl, $FrontendDist, $RosieModelPath) {
  $server = $Config.server
  $environmentMode = if ([bool]$server.strictProduction) { "production" } else { "development" }
  $httpBind = $server.httpBind
  if ([string]::IsNullOrWhiteSpace($httpBind)) { $httpBind = "0.0.0.0:3000" }
  $corsOrigins = @($server.corsOrigins) |
    Where-Object { $null -ne $_ -and "$_".Trim() -ne "" } |
    ForEach-Object { "$_".Trim() }
  foreach ($requiredOrigin in @("http://tauri.localhost", "https://tauri.localhost")) {
    if ($corsOrigins -notcontains $requiredOrigin) {
      $corsOrigins += $requiredOrigin
    }
  }
  $lines = @(
    "DATABASE_URL=$DatabaseUrl",
    "FRONTEND_DIST=$FrontendDist",
    "RIVERSIDE_HTTP_BIND=$httpBind",
    "RIVERSIDE_MODE=$environmentMode",
    "RIVERSIDE_STRICT_PRODUCTION=$("$([bool]$server.strictProduction)".ToLowerInvariant())",
    "RIVERSIDE_CORS_ORIGINS=$(($corsOrigins -join ','))",
    "RIVERSIDE_STORE_CUSTOMER_JWT_SECRET=$($server.storeCustomerJwtSecret)",
    "RIVERSIDE_CREDENTIALS_KEY=$($server.storeCustomerJwtSecret)"
  )

  # ROSIE local LLM - write model path so the Axum proxy can derive RIVERSIDE_LLAMA_UPSTREAM
  # at startup. Port stays at the default 8080 unless overridden in config.server.environment.
  if ($RosieModelPath) {
    $lines += "RIVERSIDE_LLAMA_MODEL_PATH=$RosieModelPath"
    $lines += "RIVERSIDE_LLAMA_PORT=8080"
    $lines += "RIVERSIDE_LLAMA_HOST=127.0.0.1"
  }

  if ($server.environment) {
    foreach ($prop in $server.environment.PSObject.Properties) {
      if ($null -ne $prop.Value -and "$($prop.Value)" -ne "") {
        $lines += "$($prop.Name)=$($prop.Value)"
      }
    }
  }

  Set-Content -Path $Path -Value $lines -Encoding UTF8
}

# ---------------------------------------------------------------------------
# ROSIE AI Stack Setup
# Downloads the pinned Gemma GGUF, installs Sherpa-ONNX for SenseVoice STT
# and Kokoro TTS. All assets land in %LOCALAPPDATA%\riverside-os\rosie\.
# Returns the resolved model path (or $null if skipped / failed non-fatally).
# ---------------------------------------------------------------------------
function Install-RosieStack($PackageRoot) {
  $rosieRoot   = Join-Path $env:LOCALAPPDATA "riverside-os\rosie"
  $modelsDir   = Join-Path $rosieRoot "models\gemma-4-e4b"
  $sttDir      = Join-Path $rosieRoot "stt"
  $ttsDir      = Join-Path $rosieRoot "tts"

  # ---- 1. LLM Model (pinned GGUF via MODEL_PIN.json) -----
  $pinPath = Join-Path $PackageRoot "rosie\MODEL_PIN.json"
  if (-not (Test-Path $pinPath)) {
    Write-Warning "ROSIE: MODEL_PIN.json not found at $pinPath. Skipping model download. Copy it from tools/ros-gemma/MODEL_PIN.json into the deployment package."
    return $null
  }
  $pin     = Get-Content -Raw $pinPath | ConvertFrom-Json
  $modelDest = Join-Path $modelsDir $pin.filename
  New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null

  $needsDownload = $true
  if (Test-Path $modelDest) {
    Write-Host "ROSIE: Verifying existing model SHA256..."
    $existingHash = (Get-FileHash -Algorithm SHA256 -Path $modelDest).Hash.ToLowerInvariant()
    if ($existingHash -eq $pin.sha256.ToLowerInvariant()) {
      Write-Host "ROSIE: Model already present and verified: $modelDest"
      $needsDownload = $false
    } else {
      Write-Warning "ROSIE: Existing model hash mismatch. Re-downloading."
      Remove-Item $modelDest -Force
    }
  }

  if ($needsDownload) {
    $modelUrl = "https://huggingface.co/$($pin.huggingface_model_id)/resolve/$($pin.revision)/$($pin.filename)"
    Write-Host "ROSIE: Downloading Gemma model (~$([math]::Round($pin.size_bytes / 1GB, 1)) GB)..."
    Write-Host "ROSIE: From: $modelUrl"
    Write-Host "ROSIE: To:   $modelDest"
    try {
      $headers = @{}
      if ($env:HF_TOKEN) { $headers["Authorization"] = "Bearer $env:HF_TOKEN" }

      $oldProgress = $ProgressPreference
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -Uri $modelUrl -OutFile $modelDest -Headers $headers -UseBasicParsing
      $ProgressPreference = $oldProgress

      $gotHash = (Get-FileHash -Algorithm SHA256 -Path $modelDest).Hash.ToLowerInvariant()
      if ($gotHash -ne $pin.sha256.ToLowerInvariant()) {
        Remove-Item $modelDest -Force
        throw "SHA256 mismatch after download: expected $($pin.sha256) got $gotHash"
      }
      Write-Host "ROSIE: Model downloaded and verified."
    } catch {
      Write-Warning "ROSIE: Model download failed: $($_.Exception.Message). ROSIE will be unavailable until the model is installed manually."
      return $null
    }
  }

  # ---- 2. Sherpa-ONNX (SenseVoice STT + Kokoro TTS) via uv -----
  $uvCmd = Get-Command uv.exe -ErrorAction SilentlyContinue
  if (-not $uvCmd) {
    # Try the standard uv install location
    $uvLocal = Join-Path $env:LOCALAPPDATA "Programs\uv\uv.exe"
    if (Test-Path $uvLocal) {
      $uvCmd = $uvLocal
    } else {
      Write-Host "ROSIE: Installing uv (Python toolchain manager)..."
      try {
        Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
        $uvCmd = Join-Path $env:LOCALAPPDATA "Programs\uv\uv.exe"
      } catch {
        Write-Warning "ROSIE: Could not install uv. SenseVoice STT and Kokoro TTS will be unavailable. Install uv manually from https://astral.sh/uv."
        return $modelDest
      }
    }
  } else {
    $uvCmd = $uvCmd.Source
  }

  Write-Host "ROSIE: Installing sherpa-onnx Python runtime via uv..."
  try {
    & $uvCmd tool install sherpa-onnx 2>&1 | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "uv tool install sherpa-onnx exited $LASTEXITCODE" }
    Write-Host "ROSIE: sherpa-onnx installed."
  } catch {
    Write-Warning "ROSIE: sherpa-onnx install failed: $($_.Exception.Message). Voice features will fall back to Windows TTS."
  }

  # ---- 3. SenseVoice STT model -----
  $sensevoiceDir  = Join-Path $sttDir "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
  $sensevoiceUrl  = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2"
  $sensevoiceModel = Join-Path $sensevoiceDir "model.int8.onnx"
  if (-not (Test-Path $sensevoiceModel)) {
    New-Item -ItemType Directory -Force -Path $sttDir | Out-Null
    $tarDest = Join-Path $env:TEMP "sensevoice.tar.bz2"
    Write-Host "ROSIE: Downloading SenseVoice STT model..."
    try {
      Invoke-WebRequest -Uri $sensevoiceUrl -OutFile $tarDest -UseBasicParsing
      Write-Host "ROSIE: Extracting SenseVoice model..."
      & tar.exe -xjf $tarDest -C $sttDir
      Remove-Item $tarDest -Force -ErrorAction SilentlyContinue
      Write-Host "ROSIE: SenseVoice STT model installed."
    } catch {
      Write-Warning "ROSIE: SenseVoice download failed: $($_.Exception.Message). Voice input will fall back to Windows Speech."
    }
  } else {
    Write-Host "ROSIE: SenseVoice STT model already present."
  }

  # ---- 4. Kokoro TTS model -----
  $kokoroDir    = Join-Path $ttsDir "kokoro-multi-lang-v1_0"
  $kokoroModel  = Join-Path $kokoroDir "model.onnx"
  $kokoroUrl    = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2"
  if (-not (Test-Path $kokoroModel)) {
    New-Item -ItemType Directory -Force -Path $ttsDir | Out-Null
    $tarDest = Join-Path $env:TEMP "kokoro.tar.bz2"
    Write-Host "ROSIE: Downloading Kokoro TTS model..."
    try {
      Invoke-WebRequest -Uri $kokoroUrl -OutFile $tarDest -UseBasicParsing
      Write-Host "ROSIE: Extracting Kokoro TTS model..."
      & tar.exe -xjf $tarDest -C $ttsDir
      Remove-Item $tarDest -Force -ErrorAction SilentlyContinue
      Write-Host "ROSIE: Kokoro TTS model installed."
    } catch {
      Write-Warning "ROSIE: Kokoro download failed: $($_.Exception.Message). Voice output will fall back to Windows TTS."
    }
  } else {
    Write-Host "ROSIE: Kokoro TTS model already present."
  }

  Write-Host "ROSIE: Stack setup complete. Model: $modelDest"
  return $modelDest
}

function Set-MachineEnvironmentFromServerConfig($Config) {
  $server = $Config.server
  [Environment]::SetEnvironmentVariable("RIVERSIDE_CREDENTIALS_KEY", "$($server.storeCustomerJwtSecret)", "Machine")
  [Environment]::SetEnvironmentVariable("RIVERSIDE_STORE_CUSTOMER_JWT_SECRET", "$($server.storeCustomerJwtSecret)", "Machine")
  if ($server.environment) {
    foreach ($prop in $server.environment.PSObject.Properties) {
      $name = "$($prop.Name)"
      $value = "$($prop.Value)"
      if (($name -eq "COUNTERPOINT_SYNC_TOKEN") -and -not [string]::IsNullOrWhiteSpace($value)) {
        [Environment]::SetEnvironmentVariable($name, $value, "Machine")
      }
    }
  }
}

function Get-MigrationSortKey($File) {
  if ($File.Name -match '^(\d+)([a-zA-Z]?)_') {
    return "{0:D6}-{1}-{2}" -f [int]$Matches[1], $Matches[2], $File.Name
  }
  return "999999--$($File.Name)"
}

function Get-MigrationLedgerExists($PsqlPath, $DatabaseUrl) {
  $ledgerCheck = & $PsqlPath $DatabaseUrl -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations');"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not check migration ledger."
  }
  return (($ledgerCheck -join "").Trim() -eq "t")
}

function Get-MigrationApplied($PsqlPath, $DatabaseUrl, [string]$Version) {
  $migrationVersion = Escape-SqlLiteral $Version
  $applied = & $PsqlPath $DatabaseUrl -tAc "SELECT EXISTS(SELECT 1 FROM ros_schema_migrations WHERE version = '$migrationVersion');"
  return (($applied -join "").Trim() -eq "t")
}

function Add-MigrationLedgerEntry($PsqlPath, $DatabaseUrl, [string]$Version) {
  $migrationVersion = Escape-SqlLiteral $Version
  Invoke-Psql $PsqlPath $DatabaseUrl "INSERT INTO ros_schema_migrations (version) SELECT '$migrationVersion' WHERE NOT EXISTS (SELECT 1 FROM ros_schema_migrations WHERE version = '$migrationVersion');"
}

function Test-CoreIdentityMigrationApplied($PsqlPath, $DatabaseUrl) {
  $result = & $PsqlPath $DatabaseUrl -tAc "SELECT to_regclass('public.store_settings') IS NOT NULL AND to_regclass('public.variant_sku_seq') IS NOT NULL;"
  return (($result -join "").Trim() -eq "t")
}

function Apply-Migrations($PsqlPath, $DatabaseUrl, $MigrationsDir) {
  $files = Get-ChildItem $MigrationsDir -Filter "*.sql" |
    Where-Object { $_.Name -match '^\d+[a-zA-Z]?_.*\.sql$' } |
    Sort-Object @{ Expression = { Get-MigrationSortKey $_ } }

  foreach ($file in $files) {
    if (Get-MigrationLedgerExists $PsqlPath $DatabaseUrl) {
      if (Get-MigrationApplied $PsqlPath $DatabaseUrl $file.Name) {
        Write-Host "Skip migration $($file.Name)"
        continue
      }
      if ($file.Name -eq "001_core_identity_staff.sql" -and (Test-CoreIdentityMigrationApplied $PsqlPath $DatabaseUrl)) {
        Write-Host "Recover migration ledger for $($file.Name)"
        Add-MigrationLedgerEntry $PsqlPath $DatabaseUrl $file.Name
        continue
      }
    }

    Write-Host "Apply migration $($file.Name)"
    try {
      Invoke-PsqlFile $PsqlPath $DatabaseUrl $file.FullName
    } catch {
      throw "Migration failed: $($file.Name). $($_.Exception.Message)"
    }
    if (-not (Get-MigrationLedgerExists $PsqlPath $DatabaseUrl)) {
      throw "Migration $($file.Name) did not create public.ros_schema_migrations; cannot record ledger state."
    }
    Add-MigrationLedgerEntry $PsqlPath $DatabaseUrl $file.Name
  }
}

function Apply-SeedFiles($PsqlPath, $DatabaseUrl, $SeedsDir) {
  $requiredSeeds = @(
    "seed_core_required.sql",
    "seed_rbac.sql"
  )

  foreach ($seedName in $requiredSeeds) {
    $seedPath = Join-Path $SeedsDir $seedName
    if (-not (Test-Path $seedPath)) {
      throw "Missing required seed file: $seedPath. Rebuild the deployment package or copy the seeds folder into the package root."
    }

    Write-Host "Apply seed $seedName"
    try {
      Invoke-PsqlFile $PsqlPath $DatabaseUrl $seedPath
    } catch {
      throw "Seed failed: $seedName. $($_.Exception.Message)"
    }
  }
}

function Set-DatabaseEnvironmentMode($PsqlPath, $DatabaseUrl, [bool]$StrictProduction) {
  $mode = if ($StrictProduction) { "production" } else { "development" }
  Invoke-Psql $PsqlPath $DatabaseUrl "UPDATE store_settings SET environment_mode = '$mode' WHERE id = 1;"
  $actualMode = Invoke-PsqlScalar $PsqlPath $DatabaseUrl "SELECT environment_mode FROM store_settings WHERE id = 1;"
  if ($actualMode -ne $mode) {
    throw "Could not stamp database environment_mode as '$mode'. Current value: '$actualMode'."
  }
}

Assert-Admin
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $ScriptRoot "riverside-deployment.config.json"
}
if (-not (Test-Path $ConfigPath)) {
  throw "Config file not found: $ConfigPath. Copy riverside-deployment.config.example.json to riverside-deployment.config.json and fill it in."
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
if (-not $config.server) {
  $config | Add-Member -NotePropertyName server -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $config.server.database) {
  $config.server | Add-Member -NotePropertyName database -NotePropertyValue ([pscustomobject]@{}) -Force
}

function New-RiversideSecret([int]$Length) {
  $chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  $random = New-Object System.Random
  $result = ""
  for ($i = 0; $i -lt $Length; $i++) {
    $result += $chars[$random.Next(0, $chars.Length)]
  }
  return $result
}

function Test-PlaceholderSecret([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
  return $Value -match "replace-" -or $Value -eq "password" -or $Value -eq "placeholder"
}

$configModified = $false

if (Test-PlaceholderSecret $config.server.storeCustomerJwtSecret) {
  Set-SafeProperty $config.server "storeCustomerJwtSecret" (New-RiversideSecret 32)
  $configModified = $true
  Write-Host "Auto-generated secure JWT secret." -ForegroundColor Green
}

if (Test-PlaceholderSecret $config.server.database.appPassword) {
  Set-SafeProperty $config.server.database "appPassword" (New-RiversideSecret 24)
  $configModified = $true
  Write-Host "Auto-generated secure database app password." -ForegroundColor Green
}

if (Test-PlaceholderSecret $config.server.database.adminPassword) {
  $dbHost = $config.server.database.host
  $dbPort = $config.server.database.port
  $dbUser = $config.server.database.adminUser

  Write-Host "PostgreSQL admin password is empty/placeholder. Checking local connection..."
  $tcpClient = New-Object System.Net.Sockets.TcpClient
  $connect = $tcpClient.BeginConnect($dbHost, $dbPort, $null, $null)
  $success = $connect.AsyncWaitHandle.WaitOne(1000, $false)
  if ($success) {
    $tcpClient.EndConnect($connect)
    $tcpClient.Close()

    $psqlCmd = Get-Command psql.exe -ErrorAction SilentlyContinue
    $psqlPath = if ($psqlCmd) { $psqlCmd.Source } else {
      $matches = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
      if ($matches) { $matches[0].FullName } else { "psql.exe" }
    }

    $env:PGPASSWORD = ""
    $testQuery = & $psqlPath -U $dbUser -h $dbHost -p $dbPort -d postgres -c "SELECT 1;" -t 2>&1
    $env:PGPASSWORD = $null

    if ($LASTEXITCODE -eq 0) {
      Write-Host "PostgreSQL trust authentication detected (no password required)." -ForegroundColor Green
      Set-SafeProperty $config.server.database "adminPassword" ""
      $configModified = $true
    } else {
      foreach ($pwd in @("postgres", "admin", "password")) {
        $env:PGPASSWORD = $pwd
        $testQuery = & $psqlPath -U $dbUser -h $dbHost -p $dbPort -d postgres -c "SELECT 1;" -t 2>&1
        $env:PGPASSWORD = $null
        if ($LASTEXITCODE -eq 0) {
          Write-Host "Auto-detected PostgreSQL admin password: '$pwd'" -ForegroundColor Green
          Set-SafeProperty $config.server.database "adminPassword" $pwd
          $configModified = $true
          break
        }
      }
    }
  }
}

if ($configModified) {
  $configJson = $config | ConvertTo-Json -Depth 8
  Set-Content -Path $ConfigPath -Value $configJson -Encoding UTF8
  Write-Host "Auto-saved resolved credentials and passwords to $ConfigPath." -ForegroundColor Green
}
$packageManifestPath = Join-Path $ScriptRoot "deployment-package.manifest.json"
$packageManifest = $null
if (Test-Path $packageManifestPath) {
  $packageManifest = Get-Content $packageManifestPath -Raw | ConvertFrom-Json
}
$server = $config.server
if (-not $server) { throw "Config file is missing the 'server' section. Check your riverside-deployment.config.json." }
$db = $server.database
if (-not $db) { throw "Config file is missing the 'server.database' section. Check your riverside-deployment.config.json." }
if ($db.adminUser -match '^(Admin|Administrator)$') {
  Write-Warning "database.adminUser was '$($db.adminUser)'; using 'postgres' (PostgreSQL superuser)."
  Set-SafeProperty $db "adminUser" "postgres"
}
if ($db.appUser -match '^(Admin|Administrator)$') {
  Write-Warning "database.appUser was '$($db.appUser)'; using 'riverside_app'."
  Set-SafeProperty $db "appUser" "riverside_app"
}
if ([string]::IsNullOrWhiteSpace($db.host))         { Set-SafeProperty $db "host" "127.0.0.1" }
if (-not $db.port)                                   { Set-SafeProperty $db "port" 5432 }
if ([string]::IsNullOrWhiteSpace($db.databaseName))  { Set-SafeProperty $db "databaseName" "riverside_os" }
if ([string]::IsNullOrWhiteSpace($db.appUser))       { Set-SafeProperty $db "appUser" "riverside_app" }
if ([string]::IsNullOrWhiteSpace($db.adminUser))     { Set-SafeProperty $db "adminUser" "postgres" }
$installRoot = $server.installRoot
if ([string]::IsNullOrWhiteSpace($installRoot)) {
  $installRoot = "C:\RiversideOS"
  Write-Host "No installRoot in config - defaulting to $installRoot" -ForegroundColor Yellow
}
$serverDir = Join-Path $installRoot "server"
$clientDist = Join-Path $installRoot "client\dist"
$releaseDir = Join-Path $installRoot "release"
$backupDir = Join-Path $installRoot "backups"
$logDir = Join-Path $installRoot "logs"
$packageServerExe = Join-Path $ScriptRoot "server\riverside-server.exe"
$packageDist = Join-Path $ScriptRoot "client-dist"
$packageMigrations = Join-Path $ScriptRoot "migrations"
$packageSeeds = Join-Path $ScriptRoot "seeds"
$packageReleaseDocs = Join-Path $ScriptRoot "release-docs"

foreach ($dir in @($installRoot, $serverDir, $clientDist, $releaseDir, $backupDir, $logDir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

if (-not (Test-Path $packageServerExe)) {
  throw "Missing server binary in package: $packageServerExe"
}
if (-not (Test-Path $packageDist)) {
  throw "Missing client-dist folder in package: $packageDist"
}
if (-not (Test-Path $packageMigrations)) {
  throw "Missing migrations folder in package: $packageMigrations"
}
if (-not (Test-Path $packageSeeds)) {
  throw "Missing seeds folder in package: $packageSeeds"
}

$taskName = "Riverside OS Server"
$httpBind = $server.httpBind
if ([string]::IsNullOrWhiteSpace($httpBind)) { $httpBind = "0.0.0.0:3000" }
$serverPort = [int](($httpBind -split ":")[-1])
Stop-RiversideServer
Stop-PortListeners $serverPort

Copy-Item $packageServerExe (Join-Path $serverDir "riverside-server.exe") -Force
Remove-Item "$clientDist\*" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$packageDist\*" $clientDist -Recurse -Force
$expectedGitShort = if ($packageManifest) { $packageManifest.sourceGitShort } else { $null }
Confirm-InstalledClientVersion $clientDist $config.releaseVersion $expectedGitShort
Remove-Item "$releaseDir\migrations" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item $packageMigrations (Join-Path $releaseDir "migrations") -Recurse -Force
Remove-Item "$releaseDir\seeds" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item $packageSeeds (Join-Path $releaseDir "seeds") -Recurse -Force
if (Test-Path $packageReleaseDocs) {
  Remove-Item "$releaseDir\docs" -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item $packageReleaseDocs (Join-Path $releaseDir "docs") -Recurse -Force
}

$psql = Resolve-PsqlPath $db
Ensure-PostgresServiceRunning
$databaseUrl = "postgresql://$($db.appUser):$($db.appPassword)@$($db.host):$($db.port)/$($db.databaseName)"

if (-not $SkipDatabaseCreate) {
  $appUser = Escape-SqlLiteral $db.appUser
  $appPassword = Escape-SqlLiteral $db.appPassword
  $databaseName = Escape-SqlLiteral $db.databaseName
  $roleSql = "DO `$`$ BEGIN " +
    "IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$appUser') THEN " +
    "CREATE ROLE ""$appUser"" LOGIN PASSWORD '$appPassword'; " +
    "ELSE ALTER ROLE ""$appUser"" LOGIN PASSWORD '$appPassword'; " +
    "END IF; END `$`$;"
  Invoke-PsqlAdmin $psql $db $roleSql
  $env:PGPASSWORD = $db.adminPassword
  try {
    $exists = & $psql "postgresql://$($db.adminUser)@$($db.host):$($db.port)/postgres" -tAc "SELECT 1 FROM pg_database WHERE datname = '$databaseName';"
    if (($exists -join "").Trim() -ne "1") {
      Invoke-PsqlAdmin $psql $db "CREATE DATABASE ""$databaseName"" WITH OWNER ""$appUser"" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';"
    }
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
  Assert-DatabaseUtf8 $psql $db $databaseName
  Invoke-PsqlAdmin $psql $db "ALTER DATABASE ""$databaseName"" OWNER TO ""$appUser""; GRANT CREATE ON DATABASE ""$databaseName"" TO ""$appUser"";"
  Invoke-PsqlAdminDatabase $psql $db $databaseName "ALTER SCHEMA public OWNER TO ""$appUser""; GRANT ALL ON SCHEMA public TO ""$appUser"";"
  Ensure-OptionalReportingRole $psql $db
}

Assert-DatabaseUtf8 $psql $db $db.databaseName

if (-not $SkipMigrations) {
  $env:PGPASSWORD = $db.appPassword
  try {
    Apply-Migrations $psql $databaseUrl (Join-Path $releaseDir "migrations")
    Apply-SeedFiles $psql $databaseUrl (Join-Path $releaseDir "seeds")
    Set-DatabaseEnvironmentMode $psql $databaseUrl ([bool]$server.strictProduction)
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

$env:PGPASSWORD = $db.appPassword
try {
  Ensure-BootstrapAdmin $psql $databaseUrl
  Write-Host "Bootstrap admin ready: Chris G / Access PIN 1234"
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

# ROSIE AI stack - download model and set up voice tools.
# Runs before the .env is written so the model path can be included.
$rosieModelPath = $null
if (-not $SkipRosieSetup) {
  Write-Host "`n--- ROSIE AI Stack Setup ---"
  $rosieModelPath = Install-RosieStack $ScriptRoot
  if ($rosieModelPath) {
    Write-Host "ROSIE model path: $rosieModelPath"
  } else {
    Write-Warning "ROSIE AI stack was not fully configured. ROSIE will show as unavailable until setup is completed manually. Re-run install-server.ps1 (or just Install-RosieStack) after connectivity is restored."
  }
} else {
  Write-Host "ROSIE setup skipped (-SkipRosieSetup). ROSIE will be unavailable until the model is installed."
}

$envPath = Join-Path $serverDir ".env"
Write-ServerEnv $envPath $config $databaseUrl $clientDist $rosieModelPath
Set-MachineEnvironmentFromServerConfig $config

if (-not $SkipFirewall) {
  $fwName = $server.firewallRuleName
  if ([string]::IsNullOrWhiteSpace($fwName)) { $fwName = "Riverside OS Server" }
  Ensure-RiversideFirewallRule $fwName $serverPort
}

$serverExe = Join-Path $serverDir "riverside-server.exe"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute $serverExe -WorkingDirectory $serverDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

$llamaHost = "127.0.0.1"
$llamaPort = 8080
if ($server.environment) {
  $envHost = "$($server.environment.RIVERSIDE_LLAMA_HOST)".Trim()
  $envPort = "$($server.environment.RIVERSIDE_LLAMA_PORT)".Trim()
  if ($envHost) { $llamaHost = $envHost }
  if ($envPort -and ($envPort -match '^\d+$')) { $llamaPort = [int]$envPort }
}
Ensure-RiversideLlamaHost $ScriptRoot $installRoot $rosieModelPath $llamaHost $llamaPort

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $taskName
  $localUrl = "http://127.0.0.1:$serverPort"
  Wait-RiversideApiReady $localUrl $serverPort
  Write-Host "Riverside OS server API responded at $localUrl"
}

$summary = "Riverside OS Server install complete.`n" +
  "Install root: $installRoot`n" +
  "Server task: $taskName`n" +
  "Frontend: $clientDist`n" +
  "Database: $($db.databaseName) on $($db.host):$($db.port)`n" +
  "Config: $envPath"
Set-Content -Path (Join-Path $installRoot "deployment-summary.txt") -Value $summary -Encoding UTF8
Write-Host $summary
