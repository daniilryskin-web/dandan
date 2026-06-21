"""
Тест: индикатор скорости показывает ЧЕСТНЫЕ строки/мин (по приросту progress_done),
а не число лог-событий.

Баг: «СКОРОСТЬ 60.0 строк/мин» не совпадала с логом движка («460/мин»), потому что
GUI считал количество лог-событий прогресса, а не реальные обработанные строки.

Проверяем: при разборе строк @@PROGRESS@@ копятся выборки (время, done) и speed_per_min
считается как Δdone/Δt*60. Эмулируем рост done и сверяем скорость.

Запуск:  python3 tests/test_speed_indicator.py
"""
import sys
import types
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


def main():
    import wb_checker as wc

    st = wc.AppState()
    check("есть метод record_progress_sample", hasattr(st, "record_progress_sample"))

    # эмулируем: за 4 секунды done вырос с 0 до 40 -> 600 строк/мин
    base = time.time()
    pts = [(base + 0.0, 0), (base + 1.0, 10), (base + 2.0, 20),
           (base + 3.0, 30), (base + 4.0, 40)]
    for t, d in pts:
        st.progress_done = d
        # вручную добавляем выборку с нужным временем (record использует time.time(),
        # поэтому кладём напрямую, имитируя моменты)
        if st._progress_samples and d < st._progress_samples[-1][1]:
            st._progress_samples = []
        st._progress_samples.append((t, d))
    sp = st.to_dict()["speed_per_min"]
    check(f"скорость ≈600 строк/мин (получено {sp})", 560 <= sp <= 640)

    # смена этапа: done падает (links->registry) -> история сбрасывается, без минуса
    st.progress_done = 5
    st.record_progress_sample()
    st.progress_done = 8
    st.record_progress_sample()
    sp2 = st.to_dict()["speed_per_min"]
    check("после смены этапа скорость не отрицательная", sp2 >= 0)

    # парсер @@PROGRESS@@ наполняет выборки
    runner = wc.EngineRunner(st) if False else None  # не нужен реальный процесс
    st2 = wc.AppState()
    er = wc.EngineRunner(st2)
    er._parse_line("@@PROGRESS@@ stage=links done=100 total=9577")
    er._parse_line("@@PROGRESS@@ stage=links done=200 total=9577")
    check("@@PROGRESS@@ наполняет _progress_samples (>=2)", len(st2._progress_samples) >= 2)


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
