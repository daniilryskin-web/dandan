"""
Запуск всех офлайн-тестов одной командой.

    python3 tests/run_all.py

Тесты НЕ ходят в сеть — проверяют логику (шардировка/конкурентность сбора
ссылок, защита Excel от падений, сверка названий, вердикт Ozon). Зелёный
прогон не гарантирует работу против живых WB/Ozon/ФСА (это проверяется на
вашей машине), но защищает от регрессий в логике.
"""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULES = [
    "test_compare_categories",
    "test_compare_layers",
    "test_compare_footwear",
    "test_chart_stats",
    "test_fsa_fastfail",
    "test_fsa_retry",
    "test_fsa_retry_scope",
    "test_scale_20k",
    "test_catalog_sweep",
    "test_fsa_stealth",
    "test_fsa_cookie_http",
    "test_fsa_fields",
    "test_brand_unified_report",
    "test_brand_routing",
    "test_brand_search",
    "test_brand_category",
    "test_brand_limit_topup",
    "test_appliance_no_toys",
    "test_docs_verified",
    "test_cert_fetch",
    "test_xlsx_safe",
    "test_load_result",
    "test_kg_rf_status",
    "test_speed_indicator",
    "test_empty_report_save",
    "test_ozon_verdict",
    "test_progress",
    "test_report_e2e",
    "test_preflight",
    "test_fsa_parse",
    "test_fsa_json_parse",
    "test_ozon_search",
    "test_original_cardjson",
    "test_original_viewflags",
    "check_frontend",
]


def _load_and_run(name: str) -> bool:
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)  # выполняет проверки на уровне модуля
    except SystemExit as e:
        return int(getattr(e, "code", 1) or 0) == 0
    except Exception as e:  # pragma: no cover
        print(f"[{name}] ОШИБКА ИМПОРТА/ЗАПУСКА: {e}")
        return False
    # Большинство тестов накапливают результаты в модульном списке RESULTS
    # (check() добавляет туда bool). Падение под __main__ через sys.exit при
    # импорте НЕ срабатывает, поэтому проверяем RESULTS напрямую.
    results = getattr(mod, "RESULTS", None)
    if isinstance(results, list) and results:
        return all(results)
    # У некоторых тестов есть функция run() с кодом возврата
    if hasattr(mod, "run"):
        try:
            p, t = mod.run()
            return p == t
        except Exception as e:  # pragma: no cover
            print(f"[{name}] run() упал: {e}")
            return False
    return True


def main() -> int:
    print("=" * 70)
    print("ОФЛАЙН-ТЕСТЫ dandan")
    print("=" * 70)
    ok = True
    for name in MODULES:
        print(f"\n>>> {name}")
        passed = _load_and_run(name)
        ok = ok and passed
        print(f"<<< {name}: {'OK' if passed else 'FAIL'}")
    print("\n" + "=" * 70)
    print("ИТОГ:", "ВСЕ ТЕСТЫ ЗЕЛЁНЫЕ ✅" if ok else "ЕСТЬ ПАДЕНИЯ ❌")
    print("=" * 70)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
