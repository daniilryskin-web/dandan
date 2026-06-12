"""
Тест (issue v46): бейдж «Документ проверен WB».

Эмпирически (по живым карточкам WB, 7 «с кнопкой» / 7 «без») признак наличия
кнопки «Документы проверены» = card.json.certificate.verified == true.
Карточки С кнопкой: {"certificate": {"verified": true}}; БЕЗ: {"certificate": {}}
или поля нет.

Проверяем:
  • card_json_docs_verified() корректно различает «с кнопкой» и «без»;
  • поле есть в Card и ResultRow, маппится в заголовок «Документ проверен WB»;
  • колонка входит в курируемый набор GUI (PREFERRED_COLS).

Запуск:  python3 tests/test_docs_verified.py
"""
import re
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


def main():
    import main_v39 as mv

    f = mv.card_json_docs_verified
    # с кнопкой
    check("verified=true -> True", f({"certificate": {"verified": True}}) is True)
    check("verified=true во вложенности -> True",
          f({"data": {"products": [{"certificate": {"verified": True}}]}}) is True)
    # без кнопки
    check("пустой certificate -> False", f({"certificate": {}}) is False)
    check("нет поля certificate -> False", f({"options": [{"name": "x"}]}) is False)
    check("verified=false -> False", f({"certificate": {"verified": False}}) is False)
    check("verified отсутствует -> False", f({"certificate": {"checked": True}}) is False)
    # мусор не валит
    check("None -> False", f(None) is False)
    check("строка -> False", f("оригинальный товар") is False)
    # не путаем посторонний verified
    check("посторонний verified не считается",
          f({"seller": {"verified": True}, "certificate": {}}) is False)

    # поля в датаклассах
    check("Card.docs_verified есть", "docs_verified" in mv.Card.__dataclass_fields__)
    check("ResultRow.docs_verified есть", "docs_verified" in mv.ResultRow.__dataclass_fields__)
    # заголовок
    check("заголовок 'Документ проверен WB'",
          mv.DETAILS_HEADERS_RU_V39.get("docs_verified") == "Документ проверен WB")
    # порядок ядра содержит docs_verified рядом с is_original
    check("docs_verified в порядке колонок", "docs_verified" in mv.CORE_DETAILS_ORDER_V39)
    # _card_fields_for_result прокидывает поле
    c = mv.Card(nm_id=1, product_name="p", brand="b", subject="s")
    c.docs_verified = "Да"
    check("_card_fields_for_result отдаёт docs_verified",
          mv._card_fields_for_result(c).get("docs_verified") == "Да")

    # бейдж собирается ВНУТРИ HTTP fast-path 1 запросом с известного basket-шарда
    check("fetch_docs_verified_at_host есть", hasattr(mv, "fetch_docs_verified_at_host"))
    # старый перебор-всех-шардов убран (он заваливал лог DNS-ошибками)
    check("старый probe-перебор удалён", not hasattr(mv, "fetch_docs_verified_via_card_json"))
    check("глушитель DNS-шума есть", hasattr(mv, "_install_quiet_dns_exc_handler"))
    ap = mv.build_parser()
    a = ap.parse_args(["--query", "x", "--link-only", "true"])
    check("--check-docs-verified по умолчанию TRUE", a.check_docs_verified is True)

    # v47: пустой docs_verified нормализуется в «Нет» при записи в ResultStore —
    # колонка никогда не бывает пустой (resume/редкие пути → «Нет»).
    import asyncio
    store = mv.ResultStore(Path("/tmp/_t_docs.xlsx"), None, make_report_xlsx=False)
    rr = mv.ResultRow(query="q", nm_id=1, product_name="p", brand="", subject="",
                      product_url="", status="OK")  # docs_verified не задан → ""
    asyncio.get_event_loop().run_until_complete(store.add(rr))
    check("ResultStore.add: пусто -> «Нет»", store.rows[-1].docs_verified == "Нет")
    rr2 = mv.ResultRow(query="q", nm_id=2, product_name="p", brand="", subject="",
                       product_url="", status="OK", docs_verified="Да")
    asyncio.get_event_loop().run_until_complete(store.add(rr2))
    check("ResultStore.add: «Да» не перетирается", store.rows[-1].docs_verified == "Да")

    # GUI: колонка в курируемом наборе
    gui = (Path(__file__).resolve().parents[1] / "wb_checker.py").read_text(encoding="utf-8")
    check("PREFERRED_COLS содержит 'Документ проверен WB'",
          "'Документ проверен WB'" in gui)
    check("GUI-алиас docs_verified -> 'Документ проверен WB'",
          re.search(r'"docs_verified":\s*"Документ проверен WB"', gui) is not None)


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
