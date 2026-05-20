@echo off
REM Launch GitGood with DevTools open for debugging
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
)
echo Launching GitGood in DEBUG mode (DevTools open)...
call npx electron . --dev
pause
