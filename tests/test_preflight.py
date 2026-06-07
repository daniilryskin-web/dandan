"""
Офлайн-тест логики предполётной диагностики (preflight.py).

Сетевую часть не дёргаем — проверяем определение Python, наличие модулей и
классификацию критичный/некритичный.

Запуск:  python3 tests/test_preflight.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import preflight as pf  # noqa: E402

RESULTS = []


def check(name, cond, extra=""):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra}")


# 1) Python текущей версии (3.11 в тестовой среде) — OK
st, msg = pf.check_python()
check("текущий Python проходит порог", st == pf.OK, msg)
# Искусственно завышенный порог -> FAIL
st2, _ = pf.check_python(min_major=9, min_minor=9)
check("завышенный порог даёт FAIL", st2 == pf.FAIL)

# 2) check_module: установленный vs отсутствующий
check("openpyxl найден", pf.check_module("openpyxl") is True)
check("несуществующий модуль не найден",
      pf.check_module("definitely_absent_module_xyz") is False)

# 3) Классификация: критичный отсутствующий -> FAIL, некритичный -> WARN
custom = [
    ("openpyxl", "есть", True),
    ("definitely_absent_module_xyz", "нет крит.", True),
    ("another_absent_module_qwe", "нет некрит.", False),
]
res = {name: st for st, name, _ in pf.check_dependencies(custom)}
check("установленный критичный -> OK", res["openpyxl"] == pf.OK)
check("отсутствующий критичный -> FAIL", res["definitely_absent_module_xyz"] == pf.FAIL)
check("отсутствующий некритичный -> WARN", res["another_absent_module_qwe"] == pf.WARN)

# 4) main() с критичными отсутствиями -> код возврата 1 (без --network)
#    В тестовой среде нет pywebview/curl_cffi/playwright, значит ожидаем 1.
rc = pf.main(argv=[])
check("main() сигнализирует о критических проблемах кодом 1", rc == 1, f"rc={rc}")

if __name__ == "__main__":
    passed = sum(RESULTS)
    total = len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {passed}/{total} прошло")
    sys.exit(0 if passed == total else 1)
