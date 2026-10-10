<#
Лига 17: собирает C++ часть проекта (модуль редактора Liga17Editor).
  powershell -ExecutionPolicy Bypass -File Tools\build.ps1
Unreal должен быть закрыт: он держит библиотеку игры, и сборка её не перезапишет.
#>
param([string]$Engine = 'C:\Program Files\Epic Games\UE_5.8')
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path "$PSScriptRoot\..").Path
if (Get-Process UnrealEditor -ErrorAction SilentlyContinue) {
    Write-Host 'Unreal открыт — закройте его и запустите сборку ещё раз'
    exit 2
}
& (Join-Path $Engine 'Engine\Build\BatchFiles\Build.bat') Liga17Editor Win64 Development "-Project=$project\Liga17.uproject" -WaitMutex
if ($LASTEXITCODE -eq 0) { Write-Host 'СБОРКА: успешно' } else { Write-Host "СБОРКА: ошибка (код $LASTEXITCODE)" }
exit $LASTEXITCODE
