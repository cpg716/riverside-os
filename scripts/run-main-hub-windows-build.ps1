[CmdletBinding()]
param(
  [string]$MainHubHost = $(if ($env:ROS_MAIN_HUB_HOST) { $env:ROS_MAIN_HUB_HOST } else { "riverside-main-hub" }),
  [string]$UserName = $env:ROS_MAIN_HUB_USER,
  [ValidateSet("Validate", "Package")]
  [string]$Task = "Validate",
  [string]$RemoteWorkerRoot = "C:\ProgramData\RiversideOS\build-worker",
  [string]$LocalOutputRoot = "",
  [int]$SshPort = 22,
  [string]$IdentityFile = "",
  [switch]$AllowStoreHours,
  [switch]$AllowExternalDownloads,
  [switch]$Promote,
  [switch]$KeepRemoteSource,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
  $scriptDir = Split-Path -Parent $PSCommandPath
  return (Resolve-Path (Join-Path $scriptDir "..")).Path
}

function Assert-Command([string]$CommandName) {
  $command = Get-Command $CommandName -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "$CommandName is required on the Mac for the private Windows build lane."
  }
  return $command.Source
}

function Assert-CommittedSource([string]$RepoRoot) {
  $changes = @(& git -C $RepoRoot status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect the Riverside OS worktree."
  }
  if ($changes.Count -gt 0) {
    throw "The Windows build worker accepts committed source only. Commit or intentionally set aside the current worktree changes before requesting a build."
  }
}

function New-SourceArchive([string]$RepoRoot, [string]$GitShort) {
  $archive = Join-Path ([IO.Path]::GetTempPath()) "riverside-windows-build-$GitShort-$([guid]::NewGuid().ToString('N')).zip"
  & git -C $RepoRoot archive --format=zip --output=$archive HEAD
  if ($LASTEXITCODE -ne 0) {
    throw "git archive failed with exit code $LASTEXITCODE."
  }
  return $archive
}

function ConvertTo-EncodedPowerShell([string]$ScriptText) {
  $bytes = [Text.Encoding]::Unicode.GetBytes($ScriptText)
  return [Convert]::ToBase64String($bytes)
}

if ([string]::IsNullOrWhiteSpace($MainHubHost) -or $MainHubHost -match '[\s\r\n]') {
  throw "Main Hub host is required and cannot contain whitespace. Pass -MainHubHost or set ROS_MAIN_HUB_HOST."
}
if (-not [string]::IsNullOrWhiteSpace($UserName) -and $UserName -notmatch '^[A-Za-z0-9._-]+$') {
  throw "When provided, UserName must be a simple Windows user name."
}
if ($SshPort -lt 1 -or $SshPort -gt 65535) {
  throw "SshPort must be between 1 and 65535."
}
if ($RemoteWorkerRoot -notmatch '^[A-Za-z]:\\[^"\r\n]+$') {
  throw "RemoteWorkerRoot must be an absolute Windows path without quotes or newlines."
}

$repoRoot = Resolve-RepoRoot
$fullHead = (& git -C $repoRoot rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $fullHead -notmatch '^[0-9a-f]{40}$') {
  throw "Could not resolve an exact Riverside OS source commit."
}
$gitShort = $fullHead.Substring(0, 8)
$jobId = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$gitShort-$($Task.ToLowerInvariant())"
if ([string]::IsNullOrWhiteSpace($LocalOutputRoot)) {
  $LocalOutputRoot = Join-Path $repoRoot "dist\internal-windows-builds"
}
$localArtifactDir = Join-Path $LocalOutputRoot $jobId
$requestFileName = "riverside-windows-build-request-$jobId.json"
$resultArchiveName = "riverside-windows-build-results-$jobId.zip"
$remoteRunnerFileName = "riverside-windows-build-runner-$jobId.ps1"
$target = if ([string]::IsNullOrWhiteSpace($UserName)) { $MainHubHost } else { "$UserName@$MainHubHost" }

if ($Promote -and $Task -ne "Package") {
  throw "-Promote requires -Task Package."
}

Assert-CommittedSource $repoRoot

Write-Host "Riverside internal Windows build request"
Write-Host "Main Hub: $MainHubHost"
Write-Host "Transport: SSH on port $SshPort"
Write-Host "Task: $Task"
Write-Host "Source commit: $fullHead"
Write-Host "Remote worker root: $RemoteWorkerRoot"
Write-Host "Local artifacts: $localArtifactDir"
Write-Host $(if ($Promote) {
  "Promotion requested: install the exact candidate on Main Hub, verify readiness, then publish the private workstation feed."
} else {
  "This command does not install or deploy the result."
})

if ($DryRun) {
  exit 0
}

$ssh = Assert-Command "ssh"
$scp = Assert-Command "scp"
$sshArgs = @("-p", "$SshPort")
$scpArgs = @("-P", "$SshPort")
if (-not [string]::IsNullOrWhiteSpace($IdentityFile)) {
  $resolvedIdentity = (Resolve-Path $IdentityFile).Path
  $sshArgs += @("-i", $resolvedIdentity)
  $scpArgs += @("-i", $resolvedIdentity)
}

$archive = $null
$requestPath = $null
$remoteRunnerPath = $null
$resultArchivePath = $null
$remoteExitCode = 1
try {
  $archive = New-SourceArchive $repoRoot $gitShort
  $requestPath = Join-Path ([IO.Path]::GetTempPath()) $requestFileName
  $request = [ordered]@{
    contractVersion = 1
    jobId = $jobId
    task = $Task
    expectedSourceSha = $fullHead
    workerRoot = $RemoteWorkerRoot
    archiveName = (Split-Path $archive -Leaf)
    resultArchiveName = $resultArchiveName
    allowStoreHours = [bool]$AllowStoreHours
    allowExternalDownloads = [bool]$AllowExternalDownloads
    keepRemoteSource = [bool]$KeepRemoteSource
  }
  $request | ConvertTo-Json -Depth 4 | Set-Content -Path $requestPath -Encoding UTF8

  $remoteScript = @'
$ErrorActionPreference = "Stop"
$requestPath = Join-Path $env:USERPROFILE "__REQUEST_FILE__"
$request = Get-Content $requestPath -Raw | ConvertFrom-Json
if ($request.contractVersion -ne 1) { throw "Unsupported Riverside build request contract." }
if ($request.jobId -notmatch '^[A-Za-z0-9._-]+$') { throw "Invalid Riverside build job id." }
if ($request.expectedSourceSha -notmatch '^[0-9a-fA-F]{40}$') { throw "Invalid Riverside source SHA." }
$workerRoot = [IO.Path]::GetFullPath([string]$request.workerRoot)
$workerRootPrefix = $workerRoot.TrimEnd('\') + '\'
$jobRoot = Join-Path $workerRoot ("jobs\" + $request.jobId)
$sourceRoot = Join-Path $jobRoot "source"
$inboxRoot = Join-Path $workerRoot ("inbox\" + $request.jobId)
$remoteArchive = Join-Path $inboxRoot $request.archiveName
$uploadedArchive = Join-Path $env:USERPROFILE $request.archiveName
$artifactDir = Join-Path $workerRoot ("artifacts\" + $request.jobId)
$resultArchive = Join-Path $env:USERPROFILE $request.resultArchiveName
foreach ($path in @($jobRoot, $inboxRoot, $artifactDir)) {
  $full = [IO.Path]::GetFullPath($path).TrimEnd('\') + '\'
  if (-not $full.StartsWith($workerRootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "A Riverside build path escaped the configured worker root."
  }
}

$buildExitCode = 1
try {
  if (Test-Path $jobRoot) { Remove-Item $jobRoot -Recurse -Force }
  if (Test-Path $inboxRoot) { Remove-Item $inboxRoot -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null
  New-Item -ItemType Directory -Force -Path $inboxRoot | Out-Null
  Move-Item $uploadedArchive $remoteArchive -Force
  Expand-Archive -Path $remoteArchive -DestinationPath $sourceRoot -Force

  $workerScript = Join-Path $sourceRoot "deployment\windows\Invoke-RiversideWindowsBuild.ps1"
  if (-not (Test-Path $workerScript)) {
    throw "The source archive did not contain the Riverside Windows build worker."
  }
  $workerArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $workerScript,
    "-SourceRoot", $sourceRoot,
    "-ExpectedSourceSha", $request.expectedSourceSha,
    "-JobId", $request.jobId,
    "-Task", $request.task,
    "-WorkerRoot", $workerRoot
  )
  if ($request.allowStoreHours) { $workerArgs += "-AllowStoreHours" }
  if ($request.allowExternalDownloads) { $workerArgs += "-AllowExternalDownloads" }
  & powershell.exe @workerArgs
  $buildExitCode = $LASTEXITCODE
} catch {
  Write-Error $_
  $buildExitCode = 1
} finally {
  Remove-Item $resultArchive -Force -ErrorAction SilentlyContinue
  if (Test-Path $artifactDir) {
    Compress-Archive -Path (Join-Path $artifactDir "*") -DestinationPath $resultArchive -Force
  }
  if (-not $request.keepRemoteSource) {
    Remove-Item $jobRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $inboxRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $requestPath -Force -ErrorAction SilentlyContinue
  Remove-Item $uploadedArchive -Force -ErrorAction SilentlyContinue
}
exit $buildExitCode
'@
  $remoteScript = $remoteScript.Replace("__REQUEST_FILE__", $requestFileName)
  $remoteRunnerPath = Join-Path ([IO.Path]::GetTempPath()) $remoteRunnerFileName
  $remoteScript | Set-Content -Path $remoteRunnerPath -Encoding UTF8

  & $scp @scpArgs $archive $requestPath $remoteRunnerPath "${target}:."
  if ($LASTEXITCODE -ne 0) {
    throw "Could not copy the committed source archive and worker launcher to the Main Hub over SSH."
  }

  & $ssh @sshArgs $target "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $remoteRunnerFileName"
  $remoteExitCode = $LASTEXITCODE

  $resultArchivePath = Join-Path ([IO.Path]::GetTempPath()) $resultArchiveName
  Remove-Item $resultArchivePath -Force -ErrorAction SilentlyContinue
  & $scp @scpArgs "${target}:$resultArchiveName" $resultArchivePath
  $resultCopyExitCode = $LASTEXITCODE
  if ($resultCopyExitCode -eq 0 -and (Test-Path $resultArchivePath)) {
    New-Item -ItemType Directory -Force -Path $localArtifactDir | Out-Null
    Expand-Archive -Path $resultArchivePath -DestinationPath $localArtifactDir -Force
    Write-Host "Windows build evidence copied to: $localArtifactDir"
  }

  $cleanupScript = @'
Remove-Item (Join-Path $env:USERPROFILE "__RESULT_FILE__") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:USERPROFILE "__REQUEST_FILE__") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:USERPROFILE "__ARCHIVE_FILE__") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:USERPROFILE "__RUNNER_FILE__") -Force -ErrorAction SilentlyContinue
'@
  $cleanupScript = $cleanupScript.Replace("__RESULT_FILE__", $resultArchiveName)
  $cleanupScript = $cleanupScript.Replace("__REQUEST_FILE__", $requestFileName)
  $cleanupScript = $cleanupScript.Replace("__ARCHIVE_FILE__", (Split-Path $archive -Leaf))
  $cleanupScript = $cleanupScript.Replace("__RUNNER_FILE__", $remoteRunnerFileName)
  $encodedCleanup = ConvertTo-EncodedPowerShell $cleanupScript
  & $ssh @sshArgs $target "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedCleanup" | Out-Null

  if ($remoteExitCode -ne 0) {
    if ($resultCopyExitCode -ne 0) {
      throw "The Windows build failed with exit code $remoteExitCode, and its evidence archive could not be copied back to the Mac."
    }
    throw "The Windows build failed with exit code $remoteExitCode. Inspect the copied log and summary."
  }
  if ($resultCopyExitCode -ne 0) {
    throw "The Windows build succeeded, but its evidence archive could not be copied back to the Mac."
  }

  if ($Promote) {
    $summaryPath = Join-Path $localArtifactDir "windows-build-summary.json"
    if (-not (Test-Path $summaryPath)) {
      throw "The Windows build succeeded but its summary is missing; refusing promotion."
    }
    $summary = Get-Content $summaryPath -Raw | ConvertFrom-Json
    if ($summary.status -ne "succeeded" -or
        $summary.sourceGitSha -ne $fullHead -or
        $summary.releaseCandidateReady -ne $true -or
        $summary.internalUpdaterSigned -ne $true) {
      throw "The Windows candidate did not pass the exact-build internal release gate; refusing promotion."
    }

    $promotionScript = @'
$ErrorActionPreference = "Stop"
$workerRoot = [IO.Path]::GetFullPath("__WORKER_ROOT__")
$jobId = "__JOB_ID__"
$sourceSha = "__SOURCE_SHA__"
$candidateDirectory = Join-Path $workerRoot ("artifacts\" + $jobId)
$promotionRoot = Join-Path $workerRoot "promotion"
$requestPath = Join-Path $promotionRoot "promotion-request.json"
$statusPath = Join-Path $promotionRoot "promotion-status.json"
$taskName = "Riverside OS Internal Release Promotion"
if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
  throw "The internal release promotion task is not installed. Rerun Initialize-RiversideWindowsBuildWorker.ps1 from elevated PowerShell on Main Hub."
}
if (-not (Test-Path (Join-Path $candidateDirectory "release.json"))) {
  throw "The exact internal release candidate is missing from the Main Hub build worker."
}
New-Item -ItemType Directory -Force -Path $promotionRoot | Out-Null
Remove-Item $statusPath -Force -ErrorAction SilentlyContinue
[ordered]@{
  contractVersion = 1
  jobId = $jobId
  expectedSourceSha = $sourceSha
  candidateDirectory = $candidateDirectory
  allowStoreHours = __ALLOW_STORE_HOURS__
} | ConvertTo-Json -Depth 4 | Set-Content -Path $requestPath -Encoding UTF8
Start-ScheduledTask -TaskName $taskName
Write-Host "Guarded Main Hub promotion started."
$deadline = (Get-Date).AddMinutes(60)
do {
  Start-Sleep -Seconds 5
  if (Test-Path $statusPath) {
    $status = Get-Content $statusPath -Raw | ConvertFrom-Json
    if ($status.jobId -eq $jobId) {
      Write-Host ("Promotion status: " + $status.status + " - " + $status.message)
      if ($status.status -eq "READY") { exit 0 }
      if ($status.status -eq "FAILED") { exit 1 }
    }
  }
} while ((Get-Date) -lt $deadline)
throw "Timed out waiting for the guarded Main Hub promotion task. Inspect the promotion status and transcript on Main Hub."
'@
    $promotionScript = $promotionScript.Replace("__WORKER_ROOT__", $RemoteWorkerRoot.Replace('"', ''))
    $promotionScript = $promotionScript.Replace("__JOB_ID__", $jobId)
    $promotionScript = $promotionScript.Replace("__SOURCE_SHA__", $fullHead)
    $promotionScript = $promotionScript.Replace("__ALLOW_STORE_HOURS__", $(if ($AllowStoreHours) { '$true' } else { '$false' }))
    $encodedPromotion = ConvertTo-EncodedPowerShell $promotionScript
    & $ssh @sshArgs $target "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedPromotion"
    if ($LASTEXITCODE -ne 0) {
      throw "Guarded Main Hub promotion failed. The previous internal workstation feed remains current."
    }
    Write-Host "Main Hub and private Windows update feed promoted to $fullHead."
  }
} finally {
  foreach ($temporaryPath in @($archive, $requestPath, $remoteRunnerPath, $resultArchivePath)) {
    if ($temporaryPath -and (Test-Path $temporaryPath)) {
      Remove-Item $temporaryPath -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host "Windows $Task task completed for $fullHead."
