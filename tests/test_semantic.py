"""
Тест (улучшение №1, v53): семантическое сравнение названий (офлайн-эмбеддинги).

Проверяем БЕЗ установки модели — через внедряемый фейковый эмбеддер:
  • без модели/эмбеддера слой выключен, поведение на правилах не меняется;
  • при высокой смысловой близости пограничный случай спасается из «ПРОВЕРИТЬ
    ВРУЧНУЮ» в OK;
  • при низкой близости остаётся ручная проверка;
  • семантика НЕ переопределяет конфликты (НЕСООТВЕТСТВИЕ остаётся);
  • semantic_best берёт максимум по товарам сертификата (через «; ») и кэширует.

Запуск:  python3 tests/test_semantic.py
"""
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))

import numpy as np  # noqa: E402
import main_v39 as m  # noqa: E402

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


# Фейковый эмбеддер: вектор по маркерам в тексте. Одинаковые маркеры → cos=1.
def fake_embed(texts):
    out = []
    for t in texts:
        low = t.lower()
        v = np.zeros(3, dtype="float32")
        if "sima" in low or "simb" in low:
            v[0] = 1.0
        if "difa" in low:
            v[1] = 1.0
        if "difb" in low:
            v[2] = 1.0
        if v.sum() == 0:
            v[:] = [0.33, 0.33, 0.33]
        out.append(v)
    return out


def verdict(pn, cert, tnved=""):
    return m.compare_product_names(pn, cert, "", "", "Действует", cert_tnved=tnved)[0]


def main():
    # --- без эмбеддера: выключено, правила не меняются ---
    check("без модели semantic_available()=False", not m.semantic_available())
    check("без модели semantic_best=-1 (игнорируется)",
          m.semantic_best("товар sima", "изделие simb") == -1.0)

    # --- внедряем фейковый эмбеддер ---
    m._SEMANTIC_EMBED_FN = staticmethod(fake_embed).__func__
    m._SEMANTIC_CACHE.clear()
    try:
        check("с эмбеддером semantic_available()=True", m.semantic_available())
        # высокая близость одинаковых маркеров
        check("semantic_best высок при общем маркере (~1.0)",
              m.semantic_best("товар sima", "изделие simb") > 0.99)
        check("semantic_best низок при разных маркерах (~0)",
              m.semantic_best("товар difa", "изделие difb") < 0.1)
        # максимум по нескольким товарам сертификата
        check("semantic_best берёт максимум по «; »-списку",
              m.semantic_best("товар sima", "изделие difb; изделие simb") > 0.99)

        # пограничный случай (нет общих слов/категорий → правила дают ручную),
        # но семантика высокая → спасаем в OK
        check("высокая семантика спасает из ручной в OK",
              verdict("Странныйвид sima", "Неведомоеизделие simb") == "OK")
        # низкая семантика → остаётся ручная
        check("низкая семантика → ручная остаётся",
              verdict("Странныйвид difa", "Неведомоеизделие difb") == "ПРОВЕРИТЬ ВРУЧНУЮ")

        # БЕЗОПАСНОСТЬ: конфликт не переопределяется семантикой
        # (даже если оба содержат общий маркер sima)
        check("конфликт категорий НЕ спасается семантикой",
              verdict("Кастрюля sima", "Игрушки мягкие sima") == "НЕСООТВЕТСТВИЕ")
        check("детское vs взрослый-серт НЕ спасается семантикой",
              verdict("Слип для новорожденных sima",
                      "Изделия второго слоя для взрослых sima") == "НЕСООТВЕТСТВИЕ")

        # кэш заполняется
        check("эмбеддинги кэшируются", len(m._SEMANTIC_CACHE) > 0)
    finally:
        m._SEMANTIC_EMBED_FN = None
        m._SEMANTIC_CACHE.clear()

    # после снятия эмбеддера — снова выключено
    check("после снятия эмбеддера семантика выключена", not m.semantic_available())


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
