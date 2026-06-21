"""
Тест: режим «по бренду» использует ТОТ ЖЕ движок/механизм, что и «по запросу».

Проверяем:
  • EngineRunner._run для brand-режима строит ДВА этапа: query_stage1 (сбор
    карточек бренда с --brand-фильтром) -> query_stage2 (парсинг реестров),
    оба через main_v39 (engine), а не main_brand;
  • wb_args query_stage1 со strict_brand добавляет --brand/--brand-match;
  • parse_fsa_json больше НЕ выдаёт «ТР (код N)» для неизвестных id (а известный
    39 -> «ТР ТС 007/2011»).

Запуск:  python3 tests/test_brand_routing.py
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
    import wb_checker as wc
    import main_v39 as mv

    engine = str(wc.ENGINE_V39)

    # --- 1) brand-режим -> две стадии через main_v39 ---
    runner = wc.EngineRunner(wc.AppState())
    calls = []
    runner._run_one = lambda args, label: (calls.append((label, list(args))) or 0)
    spec = wc.RunSpec(mode="brand", brand="adidas", brand_match="contains", limit=50, workers=4)
    runner._run(spec)

    check("brand-режим запускает РОВНО 2 этапа", len(calls) == 2)
    if len(calls) == 2:
        (lbl1, a1), (lbl2, a2) = calls
        check("этап1 — движок main_v39", engine in a1)
        check("этап2 — движок main_v39", engine in a2)
        check("этап1 ищет по бренду (--query adidas)",
              "--query" in a1 and a1[a1.index("--query") + 1] == "adidas")
        check("этап1 строгий бренд-фильтр (--brand adidas)",
              "--brand" in a1 and a1[a1.index("--brand") + 1] == "adidas")
        check("этап1 — сбор ссылок (--link-only true)",
              "--link-only" in a1 and a1[a1.index("--link-only") + 1] == "true")
        check("этап2 — парсинг реестров (--input-links-csv)",
              "--input-links-csv" in a2)
        check("НЕ используется main_brand.py",
              all("main_brand" not in " ".join(a) for a in (a1, a2)))

    # --- 2) wb_args query_stage1 со strict_brand ---
    s1 = wc.RunSpec(mode="query_stage1", query="nike", strict_brand="nike",
                    strict_brand_match="exact", limit=10, workers=2)
    a = s1.wb_args()
    check("query_stage1+strict_brand -> --brand-match exact",
          "--brand-match" in a and a[a.index("--brand-match") + 1] == "exact")
    # без strict_brand --brand не добавляется
    s0 = wc.RunSpec(mode="query_stage1", query="nike", limit=10, workers=2)
    check("query_stage1 без бренда -> без --brand", "--brand" not in s0.wb_args())

    # --- 3) FSA TR: неизвестный код больше не «ТР (код N)» ---
    base = {"idCertificate": 1, "number": "ЕАЭС RU С-RU.XX.В.1/24", "idStatus": 6,
            "product": {"fullName": "Тест"}}
    p_known = mv.parse_fsa_json({**base, "idTechnicalReglaments": [39]},
                                "https://pub.fsa.gov.ru/rss/certificate/view/1/baseInfo", "rss_certificate", 1)
    p_unknown = mv.parse_fsa_json({**base, "idTechnicalReglaments": [8]},
                                  "https://pub.fsa.gov.ru/rss/certificate/view/2/baseInfo", "rss_certificate", 2)
    check("известный id 39 -> ТР ТС 007/2011", p_known.get("technical_regulation") == "ТР ТС 007/2011")
    check("неизвестный id 8 -> НЕ «ТР (код 8)»",
          "код" not in (p_unknown.get("technical_regulation") or ""))


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
