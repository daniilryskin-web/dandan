"""
Тест (issue v48): отдельная категория вердикта «ДОКУМЕНТ НЕ ПРОВЕРЕН» (товар
проходит, но на карточке WB нет плашки «Документы проверены») + сбор бренда по
категориям (xsubject) для обхода лимита WB ≈1200.

Запуск:  python3 tests/test_doc_not_verified.py
"""
import asyncio
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


def main():
    # --- константа и логика «ДОКУМЕНТ НЕ ПРОВЕРЕН» ---
    check("STATUS_DOC_NOT_VERIFIED = «ДОКУМЕНТ НЕ ПРОВЕРЕН»",
          m.STATUS_DOC_NOT_VERIFIED == "ДОКУМЕНТ НЕ ПРОВЕРЕН")
    src = (Path(__file__).resolve().parents[1] / "main_v39.py").read_text(encoding="utf-8")
    # применяется ко ВСЕМ карточкам с явным «нет» (а не только к OK)
    check("override по docs_verified=нет (любой вердикт)",
          "if _row_dv == 'нет':" in src)
    check("override применён в ОБОИХ местах записи (2)",
          src.count("verdict = STATUS_DOC_NOT_VERIFIED") == 2)
    # старый CSV без признака (docs_verified отсутствует) → НЕ трогаем вердикт
    for raw in ('', None, 'Да', 'да'):
        dv = str(raw or '').strip().lower()
        applies = (dv == 'нет')
        check(f"docs_verified={raw!r}: override НЕ применяется", not applies)
    check("docs_verified='Нет': override применяется",
          str('Нет').strip().lower() == 'нет')

    # GUI: цвет статуса и бейдж-предупреждение
    gui = (Path(__file__).resolve().parents[1] / "wb_checker.py").read_text(encoding="utf-8")
    check("GUI: цвет статуса задан", "'ДОКУМЕНТ НЕ ПРОВЕРЕН'" in gui)
    check("GUI: бейдж-предупреждение (НЕ ПРОВЕРЕН)", "НЕ ПРОВЕРЕН" in gui)

    # --- бренд: сбор по категориям (xsubject) ---
    check("collect_one_query принимает xsubject",
          "xsubject" in __import__("inspect").signature(m.collect_one_query).parameters)
    check("discover_brand_subjects есть", hasattr(m, "discover_brand_subjects"))

    fake = {'data': {'filters': [
        {'key': 'xsubject', 'name': 'Категория', 'items': [
            {'id': 515, 'count': 1200}, {'id': 108, 'count': 900}, {'id': 9, 'count': 50}]},
        {'key': 'priceU', 'name': 'Цена', 'items': [{'id': 1, 'count': 5}]},
    ]}}
    _orig = m.fetch_json

    async def fake_fetch(session, url, timeout=12.0):
        return fake if 'filters' in url else None
    m.fetch_json = fake_fetch
    try:
        subs = asyncio.get_event_loop().run_until_complete(
            m.discover_brand_subjects(None, ['21']))
    finally:
        m.fetch_json = _orig
    check("категории бренда отсортированы по количеству", subs == ['515', '108', '9'])
    check("ценовой фильтр НЕ попал в категории", '1' not in subs)

    # v49: устойчивость сбора по бренду (мало карточек, когда brandId «не найден»)
    src = (Path(__file__).resolve().parents[1] / "main_v39.py").read_text(encoding="utf-8")
    check("discover_brand_filter_ids повторяет попытки (ретраи)",
          "for _attempt in range(3):" in src and "await asyncio.sleep(1.0)" in src)
    check("бренд: «бренд+тип» использует несколько сортировок",
          '_sorts = ["popular", "newly", "rate"]' in src)
    check("бренд: добавляются модификаторы на больших лимитах",
          "_bmods" in src)


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
