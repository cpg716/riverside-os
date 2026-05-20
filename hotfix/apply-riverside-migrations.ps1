[CmdletBinding()]
param(
  [string]$ConfigPath = "",
  [string]$MigrationsDir = "",
  [switch]$ApplySeeds
)

$ErrorActionPreference = "Stop"

function Resolve-ExistingPath([string[]]$Candidates, [string]$Description) {
  foreach ($candidate in $Candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path $candidate)) {
      return (Resolve-Path $candidate).Path
    }
  }

  throw "$Description not found. Run Start-RiversideDeployment.cmd once first so it can save deployment settings, or run this from a release package that contains $Description."
}

function Escape-SqlLiteral([string]$Value) {
  return $Value.Replace("'", "''")
}

function Invoke-PsqlText([string]$PsqlPath, [string]$DatabaseUrl, [string]$Sql) {
  $output = & $PsqlPath $DatabaseUrl -v ON_ERROR_STOP=1 -tAc $Sql
  if ($LASTEXITCODE -ne 0) {
    throw "psql failed with exit code $LASTEXITCODE."
  }
  return (($output -join "")).Trim()
}

function Invoke-PsqlFile([string]$PsqlPath, [string]$DatabaseUrl, [string]$FilePath) {
  & $PsqlPath $DatabaseUrl -v ON_ERROR_STOP=1 -f $FilePath
  if ($LASTEXITCODE -ne 0) {
    throw "Migration failed: $(Split-Path -Leaf $FilePath). psql exited with code $LASTEXITCODE."
  }
}

function Invoke-PsqlCommand([string]$PsqlPath, [string]$DatabaseUrl, [string]$Sql) {
  & $PsqlPath $DatabaseUrl -v ON_ERROR_STOP=1 -c $Sql | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "psql failed with exit code $LASTEXITCODE."
  }
}

function Get-MigrationSortKey($File) {
  if ($File.BaseName -match '^(\d+)') {
    return [int]$Matches[1]
  }
  return [int]::MaxValue
}

function Get-MigrationLedgerExists([string]$PsqlPath, [string]$DatabaseUrl) {
  $exists = Invoke-PsqlText $PsqlPath $DatabaseUrl "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations');"
  return $exists -eq "t"
}

function Get-MigrationApplied([string]$PsqlPath, [string]$DatabaseUrl, [string]$Version) {
  $migrationVersion = Escape-SqlLiteral $Version
  $applied = Invoke-PsqlText $PsqlPath $DatabaseUrl "SELECT EXISTS(SELECT 1 FROM ros_schema_migrations WHERE version = '$migrationVersion');"
  return $applied -eq "t"
}

function Add-MigrationLedgerEntry([string]$PsqlPath, [string]$DatabaseUrl, [string]$Version) {
  $migrationVersion = Escape-SqlLiteral $Version
  Invoke-PsqlCommand $PsqlPath $DatabaseUrl "INSERT INTO ros_schema_migrations (version) SELECT '$migrationVersion' WHERE NOT EXISTS (SELECT 1 FROM ros_schema_migrations WHERE version = '$migrationVersion');"
}

function Apply-Migrations([string]$PsqlPath, [string]$DatabaseUrl, [string]$Dir) {
  $files = Get-ChildItem $Dir -Filter "*.sql" |
    Where-Object { $_.BaseName -match '^\d+_' } |
    Sort-Object @{ Expression = { Get-MigrationSortKey $_ } }

  if (-not $files) {
    throw "No numbered migration files found in $Dir."
  }

  foreach ($file in $files) {
    if (Get-MigrationLedgerExists $PsqlPath $DatabaseUrl) {
      if (Get-MigrationApplied $PsqlPath $DatabaseUrl $file.Name) {
        Write-Host "Skip migration $($file.Name)"
        continue
      }
    }

    Write-Host "Apply migration $($file.Name)"
    Invoke-PsqlFile $PsqlPath $DatabaseUrl $file.FullName

    if (-not (Get-MigrationLedgerExists $PsqlPath $DatabaseUrl)) {
      throw "Migration $($file.Name) did not create public.ros_schema_migrations; cannot record ledger state."
    }
    Add-MigrationLedgerEntry $PsqlPath $DatabaseUrl $file.Name
  }
}

function Apply-SeedFiles([string]$PsqlPath, [string]$DatabaseUrl, [string]$Dir) {
  if (-not (Test-Path $Dir)) {
    Write-Host "No seed folder found; skipping seeds."
    return
  }

  foreach ($file in @("seed_core_required.sql", "seed_rbac.sql")) {
    $path = Join-Path $Dir $file
    if (Test-Path $path) {
      Write-Host "Apply seed $file"
      Invoke-PsqlFile $PsqlPath $DatabaseUrl $path
    }
  }
}

$defaultConfigCandidates = @(
  $ConfigPath,
  (Join-Path $PSScriptRoot "riverside-deployment.config.json"),
  (Join-Path (Split-Path -Parent $PSScriptRoot) "riverside-deployment.config.json"),
  "C:\RiversideOS\release\riverside-deployment.config.json"
)
$resolvedConfigPath = Resolve-ExistingPath $defaultConfigCandidates "riverside-deployment.config.json"

$defaultMigrationCandidates = @(
  $MigrationsDir,
  (Join-Path $PSScriptRoot "migrations"),
  "C:\RiversideOS\release\migrations"
)
$resolvedMigrationsDir = Resolve-ExistingPath $defaultMigrationCandidates "migrations folder"

$config = Get-Content $resolvedConfigPath -Raw | ConvertFrom-Json

function New-RiversideSecret([int]$Length) {
  $chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  $random = New-Object System.Random
  $result = ""
  for ($i = 0; $i -lt $Length; $i++) {
    $result += $chars[$random.Next(0, $chars.Length)]
  }
  return $result
}

function Test-PlaceholderSecret([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
  return $Value -match "replace-" -or $Value -eq "password" -or $Value -eq "placeholder"
}

function Set-SafeProperty($Object, $Name, $Value) {
  if ($null -eq $Object) { return }
  if ($Object.PSObject.Properties[$Name]) {
    $Object.$Name = $Value
  } else {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
  }
}

$configModified = $false

if (Test-PlaceholderSecret $config.server.storeCustomerJwtSecret) {
  Set-SafeProperty $config.server "storeCustomerJwtSecret" (New-RiversideSecret 32)
  $configModified = $true
}

if (Test-PlaceholderSecret $config.server.database.appPassword) {
  Set-SafeProperty $config.server.database "appPassword" (New-RiversideSecret 24)
  $configModified = $true
}

if ($configModified) {
  $configJson = $config | ConvertTo-Json -Depth 8
  Set-Content -Path $resolvedConfigPath -Value $configJson -Encoding UTF8
  Write-Host "Auto-resolved credentials inside $resolvedConfigPath." -ForegroundColor Green
}

$db = $config.server.database
$psql = $db.psqlPath

if ([string]::IsNullOrWhiteSpace($psql) -or -not (Test-Path $psql)) {
  $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    $psql = $cmd.Source
  } else {
    $matches = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
    if ($matches) {
      $psql = $matches[0].FullName
    }
  }
}

if ([string]::IsNullOrWhiteSpace($psql) -or -not (Test-Path $psql)) {
  throw "PostgreSQL psql.exe path is missing or invalid. Set server.database.psqlPath in the config."
}

if ([string]::IsNullOrWhiteSpace($db.appPassword)) {
  throw "Riverside database password is blank in deployment config."
}

$databaseUrl = "postgresql://$($db.appUser)@$($db.host):$($db.port)/$($db.databaseName)"
$env:PGPASSWORD = $db.appPassword
try {
  Write-Host "Config: $resolvedConfigPath"
  Write-Host "Migrations: $resolvedMigrationsDir"
  Apply-Migrations $psql $databaseUrl $resolvedMigrationsDir

  if ($ApplySeeds) {
    Apply-SeedFiles $psql $databaseUrl (Join-Path (Split-Path -Parent $resolvedMigrationsDir) "seeds")
  }

  Write-Host "Riverside migrations are current."
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
