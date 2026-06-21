"""
Тест (issue v48): «ПОИСК БЕЗ ЗАПРОСА» — пользователь задаёт только количество
карточек, программа сама формирует запросы и сметает каталог WB; плюс масштабные
доработки сохранения под 50k+.

Проверяем (без сети):
  • generate_catalog_queries даёт широкий breadth-first список по всем/выбранным
    категориям, без дублей, с детским режимом;
  • catalog_domains_for мапит RU/en метки на домены;
  • аргументы движка --catalog-sweep / --catalog-categories есть и не требуют query;
  • ResultStore.save(final=True) всегда пишет xlsx; большой набор без CSV — тоже;
  • GUI: режим query_auto есть, RunSpec знает поля, wb_args их прокидывает.

Запуск:  python3 tests/test_catalog_sweep.py
"""
import asyncio
import sys
import tempfile
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))

import main_v39 as m  # noqa: E402

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


def main():
    # --- генератор каталожных запросов ---
    allq = m.generate_catalog_queries(None, 2000)
    check("ВСЕ категории: >250 вариантов", len(allq) > 250)
    check("нет дублей", len(allq) == len(set(q.lower() for q in allq)))
    check("breadth-first: первые варианты из разных категорий",
          allq[0] != allq[1] and 'одежда' in allq[0].lower())
    check("есть и обувь, и игрушки, и техника в наборе",
          any('обув' in q.lower() for q in allq) and any('игрушк' in q.lower() for q in allq)
          and any('холодильник' in q.lower() or 'стиральн' in q.lower() for q in allq))

    sub = m.generate_catalog_queries(['обувь', 'игрушки'], 2000)
    check("подмножество категорий: только их домены",
          all(not ('холодильник' in q.lower() or 'кастрюл' in q.lower()) for q in sub))
    check("подмножество меньше полного", 0 < len(sub) < len(allq))

    kids = m.generate_catalog_queries(['посуда'], 2000, kids=True)
    check("детский режим добавляет «детские» к нейтральным типам",
          any(q.lower().startswith('детские ') for q in kids))

    check("cap уважается", len(m.generate_catalog_queries(None, 20)) == 20)
    check("домены: обувь+электроника -> shoes,electronics",
          m.catalog_domains_for(['обувь', 'электроника']) == ['shoes', 'electronics'])
    check("неизвестная метка -> пусто", m.catalog_domains_for(['абракадабра']) == [])

    # --- аргументы движка ---
    ap = m.build_parser()
    a = ap.parse_args(["--catalog-sweep", "true", "--limit", "50000",
                       "--catalog-categories", "обувь,игрушки"])
    check("--catalog-sweep парсится", a.catalog_sweep is True)
    check("--catalog-categories парсится", a.catalog_categories == "обувь,игрушки")
    check("catalog-sweep не требует query (query пуст)", a.query == "")

    # --- сохранение под 50k: final всегда пишет xlsx; CSV всегда ---
    async def _save_final():
        with tempfile.TemporaryDirectory() as td:
            store = m.ResultStore(Path(td) / "r.xlsx", Path(td) / "r.csv",
                                  make_report_xlsx=True)
            for i in range(50):
                await store.add(m.ResultRow(query="q", nm_id=i + 1, product_name="t",
                                            brand="b", subject="s", product_url="",
                                            status="OK", docs_verified="Да"))
            await store.save(final=True)
            return (Path(td) / "r.xlsx").exists() and (Path(td) / "r.csv").exists()
    check("save(final=True): xlsx + csv записаны",
          asyncio.get_event_loop().run_until_complete(_save_final()))

    # без CSV (как out_store этапа 2) xlsx пишется ВСЕГДА (даже не-final)
    async def _save_no_csv():
        with tempfile.TemporaryDirectory() as td:
            store = m.ResultStore(Path(td) / "r2.xlsx", None, make_report_xlsx=False)
            for i in range(30):
                await store.add(m.ResultRow(query="q", nm_id=i + 1, product_name="t",
                                            brand="b", subject="s", product_url="", status="OK"))
            await store.save(final=False)
            return (Path(td) / "r2.xlsx").exists()
    check("save без CSV всегда пишет xlsx (resume этапа 2 не теряется)",
          asyncio.get_event_loop().run_until_complete(_save_no_csv()))

    # --- GUI ---
    gui = (Path(__file__).resolve().parents[1] / "wb_checker.py").read_text(encoding="utf-8")
    check("RunSpec.catalog_sweep есть", "catalog_sweep: bool" in gui)
    check("RunSpec.catalog_categories есть", "catalog_categories: str" in gui)
    check("режим query_auto в форме", "query_auto:" in gui and "Без запроса (каталог)" in gui)
    check("wb_args прокидывает --catalog-sweep", '"--catalog-sweep", "true"' in gui)
    check("диспетчер обрабатывает query_auto",
          'spec.mode in ("query_full", "query_auto")' in gui)


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
