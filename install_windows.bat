@echo off
setlocal
chcp 65001 >nul
title WB Ozon Checker - install
echo.
echo ============================================================
echo   WB Ozon Checker v27 - dependency installer
echo ============================================================
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.10+ from https://python.org
    echo Make sure to tick "Add Python to PATH" during installation.
    pause
    exit /b 1
)

python --version
echo.
echo Upgrading pip...
python -m pip install --upgrade pip
if errorlevel 1 (
    echo [ERROR] pip upgrade failed. Check your internet connection.
    pause
    exit /b 1
)

echo.
echo Installing Python packages from requirements.txt ...
python -m pip install -U -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Failed to install Python packages.
    pause
    exit /b 1
)

echo.
echo Installing Chromium for Playwright (about 130 MB) ...
python -m playwright install chromium
if errorlevel 1 (
    echo [WARN] Chromium install failed. Browser-based modes will not work,
    echo        but HTTP-only modes will still run.
)

echo.
echo ============================================================
echo   Verifying critical Ozon dependency: curl_cffi
echo ============================================================
python -c "from curl_cffi import requests; print('  curl_cffi OK -', requests.__name__)" 2>nul
if errorlevel 1 (
    echo [WARN] curl_cffi import failed - reinstalling explicitly...
    python -m pip install -U --force-reinstall curl_cffi
    python -c "from curl_cffi import requests; print('  curl_cffi OK after reinstall')" 2>nul
    if errorlevel 1 (
        echo [ERROR] curl_cffi still broken. Ozon parser may not work.
        echo         Try manually: pip install --force-reinstall curl_cffi
    )
)

echo.
echo ============================================================
echo   Installation finished. Now double-click run_windows.bat
echo ============================================================
pause
endlocal
