# -*- coding: utf-8 -*-
"""
WB Checker — современный GUI (customtkinter)

Версия GUI: 2026-06-05-v25-reporting (gui v4 / customtkinter)

Запускает движки:
  • main_v39.py   — поиск по запросу (этап 1: сбор ссылок → этап 2: парсинг реестров)
  • main_brand.py — поиск по бренду

Установка:
    pip install customtkinter openpyxl

main_v39.py и main_brand.py должны лежать в той же папке, что и wb_gui-4.py.
Настройки автоматически сохраняются в wb_gui_settings.json.
"""

from __future__ import annotations

import os
import re
import sys
import json
import time
import queue
import threading
import subprocess
import webbrowser
from pathlib import Path
from typing import Optional, Dict, Any, List

import tkinter as tk
from tkinter import filedialog, messagebox

try:
    import customtkinter as ctk
except ImportError:
    print("Не установлен customtkinter. Установите: pip install customtkinter", file=sys.stderr)
    raise

APP_DIR = Path(__file__).resolve().parent
PYTHON = sys.executable or "python"
SETTINGS_PATH = APP_DIR / "wb_gui_settings.json"

GUI_VERSION = "2026-06-05-v25-reporting (gui v4)"

QUERY_PROFILES = ["auto", "clothing", "shoes", "toys", "cosmetics", "home", "electronics"]
BRAND_MATCH = ["exact", "contains", "any"]
STRICT_BRAND_MATCH = ["any", "exact", "contains"]
IMPERSONATE = ["chrome", "chrome120", "chrome110"]
COLLECT_STRATEGY = ["hybrid", "expanded", "base"]

# Цветовые акценты
ACCENT = "#5b8cff"
ACCENT_HOVER = "#4773e6"
SUCCESS = "#2e7d32"
SUCCESS_HOVER = "#246627"
DANGER = "#d32f2f"
DANGER_HOVER = "#a82323"
WARN_FG = "#e68a00"

FONT_DEFAULT = ("Segoe UI", 12)
FONT_BOLD = ("Segoe UI", 12, "bold")
FONT_TITLE = ("Segoe UI Semibold", 18)
FONT_SECTION = ("Segoe UI Semibold", 13)
FONT_HINT = ("Segoe UI", 10)
FONT_MONO = ("Consolas", 10)


# ---------- настройки ----------

def load_settings() -> dict:
    if SETTINGS_PATH.exists():
        try:
            return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_settings(data: dict):
    try:
        SETTINGS_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[settings] write fail: {e}", file=sys.stderr)


def open_path(p: Path):
    try:
        if sys.platform == "win32":
            os.startfile(str(p))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p)])
    except Exception as e:
        messagebox.showerror("Не удалось открыть", f"{p}\n\n{e}")


def fmt_duration(sec: float) -> str:
    sec = int(max(0, sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}ч {m:02d}мин"
    if m:
        return f"{m}мин {s:02d}с"
    return f"{s}с"


# ---------- запуск дочерних процессов ----------

class ProcRunner:
    """Запускает дочерний python-процесс и отдаёт строки stdout в очередь."""

    def __init__(self):
        self.proc: Optional[subprocess.Popen] = None
        self.q: "queue.Queue[str]" = queue.Queue()
        self.running = False
        self._t: Optional[threading.Thread] = None

    def start(self, args: List[str], cwd: Path):
        if self.running:
            return
        self.running = True

        def reader():
            try:
                self.proc = subprocess.Popen(
                    args, cwd=str(cwd),
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, encoding="utf-8", errors="replace", bufsize=1,
                    creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
                )
                assert self.proc.stdout is not None
                for line in self.proc.stdout:
                    self.q.put(line.rstrip("\n"))
                self.proc.wait()
                self.q.put(f"\n[ЗАВЕРШЕНО, код выхода: {self.proc.returncode}]")
            except Exception as e:
                self.q.put(f"[ОШИБКА ЗАПУСКА] {e}")
            finally:
                self.running = False
                self.q.put("__DONE__")

        self._t = threading.Thread(target=reader, daemon=True)
        self._t.start()

    def stop(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
            except Exception:
                pass


# ---------- вспомогательные виджеты ----------

class FormField:
    """Хранит ссылку на StringVar/BooleanVar и сам виджет — для save/restore."""

    def __init__(self, var, widget):
        self.var = var
        self.widget = widget

    def get(self):
        return self.var.get()

    def set(self, value):
        try:
            self.var.set(value)
        except Exception:
            pass


# ---------- базовая вкладка ----------

class BaseRunTab(ctk.CTkFrame):
    """Вкладка с формой слева и журналом справа."""

    def __init__(self, master, app: "App", settings_key: str):
        super().__init__(master, fg_color="transparent")
        self.app = app
        self.settings_key = settings_key
        self.fields: Dict[str, FormField] = {}
        self.runner = ProcRunner()
        self.last_output: Optional[Path] = None
        self._last_cmd: str = ""
        self._t0: float = 0.0

        # двухколоночный layout
        self.grid_columnconfigure(0, weight=1, uniform="col")
        self.grid_columnconfigure(1, weight=1, uniform="col")
        self.grid_rowconfigure(0, weight=1)

        self.form_card = ctk.CTkScrollableFrame(self, label_text="", corner_radius=12)
        self.form_card.grid(row=0, column=0, sticky="nsew", padx=(0, 6))

        self.right_card = ctk.CTkFrame(self, corner_radius=12)
        self.right_card.grid(row=0, column=1, sticky="nsew", padx=(6, 0))

        self._build_right()
        self._build_form()
        self._restore_settings()
        self._poll_log()

    # ----- helpers форма -----

    def add_title(self, title: str, subtitle: Optional[str] = None):
        ctk.CTkLabel(self.form_card, text=title, font=FONT_TITLE, anchor="w").pack(
            fill="x", padx=4, pady=(2, 0)
        )
        if subtitle:
            ctk.CTkLabel(self.form_card, text=subtitle, font=FONT_HINT,
                         text_color=("gray40", "gray70"), anchor="w").pack(
                fill="x", padx=4, pady=(0, 10)
            )

    def add_section(self, text: str):
        ctk.CTkLabel(self.form_card, text=text, font=FONT_SECTION, anchor="w").pack(
            fill="x", padx=4, pady=(14, 4)
        )

    def add_sep(self):
        sep = ctk.CTkFrame(self.form_card, height=1, fg_color=("gray80", "gray25"))
        sep.pack(fill="x", padx=4, pady=8)

    def _row(self, label: str, hint: Optional[str] = None):
        fr = ctk.CTkFrame(self.form_card, fg_color="transparent")
        fr.pack(fill="x", padx=4, pady=4)
        fr.grid_columnconfigure(1, weight=1)
        lbl = ctk.CTkLabel(fr, text=label, anchor="w", font=FONT_DEFAULT, width=170)
        lbl.grid(row=0, column=0, sticky="w", padx=(0, 8))
        if hint:
            ctk.CTkLabel(fr, text=hint, font=FONT_HINT, anchor="w",
                         text_color=("gray45", "gray60"), wraplength=540).grid(
                row=1, column=1, sticky="ew", pady=(2, 0)
            )
        return fr

    def add_entry(self, label: str, key: str, default: str = "", hint: Optional[str] = None):
        fr = self._row(label, hint)
        var = tk.StringVar(value=default)
        e = ctk.CTkEntry(fr, textvariable=var, font=FONT_DEFAULT, height=34)
        e.grid(row=0, column=1, sticky="ew")
        self.fields[key] = FormField(var, e)

    def add_spin(self, label: str, key: str, default: int, frm: int, to: int,
                 hint: Optional[str] = None):
        fr = self._row(label, hint)
        var = tk.StringVar(value=str(default))
        sub = ctk.CTkFrame(fr, fg_color="transparent")
        sub.grid(row=0, column=1, sticky="w")
        e = ctk.CTkEntry(sub, textvariable=var, font=FONT_DEFAULT, width=110, height=34)
        e.pack(side="left")
        def _bump(delta: int):
            try:
                v = int(var.get()); v = max(frm, min(to, v + delta)); var.set(str(v))
            except ValueError:
                var.set(str(default))
        ctk.CTkButton(sub, text="−", width=32, height=34, command=lambda: _bump(-1)).pack(side="left", padx=(6, 2))
        ctk.CTkButton(sub, text="+", width=32, height=34, command=lambda: _bump(+1)).pack(side="left")
        self.fields[key] = FormField(var, e)

    def add_combo(self, label: str, key: str, values: List[str], default: str,
                  hint: Optional[str] = None):
        fr = self._row(label, hint)
        var = tk.StringVar(value=default)
        c = ctk.CTkComboBox(fr, values=values, variable=var, font=FONT_DEFAULT,
                            state="readonly", height=34)
        c.grid(row=0, column=1, sticky="ew")
        self.fields[key] = FormField(var, c)

    def add_file(self, label: str, key: str, default: str, save: bool = False,
                 hint: Optional[str] = None):
        fr = self._row(label, hint)
        var = tk.StringVar(value=default)
        sub = ctk.CTkFrame(fr, fg_color="transparent")
        sub.grid(row=0, column=1, sticky="ew")
        sub.grid_columnconfigure(0, weight=1)
        e = ctk.CTkEntry(sub, textvariable=var, font=FONT_DEFAULT, height=34)
        e.grid(row=0, column=0, sticky="ew")
        def _pick():
            if save:
                p = filedialog.asksaveasfilename(initialfile=var.get() or default,
                                                 defaultextension=".xlsx")
            else:
                p = filedialog.askopenfilename(initialdir=str(APP_DIR))
            if p:
                var.set(p)
        ctk.CTkButton(sub, text="…", width=42, height=34, command=_pick).grid(row=0, column=1, padx=(6, 0))
        self.fields[key] = FormField(var, e)

    def add_check(self, key: str, text: str, default: bool, hint: Optional[str] = None):
        fr = ctk.CTkFrame(self.form_card, fg_color="transparent")
        fr.pack(fill="x", padx=4, pady=4)
        var = tk.BooleanVar(value=default)
        sw = ctk.CTkSwitch(fr, text=text, variable=var, font=FONT_DEFAULT,
                           onvalue=True, offvalue=False)
        sw.pack(anchor="w")
        if hint:
            ctk.CTkLabel(fr, text=hint, font=FONT_HINT, anchor="w",
                         text_color=("gray45", "gray60"), wraplength=540).pack(anchor="w", padx=(48, 0), pady=(0, 2))
        self.fields[key] = FormField(var, sw)

    def add_warn(self, text: str):
        ctk.CTkLabel(self.form_card, text="⚠  " + text, font=FONT_HINT,
                     text_color=WARN_FG, anchor="w", wraplength=640).pack(
            fill="x", padx=4, pady=(10, 0)
        )

    def add_run_bar(self, run_label: str):
        bar = ctk.CTkFrame(self.form_card, fg_color="transparent")
        bar.pack(fill="x", padx=4, pady=(6, 10))
        self.run_btn = ctk.CTkButton(bar, text=run_label, font=FONT_BOLD,
                                     fg_color=ACCENT, hover_color=ACCENT_HOVER,
                                     height=42, command=self._guarded_run)
        self.run_btn.pack(side="left", fill="x", expand=True)
        self.stop_btn = ctk.CTkButton(bar, text="■ Стоп", font=FONT_BOLD, width=100, height=42,
                                      fg_color=DANGER, hover_color=DANGER_HOVER,
                                      command=self._stop)
        self.stop_btn.pack(side="left", padx=(8, 0))

    # ----- правая колонка -----

    def _build_right(self):
        self.right_card.grid_rowconfigure(2, weight=1)
        self.right_card.grid_columnconfigure(0, weight=1)

        head = ctk.CTkFrame(self.right_card, fg_color="transparent")
        head.grid(row=0, column=0, sticky="ew", padx=14, pady=(14, 6))
        head.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(head, text="Журнал выполнения", font=FONT_SECTION, anchor="w").grid(row=0, column=0, sticky="w")
        self.status_lbl = ctk.CTkLabel(head, text="готов", font=FONT_HINT,
                                       text_color=("gray45", "gray60"))
        self.status_lbl.grid(row=0, column=1, sticky="e")

        # прогресс
        self.progress = ctk.CTkProgressBar(self.right_card, height=10, progress_color=ACCENT)
        self.progress.set(0)
        self.progress.grid(row=1, column=0, sticky="ew", padx=14, pady=(2, 8))

        # лог
        self.log = ctk.CTkTextbox(self.right_card, font=FONT_MONO, wrap="word")
        self.log.grid(row=2, column=0, sticky="nsew", padx=14, pady=(0, 8))

        # инфо-строка
        info = ctk.CTkFrame(self.right_card, fg_color="transparent")
        info.grid(row=3, column=0, sticky="ew", padx=14, pady=(0, 8))
        self.eta_lbl = ctk.CTkLabel(info, text="прошло: —", font=FONT_HINT,
                                    text_color=("gray45", "gray60"))
        self.eta_lbl.pack(side="left")

        # action-bar
        bar = ctk.CTkFrame(self.right_card, fg_color="transparent")
        bar.grid(row=4, column=0, sticky="ew", padx=14, pady=(0, 14))
        self.open_file_btn = ctk.CTkButton(bar, text="📄 Открыть результат",
                                           command=self._open_result, state="disabled",
                                           height=34)
        self.open_file_btn.pack(side="left", padx=(0, 6))
        ctk.CTkButton(bar, text="📁 Папка", height=34, width=86,
                      command=lambda: open_path(APP_DIR)).pack(side="left", padx=(0, 6))
        self.open_log_btn = ctk.CTkButton(bar, text="📝 Текст лога",
                                          command=self._open_run_log, state="disabled",
                                          height=34)
        self.open_log_btn.pack(side="left", padx=(0, 6))
        ctk.CTkButton(bar, text="⧉ Копировать команду", height=34,
                      command=self._copy_cmd).pack(side="left", padx=(0, 6))
        ctk.CTkButton(bar, text="🧹 Очистить", height=34, width=100,
                      command=lambda: self.log.delete("1.0", "end")).pack(side="right")

    # ----- forms — переопределяется -----

    def _build_form(self):
        raise NotImplementedError

    def _run(self):
        raise NotImplementedError

    # ----- runtime -----

    def _v(self, key) -> str:
        return str(self.fields[key].get()).strip()

    def _b(self, key) -> bool:
        return bool(self.fields[key].get())

    def _validate(self) -> str:
        for key, ff in self.fields.items():
            v = ff.get()
            if isinstance(v, str) and not v.strip() and key in ("query", "brand"):
                return f"Поле «{key}» не должно быть пустым"
        return ""

    def _guarded_run(self):
        if self.runner.running:
            messagebox.showinfo("Уже выполняется", "Дождитесь завершения или нажмите «Стоп».")
            return
        err = self._validate()
        if err:
            messagebox.showwarning("Проверьте поля", err)
            return
        self._run()

    def _start(self, args: List[str], output_path: str):
        if self.runner.running:
            messagebox.showinfo("Уже выполняется", "Дождитесь завершения или нажмите «Стоп».")
            return
        self._save_settings()
        self.last_output = (APP_DIR / output_path) if not os.path.isabs(output_path) else Path(output_path)
        self._last_cmd = " ".join(f'"{a}"' if " " in a else a for a in args)
        self.log.delete("1.0", "end")
        self.progress.set(0)
        self._t0 = time.time()
        self.open_file_btn.configure(state="disabled")
        self.open_log_btn.configure(state="disabled")
        self._log_line(f"[ЗАПУСК] {Path(args[1]).name}")
        self._log_line("[команда] " + self._last_cmd)
        self._log_line("")
        self.status_lbl.configure(text="выполняется…")
        self.app.set_status("Выполняется: " + Path(args[1]).name)
        self.runner.start(args, APP_DIR)

    def _stop(self):
        if not self.runner.running:
            return
        self.runner.stop()
        self.status_lbl.configure(text="останавливается…")
        self._log_line("\n[ОСТАНОВЛЕНО ПОЛЬЗОВАТЕЛЕМ]")

    def _enable_result_buttons(self):
        if self.last_output and Path(self.last_output).exists():
            self.open_file_btn.configure(state="normal")
        lp = self._run_log_path()
        if lp and lp.exists():
            self.open_log_btn.configure(state="normal")

    def _run_log_path(self) -> Optional[Path]:
        if not self.last_output:
            return None
        p = Path(self.last_output)
        return p.with_name(p.stem + "_run.log")

    def _open_run_log(self):
        p = self._run_log_path()
        if p and p.exists():
            open_path(p)
        else:
            messagebox.showinfo("Нет лога", "Файл лога прогона не найден.")

    def _open_result(self):
        if self.last_output and Path(self.last_output).exists():
            open_path(Path(self.last_output))
        else:
            messagebox.showinfo("Файл не найден", "Результат ещё не создан.")

    def _copy_cmd(self):
        if self._last_cmd:
            self.clipboard_clear()
            self.clipboard_append(self._last_cmd)
            self.app.set_status("Команда скопирована в буфер обмена")

    def _log_line(self, line: str):
        try:
            self.log.insert("end", line + "\n")
            self.log.see("end")
        except Exception:
            pass

    def _update_progress(self, line: str):
        # ищем "X/Y" или процент в строке
        m = re.search(r"(\d+)\s*/\s*(\d+)", line)
        if m:
            try:
                done, total = int(m.group(1)), int(m.group(2))
                if total > 0:
                    self.progress.set(min(1.0, done / total))
                    return
            except ValueError:
                pass
        m = re.search(r"(\d+(?:\.\d+)?)\s*%", line)
        if m:
            try:
                self.progress.set(min(1.0, float(m.group(1)) / 100.0))
            except ValueError:
                pass

    def _poll_log(self):
        try:
            while True:
                line = self.runner.q.get_nowait()
                if line == "__DONE__":
                    self.status_lbl.configure(text="готов")
                    self.app.set_status("Готов к работе")
                    self.progress.set(1.0 if self.last_output else 0)
                    self._enable_result_buttons()
                    continue
                self._log_line(line)
                self._update_progress(line)
        except queue.Empty:
            pass
        # ETA
        if self.runner.running:
            self.eta_lbl.configure(text=f"прошло: {fmt_duration(time.time() - self._t0)}")
        self.after(200, self._poll_log)

    # ----- settings -----

    def _save_settings(self):
        all_s = load_settings()
        all_s[self.settings_key] = {k: ff.get() for k, ff in self.fields.items()}
        save_settings(all_s)

    def _restore_settings(self):
        s = load_settings().get(self.settings_key, {})
        for k, v in s.items():
            if k in self.fields:
                self.fields[k].set(v)


# ---------- вкладки ----------

class QueryStage1Tab(BaseRunTab):
    def _build_form(self):
        self.add_title("Этап 1 — сбор карточек и ссылок",
                       "Только HTTP, без браузера. Быстро.")
        self.add_run_bar("▶  ЗАПУСТИТЬ ЭТАП 1")
        self.add_entry("Поисковый запрос", "query", "детская обувь",
                       "Что искать на WB. Например: «детская обувь».")
        self.add_combo("Профиль категории", "query_profile", QUERY_PROFILES, "shoes",
                       "Подсказка для фильтрации предметов.")
        self.add_spin("Лимит карточек", "limit", 10000, 1, 100000,
                      "Сколько карточек собрать максимум.")
        self.add_spin("HTTP-воркеры", "http_link_workers", 30, 1, 200,
                      "Параллельных запросов. Разумно 30–100.")
        self.add_spin("basket-шардов", "cert_max_hosts", 30, 1, 30,
                      "Сколько CDN-шардов перебирать (максимум 30).")
        self.add_sep()
        self.add_file("Ссылки (CSV)", "output_links_csv", "registry_links.csv", save=True)
        self.add_file("Карточки (XLSX)", "output", "links.xlsx", save=True)
        self.add_sep()
        self.add_check("fetch_sellers", "Дотягивать имена продавцов", True,
                       "Имя продавца WB не отдаёт в поиске — собирается отдельным запросом.")
        self.add_check("reset_output", "Очистить старые файлы перед запуском", False)

    def _run(self):
        out = self._v("output")
        args = [PYTHON, str(APP_DIR / "main_v39.py"),
                "--query", self._v("query"),
                "--query-profile", self._v("query_profile"),
                "--limit", self._v("limit"),
                "--link-only", "true", "--link-mode", "http_only",
                "--http-link-workers", self._v("http_link_workers"),
                "--cert-max-hosts", self._v("cert_max_hosts"),
                "--fetch-sellers", "true" if self._b("fetch_sellers") else "false",
                "--output", out,
                "--output-links-csv", self._v("output_links_csv")]
        if self._b("reset_output"):
            args += ["--reset-output", "true"]
        self._start(args, out)


class QueryStage2Tab(BaseRunTab):
    def _build_form(self):
        self.add_title("Этап 2 — парсинг реестров и сверка",
                       "FSA/Belgiss: браузер. SWIS: HTTP.")
        self.add_run_bar("▶  ЗАПУСТИТЬ ЭТАП 2")
        self.add_file("Входной CSV ссылок", "input_links_csv", "registry_links.csv", save=False)
        self.add_file("Результат (XLSX)", "output", "result.xlsx", save=True)
        self.add_spin("Лимит", "limit", 10000, 1, 100000)
        self.add_spin("Браузер-воркеры", "registry_browser_workers", 3, 1, 10,
                      "Параллельных браузеров. Разумно 3–5.")
        self.add_combo("Профиль curl_cffi", "fsa_impersonate", IMPERSONATE, "chrome120")
        self.add_spin("Рестарт зависших, с", "stall", 120, 30, 600,
                      "Перезапуск воркеров при простое.")
        self.add_sep()
        self.add_check("headless", "Скрытый браузер (headless)", True,
                       "Без видимого окна — быстрее.")
        self.add_check("fsa_http", "Пробовать HTTP для FSA (curl_cffi)", False,
                       "По умолчанию выключено: ФСА проверяется только браузером; SWIS остаётся HTTP.")
        self.add_sep()
        self.add_section("Отчёт")
        self.add_spin("Скоро истекает, дней", "expiry_warning_days", 30, 1, 365,
                      "Порог метки «Скоро истекает». Не меняет технический статус, только подсветку и флаг.")
        self.add_check("make_report_xlsx", "Расширенный отчёт (Сводка + Подробности)", True,
                       "Добавляет листы «Сводка» и «Подробности» с подсветкой по сроку.")
        self.add_sep()
        self.add_section("Строгий бренд (опционально)")
        self.add_entry("Бренд", "strict_brand", "",
                       "Если заполнено — оставляет только строки с этим брендом. Полезно, когда в выдаче WB проскочили чужие.")
        self.add_combo("Совпадение бренда", "strict_brand_match", STRICT_BRAND_MATCH, "any",
                       "any = выкл. exact = строго. contains = вхождение.")
        self.add_warn("Закройте result.xlsx в Excel перед запуском.")

    def _run(self):
        out = self._v("output")
        args = [PYTHON, str(APP_DIR / "main_v39.py"),
                "--input-links-csv", self._v("input_links_csv"),
                "--limit", self._v("limit"),
                "--registry-headless", "true" if self._b("headless") else "false",
                "--registry-browser-workers", self._v("registry_browser_workers"),
                "--registry-stall-restart-sec", self._v("stall"),
                "--fsa-http-fast-path", "true" if self._b("fsa_http") else "false",
                "--fsa-curl-cffi-impersonate", self._v("fsa_impersonate"),
                "--output", out,
                "--expiry-warning-days", self._v("expiry_warning_days"),
                "--make-report-xlsx", "true" if self._b("make_report_xlsx") else "false"]
        sb = self._v("strict_brand") if "strict_brand" in self.fields else ""
        sbm = self._v("strict_brand_match") if "strict_brand_match" in self.fields else "any"
        if sb and sbm and sbm != "any":
            args += ["--brand", sb, "--brand-match", sbm]
        self._start(args, out)


class BrandTab(BaseRunTab):
    def _build_form(self):
        self.add_title("Поиск по бренду", "Один проход: карточки + реестры.")
        self.add_run_bar("▶  ЗАПУСТИТЬ")
        self.add_entry("Бренд", "brand", "adidas",
                       "Латиницей, как на WB: adidas, nike, reebok.")
        self.add_spin("Лимит карточек", "limit", 5000, 1, 100000)
        self.add_combo("Совпадение бренда", "brand_match", BRAND_MATCH, "exact",
                       "exact = строгое, contains = частичное.")
        self.add_spin("Браузер-воркеры", "workers", 4, 1, 12)
        self.add_sep()
        self.add_spin("Страниц каталога", "max_pages", 80, 1, 300,
                      "Больше = полнее сбор каталога бренда.")
        self.add_combo("Стратегия сбора", "collect_strategy", COLLECT_STRATEGY, "hybrid",
                       "hybrid = каталог + расширенные запросы (полнее всего).")
        self.add_spin("Доп. запросов", "max_query_terms", 80, 0, 200,
                      "Расширители для обхода лимита выдачи.")
        self.add_sep()
        self.add_file("Результат (XLSX)", "output", "brand_result.xlsx", save=True)
        self.add_file("Результат (CSV)", "result_csv", "brand_result.csv", save=True)
        self.add_sep()
        self.add_check("use_brand_filter", "Каталог по fbrand-ID (полнее)", True,
                       "Поиск внутреннего ID бренда WB — отдаёт весь каталог.")
        self.add_check("no_browser", "Без браузера (только HTTP)", False,
                       "Годится, если в основном SWIS-документы.")
        self.add_check("collect_only", "Только собрать карточки", False,
                       "Без парсинга реестров.")
        self.add_check("reset_output", "Очистить старые файлы", False)
        self.add_sep()
        self.add_section("Отчёт")
        self.add_spin("Скоро истекает, дней", "expiry_warning_days", 30, 1, 365,
                      "Порог метки «Скоро истекает». Не меняет технический статус.")
        self.add_check("make_report_xlsx", "Расширенный отчёт (Сводка + Подробности)", True,
                       "Добавляет листы «Сводка» и «Подробности».")

    def _run(self):
        out = self._v("output")
        args = [PYTHON, str(APP_DIR / "main_brand.py"),
                "--brand", self._v("brand"),
                "--limit", self._v("limit"),
                "--brand-match", self._v("brand_match"),
                "--workers", self._v("workers"),
                "--max-pages", self._v("max_pages"),
                "--collect-strategy", self._v("collect_strategy"),
                "--max-query-terms", self._v("max_query_terms"),
                "--use-brand-filter", "true" if self._b("use_brand_filter") else "false",
                "--expiry-warning-days", self._v("expiry_warning_days"),
                "--make-report-xlsx", "true" if self._b("make_report_xlsx") else "false",
                "--output", out,
                "--result-csv", self._v("result_csv")]
        if self._b("no_browser"):
            args += ["--no-browser", "true"]
        if self._b("collect_only"):
            args += ["--collect-only", "true"]
        if self._b("reset_output"):
            args += ["--reset-output", "true"]
        self._start(args, out)


# ---------- главное окно ----------

class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.settings = load_settings()
        # Тема
        appearance = self.settings.get("_appearance", "dark")  # dark / light / system
        ctk.set_appearance_mode(appearance)
        ctk.set_default_color_theme("blue")

        self.title("WB Checker — проверка карточек и реестров Wildberries")
        geo = self.settings.get("_geometry", "1380x860")
        self.geometry(geo)
        self.minsize(1120, 720)

        self._header()
        self._tabs()
        self._statusbar()
        self._check_files()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _header(self):
        h = ctk.CTkFrame(self, fg_color="transparent")
        h.pack(fill="x", padx=18, pady=(14, 8))

        left = ctk.CTkFrame(h, fg_color="transparent")
        left.pack(side="left", fill="x", expand=True)
        ctk.CTkLabel(left, text="WB Checker", font=FONT_TITLE, anchor="w").pack(side="left")
        ctk.CTkLabel(left,
                     text="   проверка соответствия карточек Wildberries сертификатам и декларациям",
                     font=("Segoe UI", 11), anchor="w",
                     text_color=("gray40", "gray65")).pack(side="left", padx=(8, 0))

        right = ctk.CTkFrame(h, fg_color="transparent")
        right.pack(side="right")
        ctk.CTkLabel(right, text="Тема:", font=FONT_HINT,
                     text_color=("gray40", "gray65")).pack(side="left", padx=(0, 6))
        cur = ctk.get_appearance_mode().lower()  # "dark"/"light"
        self.theme_menu = ctk.CTkSegmentedButton(
            right, values=["Тёмная", "Светлая", "Системная"],
            command=self._on_theme_change, font=FONT_DEFAULT,
        )
        self.theme_menu.set({"dark": "Тёмная", "light": "Светлая", "system": "Системная"}.get(cur, "Тёмная"))
        self.theme_menu.pack(side="left")

    def _tabs(self):
        self.tabs = ctk.CTkTabview(self, corner_radius=12)
        self.tabs.pack(fill="both", expand=True, padx=14, pady=(0, 8))

        t1 = self.tabs.add("По запросу · Этап 1 · ссылки")
        t2 = self.tabs.add("По запросу · Этап 2 · реестры")
        t3 = self.tabs.add("По бренду")

        for t in (t1, t2, t3):
            t.grid_rowconfigure(0, weight=1)
            t.grid_columnconfigure(0, weight=1)

        self.stage1 = QueryStage1Tab(t1, self, "stage1")
        self.stage1.grid(row=0, column=0, sticky="nsew", padx=8, pady=8)
        self.stage2 = QueryStage2Tab(t2, self, "stage2")
        self.stage2.grid(row=0, column=0, sticky="nsew", padx=8, pady=8)
        self.brand = BrandTab(t3, self, "brand")
        self.brand.grid(row=0, column=0, sticky="nsew", padx=8, pady=8)

    def _statusbar(self):
        bar = ctk.CTkFrame(self, fg_color=("gray90", "gray15"), height=28, corner_radius=0)
        bar.pack(fill="x", side="bottom")
        self.status_text = ctk.CTkLabel(bar, text="Готов к работе", font=FONT_HINT,
                                        text_color=("gray30", "gray70"), anchor="w")
        self.status_text.pack(side="left", padx=12)
        ctk.CTkLabel(bar, text=f"Python {sys.version_info.major}.{sys.version_info.minor}  ·  GUI {GUI_VERSION}",
                     font=FONT_HINT, text_color=("gray40", "gray60")).pack(side="right", padx=12)

    def set_status(self, text: str):
        try:
            self.status_text.configure(text=text)
        except Exception:
            pass

    def _on_theme_change(self, value: str):
        mode = {"Тёмная": "dark", "Светлая": "light", "Системная": "system"}.get(value, "dark")
        ctk.set_appearance_mode(mode)
        s = load_settings()
        s["_appearance"] = mode
        save_settings(s)

    def _check_files(self):
        missing = [f for f in ("main_v39.py", "main_brand.py") if not (APP_DIR / f).exists()]
        if missing:
            messagebox.showwarning(
                "Не найдены файлы программ",
                "Рядом с wb_gui-4.py должны лежать:\n  " + "\n  ".join(missing) +
                "\n\nПоложите их в эту папку:\n" + str(APP_DIR),
            )

    def _on_close(self):
        for tab in (getattr(self, "stage1", None),
                    getattr(self, "stage2", None),
                    getattr(self, "brand", None)):
            if tab is not None:
                try:
                    tab._save_settings()
                except Exception:
                    pass
        s = load_settings()
        try:
            s["_geometry"] = self.geometry()
        except Exception:
            pass
        s["_appearance"] = ctk.get_appearance_mode().lower()
        save_settings(s)
        self.destroy()


if __name__ == "__main__":
    App().mainloop()
