@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0reset-postgres-password.ps1" %*
pause
