[CmdletBinding()]
param(
  [string]$ConfigPath = "",
  [string]$NewPassword = ""
)

$ErrorActionPreference = "Stop"

$ScriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ScriptRoot)) {
  $ScriptRoot = if ($MyInvocation -and $MyInvocation.MyCommand -and $MyInvocation.MyCommand.Path) {
    Split-Path $MyInvocation.MyCommand.Path -Parent
  } else { "." }
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ($null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' }))
}

if (-not (Test-Admin)) {
  Write-Host "This script requires Administrator privileges to modify PostgreSQL services." -ForegroundColor Red
  exit 1
}

# Resolve config
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $ScriptRoot "riverside-deployment.config.json"
}

if (-not (Test-Path $ConfigPath)) {
  throw "Config file not found: $ConfigPath"
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$dbUser = "postgres"
if ($config.server.database.adminUser) {
  $dbUser = $config.server.database.adminUser
}

if ([string]::IsNullOrWhiteSpace($NewPassword)) {
  # Auto-generate a secure password if none provided
  $chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  $random = New-Object System.Random
  $NewPassword = ""
  for ($i = 0; $i -lt 16; $i++) {
    $NewPassword += $chars[$random.Next(0, $chars.Length)]
  }
  Write-Host "No password provided. Auto-generated new password." -ForegroundColor Cyan
}

# 1. Locate PostgreSQL Data Directory
Write-Host "Locating PostgreSQL installation..."
$pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pgService) {
  throw "Could not find a running PostgreSQL service."
}

$serviceName = $pgService.Name
$wmiService = Get-WmiObject win32_service | Where-Object { $_.Name -eq $serviceName }
$binPath = $wmiService.PathName

# binPath usually looks like: "C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe" runservice -N "postgresql-x64-16" -D "C:\Program Files\PostgreSQL\16\data" -w
$dataDir = $null
if ($binPath -match '-D\s+"([^"]+)"') {
  $dataDir = $matches[1]
} elseif ($binPath -match '-D\s+([^ ]+)') {
  $dataDir = $matches[1]
}

if (-not $dataDir -or -not (Test-Path $dataDir)) {
  throw "Could not extract PostgreSQL data directory from service path: $binPath"
}

Write-Host "Found PostgreSQL data directory: $dataDir"

$pgHbaPath = Join-Path $dataDir "pg_hba.conf"
if (-not (Test-Path $pgHbaPath)) {
  throw "pg_hba.conf not found at $pgHbaPath"
}

# 2. Backup pg_hba.conf
$backupPath = "$pgHbaPath.bak"
Copy-Item $pgHbaPath $backupPath -Force
Write-Host "Backed up pg_hba.conf to $backupPath"

# 3. Modify pg_hba.conf to trust local connections
Write-Host "Modifying pg_hba.conf to temporarily trust all local connections..."
$hbaLines = Get-Content $pgHbaPath
$newHbaLines = @()
foreach ($line in $hbaLines) {
  if ($line -match '^\s*host\s+(all|postgres)\s+(all|postgres)\s+(127\.0\.0\.1/32|::1/128)\s+(scram-sha-256|md5)') {
    $line = $line -replace '(scram-sha-256|md5)', 'trust'
  }
  $newHbaLines += $line
}
Set-Content -Path $pgHbaPath -Value $newHbaLines -Encoding UTF8

# 4. Restart PostgreSQL
Write-Host "Restarting PostgreSQL service ($serviceName)..."
Restart-Service -Name $serviceName -Force
Start-Sleep -Seconds 3

# 5. Reset Password using psql
Write-Host "Resetting password for user '$dbUser'..."
$psqlCmd = Get-Command psql.exe -ErrorAction SilentlyContinue
$psqlPath = if ($psqlCmd) { $psqlCmd.Source } else {
  $matches = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
  if ($matches) { $matches[0].FullName } else { "psql.exe" }
}

$resetSql = "ALTER USER ""$dbUser"" WITH PASSWORD '$NewPassword';"
$env:PGPASSWORD = ""
& $psqlPath -U $dbUser -h 127.0.0.1 -p 5432 -d postgres -c $resetSql -t 2>&1
if ($LASTEXITCODE -ne 0) {
  # Try without specifying host just in case
  & $psqlPath -U $dbUser -d postgres -c $resetSql -t 2>&1
}

# 6. Restore pg_hba.conf
Write-Host "Restoring original pg_hba.conf..."
Copy-Item $backupPath $pgHbaPath -Force
Remove-Item $backupPath -Force

# 7. Restart PostgreSQL again
Write-Host "Restarting PostgreSQL service again to enforce passwords..."
Restart-Service -Name $serviceName -Force
Start-Sleep -Seconds 3

# 8. Save new password to config
if ($config.server) {
  if (-not $config.server.database) {
    $config.server | Add-Member -MemberType NoteProperty -Name "database" -Value (New-Object PSObject)
  }
  
  $db = $config.server.database
  $exists = $db.psobject.properties.match("adminPassword").Count -gt 0
  if ($exists) {
    $db.adminPassword = $NewPassword
  } else {
    $db | Add-Member -MemberType NoteProperty -Name "adminPassword" -Value $NewPassword
  }
  
  $configJson = $config | ConvertTo-Json -Depth 8
  Set-Content -Path $ConfigPath -Value $configJson -Encoding UTF8
  Write-Host "Successfully saved new admin password to $ConfigPath" -ForegroundColor Green
}

Write-Host "Password reset complete. You can now run updates and migrations." -ForegroundColor Green
