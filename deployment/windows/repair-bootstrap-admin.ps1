[CmdletBinding()]
param(
  [string]$ConfigPath = ""
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
  $script:lastNativeCommandOutput = (($stdout, $stderr) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd() }) -join "`n"

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

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $ScriptRoot "riverside-deployment.config.json"
}
if (-not (Test-Path $ConfigPath)) {
  throw "Config file not found: $ConfigPath."
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$db = $config.server.database
$psql = Resolve-PsqlPath $db
$databaseUrl = "postgresql://$($db.appUser):$($db.appPassword)@$($db.host):$($db.port)/$($db.databaseName)"
$bootstrapPinHash = '$argon2id$v=19$m=19456,t=2,p=1$KWJoKjtQYNuPjRIyKL2M9g$FBpoET53ejevTU5LrsLTzQMrgXpV5NavqruJmerdPsc'

$env:PGPASSWORD = $db.appPassword
try {
  Invoke-Psql $psql $databaseUrl @"
INSERT INTO staff (
  full_name,
  cashier_code,
  pin_hash,
  role,
  is_active,
  avatar_key
)
VALUES (
  'Chris G',
  '1234',
  '$bootstrapPinHash',
  'admin',
  TRUE,
  'ros_default'
)
ON CONFLICT (cashier_code) DO UPDATE
SET
  full_name = EXCLUDED.full_name,
  pin_hash = EXCLUDED.pin_hash,
  role = EXCLUDED.role,
  is_active = TRUE,
  avatar_key = COALESCE(staff.avatar_key, EXCLUDED.avatar_key);

DO `$`$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM staff
    WHERE cashier_code = '1234'
      AND role = 'admin'::staff_role
      AND is_active = TRUE
      AND pin_hash IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Bootstrap admin was not created.';
  END IF;
END
`$`$;
"@
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

Write-Host "Bootstrap admin ready: Chris G / Access PIN 1234"
