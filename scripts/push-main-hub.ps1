[CmdletBinding()]
param(
  [string]$MainHubHost = $env:ROS_MAIN_HUB_HOST,
  [string]$PackagePath = "",
  [string]$RemoteStagingRoot = "C:\ProgramData\RiversideOS\incoming",
  [string]$RemoteConfigPath = "C:\RiversideOS\riverside-deployment.config.json",
  [string]$UserName = $env:ROS_MAIN_HUB_USER,
  [string]$Password = $env:ROS_MAIN_HUB_PASSWORD,
  [ValidateSet("Default", "Negotiate", "Basic")]
  [string]$Authentication = "Default",
  [System.Management.Automation.PSCredential]$Credential,
  [switch]$SkipBackup,
  [switch]$SkipMigrations,
  [switch]$SkipRosieSetup,
  [switch]$NoStart,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
  $scriptDir = Split-Path -Parent $PSCommandPath
  return (Resolve-Path (Join-Path $scriptDir "..")).Path
}

function Resolve-MainHubPackage([string]$RequestedPath, [string]$RepoRoot) {
  if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
    if (-not (Test-Path $RequestedPath)) {
      throw "PackagePath was not found: $RequestedPath"
    }
    return (Resolve-Path $RequestedPath).Path
  }

  $packageRoot = Join-Path $RepoRoot "dist/deployment"
  if (-not (Test-Path $packageRoot)) {
    throw "No package path was provided and dist/deployment does not exist. Build a MainHub-Update package first."
  }

  $candidates = Get-ChildItem $packageRoot -File -Filter "*MainHub-Update*.zip" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  if ($candidates) {
    return $candidates[0].FullName
  }

  $folderCandidates = Get-ChildItem $packageRoot -Directory -Filter "*MainHub-Update*" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  if ($folderCandidates) {
    return $folderCandidates[0].FullName
  }

  throw "No MainHub-Update package was found under $packageRoot. Build one with deployment/windows/build-deployment-package.ps1 -PackageFlavor MainHub-Update."
}

function Assert-PackageShape([string]$Path) {
  if ((Get-Item $Path).PSIsContainer) {
    foreach ($relative in @(
      "install-server.ps1",
      "server/riverside-server.exe",
      "client-dist",
      "migrations",
      "seeds"
    )) {
      $candidate = Join-Path $Path $relative
      if (-not (Test-Path $candidate)) {
        throw "Package is missing required path: $candidate"
      }
    }
    return
  }

  if ([IO.Path]::GetExtension($Path) -ne ".zip") {
    throw "PackagePath must point to a deployment package folder or .zip file."
  }

  $temp = Join-Path ([IO.Path]::GetTempPath()) ("riverside-package-check-" + [guid]::NewGuid().ToString("N"))
  try {
    Expand-Archive -Path $Path -DestinationPath $temp -Force
    $roots = Get-ChildItem $temp -Directory
    $packageDir = if ($roots.Count -eq 1 -and (Test-Path (Join-Path $roots[0].FullName "install-server.ps1"))) {
      $roots[0].FullName
    } else {
      $temp
    }
    Assert-PackageShape $packageDir
  } finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function New-MainHubSession([string]$HostName, [System.Management.Automation.PSCredential]$Cred, [string]$AuthMode) {
  if ([string]::IsNullOrWhiteSpace($HostName)) {
    throw "Main Hub host is required. Pass -MainHubHost or set ROS_MAIN_HUB_HOST."
  }

  $args = @{ ComputerName = $HostName }
  if ($Cred) {
    $args.Credential = $Cred
  }
  if ($AuthMode -ne "Default") {
    $args.Authentication = $AuthMode
  }
  New-PSSession @args
}

function Resolve-Credential(
  [System.Management.Automation.PSCredential]$Cred,
  [string]$User,
  [string]$Pass
) {
  if ($Cred) {
    return $Cred
  }
  if ([string]::IsNullOrWhiteSpace($User)) {
    return $null
  }

  if ([string]::IsNullOrWhiteSpace($Pass)) {
    return Get-Credential -UserName $User -Message "Enter the Windows administrator password for the Main Hub."
  }

  $secure = ConvertTo-SecureString $Pass -AsPlainText -Force
  [System.Management.Automation.PSCredential]::new($User, $secure)
}

function Copy-PackageToMainHub(
  [System.Management.Automation.Runspaces.PSSession]$Session,
  [string]$LocalPackage,
  [string]$RemoteRoot
) {
  $deploymentId = Get-Date -Format "yyyyMMdd-HHmmss"
  $remoteDrop = Invoke-Command -Session $Session -ScriptBlock {
    param($Root, $DeploymentId)
    $path = Join-Path $Root $DeploymentId
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    $path
  } -ArgumentList $RemoteRoot, $deploymentId

  $item = Get-Item $LocalPackage
  if ($item.PSIsContainer) {
    $remotePackage = Invoke-Command -Session $Session -ScriptBlock {
      param($Drop, $Name)
      $path = Join-Path $Drop $Name
      New-Item -ItemType Directory -Force -Path $path | Out-Null
      $path
    } -ArgumentList $remoteDrop, $item.Name

    Copy-Item -Path (Join-Path $item.FullName "*") -Destination $remotePackage -Recurse -Force -ToSession $Session
    return $remotePackage
  }

  $remoteZip = Invoke-Command -Session $Session -ScriptBlock {
    param($Drop, $Name)
    Join-Path $Drop $Name
  } -ArgumentList $remoteDrop, $item.Name

  Copy-Item -Path $item.FullName -Destination $remoteZip -Force -ToSession $Session

  Invoke-Command -Session $Session -ScriptBlock {
    param($ZipPath, $Drop)
    $extractRoot = Join-Path $Drop ([IO.Path]::GetFileNameWithoutExtension($ZipPath))
    if (Test-Path $extractRoot) {
      Remove-Item $extractRoot -Recurse -Force
    }
    Expand-Archive -Path $ZipPath -DestinationPath $extractRoot -Force
    $roots = Get-ChildItem $extractRoot -Directory
    if ($roots.Count -eq 1 -and (Test-Path (Join-Path $roots[0].FullName "install-server.ps1"))) {
      return $roots[0].FullName
    }
    return $extractRoot
  } -ArgumentList $remoteZip, $remoteDrop
}

function Invoke-MainHubUpdate(
  [System.Management.Automation.Runspaces.PSSession]$Session,
  [string]$RemotePackagePath,
  [string]$ConfigPath,
  [bool]$BackupRequired,
  [bool]$SkipMigrationsRequested,
  [bool]$SkipRosieSetupRequested,
  [bool]$NoStartRequested
) {
  Invoke-Command -Session $Session -ScriptBlock {
    param(
      $PackagePath,
      $ConfigPath,
      $BackupRequired,
      $SkipMigrationsRequested,
      $SkipRosieSetupRequested,
      $NoStartRequested
    )

    $ErrorActionPreference = "Stop"

    function Assert-Admin {
      $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
      $isAdmin = $null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })
      if (-not $isAdmin) {
        throw "The remote PowerShell session is not running with Administrator rights."
      }
    }

    function Find-PostgresTool([string]$Name) {
      $cmd = Get-Command $Name -ErrorAction SilentlyContinue
      if ($cmd) {
        return $cmd.Source
      }
      $found = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter $Name -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -First 1
      if ($found) {
        return $found.FullName
      }
      throw "$Name was not found on the Main Hub."
    }

    function Get-SafeConfigValue($Object, [string]$Name, [string]$DefaultValue) {
      if ($Object -and $Object.PSObject.Properties[$Name] -and $null -ne $Object.$Name -and "$($Object.$Name)" -ne "") {
        return "$($Object.$Name)"
      }
      return $DefaultValue
    }

    function New-PreUpdateBackup([string]$ConfigPath) {
      $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
      $server = $config.server
      $db = $server.database
      if (-not $db) {
        throw "Config file is missing server.database; cannot create pre-update backup."
      }

      $installRoot = Get-SafeConfigValue $server "installRoot" "C:\RiversideOS"
      $backupDir = Join-Path $installRoot "backups"
      New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

      $pgDump = Find-PostgresTool "pg_dump.exe"
      $pgRestore = Find-PostgresTool "pg_restore.exe"
      $hostName = Get-SafeConfigValue $db "host" "127.0.0.1"
      $port = Get-SafeConfigValue $db "port" "5432"
      $databaseName = Get-SafeConfigValue $db "databaseName" "riverside_os"
      $user = Get-SafeConfigValue $db "adminUser" "postgres"
      $password = Get-SafeConfigValue $db "adminPassword" ""
      if ([string]::IsNullOrWhiteSpace($password)) {
        throw "PostgreSQL administrator password is missing from deployment config; refusing to use the limited Riverside app account for a full pre-update backup."
      }

      $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $backupPath = Join-Path $backupDir "pre-lan-update-$stamp.dump"
      $env:PGPASSWORD = $password
      try {
        & $pgDump -h $hostName -p $port -U $user -d $databaseName -w -Fc -f $backupPath
        if ($LASTEXITCODE -ne 0) {
          throw "pg_dump failed with exit code $LASTEXITCODE."
        }

        $backupFile = Get-Item $backupPath -ErrorAction Stop
        if ($backupFile.Length -lt 1024) {
          throw "Pre-update backup was too small: $backupPath"
        }

        $archiveListing = @(& $pgRestore --list $backupPath)
        if ($LASTEXITCODE -ne 0 -or $archiveListing.Count -eq 0) {
          throw "Pre-update backup archive verification failed: $backupPath"
        }
      } catch {
        Remove-Item $backupPath -Force -ErrorAction SilentlyContinue
        throw
      } finally {
        Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
      }
      return $backupPath
    }

    Assert-Admin

    if (-not (Test-Path (Join-Path $PackagePath "install-server.ps1"))) {
      throw "Remote package path is not a Riverside deployment package: $PackagePath"
    }
    if (-not (Test-Path $ConfigPath)) {
      throw "Main Hub deployment config was not found: $ConfigPath"
    }

    $manifestPath = Join-Path $PackagePath "deployment-package.manifest.json"
    if (Test-Path $manifestPath) {
      $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
      Write-Host "Package: $($manifest.packageName) / $($manifest.sourceGitSha)"
    }

    if ($BackupRequired) {
      $backupPath = New-PreUpdateBackup $ConfigPath
      Write-Host "Pre-update backup created: $backupPath"
    } else {
      Write-Warning "Pre-update backup skipped by operator request."
    }

    $installer = Join-Path $PackagePath "install-server.ps1"
    $installerArgs = @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      $installer,
      "-ConfigPath",
      $ConfigPath
    )
    if ($SkipMigrationsRequested) { $installerArgs += "-SkipMigrations" }
    if ($SkipRosieSetupRequested) { $installerArgs += "-SkipRosieSetup" }
    if ($NoStartRequested) { $installerArgs += "-NoStart" }

    Write-Host "Running Main Hub update from $PackagePath"
    & powershell.exe @installerArgs
    if ($LASTEXITCODE -ne 0) {
      throw "install-server.ps1 failed with exit code $LASTEXITCODE."
    }

    if (-not $NoStartRequested) {
      $version = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/version" -UseBasicParsing -TimeoutSec 10
      Write-Host "Main Hub version response: $($version.Content)"
    }

    Write-Host "Push to Main Hub complete."
  } -ArgumentList $RemotePackagePath, $ConfigPath, $BackupRequired, $SkipMigrationsRequested, $SkipRosieSetupRequested, $NoStartRequested
}

$repoRoot = Resolve-RepoRoot
$resolvedPackage = Resolve-MainHubPackage $PackagePath $repoRoot
Assert-PackageShape $resolvedPackage

Write-Host "Main Hub host: $MainHubHost"
Write-Host "Package: $resolvedPackage"
Write-Host "Remote staging root: $RemoteStagingRoot"
Write-Host "Remote config path: $RemoteConfigPath"

if ($DryRun) {
  Write-Host "Dry run complete. No files were copied and no remote update was started."
  exit 0
}

$Credential = Resolve-Credential $Credential $UserName $Password

$session = $null
try {
  $session = New-MainHubSession $MainHubHost $Credential $Authentication
  $remotePackage = Copy-PackageToMainHub $session $resolvedPackage $RemoteStagingRoot
  Write-Host "Remote package staged at: $remotePackage"
  Invoke-MainHubUpdate $session $remotePackage $RemoteConfigPath (-not $SkipBackup) $SkipMigrations $SkipRosieSetup $NoStart
} finally {
  if ($session) {
    Remove-PSSession $session
  }
}
