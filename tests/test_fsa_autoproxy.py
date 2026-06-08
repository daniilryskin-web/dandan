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
import wb_checker as wc  # noqa: E402

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

    def get(self, url, timeout=None, headers=None, **kw):
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

    # 1b) парс HTML-страницы (как proxy5.net) — ip:port внутри тегов/с пробелами
    mv._curl_requests = None  # отключаем curl-фоллбэк в тесте
    html = ('<table><td class="prx">5.61.51.10:8080</td><td>1.2.3.4 : 3128</td>'
            '<span>91.243.188.236:1080</span></table>')
    proxies_h = asyncio.run(mv._fetch_free_proxies(_Session([(html, 200)]), limit=80))
    check("HTML: ip:port извлечён (5.61.51.10:8080)", "http://5.61.51.10:8080" in proxies_h)
    check("HTML: ip с пробелами (1.2.3.4:3128)", "http://1.2.3.4:3128" in proxies_h)

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

    # 4) ПУЛ прокси: загрузка (inline + форматы) и ротация
    pool = mv.load_proxy_pool("1.2.3.4:8080, http://u:p@5.6.7.8:3128\nsocks5://9.9.9.9:1080\n# коммент\n")
    check("пул: ip:port -> http://1.2.3.4:8080", "http://1.2.3.4:8080" in pool)
    check("пул: с авторизацией сохранён", "http://u:p@5.6.7.8:3128" in pool)
    check("пул: socks5 сохранён", "socks5://9.9.9.9:1080" in pool)
    check("пул: комментарии отброшены", not any("коммент" in x for x in pool))
    # загрузка из файла
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tf:
        tf.write("11.11.11.11:80\n22.22.22.22:8080\n")
        tfp = tf.name
    pool_f = mv.load_proxy_pool(tfp)
    check("пул из ФАЙЛА загружен", "http://11.11.11.11:80" in pool_f and "http://22.22.22.22:8080" in pool_f)
    # ротация
    mv._FSA_PROXY_POOL = pool
    mv._FSA_PROXY_POOL_BAD = set()
    picks = set(mv._pick_fsa_proxy() for _ in range(60))
    check("ротация: выдаёт РАЗНЫЕ прокси", len(picks) >= 2)
    # исключение «плохого»
    mv._FSA_PROXY_POOL_BAD = set(pool[1:])
    picks2 = set(mv._pick_fsa_proxy() for _ in range(20))
    check("плохие прокси исключаются", picks2 == {pool[0]})

    # 5) флаг и проброс
    a3 = ap.parse_args(["--input-links-csv", "x.csv"])
    check("--registry-proxy-list есть, по умолчанию пуст", a3.registry_proxy_list == "")
    sp = wc.RunSpec(mode="query_stage2", input_links_csv="r.csv",
                    registry_proxy_list="1.2.3.4:8080,5.6.7.8:3128", workers=5)
    check("stage2 пробрасывает --registry-proxy-list",
          "--registry-proxy-list" in sp.wb_args())


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
