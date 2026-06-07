[CmdletBinding()]
param(
  [switch]$DeploymentManagerOnly,
  [switch]$ServerManagerOnly
)

$ErrorActionPreference = "Stop"

$ScriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ScriptRoot)) {
  $ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return $null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })
}

if (-not (Test-IsAdmin)) {
  Write-Host "Re-launching ROSDeployment installer as Administrator..."
  $forwardArgs = @()
  if ($DeploymentManagerOnly) { $forwardArgs += "-DeploymentManagerOnly" }
  if ($ServerManagerOnly) { $forwardArgs += "-ServerManagerOnly" }
  Start-Process powershell.exe -Verb RunAs -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`""
  ) + $forwardArgs
  exit
}

function Find-Installer([string]$Directory, [string[]]$NamePatterns) {
  if (-not (Test-Path $Directory)) { return $null }
  $installers = Get-ChildItem $Directory -Recurse -File -Include "*.msi", "*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending
  foreach ($pattern in $NamePatterns) {
    $match = $installers | Where-Object { $_.Name -like $pattern } | Select-Object -First 1
    if ($match) { return $match.FullName }
  }
  return $installers | Select-Object -First 1 -ExpandProperty FullName
}

function Install-AppBundle([string]$Label, [string]$InstallerPath) {
  if ([string]::IsNullOrWhiteSpace($InstallerPath) -or -not (Test-Path $InstallerPath)) {
    throw "$Label installer was not found in this deployment package."
  }

  Write-Host "Installing $Label from $InstallerPath"
  $extension = [IO.Path]::GetExtension($InstallerPath).ToLowerInvariant()
  if ($extension -eq ".msi") {
    $proc = Start-Process msiexec.exe -ArgumentList @("/i", "`"$InstallerPath`"", "/passive", "/norestart") -Wait -PassThru
  } else {
    $proc = Start-Process $InstallerPath -ArgumentList @("/S") -Wait -PassThru
  }

  if ($proc.ExitCode -ne 0) {
    throw "$Label installer exited with code $($proc.ExitCode)."
  }
  Write-Host "$Label install complete."
}

$installDeploymentManager = -not $ServerManagerOnly
$installServerManager = -not $DeploymentManagerOnly

if (-not $installDeploymentManager -and -not $installServerManager) {
  throw "Select DeploymentManagerOnly, ServerManagerOnly, or neither to install both."
}

if ($installDeploymentManager) {
  $deploymentInstaller = Find-Installer `
    -Directory (Join-Path $ScriptRoot "deployment-app") `
    -NamePatterns @("*Deployment*Manager*.msi", "*riverside-deployment-manager*.msi", "*Deployment*Manager*.exe")
  Install-AppBundle "Riverside OS Deployment Manager" $deploymentInstaller
}

if ($installServerManager) {
  $serverManagerInstaller = Find-Installer `
    -Directory (Join-Path $ScriptRoot "server-manager-app") `
    -NamePatterns @("*ROS*Server*Manager*.msi", "*ros-server-manager*.msi", "*ROS*Server*Manager*.exe")
  Install-AppBundle "ROS Server Manager" $serverManagerInstaller
}

Write-Host "ROSDeployment app installation complete."
