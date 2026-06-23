[CmdletBinding()]
param(
  [string]$Version = "0.80.8",
  [string]$OutputDir = "$PSScriptRoot\..\..\dist\deployment",
  [string]$ServerBinaryPath = "$PSScriptRoot\..\..\target\release\riverside-server.exe",
  [string]$ClientDistPath = "$PSScriptRoot\..\..\client\dist",
  [string]$RegisterBundlePath = "$PSScriptRoot\..\..\target\release\bundle",
  [string]$ManagerBinaryPath = "$PSScriptRoot\..\..\target\release\riverside-deployment-manager.exe",
  [string]$ServerManagerBinaryPath = "$PSScriptRoot\..\..\target\release\ros-server-manager.exe",
  [string]$ManagerBundlePath = "$PSScriptRoot\..\..\target\release\deployment-manager-bundle",
  [string]$ServerManagerBundlePath = "$PSScriptRoot\..\..\target\release\server-manager-bundle",
  [ValidateSet("Windows-Deployment", "MainHub-Update")]
  [string]$PackageFlavor = "Windows-Deployment",
  [switch]$AllowMissingRegisterBundle,
  [switch]$AllowMissingManagerBinary,
  [switch]$AllowMissingServerManagerBinary
)

$ErrorActionPreference = "Stop"

function Resolve-FullPath([string]$Path) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Get-GitShort([string]$RepoRoot) {
  try {
    return (& git -C $RepoRoot rev-parse --short=8 HEAD 2>$null).Trim()
  } catch {
    return "unknown"
  }
}

function Get-GitFull([string]$RepoRoot) {
  try {
    return (& git -C $RepoRoot rev-parse HEAD 2>$null).Trim()
  } catch {
    return "unknown"
  }
}

function Assert-ClientDistMatchesSource([string]$ClientDistPath, [string]$Version, [string]$GitShort) {
  $assetDir = Join-Path $ClientDistPath "assets"
  if (-not (Test-Path $assetDir)) {
    throw "Client asset folder not found: $assetDir"
  }

  $scripts = Get-ChildItem $assetDir -Filter "*.js" -ErrorAction SilentlyContinue
  if (-not $scripts) {
    throw "No client JavaScript assets found in $assetDir. Rebuild the client before packaging."
  }

  $versionMatch = $scripts |
    Select-String -Pattern $Version -SimpleMatch -List -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $versionMatch) {
    throw "Client dist does not contain version marker $Version. Rebuild client/dist before packaging."
  }

  if ($GitShort -and $GitShort -ne "unknown") {
    $gitMatch = $scripts |
      Select-String -Pattern $GitShort -SimpleMatch -List -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $gitMatch) {
      throw "Client dist does not contain git marker $GitShort. Rebuild client/dist from the current commit before packaging."
    }
  }
}

function Get-DownloadRetryDelaySeconds([System.Management.Automation.ErrorRecord]$ErrorRecord, [int]$Attempt) {
  $downloadException = Get-DownloadException $ErrorRecord
  $response = $downloadException.Response
  if ($response -and $response.Headers) {
    $retryAfter = $response.Headers["Retry-After"]
    if ($retryAfter) {
      $seconds = 0.0
      if ([double]::TryParse($retryAfter, [ref]$seconds) -and $seconds -ge 0) {
        return [Math]::Max(1, [int][Math]::Ceiling($seconds))
      }

      try {
        $retryAt = [DateTimeOffset]::Parse($retryAfter)
        $wait = [int][Math]::Ceiling(($retryAt - [DateTimeOffset]::UtcNow).TotalSeconds)
        return [Math]::Max(1, $wait)
      } catch {
        # Fall through to the status-code fallback.
      }
    }
  }

  if ($response -and [int]$response.StatusCode -eq 429) {
    return 65
  }

  return [Math]::Min(60, [int](5 * [Math]::Pow(2, [Math]::Max(0, $Attempt - 1))))
}

function Get-DownloadException([System.Management.Automation.ErrorRecord]$ErrorRecord) {
  $exception = $ErrorRecord.Exception
  while ($exception.InnerException) {
    $exception = $exception.InnerException
  }

  return $exception
}

function Test-IsTransientDownloadError([System.Management.Automation.ErrorRecord]$ErrorRecord) {
  $downloadException = Get-DownloadException $ErrorRecord
  $response = $downloadException.Response
  if ($response -and $response.StatusCode) {
    $statusCode = [int]$response.StatusCode
    return ($statusCode -eq 429 -or ($statusCode -ge 500 -and $statusCode -lt 600))
  }

  $status = $downloadException.Status
  return ($status -in @(
    [System.Net.WebExceptionStatus]::ConnectFailure,
    [System.Net.WebExceptionStatus]::ConnectionClosed,
    [System.Net.WebExceptionStatus]::KeepAliveFailure,
    [System.Net.WebExceptionStatus]::NameResolutionFailure,
    [System.Net.WebExceptionStatus]::ReceiveFailure,
    [System.Net.WebExceptionStatus]::SendFailure,
    [System.Net.WebExceptionStatus]::Timeout
  ))
}

function Invoke-DownloadFile([string]$Url, [string]$OutFile, [string]$Label) {
  $maxAttempts = 5
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    Write-Host "Downloading $Label (attempt $attempt/$maxAttempts)..."
    $client = New-Object System.Net.WebClient
    try {
      $client.Headers.Add("User-Agent", "RiversideOS-Deployment-Packager")
      if (Test-Path $OutFile) { Remove-Item $OutFile -Force -ErrorAction SilentlyContinue }
      $client.DownloadFile($Url, $OutFile)
      return
    } catch {
      $isTransient = Test-IsTransientDownloadError $_
      if (-not $isTransient -or $attempt -ge $maxAttempts) {
        throw
      }

      $delaySeconds = Get-DownloadRetryDelaySeconds $_ $attempt
      Write-Warning "Download failed for ${Label}: $($_.Exception.Message). Retrying in $delaySeconds second(s)."
      Start-Sleep -Seconds $delaySeconds
    } finally {
      $client.Dispose()
    }
  }
}

function Add-RosieHfFiles(
  [string]$PackageRoot,
  [string]$Repo,
  [string]$TargetSubdir,
  [string[]]$Files
) {
  $destRoot = Join-Path $PackageRoot $TargetSubdir
  New-Item -ItemType Directory -Force -Path $destRoot | Out-Null

  foreach ($file in $Files) {
    $dest = Join-Path $destRoot $file
    $destParent = Split-Path $dest -Parent
    if (-not (Test-Path $destParent)) {
      New-Item -ItemType Directory -Force -Path $destParent | Out-Null
    }
    $url = "https://huggingface.co/$Repo/resolve/main/$file"
    Invoke-DownloadFile $url $dest $file
  }
}

function Add-RosieVoiceModels([string]$PackageRoot) {
  Add-RosieHfFiles `
    -PackageRoot $PackageRoot `
    -Repo "chris-cao/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17" `
    -TargetSubdir "rosie\stt\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17" `
    -Files @("model.int8.onnx", "tokens.txt")

  Add-RosieHfFiles `
    -PackageRoot $PackageRoot `
    -Repo "csukuangfj/kokoro-multi-lang-v1_0" `
    -TargetSubdir "rosie\tts\kokoro-multi-lang-v1_0" `
    -Files @(
      "model.onnx",
      "voices.bin",
      "tokens.txt",
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

  Write-Host "Packaged ROSIE STT/TTS model files"
}

function Add-RosieSherpaBinaries([string]$PackageRoot) {
  $sherpaVersion = "1.13.2"
  $sherpaArchiveName = "sherpa-onnx-v$sherpaVersion-win-x64-shared-MD-Release.tar.bz2"
  $sherpaUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$sherpaVersion/$sherpaArchiveName"
  $rosieBinDest = Join-Path $PackageRoot "rosie\bin"
  $cacheDir = Join-Path ([IO.Path]::GetTempPath()) "riverside-rosie-package"
  $archivePath = Join-Path $cacheDir $sherpaArchiveName
  $extractDir = Join-Path $cacheDir "sherpa-onnx-v$sherpaVersion"
  $requiredBinaries = @("sherpa-onnx-offline.exe", "sherpa-onnx-offline-tts.exe")

  New-Item -ItemType Directory -Force -Path $rosieBinDest | Out-Null
  $missing = $requiredBinaries | Where-Object { -not (Test-Path (Join-Path $rosieBinDest $_)) }
  if ($missing.Count -eq 0) {
    Write-Host "Packaged ROSIE sherpa-onnx binaries already present"
    return
  }

  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  Invoke-DownloadFile $sherpaUrl $archivePath $sherpaArchiveName

  if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
  $tarOutput = & tar -xjf $archivePath -C $extractDir 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Could not extract ROSIE sherpa-onnx archive. Output: $tarOutput"
  }

  $exeRoot = Get-ChildItem $extractDir -Recurse -Filter "sherpa-onnx-offline.exe" |
    Select-Object -First 1
  if (-not $exeRoot) {
    throw "ROSIE sherpa-onnx archive did not contain sherpa-onnx-offline.exe."
  }

  $exeDir = $exeRoot.DirectoryName
  foreach ($binary in $requiredBinaries) {
    $source = Join-Path $exeDir $binary
    if (-not (Test-Path $source)) {
      throw "ROSIE sherpa-onnx archive did not contain $binary."
    }
    Copy-Item $source (Join-Path $rosieBinDest $binary) -Force
    Write-Host "Packaged rosie/bin/$binary"
  }

  Get-ChildItem $exeDir -Filter "*.dll" -ErrorAction SilentlyContinue |
    Copy-Item -Destination $rosieBinDest -Force
  Write-Host "Packaged ROSIE sherpa-onnx DLL dependencies"

  Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
}

function Add-MeilisearchBinary([string]$PackageRoot) {
  $meiliVersion = "1.11.3"
  $assetName = "meilisearch-windows-amd64.exe"
  $meiliUrl = "https://github.com/meilisearch/meilisearch/releases/download/v$meiliVersion/$assetName"
  $meiliDest = Join-Path $PackageRoot "meilisearch"
  $meiliExe = Join-Path $meiliDest "meilisearch.exe"

  New-Item -ItemType Directory -Force -Path $meiliDest | Out-Null
  Invoke-DownloadFile $meiliUrl $meiliExe "Meilisearch $meiliVersion Windows runtime"
  Write-Host "Packaged meilisearch/meilisearch.exe"
}

$repoRoot = Resolve-FullPath "$PSScriptRoot\..\.."
$gitShort = Get-GitShort $repoRoot
$gitFull = Get-GitFull $repoRoot
$packageLabel = if ($gitShort -and $gitShort -ne "unknown") {
  "RiversideOS-v$Version-$gitShort-$PackageFlavor"
} else {
  "RiversideOS-v$Version-$PackageFlavor"
}
$packageRoot = Join-Path (Resolve-FullPath $OutputDir) $packageLabel

if (-not (Test-Path $ServerBinaryPath)) {
  throw "Server binary not found: $ServerBinaryPath. Build it first on Windows with cargo build --release --manifest-path server/Cargo.toml."
}
if (-not (Test-Path $ClientDistPath)) {
  throw "Client dist not found: $ClientDistPath. Build it first with npm --prefix client run build:register or build:pwa."
}
if (-not (Test-Path $RegisterBundlePath) -and -not $AllowMissingRegisterBundle) {
  throw "Register bundle not found: $RegisterBundlePath. Build it first with npm --prefix client run tauri:build, or pass -AllowMissingRegisterBundle."
}
if (-not (Test-Path $ManagerBinaryPath) -and -not $AllowMissingManagerBinary) {
  throw "Manager binary not found: $ManagerBinaryPath. Build it first with cd deployment/manager-app && npx tauri build, or pass -AllowMissingManagerBinary."
}
if (-not (Test-Path $ServerManagerBinaryPath) -and -not $AllowMissingServerManagerBinary) {
  throw "ROS Server Manager binary not found: $ServerManagerBinaryPath. Build it first with cd deployment/server-manager-app && npx tauri build, or pass -AllowMissingServerManagerBinary."
}

Assert-ClientDistMatchesSource $ClientDistPath $Version $gitShort

Remove-Item $packageRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\server" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\client-dist" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\migrations" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\seeds" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\register" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\docs" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\deployment-app" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\server-manager-app" | Out-Null
New-Item -ItemType Directory -Force -Path "$packageRoot\meilisearch" | Out-Null

Copy-Item "$PSScriptRoot\install-server.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\install-register.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\repair-bootstrap-admin.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\reset-riverside-database.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Reset-RiversideDatabase.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\apply-riverside-migrations.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Apply-RiversideMigrations.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\repair-server-credentials-key.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Repair-RiversideCredentialsKey.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\Start-RiversideDeployment.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Start-RiversideDeployment.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\Install-RosieAiStack.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Install-RosieAiStack.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\audit-system.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Audit-System.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\reset-postgres-password.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Reset-PostgresPassword.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\remove-main-hub.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\remove-standalone-app.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Export-IntegrationCredentials.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Import-IntegrationCredentials.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Install-ROSDeploymentApps.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Install-ROSDeploymentApps.cmd" $packageRoot -Force

# Include encrypted integration credentials if they were exported and committed
$integrationCredsSource = Join-Path $repoRoot "integration-credentials.sql"
if (Test-Path $integrationCredsSource) {
  Copy-Item $integrationCredsSource $packageRoot -Force
  Write-Host "Packaged integration-credentials.sql (encrypted credential dump)"
}

if (Test-Path $ManagerBinaryPath) {
  Copy-Item $ManagerBinaryPath "$packageRoot\RiversideOS-Deployment-Manager.exe" -Force
  Write-Host "Packaged RiversideOS-Deployment-Manager.exe"
}
if (Test-Path $ServerManagerBinaryPath) {
  Copy-Item $ServerManagerBinaryPath "$packageRoot\ROS-ServerManager.exe" -Force
  Write-Host "Packaged ROS-ServerManager.exe"
}
if (Test-Path $ManagerBundlePath) {
  Copy-Item "$ManagerBundlePath\*" "$packageRoot\deployment-app" -Recurse -Force
  Write-Host "Packaged Deployment Manager installer bundle"
}
if (Test-Path $ServerManagerBundlePath) {
  Copy-Item "$ServerManagerBundlePath\*" "$packageRoot\server-manager-app" -Recurse -Force
  Write-Host "Packaged ROS Server Manager installer bundle"
}
Copy-Item "$PSScriptRoot\riverside-deployment.config.example.json" $packageRoot -Force
Copy-Item $ServerBinaryPath "$packageRoot\server\riverside-server.exe" -Force
Copy-Item "$ClientDistPath\*" "$packageRoot\client-dist" -Recurse -Force
Copy-Item "$repoRoot\migrations\*.sql" "$packageRoot\migrations" -Force
Copy-Item "$repoRoot\scripts\seeds\seed_core_required.sql" "$packageRoot\seeds" -Force
Copy-Item "$repoRoot\scripts\seeds\seed_rbac.sql" "$packageRoot\seeds" -Force

# ROSIE AI stack manifest - install-server.ps1 reads this to download the pinned model.
New-Item -ItemType Directory -Force -Path "$packageRoot\rosie" | Out-Null
$modelPinSource = Join-Path $repoRoot "tools\ros-gemma\MODEL_PIN.json"
if (Test-Path $modelPinSource) {
  Copy-Item $modelPinSource "$packageRoot\rosie\MODEL_PIN.json" -Force
  Write-Host "Packaged ROSIE MODEL_PIN.json"
} else {
  Write-Warning "tools/ros-gemma/MODEL_PIN.json not found; ROSIE model download will be skipped during server install."
}

$llamaBinSrc = Join-Path $repoRoot "client\src-tauri\binaries"
$llamaBinDest = Join-Path $packageRoot "rosie\bin"
$llamaSourceExe = Join-Path $llamaBinSrc "llama-server-x86_64-pc-windows-msvc.exe"
if (Test-Path $llamaSourceExe) {
  New-Item -ItemType Directory -Force -Path $llamaBinDest | Out-Null
  Copy-Item $llamaSourceExe (Join-Path $llamaBinDest "llama-server.exe") -Force
  Get-ChildItem $llamaBinSrc -Filter "*.dll" -ErrorAction SilentlyContinue |
    Copy-Item -Destination $llamaBinDest -Force
  Write-Host "Packaged rosie/bin/llama-server.exe for Main Hub ROSIE host"
} else {
  Write-Warning "client/src-tauri/binaries/llama-server-x86_64-pc-windows-msvc.exe not found; Install-RosieAiStack.ps1 will download the pinned llama.cpp runtime during online install."
}
Add-RosieSherpaBinaries $packageRoot
Add-RosieVoiceModels $packageRoot
Add-MeilisearchBinary $packageRoot

Copy-Item "$PSScriptRoot\start-riverside-llama.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Start-RiversideLlama.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\watch-rosie-stack.ps1" $packageRoot -Force


$manifest = @{
  releaseVersion = $Version
  sourceGitShort = $gitShort
  sourceGitSha = $gitFull
  packageName = $packageLabel
  builtAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  clientDistPath = (Resolve-FullPath $ClientDistPath)
  serverBinaryPath = (Resolve-FullPath $ServerBinaryPath)
  counterpointBridgeGuiPath = "counterpoint-bridge-gui"
  meilisearchPath = "meilisearch\meilisearch.exe"
} | ConvertTo-Json -Depth 4
Set-Content -Path "$packageRoot\deployment-package.manifest.json" -Value $manifest -Encoding UTF8

foreach ($doc in @(
  "docs\STORE_DEPLOYMENT_GUIDE.md",
  "docs\PWA_AND_REGISTER_DEPLOYMENT_TASKS.md",
  "docs\HARDWARE_MANAGEMENT.md",
  "docs\LOCAL_UPDATE_PROTOCOL.md",
  "docs\WINDOWS_INSTALLER_PACKAGE.md",
  "docs\DEPLOYMENT_MANAGER.md",
  "docs\ROS_SERVER_MANAGER.md"
)) {
  $source = Join-Path $repoRoot $doc
  if (Test-Path $source) {
    Copy-Item $source "$packageRoot\docs" -Force
  }
}

if (Test-Path $RegisterBundlePath) {
  Copy-Item "$RegisterBundlePath\*" "$packageRoot\register" -Recurse -Force
  
  # Copy bridge GUI installer files to their own clean directory.
  New-Item -ItemType Directory -Force -Path "$packageRoot\counterpoint-bridge-gui" | Out-Null
  Get-ChildItem "$packageRoot\register" -Recurse -Filter "*counterpoint-bridge-gui*" | ForEach-Object {
    Copy-Item $_.FullName "$packageRoot\counterpoint-bridge-gui\" -Force
    Remove-Item $_.FullName -Force
  }

  # Remove deployment manager installer from register directory to save space and prevent confusion
  Get-ChildItem "$packageRoot\register" -Recurse -Filter "*deployment*" -ErrorAction SilentlyContinue | Remove-Item -Force
  Get-ChildItem "$packageRoot\register" -Recurse -Filter "*manager*" -ErrorAction SilentlyContinue | Remove-Item -Force
}

$readme = "# RiversideOS $Version Windows Deployment Package`n" +
  "`nPackage build: $gitShort`n" +
  "`n1. Double-click Install-ROSDeploymentApps.cmd to install the Deployment Manager, ROS Server Manager, or both.`n" +
  "2. Open Riverside OS Deployment Manager from Start, or double-click Start-RiversideDeployment.cmd as the fallback launcher.`n" +
  "3. Choose Main Hub, Register #1, or Back Office Workstation.`n" +
  "3. Click Check, then Install, Update, Repair, or Uninstall.`n" +
  "4. Use ROS-ServerManager.exe for local server health, repairs, cleanup, and recovery when the Riverside app cannot load.`n" +
  "`nThe Deployment Manager writes riverside-deployment.config.json for you and runs`n" +
  "the correct installer for the selected station type.`n" +
  "`nMain Hub installs both:`n" +
  "`n- The Riverside OS server, database setup, firewall rule, and startup task.`n" +
  "- The local Meilisearch search runtime and startup task on http://127.0.0.1:7700.`n" +
  "- The Riverside Windows desktop app configured to use the local server.`n" +
  "`nPassword handling:`n" +
  "`n- If PostgreSQL is missing, the manager can offer to install PostgreSQL 18 through Windows Package Manager.`n" +
  "- Enter the existing PostgreSQL admin password when PostgreSQL is already installed.`n" +
  "- Riverside database and app secrets are generated automatically when left blank or placeholder.`n" +
  "- Station settings are written automatically for Register and Back Office workstation installs.`n" +
  "- A deployment-manager.log file is written next to the installer for support.`n" +
  "- ROS-ServerManager.exe runs locally and does not require the Riverside API to be online.`n" +
  "- Counterpoint Bridge GUI installers are separated under counterpoint-bridge-gui and connect directly to Main Hub ROS.`n" +
  "`nUninstall behavior:`n" +
  "`n- Workstation uninstall removes the Riverside desktop app and station settings.`n" +
  "- Server uninstall removes the Riverside server service, firewall rule, and app files.`n" +
  "- Server uninstall keeps the database, backups, and logs by default.`n" +
  "`nManual fallback:`n" +
  "`n1. Copy riverside-deployment.config.example.json to riverside-deployment.config.json.`n" +
  "2. Fill in the Main Hub, database, secret, Register #1, and printer values.`n" +
  "3. On the Main Hub, open PowerShell as Administrator and run: .\install-server.ps1`n" +
  "   Then install/configure the desktop app on the same PC: .\install-register.ps1`n" +
  "4. On Register #1, copy this package or the same config file, open PowerShell as Administrator, and run: .\install-register.ps1`n" +
  "`nThe Register installer writes C:\ProgramData\RiversideOS\station-config.json.`n" +
  "The desktop app imports that file on first launch and saves the API/printer settings for the station.`n" +
  "`nDatabase-only repair:`n" +
  "`n- If the app starts but a screen reports a missing relation/table, double-click Apply-RiversideMigrations.cmd.`n" +
  "`nUpdater manifests, installers, and signatures are published as GitHub release assets, not duplicated inside this deployment ZIP."
Set-Content -Path "$packageRoot\README.md" -Value $readme -Encoding UTF8

Compress-Archive -Path "$packageRoot\*" -DestinationPath "$packageRoot.zip" -Force
Write-Host "Deployment package created:"
Write-Host $packageRoot
Write-Host "$packageRoot.zip"
