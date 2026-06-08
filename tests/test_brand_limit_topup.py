"""
Регресс-тест (issue v45.1): при ВЫБРАННОЙ категории добор по реальным subject'ам
бренда должен запускаться, если карточек собрано меньше лимита.

Баг: поиск по бренду бытовой техники с лимитом 1000 отдавал только ~100. Причина —
при выбранной категории добор по фактическим subject'ам был отключён, а базовый
поиск без найденного brandId не листался дальше первой страницы (~100 карточек).

Здесь имитируем именно это: базовый запрос отдаёт мало и не листается, brandId не
найден. Проверяем, что добор всё равно идёт — появляются запросы «бренд + subject»,
и итог превышает «одну страницу».

Запуск:  python3 tests/test_brand_limit_topup.py
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
    import main_v39 as mv

    seen_queries = []
    nm = [5000]

    async def fake_collect(session, query, pql, sort, domain='', stats=None, page=1, fbrand_ids=None):
        seen_queries.append(query)
        # Базовый запрос «бренд»: отдаёт ровно 1 страницу и НЕ листается (page>1 -> []),
        # как бывает, когда brandId не найден. Это раньше «застревало» на ~стостраничном.
        is_base = (query.strip().lower() == "indesit")
        if is_base:
            if page == 1:
                out = []
                for _ in range(20):
                    nm[0] += 1
                    out.append(mv.Card(nm_id=nm[0], product_name="Стиральная машина",
                                       brand="Indesit", subject="Стиральные машины",
                                       source_query=query))
                return out
            return []
        # Добор «indesit Стиральные машины»: отдаёт НОВЫЕ карточки бренда той же категории.
        if page <= 2:
            out = []
            for _ in range(15):
                nm[0] += 1
                out.append(mv.Card(nm_id=nm[0], product_name="Стиральная машина",
                                   brand="Indesit", subject="Стиральные машины",
                                   source_query=query))
            return out
        return []

    async def fake_disc(s, b, timeout=10.0):
        return []  # brandId НЕ найден — как в логе пользователя

    args = SimpleNamespace(input_csv=None, query="indesit", query_profile="appliances",
                           max_expanded_queries=250, limit=200, per_query_limit=250,
                           auto_expand=True, brand="indesit", brand_match="contains",
                           strict_domain_filter=True, search_sorts="popular",
                           collect_workers=4, user_agent="t")

    _orig_coq = mv.collect_one_query
    _orig_disc = mv.discover_brand_filter_ids
    mv.collect_one_query = fake_collect
    mv.discover_brand_filter_ids = fake_disc
    try:
        cards = asyncio.run(mv.collect_cards(args))
    finally:
        mv.collect_one_query = _orig_coq
        mv.discover_brand_filter_ids = _orig_disc

    topup_queries = [q for q in seen_queries if q.strip().lower() != "indesit"
                     and "стиральн" in q.lower()]
    check("добор запущен при выбранной категории (есть «indesit <subject>»)", bool(topup_queries))
    check("собрано больше одной страницы (>20 карточек)", len(cards) > 20)


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
