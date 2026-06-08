"""
Тест: выбор товарной КАТЕГОРИИ при поиске по бренду.

  • RU-категория из GUI -> доменный профиль движка (--query-profile) в stage1;
  • «любая» -> профиль не передаётся (без сужения);
  • в движке профиль категории строит варианты «бренд + тип товара» этой
    категории и включает доменный фильтр (товары только этой категории);
  • новый домен appliances (бытовая техника) присутствует.

Запуск:  python3 tests/test_brand_category.py
"""
import asyncio
import sys
import types
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


def main():
    import wb_checker as wc
    import main_v39 as mv

    # --- GUI: RU-категория -> --query-profile в stage1 ---
    runner = wc.EngineRunner(wc.AppState())
    calls = []
    runner._run_one = lambda args, label: (calls.append(list(args)) or 0)

    runner._run(wc.RunSpec(mode="brand", brand="indesit", brand_match="contains",
                           brand_category="бытовая техника", limit=500, workers=4))
    a1 = calls[0]
    check("бытовая техника -> --query-profile appliances",
          "--query-profile" in a1 and a1[a1.index("--query-profile") + 1] == "appliances")

    calls.clear()
    runner._run(wc.RunSpec(mode="brand", brand="reebok", brand_match="exact",
                           brand_category="одежда", limit=500, workers=4))
    check("одежда -> --query-profile clothing",
          "--query-profile" in calls[0] and calls[0][calls[0].index("--query-profile") + 1] == "clothing")

    calls.clear()
    runner._run(wc.RunSpec(mode="brand", brand="reebok", brand_match="exact",
                           brand_category="любая", limit=500, workers=4))
    check("«любая» -> без --query-profile", "--query-profile" not in calls[0])

    # --- движок: новый домен appliances ---
    check("домен appliances существует", "appliances" in mv.DOMAIN_PRODUCT_TYPES)
    check("appliances содержит «стиральные машины»",
          any("стиральн" in t for t in mv.DOMAIN_PRODUCT_TYPES["appliances"]))

    # --- движок: профиль категории строит «бренд + тип» и включает фильтр ---
    seen = []
    nm = [1000]

    async def fake(session, query, pql, sort, domain='', stats=None, page=1, fbrand_ids=None):
        seen.append((query, domain))
        if page == 1:
            nm[0] += 1
            return [mv.Card(nm_id=nm[0], product_name="x", brand="Indesit",
                            subject="Стиральные машины", source_query=query)]
        return []

    async def fakedisc(s, b, timeout=10.0):
        return []

    def _args(profile):
        return SimpleNamespace(input_csv=None, query="indesit", query_profile=profile,
                               max_expanded_queries=250, limit=40, per_query_limit=250,
                               auto_expand=True, brand="indesit", brand_match="contains",
                               strict_domain_filter=True, search_sorts="popular",
                               collect_workers=4, user_agent="t")

    mv.collect_one_query = fake
    mv.discover_brand_filter_ids = fakedisc
    try:
        asyncio.run(mv.collect_cards(_args("appliances")))
    finally:
        pass
    qs = [q for q, d in seen]
    doms = set(d for q, d in seen)
    check("appliances: есть вариант «indesit стиральные машины»",
          any(q.startswith("indesit ") and "стиральн" in q for q in qs))
    check("appliances: доменный фильтр включён", "appliances" in doms)
    check("appliances: НЕ ищет одежду (нет «indesit куртки»)",
          not any("куртк" in q for q in qs))


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
