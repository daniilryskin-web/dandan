"""
Тест (улучшение №7, v53): постоянный кэш реестров между запусками (SQLite).

Документ реестра покрывает сотни карточек и повторяется между прогонами. Кэш
отдаёт его мгновенно. Проверяем:
  • put/get сохраняет и возвращает разбор + расширенные поля;
  • запись старше TTL считается несвежей (None) → документ перепарсится (и обновит
    статус) — это и есть «свежесть статуса 7 дней»;
  • TTL=0 = бессрочный кэш;
  • аргументы CLI присутствуют и значения по умолчанию верны.

Запуск:  python3 tests/test_registry_cache.py
"""
import sys
import tempfile
import time
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
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "registry_cache.sqlite"
        c = m.RegistryCache(p, ttl_days=7.0)
        url = "https://pub.fsa.gov.ru/rss/certificate/view/1/baseInfo"
        val = ("ЕАЭС RU С-CN.123", "Куртки детские", "сертификат", "Действует", "swis_ok")
        ext = {"document_date_end": "01.01.2027", "tnved": "6201"}
        c.put(url, val, ext)
        c.commit()

        got = c.get(url)
        check("get возвращает запись", got is not None)
        if got:
            v5, e = got
            check("номер/название/статус сохранены",
                  v5[0] == "ЕАЭС RU С-CN.123" and v5[1] == "Куртки детские"
                  and v5[3] == "Действует")
            check("деталь помечена ;from_cache", "from_cache" in v5[4])
            check("расширенные поля сохранены",
                  e.get("document_date_end") == "01.01.2027" and e.get("tnved") == "6201")
        check("неизвестный url → None", c.get("https://x/none") is None)
        c.close()

        # переоткрытие файла — данные на месте (персистентность между запусками)
        c2 = m.RegistryCache(p, ttl_days=7.0)
        check("после переоткрытия запись на месте", c2.get(url) is not None)
        c2.close()

        # несвежая запись (TTL очень маленький) → None (документ перепарсится)
        c3 = m.RegistryCache(p, ttl_days=1e-9)
        time.sleep(0.01)
        check("запись старше TTL → None (перепарсить, обновить статус)",
              c3.get(url) is None)
        c3.close()

        # TTL=0 → бессрочный кэш (всегда свежий)
        c4 = m.RegistryCache(p, ttl_days=0)
        check("TTL=0 → запись считается свежей всегда", c4.get(url) is not None)
        c4.close()

    # --- CLI-аргументы ---
    ap = m.build_parser()
    a = ap.parse_args(["--query", "x", "--link-only", "true"])
    check("--registry-cache по умолчанию True", a.registry_cache is True)
    check("--registry-cache-ttl-days по умолчанию 7", a.registry_cache_ttl_days == 7.0)
    check("--registry-cache-file по умолчанию пуст", a.registry_cache_file == "")

    # --- интеграция: read до парсинга, write после ---
    src = (Path(__file__).resolve().parents[1] / "main_v39.py").read_text(encoding="utf-8")
    check("кэш читается перед этапом (наполняет _retry_seed)",
          "_reg_cache.get(u)" in src and "_retry_seed[u] = val5" in src)
    check("кэш пополняется после парсинга (полные документы)",
          "_reg_cache.put(_u, _val" in src)
    check("belgiss-link-only не кэшируется",
          "'belgiss' in (_det or '')" in src)
    # v54.2: инкрементальная запись + инвалидация по версии парсера
    check("кэш пишется инкрементально (в saver_loop), а не одним батчем",
          "_flush_cache" in src and "Кэш реестров пополнен: +" in src)
    check("инвалидация кэша по версии парсера",
          "PARSER_VERSION" in src and "DELETE FROM registry" in src)

    # версия парсера сбрасывает старые записи
    import sqlite3
    with tempfile.TemporaryDirectory() as td2:
        p2 = Path(td2) / "c.sqlite"
        c = m.RegistryCache(p2, 7.0)
        c.put("uX", ("N", "Товар А; Товар Б", "серт", "Действует", "ok"), {})
        c.commit()
        c.close()
        con = sqlite3.connect(str(p2))
        con.execute("UPDATE meta SET v='OLD-VER' WHERE k='parser_version'")
        con.commit()
        con.close()
        c2 = m.RegistryCache(p2, 7.0)
        check("при смене версии парсера старая запись сброшена (перепарсится)",
              c2.get("uX") is None)
        c2.close()


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
