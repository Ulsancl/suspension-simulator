@echo off
chcp 65001 >nul
cd /d "%~dp0"
curl.exe -fsS http://127.0.0.1:5173/ 2>nul | findstr /c:"Suspension Lab" >nul
if not errorlevel 1 (
  start "" "http://127.0.0.1:5173/"
  exit /b 0
)
if not exist node_modules (
  call npm.cmd ci
  if errorlevel 1 exit /b 1
)
call npm.cmd run dev -- --port 5173 --strictPort --open
