[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$SourceGitSha = "",
  [string]$OutputDir = "$PSScriptRoot\..\..\dist\deployment",
  [string]$ServerBinaryPath = "$PSScriptRoot\..\..\target\release\riverside-server.exe",
  [string]$ClientDistPath = "$PSScriptRoot\..\..\client\dist",
  [string]$RegisterBundlePath = "$PSScriptRoot\..\..\target\release\bundle",
  [string]$ManagerBinaryPath = "$PSScriptRoot\..\..\target\release\riverside-deployment-manager.exe",
  [string]$ServerManagerBinaryPath = "$PSScriptRoot\..\..\target\release\ros-server-manager.exe",
  [string]$ManagerBundlePath = "$PSScriptRoot\..\..\target\release\deployment-manager-bundle",
  [string]$ServerManagerBundlePath = "$PSScriptRoot\..\..\target\release\server-manager-bundle",
  [string]$RuntimeCacheRoot = "",
  [ValidateSet("Windows-Deployment", "MainHub-Update")]
  [string]$PackageFlavor = "Windows-Deployment",
  [switch]$AllowMissingRegisterBundle,
  [switch]$AllowMissingManagerBinary,
  [switch]$AllowMissingServerManagerBinary,
  [switch]$SkipRosieVoiceModels,
  [switch]$DisallowRuntimeDownloads
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Version)) {
  $packageJsonPath = Join-Path $PSScriptRoot "..\..\client\package.json"
  if (-not (Test-Path $packageJsonPath)) {
    throw "Version was not provided and client/package.json was not found."
  }
  $Version = (Get-Content $packageJsonPath -Raw | ConvertFrom-Json).version
}

function Resolve-FullPath([string]$Path) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Get-PackageContentFingerprint([string]$BasePath, [string[]]$Paths) {
  $files = @()
  foreach ($path in $Paths) {
    if (Test-Path $path -PathType Container) {
      $files += @(Get-ChildItem $path -Recurse -File)
    } elseif (Test-Path $path -PathType Leaf) {
      $files += @(Get-Item $path)
    }
  }
  if ($files.Count -eq 0) {
    throw "Cannot fingerprint an empty deployment component: $($Paths -join ', ')"
  }

  $entries = @(
    $files |
      Sort-Object FullName |
      ForEach-Object {
        $relativePath = $_.FullName.Substring($BasePath.Length).TrimStart([char]92).Replace("\", "/")
        $fileHash = (Get-FileHash -Algorithm SHA256 -Path $_.FullName).Hash.ToLowerInvariant()
        "$relativePath=$fileHash"
      }
  )
  $payload = [System.Text.Encoding]::UTF8.GetBytes([string]::Join("`n", $entries))
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($payload))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
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

function Assert-FileSha256([string]$Path, [string]$Expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "Downloaded file checksum mismatch for $Path. Expected $Expected, got $actual."
  }
}

function Get-CachedRuntimeAsset(
  [string]$CacheRoot,
  [string]$AssetName,
  [string]$Url,
  [string]$ExpectedSha256,
  [string]$Label,
  [bool]$DownloadsDisallowed
) {
  New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null
  $cachePath = Join-Path $CacheRoot $AssetName
  if (Test-Path $cachePath) {
    Assert-FileSha256 $cachePath $ExpectedSha256
    Write-Host "Using cached $Label"
    return $cachePath
  }
  if ($DownloadsDisallowed) {
    throw "$Label is not cached at $cachePath and runtime downloads are disabled."
  }
  Invoke-DownloadFile $Url $cachePath $Label
  Assert-FileSha256 $cachePath $ExpectedSha256
  return $cachePath
}

function Add-RosieHfFiles(
  [string]$PackageRoot,
  [string]$Repo,
  [string]$Revision,
  [string]$TargetSubdir,
  [string[]]$Files,
  [hashtable]$ExpectedSha256
) {
  $destRoot = Join-Path $PackageRoot $TargetSubdir
  New-Item -ItemType Directory -Force -Path $destRoot | Out-Null

  foreach ($file in $Files) {
    $dest = Join-Path $destRoot $file
    $destParent = Split-Path $dest -Parent
    if (-not (Test-Path $destParent)) {
      New-Item -ItemType Directory -Force -Path $destParent | Out-Null
    }
    $url = "https://huggingface.co/$Repo/resolve/$Revision/$file"
    Invoke-DownloadFile $url $dest $file
    if (-not $ExpectedSha256.ContainsKey($file)) {
      throw "Missing pinned SHA256 for ROSIE asset $file."
    }
    Assert-FileSha256 $dest $ExpectedSha256[$file]
  }
}

function Add-RosieVoiceModels([string]$PackageRoot) {
  Add-RosieHfFiles `
    -PackageRoot $PackageRoot `
    -Repo "chris-cao/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17" `
    -Revision "20dc3ebe15651c2e26d7e07b04fcd84a39c3b920" `
    -TargetSubdir "rosie\stt\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17" `
    -Files @("model.int8.onnx", "tokens.txt") `
    -ExpectedSha256 @{
      "model.int8.onnx" = "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"
      "tokens.txt" = "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"
    }
  Add-RosieHfFiles `
    -PackageRoot $PackageRoot `
    -Repo "csukuangfj/kokoro-multi-lang-v1_1" `
    -Revision "914313412b607d95400bcd12446233fbd1248801" `
    -TargetSubdir "rosie\tts\kokoro-multi-lang-v1_1" `
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
    ) `
    -ExpectedSha256 @{
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

  Write-Host "Packaged ROSIE STT/TTS model files"
}

function Add-RosieSherpaBinaries(
  [string]$PackageRoot,
  [string]$RuntimeCacheRoot,
  [bool]$DownloadsDisallowed
) {
  $sherpaVersion = "1.13.4"
  $sherpaArchiveName = "sherpa-onnx-v$sherpaVersion-win-x64-shared-MD-Release.tar.bz2"
  $sherpaUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$sherpaVersion/$sherpaArchiveName"
  $rosieBinDest = Join-Path $PackageRoot "rosie\bin"
  $archivePath = Get-CachedRuntimeAsset `
    -CacheRoot $RuntimeCacheRoot `
    -AssetName $sherpaArchiveName `
    -Url $sherpaUrl `
    -ExpectedSha256 "d4dacc8be5afe03f22ade4d50cfd587c03a625eaca8c41f2d99a24d3db463eab" `
    -Label "ROSIE sherpa-onnx runtime $sherpaVersion" `
    -DownloadsDisallowed $DownloadsDisallowed
  $extractDir = Join-Path ([IO.Path]::GetTempPath()) "riverside-rosie-package\sherpa-onnx-v$sherpaVersion"
  $requiredBinaries = @("sherpa-onnx-offline.exe", "sherpa-onnx-offline-tts.exe")

  New-Item -ItemType Directory -Force -Path $rosieBinDest | Out-Null
  $missing = $requiredBinaries | Where-Object { -not (Test-Path (Join-Path $rosieBinDest $_)) }
  if ($missing.Count -eq 0) {
    Write-Host "Packaged ROSIE sherpa-onnx binaries already present"
    return
  }

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

function Add-MeilisearchBinary(
  [string]$PackageRoot,
  [string]$RuntimeCacheRoot,
  [bool]$DownloadsDisallowed
) {
  $meiliVersion = "1.49.0"
  $assetName = "meilisearch-windows-amd64.exe"
  $meiliUrl = "https://github.com/meilisearch/meilisearch/releases/download/v$meiliVersion/$assetName"
  $meiliDest = Join-Path $PackageRoot "meilisearch"
  $meiliExe = Join-Path $meiliDest "meilisearch.exe"

  $cachedMeili = Get-CachedRuntimeAsset `
    -CacheRoot $RuntimeCacheRoot `
    -AssetName $assetName `
    -Url $meiliUrl `
    -ExpectedSha256 "db63bea71776371a6675d95034439dfbb58deaab694ca4dfb89e61d761afbf5f" `
    -Label "Meilisearch $meiliVersion Windows runtime" `
    -DownloadsDisallowed $DownloadsDisallowed
  New-Item -ItemType Directory -Force -Path $meiliDest | Out-Null
  Copy-Item $cachedMeili $meiliExe -Force
  Write-Host "Packaged meilisearch/meilisearch.exe"
}

function Add-CubeRuntime([string]$PackageRoot, [string]$RepoRoot) {
  $cubeVersion = "1.7.16"
  $cubeSource = Join-Path $RepoRoot "cube"
  $cubeDest = Join-Path $PackageRoot "cube"
  $nodeModules = Join-Path $cubeSource "node_modules"
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue

  foreach ($required in @(
    (Join-Path $cubeSource "package.json"),
    (Join-Path $cubeSource "package-lock.json"),
    (Join-Path $cubeSource "cube.js"),
    (Join-Path $cubeSource "model"),
    $nodeModules,
    (Join-Path $PSScriptRoot "start-riverside-cube.ps1")
  )) {
    if (-not (Test-Path $required)) {
      throw "Cube Core package input is missing: $required. Run 'npm ci --prefix cube' on Windows before packaging."
    }
  }
  if (-not $nodeCommand) {
    throw "node.exe is required to package the non-Docker Cube Core runtime."
  }

  $nativeBinding = Get-ChildItem $nodeModules -Recurse -Filter "*.node" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like "*@cubejs-backend*native*" } |
    Select-Object -First 1
  if (-not $nativeBinding) {
    throw "Cube Core Windows native binding is missing. Re-run npm ci in the cube folder on Windows."
  }

  New-Item -ItemType Directory -Force -Path $cubeDest | Out-Null
  Copy-Item (Join-Path $cubeSource "package.json") $cubeDest -Force
  Copy-Item (Join-Path $cubeSource "package-lock.json") $cubeDest -Force
  Copy-Item (Join-Path $cubeSource "cube.js") $cubeDest -Force
  Copy-Item (Join-Path $cubeSource "model") (Join-Path $cubeDest "model") -Recurse -Force
  Copy-Item $nodeModules (Join-Path $cubeDest "node_modules") -Recurse -Force
  $cubeServerJs = Join-Path $cubeDest "node_modules\@cubejs-backend\server\dist\src\server.js"
  $cubeServerSource = [IO.File]::ReadAllText($cubeServerJs)
  $listenAnchor = "await this.server.listen(PORT);"
  $firstListenAnchor = $cubeServerSource.IndexOf($listenAnchor, [StringComparison]::Ordinal)
  $lastListenAnchor = $cubeServerSource.LastIndexOf($listenAnchor, [StringComparison]::Ordinal)
  if ($firstListenAnchor -lt 0 -or $firstListenAnchor -ne $lastListenAnchor) {
    throw "Pinned Cube Core server listen contract changed; cannot enforce loopback-only binding."
  }
  $cubeServerSource = $cubeServerSource.Replace($listenAnchor, "await this.server.listen(PORT, '127.0.0.1');")
  [IO.File]::WriteAllText($cubeServerJs, $cubeServerSource)
  Copy-Item $nodeCommand.Source (Join-Path $cubeDest "node.exe") -Force
  Copy-Item (Join-Path $PSScriptRoot "start-riverside-cube.ps1") $cubeDest -Force
  Set-Content -Path (Join-Path $cubeDest "VERSION") -Value $cubeVersion -Encoding ASCII
  Set-Content -Path (Join-Path $cubeDest "NODE_VERSION") -Value (& $nodeCommand.Source --version).Trim() -Encoding ASCII
  Write-Host "Packaged Cube Core $cubeVersion with a portable Windows Node runtime"
}

function Convert-FileLineEndings([string]$Path, [ValidateSet("LF", "CRLF")][string]$Mode) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $lfBytes = New-Object System.Collections.Generic.List[byte]
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    if ($bytes[$i] -eq 13) {
      if (($i + 1) -lt $bytes.Length -and $bytes[$i + 1] -eq 10) {
        $lfBytes.Add(10)
        $i++
      } else {
        $lfBytes.Add(10)
      }
    } else {
      $lfBytes.Add($bytes[$i])
    }
  }

  if ($Mode -eq "LF") {
    [System.IO.File]::WriteAllBytes($Path, $lfBytes.ToArray())
    return
  }

  $crlfBytes = New-Object System.Collections.Generic.List[byte]
  foreach ($byte in $lfBytes) {
    if ($byte -eq 10) {
      $crlfBytes.Add(13)
      $crlfBytes.Add(10)
    } else {
      $crlfBytes.Add($byte)
    }
  }
  [System.IO.File]::WriteAllBytes($Path, $crlfBytes.ToArray())
}

function Set-PackagedMigrationLineEndings([string]$MigrationDir) {
  Get-ChildItem $MigrationDir -Filter "*.sql" | ForEach-Object {
    if ($_.BaseName -match '^(\d+)_') {
      $migrationNumber = [int]$Matches[1]
      if ($migrationNumber -le 101) {
        Convert-FileLineEndings $_.FullName "CRLF"
      } else {
        Convert-FileLineEndings $_.FullName "LF"
      }
    }
  }
  Write-Host "Packaged migration line endings normalized: 001-101 CRLF, 102+ LF"
}

$repoRoot = Resolve-FullPath "$PSScriptRoot\..\.."
if ([string]::IsNullOrWhiteSpace($RuntimeCacheRoot)) {
  $RuntimeCacheRoot = Join-Path ([IO.Path]::GetTempPath()) "riverside-deployment-runtime-cache"
}
$RuntimeCacheRoot = Resolve-FullPath $RuntimeCacheRoot
$gitFull = if ([string]::IsNullOrWhiteSpace($SourceGitSha)) {
  Get-GitFull $repoRoot
} else {
  $SourceGitSha.Trim().ToLowerInvariant()
}
if ($gitFull -notmatch '^[0-9a-f]{40}$') {
  throw "A 40-character SourceGitSha is required when packaging outside a Git checkout."
}
$gitShort = $gitFull.Substring(0, 8)
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
if ($PackageFlavor -eq "Windows-Deployment" -and -not (Test-Path $ManagerBinaryPath) -and -not $AllowMissingManagerBinary) {
  throw "Manager binary not found: $ManagerBinaryPath. Build it first with cd deployment/manager-app && npx tauri build, or pass -AllowMissingManagerBinary."
}
if ($PackageFlavor -eq "Windows-Deployment" -and -not (Test-Path $ServerManagerBinaryPath) -and -not $AllowMissingServerManagerBinary) {
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
New-Item -ItemType Directory -Force -Path "$packageRoot\cube" | Out-Null

Copy-Item "$PSScriptRoot\install-server.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\install-register.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\verify-deployment-package.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\verify-release-code-signing.ps1" $packageRoot -Force
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
Copy-Item "$PSScriptRoot\Enable-MainHubLanAdmin.ps1" $packageRoot -Force

# Include encrypted integration credentials if they were exported and committed
$integrationCredsSource = Join-Path $repoRoot "integration-credentials.sql"
if (Test-Path $integrationCredsSource) {
  Copy-Item $integrationCredsSource $packageRoot -Force
  Write-Host "Packaged integration-credentials.sql (encrypted credential dump)"
}

if ($PackageFlavor -eq "Windows-Deployment" -and (Test-Path $ManagerBinaryPath)) {
  Copy-Item $ManagerBinaryPath "$packageRoot\RiversideOS-Deployment-Manager.exe" -Force
  Write-Host "Packaged RiversideOS-Deployment-Manager.exe"
}
if ($PackageFlavor -eq "Windows-Deployment" -and (Test-Path $ServerManagerBinaryPath)) {
  Copy-Item $ServerManagerBinaryPath "$packageRoot\ROS-ServerManager.exe" -Force
  Write-Host "Packaged ROS-ServerManager.exe"
}
if ($PackageFlavor -eq "Windows-Deployment" -and (Test-Path $ManagerBundlePath)) {
  Copy-Item "$ManagerBundlePath\*" "$packageRoot\deployment-app" -Recurse -Force
  Write-Host "Packaged Deployment Manager installer bundle"
}
if ($PackageFlavor -eq "Windows-Deployment" -and (Test-Path $ServerManagerBundlePath)) {
  Copy-Item "$ServerManagerBundlePath\*" "$packageRoot\server-manager-app" -Recurse -Force
  Write-Host "Packaged ROS Server Manager installer bundle"
}
Copy-Item "$PSScriptRoot\riverside-deployment.config.example.json" $packageRoot -Force
Copy-Item $ServerBinaryPath "$packageRoot\server\riverside-server.exe" -Force
Copy-Item "$ClientDistPath\*" "$packageRoot\client-dist" -Recurse -Force
Copy-Item "$repoRoot\migrations\*.sql" "$packageRoot\migrations" -Force
Set-PackagedMigrationLineEndings "$packageRoot\migrations"
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
Add-RosieSherpaBinaries $packageRoot $RuntimeCacheRoot ([bool]$DisallowRuntimeDownloads)
if ($SkipRosieVoiceModels) {
  Write-Host "Skipping bundled ROSIE voice models; existing installs retain their verified models and fresh installs use the pinned ROSIE installer."
} else {
  Add-RosieVoiceModels $packageRoot
}
Add-MeilisearchBinary $packageRoot $RuntimeCacheRoot ([bool]$DisallowRuntimeDownloads)
Add-CubeRuntime $packageRoot $repoRoot

Copy-Item "$PSScriptRoot\start-riverside-llama.ps1" $packageRoot -Force
Copy-Item "$PSScriptRoot\Start-RiversideLlama.cmd" $packageRoot -Force
Copy-Item "$PSScriptRoot\watch-rosie-stack.ps1" $packageRoot -Force

$rosieFingerprint = Get-PackageContentFingerprint $packageRoot @(
  (Join-Path $packageRoot "rosie"),
  (Join-Path $packageRoot "Install-RosieAiStack.ps1"),
  (Join-Path $packageRoot "start-riverside-llama.ps1"),
  (Join-Path $packageRoot "watch-rosie-stack.ps1")
)
$meilisearchFingerprint = Get-PackageContentFingerprint $packageRoot @(
  (Join-Path $packageRoot "meilisearch")
)
$cubeFingerprint = Get-PackageContentFingerprint $packageRoot @(
  (Join-Path $packageRoot "cube")
)
$manifest = @{
  releaseVersion = $Version
  sourceGitShort = $gitShort
  sourceGitSha = $gitFull
  packageName = $packageLabel
  packageFlavor = $PackageFlavor
  updateContractVersion = 1
  builtAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  clientDistPath = (Resolve-FullPath $ClientDistPath)
  serverBinaryPath = (Resolve-FullPath $ServerBinaryPath)
  counterpointBridgeGuiPath = "counterpoint-bridge-gui"
  meilisearchPath = "meilisearch\meilisearch.exe"
  cubePath = "cube"
  cubeVersion = "1.7.16"
  components = @{
    rosie = @{ fingerprint = $rosieFingerprint }
    meilisearch = @{ fingerprint = $meilisearchFingerprint }
    cube = @{ fingerprint = $cubeFingerprint }
  }
} | ConvertTo-Json -Depth 4
$manifestPath = Join-Path $packageRoot "deployment-package.manifest.json"
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, $manifest, $utf8WithoutBom)

foreach ($doc in @(
  "docs\STORE_DEPLOYMENT_GUIDE.md",
  "docs\PWA_AND_REGISTER_DEPLOYMENT_TASKS.md",
  "docs\HARDWARE_MANAGEMENT.md",
  "docs\LOCAL_UPDATE_PROTOCOL.md",
  "docs\WINDOWS_INSTALLER_PACKAGE.md",
  "docs\DEPLOYMENT_MANAGER.md",
  "docs\ROS_SERVER_MANAGER.md"
  "docs\CUBE_INSIGHTS_REPORTING.md"
)) {
  $source = Join-Path $repoRoot $doc
  if (Test-Path $source) {
    Copy-Item $source "$packageRoot\docs" -Force
  }
}

if (Test-Path $RegisterBundlePath) {
  Copy-Item "$RegisterBundlePath\*" "$packageRoot\register" -Recurse -Force

  # Companion-app installers belong only in the complete deployment package.
  $bridgeGuiFiles = @(Get-ChildItem "$packageRoot\register" -Recurse -Filter "*counterpoint-bridge-gui*")
  if ($PackageFlavor -eq "Windows-Deployment") {
    New-Item -ItemType Directory -Force -Path "$packageRoot\counterpoint-bridge-gui" | Out-Null
    $bridgeGuiFiles | ForEach-Object {
      Copy-Item $_.FullName "$packageRoot\counterpoint-bridge-gui\" -Force
      Remove-Item $_.FullName -Force
    }
  } else {
    $bridgeGuiFiles | Remove-Item -Force
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
  "- The local non-Docker Cube Core reporting runtime and startup task on http://127.0.0.1:4000.`n" +
  "- The Riverside Windows desktop app configured to use the local server.`n" +
  "`nPassword handling:`n" +
  "`n- If PostgreSQL is missing, the manager can offer to install PostgreSQL 16 through Windows Package Manager.`n" +
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
if ($PackageFlavor -eq "MainHub-Update") {
  $readme = "# RiversideOS $Version Main Hub Update Package`n" +
    "`nPackage build: $gitShort`n" +
    "`nThis exact-build package is for Settings -> Updates on an existing Main Hub.`n" +
    "It is not a first-time installer or recovery package.`n" +
    "`nThe updater verifies the GitHub digest, every packaged file, the existing Main Hub,`n" +
    "a pre-migration database backup, migration checksums, exact build readiness, and rollback files.`n" +
    "Unchanged ROSIE, Meilisearch, and Cube Core fingerprints are preserved; changed components`n" +
    "use their complete verified setup path. Use Windows-Deployment.zip for installation or repair."
}
Set-Content -Path "$packageRoot\README.md" -Value $readme -Encoding UTF8

$checksumLines = Get-ChildItem $packageRoot -Recurse -File |
  Where-Object { $_.Name -ne "deployment-package.files.sha256" } |
  Sort-Object FullName |
  ForEach-Object {
    $relativePath = $_.FullName.Substring($packageRoot.Length + 1)
    $hash = (Get-FileHash -Algorithm SHA256 -Path $_.FullName).Hash.ToLowerInvariant()
    "$hash *$relativePath"
  }
Set-Content -Path "$packageRoot\deployment-package.files.sha256" -Value $checksumLines -Encoding ASCII

& (Join-Path $packageRoot "verify-deployment-package.ps1") -PackageRoot $packageRoot
Compress-Archive -Path "$packageRoot\*" -DestinationPath "$packageRoot.zip" -Force
Write-Host "Deployment package created:"
Write-Host $packageRoot
Write-Host "$packageRoot.zip"
