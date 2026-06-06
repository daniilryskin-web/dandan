@echo off
setlocal
chcp 65001 >nul
title WB Ozon Checker v27.1
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Run install_windows.bat first.
    pause
    exit /b 1
)

set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
set PYTHONUNBUFFERED=1

echo Starting WB+Ozon Checker v27.1 ...
echo Log file: last_run.log
echo.

python wb_checker.py > last_run.log 2>&1
set RC=%ERRORLEVEL%

if %RC% NEQ 0 (
    echo.
    echo [ERROR] Program exited with code %RC%.
    echo Showing last 40 lines of log:
    echo ----------------------------------------
    powershell -NoProfile -Command "Get-Content last_run.log -Tail 40"
    echo ----------------------------------------
    echo Full log saved in last_run.log
    pause
)
endlocal
