"""
Офлайн-тест устойчивого извлечения ссылок Ozon из перехваченного JSON.

Проблема из реального прогона: поиск Ozon возвращал 0 товаров, хотя страница
грузилась. Причина — ссылки брались ТОЛЬКО из DOM (a[href*='/product/']), а
Ozon отдаёт выдачу в перехватываемом JSON и часто не рендерит прямые anchor'ы.
Фикс — дополнительно тянуть /product/...-<sku> из перехваченного JSON.

Запуск:  python3 tests/test_ozon_search.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ozon_parser_playwright as p  # noqa: E402

RESULTS = []


def check(name, cond, extra=""):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra}")


# Перехваченный JSON выдачи: экранированные и обычные слэши, мусор
captured = {
    "searchResultsV2-1": '{"items":[{"action":{"link":"\\/product\\/sandalii-detskie-1234567890\\/?asb=x"}},'
                         '{"link":"\\/product\\/krossovki-987654321\\/"}]}',
    "tileGridDesktop-9": '{"tile":{"button":{"default":{"link":"/product/sabo-555000111/"}}}}',
    "noise": "тут нет ссылок на товары",
}
res = p._extract_product_links_from_capture(captured)
skus = sorted(r["sku"] for r in res)

check("извлечены все 3 SKU из JSON", skus == ["1234567890", "555000111", "987654321"], str(skus))
check("URL нормализованы на www.ozon.ru/product/",
      all(r["url"].startswith("https://www.ozon.ru/product/") for r in res))
check("дедуп по SKU работает",
      len(res) == len({r["sku"] for r in res}))
check("пустой/мусорный ввод не падает",
      p._extract_product_links_from_capture({"x": "", "y": "no links"}) == [])

if __name__ == "__main__":
    passed = sum(RESULTS)
    total = len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {passed}/{total} прошло")
    sys.exit(0 if passed == total else 1)
