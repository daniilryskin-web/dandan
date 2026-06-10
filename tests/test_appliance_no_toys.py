"""
Тест (issue v46): «взрослые» категории (техника/электроника/посуда/дом) НЕ должны
тянуть детские/игрушечные товары.

Баг: запрос «бытовая техника» + категория «бытовая техника» давал варианты вроде
«стиральные машины детские» (→ игрушечная стиральная машина) и пропускал такие
карточки. Причина — детские/возрастные модификаторы применялись ко всем категориям.

Проверяем:
  • в вариантах запроса для appliances/electronics/kitchenware/home НЕТ детских
    модификаторов;
  • негативный фильтр домена отсеивает игрушечные товары для этих категорий;
  • «детские» категории (одежда/обувь/игрушки) по-прежнему богаты вариантами.

Запуск:  python3 tests/test_appliance_no_toys.py
"""
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


_KIDS = ('детск', 'для мальчик', 'для девоч', 'школьн', 'малыш', 'дошкольн', 'новорожд', 'подростк')


def main():
    import main_v39 as mv

    # Проверяем, что НЕ генерятся «<тип/запрос> + детский МОДИФИКАТОР» (суффикс) —
    # именно это давало «стиральные машины детские» = игрушки. Легитимные ТИПЫ с
    # детскими словами («детская посуда») допустимы — это реальные категории.
    mods = [m for m in mv.UNIVERSAL_MODIFIERS]
    def _ends_with_mod(s):
        sl = s.lower()
        return any(sl.endswith(' ' + m.lower()) for m in mods)
    for prof, q in [('appliances', 'бытовая техника'), ('electronics', 'электроника'),
                    ('kitchenware', 'посуда'), ('home', 'дом и текстиль')]:
        qs = mv.generate_query_variants(q, prof, 250)
        # исключаем легитимные типы, которые сами оканчиваются на «для новорожденных» и т.п.
        types = set(t.lower() for t in mv.DOMAIN_PRODUCT_TYPES.get(prof, []))
        bad = [x for x in qs if _ends_with_mod(x) and x.lower() not in types]
        check(f"{prof}: НЕТ комбинаций «тип + детский модификатор»", not bad)
        check(f"{prof}: вариантов больше базового (есть типы)", len(qs) >= 10)
    # точечно: конкретные «отравляющие» строки отсутствуют
    qa = [x.lower() for x in mv.generate_query_variants('бытовая техника', 'appliances', 250)]
    check("appliances: нет «стиральные машины детские»", 'стиральные машины детские' not in qa)
    check("appliances: нет «бытовая техника детские»", 'бытовая техника детские' not in qa)

    # негативный фильтр: игрушечная техника отсеивается
    check("appliances: игрушечная стиральная машина -> отсеяна",
          not mv.is_card_relevant_for_domain("", "appliances",
                                              product_name="Детская стиральная машина игрушечная"))
    check("appliances: настоящая стиральная машина -> релевантна",
          mv.is_card_relevant_for_domain("", "appliances", subject_name="Стиральные машины",
                                         product_name="Стиральная машина Indesit"))
    check("electronics: игрушечный телефон -> отсеян",
          not mv.is_card_relevant_for_domain("", "electronics",
                                              subject_name="Игрушки", product_name="Телефон игрушечный"))

    # детские категории — по-прежнему много вариантов (модификаторы там уместны)
    check("clothing: много вариантов (>120)", len(mv.generate_query_variants("детская одежда", "clothing", 250)) > 120)
    check("toys: много вариантов (>120)", len(mv.generate_query_variants("игрушки", "toys", 250)) > 120)

    # viewFlags-диагностика (для будущего бита «Документы проверены»)
    check("Card.view_flags есть", "view_flags" in mv.Card.__dataclass_fields__)
    ap = mv.build_parser()
    a = ap.parse_args(["--query", "x", "--link-only", "true"])
    check("--dump-viewflags по умолчанию TRUE", a.dump_viewflags is True)


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
