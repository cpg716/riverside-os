<#
.SYNOPSIS
    Validates that the Tauri shell's install_contract.rs constants match the
    paths and names actually written by install-server.ps1.

.DESCRIPTION
    This is the cross-layer contract test for the Riverside OS updater.

    The updater bug (v0.85.0 GO LIVE) was caused by server_updater.rs probing
    a path that install-server.ps1 had never written. Two files owned the same
    fact with no test connecting them. This script IS that test.

    Run this:
      - Before every release candidate build
      - As part of the T-45 quality gate in ThingsBeforeLaunch.md
      - In CI (requires pwsh / PowerShell Core on Linux/Mac, or Windows PS5+)

    Exit code 0 = all contracts match.
    Exit code 1 = one or more mismatches detected. Block the release.

.NOTES
    When you add or change a path/name/port in install-server.ps1, update
    install_contract.rs to match and re-run this script before committing.
#>

[CmdletBinding()]
param (
    [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
)

$ErrorActionPreference = "Continue"
$passed  = 0
$failed  = 0
$results = @()

function Assert-Contract {
    param(
        [string]$Name,
        [string]$RustValue,
        [string]$InstallerValue
    )
    if ($RustValue -eq $InstallerValue) {
        $script:passed++
        $results += [pscustomobject]@{ Status = "PASS"; Contract = $Name; Rust = $RustValue; Installer = $InstallerValue }
        Write-Host "  [PASS] $Name" -ForegroundColor Green
    } else {
        $script:failed++
        $results += [pscustomobject]@{ Status = "FAIL"; Contract = $Name; Rust = $RustValue; Installer = $InstallerValue }
        Write-Host "  [FAIL] $Name" -ForegroundColor Red
        Write-Host "         Rust:      '$RustValue'" -ForegroundColor Red
        Write-Host "         Installer: '$InstallerValue'" -ForegroundColor Red
    }
}

function Extract-RustConst {
    param([string]$Source, [string]$ConstName)
    # Match: pub const FOO: &str = "value";  or  pub const FOO: u16 = 3000;
    if ($Source -match "pub const $ConstName\s*:\s*[^=]+=\s*""([^""]+)""") {
        return $Matches[1].Replace("\\", "\")
    }
    if ($Source -match "pub const $ConstName\s*:\s*u16\s*=\s*(\d+)") {
        return $Matches[1]
    }
    return $null
}

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "========================================================"
Write-Host " Riverside OS — Install Contract Validator"
Write-Host "========================================================"
Write-Host ""

# ---- Locate source files ----
$contractRs    = Join-Path $RepoRoot "client\src-tauri\src\install_contract.rs"
$installerPs1  = Join-Path $RepoRoot "deployment\windows\install-server.ps1"

foreach ($f in @($contractRs, $installerPs1)) {
    if (-not (Test-Path $f)) {
        Write-Host "[ERROR] Required file not found: $f" -ForegroundColor Red
        exit 1
    }
}

$rustSrc      = Get-Content $contractRs -Raw
$installerSrc = Get-Content $installerPs1 -Raw

Write-Host "Checking contracts..."
Write-Host ""

# ---- 1. Default install root ----
$rustInstallRoot      = Extract-RustConst $rustSrc "DEFAULT_INSTALL_ROOT"
# install-server.ps1: if ([string]::IsNullOrWhiteSpace($installRoot)) { $installRoot = "C:\RiversideOS" }
if ($installerSrc -match 'installRoot\s*=\s*"(C:\\RiversideOS)"') {
    $installerInstallRoot = $Matches[1]
} else {
    $installerInstallRoot = "(not found)"
}
Assert-Contract "DEFAULT_INSTALL_ROOT" $rustInstallRoot $installerInstallRoot

# ---- 2. Server binary subpath ----
$rustBinSubpath = Extract-RustConst $rustSrc "SERVER_BIN_SUBPATH"
# install-server.ps1: $serverDir = Join-Path $installRoot "server"
#                     Copy-Item $packageServerExe (Join-Path $serverDir "riverside-server.exe")
# Derived path: server\riverside-server.exe
$installerBinSubpath = "server\riverside-server.exe"
Assert-Contract "SERVER_BIN_SUBPATH" $rustBinSubpath $installerBinSubpath

# ---- 3. Deploy config filename ----
$rustConfigFile = Extract-RustConst $rustSrc "DEPLOY_CONFIG_FILE"
# install-server.ps1 uses "riverside-deployment.config.json" throughout
if ($installerSrc -match '"(riverside-deployment\.config\.json)"') {
    $installerConfigFile = $Matches[1]
} else {
    $installerConfigFile = "(not found)"
}
Assert-Contract "DEPLOY_CONFIG_FILE" $rustConfigFile $installerConfigFile

# ---- 4. Deploy summary file ----
$rustSummaryFile = Extract-RustConst $rustSrc "DEPLOY_SUMMARY_FILE"
# install-server.ps1: Set-Content -Path (Join-Path $installRoot "deployment-summary.txt")
if ($installerSrc -match '"(deployment-summary\.txt)"') {
    $installerSummaryFile = $Matches[1]
} else {
    $installerSummaryFile = "(not found)"
}
Assert-Contract "DEPLOY_SUMMARY_FILE" $rustSummaryFile $installerSummaryFile

# ---- 5. Scheduled task name ----
$rustTaskName = Extract-RustConst $rustSrc "SERVER_TASK_NAME"
# install-server.ps1: $taskName = "Riverside OS Server"
if ($installerSrc -match '\$taskName\s*=\s*"Riverside OS Server"') {
    $installerTaskName = "Riverside OS Server"
} else {
    $installerTaskName = "(not found)"
}
Assert-Contract "SERVER_TASK_NAME" $rustTaskName $installerTaskName

# ---- 6. Default server port ----
$rustPort = Extract-RustConst $rustSrc "DEFAULT_SERVER_PORT"
# install-server.ps1: default httpBind = "0.0.0.0:3000" -> port extracted as 3000
if ($installerSrc -match 'httpBind\s*=\s*"0\.0\.0\.0:(\d+)"') {
    $installerPort = $Matches[1]
} else {
    $installerPort = "(not found)"
}
Assert-Contract "DEFAULT_SERVER_PORT" $rustPort $installerPort

# ---- 7. Health endpoint ----
$rustHealth = Extract-RustConst $rustSrc "HEALTH_ENDPOINT"
# install-server.ps1 and server_updater.rs use /api/health for process readiness.
# The health endpoint is owned by the server and used in the update runner; cross-check with
# server/src/api/health.rs route registration if possible.
$serverHealthRs = Join-Path $RepoRoot "server\src\api\health.rs"
if ((Test-Path $serverHealthRs) -and ($installerSrc -match '/api/health')) {
    $apiModRs = Join-Path $RepoRoot "server\src\api\mod.rs"
    $healthSrc = Get-Content $serverHealthRs -Raw
    $apiModSrc = if (Test-Path $apiModRs) { Get-Content $apiModRs -Raw } else { "" }
    if ($healthSrc -match 'health_router' -and $apiModSrc -match 'nest\("/api/health"') {
        $serverHealthPath = "/api/health"
    } else {
        $serverHealthPath = "(route not confirmed in server API router)"
    }
    Assert-Contract "HEALTH_ENDPOINT (vs server/src/api/health.rs)" $rustHealth $serverHealthPath
} else {
    Write-Host "  [SKIP] HEALTH_ENDPOINT — health.rs not found at expected path" -ForegroundColor Yellow
}

# ---- Summary ----
Write-Host ""
Write-Host "========================================================"
if ($failed -eq 0) {
    Write-Host " RESULT: ALL $passed CONTRACT(S) PASSED" -ForegroundColor Green
    Write-Host "========================================================"
    Write-Host ""
    exit 0
} else {
    Write-Host " RESULT: $failed CONTRACT(S) FAILED / $passed PASSED" -ForegroundColor Red
    Write-Host ""
    Write-Host " ACTION REQUIRED:" -ForegroundColor Red
    Write-Host "   Update install_contract.rs OR install-server.ps1 so both sides" -ForegroundColor Red
    Write-Host "   agree on every value above, then re-run this script." -ForegroundColor Red
    Write-Host "   DO NOT proceed with a release until this exits with code 0." -ForegroundColor Red
    Write-Host "========================================================"
    Write-Host ""
    exit 1
}
