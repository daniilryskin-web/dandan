"""
Офлайн-тест единого протокола прогресса движков -> GUI.

Движки печатают однозначный маркер `@@PROGRESS@@ stage=.. done=.. total=..`,
который GUI (wb_checker.EngineRunner._parse_line) разбирает в первую очередь.
Раньше GUI вытаскивал прогресс слабым regex (\\d+/\\d+) и ловил ложные
срабатывания («повтор 2/5», «45/мин»), из-за чего полоса прогресса скакала.

Запуск:  python3 tests/test_progress.py
"""
import io
import re
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main_v39        # noqa: E402
import ozon_parser     # noqa: E402
import main_brand      # noqa: E402

# Эти три выражения ДОЛЖНЫ совпадать с объявленными в wb_checker.py.
SENTINEL_RX = re.compile(r"@@PROGRESS@@\s+stage=(\S+)\s+done=(\d+)\s+total=(\d+)")
LOOSE_RX = re.compile(r"(\d+)\s*/\s*(\d+)")
FALSE_RX = re.compile(r"повтор|retry|попытк|/мин|/час", re.IGNORECASE)

RESULTS = []


def check(name, cond, extra=""):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra}")


def _capture(fn):
    buf = io.StringIO()
    with redirect_stdout(buf):
        fn()
    return buf.getvalue().strip()


# 1) Все три движка печатают ОДИНАКОВЫЙ формат маркера
for mod_name, mod in (("main_v39", main_v39), ("ozon_parser", ozon_parser),
                      ("main_brand", main_brand)):
    out = _capture(lambda: mod.emit_progress("links", 120, 500))
    m = SENTINEL_RX.search(out)
    check(f"{mod_name}.emit_progress -> маркер парсится", bool(m), repr(out))
    if m:
        check(f"{mod_name}: stage/done/total верны",
              m.group(1) == "links" and m.group(2) == "120" and m.group(3) == "500",
              m.groups())

# 2) GUI: маркер имеет приоритет и однозначен
line = main_v39_line = _capture(lambda: main_v39.emit_progress("registry", 7, 42))
check("маркер не путается с обычным текстом", SENTINEL_RX.search(line).groups() == ("registry", "7", "42"))

# 3) Защита от ложных срабатываний слабого regex
retry_line = "[w1] nm_id=123: повтор 2/5 после ТАЙМАУТ"
check("'повтор 2/5' отсекается фильтром", bool(FALSE_RX.search(retry_line)))
check("без фильтра 'повтор 2/5' дал бы ложный прогресс 2/5",
      LOOSE_RX.search(retry_line).groups() == ("2", "5"))

speed_line = "  [HTTP 120/500] 45/мин, ssylok=10"
check("строка со скоростью '45/мин' отсекается фильтром", bool(FALSE_RX.search(speed_line)))

good_line = "Реестры: 50/200 обработано"
check("нормальная строка прогресса проходит фильтр", not FALSE_RX.search(good_line))
check("нормальная строка даёт корректный d/t",
      LOOSE_RX.search(good_line).groups() == ("50", "200"))

if __name__ == "__main__":
    passed = sum(RESULTS)
    total = len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {passed}/{total} прошло")
    sys.exit(0 if passed == total else 1)
