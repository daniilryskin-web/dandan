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

    _orig_coq = mv.collect_one_query
    _orig_disc = mv.discover_brand_filter_ids
    mv.collect_one_query = fake
    mv.discover_brand_filter_ids = fakedisc
    try:
        asyncio.run(mv.collect_cards(_args("appliances")))
    finally:
        mv.collect_one_query = _orig_coq
        mv.discover_brand_filter_ids = _orig_disc
    qs = [q for q, d in seen]
    doms = set(d for q, d in seen)
    check("appliances: есть вариант «indesit стиральные машины»",
          any(q.startswith("indesit ") and "стиральн" in q for q in qs))
    check("appliances: доменный фильтр включён", "appliances" in doms)
    check("appliances: НЕ ищет одежду (нет «indesit куртки»)",
          not any("куртк" in q for q in qs))

    # --- НЕСКОЛЬКО категорий: одежда + обувь ---
    calls.clear()
    runner._run(wc.RunSpec(mode="brand", brand="reebok", brand_match="exact",
                           brand_category="одежда,обувь", limit=500, workers=4))
    am = next(c for c in calls if "--brand" in c)  # stage1 (с брендом)
    check("мультикатегория -> --query-profile clothing,shoes",
          "--query-profile" in am and am[am.index("--query-profile") + 1] == "clothing,shoes")
    check("мультидомен: кроссовки релевантны (clothing,shoes)",
          mv.is_card_relevant_for_domain("", "clothing,shoes", product_name="Кроссовки"))
    check("мультидомен: куртка релевантна (clothing,shoes)",
          mv.is_card_relevant_for_domain("", "clothing,shoes", product_name="Куртка"))
    check("мультидомен: холодильник НЕ релевантен (clothing,shoes)",
          not mv.is_card_relevant_for_domain("", "clothing,shoes", product_name="Холодильник"))

    # --- brandId извлекается из ТОВАРОВ поисковой выдачи ---
    async def _disc():
        import aiohttp
        async def fake_fetch(session, url, timeout=12.0):
            if "resultset=catalog" in url:
                return {"data": {"products": [
                    {"id": 111, "brand": "Reebok", "brandId": 777, "name": "x"},
                    {"id": 222, "brand": "Reebok", "brandId": 777, "name": "y"},
                    {"id": 333, "brand": "Nike", "brandId": 999, "name": "z"},
                ]}}
            return None
        orig = mv.fetch_json
        mv.fetch_json = fake_fetch
        try:
            return await mv.discover_brand_filter_ids(None, "reebok")
        finally:
            mv.fetch_json = orig
    ids = asyncio.run(_disc())
    check("brandId из товаров: найден 777 (Reebok), не 999 (Nike)",
          "777" in ids and "999" not in ids)

    # --- argparse принимает несколько профилей через запятую и новые домены ---
    ap = mv.build_parser()
    ok_multi = True
    try:
        a = ap.parse_args(["--query", "reebok", "--query-profile", "clothing,shoes", "--link-only", "true"])
        ok_multi = (a.query_profile == "clothing,shoes")
    except SystemExit:
        ok_multi = False
    check("argparse: --query-profile clothing,shoes принят", ok_multi)
    ok_app = True
    try:
        a2 = ap.parse_args(["--query", "x", "--query-profile", "appliances"])
        ok_app = (a2.query_profile == "appliances")
    except SystemExit:
        ok_app = False
    check("argparse: --query-profile appliances принят", ok_app)


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
