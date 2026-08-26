[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SourceRoot,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$ExpectedSourceSha,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$JobId,

  [ValidateSet("Validate", "Package")]
  [string]$Task = "Validate",

  [string]$WorkerRoot = "C:\ProgramData\RiversideOS\build-worker",
  [switch]$AllowStoreHours,
  [switch]$AllowExternalDownloads
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Resolve-FullPath([string]$Path) {
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Assert-Command([string]$CommandName, [string]$InstallHint) {
  $command = Get-Command $CommandName -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "$CommandName is required on the Windows build worker. $InstallHint"
  }
  return $command.Source
}

function Initialize-MsvcEnvironment {
  $programFilesX86 = ${env:ProgramFiles(x86)}
  $vswhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) {
    throw "Visual Studio Installer could not be found. Install Visual Studio 2022 Build Tools with the Desktop development with C++ workload."
  }

  $installationCandidates = @(
    & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  )
  if ($LASTEXITCODE -ne 0) {
    throw "Could not query the Visual Studio 2022 C++ build environment."
  }
  $installationPath = $installationCandidates |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($installationPath)) {
    throw "Visual Studio 2022 Build Tools is missing the Desktop development with C++ workload."
  }

  $vsDevCmd = Join-Path $installationPath "Common7\Tools\VsDevCmd.bat"
  if (-not (Test-Path $vsDevCmd)) {
    throw "Visual Studio 2022 developer environment was not found: $vsDevCmd"
  }
  $environmentCommand = "`"$vsDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
  $environmentLines = @(& $env:ComSpec /d /s /c $environmentCommand)
  if ($LASTEXITCODE -ne 0) {
    throw "Visual Studio 2022 developer environment initialization failed."
  }
  foreach ($line in $environmentLines) {
    $separator = $line.IndexOf("=")
    if ($separator -le 0) {
      continue
    }
    [Environment]::SetEnvironmentVariable(
      $line.Substring(0, $separator),
      $line.Substring($separator + 1),
      [EnvironmentVariableTarget]::Process
    )
  }
  $linker = Assert-Command "link.exe" "Repair the Visual Studio 2022 Desktop development with C++ workload."
  $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $linker
  return [pscustomobject]@{
    installationPath = $installationPath
    linker = $linker
  }
}

function Invoke-NativeStep(
  [string]$Label,
  [string]$Command,
  [string[]]$Arguments,
  [string]$WorkingDirectory
) {
  Write-Host ""
  Write-Host "--- $Label ---"
  Push-Location $WorkingDirectory
  try {
    & $Command @Arguments
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode."
  }
}

function Assert-PowerShellScriptsParse([string]$RepoRoot) {
  Write-Host ""
  Write-Host "--- Parse Windows deployment scripts ---"
  $hasErrors = $false
  Get-ChildItem (Join-Path $RepoRoot "deployment\windows") -Filter "*.ps1" -File | ForEach-Object {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
      $_.FullName,
      [ref]$tokens,
      [ref]$parseErrors
    ) | Out-Null
    foreach ($parseError in $parseErrors) {
      $hasErrors = $true
      Write-Host "$($_.Name):$($parseError.Extent.StartLineNumber): $($parseError.Message)" -ForegroundColor Red
    }
  }
  if ($hasErrors) {
    throw "Windows deployment PowerShell parse validation failed."
  }
}

function Get-MainHubReadiness {
  $result = [ordered]@{
    reachable = $false
    ready = $false
    buildSha = ""
  }
  try {
    $readyResponse = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/ready" -UseBasicParsing -TimeoutSec 10
    $result.reachable = $true
    $result.ready = ([int]$readyResponse.StatusCode -ge 200 -and [int]$readyResponse.StatusCode -lt 300)
    try {
      $identity = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/version" -UseBasicParsing -TimeoutSec 10
      $result.buildSha = [string]$identity.build_sha
    } catch {
      $result.buildSha = ""
    }
  } catch {
    $result.reachable = $false
    $result.ready = $false
  }
  return [pscustomobject]$result
}

function Get-PinnedAsset(
  [string]$CachePath,
  [string]$Url,
  [string]$ExpectedSha256,
  [string]$Label,
  [bool]$DownloadsAllowed
) {
  $cacheParent = Split-Path $CachePath -Parent
  New-Item -ItemType Directory -Force -Path $cacheParent | Out-Null

  if (Test-Path $CachePath) {
    $cachedSha = (Get-FileHash -Algorithm SHA256 -Path $CachePath).Hash.ToLowerInvariant()
    if ($cachedSha -eq $ExpectedSha256.ToLowerInvariant()) {
      Write-Host "Using cached $Label."
      return $CachePath
    }
    throw "Cached $Label failed SHA-256 verification: $CachePath"
  }

  if (-not $DownloadsAllowed) {
    throw "$Label is not cached at $CachePath. Rerun with -AllowExternalDownloads for the first build."
  }

  $downloadPath = "$CachePath.download"
  Remove-Item $downloadPath -Force -ErrorAction SilentlyContinue
  try {
    Write-Host "Downloading pinned $Label..."
    Invoke-WebRequest -Uri $Url -OutFile $downloadPath -UseBasicParsing -TimeoutSec 300
    $downloadSha = (Get-FileHash -Algorithm SHA256 -Path $downloadPath).Hash.ToLowerInvariant()
    if ($downloadSha -ne $ExpectedSha256.ToLowerInvariant()) {
      throw "Downloaded $Label failed SHA-256 verification."
    }
    Move-Item $downloadPath $CachePath -Force
  } finally {
    Remove-Item $downloadPath -Force -ErrorAction SilentlyContinue
  }
  return $CachePath
}

function Prepare-TauriWindowsInputs([string]$RepoRoot, [string]$CacheRoot, [bool]$DownloadsAllowed) {
  $llamaVersion = "b10229"
  $llamaArchiveName = "llama-$llamaVersion-bin-win-cpu-x64.zip"
  $llamaArchive = Get-PinnedAsset `
    -CachePath (Join-Path $CacheRoot "downloads\$llamaArchiveName") `
    -Url "https://github.com/ggml-org/llama.cpp/releases/download/$llamaVersion/$llamaArchiveName" `
    -ExpectedSha256 "142d927c697e9b518c2834b8faecde0a1a8c09acbcf9da62057947c99d2b19c0" `
    -Label "llama.cpp Windows runtime $llamaVersion" `
    -DownloadsAllowed $DownloadsAllowed

  $llamaExtractRoot = Join-Path $CacheRoot "runtimes\llama-$llamaVersion"
  $llamaExe = Get-ChildItem $llamaExtractRoot -Recurse -Filter "llama-server.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $llamaExe) {
    Remove-Item $llamaExtractRoot -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $llamaExtractRoot | Out-Null
    Expand-Archive -Path $llamaArchive -DestinationPath $llamaExtractRoot -Force
    $llamaExe = Get-ChildItem $llamaExtractRoot -Recurse -Filter "llama-server.exe" |
      Select-Object -First 1
  }
  if (-not $llamaExe) {
    throw "Pinned llama.cpp archive did not contain llama-server.exe."
  }

  $binaryDir = Join-Path $RepoRoot "client\src-tauri\binaries"
  New-Item -ItemType Directory -Force -Path $binaryDir | Out-Null
  Copy-Item $llamaExe.FullName (Join-Path $binaryDir "llama-server-x86_64-pc-windows-msvc.exe") -Force
  Get-ChildItem $llamaExe.DirectoryName -Filter "*.dll" -ErrorAction SilentlyContinue |
    Copy-Item -Destination $binaryDir -Force

  $wixArchive = Get-PinnedAsset `
    -CachePath (Join-Path $CacheRoot "downloads\wix314-binaries.zip") `
    -Url "https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip" `
    -ExpectedSha256 "6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31" `
    -Label "WiX Toolset 3.14.1" `
    -DownloadsAllowed $DownloadsAllowed

  $wixRoot = Join-Path $CacheRoot "tools\wix314"
  if (-not (Test-Path (Join-Path $wixRoot "candle.exe"))) {
    Remove-Item $wixRoot -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $wixRoot | Out-Null
    Expand-Archive -Path $wixArchive -DestinationPath $wixRoot -Force
  }
  if (-not (Test-Path (Join-Path $wixRoot "candle.exe"))) {
    throw "Pinned WiX archive did not contain candle.exe."
  }
  $env:TAURI_WIX_DIR = $wixRoot
}

function Write-Utf8NoBomJson($Value, [string]$Path, [int]$Depth = 8) {
  $encoding = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth $Depth), $encoding)
}

function Get-InternalUpdaterSigningMaterial(
  [string]$RepoRoot,
  [string]$SigningRoot,
  [string]$NpxCommand
) {
  New-Item -ItemType Directory -Force -Path $SigningRoot | Out-Null
  $encryptedPrivateKeyPath = Join-Path $SigningRoot "tauri-private-key.dpapi"
  $publicKeyPath = Join-Path $SigningRoot "tauri-public-key.txt"
  $entropy = [Text.Encoding]::UTF8.GetBytes("RiversideOS.InternalUpdater.v1")

  if (-not (Test-Path $encryptedPrivateKeyPath) -or -not (Test-Path $publicKeyPath)) {
    $temporaryPrivateKey = Join-Path $SigningRoot ("tauri-private-" + [guid]::NewGuid().ToString("N") + ".key")
    try {
      Invoke-NativeStep `
        "Create internal Tauri updater signing key" `
        $NpxCommand `
        @("tauri", "signer", "generate", "-w", $temporaryPrivateKey, "--ci") `
        (Join-Path $RepoRoot "client")
      $temporaryPublicKey = "$temporaryPrivateKey.pub"
      if (-not (Test-Path $temporaryPrivateKey) -or -not (Test-Path $temporaryPublicKey)) {
        throw "Tauri did not create the expected internal updater signing key pair."
      }
      $privateKey = [IO.File]::ReadAllText($temporaryPrivateKey)
      $protected = [Security.Cryptography.ProtectedData]::Protect(
        [Text.Encoding]::UTF8.GetBytes($privateKey),
        $entropy,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      [IO.File]::WriteAllBytes($encryptedPrivateKeyPath, $protected)
      Copy-Item $temporaryPublicKey $publicKeyPath -Force
    } finally {
      Remove-Item $temporaryPrivateKey -Force -ErrorAction SilentlyContinue
      Remove-Item "$temporaryPrivateKey.pub" -Force -ErrorAction SilentlyContinue
    }
  }

  $protectedPrivateKey = [IO.File]::ReadAllBytes($encryptedPrivateKeyPath)
  $privateKeyBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $protectedPrivateKey,
    $entropy,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $privateKey = [Text.Encoding]::UTF8.GetString($privateKeyBytes).Trim()
  $publicKey = [IO.File]::ReadAllText($publicKeyPath).Trim()
  if ([string]::IsNullOrWhiteSpace($privateKey) -or [string]::IsNullOrWhiteSpace($publicKey)) {
    throw "Internal updater signing material is incomplete."
  }
  return [pscustomobject]@{
    privateKey = $privateKey
    publicKey = $publicKey
    publicKeyPath = $publicKeyPath
  }
}

function Get-AuthenticodeConfiguration([string]$SigningRoot) {
  $thumbprintPath = Join-Path $SigningRoot "authenticode-thumbprint.txt"
  if (-not (Test-Path $thumbprintPath)) {
    return $null
  }
  $thumbprint = ([IO.File]::ReadAllText($thumbprintPath) -replace '\s', '').ToUpperInvariant()
  if ($thumbprint -notmatch '^[0-9A-F]{40}$') {
    throw "The configured Authenticode certificate thumbprint is invalid."
  }
  $certificate = Get-Item "Cert:\CurrentUser\My\$thumbprint" -ErrorAction SilentlyContinue
  if (-not $certificate) {
    $certificate = Get-Item "Cert:\LocalMachine\My\$thumbprint" -ErrorAction SilentlyContinue
  }
  if (-not $certificate -or -not $certificate.HasPrivateKey) {
    throw "The configured Authenticode certificate is unavailable or has no private key: $thumbprint"
  }
  return [pscustomobject]@{ thumbprint = $thumbprint; certificate = $certificate }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "Invoke-RiversideWindowsBuild.ps1 must run on Windows."
}

$SourceRoot = Resolve-FullPath $SourceRoot
$WorkerRoot = Resolve-FullPath $WorkerRoot
$ExpectedSourceSha = $ExpectedSourceSha.ToLowerInvariant()
$installRoot = Resolve-FullPath "C:\RiversideOS"
if ($SourceRoot.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Build source must not be placed inside the live C:\RiversideOS installation."
}
if (-not (Test-Path (Join-Path $SourceRoot "package.json"))) {
  throw "SourceRoot does not look like the Riverside OS repository: $SourceRoot"
}
$artifactDir = Join-Path $WorkerRoot ("artifacts\" + $JobId)
$cacheRoot = Join-Path $WorkerRoot "cache"
$lockRoot = Join-Path $WorkerRoot "locks"
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
New-Item -ItemType Directory -Force -Path $lockRoot | Out-Null
$lockPath = Join-Path $lockRoot "windows-build.lock"
$lockStream = $null
$transcriptStarted = $false
$startedAt = (Get-Date).ToUniversalTime()
$status = "failed"
$errorMessage = ""
$nodeVersion = "unavailable"
$rustVersion = "unavailable"
$healthBefore = Get-MainHubReadiness
$healthAfter = $null
$internalUpdaterSigned = $false
$authenticodeVerified = $false

try {
  try {
    $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    throw "Another Riverside Windows build is already active."
  }

  try {
    [Diagnostics.Process]::GetCurrentProcess().PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
  } catch {
    Write-Warning "Could not lower the build worker process priority: $($_.Exception.Message)"
  }

  Start-Transcript -Path (Join-Path $artifactDir "windows-build.log") -Force | Out-Null
  $transcriptStarted = $true

  if (-not $AllowStoreHours) {
    $localHour = (Get-Date).Hour
    if ($localHour -ge 10 -and $localHour -lt 18) {
      throw "Main Hub builds are blocked from 10 AM through 6 PM by default. Rerun with -AllowStoreHours only after confirming the build cannot disrupt store operations."
    }
  }

  $workerDrive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($WorkerRoot).TrimEnd('\').TrimEnd(':')) -ErrorAction Stop
  if ($workerDrive.Free -lt 35GB) {
    throw "The Windows build worker requires at least 35 GB free. Available: $([Math]::Round($workerDrive.Free / 1GB, 1)) GB."
  }

  $node = Assert-Command "node.exe" "Install the repository-pinned Node.js 24 runtime."
  $npm = Assert-Command "npm.cmd" "Install the repository-pinned Node.js 24 runtime."
  $rustup = Assert-Command "rustup.exe" "Install rustup and the Rust 1.91 toolchain with rustfmt and clippy."
  $npx = Assert-Command "npx.cmd" "Install the repository-pinned Node.js 24 runtime."
  $nodeVersionOutput = @(& $node --version)
  $nodeVersion = ($nodeVersionOutput -join " ").Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.') {
    throw "Node.js 24 is required; found '$nodeVersion'."
  }
  $rustVersionOutput = @(& $rustup run 1.91 rustc --version)
  $rustVersion = ($rustVersionOutput -join " ").Trim()
  if ($LASTEXITCODE -ne 0 -or $rustVersion -notmatch '^rustc 1\.91\.') {
    throw "Rust 1.91 is required; found '$rustVersion'."
  }
  $msvc = Initialize-MsvcEnvironment

  Write-Host "Riverside Windows build worker"
  Write-Host "Computer: $env:COMPUTERNAME"
  Write-Host "Task: $Task"
  Write-Host "Source SHA: $ExpectedSourceSha"
  Write-Host "Source root: $SourceRoot"
  Write-Host "Node: $nodeVersion"
  Write-Host "Rust: $rustVersion"
  Write-Host "MSVC: $($msvc.installationPath)"
  Write-Host "MSVC linker: $($msvc.linker)"

  if (-not $healthBefore.ready) {
    throw "The Main Hub was not ready before the build. Restore http://127.0.0.1:3000/api/ready before using production capacity for Windows builds."
  }

  $env:RIVERSIDE_BUILD_SHA = $ExpectedSourceSha
  $env:CARGO_TARGET_DIR = Join-Path $cacheRoot "cargo-target"
  Remove-Item Env:\RUSTC_WRAPPER -ErrorAction SilentlyContinue

  Assert-PowerShellScriptsParse $SourceRoot

  Invoke-NativeStep "Install root dependencies" $npm @("ci") $SourceRoot
  Invoke-NativeStep "Install client dependencies" $npm @("ci") (Join-Path $SourceRoot "client")

  Invoke-NativeStep "Check version parity" $npm @("run", "check:version") $SourceRoot
  Invoke-NativeStep "Check deployment release contracts" $npm @("run", "check:deployment-release") $SourceRoot
  Invoke-NativeStep "Client lint" $npm @("run", "lint") $SourceRoot
  Invoke-NativeStep "Client typecheck" $npm @("run", "typecheck") $SourceRoot
  Invoke-NativeStep "Rust formatting" $rustup @("run", "1.91", "cargo", "fmt", "--all", "--", "--check") $SourceRoot
  if ($Task -eq "Package") {
    Prepare-TauriWindowsInputs $SourceRoot $cacheRoot ([bool]$AllowExternalDownloads)
  }
  Invoke-NativeStep "Rust workspace check" $rustup @("run", "1.91", "cargo", "check", "--workspace") $SourceRoot

  if ($Task -eq "Package") {
    Invoke-NativeStep "Install Cube Core dependencies" $npm @("ci") (Join-Path $SourceRoot "cube")
    Invoke-NativeStep `
      "Build Windows server binary" `
      $rustup `
      @("run", "1.91", "cargo", "build", "--release", "--manifest-path", (Join-Path $SourceRoot "server\Cargo.toml")) `
      $SourceRoot
    $signingRoot = Join-Path $WorkerRoot "signing"
    $signing = Get-InternalUpdaterSigningMaterial $SourceRoot $signingRoot $npx
    $authenticode = Get-AuthenticodeConfiguration $signingRoot
    $env:TAURI_SIGNING_PRIVATE_KEY = $signing.privateKey
    Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    $env:RIVERSIDE_UPDATER_PUBLIC_KEY = $signing.publicKey
    $env:RIVERSIDE_UPDATER_ENDPOINT = "http://127.0.0.1:3000/api/internal-updates/windows/latest.json"
    $env:RIVERSIDE_UPDATER_CHANNEL = "internal"

    $updaterConfig = @{
      bundle = @{
        createUpdaterArtifacts = $true
        useLocalToolsDir = $true
        resources = @("../dist", "binaries/*.dll")
      }
      plugins = @{
        updater = @{
          active = $true
          endpoints = @($env:RIVERSIDE_UPDATER_ENDPOINT)
          pubkey = $env:RIVERSIDE_UPDATER_PUBLIC_KEY
          dangerousInsecureTransportProtocol = $true
          windows = @{ installMode = "passive" }
        }
      }
    }
    if ($authenticode) {
      $updaterConfig.bundle.windows = @{
        certificateThumbprint = $authenticode.thumbprint
        digestAlgorithm = "sha256"
        timestampUrl = "http://timestamp.digicert.com"
      }
    }
    $updaterConfigPath = Join-Path $SourceRoot "client\src-tauri\tauri.internal-updater.conf.json"
    Write-Utf8NoBomJson $updaterConfig $updaterConfigPath 8
    try {
      Invoke-NativeStep `
        "Build signed internal Windows Tauri bundle" `
        $npx `
        @("tauri", "build", "--config", $updaterConfigPath) `
        (Join-Path $SourceRoot "client")
    } finally {
      Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
      Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    }

    $signatureFiles = @(
      Get-ChildItem $env:CARGO_TARGET_DIR -Recurse -Filter "*.sig" -File |
        Where-Object {
          $_.LastWriteTimeUtc -ge $startedAt.AddMinutes(-2) -and
          (Test-Path $_.FullName.Substring(0, $_.FullName.Length - 4))
        } |
        Sort-Object LastWriteTimeUtc -Descending
    )
    if ($signatureFiles.Count -lt 1) {
      throw "The Tauri build did not produce a signed Windows updater artifact."
    }
    $updaterSignatureFile = $signatureFiles |
      Where-Object { $_.Name -like "*.nsis.zip.sig" } |
      Select-Object -First 1
    if (-not $updaterSignatureFile) {
      $updaterSignatureFile = $signatureFiles[0]
    }
    $updaterArtifactPath = $updaterSignatureFile.FullName.Substring(0, $updaterSignatureFile.FullName.Length - 4)
    $updaterAssetName = ([IO.Path]::GetFileName($updaterArtifactPath) -replace ' ', '.')
    $updaterSignatureName = "$updaterAssetName.sig"
    Copy-Item $updaterArtifactPath (Join-Path $artifactDir $updaterAssetName) -Force
    Copy-Item $updaterSignatureFile.FullName (Join-Path $artifactDir $updaterSignatureName) -Force
    Copy-Item $signing.publicKeyPath (Join-Path $artifactDir "riverside-internal-updater.pub") -Force
    $internalUpdaterSigned = $true

    if ($authenticode) {
      $signedInstallers = @(
        Get-ChildItem (Join-Path $env:CARGO_TARGET_DIR "release\bundle") -Recurse -File |
          Where-Object { $_.Extension -in @(".exe", ".msi") }
      )
      if ($signedInstallers.Count -lt 1) {
        throw "No Windows installer was available for Authenticode verification."
      }
      foreach ($installer in $signedInstallers) {
        $signature = Get-AuthenticodeSignature -FilePath $installer.FullName
        if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Thumbprint -ne $authenticode.thumbprint) {
          throw "Authenticode verification failed for $($installer.Name)."
        }
      }
      $authenticodeVerified = $true
    }

    $serverBinary = Join-Path $env:CARGO_TARGET_DIR "release\riverside-server.exe"
    $registerBundle = Join-Path $env:CARGO_TARGET_DIR "release\bundle"
    $packageOutput = Join-Path $SourceRoot "dist\deployment"
    $packageScript = Join-Path $SourceRoot "deployment\windows\build-deployment-package.ps1"
    $version = (Get-Content (Join-Path $SourceRoot "package.json") -Raw | ConvertFrom-Json).version
    $packageArgs = @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", $packageScript,
      "-Version", $version,
      "-SourceGitSha", $ExpectedSourceSha,
      "-OutputDir", $packageOutput,
      "-PackageFlavor", "MainHub-Update",
      "-ServerBinaryPath", $serverBinary,
      "-ClientDistPath", (Join-Path $SourceRoot "client\dist"),
      "-RegisterBundlePath", $registerBundle,
      "-RuntimeCacheRoot", (Join-Path $cacheRoot "package-runtimes"),
      "-AllowMissingManagerBinary",
      "-AllowMissingServerManagerBinary",
      "-SkipRosieVoiceModels"
    )
    if (-not $AllowExternalDownloads) {
      $packageArgs += "-DisallowRuntimeDownloads"
    }
    Invoke-NativeStep "Assemble exact-build Main Hub package" "powershell.exe" $packageArgs $SourceRoot

    $packageZips = @(
      Get-ChildItem $packageOutput -Filter "RiversideOS-v$version-*-MainHub-Update.zip" -File |
        Where-Object { $_.Name -like "*-$($ExpectedSourceSha.Substring(0, 8))-*" }
    )
    if ($packageZips.Count -ne 1) {
      throw "Expected exactly one exact-build Main Hub package ZIP; found $($packageZips.Count)."
    }
    $packageZip = $packageZips[0]
    $publishedPackagePath = Join-Path $artifactDir $packageZip.Name
    Copy-Item $packageZip.FullName $publishedPackagePath -Force

    $publishedUpdaterPath = Join-Path $artifactDir $updaterAssetName
    $releaseManifest = [ordered]@{
      contractVersion = 1
      version = $version
      sourceGitSha = $ExpectedSourceSha
      publishedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
      notes = "Riverside OS $version internal release ($($ExpectedSourceSha.Substring(0, 8)))"
      mainHubPackage = [ordered]@{
        fileName = $packageZip.Name
        sha256 = (Get-FileHash -Algorithm SHA256 -Path $publishedPackagePath).Hash.ToLowerInvariant()
        bytes = (Get-Item $publishedPackagePath).Length
      }
      windowsUpdater = [ordered]@{
        fileName = $updaterAssetName
        signature = ([IO.File]::ReadAllText((Join-Path $artifactDir $updaterSignatureName))).Trim()
        sha256 = (Get-FileHash -Algorithm SHA256 -Path $publishedUpdaterPath).Hash.ToLowerInvariant()
        bytes = (Get-Item $publishedUpdaterPath).Length
      }
    }
    Write-Utf8NoBomJson $releaseManifest (Join-Path $artifactDir "release.json") 8
  }

  $healthAfter = Get-MainHubReadiness
  if (-not $healthAfter.ready) {
    throw "The Main Hub was ready before the build but was not ready afterward. The candidate is not certified."
  }
  $status = "succeeded"
} catch {
  $errorMessage = $_.Exception.Message
  Write-Host "Windows build failed: $errorMessage" -ForegroundColor Red
  throw
} finally {
  if ($null -eq $healthAfter) {
    $healthAfter = Get-MainHubReadiness
  }
  $completedAt = (Get-Date).ToUniversalTime()
  $artifactEntries = @(
    Get-ChildItem $artifactDir -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notin @("windows-build-summary.json", "windows-build.log") } |
      ForEach-Object {
        [ordered]@{
          name = $_.Name
          bytes = $_.Length
          sha256 = (Get-FileHash -Algorithm SHA256 -Path $_.FullName).Hash.ToLowerInvariant()
        }
      }
  )
  $summary = [ordered]@{
    contractVersion = 1
    jobId = $JobId
    task = $Task
    status = $status
    error = $errorMessage
    sourceGitSha = $ExpectedSourceSha
    sourceGitShort = $ExpectedSourceSha.Substring(0, 8)
    worker = $env:COMPUTERNAME
    startedAt = $startedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
    completedAt = $completedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
    nodeVersion = $nodeVersion
    rustVersion = $rustVersion
    mainHubBefore = $healthBefore
    mainHubAfter = $healthAfter
    productionReady = $false
    releaseCandidateReady = ($status -eq "succeeded" -and $Task -eq "Package" -and $internalUpdaterSigned)
    internalUpdaterSigned = $internalUpdaterSigned
    authenticodeVerified = $authenticodeVerified
    certificationBoundary = if ($Task -eq "Package") {
      "Exact-build checksummed candidate with an internal Tauri updater signature. It is not production-current until guarded Main Hub promotion and exact-build readiness pass; Authenticode and live workstation status are reported separately."
    } else {
      "Windows validation only; no package, deployment, or live workstation certification was performed."
    }
    artifacts = $artifactEntries
  }
  $summary | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $artifactDir "windows-build-summary.json") -Encoding UTF8
  if ($transcriptStarted) {
    Stop-Transcript | Out-Null
  }
  if ($lockStream) {
    $lockStream.Dispose()
  }
}

Write-Host "RIVERSIDE_BUILD_ARTIFACT_DIR=$artifactDir"
