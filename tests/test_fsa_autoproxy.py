"""
Тест авто-обхода блокировки FSA: парсер публичных списков прокси и CLI-флаги.

FSA отдаёт данные только настоящему браузеру, поэтому единственный способ обойти
бан IP — пустить браузер через прокси с рабочим IP. Программа ищет такой прокси
автоматически из публичных списков. Здесь проверяем разбор списков (текст + JSON)
и наличие флагов. (Сам сетевой поиск/проверку браузером в офлайне не гоняем.)

Запуск:  python3 tests/test_fsa_autoproxy.py
"""
import asyncio
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))
import main_v39 as mv  # noqa: E402

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


class _Resp:
    def __init__(self, txt, status=200):
        self._t, self.status = txt, status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def text(self, errors=None):
        return self._t


class _Session:
    def __init__(self, payloads):
        self.payloads, self.i = payloads, 0

    def get(self, url, timeout=None):
        p = self.payloads[self.i] if self.i < len(self.payloads) else ("", 200)
        self.i += 1
        return _Resp(*p)


def main():
    # 1) парсер списков прокси: текст «ip:port» / «scheme://ip:port» + JSON geonode
    payloads = [
        ("1.2.3.4:8080\nhttp://5.6.7.8:3128\nсборка мусор\n9.9.9.9:80", 200),
        ('{"data":[{"ip":"11.22.33.44","port":"8000","protocols":["http"]}]}', 200),
        ("", 200), ("", 200),
    ]
    proxies = asyncio.run(mv._fetch_free_proxies(_Session(payloads), limit=80))
    check("парс текста: http://1.2.3.4:8080", "http://1.2.3.4:8080" in proxies)
    check("парс scheme://: http://5.6.7.8:3128", "http://5.6.7.8:3128" in proxies)
    check("парс JSON geonode: http://11.22.33.44:8000", "http://11.22.33.44:8000" in proxies)
    check("мусор отброшен", all("мусор" not in p for p in proxies))
    check("дубликаты/формат: все вида scheme://ip:port",
          all(p.startswith(("http://", "https://", "socks")) for p in proxies))

    # 2) CLI-флаги авто-обхода
    ap = mv.build_parser()
    a = ap.parse_args(["--input-links-csv", "x.csv"])
    check("--fsa-autoproxy по умолчанию TRUE", a.fsa_autoproxy is True)
    check("--fsa-autoproxy-max есть", isinstance(a.fsa_autoproxy_max, int) and a.fsa_autoproxy_max > 0)
    a2 = ap.parse_args(["--input-links-csv", "x.csv", "--fsa-autoproxy", "false"])
    check("--fsa-autoproxy false отключает", a2.fsa_autoproxy is False)

    # 3) функции авто-обхода существуют
    check("есть _auto_find_fsa_proxy", hasattr(mv, "_auto_find_fsa_proxy"))
    check("есть _browser_reaches_fsa", hasattr(mv, "_browser_reaches_fsa"))


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
