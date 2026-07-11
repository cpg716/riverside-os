[CmdletBinding()]
param(
  [string]$PackageRoot = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$checksumPath = Join-Path $PackageRoot "deployment-package.files.sha256"
if (-not (Test-Path $checksumPath)) {
  throw "Deployment package checksum manifest is missing: $checksumPath"
}

$verified = 0
foreach ($line in Get-Content $checksumPath) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  if ($line -notmatch '^([A-Fa-f0-9]{64}) \*(.+)$') {
    throw "Invalid deployment package checksum entry: $line"
  }
  $expected = $Matches[1].ToUpperInvariant()
  $relativePath = $Matches[2]
  $filePath = Join-Path $PackageRoot $relativePath
  if (-not (Test-Path $filePath -PathType Leaf)) {
    throw "Deployment package file is missing: $relativePath"
  }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $filePath).Hash.ToUpperInvariant()
  if ($actual -ne $expected) {
    throw "Deployment package checksum mismatch: $relativePath"
  }
  $verified++
}

if ($verified -eq 0) {
  throw "Deployment package checksum manifest contained no files."
}
Write-Host "Verified $verified deployment package files." -ForegroundColor Green
