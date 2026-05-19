[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "   Riverside OS System Audit & Diagnostics   " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# 1. Admin Privilege check
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[FAIL] Script is not running as Administrator. Please run this command/app elevated." -ForegroundColor Red
    exit 1
} else {
    Write-Host "[OK] Running with elevated Administrator privileges." -ForegroundColor Green
}

# 2. Config Resolution
$packageRoot = $PSScriptRoot
if (-not $packageRoot) { $packageRoot = (Get-Location).Path }
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
        $env:PGPASSWORD = ""
        if ($config -and $config.server -and $config.server.database -and $config.server.database.adminPassword) {
            $env:PGPASSWORD = $config.server.database.adminPassword
        }
        
        $queryResult = & $psqlPath -U $dbUser -h $dbHost -p $dbPort -d $dbName -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';" -t 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[FAIL] Could not query database. Password may be incorrect, or database '$dbName' does not exist." -ForegroundColor Red
            Write-Host "       Error: $queryResult" -ForegroundColor Red
        } else {
            $tableCount = "$queryResult".Trim()
            Write-Host "[OK] Connected to database '$dbName'. Found $tableCount tables." -ForegroundColor Green
            
            # Check Migrations Count
            $migrationResult = & $psqlPath -U $dbUser -h $dbHost -p $dbPort -d $dbName -c "SELECT COUNT(*) FROM _sqlx_migrations;" -t 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Host "[OK] Applied migrations count: $($migrationResult.Trim())" -ForegroundColor Green
            } else {
                Write-Host "[WARN] _sqlx_migrations table not found or query failed. Migrations may not have run yet." -ForegroundColor Yellow
            }
        }
        $env:PGPASSWORD = $null
    }
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

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "          Audit Verification Complete        " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""
