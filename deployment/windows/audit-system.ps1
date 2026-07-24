[CmdletBinding()]
param(
    [string]$ConfigPath = ""
)

$ErrorActionPreference = "Continue"
$requestedConfigPath = $ConfigPath
$script:auditFailureCount = 0

function Write-AuditFailure([string]$Message) {
    $script:auditFailureCount += 1
    Write-Host "[FAIL] $Message" -ForegroundColor Red
}

function Get-ConfiguredInstallRoot([string]$CandidateConfigPath) {
    if ([string]::IsNullOrWhiteSpace($CandidateConfigPath) -or -not (Test-Path $CandidateConfigPath)) {
        return $null
    }
    try {
        $candidateConfig = Get-Content $CandidateConfigPath -Raw | ConvertFrom-Json
        $candidateInstallRoot = "$($candidateConfig.server.installRoot)".Trim()
        if ($candidateInstallRoot) {
            return $candidateInstallRoot
        }
    } catch {
        return $null
    }
    return $null
}

function Resolve-DeploymentConfigPath(
    [string]$PackageConfigPath,
    [string]$ExampleConfigPath,
    [string]$RequestedConfigPath
) {
    if (-not [string]::IsNullOrWhiteSpace($RequestedConfigPath)) {
        return [System.IO.Path]::GetFullPath($RequestedConfigPath)
    }

    $installRoot = Get-ConfiguredInstallRoot $PackageConfigPath
    if (-not $installRoot) {
        $installRoot = Get-ConfiguredInstallRoot $ExampleConfigPath
    }
    if (-not $installRoot) {
        $installRoot = "C:\RiversideOS"
    }
    $installedConfigPath = Join-Path $installRoot "riverside-deployment.config.json"
    if (Test-Path $installedConfigPath) {
        return $installedConfigPath
    }
    return $PackageConfigPath
}

function Get-DotEnvValue([string]$Path, [string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path $Path)) {
        return $null
    }
    $matchedValue = $null
    foreach ($line in @(Get-Content -Path $Path -ErrorAction SilentlyContinue)) {
        if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*)$") {
            $matchedValue = "$($Matches[1])".Trim()
            if ($matchedValue.Length -ge 2) {
                $first = $matchedValue[0]
                $last = $matchedValue[$matchedValue.Length - 1]
                if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                    $matchedValue = $matchedValue.Substring(1, $matchedValue.Length - 2)
                }
            }
        }
    }
    return $matchedValue
}

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "   Riverside OS System Audit & Diagnostics   " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# 1. Admin Privilege check
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = $null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })
if (-not $isAdmin) {
    Write-AuditFailure "Script is not running as Administrator. Please run this command/app elevated."
    exit 1
} else {
    Write-Host "[OK] Running with elevated Administrator privileges." -ForegroundColor Green
}

# 2. Config Resolution
$ScriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ScriptRoot)) {
  $ScriptRoot = if ($MyInvocation -and $MyInvocation.MyCommand -and $MyInvocation.MyCommand.Path) {
    Split-Path -Parent $MyInvocation.MyCommand.Path
  } else {
    "."
  }
}
$packageRoot = $ScriptRoot
$packageConfigPath = Join-Path $packageRoot "riverside-deployment.config.json"
$configExamplePath = Join-Path $packageRoot "riverside-deployment.config.example.json"
$configPath = Resolve-DeploymentConfigPath $packageConfigPath $configExamplePath $requestedConfigPath

if (-not (Test-Path $configPath)) {
    Write-AuditFailure "riverside-deployment.config.json was not found at $configPath. Installed production settings cannot be verified."
    $config = $null
} else {
    try {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        Write-Host "[OK] Loaded deployment config from $configPath" -ForegroundColor Green
    } catch {
        Write-AuditFailure "Found config file, but it contains invalid JSON: $($_.Exception.Message)"
        $config = $null
    }
}

# 2b. Production safeguards
if ($config -and $config.server) {
    Write-Host ""
    Write-Host "--- Production Safeguard Checks ---" -ForegroundColor Blue
    $environmentMode = "$($config.server.environmentMode)".Trim().ToLowerInvariant()
    if (-not $environmentMode) {
        $environmentMode = "production"
    }
    $strictProduction = [bool]$config.server.strictProduction
    $backupDir = ""
    if ($config.server.environment -and $config.server.environment.RIVERSIDE_BACKUP_DIR) {
        $backupDir = "$($config.server.environment.RIVERSIDE_BACKUP_DIR)".Trim()
    }

    Write-Host "[OK] Deployment environment mode: $environmentMode" -ForegroundColor Green
    if ($environmentMode -eq "production" -and -not $strictProduction) {
        Write-AuditFailure "Production safeguards are disabled. Existing staff operations can continue, but production go-live signoff is blocked."
        Write-Host "       Verify every strict-production prerequisite, then explicitly set server.strictProduction=true and update the Main Hub." -ForegroundColor Red
    } elseif ($strictProduction) {
        Write-Host "[OK] Strict production startup safeguards are enabled." -ForegroundColor Green
    } else {
        Write-Host "[WARN] Strict production safeguards are disabled for this non-production deployment." -ForegroundColor Yellow
    }

    if ($environmentMode -eq "production" -and (-not $backupDir -or -not [System.IO.Path]::IsPathRooted($backupDir))) {
        Write-AuditFailure "Production requires an explicit absolute RIVERSIDE_BACKUP_DIR. Configured value: '$backupDir'."
    } elseif ($backupDir) {
        Write-Host "[OK] Runtime backup directory is explicit: $backupDir" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Runtime backup directory is not explicitly configured." -ForegroundColor Yellow
    }
}

# 3. Database Port Check (PostgreSQL)
$dbHost = "127.0.0.1"
$dbPort = 5432
if ($config -and $config.server -and $config.server.database -and $config.server.database.host) {
    $dbHost = $config.server.database.host
}
if ($config -and $config.server -and $config.server.database -and $config.server.database.port) {
    $dbPort = $config.server.database.port
}

Write-Host ""
Write-Host "--- Database Connection Checks ---" -ForegroundColor Blue
Write-Host "Testing connection to PostgreSQL at $dbHost`:$dbPort..."

$tcpClient = New-Object System.Net.Sockets.TcpClient
$connect = $tcpClient.BeginConnect($dbHost, $dbPort, $null, $null)
$success = $connect.AsyncWaitHandle.WaitOne(3000, $false)

if (-not $success) {
    Write-AuditFailure "Port $dbPort is not listening on $dbHost. PostgreSQL is likely stopped or blocked by firewall."
} else {
    $tcpClient.EndConnect($connect)
    $tcpClient.Close()
    Write-Host "[OK] Port $dbPort is open and listening on $dbHost." -ForegroundColor Green
    
    # 4. Database Credentials & Schema Check
    $psqlPath = ""
    if ($config -and $config.server -and $config.server.database -and $config.server.database.psqlPath) {
        $psqlPath = $config.server.database.psqlPath
    }
    if (-not $psqlPath) {
        $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
        if ($cmd) { $psqlPath = $cmd.Source }
    }
    if (-not $psqlPath) {
        $matches = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
        if ($matches) { $psqlPath = $matches[0].FullName }
    }

    if (-not $psqlPath -or -not (Test-Path $psqlPath)) {
        Write-AuditFailure "psql.exe was not found. Database contents and migration state cannot be verified."
    } else {
        Write-Host "Found psql at $psqlPath. Querying database..."
        
        $dbName = "riverside_os"
        $dbUser = "postgres"
        if ($config -and $config.server -and $config.server.database -and $config.server.database.adminUser) {
            $candidateUser = "$($config.server.database.adminUser)"
            if ($candidateUser -notmatch '^(Admin|Administrator)$') {
                $dbUser = $candidateUser
            }
        }
        $env:PGPASSWORD = ""
        if ($config -and $config.server -and $config.server.database -and $null -ne $config.server.database.adminPassword) {
            $env:PGPASSWORD = $config.server.database.adminPassword
        }
        
        $oldEAP = $ErrorActionPreference
        $ErrorActionPreference = "SilentlyContinue"

        $queryResult = & $psqlPath -U $dbUser -h $dbHost -p $dbPort -d $dbName -w -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';" -t 2>&1
        if ($LASTEXITCODE -ne 0) {
            $ErrorActionPreference = $oldEAP
            Write-AuditFailure "Could not query database. Password may be incorrect, or database '$dbName' does not exist."
            Write-Host "       Error: $queryResult" -ForegroundColor Red
        } else {
            $tableCount = "$queryResult".Trim()
            Write-Host "[OK] Connected to database '$dbName'. Found $tableCount tables." -ForegroundColor Green
            
            # Check Migrations Count
            $migrationResult = & $psqlPath -U $dbUser -h $dbHost -p $dbPort -d $dbName -w -c "SELECT COUNT(*) FROM ros_schema_migrations;" -t 2>&1
            $ErrorActionPreference = $oldEAP
            if ($LASTEXITCODE -eq 0) {
                Write-Host "[OK] Applied migrations count: $($migrationResult.Trim())" -ForegroundColor Green
            } else {
                Write-AuditFailure "ros_schema_migrations was not readable. The installed schema version cannot be verified."
            }
        }
        $env:PGPASSWORD = $null
    }
}

# 4b. ROSIE AI Stack Checks
Write-Host ""
Write-Host "--- ROSIE AI Stack Checks ---" -ForegroundColor Blue

$contractInstallRoot = "C:\RiversideOS"
if ($config -and $config.server -and $config.server.installRoot) {
    $contractInstallRoot = $config.server.installRoot
}
$packageAuditManifestPath = Join-Path $packageRoot "deployment-package.manifest.json"
$installedAuditManifestPath = Join-Path $contractInstallRoot "release\deployment-package.manifest.json"
$expectedManifestPath = if (Test-Path $packageAuditManifestPath) {
    $packageAuditManifestPath
} elseif (Test-Path $installedAuditManifestPath) {
    $installedAuditManifestPath
} else {
    $null
}
$expectedManifest = $null
if ($expectedManifestPath) {
    try {
        $expectedManifest = Get-Content -Raw $expectedManifestPath | ConvertFrom-Json
        Write-Host "[OK] Loaded expected build manifest from $expectedManifestPath" -ForegroundColor Green
    } catch {
        Write-AuditFailure "The expected deployment package manifest is invalid at $expectedManifestPath. Exact installed-build verification is impossible."
    }
} else {
    Write-AuditFailure "No deployment-package.manifest.json was found in the audit package or installed release directory. Exact installed-build verification is impossible."
}
$rosieRoot = Join-Path $contractInstallRoot "rosie"
$readyFlag = Join-Path $rosieRoot "rosie_ready"
$statusPath = Join-Path $rosieRoot "rosie_status.json"

if (Test-Path $statusPath) {
    try {
        $rosieStatus = Get-Content -Raw $statusPath | ConvertFrom-Json
        if ($rosieStatus.ready -eq $true) {
            Write-Host "[OK] ROSIE component manifest reports full stack readiness." -ForegroundColor Green
        } else {
            Write-AuditFailure "ROSIE component manifest reports partial readiness. See $statusPath."
        }
        foreach ($component in @("binaries", "llm", "stt", "tts")) {
            $componentStatus = $rosieStatus.components.$component
            if ($componentStatus -and $componentStatus.ready -eq $true) {
                Write-Host "[OK] ROSIE $component ready." -ForegroundColor Green
            } else {
                Write-AuditFailure "ROSIE $component not ready."
            }
        }
    } catch {
        Write-AuditFailure "ROSIE component manifest could not be parsed at $statusPath."
    }
} elseif (Test-Path $readyFlag) {
    Write-Host "[OK] ROSIE stack ready flag file found at $readyFlag." -ForegroundColor Green
} else {
    Write-AuditFailure "ROSIE stack ready flag file is missing at $readyFlag. ROSIE was not installed correctly."
}

# Verify precompiled binaries
$requiredBinaries = @(
    "llama-server.exe",
    "sherpa-onnx-offline.exe",
    "sherpa-onnx-offline-tts.exe"
)
foreach ($bin in $requiredBinaries) {
    $binPath = Join-Path $rosieRoot "bin\$bin"
    if (Test-Path $binPath) {
        Write-Host "[OK] Binary verified: $bin" -ForegroundColor Green
    } else {
        Write-AuditFailure "Binary missing: $binPath"
    }
}

# Verify models
$sensevoiceModel = Join-Path $rosieRoot "stt\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17\model.int8.onnx"
if (Test-Path $sensevoiceModel) {
    Write-Host "[OK] STT (SenseVoice) model verified: $sensevoiceModel" -ForegroundColor Green
} else {
    Write-AuditFailure "STT (SenseVoice) model missing at $sensevoiceModel"
}

$kokoroModel = Join-Path $rosieRoot "tts\kokoro-multi-lang-v1_0\model.onnx"
if (Test-Path $kokoroModel) {
    Write-Host "[OK] TTS (Kokoro) model verified: $kokoroModel" -ForegroundColor Green
} else {
    Write-AuditFailure "TTS (Kokoro) model missing at $kokoroModel"
}

# Verify Gemma GGUF model via MODEL_PIN.json
$pinPath = Join-Path $packageRoot "rosie\MODEL_PIN.json"
$gemmaFilename = "google_gemma-4-E4B-it-Q4_K_M.gguf"
if (Test-Path $pinPath) {
    try {
        $pin = Get-Content -Raw $pinPath | ConvertFrom-Json
        if ($pin.filename) { $gemmaFilename = $pin.filename }
    } catch {}
}
$gemmaModelPath = Join-Path $rosieRoot "models\gemma-4-e4b\$gemmaFilename"
if (Test-Path $gemmaModelPath) {
    Write-Host "[OK] LLM (Gemma GGUF) model verified: $gemmaModelPath" -ForegroundColor Green
} else {
    Write-AuditFailure "LLM (Gemma GGUF) model missing at $gemmaModelPath"
}

# Network connection and Scheduled Task checks
$llamaHost = "127.0.0.1"
$llamaPort = 8080
if ($config -and $config.server -and $config.server.environment) {
  if ($config.server.environment.RIVERSIDE_LLAMA_HOST) {
    $llamaHost = "$($config.server.environment.RIVERSIDE_LLAMA_HOST)".Trim()
  }
  if ($config.server.environment.RIVERSIDE_LLAMA_PORT) {
    $llamaPort = [int]$config.server.environment.RIVERSIDE_LLAMA_PORT
  }
}
$llamaBase = "http://${llamaHost}:$llamaPort"
Write-Host "Testing ROSIE Host LLM at $llamaBase ..."
try {
  $llamaHealth = Invoke-WebRequest -Uri "$llamaBase/health" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
  if ($llamaHealth.StatusCode -eq 200) {
    Write-Host "[OK] llama-server is responding at $llamaBase." -ForegroundColor Green
  } else {
    Write-AuditFailure "llama-server returned HTTP $($llamaHealth.StatusCode) at $llamaBase."
  }
} catch {
  Write-AuditFailure "llama-server is not reachable at $llamaBase. ROSIE chat will return 502 until Start-RiversideLlama.cmd runs or the 'Riverside OS LLM Host' task is started."
  Write-Host "       Error: $($_.Exception.Message)" -ForegroundColor Red
}
$llamaTask = Get-ScheduledTask -TaskName "Riverside OS LLM Host" -ErrorAction SilentlyContinue
if ($llamaTask) {
  Write-Host "[OK] Scheduled task 'Riverside OS LLM Host' is registered. State: $($llamaTask.State)" -ForegroundColor Green
} else {
  Write-AuditFailure "Scheduled task 'Riverside OS LLM Host' is missing. ROSIE will not restart reliably with the Main Hub."
}

# 5. Core API Server Service Checks
Write-Host ""
Write-Host "--- Core API Server Checks ---" -ForegroundColor Blue
$taskName = "Riverside OS Server"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-AuditFailure "Scheduled Task '$taskName' is missing. The server is not installed properly."
} else {
    Write-Host "[OK] Scheduled Task '$taskName' is registered. State: $($task.State)" -ForegroundColor Green
}

$apiBase = "http://127.0.0.1:3000"
if ($config -and $config.register -and $config.register.apiBase) {
    $apiBase = $config.register.apiBase
}

Write-Host "Testing HTTP response from API at $apiBase/api/version..."
try {
    $response = Invoke-WebRequest -Uri "$apiBase/api/version" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    $versionData = $response.Content | ConvertFrom-Json
    Write-Host "[OK] API server is online and responsive." -ForegroundColor Green
    Write-Host "     Server version reported: $($versionData.version)" -ForegroundColor Green

    $readyResponse = Invoke-WebRequest -Uri "$apiBase/api/ready" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    $readyData = $readyResponse.Content | ConvertFrom-Json
    $buildSha = "$($readyData.build_sha)".Trim()
    if ([string]::IsNullOrWhiteSpace($buildSha) -or $buildSha -in @("unknown", "dev")) {
        Write-AuditFailure "The API did not report an immutable build SHA. Exact installed-build verification is impossible."
    } else {
        Write-Host "[OK] API build identity: $buildSha" -ForegroundColor Green
    }
    if ($expectedManifest) {
        $expectedBuildSha = "$($expectedManifest.sourceGitSha)".Trim()
        $expectedVersion = "$($expectedManifest.releaseVersion)".Trim()
        $reportedVersion = "$($versionData.version)".Trim()
        if ($expectedBuildSha -notmatch '^[0-9a-fA-F]{40}$') {
            Write-AuditFailure "The expected deployment manifest does not contain a valid full sourceGitSha."
        } elseif (-not $buildSha.Equals($expectedBuildSha, [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-AuditFailure "Installed API build SHA '$buildSha' does not match the expected package SHA '$expectedBuildSha'."
        } else {
            Write-Host "[OK] Installed API build matches the exact package SHA." -ForegroundColor Green
        }
        if ([string]::IsNullOrWhiteSpace($expectedVersion) -or $reportedVersion -ne $expectedVersion) {
            Write-AuditFailure "Installed API version '$reportedVersion' does not match the expected package version '$expectedVersion'."
        } else {
            Write-Host "[OK] Installed API version matches the expected package version." -ForegroundColor Green
        }
        if ($config -and "$($config.releaseVersion)".Trim() -ne $expectedVersion) {
            Write-AuditFailure "Installed config releaseVersion '$($config.releaseVersion)' does not match the expected package version '$expectedVersion'."
        }
    }
    if ("$($readyData.status)".Trim().ToLowerInvariant() -ne "ready") {
        Write-AuditFailure "API readiness is '$($readyData.status)', not 'ready'. Review unavailable or degraded components before go-live."
    } else {
        Write-Host "[OK] API readiness reports ready." -ForegroundColor Green
    }
} catch {
    Write-AuditFailure "API server is offline or unreachable. Error: $($_.Exception.Message)"
}

# 6. Credentials Encryption & Environment Variables
Write-Host ""
Write-Host "--- Environment Credentials Checks ---" -ForegroundColor Blue
$jwtSecret = $null
$credKey = $null
$cpToken = $null
$backupDatabaseUrl = $null
$serverEnvPath = Join-Path $contractInstallRoot "server\.env"

$jwtSecret = Get-DotEnvValue $serverEnvPath "RIVERSIDE_STORE_CUSTOMER_JWT_SECRET"
$credKey = Get-DotEnvValue $serverEnvPath "RIVERSIDE_CREDENTIALS_KEY"
$backupDatabaseUrl = Get-DotEnvValue $serverEnvPath "RIVERSIDE_BACKUP_DATABASE_URL"
$credKeySource = "server .env"
if ([string]::IsNullOrWhiteSpace($credKey)) {
    $credKey = [System.Environment]::GetEnvironmentVariable("RIVERSIDE_CREDENTIALS_KEY", "Machine")
    $credKeySource = "Machine environment"
}
$cpToken = Get-DotEnvValue $serverEnvPath "COUNTERPOINT_SYNC_TOKEN"

if ([string]::IsNullOrWhiteSpace($jwtSecret) -or $jwtSecret.Length -lt 32) {
    Write-AuditFailure "The store-customer JWT secret is weak, empty, or missing in the effective server .env."
} else {
    Write-Host "[OK] JWT Token secret is configured and secure." -ForegroundColor Green
}

if ([string]::IsNullOrWhiteSpace($credKey)) {
    Write-AuditFailure "RIVERSIDE_CREDENTIALS_KEY is missing from the effective server .env and Machine environment. Encryption will fail."
} else {
    Write-Host "[OK] RIVERSIDE_CREDENTIALS_KEY is active from the $credKeySource." -ForegroundColor Green
}

if ([string]::IsNullOrWhiteSpace($backupDatabaseUrl)) {
    Write-AuditFailure "RIVERSIDE_BACKUP_DATABASE_URL is missing from the effective server .env. Complete backups can fail when non-public schemas use a different PostgreSQL owner."
} else {
    Write-Host "[OK] Complete database backup access is configured." -ForegroundColor Green
}

if ($cpToken) {
    Write-Host "[OK] Counterpoint Sync Token is configured." -ForegroundColor Green
} else {
    Write-AuditFailure "Counterpoint Sync Token is missing. The production sync bridge cannot authenticate."
}

# 7. Printer Configuration checks
Write-Host ""
Write-Host "--- Printer Reachability Checks ---" -ForegroundColor Blue
if ($config -and $config.register -and $config.register.receiptPrinter) {
    $printer = $config.register.receiptPrinter
    if ($printer.mode -eq "network" -and $printer.ip) {
        Write-Host "Testing network printer IP connection: $($printer.ip):$($printer.port)..."
        $ping = New-Object System.Net.NetworkInformation.Ping
        try {
            $reply = $ping.Send($printer.ip, 2000)
            if ($reply.Status -eq "Success") {
                Write-Host "[OK] Network printer IP $($printer.ip) responded to ping." -ForegroundColor Green
            } else {
                Write-AuditFailure "Network printer IP $($printer.ip) did not respond. Ping status: $($reply.Status)"
            }
        } catch {
            Write-AuditFailure "Ping test failed for $($printer.ip). Error: $($_.Exception.Message)"
        }
    } elseif ($printer.mode -eq "system" -and $printer.systemName) {
        Write-Host "Testing local system printer presence: '$($printer.systemName)'..."
        try {
            $winPrinter = Get-Printer -Name $printer.systemName -ErrorAction Stop
            Write-Host "[OK] Local printer '$($printer.systemName)' found. Status: $($winPrinter.PrinterStatus)" -ForegroundColor Green
        } catch {
            Write-AuditFailure "System printer '$($printer.systemName)' was not found on this system."
        }
    }
} else {
    Write-Host "No custom printer details configured. Skipping print routing check." -ForegroundColor Gray
}

# 8. Updater Path Contract Probes
# Verifies that the file-system paths the Tauri updater checks for Main Hub
# detection actually exist on this machine.  If these fail, Settings → Updates
# will show the satellite "Go to Main Hub" instructions even on the Main Hub.
#
# SYNC: These paths MUST match install_contract.rs constants and install-server.ps1.
#       Run deployment\windows\validate-install-contract.ps1 before every release.
Write-Host ""
Write-Host "--- Updater Path Contract Probes ---" -ForegroundColor Blue

$contractInstallRoot = "C:\RiversideOS"
if ($config -and $config.server -and $config.server.installRoot) {
    $contractInstallRoot = $config.server.installRoot
}

$contractServerBin   = Join-Path $contractInstallRoot "server\riverside-server.exe"
$contractConfigFile  = Join-Path $contractInstallRoot "riverside-deployment.config.json"
$contractSummaryFile = Join-Path $contractInstallRoot "deployment-summary.txt"

$contractAnyFound = $false
foreach ($probe in @(
    @{ Path = $contractServerBin;   Label = "Server binary (server\riverside-server.exe)" },
    @{ Path = $contractConfigFile;  Label = "Deployment config (riverside-deployment.config.json)" },
    @{ Path = $contractSummaryFile; Label = "Install marker (deployment-summary.txt)" }
)) {
    if (Test-Path $probe.Path) {
        Write-Host "[OK] Found: $($probe.Label)" -ForegroundColor Green
        Write-Host "     $($probe.Path)" -ForegroundColor DarkGray
        $contractAnyFound = $true
    } else {
        Write-Host "[WARN] Missing: $($probe.Label)" -ForegroundColor Yellow
        Write-Host "       $($probe.Path)" -ForegroundColor DarkGray
    }
}

if ($contractAnyFound) {
    Write-Host "[OK] Updater will detect this PC as the Main Hub (at least one probe file found)." -ForegroundColor Green
} else {
    Write-AuditFailure "NONE of the updater probe files were found under $contractInstallRoot."
    Write-Host "       Settings -> Updates will incorrectly show 'Go to Main Hub' instructions." -ForegroundColor Red
    Write-Host "       Re-run install-server.ps1 or check that installRoot in the config is correct." -ForegroundColor Red
}

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
if ($script:auditFailureCount -gt 0) {
    Write-Host " Audit Verification Failed ($($script:auditFailureCount) issue(s)) " -ForegroundColor Red
} else {
    Write-Host "          Audit Verification Complete        " -ForegroundColor Cyan
}
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

if ($script:auditFailureCount -gt 0) {
    exit 1
}
exit 0
