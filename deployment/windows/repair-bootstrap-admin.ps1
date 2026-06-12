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
  # Close stdin so psql can never open an interactive password prompt.
  $psi.RedirectStandardInput = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  [void]$process.Start()
  $process.StandardInput.Close()
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
    $exitCode = Invoke-NativeCommand $PsqlPath @($DatabaseUrl, "-v", "ON_ERROR_STOP=1", "-w", "-f", $temp.FullName)
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

function Resolve-ExistingPath([string[]]$Candidates, [string]$Description) {
  foreach ($candidate in $Candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path $candidate)) {
      return (Resolve-Path $candidate).Path
    }
  }
  throw "$Description not found. Run Start-RiversideDeployment.cmd once first so it can save deployment settings."
}

$resolvedConfigPath = Resolve-ExistingPath @(
  $ConfigPath,
  (Join-Path $ScriptRoot "riverside-deployment.config.json"),
  (Join-Path (Split-Path -Parent $ScriptRoot) "riverside-deployment.config.json")
) "riverside-deployment.config.json"

$config = Get-Content $resolvedConfigPath -Raw | ConvertFrom-Json
if (-not $config.server -or -not $config.server.database) {
  throw "Config file is missing server.database settings: $resolvedConfigPath"
}
$db = $config.server.database
if ($db.adminUser -match '^(Admin|Administrator)$') { $db.adminUser = "postgres" }
if ($db.appUser -match '^(Admin|Administrator)$') { $db.appUser = "riverside_app" }
if ([string]::IsNullOrWhiteSpace($db.adminUser)) { $db.adminUser = "postgres" }
if ([string]::IsNullOrWhiteSpace($db.appUser)) { $db.appUser = "riverside_app" }
$psql = Resolve-PsqlPath $db
$databaseUrl = "postgresql://$($db.appUser):$($db.appPassword)@$($db.host):$($db.port)/$($db.databaseName)"
$bootstrapPinHash = '$argon2id$v=19$m=19456,t=2,p=1$KWJoKjtQYNuPjRIyKL2M9g$FBpoET53ejevTU5LrsLTzQMrgXpV5NavqruJmerdPsc'

$env:PGPASSWORD = $db.appPassword
try {
  $sql = "UPDATE staff SET full_name = 'Chris G', pin_hash = '$bootstrapPinHash', role = 'admin'::staff_role, " +
    "is_active = TRUE, avatar_key = COALESCE(avatar_key, 'ros_default') WHERE cashier_code = '1234'; " +
    "INSERT INTO staff (full_name, cashier_code, pin_hash, role, is_active, avatar_key) " +
    "SELECT 'Chris G', '1234', '$bootstrapPinHash', 'admin'::staff_role, TRUE, 'ros_default' " +
    "WHERE NOT EXISTS (SELECT 1 FROM staff WHERE cashier_code = '1234'); " +
    "DO `$`$ BEGIN " +
    "IF NOT EXISTS (SELECT 1 FROM staff WHERE cashier_code = '1234' AND role = 'admin'::staff_role AND is_active = TRUE AND pin_hash IS NOT NULL) THEN " +
    "RAISE EXCEPTION 'Bootstrap admin was not created.'; END IF; END `$`$;"
  Invoke-Psql $psql $databaseUrl $sql
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

Write-Host "Bootstrap admin ready: Chris G / Access PIN 1234"
