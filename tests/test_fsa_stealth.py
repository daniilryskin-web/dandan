"""
Тест: FSA собирается ТОЛЬКО через браузер (без прокси), с анти-детект мерами.

После отказа от прокси единственный способ быстро и без блокировок — маскировать
headless-браузер (stealth), прогревать сессию на главной FSA (cookies) и делать
человекоподобные случайные паузы между документами. Здесь проверяем, что:

  • прокси-функционал полностью вычищен из движка (нет функций/глобалов);
  • есть stealth-хелперы и init-script, прячущий navigator.webdriver;
  • есть прогрев сессии (_fsa_warmup_context) и разбор паузы (_fsa_human_delay_range);
  • CLI-флаг --fsa-human-delay-ms парсится в диапазон секунд.

Запуск:  python3 tests/test_fsa_stealth.py
"""
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


def main():
    import main_v39 as mv

    # 1) прокси-функционал удалён из движка
    for fn in ("load_proxy_pool", "_pick_fsa_proxy", "_auto_find_fsa_proxy",
               "_auto_build_fsa_proxy_pool", "_fetch_free_proxies", "_normalize_proxy",
               "_find_working_proxy_from", "_browser_reaches_fsa"):
        check(f"нет функции {fn}", not hasattr(mv, fn))
    for g in ("_FSA_PROXY_POOL", "_FSA_PROXY_POOL_BAD", "_FSA_AUTO_PROXY"):
        check(f"нет глобала {g}", not hasattr(mv, g))

    # 2) fetch_fsa_via_http больше не принимает proxy
    import inspect
    sig = inspect.signature(mv.fetch_fsa_via_http)
    check("fetch_fsa_via_http без параметра proxy", "proxy" not in sig.parameters)

    # 3) stealth-хелперы и init-script
    check("есть _apply_stealth", hasattr(mv, "_apply_stealth"))
    check("есть _fsa_warmup_context", hasattr(mv, "_fsa_warmup_context"))
    check("есть _fsa_human_delay_range", hasattr(mv, "_fsa_human_delay_range"))
    check("есть _FSA_STEALTH_JS", hasattr(mv, "_FSA_STEALTH_JS"))
    js = getattr(mv, "_FSA_STEALTH_JS", "")
    check("stealth прячет navigator.webdriver", "webdriver" in js)

    # 4) разбор --fsa-human-delay-ms
    ap = mv.build_parser()
    a = ap.parse_args(["--input-links-csv", "x.csv"])
    check("--fsa-human-delay-ms по умолчанию '300,1400'", a.fsa_human_delay_ms == "300,1400")
    lo, hi = mv._fsa_human_delay_range(a)
    check("дефолтный диапазон 0.3..1.4 сек", abs(lo - 0.3) < 1e-6 and abs(hi - 1.4) < 1e-6)

    a2 = ap.parse_args(["--input-links-csv", "x.csv", "--fsa-human-delay-ms", "500,2000"])
    lo2, hi2 = mv._fsa_human_delay_range(a2)
    check("кастомный диапазон 0.5..2.0 сек", abs(lo2 - 0.5) < 1e-6 and abs(hi2 - 2.0) < 1e-6)

    a3 = ap.parse_args(["--input-links-csv", "x.csv", "--fsa-human-delay-ms", "0,0"])
    lo3, hi3 = mv._fsa_human_delay_range(a3)
    check("'0,0' -> без паузы", lo3 == 0.0 and hi3 == 0.0)

    # 5) прогрев главной FSA ВЫКЛЮЧЕН по умолчанию (залп при старте воркеров = блок «с порога»)
    check("--fsa-warmup по умолчанию FALSE", a.fsa_warmup is False)
    a4 = ap.parse_args(["--input-links-csv", "x.csv", "--fsa-warmup", "true"])
    check("--fsa-warmup можно включить", a4.fsa_warmup is True)


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
