"""
Тест: статус КИРГИЗСКИХ документов на территории РФ (v46).

  • load_kg_rf_status грузит таблицу (number, id_status_in_rf) с нормализацией
    номера (пробелы/точки/регистр не важны);
  • kg_rf_status_text: 14 -> «Прекращён», 15 -> «Приостановлен», нет -> "";
  • ResultRow имеет поле rf_status; в листе «Подробности» — заголовок
    «Статус на территории РФ»; в порядке колонок rf_status идёт после статуса;
  • совпавший киргизский документ получает вердикт «НЕДЕЙСТВУЕТ В РФ»
    (логика из _flush_url_to_store, повторяем её здесь);
  • GUI: алиас и PREFERRED_COLS содержат «Статус на территории РФ».

Запуск:  python3 tests/test_kg_rf_status.py
"""
import sys
import types
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


def main():
    import main_v39 as mv

    # временная таблица КГ
    from openpyxl import Workbook
    tmp = Path(tempfile.mkdtemp()) / "kg.xlsx"
    wb = Workbook(); ws = wb.active
    ws.append(["number", "reg_date", "id_status_in_rf"])
    ws.append(["ЕАЭС KG 417/052.BY.02.18233.", "2026-05-01", 14])
    ws.append(["ЕАЭС KG417/026.CH.02.06994", "2023-03-09", 15])
    wb.save(tmp)

    n = mv.load_kg_rf_status(str(tmp))
    check("загружено 2 записи", n == 2)
    check("14 -> Прекращён", mv.kg_rf_status_text("ЕАЭС KG417/052.BY.02.18233") == "Прекращён")
    check("нормализация (пробелы/точка)",
          mv.kg_rf_status_text("ЕАЭС KG 417/052.BY.02.18233.") == "Прекращён")
    check("15 -> Приостановлен", mv.kg_rf_status_text("ЕАЭС KG 417/026.CH.02.06994") == "Приостановлен")
    check("не в таблице -> пусто", mv.kg_rf_status_text("ЕАЭС KG 417/043.RU.02.09525") == "")
    check("пустой номер -> пусто", mv.kg_rf_status_text("") == "")

    # поле в ResultRow и заголовок
    check("ResultRow.rf_status есть", "rf_status" in mv.ResultRow.__dataclass_fields__)
    check("заголовок «Статус на территории РФ»",
          mv.DETAILS_HEADERS_RU_V39.get("rf_status") == "Статус на территории РФ")
    order = mv._details_field_order_v39(list(mv.ResultRow.__dataclass_fields__.keys()))
    check("rf_status сразу после document_status",
          order.index("rf_status") == order.index("document_status") + 1)
    check("вердикт-константа НЕДЕЙСТВУЕТ В РФ", mv.STATUS_INVALID_IN_RF == "НЕДЕЙСТВУЕТ В РФ")

    # логика вердикта: киргизский 14/15 -> НЕДЕЙСТВУЕТ В РФ (как в _flush_url_to_store)
    cert = "ЕАЭС KG417/052.BY.02.18233"
    verdict, score, _ = mv.compare_product_names("Куртка", "Куртка", brand="X", subject="Куртки",
                                                 doc_status="Действует")
    rf = mv.kg_rf_status_text(cert)
    if rf:
        verdict = mv.STATUS_INVALID_IN_RF
    check("совпавший КГ-документ -> вердикт НЕДЕЙСТВУЕТ В РФ", verdict == "НЕДЕЙСТВУЕТ В РФ")

    # argparse
    ap = mv.build_parser()
    a = ap.parse_args(["--input-links-csv", "x.csv"])
    check("--kg-rf-status-file есть, по умолчанию пуст", a.kg_rf_status_file == "")

    # GUI
    import wb_checker as wc
    check("GUI алиас rf_status -> Статус на территории РФ",
          wc._RESULT_HEADER_ALIASES.get("rf_status") == "Статус на территории РФ")
    check("Bridge.browse_kg_status_file есть", hasattr(wc.Bridge, "browse_kg_status_file"))
    check("Bridge.kg_status_info есть", hasattr(wc.Bridge, "kg_status_info"))


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
