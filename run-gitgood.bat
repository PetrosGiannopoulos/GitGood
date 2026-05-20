@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing dependencies for the first time...
  echo This will take a minute or two.
  call npm install
  if errorlevel 1 (
    echo.
    echo Install failed. Please ensure Node.js 18+ is installed: https://nodejs.org
    pause
    exit /b 1
  )
)
call npm start
