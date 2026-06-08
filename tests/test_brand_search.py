"""
Тесты исправлений «поиска по бренду» и извлечения реестров:

  1) collect_cards в режиме БРЕНДА не расширяет запрос вариантами категорий
     (никаких «reebok детские») и листает страницы (page=1,2,…), без доменного
     subject-фильтра;
  2) обычный поиск по запросу — поведение прежнее (page=1, расширение работает);
  3) SWIS-парсер достаёт наименование продукции и из «простых» вёрсток
     («Наименование продукции» без слов «однородное/идентификац»);
  4) Bridge._freshest_xlsx выбирает *_live.xlsx, если он свежее основного.

Запуск:  python3 tests/test_brand_search.py
"""
import asyncio
import sys
import types
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


def _args(**over):
    base = dict(
        input_csv=None, query="reebok", query_profile="auto", max_expanded_queries=250,
        limit=200, per_query_limit=250, auto_expand=True, brand="", brand_match="any",
        strict_domain_filter=True, search_sorts="popular", collect_workers=4,
        user_agent="test-agent",
    )
    base.update(over)
    return SimpleNamespace(**base)


def run_collect(mv, args):
    """Запускает collect_cards с замоканными collect_one_query и discover_brand_
    filter_ids (без сети); возвращает список (query, page, sort, fbrand_ids)."""
    seen = []
    nm_counter = [1000]

    async def fake_collect_one_query(session, query, per_query_limit, sort,
                                     domain='', stats=None, page=1, fbrand_ids=None):
        seen.append((query, page, sort, tuple(fbrand_ids or ())))
        # на первых двух страницах отдаём карточки, дальше — пусто (конец листания)
        if page <= 2:
            out = []
            for _ in range(3):
                nm_counter[0] += 1
                out.append(mv.Card(nm_id=nm_counter[0], product_name="Кроссовки",
                                   brand="Reebok", subject="обувь", source_query=query))
            return out
        return []

    async def fake_discover(session, brand, timeout=10.0):
        return ["12345"]  # имитируем найденный brandId

    orig = mv.collect_one_query
    orig_disc = mv.discover_brand_filter_ids
    mv.collect_one_query = fake_collect_one_query
    mv.discover_brand_filter_ids = fake_discover
    try:
        asyncio.run(mv.collect_cards(args))
    finally:
        mv.collect_one_query = orig
        mv.discover_brand_filter_ids = orig_disc
    return seen


def main():
    import main_v39 as mv
    import wb_checker as wc

    # 1) БРЕНД: только чистый запрос + листание + несколько сортировок + brandId
    seen_brand = run_collect(mv, _args(brand="reebok", brand_match="contains", query="reebok", limit=1000))
    queries = {q for q, _p, _s, _b in seen_brand}
    pages = {p for _q, p, _s, _b in seen_brand}
    sorts = {s for _q, _p, s, _b in seen_brand}
    fbrands = {b for _q, _p, _s, b in seen_brand}
    check("бренд: запрос ТОЛЬКО 'reebok' (без приписок)", queries == {"reebok"})
    check("бренд: нет варианта с 'детск'", not any("детск" in q for q in queries))
    check("бренд: листается несколько страниц", max(pages) >= 2)
    check("бренд: используется НЕСКОЛЬКО сортировок", len(sorts) >= 3)
    check("бренд: передаётся brandId в бренд-каталог", ("12345",) in fbrands)

    # 2) обычный поиск: page=1, без brandId
    seen_q = run_collect(mv, _args(brand="", brand_match="any", query="reebok"))
    check("обычный поиск: только page=1", {p for _q, p, _s, _b in seen_q} == {1})
    check("обычный поиск: без brandId", all(b == () for _q, _p, _s, b in seen_q))

    # 3) SWIS «простая» вёрстка
    html = ("<html><head><title>сертификат</title></head><body><table>"
            "<tr><th>Общие сведения</th></tr>"
            "<tr><td>Регистрационный номер документа</td><td>ЕАЭС KG 417/1</td></tr>"
            "<tr><td>Признак действия документа</td><td>Действует</td></tr>"
            "<tr><th>Продукция</th></tr>"
            "<tr><td>Наименование продукции</td><td>Обувь детская кроссовая</td></tr>"
            "</table></body></html>")
    d = mv.parse_swis_http_full(html, "http://swis.trade.kg/Doc/x")
    check("SWIS: номер извлечён", d.get("cert_number") == "ЕАЭС KG 417/1")
    check("SWIS: продукция извлечена из простой вёрстки",
          bool(d.get("product")) and "Обувь" in d.get("product", ""))

    # 4) freshest xlsx
    with tempfile.TemporaryDirectory() as td:
        main_x = Path(td) / "brand_result.xlsx"
        live_x = Path(td) / "brand_result_live.xlsx"
        main_x.write_text("old")
        time.sleep(0.7)
        live_x.write_text("new")
        check("freshest: выбирает _live (свежее)", wc.freshest_xlsx(main_x).name == "brand_result_live.xlsx")
        live_x.unlink()
        check("freshest: без _live -> основной", wc.freshest_xlsx(main_x).name == "brand_result.xlsx")


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
