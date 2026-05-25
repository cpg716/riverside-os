@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Export-IntegrationCredentials.ps1" %*
endlocal
