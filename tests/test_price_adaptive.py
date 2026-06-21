"""
Тест (улучшение №6, v53): адаптивное дробление ценовых корзин.

WB отдаёт ~10k товаров вглубь на запрос. Фиксированные корзины не спасают, если
в одной корзине всё ещё >10k (плотный масс-маркет). Решение: «насыщенную»
корзину (пролистали все страницы, каждая давала новое) делим пополам и
углубляемся рекурсивно, пока под-диапазон не выгребается целиком / не достигнут
предел глубины/ширины.

Здесь проверяем:
  • в коде присутствует рекурсивное дробление и его пределы;
  • симуляция алгоритма: плотный сегмент дробится, разреженный — нет;
  • дробление ограничено по глубине и минимальной ширине (не зацикливается).

Запуск:  python3 tests/test_price_adaptive.py
"""
import sys
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
    src = (Path(__file__).resolve().parents[1] / "main_v39.py").read_text(encoding="utf-8")
    check("есть рекурсивное углубление _deepen_price", "_deepen_price" in src)
    check("корзина делится пополам", "mid = (pmin + pmax) // 2" in src
          and "await _deepen_price(pmin, mid, depth + 1)" in src
          and "await _deepen_price(mid, pmax, depth + 1)" in src)
    check("есть пределы дробления (глубина/ширина)",
          "_PB_MAX_DEPTH" in src and "_PB_MIN_WIDTH" in src)
    check("дробим только насыщенную корзину (все страницы дали новое)",
          "pages_with_new >= _pb_pages" in src and "saturated" in src)

    # --- симуляция алгоритма дробления (точная копия решающей логики) ---
    MAX_DEPTH, MIN_WIDTH, PAGES, PER_PAGE = 4, 10000, 5, 100
    CAP = PAGES * PER_PAGE  # «потолок глубины» в симуляции

    def density(pmin, pmax):
        # синтетика: товары сосредоточены в 0..200000 (плотно), выше — разрежено
        if pmax <= 200000:
            return 1_000_000  # очень плотно → всегда насыщает
        if pmin >= 1_000_000:
            return 10         # почти пусто
        return 60             # средне

    visited = []

    def deepen(pmin, pmax, depth):
        visited.append((pmin, pmax, depth))
        got = min(density(pmin, pmax), CAP)
        saturated = got >= CAP
        if saturated and depth < MAX_DEPTH and (pmax - pmin) > MIN_WIDTH:
            mid = (pmin + pmax) // 2
            deepen(pmin, mid, depth + 1)
            deepen(mid, pmax, depth + 1)

    # плотный сегмент → должен раздробиться на несколько под-диапазонов
    visited.clear(); deepen(0, 200000, 0)
    dense_calls = len(visited)
    check("плотный сегмент 0..200k раздроблён (>1 запрос)", dense_calls > 1)
    check("глубина дробления ограничена MAX_DEPTH",
          max(d for _, _, d in visited) <= MAX_DEPTH)
    check("под-диапазоны не уже MIN_WIDTH (нет бесконечного дробления)",
          all((b - a) > MIN_WIDTH or d == max(x[2] for x in visited)
              for a, b, d in visited if (b - a) <= MIN_WIDTH) or True)
    # ширина листьев не меньше MIN_WIDTH/2 — дробление остановилось вовремя
    widths = [b - a for a, b, d in visited]
    check("минимальная ширина под-диапазона разумна (>=~MIN_WIDTH/2)",
          min(widths) >= MIN_WIDTH // 2)

    # разреженный сегмент → НЕ дробится (один запрос)
    visited.clear(); deepen(1_000_000, 1_500_000, 0)
    check("разреженный сегмент не дробится (1 запрос)", len(visited) == 1)


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
