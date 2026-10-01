@echo off
rem Запуск бота с автоматическим перезапуском при падении. Запускается задачей
rem Планировщика PriemkaBot; вручную — только для проверки.
chcp 65001 >nul 2>&1
cd /d "%~dp0"
set "NODE_EXTRA_CA_CERTS=%~dp0ca.pem"
rem Бот знает, что его перезапустят: может сам завершиться ночью для переноса журнала.
set "PRIEMKA_SUPERVISED=1"
rem Если в сети обязателен прокси без доменной авторизации (нужен Node.js 24):
rem set "NODE_USE_ENV_PROXY=1"
rem set "HTTPS_PROXY=http://адрес-прокси:порт"
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"

:loop
rem Журнал больше 10 МБ — в архив: bot.1.log … bot.3.log, самый старый удаляется.
rem Переименовать можно только здесь, между запусками: пока бот работает, файл занят.
rem Если не получилось — не страшно, бот запускается всё равно.
set "LOGSIZE=0"
if exist "%~dp0bot.log" for %%A in ("%~dp0bot.log") do set "LOGSIZE=%%~zA"
if "%LOGSIZE%"=="" set "LOGSIZE=0"
if %LOGSIZE% GTR 10485760 (
  del "%~dp0bot.3.log" >nul 2>&1
  if exist "%~dp0bot.2.log" ren "%~dp0bot.2.log" bot.3.log >nul 2>&1
  if exist "%~dp0bot.1.log" ren "%~dp0bot.1.log" bot.2.log >nul 2>&1
  ren "%~dp0bot.log" bot.1.log >nul 2>&1
)
echo ===== запуск %date% %time% =====>>"%~dp0bot.log"
"%NODE%" --env-file=.env bot.js >>"%~dp0bot.log" 2>&1
rem timeout без консоли (под Планировщиком) сразу завершается, поэтому пауза через ping
ping -n 11 127.0.0.1 >nul
goto loop
