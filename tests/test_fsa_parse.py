"""
Офлайн-тест разбора JSON-ответа ФСА (parse_fsa_json) и построения API-URL.

Контекст: на сети пользователя HTTP-API ФСА блокировал curl_cffi (403), парсинг
уходил в браузерный скрейп и НЕ добирал поля applicant_inn / manufacturer_name /
scheme / technical_regulation. Фикс — дёргать тот же JSON-API через сам браузер
(same-origin fetch) и парсить его parse_fsa_json. Здесь проверяем, что
parse_fsa_json действительно достаёт ранее пустые поля из структуры JSON.

Запуск:  python3 tests/test_fsa_parse.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main_v39 as m  # noqa: E402

RESULTS = []


def check(name, cond, extra=""):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra}")


URL = "https://pub.fsa.gov.ru/rss/certificate/view/3473187/baseInfo"

# 1) Разбор FSA-URL и построение API-эндпоинта
kind, doc_id = m.extract_fsa_kind_id(URL)
check("kind = rss_certificate", kind == "rss_certificate", kind)
check("doc_id = 3473187", doc_id == "3473187", doc_id)
cands = m._fsa_candidates(kind, doc_id, aggressive=True)
api_urls = [u for _l, u in cands]
check("API-URL содержит /api/v1/rss/common/certificates/3473187",
      any("/api/v1/rss/common/certificates/3473187" in u for u in api_urls), str(api_urls))

# 2) Разбор реалистичного JSON ФСА — именно те поля, что были пустыми
FSA_JSON = {
    "id": 3473187,
    "number": "ЕАЭС RU С-CN.СТ12.В.00554/24",
    "status": "Действует",
    "certRegDate": "2024-07-31T00:00:00",
    "certEndDate": "2027-07-30T00:00:00",
    "applicant": {"fullName": 'ООО "АМРОКС"', "inn": "7701234567", "ogrn": "1234567890123"},
    "manufacturer": {"fullName": 'Фабрика "Чжэцзян"', "country": "Китай"},
    "product": {"fullName": "Обувь детская повседневная открытая и закрытая"},
    "tnved": "6404",
    "scheme": "1с",
    "techReg": "ТР ТС 007/2011",
}

parsed = m.parse_fsa_json(FSA_JSON, URL, kind, doc_id)
check("doc_number извлечён", "С-CN" in parsed.get("doc_number", ""), parsed.get("doc_number"))
check("status извлечён", parsed.get("status") == "Действует", parsed.get("status"))
# Ключевое: ранее ПУСТЫЕ поля
check("applicant_inn извлечён (был пустой)", parsed.get("applicant_inn") == "7701234567",
      parsed.get("applicant_inn"))
check("manufacturer извлечён (был пустой)", "Чжэцзян" in parsed.get("manufacturer", ""),
      parsed.get("manufacturer"))
check("scheme извлечён (был пустой)", parsed.get("scheme") == "1с", parsed.get("scheme"))
check("technical_regulation извлечён (был пустой)",
      "007/2011" in parsed.get("technical_regulation", ""), parsed.get("technical_regulation"))

if __name__ == "__main__":
    passed = sum(RESULTS)
    total = len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {passed}/{total} прошло")
    sys.exit(0 if passed == total else 1)
