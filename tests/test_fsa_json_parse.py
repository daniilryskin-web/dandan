"""
Тест разбора РЕАЛЬНОГО JSON-ответа API ФСА (фикстура из живого перехвата).

Проверяет, что parse_fsa_json берёт правильные поля из вложенной структуры:
название из product.fullName (а не idProduct), изготовителя из
manufacturer.fullName (а не idLegalSubject), статус из idStatus (6 -> Действует),
схему/техрегламент из числовых кодов.

Запуск:  python3 tests/test_fsa_json_parse.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main_v39 as m  # noqa: E402

RESULTS = []


def check(name, cond, extra=""):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra}")


fix = Path(__file__).resolve().parent / "fixtures" / "fsa_cert_sample.json"
obj = json.loads(fix.read_text(encoding="utf-8"))
out = m.parse_fsa_json(obj, "https://pub.fsa.gov.ru/rss/certificate/view/3403978/baseInfo",
                       "rss_certificate", "3403978")

check("doc_number", out.get("doc_number") == "ЕАЭС RU С-UZ.НВ10.В.04409/24", repr(out.get("doc_number")))
check("status = Действует (idStatus 6)", out.get("status") == "Действует", repr(out.get("status")))
check("product_full = product.fullName",
      out.get("product_full", "").startswith("Изделия трикотажные бельевые первого слоя"),
      repr(out.get("product_full"))[:60])
check("applicant = applicant.fullName",
      "УЗКОТТОН" in out.get("applicant", ""), repr(out.get("applicant"))[:50])
check("applicant_inn", out.get("applicant_inn") == "7724409915", repr(out.get("applicant_inn")))
check("manufacturer = manufacturer.fullName (НЕ id)",
      "Нозимабону" in out.get("manufacturer", ""), repr(out.get("manufacturer"))[:50])
check("manufacturer НЕ числовой id",
      not out.get("manufacturer", "").isdigit(), repr(out.get("manufacturer"))[:20])
check("scheme = 1с", out.get("scheme") == "1с", repr(out.get("scheme")))
check("technical_regulation = ТР ТС 007/2011",
      out.get("technical_regulation") == "ТР ТС 007/2011", repr(out.get("technical_regulation")))
check("date_start = 18.03.2024", out.get("date_start") == "18.03.2024", repr(out.get("date_start")))
check("date_end = 17.03.2027", out.get("date_end") == "17.03.2027", repr(out.get("date_end")))

if __name__ == "__main__":
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
