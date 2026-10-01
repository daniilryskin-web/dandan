@echo off
rem Запуск бота с автоматическим перезапуском при падении. Запускается задачей
rem Планировщика PriemkaBot; вручную — только для проверки.
chcp 65001 >nul 2>&1
cd /d "%~dp0"
set "NODE_EXTRA_CA_CERTS=%~dp0ca.pem"
rem Если в сети обязателен прокси без доменной авторизации (нужен Node.js 24):
rem set "NODE_USE_ENV_PROXY=1"
rem set "HTTPS_PROXY=http://адрес-прокси:порт"
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"

:loop
echo ===== запуск %date% %time% =====>>"%~dp0bot.log"
"%NODE%" --env-file=.env bot.js >>"%~dp0bot.log" 2>&1
rem timeout без консоли (под Планировщиком) сразу завершается, поэтому пауза через ping
ping -n 11 127.0.0.1 >nul
goto loop
