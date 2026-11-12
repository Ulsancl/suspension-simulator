@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  call npm.cmd ci
  if errorlevel 1 exit /b 1
)
call npm.cmd run dev -- --port 5173 --strictPort --open
