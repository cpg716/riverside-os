[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
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

if ($PSScriptRoot) {
  $packageRoot = $PSScriptRoot
} else {
  $packageRoot = Split-Path -Parent $PSCommandPath
}
if (-not $packageRoot) {
  $packageRoot = (Get-Location).Path
}
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
  }
}

function Set-RoleDefaults {
  if ($serverRadio.Checked) {
    $stationLabelText.Text = "Backoffice / Server"
    $cashDrawerCheck.Checked = $false
  } elseif ($registerRadio.Checked) {
    $stationLabelText.Text = "Register #1"
    $cashDrawerCheck.Checked = $true
  } else {
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

  $serverAddress = $serverAddressText.Text.Trim()
  if (-not $serverAddress) {
    $serverAddress = Get-PrimaryIpAddress
  }

  $config.server.httpBind = "0.0.0.0:3000"
  $config.server.corsOrigins = @(
    "http://$serverAddress`:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3000"
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

  if ($serverRadio.Checked) {
    $config.register.apiBase = "http://127.0.0.1:3000"
    $config.register.stationLabel = "Backoffice / Server"
    $config.register.cashDrawerEnabled = $false
  } else {
    $config.register.apiBase = $apiBaseText.Text.Trim()
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
$form.Size = New-Object System.Drawing.Size(820, 700)
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

$checkButton = New-Object System.Windows.Forms.Button
$checkButton.Text = "Check"
$checkButton.Location = New-Object System.Drawing.Point(20, 390)
$checkButton.Size = New-Object System.Drawing.Size(120, 42)
$form.Controls.Add($checkButton)

$installButton = New-Object System.Windows.Forms.Button
$installButton.Text = "Install"
$installButton.Location = New-Object System.Drawing.Point(150, 390)
$installButton.Size = New-Object System.Drawing.Size(120, 42)
$form.Controls.Add($installButton)

$updateButton = New-Object System.Windows.Forms.Button
$updateButton.Text = "Update"
$updateButton.Location = New-Object System.Drawing.Point(280, 390)
$updateButton.Size = New-Object System.Drawing.Size(120, 42)
$form.Controls.Add($updateButton)

$repairButton = New-Object System.Windows.Forms.Button
$repairButton.Text = "Repair"
$repairButton.Location = New-Object System.Drawing.Point(410, 390)
$repairButton.Size = New-Object System.Drawing.Size(120, 42)
$form.Controls.Add($repairButton)

$uninstallButton = New-Object System.Windows.Forms.Button
$uninstallButton.Text = "Uninstall"
$uninstallButton.Location = New-Object System.Drawing.Point(540, 390)
$uninstallButton.Size = New-Object System.Drawing.Size(120, 42)
$form.Controls.Add($uninstallButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = "Close"
$closeButton.Location = New-Object System.Drawing.Point(670, 390)
$closeButton.Size = New-Object System.Drawing.Size(110, 42)
$form.Controls.Add($closeButton)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true
$logBox.ScrollBars = "Vertical"
$logBox.ReadOnly = $true
$logBox.Location = New-Object System.Drawing.Point(20, 445)
$logBox.Size = New-Object System.Drawing.Size(760, 200)
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

$serverAddressText.Add_TextChanged({
  if ($serverAddressText.Text.Trim()) {
    $apiBaseText.Text = "http://$($serverAddressText.Text.Trim()):3000"
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
      Add-Log "$Action Backoffice / Server..."
      Invoke-Installer "install-server.ps1"
      Invoke-Installer "repair-bootstrap-admin.ps1"
      Add-Log "Server $($Action.ToLowerInvariant()) complete."
      Add-Log "$Action Backoffice desktop app..."
      Invoke-Installer "install-register.ps1"
      Add-Log "Backoffice desktop app $($Action.ToLowerInvariant()) complete."
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
      Add-Log "Repairing Backoffice / Server..."
      Invoke-Installer "install-server.ps1"
      Invoke-Installer "repair-bootstrap-admin.ps1"
      Add-Log "Repairing Backoffice desktop app..."
      Invoke-Installer "install-register.ps1"
      Add-Log "Backoffice / Server repair complete."
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
  Add-Log "Ready. Choose this station type, check, then install."
} catch {
  Add-Log "Startup warning: $($_.Exception.Message)"
}

[void]$form.ShowDialog()
