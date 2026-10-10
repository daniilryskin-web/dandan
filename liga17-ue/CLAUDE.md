# Лига 17 — заметки для Claude

Фан-игра про покемонов на Unreal Engine 5.8 (C++ и Python-скрипты редактора). Владелец проекта — новичок:
отвечай по-русски, простыми шагами, объясняй, что делаешь и зачем. Перед долгими действиями (сборка, настройка
на 20–60 минут, запуск игры) предупреждай и проси закрыть браузер.

## Компьютер
- Windows 11, i5-11400F (6 ядер / 12 потоков), 16 ГБ ОЗУ, RTX 3060 12 ГБ. Памяти впритык: два Unreal сразу не запускай.
- Движок: `C:\Program Files\Epic Games\UE_5.8`. Проект: `C:\Games\liga17-ue` (эта папка).
- PowerShell запрещает сценарии `.ps1`: запускай их так — `powershell -ExecutionPolicy Bypass -File Tools\<имя>.ps1`.

## Что где
- `Source/Liga17/` — C++ игры: бой (`LigaBattle*`), покемоны, NPC, HUD, мир (`LigaWorldBuilder`), данные
  (`LigaData.cpp`, встречи в траве — `BuildEncounters`). `LigaEditorTools` — помощник для скриптов редактора.
- `Content/Python/liga_setup.py` — настройка в редакторе: текстуры, город, персонажи VRoid (плагин VRM4U),
  3D-покемоны, `Content/Liga/Data/assets.json`. Запускается снова сколько угодно раз.
- `Content/Python/liga_pokemon3d.py` — скачивание и конвертер 3D-покемонов (glTF → риг, процедурные анимации
  idle/walk/attack/faint) и импорт по одной модели за кадр с защитой по памяти. Если меняешь то, что выдаёт
  конвертер, увеличь `CONVERTER_VERSION`: модели импортируются в новую папку `/Game/Liga/Pokemon3D/V<n>`.
- `Content/Liga/Data/species.json` — виды покемонов. `ArtSource/` — Blender-скрипты города, текстуры,
  `Characters/cast.json` (персонажи VRoid).
- `Docs/README_RU.md` — инструкция для владельца (установка, управление, «Если что-то не так»). Обновляй её,
  когда меняется то, что он делает руками.

## Как проверять работу
1. Сборка C++ (Unreal закрыт): `powershell -ExecutionPolicy Bypass -File Tools\build.ps1`.
2. Настройка без окон: `powershell -ExecutionPolicy Bypass -File Tools\setup_auto.ps1` — открывает редактор,
   выполняет `liga_setup.py`, сохраняет и закрывает его; итог в `Saved\Liga\setup_report.txt`.
3. Игра со снимками экрана:
   `powershell -ExecutionPolicy Bypass -File Tools\play.ps1 -Steps "wait 30; shot start; key E; wait 2; hold W 2; shot walk"`.
   Снимки окна игры — `Saved\Liga\Screens\<имя>.png`; смотри их инструментом Read. Шаги: `wait`, `shot`, `key`,
   `hold` (см. начало `play.ps1`). Управление в игре — `Docs/README_RU.md`, раздел «Управление».
4. Логи: `Saved\Logs\Liga17.log` (строки скриптов начинаются с `[Liga]`), сбои — `Saved\Crashes\`.

## Правила
- C++: исходники в UTF-8 с BOM; предупреждения считаются ошибками — не перекрывай имена членов класса и внешних
  переменных (C4458, C4456); в `FString::Printf` строка формата только литералом.
- После удаления `Binaries` первый запуск редактора не подключает плагин VRM4U (люди становятся манекенами):
  нужен ещё один перезапуск.
- Картинки и 3D-модели покемонов не коммить и не распространяй: они скачиваются на этом компьютере для личного
  использования. Персонажи VRoid — CC0.
- Не помогай обходить защиту настоящего сайта League17 (антидетект, капча и т. п.).
- Исходники лежат на GitHub: `daniilryskin-web/dandan`, папка `liga17-ue/`, ветка `claude/wonderful-brown-vpq11p`.
  Эта папка — копия, а не git-клон. Ничего не публикуй и не пушь без просьбы владельца.
