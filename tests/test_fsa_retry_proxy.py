"""
Тесты: второй проход FSA — по кнопке (не авто), и прокси для этапа 2.

  • argparse: --registry-fsa-retry по умолчанию FALSE (авто-повтора нет),
    --registry-proxy по умолчанию пуст;
  • wb_args(query_stage2): всегда передаёт --registry-fsa-retry, а --registry-proxy
    только если задан; бренд/запрос пробрасывают прокси на этап 2;
  • Bridge.retry_failed_fsa() перезапускает этап 2 (query_stage2) с включённым
    вторым проходом FSA.

Запуск:  python3 tests/test_fsa_retry_proxy.py
"""
import os
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
    import wb_checker as wc
    import main_v39 as mv

    # 1) argparse defaults
    ap = mv.build_parser()
    a = ap.parse_args(["--input-links-csv", "x.csv"])
    check("--registry-fsa-retry по умолчанию FALSE", a.registry_fsa_retry is False)
    check("--registry-proxy по умолчанию пуст", a.registry_proxy == "")

    # 2) wb_args
    sp = wc.RunSpec(mode="query_stage2", input_links_csv="registry_links.csv",
                    registry_proxy="http://1.2.3.4:8080", registry_fsa_retry=True, workers=5)
    args = sp.wb_args()
    check("stage2: --registry-fsa-retry true",
          "--registry-fsa-retry" in args and args[args.index("--registry-fsa-retry") + 1] == "true")
    check("stage2: --registry-proxy передан",
          "--registry-proxy" in args and args[args.index("--registry-proxy") + 1] == "http://1.2.3.4:8080")
    sp2 = wc.RunSpec(mode="query_stage2", input_links_csv="registry_links.csv", workers=5)
    a2 = sp2.wb_args()
    check("stage2 без прокси -> --registry-proxy отсутствует", "--registry-proxy" not in a2)
    check("stage2 по умолчанию retry=false",
          a2[a2.index("--registry-fsa-retry") + 1] == "false")

    # бренд пробрасывает прокси на этап 2
    runner = wc.EngineRunner(wc.AppState())
    calls = []
    runner._run_one = lambda a, l: (calls.append((l, list(a))) or 0)
    runner._run(wc.RunSpec(mode="brand", brand="adidas", brand_match="exact",
                           registry_proxy="socks5://9.9.9.9:1080", workers=5))
    s2 = [a for l, a in calls if "реестр" in l.lower()][0]
    check("бренд: прокси проброшен на этап 2", "--registry-proxy" in s2)

    # 3) Bridge.retry_failed_fsa -> query_stage2 + registry_fsa_retry
    bridge = wc.Bridge()
    captured = {}
    bridge.runner.start = lambda spec: captured.update(spec=spec)
    bridge.state.running = False
    bridge.state.output_path = "brand_result.xlsx"
    bridge._last_spec = {"output_links_csv": "registry_links.csv", "workers": 5,
                         "registry_proxy": "http://p:1", "output": "brand_result.xlsx"}
    links = Path("registry_links.csv")
    created = False
    if not links.exists():
        links.write_text("registry_url\n"); created = True
    try:
        res = bridge.retry_failed_fsa()
        check("retry_failed_fsa ok", res.get("ok"))
        sp3 = captured.get("spec")
        check("повтор: режим query_stage2", sp3 is not None and sp3.mode == "query_stage2")
        check("повтор: registry_fsa_retry=True", sp3 is not None and sp3.registry_fsa_retry is True)
        check("повтор: прокси сохранён", sp3 is not None and sp3.registry_proxy == "http://p:1")
    finally:
        if created:
            try: links.unlink()
            except Exception: pass


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
