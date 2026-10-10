<#
Лига 17: выполняет Content\Python\liga_setup.py в редакторе без окон и ждёт конца.
  powershell -ExecutionPolicy Bypass -File Tools\setup_auto.ps1
Редактор открывается, работает (в первый раз до часа), сохраняет всё и закрывается сам.
Итог настройки: Saved\Liga\setup_report.txt; лог: Saved\Logs\Liga17.log.
#>
param([string]$Engine = 'C:\Program Files\Epic Games\UE_5.8', [int]$TimeoutMinutes = 120)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path "$PSScriptRoot\..").Path
$editor = Join-Path $Engine 'Engine\Binaries\Win64\UnrealEditor.exe'
$script = Join-Path $project 'Content\Python\liga_setup.py'
$report = Join-Path $project 'Saved\Liga\setup_report.txt'
$log = Join-Path $project 'Saved\Logs\Liga17.log'
if (Get-Process UnrealEditor -ErrorAction SilentlyContinue) {
    Write-Host 'Unreal уже открыт — закройте его и запустите снова'
    exit 2
}
if (Test-Path $report) { Remove-Item $report }
$env:LIGA_AUTO = '1'
$p = Start-Process $editor -ArgumentList "`"$project\Liga17.uproject`" -ExecutePythonScript=`"$script`"" -PassThru
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while (-not $p.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5 }
if (-not $p.HasExited) {
    Write-Host "Прошло $TimeoutMinutes мин — закрываю Unreal"
    Stop-Process -Id $p.Id -Force
}
if (Test-Path $report) {
    Write-Host '===== Итог настройки ====='
    Get-Content $report -Encoding UTF8
} else {
    Write-Host 'Итога нет: настройка не дошла до конца (редактор упал или время вышло). Конец лога:'
    if (Test-Path $log) { Get-Content $log -Encoding UTF8 -Tail 40 }
}
if (Test-Path $log) {
    Write-Host '===== Ошибки и предупреждения [Liga] из лога ====='
    Select-String -Path $log -Encoding UTF8 -Pattern 'Warning: \[Liga\]|Error: \[Liga\]|LogPython: Error|Fatal error' |
        Select-Object -Last 40 | ForEach-Object { $_.Line }
}
