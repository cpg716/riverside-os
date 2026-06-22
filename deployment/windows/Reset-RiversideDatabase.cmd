@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0reset-riverside-database.ps1" -ConfigPath "%~dp0riverside-deployment.config.json" -StartFresh
endlocal
