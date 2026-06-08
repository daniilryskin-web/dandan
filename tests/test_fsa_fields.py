"""
Тест: из ОДНОГО JSON-ответа FSA достаются все требуемые поля карточки документа.

По скриншотам карточек ФСА нужно собирать (и всё это есть в одном ответе API,
т.е. браузеру НЕ нужно ходить по нескольким вкладкам — меньше запросов, меньше
блокировок):
  • Технические регламенты, Схема сертификации/декларирования (вкладка «Основные»);
  • Рег. номер, Статус, Дата регистрации, Дата окончания (вкладка «Сертификат»);
  • Наименование продукции (вкладка «Сведения о продукции»).

Проверяем парсер на синтетических payload'ах сертификата и декларации, включая
извлечение техрегламента ИЗ ТЕКСТА JSON (без словаря id).

Запуск:  python3 tests/test_fsa_fields.py
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


def main():
    import main_v39 as mv

    # --- СЕРТИФИКАТ: техрегламент по неизвестному id берётся ИЗ ТЕКСТА ---
    cert = {
        "number": "ЕАЭС RU С-RU.НВ54.В.04561/23",
        "idStatus": 6,
        "certRegDate": "2023-04-28",
        "certEndDate": "2026-04-30",
        "idCertScheme": 1,
        "idTechnicalReglaments": [99999],  # НЕТ в словаре -> добор из текста
        "product": {"fullName": "Изделия трикотажные бельевые первого слоя"},
        "documents": {"commonDocuments": {"99999": [
            {"name": "перечень стандартов ... Технического регламента Таможенного союза 017/2011 ..."},
        ]}},
    }
    r = mv.parse_fsa_json(cert, "https://pub.fsa.gov.ru/rss/certificate/view/1/baseInfo",
                          "rss_certificate", "1")
    check("серт: рег. номер", r.get("doc_number") == "ЕАЭС RU С-RU.НВ54.В.04561/23")
    check("серт: статус (idStatus=6 -> Действует)", r.get("status") == "Действует")
    check("серт: дата регистрации", r.get("date_start") == "28.04.2023")
    check("серт: дата окончания", r.get("date_end") == "30.04.2026")
    check("серт: схема сертификации 1с", r.get("scheme") == "1с")
    check("серт: техрегламент из ТЕКСТА (ТР ТС 017/2011)",
          r.get("technical_regulation") == "ТР ТС 017/2011")
    check("серт: наименование продукции", "трикотаж" in (r.get("product_full") or "").lower())
    check("серт: тип документа = Сертификат", r.get("doc_type") == "Сертификат")

    # --- ДЕКЛАРАЦИЯ: схема декларирования + явные «ТР ТС NNN/YYYY» в тексте ---
    decl = {
        "number": "ЕАЭС N RU Д-RU.РА04.В.83843/26",
        "idStatus": 6,
        "declRegDate": "2026-06-08",
        "declEndDate": "2031-06-04",
        "idDeclScheme": 3,
        "product": {"fullName": "Шорли Виноград"},
        "productGroups": [{"name": "ТР ТС 029/2012; ТР ТС 021/2011; ТР ТС 022/2011"}],
    }
    d = mv.parse_fsa_json(decl, "https://pub.fsa.gov.ru/rds/declaration/view/2/common",
                          "rds_declaration", "2")
    check("декл: рег. номер", d.get("doc_number") == "ЕАЭС N RU Д-RU.РА04.В.83843/26")
    check("декл: дата регистрации", d.get("date_start") == "08.06.2026")
    check("декл: дата окончания", d.get("date_end") == "04.06.2031")
    check("декл: схема декларирования 3д", d.get("scheme") == "3д")
    check("декл: техрегламенты из текста (3 шт.)",
          all(x in (d.get("technical_regulation") or "")
              for x in ("ТР ТС 029/2012", "ТР ТС 021/2011", "ТР ТС 022/2011")))
    check("декл: наименование продукции", d.get("product_full") == "Шорли Виноград")
    check("декл: тип документа = Декларация", d.get("doc_type") == "Декларация")

    # --- КОДЫ СТАТУСОВ idStatus (подтверждены пользователем по карточкам) ---
    status_cases = {6: "Действует", 15: "Приостановлен", 14: "Прекращён",
                    11: "Недействителен", 1: "Архивный"}
    for code, want in status_cases.items():
        pay = {"number": "X-1", "idStatus": code, "product": {"fullName": "Товар"}}
        rr = mv.parse_fsa_json(pay, "https://pub.fsa.gov.ru/rss/certificate/view/9/baseInfo",
                               "rss_certificate", "9")
        check(f"idStatus={code} -> «{want}»", rr.get("status") == want)

    # --- НЕдействующие статусы -> вердикт «НЕДЕЙСТВУЮЩИЙ ДОКУМЕНТ» ---
    for st in ("Прекращён", "Приостановлен", "Недействителен", "Архивный"):
        verdict, score, _why = mv.compare_product_names(
            "Куртка детская", "Куртка детская", brand="X", subject="Куртки", doc_status=st)
        check(f"статус «{st}» -> НЕДЕЙСТВУЮЩИЙ ДОКУМЕНТ", verdict == "НЕДЕЙСТВУЮЩИЙ ДОКУМЕНТ")

    # --- авто-восстановление FSA: CLI-флаги паузы ---
    ap = mv.build_parser()
    a = ap.parse_args(["--input-links-csv", "x.csv"])
    check("--fsa-cooldown-sec по умолчанию 90", abs(a.fsa_cooldown_sec - 90.0) < 1e-6)
    check("--fsa-cooldown-fails по умолчанию 8", a.fsa_cooldown_fails == 8)
    check("--fsa-max-cooldowns по умолчанию 3", a.fsa_max_cooldowns == 3)
    check("есть глобал паузы _FSA_COOLDOWN_UNTIL", hasattr(mv, "_FSA_COOLDOWN_UNTIL"))


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
