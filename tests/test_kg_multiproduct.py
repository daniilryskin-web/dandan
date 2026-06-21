"""
Тест (issue v50): в одном киргизском сертификате (SWIS) бывает МНОГО товаров —
каждый со своей строкой «Полное наименование продукции и сведения, обеспечивающие
её идентификацию (...)». Программа должна забирать ВСЕ наименования, а не одно.

Корневая причина бага: _looks_like_product_value отбрасывал значения короче
18 символов, поэтому короткие названия из 1–2 слов («Юбки женские», «Платья
женские», «Брюки женские») выпадали — в результат попадал только самый длинный
товар, и сравнение давало ЛОЖНЫЕ несоответствия для остальных видов.

Запуск:  python3 tests/test_kg_multiproduct.py
"""
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))

import main_v39 as m  # noqa: E402

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


LBL = ('Полное наименование продукции и сведения, обеспечивающие её '
       'идентификацию (тип, марка, модель, артикул продукции и др.)')


def _row(label, value):
    return f"<tr><td>{label}</td><td>{value}</td></tr>"


def _sec(name):
    return f"<tr><th colspan=2>{name}</th></tr>"


def main():
    # --- короткие наименования продукции больше НЕ отбрасываются ---
    for v in ("Юбки женские", "Платья женские", "Брюки женские", "Носки детские"):
        check(f"короткое наименование принимается: {v!r}",
              m._looks_like_product_value(v, known_product_label=True))
    # ...но мусор/служебные значения по-прежнему отбраковываются
    check("без флага короткое значение отвергается (общий путь строгий)",
          not m._looks_like_product_value("Юбки женские"))
    check("цифры/даты не считаются продукцией",
          not m._looks_like_product_value("12.05.2024", known_product_label=True))

    # --- многотоварный сертификат: собираются ВСЕ товары ---
    products = ["Юбки и юбки-брюки женские", "Платья женские", "Брюки женские",
                "Блузки женские", "Жакеты женские"]
    rows = [_sec("Сведения о сертификате"),
            _row("Регистрационный номер документа", "ЕАЭС KG 417/123"),
            _row("Признак действия", "Действует")]
    for i, p in enumerate(products, 1):
        rows.append(_sec(f"Товар {i}"))
        rows.append(_row(LBL, p))
        rows.append(_row("Код ТН ВЭД ТС", f"620453000{i}"))
    html = "<table>" + "".join(rows) + "</table>"

    data = m.parse_swis_http_full(html)
    prod = data.get("product") or ""
    check("cert_number извлечён", data.get("cert_number") == "ЕАЭС KG 417/123")
    for p in products:
        check(f"товар попал в наименование: {p!r}", p in prod)
    check("в наименовании несколько товаров (через «; »)", prod.count(";") >= 4)

    # --- сравнение: карточка любого из видов даёт OK, а не ложное несоответствие ---
    for card in ("Юбка женская джинсовая", "Платье женское вечернее",
                 "Брюки женские классические", "Блузка женская офисная",
                 "Жакет женский"):
        verdict = m.compare_product_names(card, prod, doc_status="Действует")[0]
        check(f"карточка {card!r}: НЕ ложное несоответствие (verdict={verdict})",
              verdict in ("OK", "ПРОВЕРИТЬ ВРУЧНУЮ"))
    # чужой вид (мужская куртка) к женскому сертификату — корректно НЕ OK
    v_foreign = m.compare_product_names("Куртка мужская зимняя", prod,
                                        doc_status="Действует")[0]
    check("чужой товар не получает ложный OK по совпадению вида",
          v_foreign != "OK" or "куртк" in prod.lower())

    # строгий парсер (BeautifulSoup-таблица) — тоже собирает все товары
    c2, p2, _ = m.parse_swis_registry_strict(html)
    for p in products:
        check(f"strict-парсер: {p!r} собран", p in (p2 or ""))


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
