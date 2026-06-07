"""
Офлайн-тест: HTTP-путь Ozon теперь считает финальный вердикт сверки названий.

Раньше вердикт (название карточки vs название из реестра — главный результат
программы) считал ТОЛЬКО Playwright-путь. apply_verdicts() переносит ту же
логику (main_v39.compare_product_names) в общий HTTP-пайплайн Ozon.

Запуск:  python3 tests/test_ozon_verdict.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ozon_parser as oz  # noqa: E402

RESULTS = []


def check(name, cond, extra=""):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra}")


def row(**kw):
    return oz.OzonResultRow(**kw)


# 1) Совпадение карточки и реестра -> OK
r_ok = row(
    product_name="Кроссовки Nike Air Max мужские",
    subject="Кроссовки",
    certificate_product_name="Обувь спортивная (кроссовки) для взрослых",
    document_status="Действует",
    status="ССЫЛКА НА РЕЕСТР СОБРАНА",
)
# 2) Явное несоответствие -> НЕСООТВЕТСТВИЕ
r_bad = row(
    product_name="Платье вечернее женское",
    subject="Платья",
    certificate_product_name="Игрушки мягкие для детей",
    document_status="Действует",
    status="ССЫЛКА НА РЕЕСТР СОБРАНА",
)
# 3) Нет данных реестра -> статус НЕ меняем
r_none = row(
    product_name="Чайник электрический",
    subject="Чайники",
    certificate_product_name="",
    document_status="",
    status="ССЫЛКА НА РЕЕСТР СОБРАНА",
)

before_none = r_none.status
oz.apply_verdicts([r_ok, r_bad, r_none])

check("совпадение -> OK", r_ok.status == "OK", r_ok.status)
check("совпадение -> score > 0", r_ok.score > 0, str(r_ok.score))
check("несоответствие -> НЕСООТВЕТСТВИЕ", r_bad.status == "НЕСООТВЕТСТВИЕ", r_bad.status)
check("без реестра -> статус не тронут", r_none.status == before_none, r_none.status)

if __name__ == "__main__":
    passed = sum(RESULTS)
    total = len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {passed}/{total} прошло")
    sys.exit(0 if passed == total else 1)
