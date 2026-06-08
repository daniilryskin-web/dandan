"""
Тест: загрузка ВНЕШНЕГО result.xlsx (с другого прогона) во вкладку «Результаты».

  • Bridge.browse_result_file() открывает файловый диалог и запоминает путь;
  • get_results() без аргумента читает именно загруженный файл;
  • Bridge.clear_loaded_result() сбрасывает выбор (возврат к текущему прогону).

Сеть не нужна — делаем временный xlsx и подсовываем фейковое окно webview.

Запуск:  python3 tests/test_load_result.py
"""
import sys
import types
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# webview-заглушка с константой диалога
_wv = types.ModuleType("webview")
_wv.OPEN_DIALOG = 10
sys.modules["webview"] = _wv

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


class _FakeWindow:
    def __init__(self, path):
        self._path = path
        self.calls = 0

    def create_file_dialog(self, dialog_type, allow_multiple=False, file_types=None):
        self.calls += 1
        return [self._path]


def _make_xlsx(path):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "results"
    headers = ["query", "nm_id", "product_name", "brand", "status", "product_url",
               "registry_url", "certificate_number", "registry_host",
               "certificate_product_name", "document_status"]
    ws.append(headers)
    ws.append(["midea", 111, "Чайник", "Midea", "OK",
               "https://www.wildberries.ru/catalog/111/detail.aspx",
               "https://pub.fsa.gov.ru/rss/certificate/view/1/baseInfo",
               "ЕАЭС RU С-1", "pub.fsa.gov.ru", "Чайник электрический", "ДЕЙСТВУЕТ"])
    ws.append(["midea", 222, "Фен", "Midea", "OK",
               "https://www.wildberries.ru/catalog/222/detail.aspx",
               "https://swis.trade.kg/x", "KG-2",
               "swis.trade.kg", "Фен бытовой", "ДЕЙСТВУЕТ"])
    wb.save(path)


def main():
    import wb_checker as wc

    tmp = Path(tempfile.mkdtemp())
    xlsx = tmp / "other_run_result.xlsx"
    _make_xlsx(xlsx)

    bridge = wc.Bridge()
    bridge._window = _FakeWindow(str(xlsx))
    # у текущего прогона результата нет
    bridge.state.output_path = str(tmp / "nope.xlsx")

    check("есть метод browse_result_file", hasattr(bridge, "browse_result_file"))
    check("есть метод clear_loaded_result", hasattr(bridge, "clear_loaded_result"))

    res = bridge.browse_result_file()
    check("browse_result_file ok", res.get("ok") is True)
    check("вернул имя файла", res.get("name") == "other_run_result.xlsx")
    check("путь запомнен в Bridge", bridge._loaded_result_path == str(xlsx))

    # get_results без аргумента читает ЗАГРУЖЕННЫЙ файл
    gr = bridge.get_results()
    check("get_results ok на загруженном файле", gr.get("ok") is True)
    rows = gr.get("rows") or []
    check("строки прочитаны (2 шт.)", gr.get("total") == 2 or len(rows) == 2)
    cols = gr.get("columns") or []
    # английские заголовки листа results нормализованы в русские отображаемые имена,
    # чтобы таблица показала «Название в реестре» и кликабельные ссылки на реестр.
    check("колонка «Реестр (хост)» (нормализована из registry_host)", "Реестр (хост)" in cols)
    check("колонка «Название в реестре» присутствует (была пропавшей)",
          "Название в реестре" in cols)
    check("колонка «Ссылка на реестр» присутствует (для кликабельности)",
          "Ссылка на реестр" in cols)
    by_reg = (gr.get("stats") or {}).get("by_registry", {})
    check("статистика по реестрам посчитана (есть fsa)", "pub.fsa.gov.ru" in by_reg)

    # сброс — снова текущий прогон (которого нет → ошибка)
    bridge.clear_loaded_result()
    check("после сброса путь пуст", bridge._loaded_result_path == "")
    gr2 = bridge.get_results()
    check("после сброса читает текущий прогон (его нет → ok False)", gr2.get("ok") is False)

    # отмена диалога
    bridge._window = _FakeWindow(str(xlsx))
    bridge._window.create_file_dialog = lambda *a, **k: None
    rc = bridge.browse_result_file()
    check("отмена диалога -> cancelled", rc.get("cancelled") is True)


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
