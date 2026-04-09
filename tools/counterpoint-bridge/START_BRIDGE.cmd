@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed or not in PATH.
  echo  Install **LTS** from https://nodejs.org/  then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing bridge dependencies ^(one-time^)...
  call npm install --omit=dev
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo Created ".env" from the template.
  )
  echo.
  echo  EDIT ".env" in this folder:
  echo    - SQL_CONNECTION_STRING  ^(Counterpoint SQL Server^)
  echo    - ROS_BASE_URL           ^(e.g. http://192.168.1.50:3000^)
  echo    - COUNTERPOINT_SYNC_TOKEN ^(same secret as the ROS server^)
  echo.
  echo  Save the file, then double-click START_BRIDGE.cmd again.
  echo.
  pause
  exit /b 0
)

echo Starting Counterpoint - Riverside OS sync ^(Ctrl+C to stop^)...
node index.mjs
if errorlevel 1 (
  echo.
  echo Bridge exited with an error.
  pause
)
