[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "   Riverside OS System Audit & Diagnostics   " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# 1. Admin Privilege check
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = $null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })
if (-not $isAdmin) {
    Write-Host "[FAIL] Script is not running as Administrator. Please run this command/app elevated." -ForegroundColor Red
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
$configPath = Join-Path $packageRoot "riverside-deployment.config.json"

if (-not (Test-Path $configPath)) {
    Write-Host "[WARN] riverside-deployment.config.json was not found at $configPath." -ForegroundColor Yellow
    Write-Host "       Falling back to environment variables and defaults." -ForegroundColor Yellow
    $config = $null
} else {
    try {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        Write-Host "[OK] Loaded deployment config from $configPath" -ForegroundColor Green
    } catch {
        Write-Host "[FAIL] Found config file, but it contains invalid JSON: $($_.Exception.Message)" -ForegroundColor Red
        $config = $null
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
    Write-Host "[FAIL] Port $dbPort is not listening on $dbHost. PostgreSQL is likely stopped or blocked by firewall." -ForegroundColor Red
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
        Write-Host "[WARN] psql.exe not found on the path. Skipping active query checks." -ForegroundColor Yellow
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
            Write-Host "[FAIL] Could not query database. Password may be incorrect, or database '$dbName' does not exist." -ForegroundColor Red
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
                Write-Host "[WARN] ros_schema_migrations table not found or query failed. Migrations may not have run yet." -ForegroundColor Yellow
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
$rosieRoot = Join-Path $contractInstallRoot "rosie"
$readyFlag = Join-Path $rosieRoot "rosie_ready"
$statusPath = Join-Path $rosieRoot "rosie_status.json"

if (Test-Path $statusPath) {
    try {
        $rosieStatus = Get-Content -Raw $statusPath | ConvertFrom-Json
        if ($rosieStatus.ready -eq $true) {
            Write-Host "[OK] ROSIE component manifest reports full stack readiness." -ForegroundColor Green
        } else {
            Write-Host "[FAIL] ROSIE component manifest reports partial readiness. See $statusPath." -ForegroundColor Red
        }
        foreach ($component in @("binaries", "llm", "stt", "tts")) {
            $componentStatus = $rosieStatus.components.$component
            if ($componentStatus -and $componentStatus.ready -eq $true) {
                Write-Host "[OK] ROSIE $component ready." -ForegroundColor Green
            } else {
                Write-Host "[FAIL] ROSIE $component not ready." -ForegroundColor Red
            }
        }
    } catch {
        Write-Host "[FAIL] ROSIE component manifest could not be parsed at $statusPath." -ForegroundColor Red
    }
} elseif (Test-Path $readyFlag) {
    Write-Host "[OK] ROSIE stack ready flag file found at $readyFlag." -ForegroundColor Green
} else {
    Write-Host "[FAIL] ROSIE stack ready flag file is missing at $readyFlag. ROSIE was not installed correctly." -ForegroundColor Red
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
        Write-Host "[FAIL] Binary missing: $binPath" -ForegroundColor Red
    }
}

# Verify models
$sensevoiceModel = Join-Path $rosieRoot "stt\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17\model.int8.onnx"
if (Test-Path $sensevoiceModel) {
    Write-Host "[OK] STT (SenseVoice) model verified: $sensevoiceModel" -ForegroundColor Green
} else {
    Write-Host "[FAIL] STT (SenseVoice) model missing at $sensevoiceModel" -ForegroundColor Red
}

$kokoroModel = Join-Path $rosieRoot "tts\kokoro-multi-lang-v1_0\model.onnx"
if (Test-Path $kokoroModel) {
    Write-Host "[OK] TTS (Kokoro) model verified: $kokoroModel" -ForegroundColor Green
} else {
    Write-Host "[FAIL] TTS (Kokoro) model missing at $kokoroModel" -ForegroundColor Red
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
    Write-Host "[FAIL] LLM (Gemma GGUF) model missing at $gemmaModelPath" -ForegroundColor Red
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
    Write-Host "[FAIL] llama-server returned HTTP $($llamaHealth.StatusCode) at $llamaBase." -ForegroundColor Red
  }
} catch {
  Write-Host "[FAIL] llama-server is not reachable at $llamaBase. ROSIE chat will return 502 until Start-RiversideLlama.cmd runs or the 'Riverside OS LLM Host' task is started." -ForegroundColor Red
  Write-Host "       Error: $($_.Exception.Message)" -ForegroundColor Red
}
$llamaTask = Get-ScheduledTask -TaskName "Riverside OS LLM Host" -ErrorAction SilentlyContinue
if ($llamaTask) {
  Write-Host "[OK] Scheduled task 'Riverside OS LLM Host' is registered. State: $($llamaTask.State)" -ForegroundColor Green
} else {
  Write-Host "[WARN] Scheduled task 'Riverside OS LLM Host' is missing. Re-run install-server.ps1 from a v0.70.1+ package or run Start-RiversideLlama.cmd." -ForegroundColor Yellow
}

# 5. Core API Server Service Checks
Write-Host ""
Write-Host "--- Core API Server Checks ---" -ForegroundColor Blue
$taskName = "Riverside OS Server"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "[FAIL] Scheduled Task '$taskName' is missing. The server is not installed properly." -ForegroundColor Red
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
} catch {
    Write-Host "[FAIL] API server is offline or unreachable. Error: $($_.Exception.Message)" -ForegroundColor Red
}

# 6. Credentials Encryption & Environment Variables
Write-Host ""
Write-Host "--- Environment Credentials Checks ---" -ForegroundColor Blue
$jwtSecret = $null
$credKey = $null
$cpToken = $null

if ($config -and $config.server -and $config.server.storeCustomerJwtSecret) {
    $jwtSecret = $config.server.storeCustomerJwtSecret
}
$credKey = [System.Environment]::GetEnvironmentVariable("RIVERSIDE_CREDENTIALS_KEY", "Machine")
if ($config -and $config.server -and $config.server.environment) {
    $cpToken = $config.server.environment.COUNTERPOINT_SYNC_TOKEN
}

if ([string]::IsNullOrWhiteSpace($jwtSecret) -or $jwtSecret.Length -lt 32) {
    Write-Host "[WARN] JWT Token secret is weak, empty, or missing in config." -ForegroundColor Yellow
} else {
    Write-Host "[OK] JWT Token secret is configured and secure." -ForegroundColor Green
}

if ([string]::IsNullOrWhiteSpace($credKey)) {
    Write-Host "[FAIL] RIVERSIDE_CREDENTIALS_KEY environment variable is missing on this machine. Encryption will fail." -ForegroundColor Red
} else {
    Write-Host "[OK] RIVERSIDE_CREDENTIALS_KEY environment variable is active." -ForegroundColor Green
}

if ($cpToken) {
    Write-Host "[OK] Counterpoint Sync Token is configured." -ForegroundColor Green
} else {
    Write-Host "[WARN] Counterpoint Sync Token is missing. Sync bridge will fail unless configured manually." -ForegroundColor Yellow
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
                Write-Host "[FAIL] Network printer IP $($printer.ip) did not respond. Ping status: $($reply.Status)" -ForegroundColor Red
            }
        } catch {
            Write-Host "[FAIL] Ping test failed for $($printer.ip). Error: $($_.Exception.Message)" -ForegroundColor Red
        }
    } elseif ($printer.mode -eq "system" -and $printer.systemName) {
        Write-Host "Testing local system printer presence: '$($printer.systemName)'..."
        try {
            $winPrinter = Get-Printer -Name $printer.systemName -ErrorAction Stop
            Write-Host "[OK] Local printer '$($printer.systemName)' found. Status: $($winPrinter.PrinterStatus)" -ForegroundColor Green
        } catch {
            Write-Host "[FAIL] System printer '$($printer.systemName)' was not found on this system." -ForegroundColor Red
        }
    }
} else {
    Write-Host "No custom printer details configured. Skipping print routing check." -ForegroundColor Gray
}

# 8. Updater Path Contract Probes
# Verifies that the file-system paths the Tauri updater checks for Main Hub
# detection actually exist on this machine.  If these fail, Settings → Updates
# will show the satellite "Go to Main Hub" instructions even on the server PC.
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
    Write-Host "[FAIL] NONE of the updater probe files were found under $contractInstallRoot." -ForegroundColor Red
    Write-Host "       Settings -> Updates will incorrectly show 'Go to Main Hub' instructions." -ForegroundColor Red
    Write-Host "       Re-run install-server.ps1 or check that installRoot in the config is correct." -ForegroundColor Red
}

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "          Audit Verification Complete        " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""
