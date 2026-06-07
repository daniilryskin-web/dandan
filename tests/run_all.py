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
    "test_cert_fetch",
    "test_xlsx_safe",
    "test_ozon_verdict",
    "test_progress",
    "test_report_e2e",
    "test_preflight",
    "test_fsa_parse",
    "test_ozon_search",
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
