"""
Офлайн-тест определения «Оригинал» по биту viewFlags (на РЕАЛЬНЫХ данных).

Бит «Оригинал» = 3 (значение 8) подтверждён сравнением 3 товаров с плашкой и
4 без (см. WB_ORIGINAL_VIEWFLAG_BIT). viewFlags приходит прямо в поисковой
выдаче WB, поэтому проверка мгновенна и без доп. запросов.

Запуск:  python3 tests/test_original_viewflags.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main_v39 as m  # noqa: E402

RESULTS = []


def check(name, cond, extra=""):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra}")


# Реальные viewFlags из card.wb.ru (артикул: viewFlags)
ORIGINAL = {863239425: 135671833, 173642704: 135028761, 519200637: 202899465}
PLAIN = {1008983494: 811026, 267983778: 135798913, 237643208: 135028736,
         663082548: 8591261696}

check("бит «Оригинал» зафиксирован = 8", m.WB_ORIGINAL_VIEWFLAG_BIT == 8,
      str(m.WB_ORIGINAL_VIEWFLAG_BIT))

for nm, vf in ORIGINAL.items():
    res = m._detect_wb_original({"viewFlags": vf})
    check(f"оригинал {nm} -> 'оригинал'", res == "оригинал", res)

for nm, vf in PLAIN.items():
    res = m._detect_wb_original({"viewFlags": vf})
    check(f"обычный {nm} -> 'не указано'", res == "не указано", res)

# viewFlags может отсутствовать — не должно падать
check("нет viewFlags -> 'не указано'", m._detect_wb_original({}) == "не указано")
# текстовый сигнал по-прежнему работает
check("текст 'оригинал' в name -> 'оригинал'",
      m._detect_wb_original({"name": "Кроссовки оригинал"}) == "оригинал")

if __name__ == "__main__":
    p = sum(RESULTS)
    t = len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
