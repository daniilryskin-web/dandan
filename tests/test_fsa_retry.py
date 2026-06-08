"""
Тест: второй проход FSA — ПО КНОПКЕ, а не автоматически.

  • argparse: --registry-fsa-retry по умолчанию FALSE (авто-повтора нет);
  • wb_args(query_stage2): всегда передаёт --registry-fsa-retry (true/false);
  • Bridge.retry_failed_fsa() перезапускает этап 2 (query_stage2) с включённым
    вторым проходом FSA;
  • прокси-функционал полностью удалён (нет --registry-proxy/--registry-proxy-list
    ни в argparse, ни в RunSpec, ни в wb_args).

Запуск:  python3 tests/test_fsa_retry.py
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
    import wb_checker as wc
    import main_v39 as mv

    # 1) argparse defaults
    ap = mv.build_parser()
    a = ap.parse_args(["--input-links-csv", "x.csv"])
    check("--registry-fsa-retry по умолчанию FALSE", a.registry_fsa_retry is False)

    # 2) прокси-флаги УДАЛЕНЫ из argparse
    check("нет --registry-proxy в argparse", not hasattr(a, "registry_proxy"))
    check("нет --registry-proxy-list в argparse", not hasattr(a, "registry_proxy_list"))
    check("нет --fsa-autoproxy в argparse", not hasattr(a, "fsa_autoproxy"))

    # 3) wb_args(query_stage2): передаёт --registry-fsa-retry, без прокси
    sp = wc.RunSpec(mode="query_stage2", input_links_csv="registry_links.csv",
                    registry_fsa_retry=True, workers=5)
    args = sp.wb_args()
    check("stage2: --registry-fsa-retry true",
          "--registry-fsa-retry" in args and args[args.index("--registry-fsa-retry") + 1] == "true")
    check("stage2: --registry-proxy НЕ передаётся", "--registry-proxy" not in args)
    check("stage2: --registry-proxy-list НЕ передаётся", "--registry-proxy-list" not in args)
    sp2 = wc.RunSpec(mode="query_stage2", input_links_csv="registry_links.csv", workers=5)
    a2 = sp2.wb_args()
    check("stage2 по умолчанию retry=false",
          a2[a2.index("--registry-fsa-retry") + 1] == "false")

    # 4) RunSpec не содержит прокси-полей
    check("RunSpec без registry_proxy", "registry_proxy" not in wc.RunSpec.__dataclass_fields__)
    check("RunSpec без registry_proxy_list", "registry_proxy_list" not in wc.RunSpec.__dataclass_fields__)

    # 5) Bridge.retry_failed_fsa -> query_stage2 + registry_fsa_retry
    bridge = wc.Bridge()
    captured = {}
    bridge.runner.start = lambda spec: captured.update(spec=spec)
    bridge.state.running = False
    bridge.state.output_path = "brand_result.xlsx"
    bridge._last_spec = {"output_links_csv": "registry_links.csv", "workers": 5,
                         "output": "brand_result.xlsx"}
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
