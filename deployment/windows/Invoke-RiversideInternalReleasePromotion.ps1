[CmdletBinding()]
param(
  [string]$WorkerRoot = "C:\ProgramData\RiversideOS\build-worker",
  [string]$UpdateRoot = "C:\ProgramData\RiversideOS\updates"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-PromotionStatus(
  [string]$Status,
  [string]$Message,
  [string]$JobId = "",
  [string]$SourceGitSha = ""
) {
  $statusPath = Join-Path $WorkerRoot "promotion\promotion-status.json"
  $statusDir = Split-Path $statusPath -Parent
  New-Item -ItemType Directory -Force -Path $statusDir | Out-Null
  [ordered]@{
    contractVersion = 1
    status = $Status
    message = $Message
    jobId = $JobId
    sourceGitSha = $SourceGitSha
    updatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  } | ConvertTo-Json -Depth 4 | Set-Content -Path $statusPath -Encoding UTF8
}

function Assert-Sha256([string]$Path, [string]$ExpectedSha256, [long]$ExpectedBytes) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Internal release asset is missing: $Path"
  }
  $file = Get-Item -LiteralPath $Path
  if ($file.Length -ne $ExpectedBytes) {
    throw "Internal release asset byte count mismatch: $($file.Name)"
  }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "Internal release asset SHA-256 mismatch: $($file.Name)"
  }
}

function Get-ReadyBuild([string]$ExpectedSourceSha) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/ready" -UseBasicParsing -TimeoutSec 5
    if ([int]$response.StatusCode -ne 200) { return $null }
    $ready = $response.Content | ConvertFrom-Json
    $observed = "$($ready.build_sha)".Trim().ToLowerInvariant()
    $expected = $ExpectedSourceSha.Trim().ToLowerInvariant()
    if ($ready.database.connected -ne $true -or
        $ready.search.authoritative -ne $true -or
        $observed -ne $expected) {
      return $null
    }
    return $observed
  } catch {
    return $null
  }
}

function Resolve-DeploymentConfig([string]$InstallRoot, [string]$PackageRoot) {
  foreach ($candidate in @(
    (Join-Path $InstallRoot "riverside-deployment.config.json"),
    (Join-Path $env:ProgramData "RiversideOS\riverside-deployment.config.json"),
    (Join-Path $PackageRoot "riverside-deployment.config.json")
  )) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  throw "Could not find the existing Main Hub deployment configuration."
}

$requestPath = Join-Path $WorkerRoot "promotion\promotion-request.json"
$lockPath = Join-Path $WorkerRoot "locks\internal-release-promotion.lock"
$lockStream = $null
$transcriptStarted = $false
$jobId = ""
$expectedSourceSha = ""

try {
  $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  if (-not (Test-Path -LiteralPath $requestPath -PathType Leaf)) {
    throw "Internal release promotion request is missing: $requestPath"
  }
  $request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
  if ($request.contractVersion -ne 1 -or $request.jobId -notmatch '^[A-Za-z0-9._-]+$') {
    throw "Internal release promotion request is invalid."
  }
  $jobId = "$($request.jobId)"
  $expectedSourceSha = "$($request.expectedSourceSha)".Trim().ToLowerInvariant()
  if ($expectedSourceSha -notmatch '^[0-9a-f]{40}$') {
    throw "Internal release promotion requires an exact 40-character source SHA."
  }
  if (-not $request.allowStoreHours) {
    $hour = (Get-Date).Hour
    if ($hour -ge 10 -and $hour -lt 18) {
      throw "Internal release promotion is blocked from 10 AM through 6 PM unless store-hours approval is explicit."
    }
  }

  $artifactRoot = [IO.Path]::GetFullPath((Join-Path $WorkerRoot "artifacts"))
  $candidateRoot = [IO.Path]::GetFullPath("$($request.candidateDirectory)")
  if (-not ($candidateRoot + '\').StartsWith($artifactRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Internal release candidate must be inside the build-worker artifacts directory."
  }
  $releasePath = Join-Path $candidateRoot "release.json"
  $release = Get-Content -LiteralPath $releasePath -Raw | ConvertFrom-Json
  if ($release.contractVersion -ne 1 -or "$($release.sourceGitSha)".ToLowerInvariant() -ne $expectedSourceSha) {
    throw "Internal release metadata does not match the requested exact source SHA."
  }
  if ([string]::IsNullOrWhiteSpace("$($release.windowsUpdater.signature)")) {
    throw "Internal release is missing the Tauri updater signature."
  }
  foreach ($assetName in @("$($release.mainHubPackage.fileName)", "$($release.windowsUpdater.fileName)")) {
    if ($assetName -notmatch '^[A-Za-z0-9._-]{1,180}$' -or $assetName -in @('.', '..')) {
      throw "Internal release contains an invalid asset name."
    }
  }

  $mainHubPackagePath = Join-Path $candidateRoot "$($release.mainHubPackage.fileName)"
  $windowsUpdaterPath = Join-Path $candidateRoot "$($release.windowsUpdater.fileName)"
  Assert-Sha256 $mainHubPackagePath "$($release.mainHubPackage.sha256)" ([long]$release.mainHubPackage.bytes)
  Assert-Sha256 $windowsUpdaterPath "$($release.windowsUpdater.sha256)" ([long]$release.windowsUpdater.bytes)

  $workRoot = Join-Path $WorkerRoot ("promotion\work\" + $jobId)
  Remove-Item $workRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
  $transcriptPath = Join-Path $workRoot "promotion-transcript.txt"
  Start-Transcript -Path $transcriptPath -Force | Out-Null
  $transcriptStarted = $true
  Write-PromotionStatus "INSTALLING" "Verified candidate; guarded Main Hub installation started." $jobId $expectedSourceSha

  $packageRoot = Join-Path $workRoot "package"
  Expand-Archive -LiteralPath $mainHubPackagePath -DestinationPath $packageRoot -Force
  $installServer = Get-ChildItem $packageRoot -Recurse -Filter "install-server.ps1" -File | Select-Object -First 1
  if (-not $installServer) {
    throw "Main Hub package does not contain install-server.ps1."
  }
  $packageScriptRoot = $installServer.DirectoryName
  $packageManifestPath = Join-Path $packageScriptRoot "deployment-package.manifest.json"
  $packageManifest = Get-Content -LiteralPath $packageManifestPath -Raw | ConvertFrom-Json
  if ("$($packageManifest.sourceGitSha)".ToLowerInvariant() -ne $expectedSourceSha) {
    throw "Extracted Main Hub package does not match the requested exact source SHA."
  }

  $installRoot = "C:\RiversideOS"
  $existingConfig = Resolve-DeploymentConfig $installRoot $packageScriptRoot
  $stagedConfig = Join-Path $packageScriptRoot "riverside-deployment.config.json"
  if ($existingConfig -ne $stagedConfig) {
    Copy-Item -LiteralPath $existingConfig -Destination $stagedConfig -Force
  }

  Push-Location $packageScriptRoot
  try {
    & powershell.exe `
      -NoProfile `
      -ExecutionPolicy Bypass `
      -File $installServer.FullName `
      -ConfigPath $stagedConfig
    if ($LASTEXITCODE -ne 0) {
      throw "install-server.ps1 failed with exit code $LASTEXITCODE."
    }
    $installRegister = Join-Path $packageScriptRoot "install-register.ps1"
    if (-not (Test-Path -LiteralPath $installRegister -PathType Leaf)) {
      throw "Main Hub package does not contain install-register.ps1."
    }
    & powershell.exe `
      -NoProfile `
      -ExecutionPolicy Bypass `
      -File $installRegister `
      -ConfigPath $stagedConfig `
      -StationMode mainhub `
      -NoLaunch
    if ($LASTEXITCODE -ne 0) {
      throw "install-register.ps1 failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }

  $observedBuild = $null
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    $observedBuild = Get-ReadyBuild $expectedSourceSha
    if ($observedBuild) { break }
    Start-Sleep -Seconds 2
  }
  if (-not $observedBuild) {
    throw "The installed Main Hub did not reach exact-build database/search readiness within 180 seconds. The internal feed was not promoted."
  }

  New-Item -ItemType Directory -Force -Path $UpdateRoot | Out-Null
  $updateAcl = Get-Acl $UpdateRoot
  $updateAcl.SetAccessRuleProtection($true, $false)
  $updateInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($updateAccessRule in @(
    (New-Object Security.AccessControl.FileSystemAccessRule(
      "SYSTEM", "FullControl", $updateInheritance, "None", "Allow"
    )),
    (New-Object Security.AccessControl.FileSystemAccessRule(
      "BUILTIN\Administrators", "FullControl", $updateInheritance, "None", "Allow"
    )),
    (New-Object Security.AccessControl.FileSystemAccessRule(
      "BUILTIN\Users", "ReadAndExecute", $updateInheritance, "None", "Allow"
    ))
  )) {
    $updateAcl.SetAccessRule($updateAccessRule)
  }
  Set-Acl -Path $UpdateRoot -AclObject $updateAcl
  $candidateFeed = Join-Path $UpdateRoot (".candidate-" + $jobId)
  $currentFeed = Join-Path $UpdateRoot "current"
  $previousFeed = Join-Path $UpdateRoot "previous"
  Remove-Item $candidateFeed -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $candidateFeed | Out-Null
  foreach ($source in @($releasePath, $mainHubPackagePath, $windowsUpdaterPath)) {
    Copy-Item -LiteralPath $source -Destination $candidateFeed -Force
  }
  Assert-Sha256 `
    (Join-Path $candidateFeed "$($release.mainHubPackage.fileName)") `
    "$($release.mainHubPackage.sha256)" `
    ([long]$release.mainHubPackage.bytes)
  Assert-Sha256 `
    (Join-Path $candidateFeed "$($release.windowsUpdater.fileName)") `
    "$($release.windowsUpdater.sha256)" `
    ([long]$release.windowsUpdater.bytes)

  Remove-Item $previousFeed -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $currentFeed) {
    Move-Item $currentFeed $previousFeed
  }
  try {
    Move-Item $candidateFeed $currentFeed
  } catch {
    if (-not (Test-Path $currentFeed) -and (Test-Path $previousFeed)) {
      Move-Item $previousFeed $currentFeed
    }
    throw
  }

  Write-PromotionStatus "READY" "Main Hub and internal workstation feed are current at the exact promoted build." $jobId $expectedSourceSha
  Remove-Item $requestPath -Force -ErrorAction SilentlyContinue
} catch {
  Write-PromotionStatus "FAILED" $_.Exception.Message $jobId $expectedSourceSha
  throw
} finally {
  if ($transcriptStarted) {
    Stop-Transcript | Out-Null
  }
  if ($lockStream) {
    $lockStream.Dispose()
  }
}
