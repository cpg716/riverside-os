param(
  [string]$WorkingDirectory = ".",
  [string[]]$Arguments = @("build"),
  [int]$MaxAttempts = 3,
  [int]$DelaySeconds = 20
)

$ErrorActionPreference = "Stop"

if ($MaxAttempts -lt 1) {
  throw "MaxAttempts must be at least 1."
}

$npx = if ($IsWindows) { "npx.cmd" } else { "npx" }

Push-Location $WorkingDirectory
try {
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    Write-Host "Running: npx tauri $($Arguments -join ' ') (attempt $attempt of $MaxAttempts)"
    & $npx tauri @Arguments
    $exitCode = if ($null -eq $global:LASTEXITCODE) { 0 } else { $global:LASTEXITCODE }

    if ($exitCode -eq 0) {
      return
    }

    if ($attempt -eq $MaxAttempts) {
      exit $exitCode
    }

    Write-Host "Tauri build failed with exit code $exitCode. Retrying in $DelaySeconds seconds..."
    Start-Sleep -Seconds $DelaySeconds
  }
}
finally {
  Pop-Location
}
