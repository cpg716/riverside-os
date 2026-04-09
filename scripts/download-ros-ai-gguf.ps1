# Download pinned ROS-AI GGUF (tools/ros-gemma/MODEL_PIN.json). Run from repo root in PowerShell.
# Optional: $env:ROS_AI_GGUF_DIR, $env:HF_TOKEN

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$PinPath = Join-Path $Root "tools/ros-gemma/MODEL_PIN.json"
$OutDir = if ($env:ROS_AI_GGUF_DIR) { $env:ROS_AI_GGUF_DIR } else { Join-Path $Root "tools/ros-gemma/models" }
$Pin = Get-Content -Raw -Encoding UTF8 $PinPath | ConvertFrom-Json
$Dest = Join-Path $OutDir $Pin.filename
$Url = "https://huggingface.co/$($Pin.huggingface_model_id)/resolve/$($Pin.revision)/$($Pin.filename)"

Write-Host "URL:  $Url"
Write-Host "Dest: $Dest"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (Test-Path $Dest) {
    $hash = (Get-FileHash -Algorithm SHA256 -Path $Dest).Hash.ToLowerInvariant()
    if ($hash -eq $Pin.sha256) {
        Write-Host "OK — file exists and matches MODEL_PIN.json"
        exit 0
    }
    Write-Host "Hash mismatch; re-downloading..."
    Remove-Item -Force $Dest
}

$Headers = @{}
if ($env:HF_TOKEN) { $Headers["Authorization"] = "Bearer $($env:HF_TOKEN)" }

Invoke-WebRequest -Uri $Url -OutFile $Dest -Headers $Headers

$got = (Get-FileHash -Algorithm SHA256 -Path $Dest).Hash.ToLowerInvariant()
if ($got -ne $Pin.sha256) {
    Write-Error "SHA256 mismatch: expected $($Pin.sha256) got $got"
    Remove-Item -Force $Dest
    exit 1
}
Write-Host "OK — matches MODEL_PIN.json. Start llama-server with -m `"$Dest`""
