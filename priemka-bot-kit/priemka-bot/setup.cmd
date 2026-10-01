@echo off
chcp 65001 >nul
rem ============================================================================
rem  setup.cmd — установка бота приёмки на Windows.
rem
rem  Ничего не скачивает из интернета и ничего не устанавливает.
rem  Что меняет в системе:
rem    - в папке бота создаёт .env (токены), ca.pem (сертификаты, которым доверяет
rem      Windows, — Node.js хранилищем Windows не пользуется) и node-path.txt;
rem    - права на папку бота: полный доступ у SYSTEM и администраторов,
rem      изменение — у NETWORK SERVICE, от имени которой работает бот;
rem      остальные пользователи компьютера доступа не имеют;
rem    - задача Планировщика PriemkaBot: запуск при включении компьютера
rem      от NETWORK SERVICE, без ограничения времени работы;
rem    - отключает сон и гибернацию при питании от сети.
rem
rem  Запуск: правой кнопкой — «Запуск от имени администратора».
rem  Удаление: schtasks /delete /tn PriemkaBot /f
rem ============================================================================

setlocal
set "DIR=%~dp0"
set "DIR=%DIR:~0,-1%"
set "TASK=PriemkaBot"

echo.
echo   Установка бота приёмки
echo   Папка: "%DIR%"
echo.

rem --- права администратора ---------------------------------------------------
whoami /groups | find "S-1-16-12288" >nul
if errorlevel 1 goto :not_admin

rem --- расположение папки -----------------------------------------------------
set "CHK=%DIR:\Users\=%"
if /i not "%CHK%"=="%DIR%" goto :in_profile
set "CHK=%DIR:(=%"
if not "%CHK%"=="%DIR%" goto :bad_path
set "CHK=%DIR:)=%"
if not "%CHK%"=="%DIR%" goto :bad_path
if not exist "%DIR%\bot.js" goto :no_bot
if not exist "%DIR%\access.json" goto :no_access

rem --- Node.js ----------------------------------------------------------------
set "NODE="
if exist "%DIR%\node\node.exe" set "NODE=%DIR%\node\node.exe"
if not defined NODE for /f "delims=" %%p in ('where node.exe 2^>nul') do if not defined NODE set "NODE=%%p"
if not defined NODE goto :no_node
set "CHK=%NODE:\Users\=%"
if /i not "%CHK%"=="%NODE%" goto :node_in_profile

set "NV="
"%NODE%" -v >"%TEMP%\priemka-nv.txt" 2>nul
for /f "usebackq tokens=1 delims=.v" %%v in ("%TEMP%\priemka-nv.txt") do if not defined NV set "NV=%%v"
del "%TEMP%\priemka-nv.txt" >nul 2>&1
if not defined NV goto :node_blocked
if %NV% LSS 22 goto :node_old
>"%DIR%\node-path.txt" echo %NODE%
echo   [ок] Node.js v%NV%: "%NODE%"

rem --- токены -----------------------------------------------------------------
if exist "%DIR%\.env" goto :env_check
if exist "%DIR%\.env.txt" goto :env_txt
echo.
echo   Токены бота передаются отдельно от архива. Вставьте их по очереди:
echo   правый щелчок мыши в этом окне вставляет из буфера обмена.
echo.
set "T1="
set "T2="
set /p "T1=  Токен MAX: "
set /p "T2=  Токен Яндекс.Диска: "
if not defined T1 goto :env_empty
if not defined T2 goto :env_empty
setlocal EnableDelayedExpansion
>"%DIR%\.env" (
  echo MAX_TOKEN=!T1!
  echo YANDEX_DISK_TOKEN=!T2!
)
endlocal
set "T1="
set "T2="
cls
echo.
echo   [ок] Токены записаны в .env
goto :env_done
:env_check
findstr /r /b /c:"MAX_TOKEN=." "%DIR%\.env" >nul || goto :env_bad
findstr /r /b /c:"YANDEX_DISK_TOKEN=." "%DIR%\.env" >nul || goto :env_bad
echo   [ок] .env на месте
:env_done

rem --- сертификат Минцифры ----------------------------------------------------
powershell -NoProfile -NonInteractive -Command "$c = @(Get-ChildItem Cert:\LocalMachine\Root, Cert:\LocalMachine\CA, Cert:\CurrentUser\Root, Cert:\CurrentUser\CA | Sort-Object Thumbprint -Unique); if (-not ($c | Where-Object { $_.Subject -like '*Russian Trusted*' })) { exit 2 }; $pem = foreach ($x in $c) { '-----BEGIN CERTIFICATE-----'; [Convert]::ToBase64String($x.RawData, 'InsertLineBreaks'); '-----END CERTIFICATE-----' }; Set-Content -LiteralPath '%DIR%\ca.pem' -Value $pem -Encoding Ascii"
if errorlevel 1 goto :cert_missing
echo   [ок] Сертификаты из хранилища Windows выгружены в ca.pem

rem --- проверка связи ---------------------------------------------------------
echo   Проверяю связь с MAX и Яндекс.Диском...
set "NODE_EXTRA_CA_CERTS=%DIR%\ca.pem"
"%NODE%" -e "const u=['https://platform-api2.max.ru','https://fu.oneme.ru','https://cloud-api.yandex.net','https://downloader.disk.yandex.ru'];let bad=0;Promise.all(u.map(x=>fetch(x,{method:'HEAD',signal:AbortSignal.timeout(15000)}).then(()=>console.log('   ok    '+x),e=>{bad=1;console.log('   FAIL  '+x+'  '+((e.cause&&e.cause.code)||e.name||e.message))}))).then(()=>process.exit(bad))"
if errorlevel 1 goto :net_fail
:net_done

rem --- остановить прежний экземпляр, если setup запускают повторно -----------
schtasks /end /tn "%TASK%" >nul 2>&1
powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Where-Object { $_.CommandLine -like '*--env-file*bot.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

rem --- права на папку ---------------------------------------------------------
icacls "%DIR%" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-20:(OI)(CI)M >nul
if errorlevel 1 goto :acl_fail
icacls "%DIR%\*" /reset /T /C /Q >nul
echo   [ок] Доступ к папке: SYSTEM и администраторы, бот — NETWORK SERVICE

rem --- автозапуск -------------------------------------------------------------
powershell -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'; try { $who = ([Security.Principal.SecurityIdentifier]'S-1-5-20').Translate([Security.Principal.NTAccount]).Value } catch { $who = 'NT AUTHORITY\NETWORK SERVICE' }; $act = New-ScheduledTaskAction -Execute '%DIR%\start-bot.cmd' -WorkingDirectory '%DIR%'; $trg = New-ScheduledTaskTrigger -AtStartup; $trg.Delay = 'PT30S'; $set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -Disable; $prn = New-ScheduledTaskPrincipal -UserId $who -LogonType ServiceAccount -RunLevel Limited; Register-ScheduledTask -TaskName '%TASK%' -Action $act -Trigger $trg -Settings $set -Principal $prn -Force | Out-Null"
if errorlevel 1 goto :task_fail
echo   [ок] Задача %TASK% создана выключенной: запуск при включении, от NETWORK SERVICE,
echo        без ограничения времени работы

rem --- сон --------------------------------------------------------------------
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1
echo   [ок] Сон и гибернация при питании от сети отключены

rem --- включить сейчас или в день переключения --------------------------------
echo.
echo   Бот на прежнем месте уже остановлен? Если два бота работают
echo   одновременно, они разбирают одни и те же события наперегонки,
echo   и часть нажатий пропадает.
echo.
echo   1 — включить и запустить бота сейчас
echo   2 — оставить выключенным до дня переключения
choice /c 12 /n /m "   Ваш выбор (1 или 2): "
if errorlevel 2 goto :task_off
schtasks /change /tn "%TASK%" /enable >nul
schtasks /run /tn "%TASK%" >nul
echo.
echo   Бот запущен, жду 40 секунд и показываю конец журнала:
ping -n 41 127.0.0.1 >nul
echo.
powershell -NoProfile -NonInteractive -Command "if (Test-Path -LiteralPath '%DIR%\bot.log') { Get-Content -LiteralPath '%DIR%\bot.log' -Tail 15 -Encoding UTF8 } else { '   bot.log ещё не появился — загляните в него через минуту' }"
echo.
echo   Признак успеха — строка «Бот ... на связи.» без ошибок после неё.
echo   Затем напишите боту в MAX: должно прийти меню. Если в журнале
echo   ничего нет — бот не запустился от NETWORK SERVICE (частая причина —
echo   политика запуска программ не пускает node.exe для служебных учётных записей).
echo   Остановить: stop-bot.cmd от имени администратора.
goto :done

:task_off
schtasks /change /tn "%TASK%" /disable >nul
echo.
echo   Задача создана выключенной. В день переключения, когда бот
echo   на прежнем месте будет остановлен, выполните от администратора:
echo.
echo     schtasks /change /tn %TASK% /enable
echo     schtasks /run /tn %TASK%
goto :done

rem ============================================================================
:done
echo.
echo   Готово.
echo   Остановить бота:  stop-bot.cmd от имени администратора
echo   Удалить задачу:   schtasks /delete /tn %TASK% /f
echo.
pause
exit /b 0

:not_admin
echo   [стоп] Нужны права администратора.
echo          Правой кнопкой по setup.cmd — «Запуск от имени администратора».
goto :fail

:in_profile
echo   [стоп] Папка бота лежит в профиле пользователя.
echo          Бот работает от служебной учётной записи NETWORK SERVICE,
echo          у которой нет доступа к профилям пользователей. Перенесите папку
echo          в C:\priemka-bot и запустите setup.cmd оттуда.
goto :fail

:bad_path
echo   [стоп] В пути к папке есть скобки — скрипт с ними не справится.
echo          Перенесите папку в C:\priemka-bot и запустите setup.cmd оттуда.
goto :fail

:no_bot
echo   [стоп] Рядом с setup.cmd нет bot.js. Запускайте setup.cmd из папки бота.
goto :fail

:no_access
echo   [стоп] Нет файла access.json — списка тех, кому разрешено пользоваться
echo          ботом. Без него бот пустит только основных администраторов.
echo          Возьмите файл из архива или у разработчика.
goto :fail

:no_node
echo   [стоп] Node.js не найден.
echo          Поставьте Node.js LTS 22 или новее установщиком с nodejs.org
echo          либо распакуйте архив Node.js в подпапку node рядом с setup.cmd,
echo          чтобы получился путь node\node.exe.
goto :fail

:node_in_profile
echo   [стоп] Node.js установлен в профиль пользователя:
echo          "%NODE%"
echo          Служебная учётная запись бота его не увидит. Поставьте Node.js
echo          для всех пользователей или распакуйте его в подпапку node.
goto :fail

:node_blocked
echo   [стоп] Node.js найден, но не запускается: "%NODE%"
echo          Обычно это политика запуска программ (AppLocker и подобные):
echo          запрещена не установка, а сам запуск. Нужно разрешение
echo          службы безопасности на запуск Node.js на этом компьютере.
goto :fail

:node_old
echo   [стоп] Нужен Node.js 22 или новее, найден v%NV%.
goto :fail

:env_txt
echo   [стоп] Рядом лежит .env.txt вместо .env — Блокнот дописал расширение.
echo          Переименуйте файл в .env и запустите setup.cmd снова.
goto :fail

:env_empty
echo   [стоп] Токен не введён. Запустите setup.cmd снова.
goto :fail

:env_bad
echo   [стоп] В .env нет строк MAX_TOKEN=... и YANDEX_DISK_TOKEN=... с значениями.
echo          Если строки есть — файл сохранён в кодировке «UTF-8 с BOM»:
echo          пересохраните его в Блокноте как «UTF-8». Либо удалите .env,
echo          и setup.cmd спросит токены сам.
goto :fail

:cert_missing
echo   [стоп] Сертификат Минцифры (Russian Trusted Root CA) в хранилище
echo          Windows не найден. Скачайте его с портала Госуслуг
echo          (gosuslugi.ru/crt), установите в «Доверенные корневые центры
echo          сертификации» и запустите setup.cmd снова.
goto :fail

:net_fail
echo.
echo   [внимание] Связи нет. По коду ошибки:
echo     сертификат (CERT, SELF_SIGNED, UNABLE_TO_VERIFY) — нужного сертификата
echo       нет в хранилище Windows (Минцифры или сертификата TLS-инспекции сети);
echo     ENOTFOUND, ETIMEDOUT, TimeoutError — прокси или межсетевой экран.
echo   Бот ходит в интернет напрямую и прокси-сервер не использует.
echo.
choice /c 12 /n /m "   1 — продолжить установку без связи, 2 — прервать: "
if errorlevel 2 goto :fail
goto :net_done

:acl_fail
echo   [стоп] Не удалось выставить права на папку (icacls).
goto :fail

:task_fail
echo   [стоп] Задачу автозапуска создать не удалось — вероятно, PowerShell
echo          ограничен политикой. Заведите задачу вручную по инструкции,
echo          раздел «Ручная установка».
goto :fail

:fail
echo.
echo   Установка не завершена.
echo.
pause
exit /b 1
