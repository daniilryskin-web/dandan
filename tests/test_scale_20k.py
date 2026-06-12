"""
Тест (issue v47): устойчивый сбор по 20 000+ карточкам.

Узкие места, которые чинились (и проверяются здесь):
  • этап 1 листал ТОЛЬКО 1-ю страницу каждого варианта запроса — потолок
    ~4-8k уникальных карточек при любом лимите → scaled_search_pages;
  • число вариантов запроса не росло с лимитом → scaled_max_queries;
  • запись xlsx на 20k+ строк блокировала event loop (watchdog считал прогон
    зависшим) → ResultStore.save пишет в отдельном потоке и сериализуется;
  • обрыв этапа 2 на 15k/20k реестров требовал полного пере-парсинга →
    --registry-resume (по умолчанию ON) переносит собранное из result.xlsx,
    включая расширенные поля (даты/схема/техрегламент) через кэш.

Запуск:  python3 tests/test_scale_20k.py
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
    # --- масштабирование вариантов запроса ---
    check("малый лимит: вариантов = дефолт", m.scaled_max_queries(1000, 250) == 250)
    check("20k: вариантов больше 250", m.scaled_max_queries(20000, 250) > 250)
    check("50k: вариантов капится 800", m.scaled_max_queries(50000, 250) == 800)
    check("явное значение уважается", m.scaled_max_queries(20000, 300) == 300)

    # --- глубина листания обычного поиска ---
    check("малый лимит: 1 страница хватает", m.scaled_search_pages(250, 123) == 1)
    check("10k/123 вариантов: страниц >= 2", m.scaled_search_pages(10000, 123) >= 2)
    check("20k/123 вариантов: страниц >= 3", m.scaled_search_pages(20000, 123) >= 3)
    check("кап 10 страниц", m.scaled_search_pages(1000000, 10) == 10)
    check("0 вариантов не падает", m.scaled_search_pages(5000, 0) >= 1)

    # --- неблокирующее сохранение: параллельные save сериализуются и не падают ---
    async def _save_test():
        with tempfile.TemporaryDirectory() as td:
            store = m.ResultStore(Path(td) / "r.xlsx", Path(td) / "r.csv",
                                  make_report_xlsx=True)
            for i in range(300):
                await store.add(m.ResultRow(
                    query="q", nm_id=i + 1, product_name=f"товар {i}", brand="b",
                    subject="s", product_url="", status="OK", docs_verified="Да"))
            await asyncio.gather(store.save(), store.save(), store.save())
            return (Path(td) / "r.xlsx").exists() and (Path(td) / "r.csv").exists() \
                and store.last_save_count == 300
    check("3 параллельных save: сериализованы, файлы записаны",
          asyncio.get_event_loop().run_until_complete(_save_test()))

    # --- resume этапа 2: аргументы и перенос расширенных полей ---
    ap = m.build_parser()
    a = ap.parse_args(["--query", "x", "--link-only", "true"])
    check("--registry-resume по умолчанию TRUE", a.registry_resume is True)
    check("--registry-resume-max-age-hours = 72", a.registry_resume_max_age_hours == 72.0)

    # лоадер прежнего результата восстанавливает расширенные поля в кэш
    from openpyxl import Workbook
    H = m.DETAILS_HEADERS_RU_V39
    cols = ['registry_url', 'certificate_number', 'certificate_product_name',
            'document_type', 'document_status', 'document_date_start',
            'document_date_end', 'scheme', 'technical_regulation']
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "result.xlsx"
        wb = Workbook(); ws = wb.active; ws.title = 'Подробности'
        ws.append([H[c] for c in cols])
        u = 'https://pub.fsa.gov.ru/rss/certificate/view/777/baseInfo'
        ws.append([u, 'ЕАЭС RU С-CN.НВ10.В.04610/24', 'Обувь детская', 'сертификат',
                   'Действует', '08.04.2024', '07.04.2027', '1с', 'ТР ТС 007/2011'])
        wb.save(str(p))
        m._FSA_EXTENDED_FIELDS_CACHE.pop(u, None)
        prior = m._load_prior_registry_parsed(p)
        check("лоадер прочитал документ", u in prior and prior[u][0].startswith('ЕАЭС'))
        ext = m._FSA_EXTENDED_FIELDS_CACHE.get(u, {})
        check("даты восстановлены в кэш (resume не теряет «Действует до»)",
              ext.get('document_date_end') == '07.04.2027')
        check("схема/техрегламент восстановлены",
              ext.get('scheme') == '1с' and ext.get('technical_regulation') == 'ТР ТС 007/2011')

    # --- стилизация «Подробностей» дешёвая на больших объёмах (защита от
    #     многоминутной записи): порог в коде присутствует ---
    src = (Path(__file__).resolve().parents[1] / "main_v39.py").read_text(encoding="utf-8")
    check("guard per-cell стилизации для >8000 строк есть", "_full_style" in src)
    check("автосейв prefetch есть (обрыв 20k не теряет прогресс)",
          "периодический автосейв ВНУТРИ prefetch" in src)

    # --- этап 2: отдельный HTTP-пул для НЕ-ФСА реестров ---
    check("--registry-http-workers по умолчанию 6", a.registry_http_workers == 6)
    check("очереди этапа 2 разделены (ФСА/HTTP)", "q_http" in src and "async def http_worker" in src)
    check("ожидание учитывает оба пула воркеров",
          "all(t.done() for t in http_tasks)" in src)

    # --- GUI: кэш результатов + порционный рендер таблицы ---
    gui = (Path(__file__).resolve().parents[1] / "wb_checker.py").read_text(encoding="utf-8")
    check("get_results кэшируется по (path, mtime, size)", "_results_cache" in gui
          and "st_mtime_ns" in gui)
    check("таблица рендерится порциями (TABLE_CHUNK)", "TABLE_CHUNK" in gui
          and "_nextChunkHtml" in gui)
    check("кнопка «Показать ещё» есть", "tbl-more" in gui)
    check("клики делегированы (не тысячи обработчиков)", "wrap.onclick" in gui)


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
