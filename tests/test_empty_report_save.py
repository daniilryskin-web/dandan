"""
Регрессионный тест: сохранение отчёта с 0 строк НЕ должно падать.

Баг: при пустом сборе (WB вернул 0 карточек) _build_summary_sheet_v39 делал
условное форматирование на диапазон «B9:B8» -> ValueError, а обработчик
исключения вызывал log.warning(), хотя `log` в main_v39 не был определён ->
NameError рушил сохранение всего файла (и stage1, и весь прогон).

Проверяем: ResultStore.save() с 0 и с 1 строкой создаёт валидный XLSX со всеми
листами и не бросает исключений; модульный логгер `log` существует.

Запуск:  python3 tests/test_empty_report_save.py
"""
import asyncio
import sys
import tempfile
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))
import main_v39 as mv  # noqa: E402

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


def _save(rows):
    import openpyxl
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "links.xlsx"
        rs = mv.ResultStore(out, csv_path=Path(d) / "r.csv",
                            expiry_warning_days=30, make_report_xlsx=True)
        for r in rows:
            asyncio.get_event_loop().run_until_complete(rs.add(r))
        asyncio.get_event_loop().run_until_complete(rs.save())
        wb = openpyxl.load_workbook(out)
        return out.exists(), set(wb.sheetnames)


def main():
    check("модульный логгер log определён", hasattr(mv, "log"))

    # 0 строк — раньше падало NameError/ValueError
    try:
        ok0, sheets0 = _save([])
        check("save(0 строк) не падает", ok0)
        check("save(0 строк): есть листы Сводка+Подробности",
              {"Сводка", "Подробности"} <= sheets0)
    except Exception as e:
        check(f"save(0 строк) не падает (исключение: {type(e).__name__})", False)

    # 1 строка — обычный путь
    try:
        row = mv.ResultRow(query="x", nm_id=1, product_name="Товар", brand="B",
                           subject="177", product_url="u", status="OK",
                           certificate_product_name="Изделие", document_status="Действует")
        ok1, sheets1 = _save([row])
        check("save(1 строка) не падает", ok1)
    except Exception as e:
        check(f"save(1 строка) не падает (исключение: {type(e).__name__})", False)


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
