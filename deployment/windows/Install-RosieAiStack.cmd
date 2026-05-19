@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-RosieAiStack.ps1" %*
pause
