@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not in PATH. Install LTS from https://nodejs.org/
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
  echo  Edit ".env" and set SQL_CONNECTION_STRING to your Counterpoint company database.
  echo  You do NOT need ROS or COUNTERPOINT_SYNC_TOKEN for this step.
  echo.
  pause
  exit /b 0
)

echo Probing Counterpoint schema ^(read-only^). Report: counterpoint-schema-report.txt ^(unless CP_DISCOVER_OUTPUT=0^).
node index.mjs discover
if errorlevel 1 (
  echo.
  echo Discover failed ^(check SQL_CONNECTION_STRING and database name^).
  pause
)
