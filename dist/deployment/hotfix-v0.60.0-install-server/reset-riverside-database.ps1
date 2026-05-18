[CmdletBinding()]
param(
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"
$script:lastNativeCommandOutput = ""

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this reset tool as Administrator."
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
  $script:lastNativeCommandOutput = (($stderr, $stdout) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd() }) -join "`n"

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
  throw "psql.exe was not found. Open the Deployment Manager first so PostgreSQL can be installed."
}

function Escape-SqlIdentifier([string]$Value) {
  return $Value.Replace('"', '""')
}

try {
  Assert-Admin
  Add-Type -AssemblyName System.Windows.Forms

  if (-not $ConfigPath) {
    $ConfigPath = Join-Path $PSScriptRoot "riverside-deployment.config.json"
  }
  if (-not [System.IO.Path]::IsPathRooted($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot $ConfigPath
  }

  if (-not (Test-Path $ConfigPath)) {
    $parentConfigPath = Join-Path (Split-Path -Parent $PSScriptRoot) "riverside-deployment.config.json"
    if (Test-Path $parentConfigPath) {
      $ConfigPath = $parentConfigPath
    }
  }
  if (-not (Test-Path $ConfigPath)) {
    throw "Config file not found: $ConfigPath. Put Reset-RiversideDatabase.cmd next to riverside-deployment.config.json, or run Start-RiversideDeployment.cmd once first so it can save deployment settings."
  }

  $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
  $db = $config.server.database
  $databaseName = "$($db.databaseName)"
  if (-not $databaseName) {
    throw "server.database.databaseName is blank in the deployment config."
  }

  $confirm = [System.Windows.Forms.MessageBox]::Show(
    "This will delete and recreate only the Riverside database '$databaseName'. Use this only during a fresh failed install before store data exists. PostgreSQL itself will stay installed. Continue?",
    "Reset Riverside database",
    "YesNo",
    "Warning"
  )
  if ($confirm -ne "Yes") {
    Write-Host "Reset cancelled."
    exit 0
  }

  $psql = Resolve-PsqlPath $db
  $env:PGPASSWORD = $db.adminPassword
  try {
    $adminUrl = "postgresql://$($db.adminUser)@$($db.host):$($db.port)/postgres"
    $quotedDatabase = Escape-SqlIdentifier $databaseName
    Invoke-Psql $psql $adminUrl @"
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '$($databaseName.Replace("'", "''"))'
  AND pid <> pg_backend_pid();

DROP DATABASE IF EXISTS "$quotedDatabase" WITH (FORCE);

CREATE DATABASE "$quotedDatabase"
  WITH TEMPLATE template0
  ENCODING 'UTF8'
  LC_COLLATE 'C'
  LC_CTYPE 'C';
"@
    $databaseUrl = "postgresql://$($db.adminUser)@$($db.host):$($db.port)/$databaseName"
    Invoke-Psql $psql $databaseUrl "SHOW server_encoding;"
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }

  [System.Windows.Forms.MessageBox]::Show(
    "Riverside database reset complete. The database was recreated as UTF8. Reopen Start-RiversideDeployment.cmd and run Backoffice / Server Install.",
    "Reset complete",
    "OK",
    "Information"
  ) | Out-Null
} catch {
  [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Reset failed", "OK", "Error") | Out-Null
  throw
}
