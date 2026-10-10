<#
Лига 17: запускает игру в окне, выполняет простые шаги и снимает окно игры.
  powershell -ExecutionPolicy Bypass -File Tools\play.ps1 -Steps "wait 30; shot start; key ENTER; wait 3; hold W 2; shot walk"
Шаги через «;»:
  wait <секунды>          подождать
  shot <имя>              снимок окна игры в Saved\Liga\Screens\<имя>.png
  key <клавиша>           нажать и отпустить (A–Z, 0–9, ENTER, ESC, SPACE, BACKSPACE, TAB, SHIFT, UP, DOWN, LEFT, RIGHT, F1–F12)
  hold <клавиша> <сек>    держать клавишу (ходьба: hold W 2)
В конце игра закрывается (если не указан -KeepOpen). Unreal-редактор должен быть закрыт: двум копиям не хватит памяти.
#>
param(
    [string]$Steps = 'wait 30; shot start',
    [string]$Engine = 'C:\Program Files\Epic Games\UE_5.8',
    [int]$Width = 1280,
    [int]$Height = 720,
    [switch]$KeepOpen
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path "$PSScriptRoot\..").Path
$editor = Join-Path $Engine 'Engine\Binaries\Win64\UnrealEditor.exe'
$shots = Join-Path $project 'Saved\Liga\Screens'
New-Item -ItemType Directory -Force $shots | Out-Null
if (Get-Process UnrealEditor -ErrorAction SilentlyContinue) {
    Write-Host 'Unreal уже открыт — закройте его и запустите снова'
    exit 2
}

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LigaWin {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
}
'@
[LigaWin]::SetProcessDPIAware() | Out-Null

$p = Start-Process $editor -ArgumentList "`"$project\Liga17.uproject`" -game -windowed -ResX=$Width -ResY=$Height" -PassThru

function Get-GameWindow {
    $p.Refresh()
    return $p.MainWindowHandle
}

function Set-GameFocus {
    $h = Get-GameWindow
    if ($h -ne [IntPtr]::Zero) { [LigaWin]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 150 }
}

function Save-Shot([string]$name) {
    Set-GameFocus
    Start-Sleep -Milliseconds 300
    $r = New-Object LigaWin+RECT
    if (-not [LigaWin]::GetWindowRect((Get-GameWindow), [ref]$r)) { Write-Host "нет окна игры для снимка $name"; return }
    $w = $r.Right - $r.Left
    $h = $r.Bottom - $r.Top
    if ($w -le 0 -or $h -le 0) { Write-Host "нет окна игры для снимка $name"; return }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
    $file = Join-Path $shots "$name.png"
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "снимок: $file"
}

$named = @{ ENTER = 0x0D; ESC = 0x1B; SPACE = 0x20; BACKSPACE = 0x08; TAB = 0x09; SHIFT = 0x10; CTRL = 0x11
            LEFT = 0x25; UP = 0x26; RIGHT = 0x27; DOWN = 0x28 }

function Get-Vk([string]$key) {
    $k = $key.ToUpper()
    if ($named.ContainsKey($k)) { return $named[$k] }
    if ($k -match '^F(\d{1,2})$') { return 0x6F + [int]$Matches[1] }
    if ($k.Length -eq 1) { return [int][char]$k }
    throw "неизвестная клавиша: $key"
}

function Send-Key([string]$key, [bool]$down) {
    $vk = Get-Vk $key
    $flags = 0
    if (@(0x25, 0x26, 0x27, 0x28) -contains $vk) { $flags = $flags -bor 1 }  # стрелки — «расширенные» клавиши
    if (-not $down) { $flags = $flags -bor 2 }
    [LigaWin]::keybd_event([byte]$vk, [byte]([LigaWin]::MapVirtualKey($vk, 0)), $flags, [UIntPtr]::Zero)
}

# Ждём окно игры (до 3 минут: первый запуск компилирует шейдеры).
$deadline = (Get-Date).AddMinutes(3)
while ((Get-GameWindow) -eq [IntPtr]::Zero -and -not $p.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }

foreach ($raw in ($Steps -split ';')) {
    $parts = @($raw.Trim() -split '\s+')
    if (-not $parts[0]) { continue }
    if ($p.HasExited) { Write-Host 'игра закрылась'; break }
    switch ($parts[0].ToLower()) {
        'wait' { Start-Sleep -Milliseconds ([int]([double]$parts[1] * 1000)) }
        'shot' { Save-Shot $parts[1] }
        'key'  { Set-GameFocus; Send-Key $parts[1] $true; Start-Sleep -Milliseconds 80; Send-Key $parts[1] $false; Start-Sleep -Milliseconds 200 }
        'hold' { Set-GameFocus; Send-Key $parts[1] $true; Start-Sleep -Milliseconds ([int]([double]$parts[2] * 1000)); Send-Key $parts[1] $false }
        default { Write-Host "неизвестный шаг: $raw" }
    }
}

if (-not $KeepOpen -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force }
$log = Get-ChildItem (Join-Path $project 'Saved\Logs') -Filter 'Liga17*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($log) {
    Write-Host "лог: $($log.FullName)"
    Select-String -Path $log.FullName -Encoding UTF8 -Pattern 'Error:|Fatal error|Ensure condition failed' |
        Select-Object -Last 20 | ForEach-Object { $_.Line }
}
