[CmdletBinding()]
param(
  [string]$ConfigPath = "",
  [switch]$StartFresh,
  [switch]$Force
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

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = $null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })
  if (-not $isAdmin) {
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
  throw "psql.exe was not found. Open the Deployment Manager first so PostgreSQL can be installed."
}

function Escape-SqlIdentifier([string]$Value) {
  return $Value.Replace('"', '""')
}

try {
  Assert-Admin
  Add-Type -AssemblyName System.Windows.Forms

  if (-not $ConfigPath) {
    $ConfigPath = Join-Path $ScriptRoot "riverside-deployment.config.json"
  }
  if (-not [System.IO.Path]::IsPathRooted($ConfigPath)) {
    $ConfigPath = Join-Path $ScriptRoot $ConfigPath
  }

  if (-not (Test-Path $ConfigPath)) {
    $parentConfigPath = Join-Path (Split-Path -Parent $ScriptRoot) "riverside-deployment.config.json"
    if (Test-Path $parentConfigPath) {
      $ConfigPath = $parentConfigPath
    }
  }
  if (-not (Test-Path $ConfigPath)) {
    throw "Config file not found: $ConfigPath. Put Reset-RiversideDatabase.cmd next to riverside-deployment.config.json, or run Start-RiversideDeployment.cmd once first so it can save deployment settings."
  }

  $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json

  function Test-PlaceholderSecret([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
    return $Value -match "replace-" -or $Value -eq "password" -or $Value -eq "placeholder"
  }

  if (Test-PlaceholderSecret $config.server.database.adminPassword) {
    $dbHost = $config.server.database.host
    $dbPort = $config.server.database.port
    $dbUser = $config.server.database.adminUser

    $tcpClient = New-Object System.Net.Sockets.TcpClient
    $connect = $tcpClient.BeginConnect($dbHost, $dbPort, $null, $null)
    $success = $connect.AsyncWaitHandle.WaitOne(1000, $false)
    if ($success) {
      $tcpClient.EndConnect($connect)
      $tcpClient.Close()

      $psqlCmd = Get-Command psql.exe -ErrorAction SilentlyContinue
      $psqlPath = if ($psqlCmd) { $psqlCmd.Source } else {
        $matches = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
        if ($matches) { $matches[0].FullName } else { "psql.exe" }
      }

      $oldEAP = $ErrorActionPreference
      $ErrorActionPreference = "SilentlyContinue"

      $env:PGPASSWORD = ""
      $testQuery = & $psqlPath -U $dbUser -h $dbHost -p $dbPort -d postgres -w -c "SELECT 1;" -t 2>&1
      $env:PGPASSWORD = $null

      if ($LASTEXITCODE -eq 0) {
        $config.server.database.adminPassword = ""
        $configJson = $config | ConvertTo-Json -Depth 8
        Set-Content -Path $ConfigPath -Value $configJson -Encoding UTF8
      } else {
        foreach ($pwd in @("postgres", "admin", "password")) {
          $env:PGPASSWORD = $pwd
          $testQuery = & $psqlPath -U $dbUser -h $dbHost -p $dbPort -d postgres -w -c "SELECT 1;" -t 2>&1
          $env:PGPASSWORD = $null
          if ($LASTEXITCODE -eq 0) {
            $config.server.database.adminPassword = $pwd
            $configJson = $config | ConvertTo-Json -Depth 8
            Set-Content -Path $ConfigPath -Value $configJson -Encoding UTF8
            break
          }
        }
      }
      $ErrorActionPreference = $oldEAP
    }
  }

  $db = $config.server.database
  $databaseName = "$($db.databaseName)"
  if (-not $databaseName) {
    throw "server.database.databaseName is blank in the deployment config."
  }

  $confirm = if ($Force) { "Yes" } else { $null }
  if (-not $Force) {
    $message = if ($StartFresh) {
      "This will delete and recreate the Riverside database '$databaseName', apply packaged migrations, and apply only the required Riverside seed data. Counterpoint imports, POS transactions, inventory, customers, orders, gift cards, loyalty, and other store data will be removed. PostgreSQL itself will stay installed. Continue?"
    } else {
      "This will delete and recreate only the Riverside database '$databaseName'. Use this only during a fresh failed install before store data exists. PostgreSQL itself will stay installed. Continue?"
    }
    $confirm = [System.Windows.Forms.MessageBox]::Show(
      $message,
      "Reset Riverside database",
      "YesNo",
      "Warning"
    )
  }
  if ($confirm -ne "Yes") {
    Write-Host "Reset cancelled."
    exit 0
  }

  $psql = Resolve-PsqlPath $db
  $env:PGPASSWORD = $db.adminPassword
  try {
    $adminUrl = "postgresql://$($db.adminUser)@$($db.host):$($db.port)/postgres"
    $quotedDatabase = Escape-SqlIdentifier $databaseName
    $escapedName = $databaseName.Replace("'", "''")
    $resetSql = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
      "WHERE datname = '$escapedName' AND pid <> pg_backend_pid(); " +
      "DROP DATABASE IF EXISTS ""$quotedDatabase"" WITH (FORCE); " +
      "CREATE DATABASE ""$quotedDatabase"" WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';"
    Invoke-Psql $psql $adminUrl $resetSql
    $databaseUrl = "postgresql://$($db.adminUser)@$($db.host):$($db.port)/$databaseName"
    Invoke-Psql $psql $databaseUrl "SHOW server_encoding;"
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }

  if ($StartFresh) {
    Write-Host "Start Fresh option active. Finding migrations and seeds..."
    $migrationsDir = Join-Path $ScriptRoot "migrations"
    if (-not (Test-Path $migrationsDir)) {
      $migrationsDir = "C:\RiversideOS\release\migrations"
    }
    $migrationsScript = Join-Path $ScriptRoot "apply-riverside-migrations.ps1"
    if (Test-Path $migrationsScript) {
      Write-Host "Applying database migrations..."
      & $migrationsScript -ConfigPath $ConfigPath -MigrationsDir $migrationsDir -ApplySeeds
      Write-Host "Database recreated, migrated, and seeded successfully! Ready for use." -ForegroundColor Green
      if (-not $Force) {
        [System.Windows.Forms.MessageBox]::Show(
          "Riverside database reset complete. Migrations and required seed data were applied. ROS is ready for a clean Counterpoint import.",
          "Fresh start complete",
          "OK",
          "Information"
        ) | Out-Null
      }
    } else {
      throw "apply-riverside-migrations.ps1 not found in $ScriptRoot"
    }
  } else {
    [System.Windows.Forms.MessageBox]::Show(
      "Riverside database reset complete. The database was recreated as UTF8. Reopen Start-RiversideDeployment.cmd and run Main Hub Install.",
      "Reset complete",
      "OK",
      "Information"
    ) | Out-Null
  }
} catch {
  if (-not $StartFresh) {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Reset failed", "OK", "Error") | Out-Null
  }
  throw
}
