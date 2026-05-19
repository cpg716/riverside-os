@echo off
setlocal
if exist "%~dp0RiversideOS-Deployment-Manager.exe" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~dp0RiversideOS-Deployment-Manager.exe' -Verb RunAs"
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-RiversideDeployment.ps1"
)
if errorlevel 1 pause

