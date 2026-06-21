#!/usr/bin/env python3
"""
Предполётная диагностика окружения для WB+Ozon Checker.

Запуск:
    python preflight.py            # проверка Python и зависимостей
    python preflight.py --network  # ещё и проверка доступа к сайтам/реестрам

Назначение: за 2 секунды показать пользователю, ЧЕГО не хватает для работы
программы (несовместимый Python, не установленные пакеты, не скачанный
браузер Playwright, проблемы с сетью) — понятным языком, без чтения трейсбеков.

Коды выхода: 0 — всё критичное на месте; 1 — есть критические проблемы.
"""
from __future__ import annotations

import importlib.util
import shutil
import sys
from typing import List, Tuple

OK, WARN, FAIL = "OK", "WARN", "FAIL"

# (имя_модуля, человекочитаемое_назначение, критичность)
REQUIRED = [
    ("pywebview", "интерфейс (окно приложения)", True),
    ("openpyxl", "Excel-отчёт", True),
    ("aiohttp", "быстрые HTTP-запросы (WB)", True),
    ("requests", "HTTP-запросы", True),
    ("bs4", "разбор HTML (SWIS/BelGISS)", True),
    ("lxml", "быстрый парсер HTML", False),
    ("curl_cffi", "обход TLS-защиты ФСА и Ozon (без него ФСА/Ozon-HTTP не работают)", True),
    ("playwright", "браузерный сбор карточек", True),
    ("customtkinter", "альтернативный интерфейс (необязательно)", False),
]

NETWORK_HOSTS = [
    ("search.wb.ru", "поиск Wildberries"),
    ("basket-01.wbbasket.ru", "документы Wildberries"),
    ("www.ozon.ru", "Ozon"),
    ("pub.fsa.gov.ru", "реестр ФСА"),
    ("swis.trade.kg", "реестр Киргизии (SWIS)"),
]


def check_python(min_major: int = 3, min_minor: int = 10) -> Tuple[str, str]:
    v = sys.version_info
    cur = f"{v.major}.{v.minor}.{v.micro}"
    if (v.major, v.minor) >= (min_major, min_minor):
        return OK, f"Python {cur}"
    return FAIL, f"Python {cur} — нужен {min_major}.{min_minor}+ (обновите python.org)"


def check_module(name: str) -> bool:
    """Доступен ли модуль (без его импорта — быстро и безопасно)."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, ModuleNotFoundError):
        return False


def check_dependencies(required=REQUIRED) -> List[Tuple[str, str, str]]:
    """Возвращает список (status, имя, пояснение)."""
    out: List[Tuple[str, str, str]] = []
    for name, purpose, critical in required:
        if check_module(name):
            out.append((OK, name, purpose))
        else:
            out.append((FAIL if critical else WARN, name, purpose))
    return out


def check_playwright_chromium() -> Tuple[str, str]:
    """Установлен ли движок Playwright и скачан ли chromium."""
    if not check_module("playwright"):
        return FAIL, "playwright не установлен"
    # Браузеры Playwright лежат в ms-playwright; ищем папку chromium-*.
    try:
        from pathlib import Path
        import os
        candidates = []
        env = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
        if env:
            candidates.append(Path(env))
        home = Path.home()
        candidates += [
            home / "AppData" / "Local" / "ms-playwright",      # Windows
            home / ".cache" / "ms-playwright",                  # Linux
            home / "Library" / "Caches" / "ms-playwright",      # macOS
        ]
        for base in candidates:
            if base.exists() and any(base.glob("chromium-*")):
                return OK, f"chromium найден ({base})"
        return WARN, ("chromium не найден — выполните: "
                      "python -m playwright install chromium")
    except Exception as e:
        return WARN, f"не удалось проверить chromium: {e}"


def check_network(hosts=NETWORK_HOSTS, timeout: float = 6.0) -> List[Tuple[str, str, str]]:
    """Отвечает ли узел по HTTPS. ВАЖНО: статус 403 — это НОРМАЛЬНО (сайты
    режут прямой доступ), главное что соединение есть. 'недоступно' = проблема
    с сетью/файрволом/DNS."""
    import urllib.request
    import urllib.error
    out: List[Tuple[str, str, str]] = []
    for host, purpose in hosts:
        url = f"https://{host}/"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "preflight/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                out.append((OK, host, f"соединение есть (HTTP {r.status}) — {purpose}"))
        except urllib.error.HTTPError as e:
            # Ответ получен (даже 403) => сеть работает, это и нужно знать
            out.append((OK, host, f"соединение есть (HTTP {e.code}, прямой доступ ограничен — это норма) — {purpose}"))
        except Exception as e:
            out.append((FAIL, host, f"НЕДОСТУПНО ({type(e).__name__}) — {purpose}"))
    return out


def _print_row(status: str, name: str, msg: str) -> None:
    mark = {OK: "  ✅", WARN: "  ⚠️ ", FAIL: "  ❌"}.get(status, "  • ")
    print(f"{mark} {name:16} {msg}")


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    do_network = "--network" in argv

    print("=" * 68)
    print("  ПРЕДПОЛЁТНАЯ ДИАГНОСТИКА — WB+Ozon Checker")
    print("=" * 68)

    critical_fail = False

    print("\n[1] Python")
    st, msg = check_python()
    _print_row(st, "python", msg)
    critical_fail = critical_fail or st == FAIL

    print("\n[2] Зависимости (pip)")
    deps = check_dependencies()
    for st, name, purpose in deps:
        _print_row(st, name, purpose)
        critical_fail = critical_fail or st == FAIL
    missing = [n for st, n, _ in deps if st == FAIL]
    if missing:
        print("\n     Установить недостающее:")
        print("       python -m pip install -U -r requirements.txt")

    print("\n[3] Браузер Playwright")
    st, msg = check_playwright_chromium()
    _print_row(st, "chromium", msg)

    if do_network:
        print("\n[4] Доступ к сайтам и реестрам")
        for st, host, msg in check_network():
            _print_row(st, host, msg)
    else:
        print("\n[4] Доступ к сайтам — пропущено (добавьте --network для проверки)")

    print("\n" + "=" * 68)
    if critical_fail:
        print("  ИТОГ: ❌ есть критические проблемы — см. ❌ выше")
    else:
        print("  ИТОГ: ✅ критичное на месте, можно запускать (python wb_checker.py)")
    print("=" * 68)
    return 1 if critical_fail else 0


if __name__ == "__main__":
    sys.exit(main())
