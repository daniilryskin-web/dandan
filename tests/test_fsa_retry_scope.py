"""
Тест (issue v46): «Повторить упавшие FSA» должен пере-проверять ТОЛЬКО упавшие
FSA-ссылки, а не весь второй этап заново.

Раньше кнопка перезапускала второй этап целиком — он пере-парсил ВСЕ реестры
(включая уже успешные). Теперь из предыдущего result.xlsx переносятся успешные
документы, а заново собираются только упавшие FSA (нет номера/названия/статуса).

Проверяем строительные блоки (без браузера):
  • _load_prior_registry_parsed читает лист «Подробности» и отдаёт parsed-словарь;
  • детектор упавших FSA выбирает ровно те ссылки, где нет номера/названия/статуса,
    и НЕ трогает успешные и НЕ-FSA реестры.

Запуск:  python3 tests/test_fsa_retry_scope.py
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main_v39 as m  # noqa: E402

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


def _make_prior_xlsx(path):
    """Собирает маленький result.xlsx с подробностями через штатный построитель."""
    from openpyxl import Workbook
    H = m.DETAILS_HEADERS_RU_V39
    cols = ['registry_url', 'certificate_number', 'certificate_product_name',
            'document_type', 'document_status', 'status']
    wb = Workbook()
    # первый лист назовём «Подробности» (как в реальном отчёте)
    ws = wb.active
    ws.title = 'Подробности'
    ws.append([H[c] for c in cols])
    data = [
        # успешная FSA-декларация — НЕ трогаем
        ('https://pub.fsa.gov.ru/rds/declaration/view/111/common',
         'ЕАЭС N RU Д-CN.РА01.В.001/23', 'Кабели USB', 'декларация', 'Действует', 'OK'),
        # упавшая FSA — нет номера и названия и статуса
        ('https://pub.fsa.gov.ru/rds/declaration/view/222/common',
         '', '', 'декларация', '', 'НЕ УДАЛОСЬ ИЗВЛЕЧЬ НАЗВАНИЕ ИЗ РЕЕСТРА'),
        # частично упавшая FSA — название есть, а статуса нет
        ('https://pub.fsa.gov.ru/rss/certificate/view/333/baseInfo',
         'ЕАЭС RU С-CN.НВ01.В.003/24', 'Зарядные устройства', 'сертификат', '', 'ПРОВЕРИТЬ ВРУЧНУЮ'),
        # успешный сертификат — НЕ трогаем
        ('https://pub.fsa.gov.ru/rss/certificate/view/444/baseInfo',
         'ЕАЭС RU С-CN.НВ01.В.004/24', 'Колонки', 'сертификат', 'Действует', 'OK'),
        # НЕ-FSA (киргизский) с пустыми полями — НЕ трогаем (повтор только для FSA)
        ('https://swis.trade.kg/registry/555',
         '', '', '', '', 'ССЫЛКА НА РЕЕСТР СОБРАНА'),
    ]
    for d in data:
        ws.append(list(d))
    wb.save(str(path))


def _fsa_failed_prior(prior, u):
    if m.hostname(u) != 'pub.fsa.gov.ru':
        return False
    cert, prod, typ, dst, det = prior.get(u, ('', '', '', '', ''))
    return not cert.strip() or not prod.strip() or not dst.strip()


def main():
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / 'result.xlsx'
        _make_prior_xlsx(p)
        prior = m._load_prior_registry_parsed(p)
        check("прочитаны все 5 реестров", len(prior) == 5)
        check("успешная FSA-декларация прочитана с номером",
              prior.get('https://pub.fsa.gov.ru/rds/declaration/view/111/common', ('',))[0].startswith('ЕАЭС'))

        failed = [u for u in prior if _fsa_failed_prior(prior, u)]
        check("упавших FSA ровно 2", len(failed) == 2)
        check("в упавших — полностью пустая декларация",
              'https://pub.fsa.gov.ru/rds/declaration/view/222/common' in failed)
        check("в упавших — частичный сертификат (нет статуса)",
              'https://pub.fsa.gov.ru/rss/certificate/view/333/baseInfo' in failed)
        check("успешная FSA НЕ попала в упавшие",
              'https://pub.fsa.gov.ru/rss/certificate/view/444/baseInfo' not in failed)
        check("успешная декларация НЕ попала в упавшие",
              'https://pub.fsa.gov.ru/rds/declaration/view/111/common' not in failed)
        check("НЕ-FSA (SWIS) НЕ попадает в повтор даже с пустыми полями",
              'https://swis.trade.kg/registry/555' not in failed)

        # перенос: всё кроме упавших сидируется из прошлого результата
        seed = {u: v for u, v in prior.items() if u not in set(failed)}
        check("перенос содержит 3 успешных/не-FSA реестра", len(seed) == 3)
        check("функция-загрузчик есть в движке", hasattr(m, '_load_prior_registry_parsed'))


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
