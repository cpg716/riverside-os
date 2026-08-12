param(
  [int]$MaxAttempts = 3,
  [int]$InitialDelaySeconds = 10
)

$ErrorActionPreference = "Stop"

if ($MaxAttempts -lt 1) {
  throw "MaxAttempts must be at least 1."
}

if ($InitialDelaySeconds -lt 0) {
  throw "InitialDelaySeconds cannot be negative."
}

$npm = if ($IsWindows) { "npm.cmd" } else { "npm" }

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
  Write-Host "Installing the pinned Cube Core runtime (attempt $attempt of $MaxAttempts)..."
  & $npm ci --prefix cube
  $exitCode = if ($null -eq $global:LASTEXITCODE) { 0 } else { $global:LASTEXITCODE }

  if ($exitCode -eq 0) {
    return
  }

  if ($attempt -eq $MaxAttempts) {
    exit $exitCode
  }

  $delaySeconds = $InitialDelaySeconds * $attempt
  Write-Warning "Cube Core installation failed with exit code $exitCode. Retrying in $delaySeconds seconds..."
  Start-Sleep -Seconds $delaySeconds
}
