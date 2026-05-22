[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ($null -ne ($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' }))
}

if (-not (Test-Admin)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "`"$PSCommandPath`""
  )
  exit
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ScriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ScriptRoot)) {
  $ScriptRoot = if ($MyInvocation -and $MyInvocation.MyCommand -and $MyInvocation.MyCommand.Path) {
    Split-Path -Parent $MyInvocation.MyCommand.Path
  } else {
    Split-Path -Parent $PSCommandPath
  }
}
if (-not $ScriptRoot) {
  $ScriptRoot = "."
}
$packageRoot = $ScriptRoot
$configExamplePath = Join-Path $packageRoot "riverside-deployment.config.example.json"
$configPath = Join-Path $packageRoot "riverside-deployment.config.json"
$packageManifestPath = Join-Path $packageRoot "deployment-package.manifest.json"
$managerLogPath = Join-Path $packageRoot "deployment-manager.log"

function Read-DeploymentConfig {
  if (-not (Test-Path $configPath)) {
    if (-not (Test-Path $configExamplePath)) {
      throw "Missing riverside-deployment.config.example.json in the deployment package."
    }
    Copy-Item $configExamplePath $configPath -Force
  }
  Get-Content $configPath -Raw | ConvertFrom-Json
}

function Write-DeploymentConfig($Config) {
  $json = $Config | ConvertTo-Json -Depth 20
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($configPath, $json, $utf8NoBom)
}

function Read-PackageManifest {
  if (-not (Test-Path $packageManifestPath)) {
    return $null
  }
  try {
    return Get-Content $packageManifestPath -Raw | ConvertFrom-Json
  } catch {
    throw "Deployment package manifest is invalid. Rebuild the package."
  }
}

function New-RiversideSecret([int]$Length = 36) {
  $chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789".ToCharArray()
  $bytes = New-Object byte[] $Length
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  $result = New-Object char[] $Length
  for ($i = 0; $i -lt $Length; $i++) {
    $result[$i] = $chars[$bytes[$i] % $chars.Length]
  }
  return -join $result
}

function Test-PlaceholderSecret([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $true
  }
  return $Value -match "^replace-" -or $Value -eq "password"
}

function Get-ConfigEnvironmentValue($Environment, [string]$Name) {
  if (-not $Environment) {
    return ""
  }
  $property = $Environment.PSObject.Properties[$Name]
  if (-not $property -or $null -eq $property.Value) {
    return ""
  }
  return "$($property.Value)"
}

function Set-ConfigEnvironmentValue($Config, [string]$Name, [string]$Value) {
  if (-not $Config.server.environment) {
    $Config.server | Add-Member -NotePropertyName environment -NotePropertyValue ([pscustomobject]@{}) -Force
  }

  if ($Config.server.environment.PSObject.Properties[$Name]) {
    $Config.server.environment.$Name = $Value
  } else {
    $Config.server.environment | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  }
}

function Get-PrimaryIpAddress {
  $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
    Sort-Object InterfaceMetric |
    Select-Object -First 1

  if ($ip) {
    return $ip.IPAddress
  }
  return "127.0.0.1"
}

function Find-PsqlPath {
  $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  $matches = Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending
  if ($matches) {
    return $matches[0].FullName
  }
  return ""
}

function Install-PostgreSqlWithWinget {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "PostgreSQL is not installed and Windows Package Manager was not found. Install PostgreSQL 18 first, then rerun this manager."
  }

  if (Test-PlaceholderSecret $postgresPasswordText.Text) {
    $postgresPasswordText.Text = New-RiversideSecret 24
    Add-Log "Generated PostgreSQL admin password for the new PostgreSQL install."
  }

  Add-Log "Installing PostgreSQL 18. This may take several minutes."
  $override = "--mode unattended --unattendedmodeui minimal --superpassword `"$($postgresPasswordText.Text)`" --serverport 5432"
  $output = & $winget.Source install -e --id PostgreSQL.PostgreSQL.18 --silent --accept-package-agreements --accept-source-agreements --override $override 2>&1
  foreach ($line in $output) {
    if ($null -ne $line) {
      Add-Log "$line"
    }
  }
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL install failed with exit code $LASTEXITCODE."
  }

  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $found = Find-PsqlPath
    if ($found) {
      $psqlPathText.Text = $found
      Add-Log "PostgreSQL command found at $found"
      return
    }
  }

  throw "PostgreSQL install finished, but psql.exe was not found yet. Restart Windows, then rerun this manager."
}

function Ensure-PostgreSqlAvailableForServer {
  $psqlPath = $psqlPathText.Text.Trim()
  if ($psqlPath -and (Test-Path $psqlPath)) {
    return
  }

  $found = Find-PsqlPath
  if ($found) {
    $psqlPathText.Text = $found
    return
  }

  $choice = [System.Windows.Forms.MessageBox]::Show(
    "PostgreSQL was not found. Install PostgreSQL 18 now?",
    "Install PostgreSQL",
    "YesNo",
    "Question"
  )
  if ($choice -ne "Yes") {
    throw "PostgreSQL is required for the Server install."
  }

  Install-PostgreSqlWithWinget
}

function Get-InstalledPrinterNames {
  try {
    $printers = Get-Printer -ErrorAction Stop | Sort-Object Name | Select-Object -ExpandProperty Name
    return @($printers)
  } catch {
    return @()
  }
}

function Invoke-Installer($ScriptName, [string[]]$ExtraArgs = @()) {
  $scriptPath = Join-Path $packageRoot $ScriptName
  if (-not (Test-Path $scriptPath)) {
    throw "Missing installer script: $ScriptName"
  }

  $installerArgs = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $scriptPath,
    "-ConfigPath",
    $configPath
  )
  $installerArgs += $ExtraArgs

  Add-Log "Running $ScriptName..."
  $output = & powershell.exe @installerArgs 2>&1
  foreach ($line in $output) {
    if ($null -ne $line) {
      Add-Log "$line"
    }
  }
  if ($LASTEXITCODE -ne 0) {
    throw "$ScriptName failed with exit code $LASTEXITCODE."
  }
}

function Stop-RiversideDesktopApp {
  foreach ($name in @("Riverside POS", "Riverside.POS", "RiversideOS", "riverside-pos")) {
    Stop-Process -Name $name -Force -ErrorAction SilentlyContinue
  }
}

function Uninstall-RiversideDesktopApp {
  Stop-RiversideDesktopApp
  $registryPaths = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )

  $apps = foreach ($path in $registryPaths) {
    Get-ItemProperty $path -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -match "Riverside" -and ($_.DisplayName -match "POS|OS") }
  }

  foreach ($app in $apps) {
    if ($app.PSChildName -match "^\{.*\}$") {
      $proc = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @("/x", $app.PSChildName, "/qn", "/norestart")
      if ($proc.ExitCode -ne 0) {
        throw "Riverside desktop uninstall failed with exit code $($proc.ExitCode)."
      }
    } elseif ($app.UninstallString) {
      Start-Process cmd.exe -Wait -ArgumentList @("/c", $app.UninstallString)
    }
  }

  $stationDir = Join-Path $env:PROGRAMDATA "RiversideOS"
  Remove-Item (Join-Path $stationDir "station-config.json") -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $stationDir "register-deployment-summary.txt") -Force -ErrorAction SilentlyContinue
}

function Uninstall-RiversideServer {
  $config = Read-DeploymentConfig
  $installRoot = $config.server.installRoot
  if (-not $installRoot) {
    $installRoot = "C:\RiversideOS"
  }

  Stop-ScheduledTask -TaskName "Riverside OS Server" -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "Riverside OS Server" -Confirm:$false -ErrorAction SilentlyContinue
  Stop-Process -Name "riverside-server" -Force -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName $config.server.firewallRuleName -ErrorAction SilentlyContinue

  foreach ($child in @("server", "client", "release")) {
    Remove-Item (Join-Path $installRoot $child) -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-Item (Join-Path $installRoot "deployment-summary.txt") -Force -ErrorAction SilentlyContinue
}

function Test-PackageFile($RelativePath) {
  return Test-Path (Join-Path $packageRoot $RelativePath)
}

function Add-Log($Text) {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $managerLogPath -Value "[$timestamp] $Text" -Encoding UTF8
  $logBox.AppendText("$Text`r`n")
  $logBox.SelectionStart = $logBox.Text.Length
  $logBox.ScrollToCaret()
}

function Test-HttpReady([string]$Url) {
  try {
    Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Get-ServerInstallRoot {
  try {
    $config = Read-DeploymentConfig
    if ($config.server.installRoot) {
      return "$($config.server.installRoot)"
    }
  } catch {
    # Status checks should stay usable even before config is finalized.
  }
  return "C:\RiversideOS"
}

function Get-PackageVersionText {
  $manifest = Read-PackageManifest
  if ($manifest -and $manifest.releaseVersion) {
    return "$($manifest.releaseVersion)"
  }
  try {
    $config = Read-DeploymentConfig
    if ($config.releaseVersion) {
      return "$($config.releaseVersion)"
    }
  } catch {
    return "unknown"
  }
  return "unknown"
}

function Get-ServerApiBaseForStatus {
  if ($serverRadio.Checked) {
    return "http://127.0.0.1:3000"
  }
  if ($apiBaseText.Text.Trim()) {
    return Normalize-ApiBase $apiBaseText.Text
  }
  return "http://127.0.0.1:3000"
}

function Get-RiversideServerTaskStatus {
  $task = Get-ScheduledTask -TaskName "Riverside OS Server" -ErrorAction SilentlyContinue
  if (-not $task) {
    return "missing"
  }
  return "$($task.State)"
}

function Get-InstalledServerVersion([string]$BaseUrl) {
  try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/api/version" -UseBasicParsing -TimeoutSec 4
    if ($response.StatusCode -ne 200) {
      return "unreachable"
    }
    $body = $response.Content | ConvertFrom-Json
    if ($body.version) {
      return "$($body.version)"
    }
    return "unknown"
  } catch {
    return "unreachable"
  }
}

function Refresh-ServerManagerStatus {
  try {
    $apiBase = Get-ServerApiBaseForStatus
    $taskState = Get-RiversideServerTaskStatus
    $packageVersion = Get-PackageVersionText
    $installedVersion = Get-InstalledServerVersion $apiBase

    $serverTaskValue.Text = $taskState
    $serverApiValue.Text = $apiBase
    $serverInstalledValue.Text = $installedVersion
    $serverPackageValue.Text = $packageVersion

    if ($installedVersion -eq "unreachable") {
      $serverVerdictValue.Text = "Server unreachable. Use Start Server, Restart Server, or Repair Server."
      return
    }
    if ($packageVersion -ne "unknown" -and $installedVersion -ne $packageVersion) {
      $serverVerdictValue.Text = "Server update required. Run Update This Server PC."
      return
    }
    if ($taskState -eq "missing") {
      $serverVerdictValue.Text = "Server task missing. Run Repair Server."
      return
    }
    $serverVerdictValue.Text = "Server version and package match."
  } catch {
    $serverVerdictValue.Text = "Could not refresh server status: $($_.Exception.Message)"
  }
}

function Start-RiversideServerFromManager {
  $task = Get-ScheduledTask -TaskName "Riverside OS Server" -ErrorAction SilentlyContinue
  if (-not $task) {
    throw "Riverside OS Server task is missing. Run Backoffice / Server Repair."
  }
  Add-Log "Starting Riverside OS Server task..."
  Start-ScheduledTask -TaskName "Riverside OS Server"
  Start-Sleep -Seconds 2
  Refresh-ServerManagerStatus
}

function Restart-RiversideServerFromManager {
  Add-Log "Restarting Riverside OS Server task..."
  Stop-ScheduledTask -TaskName "Riverside OS Server" -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  foreach ($process in Get-Process -Name "riverside-server" -ErrorAction SilentlyContinue) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Start-RiversideServerFromManager
}

function Open-RiversideServerLogs {
  $installRoot = Get-ServerInstallRoot
  $logDir = Join-Path $installRoot "logs"
  if (Test-Path $logDir) {
    Invoke-Item $logDir
    return
  }
  Invoke-Item $installRoot
}

function Normalize-ApiBase([string]$Value) {
  $url = "$Value".Trim()
  if (-not $url) {
    return ""
  }
  if ($url -notmatch "^https?://") {
    $url = "http://$url"
  }
  $hasExplicitPort = $url -match "^https?://[^/]+:\d+(/|$)"
  $uri = [Uri]$url
  $builder = [UriBuilder]::new($uri)
  if (-not $hasExplicitPort -and $builder.Scheme -eq "http") {
    $builder.Port = 3000
  }
  return $builder.Uri.AbsoluteUri.TrimEnd("/")
}

function Get-ServerApiBaseFromField {
  $serverAddress = $serverAddressText.Text.Trim()
  if (-not $serverAddress) {
    $serverAddress = Get-PrimaryIpAddress
  }
  return Normalize-ApiBase $serverAddress
}

function Set-RoleControlState {
  $serverMode = $serverRadio.Checked
  foreach ($control in $serverGroup.Controls) {
    $control.Enabled = $serverMode
  }
  foreach ($control in $workstationGroup.Controls) {
    $control.Enabled = -not $serverMode
  }
  if ($serverMode) {
    $apiBaseText.Enabled = $true
    $updateButton.Text = "Update This Server PC"
    $repairButton.Text = "Repair Server"
  } else {
    $updateButton.Text = "Update This PC"
    $repairButton.Text = "Repair Settings"
  }
}

function Set-RoleDefaults {
  if ($serverRadio.Checked) {
    $apiBaseText.Text = "http://127.0.0.1:3000"
    $stationLabelText.Text = "Backoffice / Server"
    $cashDrawerCheck.Checked = $false
  } elseif ($registerRadio.Checked) {
    $apiBaseText.Text = Get-ServerApiBaseFromField
    $stationLabelText.Text = "Register #1"
    $cashDrawerCheck.Checked = $true
  } else {
    $apiBaseText.Text = Get-ServerApiBaseFromField
    $stationLabelText.Text = "Back Office"
    $cashDrawerCheck.Checked = $false
  }
  Set-RoleControlState
}

function Load-ConfigIntoForm {
  $config = Read-DeploymentConfig
  $serverHost = Get-PrimaryIpAddress

  $serverAddressText.Text = $serverHost
  if ($config.server.database.psqlPath) {
    $psqlPathText.Text = $config.server.database.psqlPath
  } else {
    $psqlPathText.Text = Find-PsqlPath
  }
  $postgresPasswordText.Text = $config.server.database.adminPassword
  $appPasswordText.Text = $config.server.database.appPassword
  $secretText.Text = $config.server.storeCustomerJwtSecret
  $apiBaseText.Text = "http://$serverHost`:3000"

  if ($config.register.apiBase) {
    $apiBaseText.Text = $config.register.apiBase
  }
  if ($config.register.stationLabel) {
    $stationLabelText.Text = $config.register.stationLabel
  }
  $cashDrawerCheck.Checked = [bool]$config.register.cashDrawerEnabled

  if ($config.register.receiptPrinter.mode -eq "system") {
    $receiptModeCombo.SelectedItem = "Installed printer"
  } else {
    $receiptModeCombo.SelectedItem = "Network IP"
  }
  $receiptIpText.Text = $config.register.receiptPrinter.ip
  $receiptPortText.Text = "$($config.register.receiptPrinter.port)"
}

function Save-FormToConfig {
  $config = Read-DeploymentConfig

  $manifest = Read-PackageManifest
  if ($manifest -and $manifest.releaseVersion) {
    if ($config.releaseVersion -ne $manifest.releaseVersion) {
      if ($config.PSObject.Properties["releaseVersion"]) {
        $config.releaseVersion = $manifest.releaseVersion
      } else {
        $config | Add-Member -NotePropertyName "releaseVersion" -NotePropertyValue $manifest.releaseVersion -Force
      }
    }
  }

  $serverAddress = $serverAddressText.Text.Trim()
  if (-not $serverAddress) {
    $serverAddress = Get-PrimaryIpAddress
  }
  $serverApiBase = Normalize-ApiBase $serverAddress

  $config.server.httpBind = "0.0.0.0:3000"
  $config.server.corsOrigins = @(
    $serverApiBase,
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://tauri.localhost",
    "https://tauri.localhost"
  )
  $config.server.database.psqlPath = $psqlPathText.Text.Trim()
  $config.server.database.adminPassword = $postgresPasswordText.Text
  if (Test-PlaceholderSecret $appPasswordText.Text) {
    $appPasswordText.Text = New-RiversideSecret 28
    Add-Log "Generated Riverside database password."
  }
  if (Test-PlaceholderSecret $secretText.Text -or $secretText.Text.Length -lt 32) {
    $secretText.Text = New-RiversideSecret 48
    Add-Log "Generated Riverside app secret."
  }

  $config.server.database.appPassword = $appPasswordText.Text
  $config.server.storeCustomerJwtSecret = $secretText.Text
  $counterpointSyncToken = Get-ConfigEnvironmentValue $config.server.environment "COUNTERPOINT_SYNC_TOKEN"
  if (Test-PlaceholderSecret $counterpointSyncToken -or $counterpointSyncToken.Length -lt 32) {
    $counterpointSyncToken = New-RiversideSecret 48
    Set-ConfigEnvironmentValue $config "COUNTERPOINT_SYNC_TOKEN" $counterpointSyncToken
    Add-Log "Generated Counterpoint bridge sync token."
  }
  $helcimApiToken = Get-ConfigEnvironmentValue $config.server.environment "HELCIM_API_TOKEN"
  $helcimTerminal1 = Get-ConfigEnvironmentValue $config.server.environment "HELCIM_TERMINAL_1_DEVICE_CODE"
  $helcimTerminal2 = Get-ConfigEnvironmentValue $config.server.environment "HELCIM_TERMINAL_2_DEVICE_CODE"
  if ((Test-PlaceholderSecret $helcimApiToken) -or (Test-PlaceholderSecret $helcimTerminal1) -or (Test-PlaceholderSecret $helcimTerminal2)) {
    $config.server.strictProduction = $false
    Add-Log "Strict production startup disabled until Helcim API token and Terminal 1/2 device codes are configured."
  }

  if ($serverRadio.Checked) {
    $config.register.apiBase = "http://127.0.0.1:3000"
    $config.register.stationLabel = "Backoffice / Server"
    $config.register.cashDrawerEnabled = $false
  } else {
    $config.register.apiBase = Normalize-ApiBase $apiBaseText.Text
    $config.register.stationLabel = $stationLabelText.Text.Trim()
    $config.register.cashDrawerEnabled = [bool]$cashDrawerCheck.Checked
  }

  if ($receiptModeCombo.SelectedItem -eq "Installed printer") {
    $config.register.receiptPrinter.mode = "system"
    $config.register.receiptPrinter.ip = ""
    $config.register.receiptPrinter.systemName = "$($receiptPrinterCombo.SelectedItem)"
  } else {
    $config.register.receiptPrinter.mode = "network"
    $config.register.receiptPrinter.ip = $receiptIpText.Text.Trim()
    $config.register.receiptPrinter.port = [int]$receiptPortText.Text
    $config.register.receiptPrinter.systemName = ""
  }

  $config.register.tagPrinter.mode = "system"
  $config.register.tagPrinter.systemName = "$($tagPrinterCombo.SelectedItem)"
  $config.register.reportPrinter.mode = "system"
  $config.register.reportPrinter.systemName = "$($reportPrinterCombo.SelectedItem)"

  Write-DeploymentConfig $config
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Riverside OS Deployment Manager"
$form.Size = New-Object System.Drawing.Size(820, 805)
$form.StartPosition = "CenterScreen"
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Riverside OS Deployment Manager"
$title.Font = New-Object System.Drawing.Font("Segoe UI", 16, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(20, 16)
$title.Size = New-Object System.Drawing.Size(760, 34)
$form.Controls.Add($title)

$roleGroup = New-Object System.Windows.Forms.GroupBox
$roleGroup.Text = "Install this station as"
$roleGroup.Location = New-Object System.Drawing.Point(20, 60)
$roleGroup.Size = New-Object System.Drawing.Size(760, 74)
$form.Controls.Add($roleGroup)

$serverRadio = New-Object System.Windows.Forms.RadioButton
$serverRadio.Text = "Backoffice / Server"
$serverRadio.Location = New-Object System.Drawing.Point(18, 30)
$serverRadio.Size = New-Object System.Drawing.Size(180, 28)
$serverRadio.Checked = $true
$roleGroup.Controls.Add($serverRadio)

$registerRadio = New-Object System.Windows.Forms.RadioButton
$registerRadio.Text = "Register #1"
$registerRadio.Location = New-Object System.Drawing.Point(230, 30)
$registerRadio.Size = New-Object System.Drawing.Size(140, 28)
$roleGroup.Controls.Add($registerRadio)

$backOfficeRadio = New-Object System.Windows.Forms.RadioButton
$backOfficeRadio.Text = "Back Office Workstation"
$backOfficeRadio.Location = New-Object System.Drawing.Point(410, 30)
$backOfficeRadio.Size = New-Object System.Drawing.Size(220, 28)
$roleGroup.Controls.Add($backOfficeRadio)

$serverGroup = New-Object System.Windows.Forms.GroupBox
$serverGroup.Text = "Server settings"
$serverGroup.Location = New-Object System.Drawing.Point(20, 145)
$serverGroup.Size = New-Object System.Drawing.Size(370, 230)
$form.Controls.Add($serverGroup)

$serverAddressLabel = New-Object System.Windows.Forms.Label
$serverAddressLabel.Text = "Server IP or computer name"
$serverAddressLabel.Location = New-Object System.Drawing.Point(16, 32)
$serverAddressLabel.Size = New-Object System.Drawing.Size(330, 22)
$serverGroup.Controls.Add($serverAddressLabel)

$serverAddressText = New-Object System.Windows.Forms.TextBox
$serverAddressText.Location = New-Object System.Drawing.Point(16, 56)
$serverAddressText.Size = New-Object System.Drawing.Size(330, 28)
$serverGroup.Controls.Add($serverAddressText)

$psqlPathLabel = New-Object System.Windows.Forms.Label
$psqlPathLabel.Text = "PostgreSQL psql.exe"
$psqlPathLabel.Location = New-Object System.Drawing.Point(16, 90)
$psqlPathLabel.Size = New-Object System.Drawing.Size(330, 22)
$serverGroup.Controls.Add($psqlPathLabel)

$psqlPathText = New-Object System.Windows.Forms.TextBox
$psqlPathText.Location = New-Object System.Drawing.Point(16, 114)
$psqlPathText.Size = New-Object System.Drawing.Size(330, 28)
$serverGroup.Controls.Add($psqlPathText)

$postgresPasswordLabel = New-Object System.Windows.Forms.Label
$postgresPasswordLabel.Text = "PostgreSQL admin password"
$postgresPasswordLabel.Location = New-Object System.Drawing.Point(16, 148)
$postgresPasswordLabel.Size = New-Object System.Drawing.Size(170, 22)
$serverGroup.Controls.Add($postgresPasswordLabel)

$postgresPasswordText = New-Object System.Windows.Forms.TextBox
$postgresPasswordText.Location = New-Object System.Drawing.Point(16, 172)
$postgresPasswordText.Size = New-Object System.Drawing.Size(150, 28)
$postgresPasswordText.UseSystemPasswordChar = $true
$serverGroup.Controls.Add($postgresPasswordText)

$appPasswordLabel = New-Object System.Windows.Forms.Label
$appPasswordLabel.Text = "Riverside DB password"
$appPasswordLabel.Location = New-Object System.Drawing.Point(196, 148)
$appPasswordLabel.Size = New-Object System.Drawing.Size(150, 22)
$serverGroup.Controls.Add($appPasswordLabel)

$appPasswordText = New-Object System.Windows.Forms.TextBox
$appPasswordText.Location = New-Object System.Drawing.Point(196, 172)
$appPasswordText.Size = New-Object System.Drawing.Size(150, 28)
$appPasswordText.UseSystemPasswordChar = $true
$serverGroup.Controls.Add($appPasswordText)

$secretText = New-Object System.Windows.Forms.TextBox
$secretText.Location = New-Object System.Drawing.Point(16, 202)
$secretText.Size = New-Object System.Drawing.Size(330, 28)
$secretText.Visible = $false
$serverGroup.Controls.Add($secretText)

$workstationGroup = New-Object System.Windows.Forms.GroupBox
$workstationGroup.Text = "Workstation settings"
$workstationGroup.Location = New-Object System.Drawing.Point(410, 145)
$workstationGroup.Size = New-Object System.Drawing.Size(370, 230)
$form.Controls.Add($workstationGroup)

$apiBaseLabel = New-Object System.Windows.Forms.Label
$apiBaseLabel.Text = "Server address"
$apiBaseLabel.Location = New-Object System.Drawing.Point(16, 32)
$apiBaseLabel.Size = New-Object System.Drawing.Size(330, 22)
$workstationGroup.Controls.Add($apiBaseLabel)

$apiBaseText = New-Object System.Windows.Forms.TextBox
$apiBaseText.Location = New-Object System.Drawing.Point(16, 56)
$apiBaseText.Size = New-Object System.Drawing.Size(330, 28)
$workstationGroup.Controls.Add($apiBaseText)

$stationLabelLabel = New-Object System.Windows.Forms.Label
$stationLabelLabel.Text = "Station label"
$stationLabelLabel.Location = New-Object System.Drawing.Point(16, 90)
$stationLabelLabel.Size = New-Object System.Drawing.Size(150, 22)
$workstationGroup.Controls.Add($stationLabelLabel)

$stationLabelText = New-Object System.Windows.Forms.TextBox
$stationLabelText.Location = New-Object System.Drawing.Point(16, 114)
$stationLabelText.Size = New-Object System.Drawing.Size(150, 28)
$workstationGroup.Controls.Add($stationLabelText)

$cashDrawerCheck = New-Object System.Windows.Forms.CheckBox
$cashDrawerCheck.Text = "Cash drawer"
$cashDrawerCheck.Location = New-Object System.Drawing.Point(196, 114)
$cashDrawerCheck.Size = New-Object System.Drawing.Size(130, 28)
$workstationGroup.Controls.Add($cashDrawerCheck)

$receiptModeLabel = New-Object System.Windows.Forms.Label
$receiptModeLabel.Text = "Receipt printer"
$receiptModeLabel.Location = New-Object System.Drawing.Point(16, 148)
$receiptModeLabel.Size = New-Object System.Drawing.Size(150, 22)
$workstationGroup.Controls.Add($receiptModeLabel)

$receiptModeCombo = New-Object System.Windows.Forms.ComboBox
$receiptModeCombo.DropDownStyle = "DropDownList"
$receiptModeCombo.Items.Add("Network IP") | Out-Null
$receiptModeCombo.Items.Add("Installed printer") | Out-Null
$receiptModeCombo.Location = New-Object System.Drawing.Point(16, 172)
$receiptModeCombo.Size = New-Object System.Drawing.Size(150, 28)
$workstationGroup.Controls.Add($receiptModeCombo)

$receiptIpText = New-Object System.Windows.Forms.TextBox
$receiptIpText.Location = New-Object System.Drawing.Point(196, 172)
$receiptIpText.Size = New-Object System.Drawing.Size(105, 28)
$workstationGroup.Controls.Add($receiptIpText)

$receiptPortText = New-Object System.Windows.Forms.TextBox
$receiptPortText.Location = New-Object System.Drawing.Point(306, 172)
$receiptPortText.Size = New-Object System.Drawing.Size(40, 28)
$workstationGroup.Controls.Add($receiptPortText)

$receiptPrinterCombo = New-Object System.Windows.Forms.ComboBox
$receiptPrinterCombo.DropDownStyle = "DropDownList"
$receiptPrinterCombo.Location = New-Object System.Drawing.Point(196, 172)
$receiptPrinterCombo.Size = New-Object System.Drawing.Size(150, 28)
$receiptPrinterCombo.Visible = $false
$workstationGroup.Controls.Add($receiptPrinterCombo)

$tagPrinterCombo = New-Object System.Windows.Forms.ComboBox
$tagPrinterCombo.DropDownStyle = "DropDownList"
$tagPrinterCombo.Location = New-Object System.Drawing.Point(16, 202)
$tagPrinterCombo.Size = New-Object System.Drawing.Size(150, 28)
$tagPrinterCombo.Visible = $false
$workstationGroup.Controls.Add($tagPrinterCombo)

$reportPrinterCombo = New-Object System.Windows.Forms.ComboBox
$reportPrinterCombo.DropDownStyle = "DropDownList"
$reportPrinterCombo.Location = New-Object System.Drawing.Point(196, 202)
$reportPrinterCombo.Size = New-Object System.Drawing.Size(150, 28)
$reportPrinterCombo.Visible = $false
$workstationGroup.Controls.Add($reportPrinterCombo)

$serverStatusGroup = New-Object System.Windows.Forms.GroupBox
$serverStatusGroup.Text = "Server manager"
$serverStatusGroup.Location = New-Object System.Drawing.Point(20, 385)
$serverStatusGroup.Size = New-Object System.Drawing.Size(760, 112)
$form.Controls.Add($serverStatusGroup)

$serverTaskLabel = New-Object System.Windows.Forms.Label
$serverTaskLabel.Text = "Task"
$serverTaskLabel.Location = New-Object System.Drawing.Point(16, 28)
$serverTaskLabel.Size = New-Object System.Drawing.Size(70, 22)
$serverStatusGroup.Controls.Add($serverTaskLabel)

$serverTaskValue = New-Object System.Windows.Forms.Label
$serverTaskValue.Text = "not checked"
$serverTaskValue.Location = New-Object System.Drawing.Point(90, 28)
$serverTaskValue.Size = New-Object System.Drawing.Size(120, 22)
$serverStatusGroup.Controls.Add($serverTaskValue)

$serverInstalledLabel = New-Object System.Windows.Forms.Label
$serverInstalledLabel.Text = "Installed"
$serverInstalledLabel.Location = New-Object System.Drawing.Point(220, 28)
$serverInstalledLabel.Size = New-Object System.Drawing.Size(70, 22)
$serverStatusGroup.Controls.Add($serverInstalledLabel)

$serverInstalledValue = New-Object System.Windows.Forms.Label
$serverInstalledValue.Text = "not checked"
$serverInstalledValue.Location = New-Object System.Drawing.Point(295, 28)
$serverInstalledValue.Size = New-Object System.Drawing.Size(110, 22)
$serverStatusGroup.Controls.Add($serverInstalledValue)

$serverPackageLabel = New-Object System.Windows.Forms.Label
$serverPackageLabel.Text = "Package"
$serverPackageLabel.Location = New-Object System.Drawing.Point(415, 28)
$serverPackageLabel.Size = New-Object System.Drawing.Size(70, 22)
$serverStatusGroup.Controls.Add($serverPackageLabel)

$serverPackageValue = New-Object System.Windows.Forms.Label
$serverPackageValue.Text = "not checked"
$serverPackageValue.Location = New-Object System.Drawing.Point(490, 28)
$serverPackageValue.Size = New-Object System.Drawing.Size(110, 22)
$serverStatusGroup.Controls.Add($serverPackageValue)

$serverApiLabel = New-Object System.Windows.Forms.Label
$serverApiLabel.Text = "API"
$serverApiLabel.Location = New-Object System.Drawing.Point(16, 56)
$serverApiLabel.Size = New-Object System.Drawing.Size(70, 22)
$serverStatusGroup.Controls.Add($serverApiLabel)

$serverApiValue = New-Object System.Windows.Forms.Label
$serverApiValue.Text = "not checked"
$serverApiValue.Location = New-Object System.Drawing.Point(90, 56)
$serverApiValue.Size = New-Object System.Drawing.Size(280, 22)
$serverStatusGroup.Controls.Add($serverApiValue)

$serverVerdictValue = New-Object System.Windows.Forms.Label
$serverVerdictValue.Text = "Use Refresh Server Status before server update or repair."
$serverVerdictValue.Location = New-Object System.Drawing.Point(16, 82)
$serverVerdictValue.Size = New-Object System.Drawing.Size(560, 22)
$serverStatusGroup.Controls.Add($serverVerdictValue)

$refreshServerButton = New-Object System.Windows.Forms.Button
$refreshServerButton.Text = "Refresh Server Status"
$refreshServerButton.Location = New-Object System.Drawing.Point(600, 24)
$refreshServerButton.Size = New-Object System.Drawing.Size(145, 28)
$serverStatusGroup.Controls.Add($refreshServerButton)

$startServerButton = New-Object System.Windows.Forms.Button
$startServerButton.Text = "Start Server"
$startServerButton.Location = New-Object System.Drawing.Point(600, 54)
$startServerButton.Size = New-Object System.Drawing.Size(145, 28)
$serverStatusGroup.Controls.Add($startServerButton)

$restartServerButton = New-Object System.Windows.Forms.Button
$restartServerButton.Text = "Restart Server"
$restartServerButton.Location = New-Object System.Drawing.Point(600, 84)
$restartServerButton.Size = New-Object System.Drawing.Size(145, 28)
$serverStatusGroup.Controls.Add($restartServerButton)

$openLogsButton = New-Object System.Windows.Forms.Button
$openLogsButton.Text = "Open Logs"
$openLogsButton.Location = New-Object System.Drawing.Point(475, 54)
$openLogsButton.Size = New-Object System.Drawing.Size(115, 28)
$serverStatusGroup.Controls.Add($openLogsButton)

$checkButton = New-Object System.Windows.Forms.Button
$checkButton.Text = "Check Package"
$checkButton.Location = New-Object System.Drawing.Point(20, 510)
$checkButton.Size = New-Object System.Drawing.Size(120, 42)
$form.Controls.Add($checkButton)

$installButton = New-Object System.Windows.Forms.Button
$installButton.Text = "Install"
$installButton.Location = New-Object System.Drawing.Point(150, 510)
$installButton.Size = New-Object System.Drawing.Size(120, 42)
$form.Controls.Add($installButton)

$updateButton = New-Object System.Windows.Forms.Button
$updateButton.Text = "Update This PC"
$updateButton.Location = New-Object System.Drawing.Point(280, 510)
$updateButton.Size = New-Object System.Drawing.Size(120, 42)
$form.Controls.Add($updateButton)

$repairButton = New-Object System.Windows.Forms.Button
$repairButton.Text = "Repair"
$repairButton.Location = New-Object System.Drawing.Point(410, 510)
$repairButton.Size = New-Object System.Drawing.Size(120, 42)
$form.Controls.Add($repairButton)

$uninstallButton = New-Object System.Windows.Forms.Button
$uninstallButton.Text = "Uninstall"
$uninstallButton.Location = New-Object System.Drawing.Point(540, 510)
$uninstallButton.Size = New-Object System.Drawing.Size(120, 42)
$form.Controls.Add($uninstallButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = "Close"
$closeButton.Location = New-Object System.Drawing.Point(670, 510)
$closeButton.Size = New-Object System.Drawing.Size(110, 42)
$form.Controls.Add($closeButton)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true
$logBox.ScrollBars = "Vertical"
$logBox.ReadOnly = $true
$logBox.Location = New-Object System.Drawing.Point(20, 565)
$logBox.Size = New-Object System.Drawing.Size(760, 190)
$form.Controls.Add($logBox)

$printerNames = Get-InstalledPrinterNames
foreach ($printer in $printerNames) {
  $receiptPrinterCombo.Items.Add($printer) | Out-Null
  $tagPrinterCombo.Items.Add($printer) | Out-Null
  $reportPrinterCombo.Items.Add($printer) | Out-Null
}
if ($receiptPrinterCombo.Items.Count -gt 0) {
  $receiptPrinterCombo.SelectedIndex = 0
  $tagPrinterCombo.SelectedIndex = 0
  $reportPrinterCombo.SelectedIndex = 0
}

$receiptModeCombo.Add_SelectedIndexChanged({
  $systemMode = $receiptModeCombo.SelectedItem -eq "Installed printer"
  $receiptPrinterCombo.Visible = $systemMode
  $receiptIpText.Visible = -not $systemMode
  $receiptPortText.Visible = -not $systemMode
})

$serverRadio.Add_CheckedChanged({ if ($serverRadio.Checked) { Set-RoleDefaults } })
$registerRadio.Add_CheckedChanged({ if ($registerRadio.Checked) { Set-RoleDefaults } })
$backOfficeRadio.Add_CheckedChanged({ if ($backOfficeRadio.Checked) { Set-RoleDefaults } })

$refreshServerButton.Add_Click({
  Add-Log "Refreshing server status..."
  Refresh-ServerManagerStatus
})

$startServerButton.Add_Click({
  try {
    Start-RiversideServerFromManager
  } catch {
    Add-Log "Start Server failed: $($_.Exception.Message)"
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Start Server failed", "OK", "Error") | Out-Null
  }
})

$restartServerButton.Add_Click({
  try {
    Restart-RiversideServerFromManager
  } catch {
    Add-Log "Restart Server failed: $($_.Exception.Message)"
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Restart Server failed", "OK", "Error") | Out-Null
  }
})

$openLogsButton.Add_Click({
  try {
    Open-RiversideServerLogs
  } catch {
    Add-Log "Open Logs failed: $($_.Exception.Message)"
  }
})

$serverAddressText.Add_TextChanged({
  if ($serverAddressText.Text.Trim() -and -not $serverRadio.Checked) {
    $apiBaseText.Text = Get-ServerApiBaseFromField
  }
})

$checkButton.Add_Click({
  try {
    $logBox.Clear()
    Add-Log "Checking package..."

    if (-not (Test-Path $configPath) -and -not (Test-Path $configExamplePath)) {
      throw "Missing config file. The package needs riverside-deployment.config.json or riverside-deployment.config.example.json."
    }
    if (-not (Test-Path $configPath)) {
      Add-Log "Config file will be created from the package template during install."
    }
    if ($serverRadio.Checked) {
      foreach ($required in @("install-server.ps1", "install-register.ps1", "repair-bootstrap-admin.ps1", "server\riverside-server.exe", "client-dist", "migrations", "register")) {
        if (-not (Test-PackageFile $required)) {
          throw "Missing $required"
        }
      }
      $manifest = Read-PackageManifest
      if ($manifest) {
        Add-Log "Package build: $($manifest.releaseVersion) / $($manifest.sourceGitShort)"
      } else {
        Add-Log "Warning: package build manifest is missing. Use a rebuilt full deployment package."
      }
      $psqlPath = $psqlPathText.Text.Trim()
      if (-not $psqlPath -or -not (Test-Path $psqlPath)) {
        if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
          Add-Log "PostgreSQL was not found. Install will offer to install PostgreSQL 18."
        } else {
          throw "PostgreSQL psql.exe was not found. Install PostgreSQL or correct the psql.exe path."
        }
      }
      if (Test-PlaceholderSecret $postgresPasswordText.Text) {
        Add-Log "PostgreSQL admin password is blank or placeholder. If PostgreSQL is installed by this manager, one will be generated."
      }
      Add-Log "Server and desktop app package files found."
      if ($psqlPath -and (Test-Path $psqlPath)) {
        Add-Log "PostgreSQL command found."
      }
    } else {
      foreach ($required in @("install-register.ps1", "register")) {
        if (-not (Test-PackageFile $required)) {
          throw "Missing $required"
        }
      }
      Add-Log "Workstation package files found."
      Add-Log "Server address: $($apiBaseText.Text)"
      if (Test-HttpReady $apiBaseText.Text.Trim()) {
        Add-Log "Server responded."
      } else {
        Add-Log "Warning: server did not respond yet. You can still install station settings, but verify the Server is installed and reachable."
      }
    }
    Add-Log "Check complete."
  } catch {
    Add-Log "Check failed: $($_.Exception.Message)"
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Check failed", "OK", "Error") | Out-Null
  }
})

function Invoke-SelectedLifecycleAction([string]$Action) {
  if ($serverRadio.Checked -and ($Action -eq "Install" -or $Action -eq "Update" -or $Action -eq "Repair")) {
    Ensure-PostgreSqlAvailableForServer
  }

  Save-FormToConfig
  Add-Log "Saved deployment settings."

  if ($Action -eq "Install" -or $Action -eq "Update") {
    if ($serverRadio.Checked) {
      Add-Log "$Action This Backoffice / Server PC..."
      Invoke-Installer "install-server.ps1"
      Invoke-Installer "repair-bootstrap-admin.ps1"
      Add-Log "Server $($Action.ToLowerInvariant()) complete."
      Add-Log "$Action Backoffice desktop app..."
      Invoke-Installer "install-register.ps1"
      Add-Log "Backoffice desktop app $($Action.ToLowerInvariant()) complete."
      Refresh-ServerManagerStatus
    } elseif ($registerRadio.Checked) {
      Add-Log "$Action Register #1..."
      Invoke-Installer "install-register.ps1"
      Add-Log "Register $($Action.ToLowerInvariant()) complete."
    } else {
      Add-Log "$Action Back Office workstation..."
      Invoke-Installer "install-register.ps1"
      Add-Log "Back Office workstation $($Action.ToLowerInvariant()) complete."
    }
    return
  }

  if ($Action -eq "Repair") {
    if ($serverRadio.Checked) {
      Add-Log "Repairing This Backoffice / Server PC..."
      Invoke-Installer "install-server.ps1"
      Invoke-Installer "repair-bootstrap-admin.ps1"
      Add-Log "Repairing Backoffice desktop app..."
      Invoke-Installer "install-register.ps1"
      Add-Log "Backoffice / Server repair complete."
      Refresh-ServerManagerStatus
    } else {
      Add-Log "Repairing workstation settings..."
      Invoke-Installer "install-register.ps1" @("-SkipAppInstall", "-NoLaunch")
      Add-Log "Workstation settings repair complete."
    }
    return
  }

  if ($Action -eq "Uninstall") {
    if ($serverRadio.Checked) {
      $choice = [System.Windows.Forms.MessageBox]::Show(
        "This removes the Riverside server service, firewall rule, and app files from this PC. The database, backups, and logs are kept. Continue?",
        "Uninstall Backoffice / Server",
        "YesNo",
        "Warning"
      )
      if ($choice -ne "Yes") {
        Add-Log "Server uninstall cancelled."
        return
      }
      Add-Log "Removing Riverside server service and app files..."
      Uninstall-RiversideServer
      Add-Log "Server app removal complete. Database, backups, and logs were kept."
    } else {
      $choice = [System.Windows.Forms.MessageBox]::Show(
        "This removes the Riverside desktop app and station settings from this workstation. Continue?",
        "Uninstall Riverside workstation",
        "YesNo",
        "Warning"
      )
      if ($choice -ne "Yes") {
        Add-Log "Workstation uninstall cancelled."
        return
      }
      Add-Log "Removing Riverside desktop app and station settings..."
      Uninstall-RiversideDesktopApp
      Add-Log "Workstation uninstall complete."
    }
  }
}

function Invoke-ButtonAction($Button, [string]$Action) {
  try {
    $Button.Enabled = $false
    Invoke-SelectedLifecycleAction $Action
    [System.Windows.Forms.MessageBox]::Show("Riverside OS $($Action.ToLowerInvariant()) complete.", "$Action complete", "OK", "Information") | Out-Null
  } catch {
    Add-Log "$Action failed: $($_.Exception.Message)"
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "$Action failed", "OK", "Error") | Out-Null
  } finally {
    $Button.Enabled = $true
  }
}

$installButton.Add_Click({ Invoke-ButtonAction $installButton "Install" })
$updateButton.Add_Click({ Invoke-ButtonAction $updateButton "Update" })
$repairButton.Add_Click({ Invoke-ButtonAction $repairButton "Repair" })
$uninstallButton.Add_Click({ Invoke-ButtonAction $uninstallButton "Uninstall" })

$closeButton.Add_Click({ $form.Close() })

try {
  Load-ConfigIntoForm
  if (-not $stationLabelText.Text) {
    Set-RoleDefaults
  }
  Set-RoleControlState
  Refresh-ServerManagerStatus
  Add-Log "Ready. Choose this station type, check package, then install, update, or repair."
} catch {
  Add-Log "Startup warning: $($_.Exception.Message)"
}

[void]$form.ShowDialog()
