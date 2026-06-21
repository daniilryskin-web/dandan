"""
Тест (v54.6): доработки №1/№2/№3.

  №3 ETA      — предстартовая оценка времени (этап 1 / этап 2);
  №2 живучесть — движок выходит с НЕНУЛЕВЫМ кодом при крахе; GUI авто-перезапускает
                 прогон после аномального завершения (resume/кэш продолжают);
  №1 конвейер  — этап 2 стартует параллельно хвосту этапа 1, затем финальный проход;
                 параллельный проход не перезаписывает дифф-снимок (--diff-snapshot false).

Запуск:  python3 tests/test_v546_pipeline.py
"""
import sys
import tempfile
import time
import types
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))

import main_v39 as m  # noqa: E402

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


# ---------------------------------------------------------------- №3 ETA
def test_eta():
    check("№3 длительность < 1 мин", m._human_duration_ru(40) == "< 1 мин")
    check("№3 длительность минуты", "мин" in m._human_duration_ru(700))
    check("№3 длительность часы", "ч" in m._human_duration_ru(34000))
    check("№3 этап1 пусто при 0", m._estimate_stage1_eta(0) == "")
    s1 = m._estimate_stage1_eta(17900)
    check("№3 этап1 содержит число карточек", "17900" in s1)
    check("№3 этап2 пусто при 0", m._estimate_stage2_eta(0, 0, True) == "")
    slow = m._estimate_stage2_eta(14335, 1200, True)
    fast = m._estimate_stage2_eta(14335, 1200, False)
    check("№3 этап2 slow помечает медленный режим", "медленн" in slow)
    check("№3 этап2 slow дольше fast", ("ч" in slow))
    # источник: ETA печатается на обоих этапах
    src = (Path(__file__).resolve().parents[1] / "main_v39.py").read_text(encoding="utf-8")
    check("№3 ETA этапа 1 в run_link_collection", "_estimate_stage1_eta(len(cards))" in src)
    check("№3 ETA этапа 2 в run_registry_stage", "_estimate_stage2_eta(_n_fsa, _n_other" in src)


# ---------------------------------------------------------------- №2 exit code
def test_exit_code_source():
    src = (Path(__file__).resolve().parents[1] / "main_v39.py").read_text(encoding="utf-8")
    # в ветке Exception есть sys.exit(1); в ветке KeyboardInterrupt — нет
    i_main = src.index("def main():")
    tail = src[i_main:i_main + 1200]
    check("№2 движок: критическая ошибка → sys.exit(1)", "sys.exit(1)" in tail)
    ki = tail.index("KeyboardInterrupt")
    exc = tail.index("except Exception")
    check("№2 движок: sys.exit(1) в ветке Exception, не в KeyboardInterrupt",
          tail.index("sys.exit(1)") > exc > ki)


# ---------------------------------------------------------------- GUI helpers
def _make_runner():
    import wb_checker as w
    state = types.SimpleNamespace(
        log_lines=[], full_log_path="", error="", running=False,
        stage_label="", last_cmd="")
    r = w.EngineRunner(state)
    return w, r


# ---------------------------------------------------------------- №2 GUI restart
def test_gui_auto_restart():
    w, r = _make_runner()
    import time as _t
    _orig_sleep = _t.sleep
    _t.sleep = lambda *a, **k: None  # без реальных пауз бэкоффа
    try:
        w.AUTO_RESTART_MAX = 3
        # 1) падает дважды, потом успех → должен вернуть 0 за 3 попытки
        calls = []
        seq = [2, 2, 0]
        def once_ok(args, label):
            calls.append(label)
            return seq[len(calls) - 1]
        r._run_one_once = once_ok
        rc = r._run_one(["x"], "L")
        check("№2 GUI: успех после 2 перезапусков → rc 0", rc == 0)
        check("№2 GUI: ровно 3 попытки", len(calls) == 3)

        # 2) всегда падает → отдаёт код после AUTO_RESTART_MAX+1 попыток
        calls2 = []
        def once_fail(args, label):
            calls2.append(label)
            return 7
        r._run_one_once = once_fail
        rc2 = r._run_one(["x"], "L")
        check("№2 GUI: постоянный сбой → rc сохранён", rc2 == 7)
        check("№2 GUI: 1 основная + 3 перезапуска = 4 попытки", len(calls2) == 4)

        # 3) остановка пользователем → без перезапуска
        r._stop_flag.set()
        calls3 = []
        def once_stop(args, label):
            calls3.append(label)
            return 9
        r._run_one_once = once_stop
        rc3 = r._run_one(["x"], "L")
        check("№2 GUI: при остановке не перезапускает", len(calls3) == 1 and rc3 == 9)
        r._stop_flag.clear()

        # rc==0 с первой попытки → одна попытка
        calls4 = []
        r._run_one_once = lambda a, l: (calls4.append(l) or 0)
        r._run_one(["x"], "L")
        check("№2 GUI: успех сразу → без перезапусков", len(calls4) == 1)
    finally:
        _t.sleep = _orig_sleep


# ---------------------------------------------------------------- №1 GUI overlap
def test_gui_overlap():
    w, r = _make_runner()
    with tempfile.TemporaryDirectory() as td:
        links = Path(td) / "registry_links.csv"
        links.write_text("header\n" + "\n".join(f"row{i}" for i in range(20)), encoding="utf-8")

        w.OVERLAP_MIN_LINKS = 5
        w.OVERLAP_POLL_SEC = 0.05

        lock = threading.Lock()
        collect_calls = []   # (label, args)
        run_calls = []       # (label, args)

        def fake_collect(args, label, lines):
            with lock:
                collect_calls.append((label, list(args)))
            if "Этап 1" in label or "stage1" in label.lower() or label.startswith("L1"):
                time.sleep(0.3)  # этап 1 «живёт», чтобы успел стартовать параллельный проход
            else:
                time.sleep(0.05)
            return 0

        def fake_run_one(args, label):
            with lock:
                run_calls.append((label, list(args)))
            return 0

        r._run_one_collect = fake_collect
        r._run_one = fake_run_one

        s1 = w.RunSpec(mode="query_stage1", query="x",
                       output_links_csv=str(links), output="links.xlsx")
        s2 = w.RunSpec(mode="query_stage2", query="x", input_links_csv=str(links))

        rc = r._run_overlapped(s1, s2, "L1 этап 1", "L2 этап 2")
        check("№1 overlap: вернул rc 0", rc == 0)
        check("№1 overlap: этап 1 + параллельный проход запущены (2 collect)",
              len(collect_calls) == 2)
        check("№1 overlap: финальный проход через _run_one (1 раз)", len(run_calls) == 1)

        # параллельный проход должен иметь --diff-snapshot false
        pass1 = [c for c in collect_calls if "параллельн" in c[0]]
        check("№1 overlap: есть параллельный проход", len(pass1) == 1)
        if pass1:
            a = pass1[0][1]
            has_flag = any(a[i] == "--diff-snapshot" and a[i + 1] == "false"
                           for i in range(len(a) - 1))
            check("№1 overlap: параллельный проход НЕ пишет дифф-снимок", has_flag)
        # финальный проход ПИШЕТ снимок (нет --diff-snapshot false)
        if run_calls:
            fa = run_calls[0][1]
            no_suppress = not any(fa[i] == "--diff-snapshot" and fa[i + 1] == "false"
                                  for i in range(len(fa) - 1))
            check("№1 overlap: финальный проход пишет дифф-снимок", no_suppress)


# ---------------------------------------------------------------- №1 источник
def test_overlap_source():
    w_src = (Path(__file__).resolve().parents[1] / "wb_checker.py").read_text(encoding="utf-8")
    check("№1 overlap подключён в query_full",
          "self._run_overlapped(s1, s2" in w_src)
    check("№1 wb_args добавляет --diff-snapshot false",
          '"--diff-snapshot", "false"' in w_src)
    check("№1 движок прокидывает write_prev_snapshot в out_store",
          "write_prev_snapshot=bool(getattr(args" in
          (Path(__file__).resolve().parents[1] / "main_v39.py").read_text(encoding="utf-8"))


def main():
    test_eta()
    test_exit_code_source()
    test_gui_auto_restart()
    test_gui_overlap()
    test_overlap_source()


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
