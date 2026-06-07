"""
Регрессионный тест: график-статистика (Bridge.get_results -> stats) корректно
читает РУССКИЕ заголовки листа «Подробности».

Чинит баг, из-за которого график «Реестры» оставался «нет данных» после прогона:
find_col искал латинское «реестр (host)», а в файле заголовок «Реестр (хост)»
с КИРИЛЛИЧЕСКОЙ «х». Также проверяем by_status / by_original / by_marketplace.

Запуск:  python3 tests/test_chart_stats.py
"""
import sys
import types
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# wb_checker делает import webview и sys.exit(1) без pywebview — в CI-окружении
# его нет. Подсовываем пустую заглушку, нам нужна только логика get_results.
sys.modules.setdefault("webview", types.ModuleType("webview"))

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


def _build_xlsx(path):
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Подробности"
    ws.append([
        "Запрос", "Артикул WB", "Название товара", "Бренд", "Категория WB",
        "Ссылка на товар", "Технический статус", "Плашка 'Оригинал'",
        "Реестр (хост)", "Статус документа",
    ])
    data = [
        ("q", 1, "Костюм", "A", "177", "https://www.wildberries.ru/catalog/1/detail.aspx", "OK", "оригинал", "pub.fsa.gov.ru", "Действует"),
        ("q", 2, "Комбинезон", "B", "157", "https://www.wildberries.ru/catalog/2/detail.aspx", "OK", "не указано", "pub.fsa.gov.ru", "Действует"),
        ("q", 3, "Брюки", "C", "11", "https://www.wildberries.ru/catalog/3/detail.aspx", "ПРОВЕРИТЬ ВРУЧНУЮ", "не указано", "swis.trade.kg", "Действует"),
    ]
    for r in data:
        ws.append(list(r))
    wb.save(path)


def main():
    import wb_checker
    with tempfile.TemporaryDirectory() as d:
        xlsx = Path(d) / "result.xlsx"
        _build_xlsx(xlsx)
        bridge = wb_checker.Bridge()
        res = bridge.get_results(str(xlsx))
        check("get_results ok", res.get("ok"))
        stats = res.get("stats", {})
        br = stats.get("by_registry", {})
        bs = stats.get("by_status", {})
        bo = stats.get("by_original", {})
        bm = stats.get("by_marketplace", {})
        print("  by_registry =", dict(br))
        print("  by_status   =", dict(bs))
        print("  by_original =", dict(bo))
        print("  by_marketplace =", dict(bm))
        # КЛЮЧЕВОЕ: реестры распознаны по кириллическому заголовку «Реестр (хост)»
        check("by_registry непустой (кириллический заголовок)", bool(br))
        check("by_registry: pub.fsa.gov.ru == 2", br.get("pub.fsa.gov.ru") == 2)
        check("by_registry: swis.trade.kg == 1", br.get("swis.trade.kg") == 1)
        check("by_status непустой", bool(bs) and bs.get("OK") == 2)
        check("by_original непустой", bool(bo))
        check("by_marketplace непустой (fallback по product_url)", bool(bm))


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
