[CmdletBinding()]
param(
  [string]$MainHubHost = $env:ROS_MAIN_HUB_HOST,
  [string]$RemoteSourceRoot = "C:\RiversideOS\source\riverside-os",
  [string]$RemoteStagingRoot = "C:\ProgramData\RiversideOS\source-incoming",
  [string]$RemoteConfigPath = "C:\RiversideOS\riverside-deployment.config.json",
  [string]$UserName = $env:ROS_MAIN_HUB_USER,
  [string]$Password = $env:ROS_MAIN_HUB_PASSWORD,
  [ValidateSet("ClientOnly", "Full")]
  [string]$Mode = "ClientOnly",
  [ValidateSet("Default", "Negotiate", "Basic")]
  [string]$Authentication = "Default",
  [System.Management.Automation.PSCredential]$Credential,
  [switch]$SkipNpmInstall,
  [switch]$SkipMigrations,
  [switch]$NoStart,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
  $scriptDir = Split-Path -Parent $PSCommandPath
  return (Resolve-Path (Join-Path $scriptDir "..")).Path
}

function New-MainHubSession([string]$HostName, [System.Management.Automation.PSCredential]$Cred, [string]$AuthMode) {
  if ([string]::IsNullOrWhiteSpace($HostName)) {
    throw "Main Hub host is required. Pass -MainHubHost or set ROS_MAIN_HUB_HOST."
  }
  $args = @{ ComputerName = $HostName }
  if ($Cred) { $args.Credential = $Cred }
  if ($AuthMode -ne "Default") { $args.Authentication = $AuthMode }
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

function New-SourceArchive([string]$RepoRoot) {
  $gitShort = (& git -C $RepoRoot rev-parse --short=8 HEAD).Trim()
  $archive = Join-Path ([IO.Path]::GetTempPath()) "riverside-os-source-$gitShort.zip"
  if (Test-Path $archive) {
    Remove-Item $archive -Force
  }
  & git -C $RepoRoot archive --format=zip --output=$archive HEAD
  if ($LASTEXITCODE -ne 0) {
    throw "git archive failed with exit code $LASTEXITCODE."
  }
  return $archive
}

$repoRoot = Resolve-RepoRoot
$head = (& git -C $repoRoot rev-parse --short=8 HEAD).Trim()
$fullHead = (& git -C $repoRoot rev-parse HEAD).Trim()
Write-Host "Main Hub host: $MainHubHost"
Write-Host "Source commit: $head"
Write-Host "Update mode: $Mode"
Write-Host "Remote source root: $RemoteSourceRoot"

if ($DryRun) {
  exit 0
}

$Credential = Resolve-Credential $Credential $UserName $Password

$session = $null
$archive = $null
try {
  $archive = New-SourceArchive $repoRoot
  $session = New-MainHubSession $MainHubHost $Credential $Authentication

  $remoteArchive = Invoke-Command -Session $session -ScriptBlock {
    param($StagingRoot, $ArchiveName)
    New-Item -ItemType Directory -Force -Path $StagingRoot | Out-Null
    Join-Path $StagingRoot $ArchiveName
  } -ArgumentList $RemoteStagingRoot, (Split-Path $archive -Leaf)

  Copy-Item -Path $archive -Destination $remoteArchive -Force -ToSession $session

  Invoke-Command -Session $session -ScriptBlock {
    param($ArchivePath, $SourceRoot, $ConfigPath, $Mode, $SourceGitSha, $SourceGitShort, $SkipNpmInstall, $SkipMigrations, $NoStart)
    $ErrorActionPreference = "Stop"

    if (Test-Path $SourceRoot) {
      Remove-Item $SourceRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $SourceRoot | Out-Null
    Expand-Archive -Path $ArchivePath -DestinationPath $SourceRoot -Force

    $scriptPath = Join-Path $SourceRoot "deployment\windows\Build-And-Apply-MainHubFastUpdate.ps1"
    $args = @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      $scriptPath,
      "-SourceRoot",
      $SourceRoot,
      "-ConfigPath",
      $ConfigPath,
      "-Mode",
      $Mode,
      "-SourceGitSha",
      $SourceGitSha,
      "-SourceGitShort",
      $SourceGitShort
    )
    if ($SkipNpmInstall) { $args += "-SkipNpmInstall" }
    if ($SkipMigrations) { $args += "-SkipMigrations" }
    if ($NoStart) { $args += "-NoStart" }

    & powershell.exe @args
    if ($LASTEXITCODE -ne 0) {
      throw "Build-And-Apply-MainHubFastUpdate.ps1 failed with exit code $LASTEXITCODE."
    }
  } -ArgumentList $remoteArchive, $RemoteSourceRoot, $RemoteConfigPath, $Mode, $fullHead, $head, $SkipNpmInstall, $SkipMigrations, $NoStart
} finally {
  if ($session) { Remove-PSSession $session }
  if ($archive -and (Test-Path $archive)) { Remove-Item $archive -Force -ErrorAction SilentlyContinue }
}
