[CmdletBinding()]
param(
  [string]$ConfigPath = "",
  [string]$MigrationsDir = "",
  [switch]$ApplySeeds
)

$ErrorActionPreference = "Stop"

$ScriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ScriptRoot)) {
  $ScriptRoot = if ($MyInvocation -and $MyInvocation.MyCommand -and $MyInvocation.MyCommand.Path) {
    Split-Path -Parent $MyInvocation.MyCommand.Path
  } else {
    "."
  }
}

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
  $output = & $PsqlPath $DatabaseUrl -v ON_ERROR_STOP=1 -w -tAc $Sql
  if ($LASTEXITCODE -ne 0) {
    throw "psql failed with exit code $LASTEXITCODE."
  }
  return (($output -join "")).Trim()
}

function Invoke-PsqlFile([string]$PsqlPath, [string]$DatabaseUrl, [string]$FilePath) {
  & $PsqlPath $DatabaseUrl -v ON_ERROR_STOP=1 -1 -w -f $FilePath
  if ($LASTEXITCODE -ne 0) {
    throw "Migration failed: $(Split-Path -Leaf $FilePath). psql exited with code $LASTEXITCODE."
  }
}

function Invoke-PsqlCommand([string]$PsqlPath, [string]$DatabaseUrl, [string]$Sql) {
  & $PsqlPath $DatabaseUrl -v ON_ERROR_STOP=1 -w -c $Sql | Out-Host
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

function Add-MigrationLedgerEntry([string]$PsqlPath, [string]$DatabaseUrl, [string]$Version, [string]$FileSha256) {
  $migrationVersion = Escape-SqlLiteral $Version
  $safeSha = Escape-SqlLiteral $FileSha256
  Invoke-PsqlCommand $PsqlPath $DatabaseUrl "INSERT INTO ros_schema_migrations (version, file_sha256) SELECT '$migrationVersion', '$safeSha' WHERE NOT EXISTS (SELECT 1 FROM ros_schema_migrations WHERE version = '$migrationVersion');"
}

function Ensure-ChecksumColumn([string]$PsqlPath, [string]$DatabaseUrl) {
  if (Get-MigrationLedgerExists $PsqlPath $DatabaseUrl) {
    try {
      Invoke-PsqlText $PsqlPath $DatabaseUrl "ALTER TABLE ros_schema_migrations ADD COLUMN IF NOT EXISTS file_sha256 text;" | Out-Null
    } catch { <# column may already exist #> }
  }
}

function Get-FileSha256([string]$Path) {
  $hash = Get-FileHash -Path $Path -Algorithm SHA256
  return $hash.Hash.ToLower()
}

function Get-Sha256ForBytes([byte[]]$Bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($Bytes)
    return -join ($hash | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha.Dispose()
  }
}

function Get-FileSha256Variants([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $lfBytes = New-Object System.Collections.Generic.List[byte]
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    if ($bytes[$i] -eq 13) {
      if (($i + 1) -lt $bytes.Length -and $bytes[$i + 1] -eq 10) {
        $lfBytes.Add(10)
        $i++
      } else {
        $lfBytes.Add(10)
      }
    } else {
      $lfBytes.Add($bytes[$i])
    }
  }

  $crlfBytes = New-Object System.Collections.Generic.List[byte]
  foreach ($byte in $lfBytes) {
    if ($byte -eq 10) {
      $crlfBytes.Add(13)
      $crlfBytes.Add(10)
    } else {
      $crlfBytes.Add($byte)
    }
  }

  return @(
    Get-Sha256ForBytes $bytes
    Get-Sha256ForBytes $lfBytes.ToArray()
    Get-Sha256ForBytes $crlfBytes.ToArray()
  ) | Select-Object -Unique
}

function Test-MigrationChecksumMatch([string]$StoredSha, [string[]]$AllowedShas) {
  $normalizedStoredSha = $StoredSha.Trim().ToLower()
  return ($AllowedShas -contains $normalizedStoredSha)
}

function Get-StoredChecksum([string]$PsqlPath, [string]$DatabaseUrl, [string]$Version) {
  $migrationVersion = Escape-SqlLiteral $Version
  return Invoke-PsqlText $PsqlPath $DatabaseUrl "SELECT COALESCE(file_sha256, '') FROM ros_schema_migrations WHERE version = '$migrationVersion';"
}

function Update-StoredChecksum([string]$PsqlPath, [string]$DatabaseUrl, [string]$Version, [string]$FileSha256) {
  $migrationVersion = Escape-SqlLiteral $Version
  $safeSha = Escape-SqlLiteral $FileSha256
  Invoke-PsqlText $PsqlPath $DatabaseUrl "UPDATE ros_schema_migrations SET file_sha256 = '$safeSha' WHERE version = '$migrationVersion' AND file_sha256 IS NULL;" | Out-Null
}

function Repair-PublicSerialSequences([string]$PsqlPath, [string]$DatabaseUrl) {
  $sql = @'
DO $$
DECLARE
  rec record;
  max_value bigint;
BEGIN
  FOR rec IN
    SELECT
      n.nspname AS table_schema,
      c.relname AS table_name,
      a.attname AS column_name,
      pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS sequence_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname = 'public'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
  LOOP
    EXECUTE format(
      'SELECT COALESCE(MAX(%I), 0) FROM %I.%I',
      rec.column_name,
      rec.table_schema,
      rec.table_name
    )
    INTO max_value;

    EXECUTE format(
      'SELECT setval(%L::regclass, GREATEST(%s + 1, 1), false)',
      rec.sequence_name,
      max_value
    );
  END LOOP;
END $$;
'@
  Invoke-PsqlCommand $PsqlPath $DatabaseUrl $sql
}

function Apply-Migrations([string]$PsqlPath, [string]$DatabaseUrl, [string]$Dir) {
  $files = Get-ChildItem $Dir -Filter "*.sql" |
    Where-Object { $_.BaseName -match '^\d+_' } |
    Sort-Object @{ Expression = { Get-MigrationSortKey $_ } }

  if (-not $files) {
    throw "No numbered migration files found in $Dir."
  }

  Ensure-ChecksumColumn $PsqlPath $DatabaseUrl
  $driftCount = 0

  foreach ($file in $files) {
    $currentSha = Get-FileSha256 $file.FullName
    $currentShaVariants = Get-FileSha256Variants $file.FullName

    if (Get-MigrationLedgerExists $PsqlPath $DatabaseUrl) {
      if (Get-MigrationApplied $PsqlPath $DatabaseUrl $file.Name) {
        $storedSha = Get-StoredChecksum $PsqlPath $DatabaseUrl $file.Name
        if ([string]::IsNullOrWhiteSpace($storedSha)) {
          Update-StoredChecksum $PsqlPath $DatabaseUrl $file.Name $currentSha
          Write-Host "Skip migration $($file.Name) (checksum recorded)"
        } elseif (-not (Test-MigrationChecksumMatch $storedSha $currentShaVariants)) {
          Write-Warning "DRIFT: $($file.Name) has changed since it was applied! (stored=$storedSha current=$currentSha)"
          Write-Warning "  This file was modified after being applied. You may need a new migration to reconcile."
          $driftCount++
        } elseif ($storedSha -ne $currentSha) {
          Write-Host "Skip migration $($file.Name) (line-ending checksum compatible)"
        } else {
          Write-Host "Skip migration $($file.Name)"
        }
        continue
      }
    }

    Write-Host "Apply migration $($file.Name)"
    Repair-PublicSerialSequences $PsqlPath $DatabaseUrl
    Invoke-PsqlFile $PsqlPath $DatabaseUrl $file.FullName

    if (-not (Get-MigrationLedgerExists $PsqlPath $DatabaseUrl)) {
      throw "Migration $($file.Name) did not create public.ros_schema_migrations; cannot record ledger state."
    }
    Add-MigrationLedgerEntry $PsqlPath $DatabaseUrl $file.Name $currentSha
  }

  if ($driftCount -gt 0) {
    Write-Warning "$driftCount migration file(s) have changed since they were applied. Create a new numbered migration to reconcile."
  } else {
    Write-Host "No drift detected. All checksums match." -ForegroundColor Green
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
  (Join-Path $ScriptRoot "riverside-deployment.config.json"),
  (Join-Path (Split-Path -Parent $ScriptRoot) "riverside-deployment.config.json"),
  "C:\RiversideOS\release\riverside-deployment.config.json"
)
$resolvedConfigPath = Resolve-ExistingPath $defaultConfigCandidates "riverside-deployment.config.json"

$defaultMigrationCandidates = @(
  $MigrationsDir,
  (Join-Path $ScriptRoot "migrations"),
  "C:\RiversideOS\release\migrations"
)
$resolvedMigrationsDir = Resolve-ExistingPath $defaultMigrationCandidates "migrations folder"

$config = Get-Content $resolvedConfigPath -Raw | ConvertFrom-Json

function Ensure-ConfigServerSection($Config) {
  if (-not $Config.server) {
    $Config | Add-Member -NotePropertyName server -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  if (-not $Config.server.database) {
    $Config.server | Add-Member -NotePropertyName database -NotePropertyValue ([pscustomobject]@{}) -Force
  }
}

function Normalize-DatabaseConfig($Db) {
  if ($Db.adminUser -match '^(Admin|Administrator)$') {
    Write-Warning "database.adminUser was '$($Db.adminUser)'; using 'postgres' (PostgreSQL superuser)."
    $Db.adminUser = "postgres"
  }
  if ($Db.appUser -match '^(Admin|Administrator)$') {
    Write-Warning "database.appUser was '$($Db.appUser)'; using 'riverside_app'."
    $Db.appUser = "riverside_app"
  }
  if ([string]::IsNullOrWhiteSpace($Db.adminUser)) { $Db.adminUser = "postgres" }
  if ([string]::IsNullOrWhiteSpace($Db.appUser)) { $Db.appUser = "riverside_app" }
}

Ensure-ConfigServerSection $config

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
Normalize-DatabaseConfig $db
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

  # Import encrypted integration credentials shipped with the deployment package.
  $packageCredentialsPath = Join-Path $ScriptRoot "integration-credentials.sql"
  $importScriptPath = Join-Path $ScriptRoot "Import-IntegrationCredentials.ps1"
  if ((Test-Path $packageCredentialsPath) -and (Test-Path $importScriptPath)) {
    try {
      Write-Host "Integration credentials file found in deployment package. Checking database..."
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $importScriptPath -ConfigPath $resolvedConfigPath -SqlPath $packageCredentialsPath 2>&1 | Write-Host
    } catch {
      Write-Warning "Integration credential import failed: $($_.Exception.Message). Continuing."
    }
  }

  Write-Host "Riverside migrations are current."
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
