param(
  [Parameter(Mandatory = $true)]
  [string]$PackageJsonPath,

  [Parameter(Mandatory = $true)]
  [string]$TargetRoot,

  [Parameter(Mandatory = $true)]
  [string]$OutputDir,

  [Parameter(Mandatory = $true)]
  [string]$ManifestName,

  [Parameter(Mandatory = $true)]
  [string]$BaseUrl,

  [string]$Notes = "Riverside app update",
  [string]$BuildManifestName = "",
  [string]$PlatformKey = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $PackageJsonPath)) {
  throw "Package JSON not found: $PackageJsonPath"
}
if (-not (Test-Path $TargetRoot)) {
  throw "Tauri target root not found: $TargetRoot"
}

$sig = Get-ChildItem -Path $TargetRoot -Recurse -Filter *.sig |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if ($null -eq $sig) {
  throw "No updater signature file (*.sig) found under $TargetRoot. Ensure TAURI_SIGNING_PRIVATE_KEY is configured and createUpdaterArtifacts is enabled."
}

$artifactPath = [System.IO.Path]::GetFullPath(($sig.FullName.Substring(0, $sig.FullName.Length - 4)))
if (-not (Test-Path $artifactPath)) {
  throw "Could not find updater artifact paired with signature: $artifactPath"
}

$pkg = Get-Content $PackageJsonPath | ConvertFrom-Json
$version = "$($pkg.version)"
if ([string]::IsNullOrWhiteSpace($version)) {
  throw "Package JSON does not define a version: $PackageJsonPath"
}

$gitFull = if (-not [string]::IsNullOrWhiteSpace($env:RIVERSIDE_BUILD_SHA)) {
  $env:RIVERSIDE_BUILD_SHA
} elseif (-not [string]::IsNullOrWhiteSpace($env:GITHUB_SHA)) {
  $env:GITHUB_SHA
} else {
  (git rev-parse HEAD).Trim()
}
$gitShort = if ($gitFull.Length -ge 8) { $gitFull.Substring(0, 8) } else { $gitFull }
$updaterVersion = "$version+$gitShort"
$pubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$artifactName = [System.IO.Path]::GetFileName($artifactPath)
$releaseAssetName = $artifactName -replace ' ', '.'
$releaseSignatureName = "$releaseAssetName.sig"
$signature = (Get-Content $sig.FullName -Raw).Trim()
$assetUrl = "$($BaseUrl.TrimEnd('/'))/$releaseAssetName"

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
Copy-Item -Path $artifactPath -Destination (Join-Path $OutputDir $releaseAssetName) -Force
Copy-Item -Path $sig.FullName -Destination (Join-Path $OutputDir $releaseSignatureName) -Force

if ([string]::IsNullOrWhiteSpace($PlatformKey)) {
  $manifest = @{
    version = $updaterVersion
    notes = $Notes
    pub_date = $pubDate
    build_sha = $gitFull
    signature = $signature
    url = $assetUrl
  }
} else {
  $manifest = @{
    version = $updaterVersion
    notes = $Notes
    pub_date = $pubDate
    build_sha = $gitFull
    platforms = @{
      $PlatformKey = @{
        signature = $signature
        url = $assetUrl
      }
    }
  }
}

$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $OutputDir $ManifestName) -NoNewline

if (-not [string]::IsNullOrWhiteSpace($BuildManifestName)) {
  @{
    version = $version
    updaterVersion = $updaterVersion
    sourceGitSha = $gitFull
    sourceGitShort = $gitShort
    asset = $releaseAssetName
    signatureAsset = $releaseSignatureName
    builtAt = $pubDate
  } | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $OutputDir $BuildManifestName) -NoNewline
}

Write-Host "Prepared updater manifest $ManifestName for $updaterVersion using $releaseAssetName"
