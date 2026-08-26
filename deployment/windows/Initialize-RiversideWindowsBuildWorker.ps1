[CmdletBinding()]
param(
  [string]$BuildWorkerUser = "$env:USERDOMAIN\$env:USERNAME",
  [string]$WorkerRoot = "C:\ProgramData\RiversideOS\build-worker",
  [ValidatePattern('^[0-9A-Fa-f]{40}$')]
  [string]$AuthenticodeCertificateThumbprint = ""
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this initialization script from an elevated PowerShell window on the Main Hub."
  }
}

function Assert-ExistingAccount([string]$AccountName) {
  try {
    $account = New-Object Security.Principal.NTAccount($AccountName)
    $null = $account.Translate([Security.Principal.SecurityIdentifier])
  } catch {
    throw "The Windows account does not exist or cannot be resolved: $AccountName"
  }
}

Assert-Admin
Assert-ExistingAccount $BuildWorkerUser

$workerRootFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($WorkerRoot)
$installRootFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath("C:\RiversideOS")
if ($workerRootFull.StartsWith($installRootFull, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The build-worker root must remain outside the live C:\RiversideOS installation."
}

foreach ($relative in @("artifacts", "cache", "inbox", "jobs", "locks", "promotion", "promotion\work", "signing")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $workerRootFull $relative) | Out-Null
}

$acl = Get-Acl $workerRootFull
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [Security.AccessControl.InheritanceFlags]::ObjectInherit
foreach ($accessRule in @(
  (New-Object Security.AccessControl.FileSystemAccessRule(
    "SYSTEM",
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )),
  (New-Object Security.AccessControl.FileSystemAccessRule(
    "BUILTIN\Administrators",
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )),
  (New-Object Security.AccessControl.FileSystemAccessRule(
    $BuildWorkerUser,
    [Security.AccessControl.FileSystemRights]::Modify,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  ))
)) {
  $acl.SetAccessRule($accessRule)
}
Set-Acl -Path $workerRootFull -AclObject $acl

$signingRoot = Join-Path $workerRootFull "signing"
if (-not [string]::IsNullOrWhiteSpace($AuthenticodeCertificateThumbprint)) {
  $thumbprint = ($AuthenticodeCertificateThumbprint -replace '\s', '').ToUpperInvariant()
  $certificate = Get-Item "Cert:\CurrentUser\My\$thumbprint" -ErrorAction SilentlyContinue
  if (-not $certificate) {
    $certificate = Get-Item "Cert:\LocalMachine\My\$thumbprint" -ErrorAction SilentlyContinue
  }
  if (-not $certificate -or -not $certificate.HasPrivateKey) {
    throw "The Authenticode certificate is unavailable or has no private key: $thumbprint"
  }
  Set-Content -Path (Join-Path $signingRoot "authenticode-thumbprint.txt") -Value $thumbprint -Encoding ASCII
}

$promotionSource = Join-Path $PSScriptRoot "Invoke-RiversideInternalReleasePromotion.ps1"
if (-not (Test-Path $promotionSource)) {
  throw "Internal release promotion script is missing: $promotionSource"
}
$promotionScript = Join-Path $workerRootFull "Invoke-RiversideInternalReleasePromotion.ps1"
Copy-Item $promotionSource $promotionScript -Force
$promotionTaskName = "Riverside OS Internal Release Promotion"
$promotionAction = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$promotionScript`" -WorkerRoot `"$workerRootFull`""
$promotionPrincipal = New-ScheduledTaskPrincipal `
  -UserId "SYSTEM" `
  -LogonType ServiceAccount `
  -RunLevel Highest
$promotionSettings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew
Register-ScheduledTask `
  -TaskName $promotionTaskName `
  -Action $promotionAction `
  -Principal $promotionPrincipal `
  -Settings $promotionSettings `
  -Force | Out-Null

$sshd = Get-Service -Name "sshd" -ErrorAction SilentlyContinue
if (-not $sshd -or $sshd.Status -ne "Running") {
  throw "The build-worker folders and permissions are ready, but Windows OpenSSH Server is not running. Review the Main Hub firewall scope, then enable sshd explicitly before connecting from the Mac."
}

Write-Host "Riverside Windows build worker initialized." -ForegroundColor Green
Write-Host "Worker root: $workerRootFull"
Write-Host "Windows account: $BuildWorkerUser"
Write-Host "OpenSSH Server: $($sshd.Status)"
Write-Host "Promotion task: $promotionTaskName"
if (Test-Path (Join-Path $signingRoot "authenticode-thumbprint.txt")) {
  Write-Host "Authenticode certificate: configured"
} else {
  Write-Host "Authenticode certificate: not configured (internal Tauri updater signing is generated automatically on the first package build)"
}
Write-Host "Install Node.js 24, rustup/Rust 1.91, and Visual Studio 2022 Build Tools for this Windows account before the first build."
