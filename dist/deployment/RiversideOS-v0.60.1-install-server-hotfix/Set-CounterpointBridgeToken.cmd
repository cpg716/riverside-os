@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-counterpoint-bridge-token.ps1"
pause
