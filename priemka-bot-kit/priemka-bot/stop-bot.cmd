@echo off
chcp 65001 >nul
rem Остановка бота. Запускать от имени администратора.
rem Завершает задачу Планировщика и только тот node.exe, что запущен с bot.js,
rem — другие программы на Node.js не затрагиваются.
schtasks /end /tn PriemkaBot >nul 2>&1
powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Where-Object { $_.CommandLine -like '*--env-file*bot.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo   Бот остановлен. Запустить снова: schtasks /run /tn PriemkaBot
pause
