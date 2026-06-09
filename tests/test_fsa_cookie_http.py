"""
Тест: быстрый HTTP-путь FSA по КУКАМ браузера (v45.2).

Идея решения: первый FSA-документ парсится браузером (он проходит JS-антибот ФСА
и получает сессионную куку), его куки снимаются в _FSA_SESSION_COOKIES, а все
следующие документы тянутся напрямую к JSON API ФСА быстрым HTTP (curl_cffi) с
этими куками — один лёгкий запрос вместо полной загрузки SPA.

Проверяем механизм без сети:
  • fetch_fsa_via_http принимает cookies и кладёт их в сессию curl_cffi
    (домен pub.fsa.gov.ru);
  • при skip_warmup=True не делаются прогревочные запросы (i18n/account) —
    бьём сразу в API;
  • есть _harvest_fsa_cookies; флаг --fsa-cookie-http по умолчанию TRUE.

Запуск:  python3 tests/test_fsa_cookie_http.py
"""
import inspect
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


class _FakeCookies:
    def __init__(self):
        self.sets = []

    def set(self, name, value, domain=None):
        self.sets.append((name, value, domain))


class _FakeResp:
    status_code = 200
    text = '{"ok": 1}'

    def json(self):
        return {"ok": 1}


class _FakeSession:
    def __init__(self):
        self.cookies = _FakeCookies()
        self.gets = []

    def get(self, url, headers=None, timeout=None, impersonate=None, **kw):
        self.gets.append(url)
        return _FakeResp()


def main():
    import main_v39 as mv

    # 1) сигнатура и наличие хелпера/флага
    sig = inspect.signature(mv.fetch_fsa_via_http)
    check("fetch_fsa_via_http принимает cookies", "cookies" in sig.parameters)
    check("есть _harvest_fsa_cookies", hasattr(mv, "_harvest_fsa_cookies"))
    check("_harvest_fsa_cookies — корутина", inspect.iscoroutinefunction(mv._harvest_fsa_cookies))
    ap = mv.build_parser()
    a = ap.parse_args(["--input-links-csv", "x.csv"])
    check("--fsa-cookie-http по умолчанию FALSE (ФСА только браузер)", a.fsa_cookie_http is False)
    a_on = ap.parse_args(["--input-links-csv", "x.csv", "--fsa-cookie-http", "true"])
    check("--fsa-cookie-http можно включить", a_on.fsa_cookie_http is True)
    check("есть глобал _FSA_SESSION_COOKIES", hasattr(mv, "_FSA_SESSION_COOKIES"))

    # 2) куки реально кладутся в сессию curl_cffi, домен FSA, прогрев пропущен
    fake_mod = types.SimpleNamespace()
    created = {}

    def _Session():
        s = _FakeSession()
        created["s"] = s
        return s

    fake_mod.Session = _Session
    _orig = mv._curl_requests
    mv._curl_requests = fake_mod
    # чистим кэш, чтобы документ реально запросился
    try:
        mv._FSA_CACHE.clear()
    except Exception:
        pass
    try:
        url = "https://pub.fsa.gov.ru/rss/certificate/view/777001/baseInfo"
        cookies = {"SESSION": "abc123", "XSRF-TOKEN": "tok"}
        mv.fetch_fsa_via_http(url, cookies=cookies, skip_warmup=True)
        s = created.get("s")
        sets = s.cookies.sets if s else []
        set_names = {n for (n, v, d) in sets}
        check("куки SESSION/XSRF положены в сессию", {"SESSION", "XSRF-TOKEN"} <= set_names)
        check("домен кук = pub.fsa.gov.ru",
              bool(sets) and all(d == "pub.fsa.gov.ru" for (n, v, d) in sets))
        warmup_hit = any(("i18n" in u or "/account" in u) for u in (s.gets if s else []))
        check("skip_warmup: прогревочные запросы НЕ делались", not warmup_hit)
        check("запрос к API /api/v1/.../certificates/ был сделан",
              any("/api/v1/" in u and "777001" in u for u in (s.gets if s else [])))
    finally:
        mv._curl_requests = _orig


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
