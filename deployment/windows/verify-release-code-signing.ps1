[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string[]]$Path
)

$ErrorActionPreference = "Stop"
$files = foreach ($item in $Path) {
  if (Test-Path $item -PathType Leaf) {
    Get-Item $item
  } elseif (Test-Path $item -PathType Container) {
    Get-ChildItem $item -Recurse -File -Include *.exe,*.msi
  } else {
    throw "Signing verification path does not exist: $item"
  }
}

if (-not $files) {
  throw "No Windows executable or MSI files were found for signing verification."
}
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature $file.FullName
  if ($signature.Status -ne "Valid") {
    throw "Authenticode signature is not valid for $($file.FullName): $($signature.Status) $($signature.StatusMessage)"
  }
  Write-Host "Valid Authenticode signature: $($file.FullName)" -ForegroundColor Green
}
